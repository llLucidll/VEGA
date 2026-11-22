import { create } from 'zustand'
import type {
  CouncilSignal,
  MonitoredNode,
  NetworkEdge,
  NodeStatus,
  ObserverQA,
  OracleAssessment,
  ScenarioId,
  ScoutFinding,
  StoredEvent,
  ThreatMode,
  VegaStage,
  WardenAuditEntry,
  WardenDecision,
  Window,
} from '../contracts/vega'
import { SCENARIOS } from '../data/scenarios'

export interface ObserverMessage {
  id: string
  role: 'user' | 'vega'
  text: string
  qa?: ObserverQA
  timestamp: string
}

export interface BackendStateSnapshot {
  threat_mode: ThreatMode
  active_window_id: string
  ttl_seconds_remaining: number
  nodes: MonitoredNode[]
  edges: NetworkEdge[]
  windows: Window[]
  events: StoredEvent[]
  findings: ScoutFinding[]
  council_signal: CouncilSignal | null
  oracle_assessment: OracleAssessment | null
  warden_decision: WardenDecision | null
}

export type LiveConnectionStatus = 'disconnected' | 'connecting' | 'connected'

type WardenRequest =
  | { decisionId: string; status: 'pending' }
  | { decisionId: string; status: 'error'; message: string }

interface VegaState {
  dataMode: 'SIMULATED' | 'LIVE'
  liveStatus: LiveConnectionStatus
  scenarioId: ScenarioId
  stage: VegaStage
  threatMode: ThreatMode
  isPlaying: boolean
  playbackSpeed: number
  elapsedMs: number
  ttlSecondsRemaining: number

  nodes: MonitoredNode[]
  edges: NetworkEdge[]
  windows: Window[]
  activeWindowId: string
  events: StoredEvent[]
  findings: ScoutFinding[]
  councilSignal: CouncilSignal | null
  oracleAssessment: OracleAssessment | null
  wardenDecision: WardenDecision | null
  wardenRequest: WardenRequest | null

  selectedNodeId: string | null
  selectedEventId: string | null
  chronosExpanded: boolean
  chronosCursorIndex: number | null
  observerOpen: boolean
  observerMessages: ObserverMessage[]
  presenterOpen: boolean

  // Actions
  setDataMode: (mode: 'SIMULATED' | 'LIVE') => void
  setLiveStatus: (status: LiveConnectionStatus) => void
  resetLiveBaseline: () => void
  hydrateSnapshot: (snapshot: BackendStateSnapshot) => void
  loadScenario: (scenarioId: ScenarioId) => void
  setStage: (stage: VegaStage) => void
  setThreatMode: (mode: ThreatMode) => void
  setPlaying: (playing: boolean) => void
  setPlaybackSpeed: (speed: number) => void
  setElapsedMs: (ms: number) => void
  tickTtl: (deltaSec: number) => void
  pushEvent: (event: StoredEvent) => void
  pushFinding: (finding: ScoutFinding) => void
  markEventsSuspicious: (eventIds: string[]) => void
  upsertWindow: (window: Window) => void
  setCouncilSignal: (signal: CouncilSignal | null) => void
  setOracleAssessment: (assessment: OracleAssessment | null) => void
  setWardenDecision: (decision: WardenDecision | null) => void
  setWardenRequest: (request: WardenRequest | null) => void
  updateNodeStatus: (sourceId: string, status: NodeStatus) => void
  markEdgeAnomalous: (edgeId: string, anomalous: boolean) => void
  updateWindowStatus: (windowId: string, status: Window['status']) => void
  setActiveWindowId: (windowId: string) => void
  selectNode: (sourceId: string | null) => void
  selectEvent: (eventId: string | null) => void
  setChronosExpanded: (expanded: boolean) => void
  setChronosCursorIndex: (index: number | null) => void
  setObserverOpen: (open: boolean) => void
  addObserverMessage: (msg: ObserverMessage) => void
  setPresenterOpen: (open: boolean) => void
  appendWardenAudit: (entry: WardenAuditEntry) => void
  updateWardenExecution: (
    patch: Partial<Pick<WardenDecision, 'approval_status' | 'approval_ref' | 'execution_status'>>,
  ) => void
}

const initialScenario = SCENARIOS['sev1-exfil']

