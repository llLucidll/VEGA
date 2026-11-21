import asyncio
import json
import shutil
import subprocess
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from vega import api
from vega.models import Channel, StoredEvent, Window
from vega.state import VegaRuntimeState
from vega.streams import EventMapper, InMemoryStreamStore, RedisStreamStore
from vega.swarm import (
    CorrelatorOutput,
    GeminiChannelScout,
    GeminiStructuredReasoner,
    GeminiWindowCorrelator,
    HeuristicStructuredReasoner,
    ReportingRules,
    ScoutChunkOutput,
    ScoutFindingDraft,
    SwarmWindowCoordinator,
    WindowScheduler,
)


class FakeReasoner:
    """Deterministic fake StructuredReasoner recording every chunk submitted."""

    mode_name = "fake-test"

    def __init__(self, *, hallucinate_ids: bool = False, delay_sec: float = 0.0) -> None:
        self.calls: list[dict[str, object]] = []
        self.hallucinate_ids = hallucinate_ids
        self.delay_sec = delay_sec

    async def generate(self, *, system_instruction: str, prompt: str, response_schema):
        if self.delay_sec > 0:
            await asyncio.sleep(self.delay_sec)
        payload = json.loads(prompt)
        self.calls.append({"schema": response_schema.__name__, "payload": payload})

        if response_schema is ScoutChunkOutput:
            if self.hallucinate_ids:
                return ScoutChunkOutput(
                    findings=[
                        ScoutFindingDraft(
                            signal="invented_signal",
                            rationale="Hallucinated event reference",
                            evidence_event_ids=["evt-does-not-exist"],
                            confidence="high",
                        )
                    ]
                )
            events = payload["events"]
            suspicious = [e["event_id"] for e in events if e["payload"].get("suspicious")]
            if not suspicious:
                return ScoutChunkOutput(findings=[])
            return ScoutChunkOutput(
                findings=[
                    ScoutFindingDraft(
                        signal=f"{payload['channel']}_anomaly",
                        rationale="Detected synthetic suspicious marker",
                        evidence_event_ids=suspicious,
                        confidence="high",
                    )
                ]
            )

        if response_schema is CorrelatorOutput:
            findings = payload["findings"]
            return CorrelatorOutput(
                should_escalate=True,
                severity="SEV1",
                summary="Correlated multi-channel exfiltration",
                rationale="Joined file, process, and network findings",
                source_ids=sorted({f["source_id"] for f in findings}),
                finding_refs=[f["finding_id"] for f in findings],
                evidence_event_ids=[
                    eid for f in findings for eid in f["evidence_event_ids"]
                ],
                escalation_rule="RULE-EXFIL-MULTI-CHANNEL-01",
            )

        raise AssertionError(f"Unexpected schema: {response_schema}")


def _ev(
    event_id: str,
    source_id: str,
    channel: Channel,
    ingested_at: datetime,
    payload: dict[str, object],
) -> StoredEvent:
    return StoredEvent(
        schema_version=1,
        run_id="swarm-test",
        event_id=event_id,
        source_id=source_id,
        channel=channel,
        event_time=ingested_at,
        ingested_at=ingested_at,
        payload=payload,
    )


async def test_every_populated_chunk_analyzed_and_benign_returns_no_signal():
    store = InMemoryStreamStore()
    reasoner = FakeReasoner()
    runtime = VegaRuntimeState()
    now = datetime.now(timezone.utc)
    window = Window(id="W-benign", start=now - timedelta(seconds=5), end=now + timedelta(seconds=30))

    await store.append(_ev("b1", "vm-a", "file", now, {"op": "write", "path": "/src/app.py"}))
    await store.append(_ev("b2", "vm-b", "network", now, {"dst": "10.24.8.15:443", "internal": True}))

    scouts = {
        ch: GeminiChannelScout(channel=ch, reasoner=reasoner)
        for ch in ("file", "network", "process")
    }
    coordinator = SwarmWindowCoordinator(
        store=store,
        scouts=scouts,
        correlator=GeminiWindowCorrelator(reasoner=reasoner),
        runtime=runtime,
    )

    result = await coordinator.process_window_detailed(window)
    assert result.chunks_analyzed == 2
    assert result.findings == []
    assert result.signal is None
    assert window.status == "clean"
    # Both benign chunks were submitted to scouts; Correlator was not called on empty findings.
    assert [c["schema"] for c in reasoner.calls] == ["ScoutChunkOutput", "ScoutChunkOutput"]


