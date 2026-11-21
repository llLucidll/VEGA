"""Channel Scouts: reason over every populated (source_id, channel, window) chunk."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Protocol, Sequence
from uuid import uuid4

from pydantic import BaseModel

from ..models import Channel, ConfidenceLevel, ScoutFinding, StoredEvent, Window
from .reasoner import StructuredReasoner


class ScoutFindingDraft(BaseModel):
    """Gemini structured output schema (no default values for API compatibility)."""

    signal: str
    rationale: str
    evidence_event_ids: list[str]
    confidence: ConfidenceLevel


class ScoutChunkOutput(BaseModel):
    """Gemini structured output wrapper for a single chunk."""

    findings: list[ScoutFindingDraft]


class ChannelScout(Protocol):
    channel: Channel

    async def analyze(
        self, window: Window, source_id: str, events: Sequence[StoredEvent]
    ) -> list[ScoutFinding]:
        """Reason over every populated chunk; return [] when no signal is found."""
        ...


CHANNEL_GUIDANCE: dict[Channel, str] = {
    "file": (
        "Inspect file-system metadata for unusual access to restricted/secret directories, "
        "bulk reads, or hidden archive staging in temporary paths. Routine source edits or "
        "normal build outputs are benign."
    ),
    "network": (
        "Inspect network metadata for large outbound transfers to unfamiliar/untrusted external "
        "ASNs, suspicious SNIs, or rejected lateral SSH/port probes. Internal registry or "
        "approved service traffic is benign."
    ),
    "process": (
        "Inspect process execution metadata for unexpected archiving/compression of sensitive "
        "paths, interactive shell staging, or suspicious exfiltration tools. Routine tests, "
        "builds, and systemd health checks are benign."
    ),
}


class GeminiChannelScout:
    """Lightweight channel scout backed by a StructuredReasoner (Gemini or fake/fallback)."""

    def __init__(
        self,
        *,
        channel: Channel,
        reasoner: StructuredReasoner,
        detector_version: str = "sentinel-scout/0.5",
    ) -> None:
        self.channel = channel
        self.reasoner = reasoner
        self.detector_version = detector_version

    async def analyze(
        self, window: Window, source_id: str, events: Sequence[StoredEvent]
    ) -> list[ScoutFinding]:
        if not events:
            return []

        valid_event_ids = {ev.event_id for ev in events}
        minimized_events = [
            {
                "event_id": ev.event_id,
                "event_time": ev.event_time.isoformat(),
                "ingested_at": ev.ingested_at.isoformat(),
                "payload": ev.payload,
            }
            for ev in events
        ]

        system_instruction = (
            f"You are a VEGA Sentinel {self.channel.upper()} Scout analyzing one two-minute "
            f"telemetry chunk for source '{source_id}'. {CHANNEL_GUIDANCE[self.channel]} "
            "Rules: (1) Return an empty findings list for ordinary/benign activity. "
            "(2) Only cite event_id values present in the input events—never invent IDs. "
            "(3) Do not infer employee intent or include direct employee identifiers."
        )

        prompt = json.dumps(
            {
                "window_id": window.id,
                "window_start": window.start.isoformat(),
                "window_end": window.end.isoformat(),
                "source_id": source_id,
                "channel": self.channel,
                "events": minimized_events,
            }
        )

        output = await self.reasoner.generate(
            system_instruction=system_instruction,
            prompt=prompt,
            response_schema=ScoutChunkOutput,
        )

        now = datetime.now(timezone.utc)
        validated: list[ScoutFinding] = []
        for draft in output.findings:
            # Enforce evidence grounding: keep only real event IDs from this chunk.
            grounded_ids = [eid for eid in draft.evidence_event_ids if eid in valid_event_ids]
            if not grounded_ids:
                continue
            validated.append(
                ScoutFinding(
                    finding_id=f"fnd-{self.channel}-{uuid4().hex[:8]}",
                    window_id=window.id,
                    source_id=source_id,
                    channel=self.channel,
                    signal=draft.signal,
                    rationale=draft.rationale,
                    evidence_event_ids=list(dict.fromkeys(grounded_ids)),
                    confidence=draft.confidence,
                    detector_version=f"{self.detector_version} ({self.reasoner.mode_name})",
                    created_at=now,
                )
            )
        return validated
