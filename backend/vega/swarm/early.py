"""Cheap telemetry hints for scheduling Sentinel, not for escalating incidents."""

import re

from ..models import StoredEvent

_ARCHIVES = (".tgz", ".tar.gz", ".zip")
_STAGING_COMMAND = re.compile(r"^tar\s+(?:-[a-zA-Z]*c[a-zA-Z]*\b|--create\b)")


def has_early_hint(event: StoredEvent) -> bool:
    payload = event.payload
    if event.channel == "file":
        if payload.get("op") == "read_burst":
            return True
        path = payload.get("path")
        return (
            payload.get("op") in ("create", "write")
            and isinstance(path, str)
            and path.startswith("/tmp/.")
            and path.endswith(_ARCHIVES)
        )
    if event.channel == "process":
        cmd = payload.get("cmd")
        return (
            isinstance(cmd, str)
            and bool(_STAGING_COMMAND.match(cmd))
            and ("/tmp/." in cmd or "/srv/secrets/" in cmd or "/srv/sensitive_data/" in cmd)
        )
    if event.channel == "network":
        size = payload.get("bytes_out")
        return payload.get("unapproved_egress") is True or (
            isinstance(size, (float, int)) and size >= 25_000_000 and payload.get("internal") is not True
        )
    return False