async def test_hallucinated_event_ids_are_rejected():
    reasoner = FakeReasoner(hallucinate_ids=True)
    scout = GeminiChannelScout(channel="file", reasoner=reasoner)
    now = datetime.now(timezone.utc)
    window = Window(id="W-halluc", start=now, end=now + timedelta(minutes=2))

    findings = await scout.analyze(
        window,
        "vm-a",
        [_ev("real-1", "vm-a", "file", now, {"op": "read"})],
    )
    assert findings == []


async def test_positive_multi_channel_window_escalates_sev1_and_preserves_evidence():
    store = InMemoryStreamStore()
    reasoner = HeuristicStructuredReasoner()
    runtime = VegaRuntimeState()
    now = datetime.now(timezone.utc)
    window = Window(id="W-1042", start=now - timedelta(seconds=5), end=now + timedelta(seconds=30))
    runtime.windows = [window]
    runtime.active_window_id = window.id

    events = [
        _ev(
            "evt-1",
            "vm-a",
            "file",
            now,
            {"op": "read_burst", "path": "/srv/secrets/prod-keys/", "hidden_dotfile": True},
        ),
        _ev(
            "evt-2",
            "vm-a",
            "process",
            now + timedelta(seconds=1),
            {"cmd": "tar -czf /tmp/.cache-bundle.tar.gz /srv/secrets/prod-keys"},
        ),
        _ev(
            "evt-3",
            "vm-a",
            "network",
            now + timedelta(seconds=2),
            {"dst": "198.51.100.44:8443", "bytes_out": 48210944, "internal": False},
        ),
        _ev(
            "evt-4",
            "vm-b",
            "network",
            now + timedelta(seconds=3),
            {"src": "vm-a", "dst": "vm-b:22", "status": "rejected"},
        ),
    ]
    for ev in events:
        await store.append(ev)
        runtime.record_event(ev)

    scouts = {
        ch: GeminiChannelScout(channel=ch, reasoner=reasoner)
        for ch in ("file", "network", "process")
    }
    coordinator = SwarmWindowCoordinator(
        store=store,
        scouts=scouts,
        correlator=GeminiWindowCorrelator(
            reasoner=reasoner,
            reporting_rules=ReportingRules(min_channels_for_sev1=2),
        ),
        runtime=runtime,
    )

    result = await coordinator.process_window_detailed(window)
    assert result.chunks_analyzed == 4
    assert len(result.findings) == 4
    assert result.signal is not None
    assert result.signal.severity == "SEV1"
    assert result.signal.snapshot_preserved is True
    assert set(result.signal.evidence_event_ids) == {"evt-1", "evt-2", "evt-3", "evt-4"}
    assert set(runtime.preserved_evidence.keys()) == {"evt-1", "evt-2", "evt-3", "evt-4"}
    assert runtime.threat_mode == "INVESTIGATE"
    assert window.status == "flagged"


async def test_overlapping_windows_next_window_opens_while_prior_correlates():
    store = InMemoryStreamStore()
    reasoner = FakeReasoner(delay_sec=0.08)
    runtime = VegaRuntimeState()
    now = datetime.now(timezone.utc)
    await store.append(_ev("e-w1", "vm-a", "file", now, {"suspicious": True}))

    scouts = {
        ch: GeminiChannelScout(channel=ch, reasoner=reasoner)
        for ch in ("file", "network", "process")
    }
    coordinator = SwarmWindowCoordinator(
        store=store,
        scouts=scouts,
        correlator=GeminiWindowCorrelator(
            reasoner=reasoner,
            reporting_rules=ReportingRules(min_channels_for_sev1=2, allow_single_channel_high=True),
        ),
        runtime=runtime,
    )
    scheduler = WindowScheduler(coordinator=coordinator, runtime=runtime, window_seconds=120)

    closed = await scheduler.flush_current_window(wait=False)
    assert closed.id == "W-1000"
    # Next window is immediately active while W-1000 is still running in background
    assert runtime.active_window_id == "W-1001"

    await asyncio.sleep(0.25)
    assert runtime.council_signal is not None
    assert runtime.council_signal.window_id == "W-1000"
    await scheduler.stop()


