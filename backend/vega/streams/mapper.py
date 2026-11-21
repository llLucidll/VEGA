"""Normalize accepted endpoint events with central UTC ingest timestamps."""

from datetime import datetime, timezone

from ..models import EventIn, StoredEvent
from .store import StreamStore


class EventMapper:
    def __init__(self, store: StreamStore) -> None:
        self.store = store

    async def ingest(self, event: EventIn) -> tuple[str, StoredEvent]:
        normalized = StoredEvent(
            **event.model_dump(),
            ingested_at=datetime.now(timezone.utc),
        )
        stream_id = await self.store.append(normalized)
        return stream_id, normalized
