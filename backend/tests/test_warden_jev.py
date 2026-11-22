"""Tests for Warden + TypeSafe AI Jev System One routing and live containment executor."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from oracle import context as oracle_context
from oracle.sentinel_bridge import OracleBridge
from vega.council.enforcer import DryRunContainmentExecutor, LiveContainmentExecutor
from vega.council.warden import JevEvaluation, JevWardenService, TypeSafeJevEvaluator
from vega.models import (
    CouncilSignal,
    DefenderOpinion,
    OracleAssessment,
    ProsecutorOpinion,
    ScoutFinding,
    StewardOpinion,
    StoredEvent,
    VmVerdict,
)
from vega.state import VegaRuntimeState

FIXTURE = Path(__file__).resolve().parents[1] / "oracle" / "fixtures" / "three_vm_request.json"


def _fixture():
    raw = json.loads(FIXTURE.read_text())
    signal = CouncilSignal.model_validate(raw["signal"])
    findings = [ScoutFinding.model_validate(f) for f in raw["findings"]]
    events = [StoredEvent.model_validate(e) for e in raw["events"]]
    return signal, findings, events


def _assessment(verdicts: list[VmVerdict], signal_id: str = "sig-1") -> OracleAssessment:
    return OracleAssessment(
        incident_id="INC-100",
        signal_id=signal_id,
        assessment="Correlated secret access, archive staging, and unapproved egress.",
        competing_explanations=[],
        cited_policies=[],
        historical_context="No prior incidents.",
        uncertainty="Low",
        recommended_action="Isolate compromised host and revoke credentials.",
        recommended_scope="host:vm-a",
        model_version="gemini-3.5-flash-lite",
        created_at=datetime.now(timezone.utc),
        verdicts=verdicts,
        council_ms=420,
    )


def _verdict(source_id: str, verdict: str) -> VmVerdict:
    return VmVerdict(
        source_id=source_id,
        verdict=verdict,  # type: ignore[arg-type]
        prosecutor=ProsecutorOpinion(score=0.92 if verdict == "CONTAIN" else 0.1, reason="evidence"),
        defender=DefenderOpinion(score=0.1 if verdict == "CONTAIN" else 0.9, hypothesis="benign", reason="check"),
        steward=StewardOpinion(allowed=True, policy_ids=["POL-CONTAIN-01"], reason="allowed"),
    )


class StubJev:
    def __init__(self, result: JevEvaluation) -> None:
        self.result = result
        self.last_state: dict | None = None

    async def evaluate(self, state: dict) -> JevEvaluation:
        self.last_state = state
        return self.result


async def test_jev_high_confidence_auto_contains_without_human():
    signal, findings, events = _fixture()
    assessment = _assessment(
        [_verdict("vm-a", "CONTAIN"), _verdict("vm-b", "NO_ACTION")],
        signal_id=signal.signal_id,
    )
    jev = StubJev(
        JevEvaluation(
            available=True,
            action_choice="quarantine_and_revoke",
            confidence=0.94,
            probabilities={
                "quarantine_and_revoke": 0.95,
                "quarantine_host": 0.04,
                "revoke_credentials": 0.01,
                "escalate_human": 0.0,
            },
            credential_compromise=0.96,
            host_compromise=0.93,
            safe_to_automate=0.91,
            model="jev-1.13.0",
        )
    )
    executor = DryRunContainmentExecutor({"vm-a": "auth0|demo"})
    warden = JevWardenService(jev=jev, executor=executor, vm_subjects={"vm-a": "auth0|demo"})

    decision = await warden.evaluate(assessment, signal=signal, findings=findings, events=events)
    assert decision is not None
    assert decision.requires_human_approval is False
    assert decision.approval_status == "approved"
    assert decision.approval_ref and decision.approval_ref.startswith("AUTO-JEV-")
    assert decision.action_type == "quarantine_and_revoke"
    assert decision.target_hosts == ["vm-a"]  # vm-b (NO_ACTION) excluded
    assert jev.last_state is not None
    assert jev.last_state["enrolled_auth0_hosts"] == ["vm-a"]

    runtime = VegaRuntimeState()
    for ev in events:
        runtime.record_event(ev)
    runtime.council_signal = signal
    enforced = await warden.enforce_decision(decision, runtime)
    assert enforced.execution_status == "contained_dry_run"
    assert runtime.threat_mode == "CONTAINED"
    assert next(n for n in runtime.nodes if n.source_id == "vm-a").status == "isolated"
    assert next(n for n in runtime.nodes if n.source_id == "vm-b").status == "healthy"


async def test_jev_low_confidence_fails_closed_to_human():
    signal, findings, events = _fixture()
    assessment = _assessment([_verdict("vm-a", "CONTAIN")], signal_id=signal.signal_id)
    jev = StubJev(
        JevEvaluation(
            available=True,
            action_choice="quarantine_host",
            confidence=0.52,
            probabilities={"quarantine_host": 0.64, "escalate_human": 0.36},
            credential_compromise=0.2,
            host_compromise=0.75,
            safe_to_automate=0.45,
            model="jev-1.13.0",
        )
    )
    warden = JevWardenService(jev=jev, executor=DryRunContainmentExecutor())

    decision = await warden.evaluate(assessment, signal=signal, findings=findings, events=events)
    assert decision is not None
    assert decision.requires_human_approval is True
    assert decision.approval_status == "pending"
    assert decision.execution_status == "awaiting_authorization"
    assert any(c.id == "jev-confidence" and not c.passed for c in decision.policy_checks)


async def test_jev_unavailable_fails_closed_to_human():
    signal, findings, events = _fixture()
    assessment = _assessment([_verdict("vm-a", "CONTAIN")], signal_id=signal.signal_id)
    evaluator = TypeSafeJevEvaluator(api_key="")
    warden = JevWardenService(jev=evaluator, executor=DryRunContainmentExecutor())

    decision = await warden.evaluate(assessment, signal=signal, findings=findings, events=events)
    assert decision is not None
    assert decision.requires_human_approval is True
    assert decision.execution_status == "awaiting_authorization"
    assert decision.jev_decision is not None
    assert decision.jev_decision["available"] is False


async def test_protected_host_and_oracle_escalate_override_jev(monkeypatch):
    monkeypatch.setattr(oracle_context, "PROTECTED_HOSTS", {"vm-a"})
    # Also patch the imported reference inside warden module
    from vega.council import warden as warden_mod

    monkeypatch.setattr(warden_mod, "PROTECTED_HOSTS", {"vm-a"})

    signal, findings, events = _fixture()
    assessment = _assessment([_verdict("vm-a", "CONTAIN")], signal_id=signal.signal_id)
    jev = StubJev(
        JevEvaluation(
            available=True,
            action_choice="quarantine_host",
            confidence=0.99,
            probabilities={"quarantine_host": 0.99},
            credential_compromise=0.1,
            host_compromise=0.99,
            safe_to_automate=0.99,
            model="jev-1.13.0",
        )
    )
    warden = JevWardenService(jev=jev, executor=DryRunContainmentExecutor())
    decision = await warden.evaluate(assessment, signal=signal, findings=findings, events=events)
    assert decision is not None
    assert decision.requires_human_approval is True
    assert any(c.id == "protected-host" and not c.passed for c in decision.policy_checks)


async def test_all_no_action_returns_none():
    signal, findings, events = _fixture()
    assessment = _assessment([_verdict("vm-b", "NO_ACTION")], signal_id=signal.signal_id)
    warden = JevWardenService(
        jev=StubJev(
            JevEvaluation(
                available=True,
                action_choice="escalate_human",
                confidence=1.0,
                probabilities={"escalate_human": 1.0},
                credential_compromise=0.0,
                host_compromise=0.0,
                safe_to_automate=0.0,
                model="jev-1.13.0",
            )
        ),
        executor=DryRunContainmentExecutor(),
    )
    assert await warden.evaluate(assessment, signal=signal, findings=findings, events=events) is None


async def test_live_executor_runs_vault_auth0_and_iptables(monkeypatch):
    calls: list[tuple[str, list[str]]] = []
    auth0_calls: list[tuple[str, bool]] = []

    executor = LiveContainmentExecutor(
        auth0_domain="example.us.auth0.com",
        auth0_client_id="warden-m2m",
        auth0_client_secret="secret",
        vm_subjects={"vm-a": "auth0|6b01f488d9d84efdf43850d4"},
        telemetry_host="10.97.0.1",
    )

    async def fake_multipass(host: str, args: list[str], *, stdin_text: str | None = None):
        calls.append((host, args))
        return 0, "", ""

    async def fake_auth0(user_id: str, *, blocked: bool):
        auth0_calls.append((user_id, blocked))

    monkeypatch.setattr(executor, "_run_multipass", fake_multipass)
    monkeypatch.setattr(executor, "_set_auth0_blocked", fake_auth0)

    res = await executor.execute("quarantine_and_revoke", ["vm-a"])
    assert res.succeeded is True
    assert res.isolated_hosts == ["vm-a"]
    assert res.revoked_subjects == ["auth0|6b01f488d9d84efdf43850d4"]
    assert auth0_calls == [("auth0|6b01f488d9d84efdf43850d4", True)]
    assert len(calls) == 3  # 1 Vault blocked-users + 1 modprobe nf_conntrack + 1 iptables quarantine

    # Live mode sets execution_status="contained" (not contained_dry_run)
    warden = JevWardenService(
        jev=StubJev(
            JevEvaluation(
                available=True,
                action_choice="quarantine_and_revoke",
                confidence=0.95,
                probabilities={"quarantine_and_revoke": 0.96},
                credential_compromise=0.95,
                host_compromise=0.95,
                safe_to_automate=0.95,
                model="jev-1.13.0",
            )
        ),
        executor=executor,
        vm_subjects={"vm-a": "auth0|6b01f488d9d84efdf43850d4"},
    )
    signal, findings, events = _fixture()
    assessment = _assessment([_verdict("vm-a", "CONTAIN")], signal_id=signal.signal_id)
    decision = await warden.evaluate(assessment, signal=signal, findings=findings, events=events)
    assert decision is not None and decision.dry_run is False

    runtime = VegaRuntimeState()
    for ev in events:
        runtime.record_event(ev)
    runtime.council_signal = signal
    enforced = await warden.enforce_decision(decision, runtime)
    assert enforced.execution_status == "contained"
    assert runtime.threat_mode == "CONTAINED"

    # Release restores VM + Auth0
    await executor.release_all(["vm-a"])
    assert ("auth0|6b01f488d9d84efdf43850d4", False) in auth0_calls


async def test_oracle_bridge_invokes_warden_callback():
    signal, findings, events = _fixture()
    runtime = VegaRuntimeState()
    for ev in events:
        runtime.record_event(ev)
    runtime.council_signal = signal

    seen: list[str] = []

    async def on_assessment(assessment, sig, _findings, _events):
        seen.append(f"{assessment.signal_id}:{sig.severity}")

    bridge = OracleBridge(runtime, mock=True, on_assessment=on_assessment)
    assessment = await bridge.handle_signal(signal, findings)
    assert assessment is not None
    assert seen == [f"{signal.signal_id}:SEV1"]


async def test_oracle_bridge_stage_delay_aborts_on_reset():
    signal, findings, events = _fixture()
    runtime = VegaRuntimeState()
    for ev in events:
        runtime.record_event(ev)
    runtime.council_signal = signal

    called = False

    async def on_assessment(*_args):
        nonlocal called
        called = True

    bridge = OracleBridge(runtime, mock=True, on_assessment=on_assessment, stage_delay_s=0.05)
    task = bridge.schedule(signal, findings)
    assert task is not None
    await asyncio.sleep(0.01)
    runtime.reset()  # reset during stage delay
    assessment = await task
    assert assessment is None
    assert runtime.oracle_assessment is None
    assert called is False


async def test_demo_topology_interconnects_host_vms_and_infra_nodes(monkeypatch):
    from vega import state as state_mod

    monkeypatch.setattr(state_mod.settings, "demo_topology", True)
    rt = VegaRuntimeState()
    node_ids = {n.source_id for n in rt.nodes}
    assert {"vega-core", "vm-d", "vm-e", "vm-f", "vm-g", "vm-h", "vm-i", "vm-j", "vm-k"} <= node_ids

    now = datetime.now(timezone.utc)
    for idx, vm in enumerate(("vm-a", "vm-b", "vm-c")):
        rt.record_event(
            StoredEvent(
                schema_version=1,
                run_id="topo-test",
                event_id=f"evt-topo-{idx}",
                source_id=vm,
                channel="process",
                event_time=now,
                ingested_at=now,
                payload={"host_role": "Linux VM Endpoint"},
            )
        )

    edge_pairs = {(e.from_node, e.to_node) for e in rt.edges}
    assert ("vm-a", "vm-b") in edge_pairs
    assert ("vm-b", "vm-c") in edge_pairs
    assert ("vm-a", "vm-c") in edge_pairs
    assert ("vm-a", "vega-core") in edge_pairs
    assert ("vm-b", "vega-core") in edge_pairs
    assert ("vm-c", "vega-core") in edge_pairs


async def test_typesafe_jev_evaluator_parses_system_one_response():
    import httpx2

    def handler(request: httpx2.Request) -> httpx2.Response:
        assert request.url.path == "/v1/systemone"
        return httpx2.Response(
            200,
            json={
                "model": "jev-1.13.0",
                "usage": {"input_tokens": 120, "output_tokens": 4},
                "answers": {
                    "containment_action": {
                        "type": "choice",
                        "choice": "revoke_credentials",
                        "confidence": 0.91,
                        "probabilities": {
                            "revoke_credentials": 0.93,
                            "quarantine_host": 0.05,
                            "quarantine_and_revoke": 0.02,
                            "escalate_human": 0.0,
                        },
                    },
                    "credential_compromise": {"type": "noul", "noul": 0.94},
                    "host_compromise": {"type": "noul", "noul": 0.22},
                    "safe_to_automate": {"type": "noul", "noul": 0.89},
                },
            },
        )

    from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul

    transport = httpx2.MockTransport(handler)
    async with AsyncTypeSafeClient(api_key="test-key", transport=transport) as client:
        resp = await client.system_one(
            state={"host": "vm-a"},
            questions={
                "containment_action": Choice(
                    instructions="pick",
                    criteria={
                        "revoke_credentials": "revoke",
                        "quarantine_host": "quarantine",
                        "quarantine_and_revoke": "both",
                        "escalate_human": "human",
                    },
                ),
                "credential_compromise": Noul(instructions="cred"),
                "host_compromise": Noul(instructions="host"),
                "safe_to_automate": Noul(instructions="safe"),
            },
        )
    assert resp.choices["containment_action"].choice == "revoke_credentials"
    assert resp.choices["containment_action"].confidence == pytest.approx(0.91)
    assert resp.nouls["credential_compromise"].noul == pytest.approx(0.94)
