"""Canonical Pydantic v2 contracts aligned 1:1 with frontend/src/contracts/vega.ts."""

from datetime import datetime
from typing import Any, Literal

from pydantic import AwareDatetime, BaseModel, Field

Channel = Literal["file", "network", "process"]
ThreatMode = Literal["WATCH", "INVESTIGATE", "SEV1_ESCALATION", "CONTAINED"]
ConfidenceLevel = Literal["low", "medium", "high"]
SeverityLevel = Literal["LOW", "MEDIUM", "HIGH", "SEV1"]
NodeStatus = Literal["healthy", "elevated", "compromised", "isolated"]
NodeCluster = Literal["core", "eng", "ops", "fin"]
WindowStatus = Literal["collecting", "scouting", "correlating", "clean", "flagged"]


class EventIn(BaseModel):
    schema_version: Literal[1] = 1
    run_id: str = Field(min_length=1)
    event_id: str = Field(min_length=1)
    source_id: str = Field(min_length=1)
    channel: Channel
    event_time: AwareDatetime
    payload: dict[str, Any]


class StoredEvent(EventIn):
    """Normalized event stored in the ephemeral stream; ingested_at is set centrally."""

    ingested_at: datetime
    suspicious: bool | None = None
    summary: str | None = None


class IngestResponse(BaseModel):
    stream_id: str


class Window(BaseModel):
    id: str
    start: datetime
    end: datetime
    status: WindowStatus = "collecting"


class ScoutFinding(BaseModel):
    finding_id: str
    window_id: str
    source_id: str
    channel: Channel
    signal: str
    rationale: str
    evidence_event_ids: list[str]
    confidence: ConfidenceLevel
    detector_version: str
    created_at: datetime


class CouncilSignal(BaseModel):
    signal_id: str
    window_id: str
    severity: SeverityLevel
    summary: str
    rationale: str
    source_ids: list[str]
    finding_refs: list[str]
    evidence_event_ids: list[str]
    escalation_rule: str
    snapshot_preserved: bool = True
    created_at: datetime


class CitedPolicy(BaseModel):
    policy_id: str
    title: str
    version: str
    excerpt: str


class CompetingExplanation(BaseModel):
    hypothesis: str
    status: Literal["ruled_out", "unlikely", "plausible"]
    reason: str


Verdict = Literal["CONTAIN", "NO_ACTION", "ESCALATE"]


class ProsecutorOpinion(BaseModel):
    score: float
    reason: str


class DefenderOpinion(BaseModel):
    score: float
    hypothesis: str
    reason: str


class StewardOpinion(BaseModel):
    allowed: bool
    policy_ids: list[str]
    reason: str


class VmVerdict(BaseModel):
    """Oracle council outcome for one machine named in the CouncilSignal."""

    source_id: str
    verdict: Verdict
    prosecutor: ProsecutorOpinion | None = None
    defender: DefenderOpinion | None = None
    steward: StewardOpinion | None = None
    failures: list[str] = Field(default_factory=list)


class OracleAssessment(BaseModel):
    incident_id: str
    signal_id: str
    assessment: str
    competing_explanations: list[CompetingExplanation]
    cited_policies: list[CitedPolicy]
    historical_context: str
    uncertainty: str
    recommended_action: str
    recommended_scope: str
    model_version: str
    created_at: datetime
    # Oracle council additions (optional so existing producers stay valid)
    verdicts: list[VmVerdict] = Field(default_factory=list)
    council_ms: int = 0


class PolicyCheck(BaseModel):
    id: str
    label: str
    passed: bool
    detail: str


class WardenAuditEntry(BaseModel):
    id: str
    timestamp: str
    actor: Literal["WARDEN", "POLICY_ENGINE", "OPERATOR"]
    message: str
    status: Literal["info", "ok", "warn", "critical"]


class WardenDecision(BaseModel):
    decision_id: str
    incident_id: str
    proposed_action: str
    trusted_target_ref: str
    scope: str
    policy_id: str
    policy_checks: list[PolicyCheck]
    requires_human_approval: bool = True
    approval_status: Literal["pending", "approved", "denied"] = "pending"
    approval_ref: str | None = None
    expires_at: datetime
    dry_run: bool = True
    execution_status: Literal[
        "awaiting_authorization", "executing", "contained_dry_run", "denied"
    ] = "awaiting_authorization"
    audit_log: list[WardenAuditEntry] = Field(default_factory=list)


class MonitoredNode(BaseModel):
    source_id: str
    pseudonym: str
    role: str
    cluster: NodeCluster
    status: NodeStatus = "healthy"
    heartbeat_age_sec: int = 1
    identity_sealed: bool = True


class NetworkEdge(BaseModel):
    id: str
    from_node: str = Field(alias="from", serialization_alias="from")
    to_node: str = Field(alias="to", serialization_alias="to")
    channel: Channel
    anomalous: bool = False

    model_config = {"populate_by_name": True}


class ObserverQA(BaseModel):
    id: str
    prompt: str
    answer: str
    summary_bullets: list[str]
    cited_event_ids: list[str]
    cited_finding_ids: list[str]
    confidence: ConfidenceLevel


class ObserverAskRequest(BaseModel):
    prompt: str = Field(min_length=1)


class StateSnapshot(BaseModel):
    threat_mode: ThreatMode
    active_window_id: str
    ttl_seconds_remaining: int
    nodes: list[MonitoredNode]
    edges: list[NetworkEdge]
    windows: list[Window]
    events: list[StoredEvent]
    findings: list[ScoutFinding]
    council_signal: CouncilSignal | None = None
    oracle_assessment: OracleAssessment | None = None
    warden_decision: WardenDecision | None = None
