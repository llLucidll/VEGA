# VEGA Backend

This directory is reserved for the VEGA Python backend services:

1. **Ephemeral Streams & Ingest (`FastAPI` + `Redis Streams`)**
   - Reference scaffold: `../../ephemeral_streams/vega_streams/`
   - Design spec: `../../Ephemeral Streams.md`
   - Standardized channels: `file`, `network`, `process`

2. **Sentinel Agent Swarm (`Gemini` scouts + 2-minute `WindowCorrelator`)**
   - Design spec: `../../Agent Swarm.md`

3. **Oracle & Warden Policy Engine (Dry-Run)**
   - Design spec: `../../VEGA - Architecture Review.md`

## Frontend Contract Alignment

All backend JSON payloads exposed to the UI (via REST / SSE / WebSocket) should match the TypeScript contracts in `../frontend/src/contracts/vega.ts`:

- `EventIn` / `StoredEvent` (`schema_version: 1`, `channel: "file" | "network" | "process"`)
- `Window` (`id`, `start`, `end`, `status`)
- `ScoutFinding` (`finding_id`, `window_id`, `source_id`, `channel`, `evidence_event_ids`, `confidence`)
- `CouncilSignal` (`signal_id`, `window_id`, `severity`, `source_ids`, `finding_refs`, `evidence_event_ids`, `snapshot_preserved`)
- `OracleAssessment` & `WardenDecision` (`dry_run: true`)
