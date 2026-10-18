# CrowdGuardian

CrowdGuardian is a human-in-the-loop crowd-crisis decision-support prototype. The stadium twin streams 4,000 simulated people to Python. Python detects congestion, assigns gates, forecasts 5- and 10-minute zone density, and ranks operator responses from isolated counterfactual rollouts. The operator approves a plan; React only executes the returned assignments.

## Repository

- `backend/` — FastAPI service: congestion detection, routing, live forecasts, dataset generation, and counterfactual rollouts
- `frontend/` — React, TypeScript, Vite, R3F/Three.js, Zustand
- `shared/stadium-config.json` — single source for gates, sections, capacities, and detector geometry
- `data/generated/` — reproducible zone-telemetry dataset (gitignored after generation)
- `data/models/` — optional trained GBM forecaster (gitignored)
- `PROJECT_CONTEXT.md` — current implementation status
- `PROJECT_BRIEF.md` — product definition

## Quick start (two terminals)

Python 3.11+ with numpy. On this machine the conda env is `northstar`.

### 1. Backend

```bash
cd backend
conda activate northstar
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 8000
```

`uvicorn[standard]` (and therefore `websockets`) is required. Without it the dashboard shows **Detector unavailable**.

API: `http://localhost:8000`  
Docs: `http://localhost:8000/docs`

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. Keep both processes running.

The 3D twin still runs if Python is down. It marks monitoring as unavailable and does not invent a local detection result. Local routing is used only as a fallback.

### Docker

```bash
docker compose up --build
```

## Demo flow

1. Click **Start**.
2. Close Gate B (or any other exit) from the gate list.
3. People walk seat → aisle → base path → gate corridor → FIFO queue → outside.
4. Python confirms persistent congestion (5 s on, 10 s off) and returns per-person assignment deltas.
5. The 3D people execute those deltas; the incident strip, risk panel, and gate list show live density, queue, and speed.
6. Click **Evaluate responses**. Python restores the current crowd, rolls out do-nothing plus redirect / meter / combined plans across seeds and compliance, and ranks them.
7. Select a feasible plan and **Approve**. Routing applies it on the next telemetry ticks.
8. Optional: download the run JSON from the export control, or `GET /api/runs/{run_id}/export`.

## Dataset, forecasts, and the optional GBM

Generate 100 reproducible runs (normal, single closure, multi closure, reopen):

```bash
cd backend
python -m scripts.generate_dataset --runs 100
```

Writes `data/generated/crowd_v1/` (`zone_telemetry.csv`, `runs.csv`, `before_after.csv`, `manifest.json`).

Train the optional gradient-boosted zone forecaster (needs `pip install -e ".[ml]"`):

```bash
cd backend
python -m scripts.train_forecaster
```

Writes `data/models/zone_forecaster_v1.joblib`. The live WebSocket reply uses it when present and falls back to the mass-balance baseline otherwise.

Mass-balance baseline on a demo snapshot:

```bash
cd backend
python -m scripts.run_baseline --gate-b-closed --metro-delayed --steps 8
```

## Tests

```bash
cd backend && pytest
cd frontend && npm test
cd frontend && npm run build
```

## Safety statement

CrowdGuardian is a hackathon decision-support prototype. It is not certified evacuation software and must not autonomously control real crowds. Detector thresholds and gate capacities are engineering defaults, not certified safety limits.
