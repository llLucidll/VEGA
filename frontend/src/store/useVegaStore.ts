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

interface VegaState {
  dataMode: 'SIMULATED' | 'LIVE'
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

  selectedNodeId: string | null
  selectedEventId: string | null
  chronosExpanded: boolean
  chronosCursorIndex: number | null
  observerOpen: boolean
  observerMessages: ObserverMessage[]
  presenterOpen: boolean

  // Actions
  loadScenario: (scenarioId: ScenarioId) => void
  setStage: (stage: VegaStage) => void
  setThreatMode: (mode: ThreatMode) => void
  setPlaying: (playing: boolean) => void
  setPlaybackSpeed: (speed: number) => void
  setElapsedMs: (ms: number) => void
  tickTtl: (deltaSec: number) => void
  pushEvent: (event: StoredEvent) => void
  pushFinding: (finding: ScoutFinding) => void
  setCouncilSignal: (signal: CouncilSignal | null) => void
  setOracleAssessment: (assessment: OracleAssessment | null) => void
  setWardenDecision: (decision: WardenDecision | null) => void
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

  selectedNodeId: null,
  selectedEventId: null,
  chronosExpanded: false,
  chronosCursorIndex: null,
  observerOpen: false,
  observerMessages: [],
  presenterOpen: false,

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
          stage === 'ghost_protocol' && !state.selectedNodeId ? 'vm-a' : state.selectedNodeId,
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
      return { events: [...state.events, event] }
    }),

  pushFinding: (finding) =>
    set((state) => {
      if (state.findings.some((f) => f.finding_id === finding.finding_id)) return state
      return { findings: [...state.findings, finding] }
    }),

  setCouncilSignal: (councilSignal) => set({ councilSignal }),
  setOracleAssessment: (oracleAssessment) => set({ oracleAssessment }),
  setWardenDecision: (wardenDecision) => set({ wardenDecision }),

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