def test_api_ingest_and_flush_window_end_to_end():
    with TestClient(api.app) as client:
        client.post("/api/demo/reset")
        now = datetime.now(timezone.utc).isoformat()

        for idx, (ch, payload) in enumerate(
            [
                ("file", {"op": "read_burst", "path": "/srv/secrets/prod-keys/"}),
                ("process", {"cmd": "tar -czf /tmp/.cache-bundle.tar.gz /srv/secrets/prod-keys"}),
                ("network", {"dst": "198.51.100.44:8443", "bytes_out": 48210944}),
            ],
            start=1,
        ):
            res = client.post(
                "/events",
                json={
                    "schema_version": 1,
                    "run_id": "demo-e2e",
                    "event_id": f"evt-e2e-{idx}",
                    "source_id": "vm-a",
                    "channel": ch,
                    "event_time": now,
                    "payload": payload,
                },
            )
            assert res.status_code == 201

        flush_res = client.post("/api/demo/flush-window?wait=true")
        assert flush_res.status_code == 200
        body = flush_res.json()
        assert body["chunks_analyzed"] == 3
        assert body["findings_count"] == 3
        assert body["council_signal"]["severity"] == "SEV1"

        state_res = client.get("/api/state")
        assert state_res.status_code == 200
        snap = state_res.json()
        assert snap["threat_mode"] == "INVESTIGATE"
        assert snap["council_signal"]["severity"] == "SEV1"


async def test_gemini_structured_reasoner_parses_sdk_response(monkeypatch):
    captured: dict[str, object] = {}

    class FakeResponse:
        parsed = ScoutChunkOutput(
            findings=[
                ScoutFindingDraft(
                    signal="secret_read",
                    rationale="Matched secret path",
                    evidence_event_ids=["evt-g1"],
                    confidence="high",
                )
            ]
        )
        text = ""

    class FakeAsyncModels:
        async def generate_content(self, *, model, contents, config):
            captured["model"] = model
            captured["contents"] = contents
            captured["config"] = config
            return FakeResponse()

    class FakeAio:
        models = FakeAsyncModels()

    class FakeClient:
        def __init__(self, api_key: str) -> None:
            captured["api_key"] = api_key
            self.aio = FakeAio()

    monkeypatch.setattr("vega.swarm.reasoner.genai.Client", FakeClient)

    reasoner = GeminiStructuredReasoner(api_key="test-key", model="gemini-2.5-flash")
    out = await reasoner.generate(
        system_instruction="sys",
        prompt='{"events": []}',
        response_schema=ScoutChunkOutput,
    )
    assert captured["api_key"] == "test-key"
    assert captured["model"] == "gemini-2.5-flash"
    assert captured["config"].response_mime_type == "application/json"
    assert captured["config"].response_schema is ScoutChunkOutput
    assert out.findings[0].signal == "secret_read"


async def test_unrelated_sources_do_not_falsely_combine_into_sev1():
    store = InMemoryStreamStore()
    reasoner = HeuristicStructuredReasoner()
    runtime = VegaRuntimeState()
    now = datetime.now(timezone.utc)
    window = Window(id="W-unrel", start=now - timedelta(seconds=5), end=now + timedelta(seconds=30))

    # Single file finding on vm-a + single unrelated network finding on vm-c
    await store.append(
        _ev("u1", "vm-a", "file", now, {"op": "read_burst", "path": "/srv/secrets/prod-keys/"})
    )
    await store.append(
        _ev(
            "u2",
            "vm-c",
            "network",
            now + timedelta(seconds=2),
            {"dst": "198.51.100.99:443", "bytes_out": 30_000_000, "internal": False},
        )
    )

    scouts = {
        ch: GeminiChannelScout(channel=ch, reasoner=reasoner)
        for ch in ("file", "network", "process")
    }
    coordinator = SwarmWindowCoordinator(
        store=store,
        scouts=scouts,
        correlator=GeminiWindowCorrelator(
            reasoner=reasoner,
            reporting_rules=ReportingRules(min_channels_for_sev1=2),
        ),
        runtime=runtime,
    )

    result = await coordinator.process_window_detailed(window)
    assert len(result.findings) == 2
    assert result.signal is None
    assert window.status == "clean"


