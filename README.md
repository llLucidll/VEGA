# VEGA

VEGA is an autonomous, multi-agent cybersecurity intelligence system that continuously monitors organizational activity to detect insider threats and cyberattacks in real time. Through specialized AI agents (**Sentinel**, **Oracle**, and **Warden**), VEGA identifies suspicious behavior, investigates threats using organizational context, and coordinates policy-gated containment before incidents escalate.

## Monorepo Layout

```text
code/
├── frontend/   # Vite + React + TypeScript + Tailwind v4 command center UI
└── backend/    # Python FastAPI + Redis Streams + Gemini Swarm (in progress)
```

## Frontend Quickstart (Runs Standalone with Simulated Telemetry)

```bash
cd frontend
npm install
npm run dev
```

### Demo Controls
- **Natural Navigation:** Click any node on Panopticon to inspect telemetry in Ghost Protocol, escalate to The Council / Warden Gate from the panels, scrub **Chronos** at the bottom, or click **OBSERVER** (`Cmd/Ctrl + K`).
- **`Shift + D`:** Toggle **Manual Cues** (`Next Cue`, `+1 Event`, `Inject Anomaly`, `Council`, `Blackout`, `Benign`, `Reset`, `Ambient`).
- **`Cmd/Ctrl + K`:** Toggle **The Observer** conversational evidence drawer.

## Parallel Agent Ownership Map

- **Contracts & State Machine:** `frontend/src/contracts/vega.ts`, `frontend/src/store/useVegaStore.ts`, `frontend/src/engine/`
- **01 Panopticon & 02 Ghost Protocol:** `frontend/src/components/stages/PanopticonCanvas.tsx`, `GhostProtocolPanel.tsx`
- **03 The Council:** `frontend/src/components/stages/CouncilView.tsx`
- **04 Chronos:** `frontend/src/components/overlays/ChronosScrubber.tsx`
- **05 Blackout (Warden Gate):** `frontend/src/components/stages/BlackoutOverlay.tsx`
- **06 The Observer:** `frontend/src/components/overlays/ObserverDrawer.tsx`
- **Backend Integration:** Implement `VegaDataSource` (`frontend/src/engine/dataSource.ts`) against `backend/` endpoints without modifying UI components.
