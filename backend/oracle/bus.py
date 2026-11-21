"""Input/output for Oracle: JSON files and Redis Streams.

Redis protocol (one JSON document per stream entry, in field `payload`):
  in : ORACLE_IN_STREAM  (default vega:oracle:requests)    <- Sentinel XADDs an OracleRequest
  out: ORACLE_OUT_STREAM (default vega:oracle:assessments) -> Oracle XADDs an OracleAssessment
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import AsyncIterator

from .schemas import OracleAssessment, OracleRequest

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
IN_STREAM = os.getenv("ORACLE_IN_STREAM", "vega:oracle:requests")
OUT_STREAM = os.getenv("ORACLE_OUT_STREAM", "vega:oracle:assessments")


# ---------- Files ----------

def read_request_file(path: Path) -> OracleRequest:
    return OracleRequest.model_validate_json(path.read_text())


def write_assessment_file(assessment: OracleAssessment, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(assessment.model_dump_json(indent=2))
    tmp.replace(path)  # atomic: readers never see a half-written file


# ---------- Redis Streams ----------

def redis_client():
    import redis.asyncio as redis

    return redis.from_url(REDIS_URL, decode_responses=True)


async def consume_requests(r, from_start: bool = False) -> AsyncIterator[tuple[str, OracleRequest | Exception]]:
    """Yield (entry_id, request) forever. Invalid payloads are yielded as exceptions, not raised."""
    last_id = "0" if from_start else "$"
    while True:
        resp = await r.xread({IN_STREAM: last_id}, block=5000, count=10)
        for _stream, entries in resp or []:
            for entry_id, fields in entries:
                last_id = entry_id
                try:
                    yield entry_id, OracleRequest.model_validate_json(fields["payload"])
                except Exception as exc:  # noqa: BLE001
                    yield entry_id, exc


async def publish_assessment(r, assessment: OracleAssessment) -> str:
    return await r.xadd(OUT_STREAM, {"payload": assessment.model_dump_json()}, maxlen=1000, approximate=True)


async def publish_request(r, request: OracleRequest) -> str:
    """Test/demo helper: act as Sentinel and push a request."""
    return await r.xadd(IN_STREAM, {"payload": request.model_dump_json()}, maxlen=1000, approximate=True)