# CrowdGuardian

CrowdGuardian is a human-in-the-loop crowd-crisis decision-support prototype. Its current stadium twin streams the state of 4,000 simulated people to Python, detects persistent congestion across eight gates, and deterministically reroutes affected people. Live 5–10 minute forecasting and calculated intervention ranking are the next backend milestones.

## Repository

- `backend/` — FastAPI service, deterministic simulation, forecasting, and response ranking
- `frontend/` — React, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand, Zod, and Recharts
- `shared/stadium-config.json` — single source for the eight gate positions, capacities, and detector geometry
- `data/` — scenario definitions, generated telemetry, and model artifacts
- `PROJECT_CONTEXT.md` — canonical implementation status, architecture, and ordered TODO
- `PROJECT_BRIEF.md` — product and technical definition
- `TEAM_TASK_DISTRIBUTION.md` — four-person ownership and integration plan

## Quick start

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload
```

The API is available at `http://localhost:8000`; interactive documentation is at `http://localhost:8000/docs`.

Run the deterministic forecasting baseline directly:

```bash
cd backend
python -m scripts.run_baseline --gate-b-closed --metro-delayed --steps 8
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

Run the backend and frontend together. The default 3D stadium continues to run if Python is unavailable, but clearly marks congestion monitoring as unavailable and never fabricates a local detection result.

## Per-person congestion path

- The frontend owns 4,000 deterministic person identities per run.
- Each identity exits once; exited people never respawn.
- People follow explicit seat-row, aisle, lower-base-path, gate-corridor, queue, and exit phases.
- All eight exits can be opened or closed individually from the gate list.
- The 3D twin sends a complete person snapshot once per real second to `ws://localhost:8000/ws/congestion`.
- FastAPI calculates approach density, queue length, speed, and throughput for Gates A–H.
- Congestion must persist for five simulated seconds before it is raised and must remain clear for ten simulated seconds before it is removed.
- A closed or backend-confirmed congested gate triggers deterministic rerouting to the lowest-cost open alternative using distance, queue, and density—not an ML model.
- Backend results appear in the existing incident strip, risk summary, gate list, and 3D gate treatment.

The detector is deterministic and intended for the prototype only. Its thresholds are engineering defaults, not certified crowd-safety limits.

### Docker

```bash
docker compose up --build
```

## Demo flow

1. Start the simulation.
2. Close Gate B or another selected exit from the gate controls.
3. Observe people follow the seating aisles to the base path and gate corridors.
4. Wait for Python to confirm persistent congestion at a loaded gate.
5. Observe the live density, queue, speed, and throughput result in the existing UI.
6. Observe affected people move toward lower-cost open exits.
7. Reopen the gate or reset the deterministic run.

The congestion result is derived from per-person frontend telemetry by the Python detector. Forecast and intervention values in the default 3D experience remain deterministic demonstration data and are explicitly tracked as TODO in `PROJECT_CONTEXT.md`.

## Tests

```bash
cd backend && pytest
cd frontend && npm test
cd frontend && npm run test:e2e
```

## Safety statement

CrowdGuardian is a hackathon decision-support prototype. It is not certified evacuation software and must not autonomously control real crowds.

