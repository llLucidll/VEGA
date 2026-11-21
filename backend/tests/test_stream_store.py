from datetime import datetime, timedelta, timezone

from vega.models import StoredEvent, Window
from vega.streams import InMemoryStreamStore


def _make_event(event_id: str, source_id: str, channel: str, ingested_at: datetime) -> StoredEvent:
    return StoredEvent(
        schema_version=1,
        run_id="run-test",
        event_id=event_id,
        source_id=source_id,
        channel=channel,  # type: ignore[arg-type]
        event_time=ingested_at,
        ingested_at=ingested_at,
        payload={"demo": True},
    )


async def test_read_window_groups_by_source_and_channel():
    store = InMemoryStreamStore()
    base = datetime(2026, 11, 21, 14, 0, 0, tzinfo=timezone.utc)
    window = Window(id="W-1000", start=base, end=base + timedelta(minutes=2))

    await store.append(_make_event("e1", "vm-a", "file", base + timedelta(seconds=10)))
    await store.append(_make_event("e2", "vm-a", "file", base + timedelta(seconds=20)))
    await store.append(_make_event("e3", "vm-b", "network", base + timedelta(seconds=30)))
    # Outside window (at exact end boundary -> exclusive)
    await store.append(_make_event("e4", "vm-a", "file", base + timedelta(minutes=2)))

    chunks = await store.read_window(window)
    assert len(chunks[("vm-a", "file")]) == 2
    assert len(chunks[("vm-b", "network")]) == 1
    assert ("vm-a", "process") not in chunks


async def test_trim_expired_and_reset():
    store = InMemoryStreamStore()
    now = datetime.now(timezone.utc)

    await store.append(_make_event("old-1", "vm-a", "file", now - timedelta(seconds=120)))
    await store.append(_make_event("new-1", "vm-a", "file", now - timedelta(seconds=5)))

    removed = await store.trim_expired(retention_seconds=60)
    assert removed == 1

    window = Window(
        id="W-now",
        start=now - timedelta(minutes=5),
        end=now + timedelta(minutes=1),
    )
    chunks = await store.read_window(window)
    assert [e.event_id for e in chunks[("vm-a", "file")]] == ["new-1"]

    await store.reset_demo_streams()
    assert await store.read_window(window) == {}
