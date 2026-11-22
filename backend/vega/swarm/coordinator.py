"""Early and final window analysis for the Sentinel scout swarm."""

from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from itertools import chain
from typing import Protocol

from ..models import Channel, CouncilSignal, ScoutFinding, StoredEvent, Window, WindowStatus
from ..state import VegaRuntimeState
from ..streams.store import StreamStore
from .correlator import WindowCorrelator
from .early import has_early_hint
from .scouts import ChannelScout


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class WindowRunResult:
    window: Window
    chunks_analyzed: int
    findings: list[ScoutFinding]
    signal: CouncilSignal | None
    chunks_reused: int = 0


@dataclass
class _WindowAnalysisCache:
    """Window-local digests and inference results, never raw events or prompts."""

    scouts: dict[tuple[str, Channel], tuple[bytes, list[ScoutFinding]]] = field(default_factory=dict)
    correlations: dict[tuple[str, ...], CouncilSignal | None] = field(default_factory=dict)


def _chunk_digest(events: list[StoredEvent]) -> bytes:
    digest = sha256()
    for event in events:
        digest.update(event.model_dump_json().encode())
        digest.update(b"\n")  # JSON strings escape newlines.
    return digest.digest()


class WindowCoordinator(Protocol):
    async def process_window(self, window: Window) -> CouncilSignal | None:
        """Read window chunks from StreamStore, fan out scouts, and run the Correlator."""
        ...