export const useVegaStore = create<VegaState>((set) => ({
  dataMode: 'SIMULATED',
  liveStatus: 'disconnected',
  scenarioId: initialScenario.id,
  stage: 'panopticon',
  threatMode: 'WATCH',
  isPlaying: true,
  playbackSpeed: 1,
  elapsedMs: 0,
  ttlSecondsRemaining: initialScenario.retention_seconds,

  nodes: initialScenario.nodes.map((n) => ({ ...n })),
  edges: initialScenario.edges.map((e) => ({ ...e })),
  windows: initialScenario.windows.map((w) => ({ ...w })),
  activeWindowId: initialScenario.windows[0]?.id ?? 'W-1041',
  events: [],
  findings: [],
  councilSignal: null,
  oracleAssessment: null,
  wardenDecision: null,
  wardenRequest: null,

  selectedNodeId: null,
  selectedEventId: null,
  chronosExpanded: false,
  chronosCursorIndex: null,
  observerOpen: false,
  observerMessages: [],
  presenterOpen: false,

  setDataMode: (dataMode) => set({ dataMode }),
  setLiveStatus: (liveStatus) => set({ liveStatus }),

  resetLiveBaseline: () =>
    set({
      stage: 'panopticon',
      threatMode: 'WATCH',
      ttlSecondsRemaining: initialScenario.retention_seconds,
      nodes: [
        {
          source_id: 'vega-core',
          pseudonym: 'cluster-hub',
          role: 'VEGA Ingest & Swarm Hub',
          cluster: 'core',
          status: 'healthy',
          heartbeat_age_sec: 0,
          identity_sealed: false,
        },
      ],
      edges: [],
      windows: [],
      activeWindowId: 'W-1000',
      events: [],
      findings: [],
      councilSignal: null,
      oracleAssessment: null,
      wardenDecision: null,
      selectedNodeId: null,
      selectedEventId: null,
      chronosCursorIndex: null,
      observerMessages: [],
    }),

  hydrateSnapshot: (snapshot) =>
    set((state) => {
      const flaggedIds = new Set<string>()
      for (const f of snapshot.findings) {
        for (const eid of f.evidence_event_ids) flaggedIds.add(eid)
      }
      if (snapshot.council_signal) {
        for (const eid of snapshot.council_signal.evidence_event_ids) flaggedIds.add(eid)
      }
      const events = snapshot.events.map((ev) =>
        flaggedIds.has(ev.event_id) ? { ...ev, suspicious: true } : ev,
      )
      const selectedIdx = events.findIndex((ev) => ev.event_id === state.selectedEventId)
      return {
        selectedEventId: events[selectedIdx]?.event_id ?? null,
        chronosCursorIndex: selectedIdx < 0 ? null : selectedIdx,
        threatMode: snapshot.threat_mode,
        activeWindowId: snapshot.active_window_id,
        ttlSecondsRemaining: snapshot.ttl_seconds_remaining,
        nodes: snapshot.nodes,
        edges: snapshot.edges,
        windows: snapshot.windows,
        events,
        findings: snapshot.findings,
        councilSignal: snapshot.council_signal,
        oracleAssessment: snapshot.oracle_assessment,
        wardenDecision: snapshot.warden_decision,
        selectedNodeId:
          state.selectedNodeId && snapshot.nodes.some((n) => n.source_id === state.selectedNodeId)
            ? state.selectedNodeId
            : null,
      }
    }),

  loadScenario: (scenarioId) => {
    const sc = SCENARIOS[scenarioId]
    set({
      scenarioId,
      stage: 'panopticon',
      threatMode: 'WATCH',
      isPlaying: true,
      elapsedMs: 0,
      ttlSecondsRemaining: sc.retention_seconds,
      nodes: sc.nodes.map((n) => ({ ...n })),
      edges: sc.edges.map((e) => ({ ...e })),
      windows: sc.windows.map((w) => ({ ...w })),
      activeWindowId: sc.windows[0]?.id ?? 'W-1041',
      events: [],
      findings: [],
      councilSignal: null,
      oracleAssessment: null,
      wardenDecision: null,
      selectedNodeId: null,
      selectedEventId: null,
      chronosCursorIndex: null,
      observerMessages: [],
    })
  },

  setStage: (stage) =>
    set((state) => {
      if (stage === 'chronos') {
        return { chronosExpanded: true }
      }
      if (stage === 'observer') {
        return { observerOpen: true }
      }
      return {
        stage,
        selectedNodeId:
          stage === 'ghost_protocol' && !state.selectedNodeId
            ? (state.findings.at(-1)?.source_id ??
              state.nodes.find((n) => n.source_id !== 'vega-core')?.source_id ??
              (state.dataMode === 'SIMULATED' ? 'vm-a' : state.nodes[0]?.source_id ?? null))
            : state.selectedNodeId,
      }
    }),

  setThreatMode: (threatMode) => set({ threatMode }),
  setPlaying: (isPlaying) => set({ isPlaying }),
  setPlaybackSpeed: (playbackSpeed) => set({ playbackSpeed }),
  setElapsedMs: (elapsedMs) => set({ elapsedMs }),
  tickTtl: (deltaSec) =>
    set((state) => ({
      ttlSecondsRemaining: Math.max(0, state.ttlSecondsRemaining - deltaSec),
    })),

  pushEvent: (event) =>
    set((state) => {
      if (state.events.some((e) => e.event_id === event.event_id)) return state
      let nodes = state.nodes
      let edges = state.edges
      if (!nodes.some((n) => n.source_id === event.source_id)) {
        nodes = [
          ...nodes,
          {
            source_id: event.source_id,
            pseudonym: `subj-${String(nodes.length).padStart(3, '0')}`,
            role: 'Monitored Endpoint',
            cluster: 'eng',
            status: 'healthy',
            heartbeat_age_sec: 1,
            identity_sealed: true,
          },
        ]
        edges = [
          ...edges,
          {
            id: `e-core-${event.source_id}`,
            from: event.source_id,
            to: 'vega-core',
            channel: event.channel,
          },
        ]
      }
      return { events: [...state.events, event], nodes, edges }
    }),

  pushFinding: (finding) =>
    set((state) => {
      if (state.findings.some((f) => f.finding_id === finding.finding_id)) return state
      const flagged = new Set(finding.evidence_event_ids)
      return {
        findings: [...state.findings, finding],
        events: state.events.map((ev) =>
          flagged.has(ev.event_id) ? { ...ev, suspicious: true } : ev,
        ),
      }
    }),

  markEventsSuspicious: (eventIds) =>
    set((state) => {
      const flagged = new Set(eventIds)
      return {
        events: state.events.map((ev) =>
          flagged.has(ev.event_id) ? { ...ev, suspicious: true } : ev,
        ),
      }
    }),

  upsertWindow: (window) =>
    set((state) => {
      const exists = state.windows.some((w) => w.id === window.id)
      const windows = exists
        ? state.windows.map((w) => (w.id === window.id ? window : w))
        : [...state.windows, window]
      return {
        windows,
        activeWindowId: window.status === 'collecting' ? window.id : state.activeWindowId,
      }
    }),

  setCouncilSignal: (councilSignal) => set({ councilSignal }),
  setOracleAssessment: (oracleAssessment) => set({ oracleAssessment }),
  setWardenDecision: (wardenDecision) => set({ wardenDecision }),
  setWardenRequest: (wardenRequest) => set({ wardenRequest }),

  updateNodeStatus: (sourceId, status) =>
    set((state) => ({
      nodes: state.nodes.map((n) => (n.source_id === sourceId ? { ...n, status } : n)),
    })),

  markEdgeAnomalous: (edgeId, anomalous) =>
    set((state) => ({
      edges: state.edges.map((e) => (e.id === edgeId ? { ...e, anomalous } : e)),
    })),

  updateWindowStatus: (windowId, status) =>
    set((state) => ({
      windows: state.windows.map((w) => (w.id === windowId ? { ...w, status } : w)),
    })),

  setActiveWindowId: (activeWindowId) => set({ activeWindowId }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  selectEvent: (selectedEventId) =>
    set((state) => {
      const idx = selectedEventId
        ? state.events.findIndex((e) => e.event_id === selectedEventId)
        : -1
      return {
        selectedEventId,
        chronosCursorIndex: idx >= 0 ? idx : state.chronosCursorIndex,
      }
    }),
  setChronosExpanded: (chronosExpanded) => set({ chronosExpanded }),
  setChronosCursorIndex: (chronosCursorIndex) =>
    set((state) => ({
      chronosCursorIndex,
      selectedEventId:
        chronosCursorIndex !== null && state.events[chronosCursorIndex]
          ? state.events[chronosCursorIndex].event_id
          : state.selectedEventId,
    })),
  setObserverOpen: (observerOpen) => set({ observerOpen }),
  addObserverMessage: (msg) =>
    set((state) => ({ observerMessages: [...state.observerMessages, msg] })),
  setPresenterOpen: (presenterOpen) => set({ presenterOpen }),

  appendWardenAudit: (entry) =>
    set((state) => {
      if (!state.wardenDecision) return state
      if (state.wardenDecision.audit_log.some((a) => a.id === entry.id)) return state
      return {
        wardenDecision: {
          ...state.wardenDecision,
          audit_log: [...state.wardenDecision.audit_log, entry],
        },
      }
    }),

  updateWardenExecution: (patch) =>
    set((state) => {
      if (!state.wardenDecision) return state
      return {
        wardenDecision: {
          ...state.wardenDecision,
          ...patch,
        },
      }
    }),
}))
