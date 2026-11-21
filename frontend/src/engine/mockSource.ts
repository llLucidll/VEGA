import type { ScenarioId, VegaStage } from '../contracts/vega'
import { SCENARIOS } from '../data/scenarios'
import { useVegaStore } from '../store/useVegaStore'
import type { VegaDataSource } from './dataSource'
import { particleBus } from './particleBus'

class MockScenarioSource implements VegaDataSource {
  readonly mode = 'SIMULATED' as const
  private ttlTimerId: number | null = null
  private ambientTimerId: number | null = null
  private containmentTimers: number[] = []
  private emittedEvents = new Set<string>()
  private emittedFindings = new Set<string>()
  private emittedCouncil = false
  private emittedOracle = false
  private emittedWarden = false

  start(scenarioId: ScenarioId = 'sev1-exfil') {
    this.stop()
    this.resetState(scenarioId)

    // Hydrate only the calm baseline window; never auto-advance into anomalies or later stages.
    const baselineMs = scenarioId === 'benign-control' ? 5000 : 4000
    this.syncUpTo(baselineMs)
    useVegaStore.getState().setElapsedMs(baselineMs)

    // Gentle 1s TTL countdown tick while ambient stream is active
    this.ttlTimerId = window.setInterval(() => {
      const state = useVegaStore.getState()
      if (!state.isPlaying) return
      state.tickTtl(1)
    }, 1000)

    // Ambient healthy telemetry particles so Panopticon stays visually alive
    this.ambientTimerId = window.setInterval(() => {
      const state = useVegaStore.getState()
      if (!state.isPlaying) return
      const healthyEdges = state.edges.filter((e) => !e.anomalous)
      if (healthyEdges.length === 0) return
      const edge = healthyEdges[Math.floor(Math.random() * healthyEdges.length)]
      const fromNode = state.nodes.find((n) => n.source_id === edge.from)
      if (fromNode?.status === 'isolated') return
      particleBus.spawn(edge.from, edge.to, edge.channel, false)
    }, 340)
  }

  stop() {
    if (this.ttlTimerId !== null) {
      window.clearInterval(this.ttlTimerId)
      this.ttlTimerId = null
    }
    if (this.ambientTimerId !== null) {
      window.clearInterval(this.ambientTimerId)
      this.ambientTimerId = null
    }
    this.clearContainmentTimers()
  }

  reset(scenarioId?: ScenarioId) {
    const target = scenarioId ?? useVegaStore.getState().scenarioId
    this.start(target)
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

    const sc = SCENARIOS[state.scenarioId]

    if (stage === 'panopticon') {
      state.setStage('panopticon')
      return
    }

    if (sc.id === 'benign-control') {
      this.syncUpTo(5000)
      state.setElapsedMs(5000)
      state.setStage(stage)
      return
    }

    const targetMsByStage: Record<'ghost_protocol' | 'council' | 'blackout', number> = {
      ghost_protocol: 10000,
      council: 13500,
      blackout: 15500,
    }

    const targetMs = targetMsByStage[stage]
    if (state.elapsedMs < targetMs) {
      this.syncUpTo(targetMs)
      state.setElapsedMs(targetMs)
    }

    if (stage === 'ghost_protocol') {
      state.selectNode('vm-a')
      state.setThreatMode('INVESTIGATE')
    } else if (stage === 'council') {
      state.setThreatMode('INVESTIGATE')
    } else if (stage === 'blackout') {
      if (state.wardenDecision?.execution_status !== 'contained_dry_run') {
        state.setThreatMode('SEV1_ESCALATION')
      }
    }

    state.setStage(stage)
  }

  injectAnomaly() {
    const state = useVegaStore.getState()
    if (state.scenarioId !== 'sev1-exfil') {
      this.start('sev1-exfil')
    }

    const targetMs = 10000
    this.syncUpTo(targetMs)
    const nextState = useVegaStore.getState()
    nextState.setElapsedMs(targetMs)
    nextState.selectNode('vm-a')
    nextState.setThreatMode('INVESTIGATE')
    nextState.setStage('ghost_protocol')

    // Visual red pulse burst on vm-a edges
    particleBus.spawn('vm-a', 'vega-core', 'file', true)
    particleBus.spawn('vm-a', 'vm-b', 'network', true)
    particleBus.spawn('vm-a', 'vega-core', 'network', true)
  }

