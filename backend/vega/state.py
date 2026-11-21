"""Central runtime state, preserved evidence snapshots, and SSE broadcaster."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any

from .config import settings
from .models import (
    CouncilSignal,
    MonitoredNode,
    NetworkEdge,
    OracleAssessment,
    ScoutFinding,
    StateSnapshot,
    StoredEvent,
    ThreatMode,
    WardenAuditEntry,
    WardenDecision,
    Window,
)


def default_nodes() -> list[MonitoredNode]:
    return [
        MonitoredNode(
            source_id="vega-core",
            pseudonym="cluster-hub",
            role="VEGA Ingest & Swarm Hub",
            cluster="core",
            identity_sealed=False,
        ),
    ]


def default_edges() -> list[NetworkEdge]:
    return []


class VegaRuntimeState:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self.reset()

    def reset(self) -> None:
        now = datetime.now(timezone.utc)
        self.threat_mode: ThreatMode = "WATCH"
        self.nodes: list[MonitoredNode] = default_nodes()
        self.edges: list[NetworkEdge] = default_edges()
        self.windows: list[Window] = [
            Window(
                id="W-1000",
                start=now,
                end=now + timedelta(seconds=settings.window_seconds),
                status="collecting",
            )
        ]
        self.active_window_id: str = "W-1000"
        self.events: list[StoredEvent] = []
        self.findings: list[ScoutFinding] = []
        self.council_signal: CouncilSignal | None = None
        self.oracle_assessment: OracleAssessment | None = None
        self.warden_decision: WardenDecision | None = None
        self.preserved_evidence: dict[str, StoredEvent] = {}

    def snapshot(self) -> StateSnapshot:
        return StateSnapshot(
            threat_mode=self.threat_mode,
            active_window_id=self.active_window_id,
            ttl_seconds_remaining=settings.retention_seconds,
            nodes=self.nodes,
            edges=self.edges,
            windows=self.windows,
            events=self.events[-200:],
            findings=self.findings,
            council_signal=self.council_signal,
            oracle_assessment=self.oracle_assessment,
            warden_decision=self.warden_decision,
        )

    def record_event(self, event: StoredEvent) -> None:
        self.events.append(event)
        if len(self.events) > 500:
            self.events = self.events[-500:]
        if not any(n.source_id == event.source_id for n in self.nodes):
            role = str(event.payload.get("host_role") or "Monitored Endpoint")
            self.nodes.append(
                MonitoredNode(
                    source_id=event.source_id,
                    pseudonym=f"subj-{len(self.nodes):03d}",
                    role=role,
                    cluster="eng",
                )
            )
            self.edges.append(
                NetworkEdge(
                    id=f"e-core-{event.source_id}",
                    **{"from": event.source_id, "to": "vega-core"},
                    channel=event.channel,
                )
            )
        else:
            for node in self.nodes:
                if node.source_id == event.source_id:
                    node.heartbeat_age_sec = 0
                    break

    def preserve_evidence(self, event_ids: list[str]) -> None:
        by_id = {ev.event_id: ev for ev in self.events}
        for eid in event_ids:
            if eid in by_id:
                self.preserved_evidence[eid] = by_id[eid]

    def append_warden_audit(self, entry: WardenAuditEntry) -> None:
        if self.warden_decision is None:
            return
        self.warden_decision.audit_log.append(entry)

    def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=200)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subscribers.discard(q)

    async def publish(self, event_type: str, payload: Any) -> None:
        if hasattr(payload, "model_dump"):
            data = payload.model_dump(mode="json", by_alias=True)
        else:
            data = payload
        frame = f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
        for q in list(self._subscribers):
            if q.full():
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            await q.put(frame)
