import type {
  CouncilSignal,
  ObserverQA,
  OracleAssessment,
  ScenarioId,
  ScoutFinding,
  StoredEvent,
  VegaStage,
  WardenDecision,
  Window,
} from '../contracts/vega'
import { type BackendStateSnapshot, useVegaStore } from '../store/useVegaStore'
import type { VegaDataSource } from './dataSource'
import { particleBus } from './particleBus'
import { isWardenApprovalExpired, isWardenApprovalPending } from './wardenApproval'

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
const STREAM_RETRY_MS = 2_000

export class LiveStreamSource implements VegaDataSource {
  readonly mode = 'LIVE' as const
  private eventSource: EventSource | null = null
  private reconnectTimerId: number | null = null
  private ttlTimerId: number | null = null
  private wardenRequestController: AbortController | null = null

  start(_scenarioId?: ScenarioId) {
    this.stop()
    const store = useVegaStore.getState()
    store.setDataMode('LIVE')
    store.setLiveStatus('connecting')
    store.resetLiveBaseline()
    particleBus.clear()

    this.connectSse()

    this.ttlTimerId = window.setInterval(() => {
      const s = useVegaStore.getState()
      if (s.liveStatus === 'connected' && s.isPlaying && s.events.length > 0) {
        s.tickTtl(1)
      }
    }, 1000)
  }

  stop() {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    if (this.reconnectTimerId !== null) {
      window.clearTimeout(this.reconnectTimerId)
      this.reconnectTimerId = null
    }
    if (this.ttlTimerId !== null) {
      window.clearInterval(this.ttlTimerId)
      this.ttlTimerId = null
    }
    this.wardenRequestController?.abort()
    this.wardenRequestController = null
    const store = useVegaStore.getState()
    store.setWardenRequest(null)
    store.setLiveStatus('disconnected')
  }

  reset(_scenarioId?: ScenarioId) {
    particleBus.clear()
    useVegaStore.getState().setStage('panopticon')
    void fetch(`${API_BASE}/api/demo/reset`, { method: 'POST' })
  }

  setPlaying(playing: boolean) {
    useVegaStore.getState().setPlaying(playing)
  }

  setSpeed(multiplier: number) {
    useVegaStore.getState().setPlaybackSpeed(multiplier)
  }

  jumpToStage(stage: VegaStage) {
    const state = useVegaStore.getState()
    if (stage === 'chronos') {
      state.setChronosExpanded(!state.chronosExpanded)
      return
    }
    if (stage === 'observer') {
      state.setObserverOpen(!state.observerOpen)
      return
    }
    state.setStage(stage)
  }

  injectAnomaly() {
    // Live mode receives telemetry exclusively from real endpoint producers.
  }

  stepNextEvent() {
    // Live mode receives telemetry exclusively from real endpoint producers.
  }

  advanceCue() {
    const state = useVegaStore.getState()
    if (state.stage === 'panopticon') {
      const finding = state.findings.at(-1)
      if (finding) {
        state.selectNode(finding.source_id)
        state.setStage('ghost_protocol')
      } else {
        void this.flushWindow()
      }
      return
    }
    if (state.stage === 'ghost_protocol') {
      state.setStage('council')
      return
    }
    if (state.stage === 'council') {
      if (!state.chronosExpanded) {
        state.setChronosExpanded(true)
        return
      }
      state.setChronosExpanded(false)
      state.setStage('blackout')
      return
    }
    if (state.stage === 'blackout') state.setObserverOpen(true)
  }

  authorizeContainment(decisionId: string) {
    void this.submitWardenRequest(decisionId, 'authorize')
  }

  denyContainment(decisionId: string) {
    void this.submitWardenRequest(decisionId, 'deny')
  }

