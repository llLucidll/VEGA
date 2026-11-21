"""Overlapping window coordinator and scheduler for the Sentinel scout swarm."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Protocol

from ..models import Channel, CouncilSignal, ScoutFinding, StoredEvent, Window
from ..state import VegaRuntimeState
from ..streams.store import StreamStore
from .correlator import WindowCorrelator
from .scouts import ChannelScout


@dataclass(frozen=True)
class WindowRunResult:
    window: Window
    chunks_analyzed: int
    findings: list[ScoutFinding]
    signal: CouncilSignal | None


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
    ) -> None:
        self.store = store
        self.scouts = scouts
        self.correlator = correlator
        self.runtime = runtime
        self._semaphore = asyncio.Semaphore(max(1, max_concurrency))

    async def process_window(self, window: Window) -> CouncilSignal | None:
        result = await self.process_window_detailed(window)
        return result.signal

    async def process_window_detailed(self, window: Window) -> WindowRunResult:
        await self._update_window_status(window, "scouting")

        chunks = await self.store.read_window(window)
        tasks = [
            self._run_scout(window, source_id, channel, events)
            for (source_id, channel), events in sorted(chunks.items())
            if events and channel in self.scouts
        ]

        nested_findings = await asyncio.gather(*tasks) if tasks else []
        findings = [f for group in nested_findings for f in group]

        if self.runtime is not None:
            for finding in findings:
                self.runtime.findings.append(finding)
                await self.runtime.publish("finding", finding)

        await self._update_window_status(window, "correlating")
        signal = await self.correlator.correlate(window, findings)

        if signal is not None:
            await self._update_window_status(window, "flagged")
            if self.runtime is not None:
                self.runtime.council_signal = signal
                self.runtime.preserve_evidence(signal.evidence_event_ids)
                if signal.severity == "SEV1":
                    self.runtime.threat_mode = "INVESTIGATE"
                for node in self.runtime.nodes:
                    if node.source_id in signal.source_ids:
                        node.status = "compromised" if signal.severity == "SEV1" else "elevated"
                await self.runtime.publish("council_signal", signal)
        else:
            await self._update_window_status(window, "clean")

        return WindowRunResult(
            window=window,
            chunks_analyzed=len(tasks),
            findings=findings,
            signal=signal,
        )

    async def _run_scout(
        self,
        window: Window,
        source_id: str,
        channel: Channel,
        events: list[StoredEvent],
    ) -> list[ScoutFinding]:
        async with self._semaphore:
            return await self.scouts[channel].analyze(window, source_id, events)

    async def _update_window_status(self, window: Window, status: Window["status"]) -> None:
        window.status = status
        if self.runtime is None:
            return
        for w in self.runtime.windows:
            if w.id == window.id:
                w.status = status
                break
        await self.runtime.publish("window", window)


class WindowScheduler:
    """Rotates aligned windows so Window N+1 collects/scouts while Window N correlates."""

    def __init__(
        self,
        *,
        coordinator: SwarmWindowCoordinator,
        runtime: VegaRuntimeState,
        window_seconds: int = 120,
    ) -> None:
        self.coordinator = coordinator
        self.runtime = runtime
        self.window_seconds = max(1, window_seconds)
        self._counter = 1000
        self._inflight: set[asyncio.Task[WindowRunResult]] = set()
        self._loop_task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._loop_task is None or self._loop_task.done():
            self._loop_task = asyncio.create_task(self._run_loop())

    async def reset(self) -> None:
        for task in list(self._inflight):
            task.cancel()
        if self._inflight:
            await asyncio.gather(*self._inflight, return_exceptions=True)
        self._inflight.clear()
        self._counter = 1000

    async def stop(self) -> None:
        if self._loop_task is not None:
            self._loop_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._loop_task
            self._loop_task = None
        for task in list(self._inflight):
            task.cancel()
        if self._inflight:
            await asyncio.gather(*self._inflight, return_exceptions=True)
        self._inflight.clear()

    async def flush_current_window(self, *, wait: bool = False) -> WindowRunResult | Window:
        """Close the active window, immediately open the next window, and correlate in background."""
        now = datetime.now(timezone.utc)
        current = self._get_active_window()
        current.end = now

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

        task = asyncio.create_task(self.coordinator.process_window_detailed(current))
        self._inflight.add(task)
        task.add_done_callback(self._inflight.discard)

        if wait:
            return await task
        return current

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
            await asyncio.sleep(self.window_seconds)
            await self.flush_current_window(wait=False)