  stepNextEvent() {
    const state = useVegaStore.getState()
    const sc = SCENARIOS[state.scenarioId]

    const nextEvent = sc.events.find((item) => !this.emittedEvents.has(item.event.event_id))
    if (nextEvent) {
      const targetMs = Math.max(state.elapsedMs, nextEvent.offsetMs)
      this.syncUpTo(targetMs)
      useVegaStore.getState().setElapsedMs(targetMs)
      if (nextEvent.event.suspicious) {
        useVegaStore.getState().selectNode(nextEvent.event.source_id)
        useVegaStore.getState().setThreatMode('INVESTIGATE')
      }
      return
    }

    const nextFinding = sc.findings.find((item) => !this.emittedFindings.has(item.finding.finding_id))
    if (nextFinding) {
      this.syncUpTo(nextFinding.offsetMs)
      useVegaStore.getState().setElapsedMs(nextFinding.offsetMs)
      return
    }

    if (sc.councilSignal && !this.emittedCouncil) {
      this.jumpToStage('council')
      return
    }

    if (sc.wardenDecision && !this.emittedWarden) {
      this.jumpToStage('blackout')
    }
  }

  advanceCue() {
    const state = useVegaStore.getState()

    if (state.stage === 'panopticon') {
      this.injectAnomaly()
      return
    }

    if (state.stage === 'ghost_protocol') {
      this.jumpToStage('council')
      return
    }

    if (state.stage === 'council') {
      if (!state.chronosExpanded) {
        state.setChronosExpanded(true)
        return
      }
      state.setChronosExpanded(false)
      this.jumpToStage('blackout')
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
    const state = useVegaStore.getState()
    const sc = SCENARIOS[state.scenarioId]
    if (!state.wardenDecision || state.wardenDecision.execution_status === 'contained_dry_run') {
      return
    }

    this.clearContainmentTimers()
    state.updateWardenExecution({
      approval_status: 'approved',
      approval_ref: 'APR-DEMO-1042',
      execution_status: 'executing',
    })

    const steps = sc.containmentSteps ?? []
    steps.forEach((step, idx) => {
      const t = window.setTimeout(() => {
        const current = useVegaStore.getState()
        current.appendWardenAudit(step)
        if (idx === 2) {
          current.updateNodeStatus('vm-a', 'isolated')
          current.markEdgeAnomalous('e-core-a', false)
          current.markEdgeAnomalous('e-a-b', false)
        }
        if (idx === steps.length - 1) {
          current.updateWardenExecution({ execution_status: 'contained_dry_run' })
          current.setThreatMode('CONTAINED')
        }
      }, idx * 420)
      this.containmentTimers.push(t)
    })
  }

  denyContainment() {
    const state = useVegaStore.getState()
    if (!state.wardenDecision) return
    this.clearContainmentTimers()
    state.updateWardenExecution({
      approval_status: 'denied',
      execution_status: 'denied',
    })
    state.appendWardenAudit({
      id: `aud-deny-${Date.now()}`,
      timestamp: new Date().toISOString().slice(11, 23) + 'Z',
      actor: 'OPERATOR',
      message: 'Containment request denied by operator. Monitoring continues in SEV1 review.',
      status: 'warn',
    })
  }

  askObserver(prompt: string) {
    const trimmed = prompt.trim()
    if (!trimmed) return
    const state = useVegaStore.getState()
    const sc = SCENARIOS[state.scenarioId]
    const now = new Date().toISOString().slice(11, 19) + 'Z'

    state.addObserverMessage({
      id: `usr-${Date.now()}`,
      role: 'user',
      text: trimmed,
      timestamp: now,
    })

    const lower = trimmed.toLowerCase()
    let matched = sc.observerPresets[0]

    if (lower.includes('backup') || lower.includes('false') || lower.includes('routine') || lower.includes('ci')) {
      matched = sc.observerPresets.find((p) => p.id.includes('false') || p.id.includes('benign')) ?? matched
    } else if (lower.includes('privacy') || lower.includes('ttl') || lower.includes('redis') || lower.includes('identity')) {
      matched = sc.observerPresets.find((p) => p.id.includes('privacy')) ?? matched
    } else if (lower.includes('why') || lower.includes('042') || lower.includes('vm-a') || lower.includes('flag')) {
      matched = sc.observerPresets[0]
    }

    window.setTimeout(() => {
      useVegaStore.getState().addObserverMessage({
        id: `vega-${Date.now()}`,
        role: 'vega',
        text: matched.answer,
        qa: matched,
        timestamp: new Date().toISOString().slice(11, 19) + 'Z',
      })
    }, 260)
  }

  private resetState(scenarioId: ScenarioId) {
    this.emittedEvents.clear()
    this.emittedFindings.clear()
    this.emittedCouncil = false
    this.emittedOracle = false
    this.emittedWarden = false
    particleBus.clear()
    useVegaStore.getState().loadScenario(scenarioId)
  }

  private clearContainmentTimers() {
    this.containmentTimers.forEach((id) => window.clearTimeout(id))
    this.containmentTimers = []
  }

  private syncUpTo(elapsedMs: number) {
    const state = useVegaStore.getState()
    const sc = SCENARIOS[state.scenarioId]

    // Window transitions
    if (sc.id === 'sev1-exfil') {
      if (elapsedMs >= 4200 && state.activeWindowId !== 'W-1042') {
        state.updateWindowStatus('W-1041', 'clean')
        state.setActiveWindowId('W-1042')
        state.updateWindowStatus('W-1042', 'scouting')
      }
    } else if (elapsedMs >= 3800) {
      state.updateWindowStatus('W-1043', 'clean')
    }

    // Events
    for (const item of sc.events) {
      if (elapsedMs >= item.offsetMs && !this.emittedEvents.has(item.event.event_id)) {
        this.emittedEvents.add(item.event.event_id)
        state.pushEvent(item.event)

        if (item.edgeId) {
          const edge = state.edges.find((e) => e.id === item.edgeId)
          if (edge) {
            particleBus.spawn(edge.from, edge.to, item.event.channel, Boolean(item.event.suspicious))
            if (item.event.suspicious) {
              state.markEdgeAnomalous(edge.id, true)
            }
          }
        }

        if (item.event.suspicious) {
          state.updateNodeStatus(item.event.source_id, 'elevated')
        }
      }
    }

    // Scout findings
    for (const item of sc.findings) {
      if (elapsedMs >= item.offsetMs && !this.emittedFindings.has(item.finding.finding_id)) {
        this.emittedFindings.add(item.finding.finding_id)
        state.pushFinding(item.finding)
      }
    }

    // Council signal
    if (sc.councilSignal && elapsedMs >= sc.councilSignal.offsetMs && !this.emittedCouncil) {
      this.emittedCouncil = true
      state.setCouncilSignal(sc.councilSignal.signal)
      state.updateWindowStatus('W-1042', 'flagged')
      state.updateNodeStatus('vm-a', 'compromised')
    }

    // Oracle assessment
    if (sc.oracleAssessment && elapsedMs >= sc.oracleAssessment.offsetMs && !this.emittedOracle) {
      this.emittedOracle = true
      state.setOracleAssessment(sc.oracleAssessment.assessment)
    }

    // Warden decision
    if (sc.wardenDecision && elapsedMs >= sc.wardenDecision.offsetMs && !this.emittedWarden) {
      this.emittedWarden = true
      state.setWardenDecision(structuredClone(sc.wardenDecision.decision))
    }
  }
}

export const vegaSource: VegaDataSource = new MockScenarioSource()
