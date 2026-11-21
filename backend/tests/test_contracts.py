from datetime import datetime, timezone

from fastapi.testclient import TestClient

from vega import api
from vega.models import NetworkEdge
from vega.streams import StreamStoreUnavailable


def test_health_and_state_snapshot():
    with TestClient(api.app) as client:
        client.post("/api/demo/reset")
        res = client.get("/health")
        assert res.status_code == 200
        body = res.json()
        assert body["status"] == "ok"
        assert body["channels"] == ["file", "network", "process"]

        state_res = client.get("/api/state")
        assert state_res.status_code == 200
        snap = state_res.json()
        assert snap["threat_mode"] == "WATCH"
        # Starts with only vega-core until real endpoints send events
        assert [n["source_id"] for n in snap["nodes"]] == ["vega-core"]
        assert snap["edges"] == []

        # Ingesting an event dynamically registers the endpoint node and edge
        ingest_res = client.post(
            "/events",
            json={
                "schema_version": 1,
                "run_id": "demo-001",
                "event_id": "evt-dyn-01",
                "source_id": "local-host",
                "channel": "process",
                "event_time": datetime.now(timezone.utc).isoformat(),
                "payload": {"cmd": "python3 -m vega.producers.local_agent"},
            },
        )
        assert ingest_res.status_code == 201

        snap_after = client.get("/api/state").json()
        assert [n["source_id"] for n in snap_after["nodes"]] == ["vega-core", "local-host"]
        assert snap_after["edges"][0]["from"] == "local-host"
        assert snap_after["edges"][0]["to"] == "vega-core"


def test_network_edge_alias_serialization():
    edge = NetworkEdge(id="e-1", **{"from": "vm-a", "to": "vega-core"}, channel="network")
    dumped = edge.model_dump(by_alias=True)
    assert dumped["from"] == "vm-a"
    assert dumped["to"] == "vega-core"


def test_ingest_valid_and_invalid_events():
    with TestClient(api.app) as client:
        client.post("/api/demo/reset")

        valid = {
            "schema_version": 1,
            "run_id": "demo-001",
            "event_id": "evt-test-01",
            "source_id": "vm-a",
            "channel": "file",
            "event_time": datetime.now(timezone.utc).isoformat(),
            "payload": {"op": "read", "path": "/srv/secrets/key.pem"},
        }
        res = client.post("/events", json=valid)
        assert res.status_code == 201
        assert "stream_id" in res.json()

        # Unknown channel -> 400 (not 422)
        bad_channel = {**valid, "channel": "keyboard"}
        bad_res = client.post("/events", json=bad_channel)
        assert bad_res.status_code == 400

        # Naive timestamp -> 400
        naive_ts = {**valid, "event_time": "2026-11-21T12:00:00"}
        naive_res = client.post("/events", json=naive_ts)
        assert naive_res.status_code == 400


def test_ingest_returns_503_when_store_unavailable(monkeypatch):
    async def fail_append(_event):
        raise StreamStoreUnavailable("down")

    monkeypatch.setattr(api.store, "append", fail_append)

    with TestClient(api.app) as client:
        res = client.post(
            "/events",
            json={
                "schema_version": 1,
                "run_id": "demo-001",
                "event_id": "evt-fail-01",
                "source_id": "vm-a",
                "channel": "network",
                "event_time": datetime.now(timezone.utc).isoformat(),
                "payload": {"dst": "198.51.100.44:8443"},
            },
        )
        assert res.status_code == 503
