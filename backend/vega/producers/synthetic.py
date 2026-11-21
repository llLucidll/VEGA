"""Track D: Synthetic producer helper targeting POST /events."""

from datetime import datetime, timezone
from uuid import uuid4

from ..models import Channel, EventIn


def make_synthetic_event(
    *,
    run_id: str,
    source_id: str,
    channel: Channel,
    payload: dict[str, object],
) -> EventIn:
    return EventIn(
        schema_version=1,
        run_id=run_id,
        event_id=f"evt-{uuid4().hex[:12]}",
        source_id=source_id,
        channel=channel,
        event_time=datetime.now(timezone.utc),
        payload=payload,
    )
