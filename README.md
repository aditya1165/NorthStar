# CrowdGuardian

CrowdGuardian is a human-in-the-loop crowd-crisis decision-support prototype. It detects emerging congestion, forecasts conditions 5–10 minutes ahead, simulates operational responses, and recommends the safest low-disruption intervention.

## Repository

- `backend/` — FastAPI service, deterministic simulation, forecasting, and response ranking
- `frontend/` — React, TypeScript, Vite, Tailwind CSS, TanStack Query, Zustand, Zod, and Recharts
- `data/` — scenario definitions, generated telemetry, and model artifacts
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

### Docker

```bash
docker compose up --build
```

## Demo flow

1. Start the simulation.
2. Inject the Gate B closure and metro delay.
3. Step the simulation until the north concourse warning appears.
4. Review the 5- and 10-minute forecast.
5. Compare the do-nothing baseline with available interventions.
6. Approve the recommended response.
7. Observe the reduced density and queue trajectory.

All demo values are derived from the deterministic simulation and response evaluator rather than hard-coded dashboard values.

## Tests

```bash
cd backend && pytest
cd frontend && npm test
```

## Safety statement

CrowdGuardian is a hackathon decision-support prototype. It is not certified evacuation software and must not autonomously control real crowds.

