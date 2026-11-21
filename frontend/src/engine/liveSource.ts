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

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''

export class LiveStreamSource implements VegaDataSource {
  readonly mode = 'LIVE' as const
  private eventSource: EventSource | null = null
  private ttlTimerId: number | null = null
  private stepCounter = 0

  start(_scenarioId?: ScenarioId) {
    this.stop()
    const store = useVegaStore.getState()
    store.setDataMode('LIVE')
    store.setLiveStatus('connecting')
    store.resetLiveBaseline()
    particleBus.clear()

    void this.fetchInitialState()
    this.connectSse()

    this.ttlTimerId = window.setInterval(() => {
      const s = useVegaStore.getState()
      if (s.liveStatus === 'connected' && s.isPlaying) {
        s.tickTtl(1)
      }
    }, 1000)
  }

  stop() {
    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }
    if (this.ttlTimerId !== null) {
      window.clearInterval(this.ttlTimerId)
      this.ttlTimerId = null
    }
    useVegaStore.getState().setLiveStatus('disconnected')
  }

  reset(_scenarioId?: ScenarioId) {
    this.stepCounter = 0
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
    void this.sendLiveExfilSequence()
  }

  stepNextEvent() {
    void this.sendSingleLiveEvent()
  }

  advanceCue() {
    const state = useVegaStore.getState()
    if (state.stage === 'panopticon') {
      if (state.findings.length === 0) {
        this.injectAnomaly()
      } else {
        state.selectNode('vm-a')
        state.setStage('ghost_protocol')
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
    if (state.stage === 'blackout') {
      if (state.wardenDecision?.execution_status === 'awaiting_authorization') {
        this.authorizeContainment()
        return
      }
      state.setObserverOpen(true)
    }
  }

  authorizeContainment() {
    const decision = useVegaStore.getState().wardenDecision
    if (!decision) return
    void fetch(`${API_BASE}/api/warden/${encodeURIComponent(decision.decision_id)}/authorize`, {
      method: 'POST',
    })
  }

  denyContainment() {
    const decision = useVegaStore.getState().wardenDecision
    if (!decision) return
    void fetch(`${API_BASE}/api/warden/${encodeURIComponent(decision.decision_id)}/deny`, {
      method: 'POST',
    })
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

  private async fetchInitialState() {
    try {
      const res = await fetch(`${API_BASE}/api/state`)
      if (!res.ok) return
      const snap = (await res.json()) as BackendStateSnapshot
      useVegaStore.getState().hydrateSnapshot(snap)
    } catch {
      useVegaStore.getState().setLiveStatus('disconnected')
    }
  }

  private connectSse() {
    const es = new EventSource(`${API_BASE}/api/stream`)
    this.eventSource = es

    es.onopen = () => {
      useVegaStore.getState().setLiveStatus('connected')
    }

    es.onerror = () => {
      useVegaStore.getState().setLiveStatus('disconnected')
    }

    es.addEventListener('snapshot', (e) => {
      const snap = JSON.parse((e as MessageEvent<string>).data) as BackendStateSnapshot
      useVegaStore.getState().hydrateSnapshot(snap)
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
      store.updateNodeStatus(finding.source_id, 'elevated')
      const edge = store.edges.find((ed) => ed.from === finding.source_id)
      if (edge) store.markEdgeAnomalous(edge.id, true)
      particleBus.spawn(finding.source_id, 'vega-core', finding.channel, true)
    })

    es.addEventListener('council_signal', (e) => {
      const signal = JSON.parse((e as MessageEvent<string>).data) as CouncilSignal
      const store = useVegaStore.getState()
      store.setCouncilSignal(signal)
      store.markEventsSuspicious(signal.evidence_event_ids)
      for (const sid of signal.source_ids) {
        store.updateNodeStatus(sid, signal.severity === 'SEV1' ? 'compromised' : 'elevated')
      }
      if (signal.severity === 'SEV1') {
        store.setThreatMode('INVESTIGATE')
      }
    })

    es.addEventListener('oracle_assessment', (e) => {
      const assessment = JSON.parse((e as MessageEvent<string>).data) as OracleAssessment
      useVegaStore.getState().setOracleAssessment(assessment)
    })

    es.addEventListener('warden_decision', (e) => {
      const decision = JSON.parse((e as MessageEvent<string>).data) as WardenDecision
      const store = useVegaStore.getState()
      store.setWardenDecision(decision)
      if (decision.execution_status === 'contained_dry_run') {
        store.setThreatMode('CONTAINED')
        store.updateNodeStatus('vm-a', 'isolated')
      } else if (decision.execution_status === 'awaiting_authorization') {
        store.setThreatMode('SEV1_ESCALATION')
      }
    })
  }

  private async sendSingleLiveEvent() {
    const samples = [
      {
        source_id: 'vm-c',
        channel: 'process',
        payload: { cmd: 'systemctl status vega-collector', uid: 1001, exit_code: 0 },
      },
      {
        source_id: 'vm-a',
        channel: 'file',
        payload: {
          op: 'read_burst',
          path: '/srv/secrets/prod-keys/',
          file_count: 37,
          sensitive_marker: 'vault-export-manifest',
        },
      },
      {
        source_id: 'vm-a',
        channel: 'process',
        payload: {
          cmd: 'tar -czf /tmp/.cache-bundle.tar.gz /srv/secrets/prod-keys',
          parent: 'bash',
          pid: 28419,
        },
      },
      {
        source_id: 'vm-a',
        channel: 'network',
        payload: {
          dst: '198.51.100.44:8443',
          sni: 'egress-drop.invalid',
          bytes_out: 48210944,
          asn: 'AS64512-UNTRUSTED',
        },
      },
    ] as const

    const sample = samples[this.stepCounter % samples.length]
    this.stepCounter += 1

    await fetch(`${API_BASE}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schema_version: 1,
        run_id: 'live-ui-demo',
        event_id: `evt-live-${Date.now()}-${this.stepCounter}`,
        source_id: sample.source_id,
        channel: sample.channel,
        event_time: new Date().toISOString(),
        payload: sample.payload,
      }),
    })
  }

  private async sendLiveExfilSequence() {
    const now = new Date().toISOString()
    const batch = [
      {
        source_id: 'vm-a',
        channel: 'file',
        payload: {
          op: 'read_burst',
          path: '/srv/secrets/prod-keys/',
          file_count: 37,
          sensitive_marker: 'vault-export-manifest',
        },
      },
      {
        source_id: 'vm-a',
        channel: 'process',
        payload: {
          cmd: 'tar -czf /tmp/.cache-bundle.tar.gz /srv/secrets/prod-keys',
          parent: 'bash',
          pid: 28419,
        },
      },
      {
        source_id: 'vm-a',
        channel: 'network',
        payload: {
          dst: '198.51.100.44:8443',
          sni: 'egress-drop.invalid',
          bytes_out: 48210944,
          asn: 'AS64512-UNTRUSTED',
        },
      },
    ]

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]
      await fetch(`${API_BASE}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          schema_version: 1,
          run_id: 'live-ui-demo',
          event_id: `evt-live-${Date.now()}-${i + 1}`,
          source_id: item.source_id,
          channel: item.channel,
          event_time: now,
          payload: item.payload,
        }),
      })
    }

    await this.flushWindow()
    const store = useVegaStore.getState()
    store.selectNode('vm-a')
    store.setStage('ghost_protocol')
  }
}