async def test_scheduler_reset_cancels_inflight_tasks():
    store = InMemoryStreamStore()
    reasoner = FakeReasoner(delay_sec=0.2)
    runtime = VegaRuntimeState()
    now = datetime.now(timezone.utc)
    await store.append(_ev("e-slow", "vm-a", "file", now, {"suspicious": True}))

    scouts = {
        ch: GeminiChannelScout(channel=ch, reasoner=reasoner)
        for ch in ("file", "network", "process")
    }
    coordinator = SwarmWindowCoordinator(
        store=store,
        scouts=scouts,
        correlator=GeminiWindowCorrelator(
            reasoner=reasoner,
            reporting_rules=ReportingRules(min_channels_for_sev1=2, allow_single_channel_high=True),
        ),
        runtime=runtime,
    )
    scheduler = WindowScheduler(coordinator=coordinator, runtime=runtime, window_seconds=120)

    await scheduler.flush_current_window(wait=False)
    assert runtime.active_window_id == "W-1001"

    await scheduler.reset()
    runtime.reset()
    await asyncio.sleep(0.25)

    assert runtime.active_window_id == "W-1000"
    assert runtime.findings == []
    assert runtime.council_signal is None
    await scheduler.stop()


@pytest.mark.skipif(shutil.which("redis-server") is None, reason="redis-server not installed")
async def test_redis_stream_store_with_swarm_coordinator():
    port = 16380
    proc = subprocess.Popen(
        ["redis-server", "--port", str(port), "--save", "", "--appendonly", "no"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    store = RedisStreamStore(f"redis://127.0.0.1:{port}/0")

    try:
        for _ in range(30):
            if await store.health():
                break
            await asyncio.sleep(0.1)
        assert await store.health() is True
        await store.reset_demo_streams()

        runtime = VegaRuntimeState()
        mapper = EventMapper(store)
        reasoner = HeuristicStructuredReasoner()
        scouts = {
            ch: GeminiChannelScout(channel=ch, reasoner=reasoner)
            for ch in ("file", "network", "process")
        }
        coordinator = SwarmWindowCoordinator(
            store=store,
            scouts=scouts,
            correlator=GeminiWindowCorrelator(reasoner=reasoner),
            runtime=runtime,
        )

        from vega.models import EventIn

        t_start = datetime.now(timezone.utc) - timedelta(seconds=1)
        for idx, (ch, payload) in enumerate(
            [
                ("file", {"op": "read_burst", "path": "/srv/secrets/prod-keys/"}),
                ("process", {"cmd": "tar -czf /tmp/.cache-bundle.tar.gz /srv/secrets/prod-keys"}),
                ("network", {"dst": "198.51.100.44:8443", "bytes_out": 48210944}),
            ],
            start=1,
        ):
            _, stored = await mapper.ingest(
                EventIn(
                    schema_version=1,
                    run_id="redis-swarm-e2e",
                    event_id=f"evt-rs-{idx}",
                    source_id="vm-a",
                    channel=ch,  # type: ignore[arg-type]
                    event_time=datetime.now(timezone.utc),
                    payload=payload,
                )
            )
            runtime.record_event(stored)

        window = Window(
            id="W-redis-swarm",
            start=t_start,
            end=datetime.now(timezone.utc) + timedelta(seconds=10),
        )
        result = await coordinator.process_window_detailed(window)
        assert result.chunks_analyzed == 3
        assert len(result.findings) == 3
        assert result.signal is not None
        assert result.signal.severity == "SEV1"
        assert set(runtime.preserved_evidence.keys()) == {"evt-rs-1", "evt-rs-2", "evt-rs-3"}
    finally:
        await store.close()
        proc.terminate()
        proc.wait(timeout=5)
