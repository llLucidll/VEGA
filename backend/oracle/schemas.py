"""Oracle data models.

Mirrors frontend/src/contracts/vega.ts field for field (CouncilSignal, ScoutFinding,
StoredEvent, OracleAssessment). `verdicts` and `council_ms` on OracleAssessment are
the only additions and must be added to vega.ts too.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

Channel = Literal["file", "network", "process"]
ConfidenceLevel = Literal["low", "medium", "high"]
SeverityLevel = Literal["LOW", "MEDIUM", "HIGH", "SEV1"]
Verdict = Literal["CONTAIN", "NO_ACTION", "ESCALATE"]


# ---------- Input (from Sentinel) ----------

class StoredEvent(BaseModel):
    schema_version: Literal[1] = 1
    run_id: str
    event_id: str
    source_id: str
    channel: Channel
    event_time: str
    payload: dict[str, Any]
    ingested_at: str
    summary: str | None = None


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
    created_at: str


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
    snapshot_preserved: bool
    created_at: str


class OracleRequest(BaseModel):
    """What Sentinel publishes for Oracle: the signal plus the findings/events it references."""

    signal: CouncilSignal
    findings: list[ScoutFinding]
    events: list[StoredEvent] = Field(default_factory=list)


# ---------- Council member outputs (returned by the model) ----------

class ProsecutorOpinion(BaseModel):
    score: float = Field(description="0.0-1.0 likelihood this machine is compromised")
    reason: str = Field(description="One sentence citing specific findings")


class DefenderOpinion(BaseModel):
    score: float = Field(description="0.0-1.0 plausibility of an innocent explanation")
    hypothesis: str = Field(description="The best innocent explanation, as a short phrase")
    reason: str = Field(description="One sentence explaining why it does or does not fit")


class StewardOpinion(BaseModel):
    allowed: bool = Field(description="Whether policy allows containing this machine")
    policy_ids: list[str] = Field(description="IDs of the policies relied on")
    reason: str = Field(description="One sentence")

class CouncilOpinions(BaseModel):
    """All three members' opinions for one VM, returned by a single model call."""

    prosecutor: ProsecutorOpinion
    defender: DefenderOpinion
    steward: StewardOpinion


class VmVerdict(BaseModel):
    source_id: str
    verdict: Verdict
    prosecutor: ProsecutorOpinion | None
    defender: DefenderOpinion | None
    steward: StewardOpinion | None
    failures: list[str] = Field(default_factory=list)


# ---------- Output (to Warden / UI) ----------

class CitedPolicy(BaseModel):
    policy_id: str
    title: str
    version: str
    excerpt: str


class CompetingExplanation(BaseModel):
    hypothesis: str
    status: Literal["ruled_out", "unlikely", "plausible"]
    reason: str


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
    created_at: str
    # Additions (add to vega.ts):
    verdicts: list[VmVerdict]
    council_ms: int