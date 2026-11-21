"""Per-window Correlator leader: combines scout findings and applies reporting rules."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol, Sequence
from uuid import uuid4

from pydantic import BaseModel

from ..models import CouncilSignal, ScoutFinding, SeverityLevel, Window
from .reasoner import StructuredReasoner


class CorrelatorOutput(BaseModel):
    """Gemini structured output schema (no default values for API compatibility)."""

    should_escalate: bool
    severity: SeverityLevel
    summary: str
    rationale: str
    source_ids: list[str]
    finding_refs: list[str]
    evidence_event_ids: list[str]
    escalation_rule: str


@dataclass(frozen=True)
class ReportingRules:
    """Post-reasoning escalation criteria (never used as a pre-analysis scout filter)."""

    min_channels_for_sev1: int = 2
    allow_single_channel_high: bool = False


class WindowCorrelator(Protocol):
    async def correlate(
        self, window: Window, findings: Sequence[ScoutFinding]
    ) -> CouncilSignal | None:
        """Correlate scout findings across channels/sources and emit a CouncilSignal only if flagged."""
        ...


class GeminiWindowCorrelator:
    """Swarm leader reasoning over scout findings for a single window."""

    def __init__(
        self,
        *,
        reasoner: StructuredReasoner,
        reporting_rules: ReportingRules | None = None,
    ) -> None:
        self.reasoner = reasoner
        self.reporting_rules = reporting_rules or ReportingRules()

    async def correlate(
        self, window: Window, findings: Sequence[ScoutFinding]
    ) -> CouncilSignal | None:
        if not findings:
            return None

        window_findings = [f for f in findings if f.window_id == window.id]
        if not window_findings:
            return None

        system_instruction = (
            "You are the VEGA Sentinel Window Correlator leader. Review all scout findings for "
            "this window, check whether signals fit together across channels (file, network, "
            "process) and sources by time, consider benign explanations, and decide whether to "
            "escalate a CouncilSignal. Do not combine unrelated single-channel findings from "
            "different sources unless explicit evidence links them. Only cite finding_id, "
            "source_id, and event_id values present in the input. Do not judge employee intent "
            "or execute actions."
        )

        prompt = json.dumps(
            {
                "window_id": window.id,
                "window_start": window.start.isoformat(),
                "window_end": window.end.isoformat(),
                "findings": [f.model_dump(mode="json") for f in window_findings],
            }
        )

        output = await self.reasoner.generate(
            system_instruction=system_instruction,
            prompt=prompt,
            response_schema=CorrelatorOutput,
        )

        if not output.should_escalate:
            return None

        valid_finding_ids = {f.finding_id for f in window_findings}
        valid_sources = {f.source_id for f in window_findings}
        valid_event_ids = {eid for f in window_findings for eid in f.evidence_event_ids}

        grounded_findings = [fid for fid in output.finding_refs if fid in valid_finding_ids]
        if not grounded_findings:
            grounded_findings = [f.finding_id for f in window_findings]

        cited_finding_objs = [f for f in window_findings if f.finding_id in grounded_findings]
        channels_by_source: dict[str, set[str]] = {}
        for f in cited_finding_objs:
            channels_by_source.setdefault(f.source_id, set()).add(f.channel)

        # Post-reasoning reporting threshold check: require multi-channel corroboration on at
        # least one source (prevents unrelated single-channel findings across hosts from merging).
        meets_multi_channel = any(
            len(chs) >= self.reporting_rules.min_channels_for_sev1
            for chs in channels_by_source.values()
        )
        meets_single_high = (
            self.reporting_rules.allow_single_channel_high
            and any(f.confidence == "high" for f in cited_finding_objs)
        )
        if not (meets_multi_channel or meets_single_high):
            return None

        grounded_events = [eid for eid in output.evidence_event_ids if eid in valid_event_ids]
        if not grounded_events:
            grounded_events = [
                eid for f in cited_finding_objs for eid in f.evidence_event_ids
            ]

        grounded_sources = [sid for sid in output.source_ids if sid in valid_sources]
        if not grounded_sources:
            grounded_sources = sorted({f.source_id for f in cited_finding_objs})

        severity: SeverityLevel = "SEV1" if meets_multi_channel else output.severity

        return CouncilSignal(
            signal_id=f"sig-{window.id.lower()}-{uuid4().hex[:6]}",
            window_id=window.id,
            severity=severity,
            summary=output.summary,
            rationale=output.rationale,
            source_ids=list(dict.fromkeys(grounded_sources)),
            finding_refs=list(dict.fromkeys(grounded_findings)),
            evidence_event_ids=list(dict.fromkeys(grounded_events)),
            escalation_rule=output.escalation_rule or "RULE-EXFIL-MULTI-CHANNEL-01",
            snapshot_preserved=(severity == "SEV1"),
            created_at=datetime.now(timezone.utc),
        )