class SwarmWindowCoordinator:
    """Fans out channel scouts per (source_id, channel, window) and runs the Correlator."""

    def __init__(
        self,
        *,
        store: StreamStore,
        scouts: dict[Channel, ChannelScout],
        correlator: WindowCorrelator,
        runtime: VegaRuntimeState | None = None,
        max_concurrency: int = 6,
        stage_delay_seconds: float = 0.0,
    ) -> None:
        self.store = store
        self.scouts = scouts
        self.correlator = correlator
        self.runtime = runtime
        self._semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self.stage_delay_seconds = max(0.0, stage_delay_seconds)

    async def process_window(self, window: Window) -> CouncilSignal | None:
        result = await self.process_window_detailed(window)
        return result.signal

    async def process_window_detailed(
        self,
        window: Window,
        *,
        early_sources: set[str] | None = None,
        cache: _WindowAnalysisCache | None = None,
    ) -> WindowRunResult:
        # Early analysis reads a snapshot of a still-collecting window.
        if self.runtime is not None:
            await self.runtime.wait_if_paused()
        if early_sources is None:
            await self._update_window_status(window, "scouting")

        chunks = await self.store.read_window(window)
        if early_sources is not None:
            chunks = {key: chunk for key, chunk in chunks.items() if key[0] in early_sources}
        findings_by_chunk: dict[tuple[str, Channel], list[ScoutFinding]] = {}
        pending = []
        tasks = []
        for key, events in sorted(chunks.items()):
            source_id, channel = key
            if not events or channel not in self.scouts:
                continue
            digest = _chunk_digest(events) if cache is not None else b""
            saved = cache.scouts.get(key) if cache is not None else None
            if saved is not None and saved[0] == digest:
                findings_by_chunk[key] = saved[1]
            else:
                pending.append((key, digest))
                tasks.append(self._run_scout(window, source_id, channel, events))

        chunks_reused = len(findings_by_chunk)
        nested_results = await asyncio.gather(*tasks, return_exceptions=True) if tasks else []
        scout_failed = False
        for (key, digest), item in zip(pending, nested_results, strict=True):
            if isinstance(item, BaseException):
                scout_failed = True
                logger.warning("Scout failed in %s (%s)", window.id, type(item).__name__)
                continue
            findings_by_chunk[key] = item
            if early_sources is not None and cache is not None:
                cache.scouts[key] = (digest, item)

        findings = list(chain.from_iterable(findings_by_chunk[key] for key in sorted(findings_by_chunk)))
        had_signal = self.runtime is not None and self.runtime.council_signal is not None
        findings = await self._publish_findings(window, findings)
        if (
            findings
            and not had_signal
            and self.stage_delay_seconds > 0
            and self.runtime is not None
            and self.runtime.council_signal is None
        ):
            await asyncio.sleep(self.stage_delay_seconds)
        if self.runtime is not None:
            await self.runtime.wait_if_paused()
        if early_sources is None:
            await self._update_window_status(window, "correlating")
        # Correlation sees only the findings, not raw events. Don't reuse incomplete passes.
        correlation_key = tuple(f.finding_id for f in findings)
        if cache is not None and not scout_failed and correlation_key in cache.correlations:
            saved_signal = cache.correlations[correlation_key]
            signal = saved_signal.model_copy(deep=True) if saved_signal is not None else None
        else:
            signal = await self.correlator.correlate(window, findings)
            if early_sources is not None and cache is not None and not scout_failed:
                cache.correlations[correlation_key] = signal.model_copy(deep=True) if signal is not None else None
        if self.runtime is not None:
            if signal is not None:
                self.runtime.preserve_evidence(signal.evidence_event_ids, chain.from_iterable(chunks.values()))
                signal = await self._publish_signal(signal)
            else:
                signal = self.runtime.window_signals.get(window.id)
        if early_sources is None:
            outcome = "flagged" if signal else "failed" if scout_failed else "clean"
            await self._update_window_status(window, outcome)

        return WindowRunResult(
            window=window,
            chunks_analyzed=len(tasks),
            findings=findings,
            signal=signal,
            chunks_reused=chunks_reused,
        )

    async def _publish_findings(self, window: Window, findings: list[ScoutFinding]) -> list[ScoutFinding]:
        if self.runtime is None:
            return findings

        def key(finding: ScoutFinding):
            return finding.source_id, finding.channel, finding.signal, frozenset(finding.evidence_event_ids)

        known = {key(f): f for f in self.runtime.findings if f.window_id == window.id}
        for finding in findings:
            if key(finding) in known:
                continue
            known[key(finding)] = finding
            self.runtime.findings.append(finding)
            for node in self.runtime.nodes:
                if node.source_id == finding.source_id and node.status == "healthy":
                    node.status = "elevated"
            for edge in self.runtime.edges:
                if edge.from_node == finding.source_id:
                    edge.anomalous = True
            await self.runtime.publish("finding", finding)
        return list({known[key(f)].finding_id: known[key(f)] for f in findings}.values())

    async def _publish_signal(self, signal: CouncilSignal) -> CouncilSignal:
        assert self.runtime is not None
        previous = self.runtime.window_signals.get(signal.window_id)
        rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "SEV1": 3}
        if previous is not None:
            if (
                rank[signal.severity] <= rank[previous.severity]
                and set(signal.source_ids) <= set(previous.source_ids)
                and set(signal.evidence_event_ids) <= set(previous.evidence_event_ids)
            ):
                return previous
            # Update the existing incident, retaining the first alert's ID and timestamp.
            signal.signal_id = previous.signal_id
            signal.created_at = previous.created_at
            signal.severity = max((previous.severity, signal.severity), key=rank.__getitem__)
            signal.source_ids = list(dict.fromkeys(previous.source_ids + signal.source_ids))
            signal.finding_refs = list(dict.fromkeys(previous.finding_refs + signal.finding_refs))
            signal.evidence_event_ids = list(dict.fromkeys(previous.evidence_event_ids + signal.evidence_event_ids))
            signal.snapshot_preserved |= previous.snapshot_preserved

        self.runtime.window_signals[signal.window_id] = signal
        for node in self.runtime.nodes:
            if node.source_id not in signal.source_ids or node.status == "isolated":
                continue
            if signal.severity == "SEV1":
                node.status = "compromised"
            elif node.status != "compromised":
                node.status = "elevated"
        if signal.severity == "SEV1" and self.runtime.threat_mode == "WATCH":
            self.runtime.threat_mode = "INVESTIGATE"
        self.runtime.council_signal = signal
        await self.runtime.publish("council_signal", signal)
        return signal

    async def _run_scout(
        self,
        window: Window,
        source_id: str,
        channel: Channel,
        events: list[StoredEvent],
    ) -> list[ScoutFinding]:
        async with self._semaphore:
            return await self.scouts[channel].analyze(window, source_id, events)

    async def _update_window_status(self, window: Window, status: WindowStatus) -> None:
        window.status = status
        if self.runtime is None:
            return
        for w in self.runtime.windows:
            if w.id == window.id:
                w.status = status
                break
        await self.runtime.publish("window", window)


