"""Sentinel -> Oracle bridge (in-process).

When Sentinel's window coordinator produces a SEV1 CouncilSignal, this bridge:
  1. builds an OracleRequest from the signal plus the findings and events it references,
  2. runs the Oracle council (Gemini, or canned opinions in mock mode),
  3. stores the result on runtime.oracle_assessment and publishes an `oracle_assessment`
     SSE event (frontend/src/engine/liveSource.ts already listens for it).

It wraps the coordinator instead of changing Sentinel's code, and is opt-in:

  ORACLE_BRIDGE=1        enable (default off: Sentinel behaves exactly as before)
  ORACLE_BRIDGE_MOCK=1   use oracle/fixtures/mock_opinions.json instead of Gemini
  ORACLE_BRIDGE_TIMEOUT  seconds for the whole council run (default 90)

Failures never break Sentinel: if the council cannot run, the error is logged and no
assessment is stored, so nothing downstream acts on it (fail closed).
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Iterable

from dotenv import load_dotenv

from vega.models import CouncilSignal, OracleAssessment, ScoutFinding, StoredEvent

from .schemas import OracleRequest

log = logging.getLogger("oracle.bridge")

_TRUE = {"1", "true", "yes", "on"}


def _flag(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in _TRUE


def build_request(
    signal: CouncilSignal,
    findings: Iterable[ScoutFinding],
    events: Iterable[StoredEvent],
) -> OracleRequest:
    """Turn Sentinel's signal (which only carries references) into Oracle's full packet."""
    findings = list(findings)
    refs = set(signal.finding_refs)
    picked = [f for f in findings if f.finding_id in refs]
    if not picked:  # no usable refs: fall back to every finding for the flagged hosts
        sources = set(signal.source_ids)
        picked = [f for f in findings if f.source_id in sources]

    wanted = set(signal.evidence_event_ids) | {eid for f in picked for eid in f.evidence_event_ids}
    seen: set[str] = set()
    picked_events = []
    for e in events:
        if e.event_id in wanted and e.event_id not in seen:
            seen.add(e.event_id)
            picked_events.append(e)

    return OracleRequest.model_validate(
        {
            "signal": signal.model_dump(mode="json"),
            "findings": [f.model_dump(mode="json") for f in picked],
            "events": [e.model_dump(mode="json") for e in picked_events],
        }
    )


class OracleBridge:
    def __init__(
        self,
        runtime,
        *,
        mock: bool | None = None,
        caller=None,
        timeout_s: float | None = None,
        on_assessment=None,
        stage_delay_s: float | None = None,
    ) -> None:
        self.runtime = runtime
        self.mock = _flag("ORACLE_BRIDGE_MOCK") if mock is None else mock
        self.timeout_s = timeout_s or float(os.getenv("ORACLE_BRIDGE_TIMEOUT", "90"))
        self._caller = caller
        self._label = "custom" if caller else None
        self._on_assessment = on_assessment
        self.stage_delay_s = (
            max(0.0, float(os.getenv("VEGA_STAGE_DELAY_SECONDS", "0")))
            if stage_delay_s is None
            else max(0.0, stage_delay_s)
        )
        self._tasks: set[asyncio.Task] = set()

    def _get_caller(self):
        if self._caller is None:
            from . import council  # imported late so ORACLE_* env vars from .env apply

            self._caller, self._label = (
                (council.mock_caller(), "mock") if self.mock else (council.gemini_caller(), council.MODEL)
            )
        return self._caller, self._label

    async def assess(
        self, signal: CouncilSignal, findings: Iterable[ScoutFinding], events: Iterable[StoredEvent]
    ) -> OracleAssessment:
        from . import council

        request = build_request(signal, findings, events)
        caller, label = self._get_caller()
        result = await asyncio.wait_for(council.decide(request, caller, label), self.timeout_s)
        return OracleAssessment.model_validate(result.model_dump(mode="json"))

    async def handle_signal(self, signal: CouncilSignal | None, findings: Iterable[ScoutFinding]) -> OracleAssessment | None:
        if signal is None or signal.severity != "SEV1":
            return None
        rt = self.runtime
        if self.stage_delay_s > 0:
            await asyncio.sleep(self.stage_delay_s)
            if rt.council_signal != signal:
                log.info("Skipping Oracle for %s: signal was reset or superseded during stage delay", signal.signal_id)
                return None
        events = list(rt.preserved_evidence.values()) + list(rt.events)
        try:
            assessment = await self.assess(signal, findings, events)
        except Exception:  # noqa: BLE001 - never break Sentinel; fail closed
            log.exception("Oracle council failed for %s; no assessment stored", signal.signal_id)
            return None

        current = rt.council_signal
        if current != signal:
            log.info("Discarding assessment for %s: signal was reset or superseded", signal.signal_id)
            return None
        rt.oracle_assessment = assessment
        await rt.publish("oracle_assessment", assessment)
        if self._on_assessment is not None and rt.council_signal == signal:
            try:
                await self._on_assessment(assessment, signal, list(findings), events)
            except Exception:  # noqa: BLE001 - never break Oracle on downstream Warden error
                log.exception("Warden handler failed for %s", signal.signal_id)
        return assessment

    def schedule(self, signal: CouncilSignal | None, findings: Iterable[ScoutFinding]) -> asyncio.Task | None:
        """Run the council in the background so Sentinel's window processing isn't delayed."""
        if signal is None or signal.severity != "SEV1":
            return None
        task = asyncio.create_task(self.handle_signal(signal, list(findings)))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def drain(self) -> None:
        """Wait for in-flight council runs (tests / shutdown)."""
        if self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)


def attach(coordinator, runtime, **kwargs) -> OracleBridge | None:
    """Hook Oracle onto Sentinel's coordinator. Returns None (and changes nothing) unless ORACLE_BRIDGE=1."""
    load_dotenv()  # does not override variables already set in the environment
    if not _flag("ORACLE_BRIDGE"):
        return None

    bridge = OracleBridge(runtime, **kwargs)
    original = coordinator.process_window_detailed

    async def process_window_detailed(window, **options):
        previous = runtime.window_signals.get(window.id)
        result = await original(window, **options)
        if result.signal is not None and result.signal != previous:
            # The final pass can reuse the early signal without reopening the case.
            refs = set(result.signal.finding_refs)
            bridge.schedule(result.signal, [f for f in runtime.findings if f.finding_id in refs])
        return result

    coordinator.process_window_detailed = process_window_detailed
    log.info("Oracle bridge attached (%s)", "mock" if bridge.mock else "gemini")
    return bridge
