"""Central runtime state, preserved evidence snapshots, and SSE broadcaster."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterable
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


_AMBIENT_INFRA_NODES: tuple[tuple[str, str, str, str], ...] = (
    ("vm-d", "subj-004", "GitHub CI Runner (us-east)", "eng"),
    ("vm-e", "subj-005", "AWS EC2 Prod API (i-09f4a)", "ops"),
    ("vm-f", "subj-006", "Foundry Pipeline Worker", "eng"),
    ("vm-g", "subj-007", "AWS EKS Auth Gateway", "ops"),
    ("vm-h", "subj-008", "ML Inference Cluster (GPU)", "eng"),
    ("vm-i", "subj-009", "Release Signing Bastion", "ops"),
    ("vm-j", "subj-010", "Audit Ledger Store (AWS RDS)", "fin"),
    ("vm-k", "subj-011", "Artifact Registry (ECR)", "ops"),
)

_AMBIENT_INFRA_EDGES: tuple[tuple[str, str, str], ...] = (
    ("vm-d", "vega-core", "process"),
    ("vm-e", "vega-core", "network"),
    ("vm-f", "vega-core", "process"),
    ("vm-g", "vega-core", "network"),
    ("vm-h", "vega-core", "process"),
    ("vm-i", "vega-core", "file"),
    ("vm-j", "vega-core", "file"),
    ("vm-k", "vega-core", "network"),
    ("vm-d", "vm-k", "network"),
    ("vm-d", "vm-f", "process"),
    ("vm-e", "vm-g", "network"),
    ("vm-f", "vm-h", "process"),
    ("vm-g", "vm-j", "file"),
    ("vm-i", "vm-k", "file"),
)

_HOST_VM_PEERS: tuple[tuple[str, str, str], ...] = (
    ("vm-a", "vm-b", "network"),
    ("vm-b", "vm-c", "process"),
    ("vm-a", "vm-c", "network"),
)

_VM_TO_INFRA_EDGES: tuple[tuple[str, str, str], ...] = (
    ("vm-a", "vm-e", "network"),
    ("vm-b", "vm-d", "process"),
    ("vm-b", "vm-k", "network"),
    ("vm-c", "vm-i", "process"),
)


def default_nodes() -> list[MonitoredNode]:
    nodes = [
        MonitoredNode(
            source_id="vega-core",
            pseudonym="cluster-hub",
            role="VEGA Ingest & Swarm Hub",
            cluster="core",
            identity_sealed=False,
        ),
    ]
    if settings.demo_topology:
        for source_id, pseudonym, role, cluster in _AMBIENT_INFRA_NODES:
            nodes.append(
                MonitoredNode(
                    source_id=source_id,
                    pseudonym=pseudonym,
                    role=role,
                    cluster=cluster,  # type: ignore[arg-type]
                    ambient=True,
                )
            )
    return nodes


def default_edges() -> list[NetworkEdge]:
    if not settings.demo_topology:
        return []
    return [
        NetworkEdge(
            id=f"e-{src}-{dst}",
            **{"from": src, "to": dst},
            channel=channel,  # type: ignore[arg-type]
        )
        for src, dst, channel in _AMBIENT_INFRA_EDGES
    ]


class VegaRuntimeState:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[str]] = set()
        self._resume_event = asyncio.Event()
        self._resume_event.set()
        self.reset()

    def reset(self) -> None:
        now = datetime.now(timezone.utc)
        self.threat_mode: ThreatMode = "WATCH"
        self.pipeline_paused: bool = False
        if hasattr(self, "_resume_event"):
            self._resume_event.set()
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
        self.window_signals: dict[str, CouncilSignal] = {}
        self.oracle_assessment: OracleAssessment | None = None
        self.warden_decision: WardenDecision | None = None
        self.preserved_evidence: dict[str, StoredEvent] = {}
        self.oldest_stream_event_at: datetime | None = None

    def compute_ttl_seconds_remaining(self, now: datetime | None = None) -> int:
        if self.oldest_stream_event_at is None:
            return settings.retention_seconds
        current = now or datetime.now(timezone.utc)
        expires_at = self.oldest_stream_event_at + timedelta(seconds=settings.retention_seconds)
        return max(0, int((expires_at - current).total_seconds()))

    def set_pipeline_paused(self, paused: bool) -> bool:
        self.pipeline_paused = paused
        if paused:
            self._resume_event.clear()
        else:
            self._resume_event.set()
        return self.pipeline_paused

    async def wait_if_paused(self) -> None:
        while self.pipeline_paused:
            await self._resume_event.wait()

    def snapshot(self) -> StateSnapshot:
        return StateSnapshot(
            threat_mode=self.threat_mode,
            active_window_id=self.active_window_id,
            ttl_seconds_remaining=self.compute_ttl_seconds_remaining(),
            pipeline_paused=self.pipeline_paused,
            nodes=self.nodes,
            edges=self.edges,
            windows=self.windows,
            events=self.visible_events(),
            findings=self.findings,
            council_signal=self.council_signal,
            oracle_assessment=self.oracle_assessment,
            warden_decision=self.warden_decision,
        )

    def record_event(self, event: StoredEvent) -> None:
        self.events.append(event)
        if len(self.events) > 500:
            self.events = self.events[-500:]
        if self.oldest_stream_event_at is None or event.ingested_at < self.oldest_stream_event_at:
            self.oldest_stream_event_at = event.ingested_at
        if not any(n.source_id == event.source_id for n in self.nodes):
            role = str(event.payload.get("host_role") or "Monitored Endpoint")
            real_count = sum(1 for n in self.nodes if n.source_id != "vega-core" and not n.ambient)
            self.nodes.append(
                MonitoredNode(
                    source_id=event.source_id,
                    pseudonym=f"subj-{real_count + 1:03d}",
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
            present = {n.source_id for n in self.nodes}
            existing_edges = {(e.from_node, e.to_node) for e in self.edges}
            peer_links = list(_HOST_VM_PEERS)
            if settings.demo_topology:
                peer_links.extend(_VM_TO_INFRA_EDGES)
            for src, dst, channel in peer_links:
                if src in present and dst in present and (src, dst) not in existing_edges:
                    self.edges.append(
                        NetworkEdge(
                            id=f"e-peer-{src}-{dst}",
                            **{"from": src, "to": dst},
                            channel=channel,  # type: ignore[arg-type]
                        )
                    )
                    existing_edges.add((src, dst))
        else:
            for node in self.nodes:
                if node.source_id == event.source_id:
                    node.heartbeat_age_sec = 0
                    break

    def visible_events(self) -> list[StoredEvent]:
        # Keep incident evidence visible after removing it from the rolling telemetry buffer.
        visible = {ev.event_id: ev for ev in self.events[-200:]}
        visible.update(self.preserved_evidence)
        return sorted(visible.values(), key=lambda ev: ev.ingested_at)

    def preserve_evidence(self, event_ids: list[str], events: Iterable[StoredEvent]) -> None:
        wanted = set(event_ids)
        self.preserved_evidence.update((ev.event_id, ev) for ev in events if ev.event_id in wanted)

    async def clear_window_context(self, window: Window) -> None:
        self.events = [ev for ev in self.events if not window.start <= ev.ingested_at < window.end]
        # Replace stale queued raw telemetry with the authoritative snapshot for live clients.
        for queue in self._subscribers:
            while not queue.empty():
                queue.get_nowait()
        await self.publish("snapshot", self.snapshot())

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