class WindowScheduler:
    """Run early analysis without rotating; finalize and purge context at the deadline."""

    def __init__(
        self,
        *,
        coordinator: SwarmWindowCoordinator,
        runtime: VegaRuntimeState,
        window_seconds: int = 120,
        early_analysis: bool = True,
        early_delay_seconds: float = 0.35,
    ) -> None:
        self.coordinator = coordinator
        self.runtime = runtime
        self.window_seconds = max(1, window_seconds)
        self.early_analysis = early_analysis
        self.early_delay_seconds = early_delay_seconds
        self.lifecycle_lock = asyncio.Lock()  # Serialize ingest commits, rotation, and reset.
        self._window_changed = asyncio.Event()
        self._counter = 1000
        self._inflight: set[asyncio.Task] = set()
        self._loop_task: asyncio.Task[None] | None = None
        self._early_task: asyncio.Task[None] | None = None
        self._analysis_cache = _WindowAnalysisCache()
        self._hints: dict[str, set[Channel]] = {}
        self._early_pending: set[str] = set()
        self._early_scheduled: set[str] = set()

    def start(self) -> None:
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self._run_loop())

    async def reset(self) -> None:
        await self._cancel_jobs()
        self._counter = 1000
        self._window_changed.set()

    def _clear_early_state(self) -> None:
        self._early_task = None
        self._analysis_cache = _WindowAnalysisCache()
        self._hints.clear()
        self._early_pending.clear()
        self._early_scheduled.clear()

    async def _cancel_jobs(self) -> None:
        jobs = list(self._inflight)
        for task in jobs:
            task.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        self._inflight.clear()
        self._clear_early_state()

    def _track(self, task: asyncio.Task) -> None:
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

    def observe(self, event: StoredEvent) -> None:
        if not self.early_analysis or not has_early_hint(event):
            return
        current = self._get_active_window()
        source = event.source_id
        if event.ingested_at < current.start or source in self._early_scheduled:
            return
        channels = self._hints.setdefault(source, set())
        channels.add(event.channel)
        if len(channels) < 2:
            return
        self._early_scheduled.add(source)
        self._early_pending.add(source)
        if self._early_task is None or self._early_task.done():
            self._early_task = asyncio.create_task(self._run_early(current, self._analysis_cache))
            self._track(self._early_task)

    async def _run_early(self, current: Window, cache: _WindowAnalysisCache) -> None:
        while self.runtime.active_window_id == current.id and self._early_pending:
            await asyncio.sleep(self.early_delay_seconds)
            async with self.lifecycle_lock:
                if self.runtime.active_window_id != current.id:
                    return  # The final pass will handle any hints still in the queue.
                sources = self._early_pending.copy()
                self._early_pending.clear()
                snapshot = current.model_copy(update={"end": datetime.now(timezone.utc)})
            try:
                await self.coordinator.process_window_detailed(snapshot, early_sources=sources, cache=cache)
            except Exception as exc:
                logger.warning("Early analysis failed in %s (%s); final pass still scheduled", current.id, type(exc).__name__)

    async def stop(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._loop_task
            self._loop_task = None
        await self._cancel_jobs()
        # The API object can be started again on a new event loop (e.g. TestClient).
        self._window_changed = asyncio.Event()
        self.lifecycle_lock = asyncio.Lock()

    async def flush_current_window(self, *, wait: bool = False) -> WindowRunResult | Window:
        """Close the active window and immediately open its successor."""
        async with self.lifecycle_lock:
            current, task = await self._rotate_locked()
        return await asyncio.shield(task) if wait else current

    async def _rotate_locked(self) -> tuple[Window, asyncio.Task[WindowRunResult]]:
        current = self._get_active_window()
        now = datetime.now(timezone.utc)
        current.end = now
        early_task, cache = self._early_task, self._analysis_cache
        self._clear_early_state()

        self._counter += 1
        next_window = Window(
            id=f"W-{self._counter}",
            start=now,
            end=now + timedelta(seconds=self.window_seconds),
            status="collecting",
        )
        self.runtime.windows.append(next_window)
        self.runtime.active_window_id = next_window.id
        await self.runtime.publish("window", next_window)

        task = asyncio.create_task(self._finalize(current, early_task, cache))
        self._track(task)
        self._window_changed.set()
        return current, task

    async def _finalize(
        self, window: Window, early_task: asyncio.Task[None] | None, cache: _WindowAnalysisCache
    ) -> WindowRunResult:
        if early_task is not None:
            await early_task
        try:
            result = await self.coordinator.process_window_detailed(window, cache=cache)
        except Exception as exc:
            logger.warning("Final analysis failed in %s (%s)", window.id, type(exc).__name__)
            await self.coordinator._update_window_status(window, "failed")
            result = WindowRunResult(window, 0, [], self.runtime.window_signals.get(window.id))
        # Do not retain uncited raw telemetry indefinitely even if inference failed.
        try:
            await self.coordinator.store.purge_window(window)
            self.runtime.oldest_stream_event_at = await self.coordinator.store.oldest_event_time()
        except Exception as exc:
            logger.warning("Purge failed in %s (%s); stream TTL remains as a fallback", window.id, type(exc).__name__)
        finally:
            cache.scouts.clear()
            cache.correlations.clear()
            await self.runtime.clear_window_context(window)
        return result

    def _get_active_window(self) -> Window:
        for w in self.runtime.windows:
            if w.id == self.runtime.active_window_id:
                return w
        now = datetime.now(timezone.utc)
        w = Window(
            id=f"W-{self._counter}",
            start=now,
            end=now + timedelta(seconds=self.window_seconds),
            status="collecting",
        )
        self.runtime.windows.append(w)
        self.runtime.active_window_id = w.id
        return w

    async def _run_loop(self) -> None:
        while True:
            self._window_changed.clear()
            async with self.lifecycle_lock:
                current = self._get_active_window()
                delay = (current.end - datetime.now(timezone.utc)).total_seconds()
                if delay <= 0:
                    await self._rotate_locked()
                    continue
            with suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._window_changed.wait(), timeout=delay)
