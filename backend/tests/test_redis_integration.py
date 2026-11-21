import asyncio
import shutil
import subprocess
import time
from datetime import datetime, timedelta, timezone

import pytest

from vega.models import StoredEvent, Window
from vega.streams import RedisStreamStore


@pytest.mark.skipif(shutil.which("redis-server") is None, reason="redis-server not installed")
async def test_redis_stream_store_end_to_end():
    port = 16379
    proc = subprocess.Popen(
        ["redis-server", "--port", str(port), "--save", "", "--appendonly", "no"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    store = RedisStreamStore(f"redis://127.0.0.1:{port}/0")

    try:
        # Wait for Redis to accept connections
        for _ in range(30):
            if await store.health():
                break
            await asyncio.sleep(0.1)
        assert await store.health() is True

        await store.reset_demo_streams()

        t0 = datetime.now(timezone.utc)
        ev1 = StoredEvent(
            schema_version=1,
            run_id="redis-test",
            event_id="evt-r1",
            source_id="vm-a",
            channel="file",
            event_time=t0,
            ingested_at=t0,
            payload={"op": "read"},
        )
        sid = await store.append(ev1)
        assert "-" in sid

        window = Window(
            id="W-redis",
            start=t0 - timedelta(seconds=5),
            end=t0 + timedelta(seconds=30),
        )
        chunks = await store.read_window(window)
        assert [e.event_id for e in chunks[("vm-a", "file")]] == ["evt-r1"]

        # Wait >1s so XTRIM MINID with retention_seconds=1 trims evt-r1
        time.sleep(1.15)
        trimmed = await store.trim_expired(retention_seconds=1)
        assert trimmed >= 1

        chunks_after = await store.read_window(window)
        assert chunks_after == {}

        # Appending after trim still works cleanly
        t1 = datetime.now(timezone.utc)
        ev2 = StoredEvent(
            schema_version=1,
            run_id="redis-test",
            event_id="evt-r2",
            source_id="vm-b",
            channel="network",
            event_time=t1,
            ingested_at=t1,
            payload={"dst": "10.0.0.5:443"},
        )
        await store.append(ev2)
        chunks_new = await store.read_window(
            Window(id="W-redis-2", start=t1 - timedelta(seconds=5), end=t1 + timedelta(seconds=30))
        )
        assert [e.event_id for e in chunks_new[("vm-b", "network")]] == ["evt-r2"]

        await store.reset_demo_streams()
        assert (
            await store.read_window(
                Window(
                    id="W-redis-3",
                    start=t1 - timedelta(seconds=5),
                    end=t1 + timedelta(seconds=30),
                )
            )
            == {}
        )
    finally:
        await store.close()
        proc.terminate()
        proc.wait(timeout=5)
