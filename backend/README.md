# VEGA Backend

FastAPI + Redis Streams + Sentinel Swarm + Oracle/Warden backend aligned 1:1 with `../frontend/src/contracts/vega.ts`.

## Quickstart (Local with `uv`)

```bash
cd backend
uv sync
uv run uvicorn vega.api:app --reload --port 8000
```

By default `VEGA_STREAM_BACKEND=memory` runs an in-memory `StreamStore` with identical `ingested_at` windowing and TTL trimming semantics so you can develop and test without Docker/Redis installed locally.

To run against real Redis (installed locally at `~/.local/bin/redis-server` v7.4.2, or via `docker compose up -d redis`):

```bash
# Terminal 1: start memory-only Redis (no RDB/AOF persistence)
./scripts/start_redis.sh

# Terminal 2: start FastAPI backed by Redis Streams
VEGA_STREAM_BACKEND=redis VEGA_REDIS_URL=redis://127.0.0.1:6379/0 uv run uvicorn vega.api:app --reload --port 8000
```

## Run Tests

```bash
cd backend
uv run pytest
```

## Parallel Track Ownership

- **Track A — Ephemeral Streams (`vega/streams/`):** `RedisStreamStore` (`XADD`, `XRANGE`, `XTRIM MINID`), periodic cleanup task, `POST /events`, `GET /health`.
- **Track B — Sentinel Swarm (`vega/swarm/`):** `WindowCoordinator`, Gemini channel scouts (`file`, `network`, `process`), `WindowCorrelator`.
- **Track C — Oracle, Warden & Observer (`vega/council/`):** `Oracle` contextual assessment, `Warden` policy gate (`dry_run=True`), preserved evidence snapshot store, `Observer` Q&A.
- **Track D — Producers & Live UI Adapter (`vega/producers/` + `../frontend/src/engine/liveSource.ts`):** Multi-VM synthetic event generator + frontend SSE client.
