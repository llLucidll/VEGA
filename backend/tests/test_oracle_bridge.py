"""Sentinel -> Oracle integration tests (backend/oracle/sentinel_bridge.py)."""

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from oracle import council
from oracle.schemas import OracleRequest
from oracle.sentinel_bridge import OracleBridge, attach, build_request
from vega.models import CouncilSignal, OracleAssessment, ScoutFinding, StoredEvent, Window
from vega.state import VegaRuntimeState
from vega.streams import InMemoryStreamStore
from vega.swarm import (
    GeminiChannelScout,
    GeminiWindowCorrelator,
    HeuristicStructuredReasoner,
    SwarmWindowCoordinator,
)

FIXTURE = Path(__file__).resolve().parents[1] / "oracle" / "fixtures" / "three_vm_request.json"


def _fixture():
    raw = json.loads(FIXTURE.read_text())
    signal = CouncilSignal.model_validate(raw["signal"])
    findings = [ScoutFinding.model_validate(f) for f in raw["findings"]]
    events = [StoredEvent.model_validate(e) for e in raw["events"]]
    return signal, findings, events


def _sentinel(runtime: VegaRuntimeState, store: InMemoryStreamStore) -> SwarmWindowCoordinator:
    """Sentinel wired like vega/api.py, with the deterministic heuristic reasoner."""
    reasoner = HeuristicStructuredReasoner()
    return SwarmWindowCoordinator(
        store=store,
        scouts={ch: GeminiChannelScout(channel=ch, reasoner=reasoner) for ch in ("file", "network", "process")},
        correlator=GeminiWindowCorrelator(reasoner=reasoner),
        runtime=runtime,
    )


def _frames(queue: asyncio.Queue) -> list[str]:
    out = []
    while not queue.empty():
        out.append(queue.get_nowait())
    return out


# ---------- contract ----------

async def test_oracle_output_keeps_verdicts_in_shared_contract():
    signal, findings, events = _fixture()
    request = build_request(signal, findings, events)
    result = await council.decide(request, council.mock_caller(), "mock")

    shared = OracleAssessment.model_validate(result.model_dump(mode="json"))

    assert {v.source_id: v.verdict for v in shared.verdicts} == {
        "vm-a": "CONTAIN",
        "vm-b": "NO_ACTION",
        "vm-c": "CONTAIN",
    }
    assert shared.council_ms == result.council_ms


def test_existing_assessments_without_verdicts_still_validate():
    a = OracleAssessment(
        incident_id="INC-1", signal_id="sig-1", assessment="x", competing_explanations=[],
        cited_policies=[], historical_context="", uncertainty="", recommended_action="",
        recommended_scope="", model_version="m", created_at=datetime.now(timezone.utc),
    )
    assert a.verdicts == [] and a.council_ms == 0


def test_build_request_uses_only_referenced_findings_and_events():
    signal, findings, events = _fixture()
    extra = findings[0].model_copy(update={"finding_id": "fnd-unrelated"})
    request = build_request(signal, findings + [extra], events + events)  # duplicates on purpose

    assert isinstance(request, OracleRequest)
    assert "fnd-unrelated" not in {f.finding_id for f in request.findings}
    ids = [e.event_id for e in request.events]
    assert len(ids) == len(set(ids))


# ---------- end to end: Sentinel produces the signal, Oracle assesses it ----------

async def test_sentinel_sev1_reaches_oracle_and_is_published(monkeypatch):
    monkeypatch.setenv("ORACLE_BRIDGE", "1")
    store = InMemoryStreamStore()
    runtime = VegaRuntimeState()
    now = datetime.now(timezone.utc)
    window = Window(id="W-oracle", start=now - timedelta(seconds=5), end=now + timedelta(seconds=30))
    runtime.windows = [window]
    runtime.active_window_id = window.id

    _, _, events = _fixture()
    for i, ev in enumerate(events):  # replay the demo telemetry into the current window
        ev = ev.model_copy(update={"ingested_at": now + timedelta(milliseconds=i)})
        await store.append(ev)
        runtime.record_event(ev)

    coordinator = _sentinel(runtime, store)
    bridge = attach(coordinator, runtime, mock=True)
    assert bridge is not None
    queue = runtime.subscribe()

    result = await coordinator.process_window_detailed(window)
    await bridge.drain()

    assert result.signal is not None, "Sentinel did not escalate the demo telemetry"
    assert result.signal.severity == "SEV1"
    assessment = runtime.oracle_assessment
    assert assessment is not None, "Oracle assessment was not stored"
    assert assessment.signal_id == result.signal.signal_id
    assert [v.source_id for v in assessment.verdicts] == result.signal.source_ids
    assert any(f.startswith("event: oracle_assessment") for f in _frames(queue))


def test_attach_is_a_no_op_when_disabled(monkeypatch):
    monkeypatch.setenv("ORACLE_BRIDGE", "0")
    coordinator = _sentinel(VegaRuntimeState(), InMemoryStreamStore())

    assert attach(coordinator, VegaRuntimeState()) is None
    assert "process_window_detailed" not in vars(coordinator)  # original method untouched


# ---------- fail closed ----------

async def test_assessment_discarded_after_demo_reset():
    signal, findings, events = _fixture()
    runtime = VegaRuntimeState()
    runtime.events = events
    runtime.council_signal = None  # e.g. /api/demo/reset happened while the council ran

    bridge = OracleBridge(runtime, mock=True)
    assert await bridge.handle_signal(signal, findings) is None
    assert runtime.oracle_assessment is None


async def test_council_timeout_stores_nothing_and_does_not_raise():
    signal, findings, events = _fixture()
    runtime = VegaRuntimeState()
    runtime.events = events
    runtime.council_signal = signal

    async def slow(*_args, **_kwargs):
        await asyncio.sleep(5)

    bridge = OracleBridge(runtime, caller=slow, timeout_s=0.05)
    assert await bridge.handle_signal(signal, findings) is None
    assert runtime.oracle_assessment is None


async def test_non_sev1_signals_are_ignored():
    signal, findings, _ = _fixture()
    runtime = VegaRuntimeState()
    runtime.council_signal = signal.model_copy(update={"severity": "HIGH"})

    bridge = OracleBridge(runtime, mock=True)
    assert bridge.schedule(runtime.council_signal, findings) is None
    assert await bridge.handle_signal(runtime.council_signal, findings) is None
