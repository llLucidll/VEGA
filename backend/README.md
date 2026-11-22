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

# Terminal 2: start FastAPI backed by Redis Streams (bind 0.0.0.0 so Multipass VMs can reach it)
VEGA_STREAM_BACKEND=redis VEGA_REDIS_URL=redis://127.0.0.1:6379/0 uv run uvicorn vega.api:app --reload --host 0.0.0.0 --port 8000
```

## Live Sentinel demo (Multipass)

On a demo VM, run `~/malicious-script` for the **live** exercise. Approve the Auth0 sign-in in your browser. The script fetches `secrets.txt` through the vault, verifies it is the installed synthetic fixture, then runs `tar` and `curl` to the private Multipass demo sink. It does not submit synthetic events. The collectors send their observations. Sentinel starts early analysis when two distinct channels have suspicious scheduling hints for the same VM. A short debounce collects the rest of the telemetry burst. The hints only schedule inference; the scouts and Council correlation still determine whether to raise an alert. Each VM gets at most one early pass per window, and the window stays open. Set `VEGA_EARLY_ANALYSIS=false` to compare with window-close-only detection.

After the two-minute window closes, a final pass checks all sources. It reuses successful scout results for unchanged chunks and sends only new, changed, or previously failed chunks to scouts. Changed chunks include their earlier events for context. Identical sets of findings reuse the correlation verdict. This window-local cache contains no raw telemetry and is dropped on cleanup; the early alert does not wait for this pass. VEGA then deletes that window's raw telemetry from the stream and runtime buffer and updates connected dashboards. Council-cited telemetry, derived findings, and incident state remain available until demo reset. Redis TTL is a fallback if per-window deletion fails or the backend restarts. This is application-level cleanup: it does not erase VM logs, Redis persistence/backups, or control Gemini provider retention. Sentinel makes stateless requests, with no conversation or cached model context to reset. To force final analysis and cleanup, run `curl -fsS -X POST http://127.0.0.1:8000/api/demo/flush-window` on the host.

For a **telemetry-only replay**, run the following on the host to send demo fixtures from `vm-a` and `vm-b` in parallel, then close the window:

```bash
python3 scripts/run_sentinel_demo.py --reset
```

`--reset` clears previous demo telemetry and sets the dashboard back to WATCH. To include a different set of nodes, list them after the flag (for example, `--reset vm-a vm-b vm-c`). Otherwise `vm-c` stays a healthy control. The launcher reports the findings and the actual Council result. It only sends synthetic event metadata; it does not read, archive, or upload files or sign in to Auth0.

The guest replay command is `~/sentinel-replay`. Unlike `~/malicious-script`, it only emits simulated events for that VM. The real vault exercise requires the VM's test employee to be allowlisted and the private upload sink to be running.

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