  private async submitWardenRequest(decisionId: string, action: 'authorize' | 'deny') {
    const state = useVegaStore.getState()
    const decision = state.wardenDecision
    if (
      state.dataMode !== 'LIVE' ||
      state.liveStatus !== 'connected' ||
      this.wardenRequestController ||
      !isWardenApprovalPending(decision) ||
      decision.decision_id !== decisionId ||
      isWardenApprovalExpired(decision, Date.now())
    ) return

    const controller = new AbortController()
    this.wardenRequestController = controller
    state.setWardenRequest({ decisionId, status: 'pending' })
    try {
      const response = await fetch(`${API_BASE}/api/warden/${encodeURIComponent(decisionId)}/${action}`, {
        method: 'POST',
        signal: controller.signal,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const detail = typeof body?.detail === 'string' ? body.detail : `HTTP ${response.status}`
        throw new Error(detail)
      }

      const updated = (await response.json()) as WardenDecision
      if (updated?.decision_id !== decisionId) throw new Error('Unexpected decision in server response')
      // Never let the POST response replace a decision already refreshed by SSE.
      if (!controller.signal.aborted && useVegaStore.getState().wardenDecision === decision) {
        this.applyWardenDecision(updated)
      }
    } catch (error) {
      const current = useVegaStore.getState()
      if (!controller.signal.aborted && current.wardenDecision?.decision_id === decisionId) {
        current.setWardenRequest({
          decisionId,
          status: 'error',
          message: `Warden could not confirm the request: ${error instanceof Error ? error.message : 'Unknown error'}`,
        })
      }
    } finally {
      if (this.wardenRequestController === controller) {
        this.wardenRequestController = null
        const current = useVegaStore.getState()
        if (current.wardenRequest?.status === 'pending') current.setWardenRequest(null)
      }
    }
  }

  private applyWardenDecision(decision: WardenDecision) {
    const state = useVegaStore.getState()
    state.setWardenDecision(decision)
    // The backend snapshot owns node status. Council suspects are not necessarily Warden targets.
    if (decision.execution_status === 'contained' || decision.execution_status === 'contained_dry_run') {
      state.setThreatMode('CONTAINED')
    } else if (decision.execution_status === 'awaiting_authorization') {
      state.setThreatMode('SEV1_ESCALATION')
    }
  }

  askObserver(prompt: string) {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const store = useVegaStore.getState()
    store.addObserverMessage({
      id: `usr-${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: new Date().toISOString().slice(11, 19) + 'Z',
    })

    void fetch(`${API_BASE}/api/observer/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: trimmed }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const qa = (await res.json()) as ObserverQA
        useVegaStore.getState().addObserverMessage({
          id: qa.id,
          role: 'vega',
          text: qa.answer,
          qa,
          timestamp: new Date().toISOString().slice(11, 19) + 'Z',
        })
      })
      .catch((err: unknown) => {
        useVegaStore.getState().addObserverMessage({
          id: `err-${Date.now()}`,
          role: 'vega',
          text: `Observer request failed: ${err instanceof Error ? err.message : 'unknown error'}`,
          timestamp: new Date().toISOString().slice(11, 19) + 'Z',
        })
      })
  }

  async flushWindow() {
    await fetch(`${API_BASE}/api/demo/flush-window?wait=true`, { method: 'POST' })
  }

  private connectSse() {
    const es = new EventSource(`${API_BASE}/api/stream`)
    this.eventSource = es

    es.onerror = () => {
      if (this.eventSource !== es) return
      useVegaStore.getState().setLiveStatus('disconnected')
      es.close()
      if (this.reconnectTimerId !== null) return
      this.reconnectTimerId = window.setTimeout(() => {
        this.reconnectTimerId = null
        if (this.eventSource !== es) return
        useVegaStore.getState().setLiveStatus('connecting')
        this.connectSse()
      }, STREAM_RETRY_MS)
    }

    es.addEventListener('snapshot', (e) => {
      if (this.eventSource !== es) return
      // Bootstrap and resync on the same stream as the deltas. A separate HTTP
      // snapshot could arrive late and overwrite a newer Council or node update.
      const snap = JSON.parse((e as MessageEvent<string>).data) as BackendStateSnapshot
      const store = useVegaStore.getState()
      store.hydrateSnapshot(snap)
      store.setLiveStatus('connected')
    })

    es.addEventListener('event', (e) => {
      const ev = JSON.parse((e as MessageEvent<string>).data) as StoredEvent
      const store = useVegaStore.getState()
      store.pushEvent(ev)
      particleBus.spawn(ev.source_id, 'vega-core', ev.channel, Boolean(ev.suspicious))
    })

    es.addEventListener('window', (e) => {
      const win = JSON.parse((e as MessageEvent<string>).data) as Window
      useVegaStore.getState().upsertWindow(win)
    })

    es.addEventListener('finding', (e) => {
      const finding = JSON.parse((e as MessageEvent<string>).data) as ScoutFinding
      const store = useVegaStore.getState()
      store.pushFinding(finding)
      if (store.nodes.find((n) => n.source_id === finding.source_id)?.status === 'healthy') {
        store.updateNodeStatus(finding.source_id, 'elevated')
      }
      const edge =
        store.edges.find((ed) => ed.from === finding.source_id && ed.to === 'vega-core') ??
        store.edges.find((ed) => ed.from === finding.source_id)
      if (edge) store.markEdgeAnomalous(edge.id, true)
      particleBus.spawn(finding.source_id, 'vega-core', finding.channel, true)
    })

    es.addEventListener('council_signal', (e) => {
      const signal = JSON.parse((e as MessageEvent<string>).data) as CouncilSignal
      const store = useVegaStore.getState()
      store.setCouncilSignal(signal)
      store.markEventsSuspicious(signal.evidence_event_ids)
      for (const sid of signal.source_ids) {
        const status = store.nodes.find((n) => n.source_id === sid)?.status
        if (status !== 'isolated' && (status !== 'compromised' || signal.severity === 'SEV1')) {
          store.updateNodeStatus(sid, signal.severity === 'SEV1' ? 'compromised' : 'elevated')
        }
      }
      if (signal.severity === 'SEV1' && store.threatMode === 'WATCH') {
        store.setThreatMode('INVESTIGATE')
      }
    })

    es.addEventListener('oracle_assessment', (e) => {
      const assessment = JSON.parse((e as MessageEvent<string>).data) as OracleAssessment
      useVegaStore.getState().setOracleAssessment(assessment)
    })

    es.addEventListener('warden_decision', (e) => {
      if (this.eventSource !== es) return
      const decision = JSON.parse((e as MessageEvent<string>).data) as WardenDecision
      this.applyWardenDecision(decision)
    })
  }
}
