"""StreamStore protocol plus InMemory and Redis Streams implementations."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Protocol

from redis.asyncio import Redis
from redis.exceptions import RedisError

from ..models import Channel, StoredEvent, Window

CHANNELS: tuple[Channel, ...] = ("file", "network", "process")


class StreamStoreUnavailable(Exception):
    """Raised when the backing stream store cannot accept reads or writes."""


class StreamStore(Protocol):
    """Abstract boundary between VEGA ingest/swarm and the ephemeral stream backend."""

    def stream_key(self, channel: Channel) -> str: ...

    async def append(self, event: StoredEvent) -> str: ...

    async def read_window(
        self, window: Window
    ) -> dict[tuple[str, Channel], list[StoredEvent]]: ...

    async def purge_window(self, window: Window) -> int: ...

    async def trim_expired(self, retention_seconds: int) -> int: ...

    async def oldest_event_time(self) -> datetime | None: ...

    async def reset_demo_streams(self) -> None: ...

    async def health(self) -> bool: ...


class InMemoryStreamStore:
    """Zero-dependency StreamStore matching Redis Streams windowing and TTL semantics."""

    def __init__(self) -> None:
        self._streams: dict[Channel, list[tuple[str, StoredEvent]]] = {
            ch: [] for ch in CHANNELS
        }
        self._seq = 0

    def stream_key(self, channel: Channel) -> str:
        return f"vega:events:{channel}"

    async def append(self, event: StoredEvent) -> str:
        ms = int(event.ingested_at.timestamp() * 1000)
        stream_id = f"{ms}-{self._seq}"
        self._seq += 1
        self._streams[event.channel].append((stream_id, event))
        return stream_id

    async def read_window(
        self, window: Window
    ) -> dict[tuple[str, Channel], list[StoredEvent]]:
        grouped: dict[tuple[str, Channel], list[StoredEvent]] = defaultdict(list)
        for channel in CHANNELS:
            for _stream_id, event in self._streams[channel]:
                if window.start <= event.ingested_at < window.end:
                    grouped[(event.source_id, channel)].append(event)
        return dict(grouped)

    async def purge_window(self, window: Window) -> int:
        removed = 0
        for channel, entries in self._streams.items():
            kept = [(sid, ev) for sid, ev in entries if not window.start <= ev.ingested_at < window.end]
            removed += len(entries) - len(kept)
            self._streams[channel] = kept
        return removed

    async def trim_expired(self, retention_seconds: int) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=retention_seconds)
        removed = 0
        for channel in CHANNELS:
            before = len(self._streams[channel])
            self._streams[channel] = [
                (sid, ev) for sid, ev in self._streams[channel] if ev.ingested_at >= cutoff
            ]
            removed += before - len(self._streams[channel])
        return removed

    async def oldest_event_time(self) -> datetime | None:
        oldest: datetime | None = None
        for channel in CHANNELS:
            for _sid, ev in self._streams[channel]:
                if oldest is None or ev.ingested_at < oldest:
                    oldest = ev.ingested_at
        return oldest

    async def reset_demo_streams(self) -> None:
        for channel in CHANNELS:
            self._streams[channel].clear()

    async def health(self) -> bool:
        return True


class RedisStreamStore:
    """Redis Streams implementation using XADD, XRANGE, XDEL, and exact XTRIM MINID."""

    def __init__(self, redis_url: str) -> None:
        self._client: Redis = Redis.from_url(redis_url, decode_responses=True)

    def stream_key(self, channel: Channel) -> str:
        return f"vega:events:{channel}"

    async def append(self, event: StoredEvent) -> str:
        key = self.stream_key(event.channel)
        try:
            stream_id = await self._client.xadd(key, {"data": event.model_dump_json()})
            return str(stream_id)
        except RedisError as exc:
            raise StreamStoreUnavailable("Redis XADD failed") from exc

    async def read_window(
        self, window: Window
    ) -> dict[tuple[str, Channel], list[StoredEvent]]:
        grouped: dict[tuple[str, Channel], list[StoredEvent]] = defaultdict(list)
        start_ms = max(0, int(window.start.timestamp() * 1000) - 1000)
        end_ms = int(window.end.timestamp() * 1000) + 1000

        try:
            for channel in CHANNELS:
                entries = await self._client.xrange(
                    self.stream_key(channel),
                    min=f"{start_ms}-0",
                    max=f"{end_ms}-999999",
                )
                for _entry_id, fields in entries:
                    raw = fields.get("data")
                    if not raw:
                        continue
                    event = StoredEvent.model_validate_json(raw)
                    if window.start <= event.ingested_at < window.end:
                        grouped[(event.source_id, channel)].append(event)
        except RedisError as exc:
            raise StreamStoreUnavailable("Redis XRANGE failed") from exc

        return dict(grouped)

    async def purge_window(self, window: Window) -> int:
        # Redis IDs have millisecond precision and use Redis's clock; check the stored
        # ingest timestamp so entries on the next window's boundary aren't deleted.
        start_ms = max(0, int(window.start.timestamp() * 1000) - 1000)
        end_ms = int(window.end.timestamp() * 1000) + 1000
        removed = 0
        try:
            for channel in CHANNELS:
                key = self.stream_key(channel)
                cursor = f"{start_ms}-0"
                while entries := await self._client.xrange(key, min=cursor, max=f"{end_ms + 1}-0", count=256):
                    delete_ids = []
                    for entry_id, fields in entries:
                        if raw := fields.get("data"):
                            at = StoredEvent.model_validate_json(raw).ingested_at
                            if window.start <= at < window.end:
                                delete_ids.append(entry_id)
                    if delete_ids:
                        removed += int(await self._client.xdel(key, *delete_ids))
                    cursor = f"({entries[-1][0]}"
        except RedisError as exc:
            raise StreamStoreUnavailable("Redis window purge failed") from exc
        return removed

    async def trim_expired(self, retention_seconds: int) -> int:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=retention_seconds)
        cutoff_ms = max(0, int(cutoff.timestamp() * 1000))
        trimmed_total = 0
        try:
            for channel in CHANNELS:
                trimmed = await self._client.xtrim(
                    self.stream_key(channel),
                    minid=f"{cutoff_ms}-0",
                    approximate=False,
                )
                trimmed_total += int(trimmed)
        except RedisError as exc:
            raise StreamStoreUnavailable("Redis XTRIM failed") from exc
        return trimmed_total

    async def oldest_event_time(self) -> datetime | None:
        oldest: datetime | None = None
        try:
            for channel in CHANNELS:
                entries = await self._client.xrange(
                    self.stream_key(channel),
                    min="-",
                    max="+",
                    count=1,
                )
                if not entries:
                    continue
                entry_id, _fields = entries[0]
                ms = int(str(entry_id).split("-", 1)[0])
                ts = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
                if oldest is None or ts < oldest:
                    oldest = ts
        except RedisError as exc:
            raise StreamStoreUnavailable("Redis XRANGE failed") from exc
        return oldest

    async def reset_demo_streams(self) -> None:
        keys = [self.stream_key(ch) for ch in CHANNELS]
        try:
            await self._client.delete(*keys)
        except RedisError as exc:
            raise StreamStoreUnavailable("Redis DELETE failed") from exc

    async def health(self) -> bool:
        try:
            return bool(await self._client.ping())
        except RedisError:
            return False

    async def close(self) -> None:
        await self._client.aclose()
