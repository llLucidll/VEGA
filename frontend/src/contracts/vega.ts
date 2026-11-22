/**
 * Canonical VEGA frontend contracts.
 *
 * Aligned 1:1 with:
 * - ephemeral_streams/vega_streams/models.py (Channel, EventIn, StoredEvent, IngestResponse)
 * - Agent Swarm.md (Window, ScoutFinding, CouncilSignal)
 * - VEGA - Architecture Review.md (OracleAssessment, WardenDecision)
 */

export type Channel = 'file' | 'network' | 'process'

export type VegaStage =
  | 'panopticon'
  | 'ghost_protocol'
  | 'council'
  | 'chronos'
  | 'blackout'
  | 'observer'

export type ThreatMode = 'WATCH' | 'INVESTIGATE' | 'SEV1_ESCALATION' | 'CONTAINED'

export type ConfidenceLevel = 'low' | 'medium' | 'high'

export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'SEV1'

export type NodeStatus = 'healthy' | 'elevated' | 'compromised' | 'isolated'

export type NodeCluster = 'core' | 'eng' | 'ops' | 'fin'

export interface EventIn {
  schema_version: 1
  run_id: string
  event_id: string
  source_id: string
  channel: Channel
  event_time: string // RFC 3339 timestamp from producer
  payload: Record<string, unknown>
}

export interface StoredEvent extends EventIn {
  /** Set centrally by EventMapper; never trusted from endpoint producer. */
  ingested_at: string
  /** Optional UI annotation for scenario playback & Chronos highlighting. */
  suspicious?: boolean
  summary?: string
}

export interface IngestResponse {
  stream_id: string
}

export interface Window {
  id: string
  start: string // inclusive ISO timestamp
  end: string // exclusive ISO timestamp
  status: 'collecting' | 'scouting' | 'correlating' | 'clean' | 'flagged' | 'failed'
}

export interface ScoutFinding {
  finding_id: string
  window_id: string
  source_id: string
  channel: Channel
  signal: string
  rationale: string
  evidence_event_ids: string[]
  confidence: ConfidenceLevel
  detector_version: string
  created_at: string
}

export interface CouncilSignal {
  signal_id: string
  window_id: string
  severity: SeverityLevel
  summary: string
  rationale: string
  source_ids: string[]
  finding_refs: string[]
  evidence_event_ids: string[]
  escalation_rule: string
  snapshot_preserved: boolean
  created_at: string
}

export interface CitedPolicy {
  policy_id: string
  title: string
  version: string
  excerpt: string
}

export type Verdict = 'CONTAIN' | 'NO_ACTION' | 'ESCALATE'

/** Oracle council outcome for one machine named in the CouncilSignal. */
export interface VmVerdict {
  source_id: string
  verdict: Verdict
  prosecutor: { score: number; reason: string } | null
  defender: { score: number; hypothesis: string; reason: string } | null
  steward: { allowed: boolean; policy_ids: string[]; reason: string } | null
  failures: string[]
}

export interface OracleAssessment {
  incident_id: string
  signal_id: string
  assessment: string
  competing_explanations: Array<{
    hypothesis: string
    status: 'ruled_out' | 'unlikely' | 'plausible'
    reason: string
  }>
  cited_policies: CitedPolicy[]
  historical_context: string
  uncertainty: string
  recommended_action: string
  recommended_scope: string
  model_version: string
  created_at: string
  // Oracle council additions (optional so existing mock scenarios stay valid)
  verdicts?: VmVerdict[]
  council_ms?: number
}

export interface PolicyCheck {
  id: string
  label: string
  passed: boolean
  detail: string
}

export interface WardenAuditEntry {
  id: string
  timestamp: string
  actor: 'WARDEN' | 'POLICY_ENGINE' | 'OPERATOR'
  message: string
  status: 'info' | 'ok' | 'warn' | 'critical'
}

export interface WardenDecision {
  decision_id: string
  incident_id: string
  proposed_action: string
  trusted_target_ref: string
  scope: string
  policy_id: string
  policy_checks: PolicyCheck[]
  requires_human_approval: boolean
  approval_status: 'pending' | 'approved' | 'denied'
  approval_ref?: string
  expires_at: string
  /** Always true in hackathon demo; no real endpoint controls are mutated. */
  dry_run: boolean
  execution_status: 'awaiting_authorization' | 'executing' | 'contained_dry_run' | 'denied'
  audit_log: WardenAuditEntry[]
}

export interface MonitoredNode {
  source_id: string
  pseudonym: string
  role: string
  cluster: NodeCluster
  status: NodeStatus
  heartbeat_age_sec: number
  identity_sealed: boolean
}

export interface NetworkEdge {
  id: string
  from: string
  to: string
  channel: Channel
  anomalous?: boolean
}

export interface ObserverQA {
  id: string
  prompt: string
  answer: string
  summary_bullets: string[]
  cited_event_ids: string[]
  cited_finding_ids: string[]
  confidence: ConfidenceLevel
}

export type ScenarioId = 'sev1-exfil' | 'benign-control'

export interface ScenarioDefinition {
  id: ScenarioId
  name: string
  subtitle: string
  run_id: string
  retention_seconds: number
  nodes: MonitoredNode[]
  edges: NetworkEdge[]
  windows: Window[]
  events: Array<{
    offsetMs: number
    event: StoredEvent
    edgeId?: string
  }>
  findings: Array<{
    offsetMs: number
    finding: ScoutFinding
  }>
  councilSignal?: {
    offsetMs: number
    signal: CouncilSignal
  }
  oracleAssessment?: {
    offsetMs: number
    assessment: OracleAssessment
  }
  wardenDecision?: {
    offsetMs: number
    decision: WardenDecision
  }
  containmentSteps?: WardenAuditEntry[]
  observerPresets: ObserverQA[]
}
