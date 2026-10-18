# CrowdGuardian — Four-Person Task Distribution

## Team Objective

Build a working CrowdGuardian MVP that demonstrates this complete loop:

```text
Incident
  -> risk detection
  -> 5–10 minute forecast
  -> intervention simulation
  -> ranked recommendation
  -> human approval
  -> measurable risk reduction
```

Each person owns one module and initially develops against shared mock JSON data. This keeps all four workstreams moving in parallel.

## Current Delivery Status

The project has moved beyond the original mocked-module starting point:

- Person 1's browser simulation now contains 4,000 stable people, 24 seating sections, eight gates, explicit aisle/base-path movement, and FIFO gate queues.
- Person 2's Python module receives live per-person WebSocket telemetry and detects persistent congestion at all eight exits.
- A deterministic rerouting proof currently runs in the frontend after a closure or backend-confirmed congestion event.
- Person 4's existing 3D operator interface is connected to the detector and exposes individual open/close control for every gate.
- Forecast charts, intervention outcomes, and recommendation ranking remain demonstration data.
- No gradient-boosted model will be trained until Person 1 produces the multi-run dataset.

The stadium scenario is the only active MVP scenario. Wildfire work is deferred. See [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for the canonical architecture and backlog.

## Current Sprint TODO

### Person 1 — Simulation data and controlled runs

- Export reproducible normal, single-closure, multi-closure, and reopen runs.
- Produce 30-second zone aggregates and scenario metadata.
- Deliver at least 100 complete runs to Person 2.
- Add measured exit time, queue, throughput, reroute, and walking-distance summaries.

### Person 2 — Live risk and forecasting

- Keep the current gate detector stable and configurable.
- Convert per-person snapshots into rolling zone histories.
- Connect the deterministic 5- and 10-minute baseline to those histories.
- Define the training table and future targets after receiving Person 1's runs.
- Do not train gradient boosting before the dataset and leakage-safe split exist.

### Person 3 — Backend routing and intervention engine

- Move the deterministic routing cost calculation from React into Python.
- Return only changed person-to-gate assignments with reason and estimated benefit.
- Add route-switch hysteresis, cooldown, and closed-gate constraints.
- Add controlled do-nothing and rerouting comparisons before building broader intervention rollouts.

### Person 4 — Frontend integration

- Make the movement engine execute backend assignment deltas.
- Display rerouted-person counts and the source/reason for the active routing decision.
- Replace mock forecast and intervention surfaces only when their live endpoints are ready.
- Preserve the current stadium design and backend-unavailable behavior.

## Shared Setup — Complete Together First

Before splitting into individual tasks:

1. Use the shared eight-gate venue configuration in `shared/stadium-config.json`.
2. Confirm the demo incident: Gate B closes while a metro delay reduces downstream capacity.
3. Confirm the future candidate responses:
   - Do nothing
   - Reassign selected sections or people to open gates
   - Meter selected seating-section releases
   - Apply a combined reassignment and release plan
4. Agree on the telemetry, forecast, intervention, and simulation-state interfaces.
5. Select a deterministic random seed for the final demonstration.
6. Create four Git branches:
   - `simulation`
   - `forecasting`
   - `optimizer`
   - `frontend`

Recommended project layout:

```text
crowdguardian/
├── backend/
│   └── app/
│       ├── simulation/
│       ├── forecasting/
│       ├── response/
│       └── shared/
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── features/
│   │   ├── hooks/
│   │   ├── lib/
│   │   ├── pages/
│   │   ├── stores/
│   │   └── types/
│   ├── public/
│   └── package.json
├── data/
│   ├── scenarios/
│   ├── generated/
│   └── models/
├── tests/
├── scripts/
├── pyproject.toml
├── docker-compose.yml
└── README.md
```

---

## Person 1 — Digital Twin and Telemetry

### Mission

Build the pedestrian simulation and produce the live data consumed by the other modules.

### Tasks

- Maintain the simplified stadium with 24 seating sections, concourses, Gates A–H, and a metro entrance.
- Simulate spectators moving from seating sections to exits.
- Divide the venue into operational zones.
- Implement deterministic random seeds.
- Add configurable events:
  - Gate B closure
  - Metro delay
  - Section-release rate changes
  - Route-compliance changes
- Aggregate agent positions into zone telemetry.
- Record people count, density, inflow, outflow, walking speed, queue length, opposing-flow ratio, and operational status.
- Save complete simulation runs as Parquet or CSV.
- Support simulation snapshots, cloning, and intervention application.
- Provide coordinates or zone geometry for the React frontend.

### Required Interface

```python
simulation = CrowdSimulation(scenario, seed=42)
simulation.step()
telemetry = simulation.get_telemetry()
snapshot = simulation.snapshot()
simulation.apply_intervention(intervention)
```

### Deliverables

- Normal post-match egress simulation.
- Gate-closure and metro-delay scenario.
- Zone-level telemetry generator.
- Synthetic training dataset.
- Simulation snapshot and cloning support.
- Tests proving that identical seeds produce identical results.

### Definition of Done

The simulation runs from initial release to venue clearance, preserves all 4,000 identities, responds to arbitrary gate closures, and exports reproducible telemetry and run summaries.

---

## Person 2 — Risk Detection and Forecasting

### Mission

Identify emerging crowd risk and forecast congestion 5–10 minutes ahead.

### Tasks

- Implement explainable risk rules using:
  - Density and density growth
  - Inflow/outflow imbalance
  - Falling walking speed
  - Queue growth
  - Opposing pedestrian flow
  - Gate and corridor status
- Build a deterministic persistence or flow-extrapolation baseline.
- Convert synthetic telemetry into forecasting features.
- Train a gradient-boosted model for 5- and 10-minute forecasts.
- Predict future density, queue length, risk probability, time to congestion, and clearance time.
- Return the most important contributing factors for each forecast.
- Add uncertainty estimates or confidence ranges.
- Validate using held-out scenarios or chronological splits to prevent data leakage.
- Compare the trained model with the deterministic baseline.

### Required Interface

```python
risk = risk_detector.evaluate(current_telemetry)
forecast = forecaster.predict(
    history=telemetry_history,
    horizons_minutes=[5, 10],
)
```

### Deliverables

- Rule-based risk detector.
- Deterministic forecast baseline.
- Trained gradient-boosted model.
- Saved model and prediction API.
- Evaluation results for forecast error and high-risk classification.
- Human-readable forecast explanations.

### Definition of Done

The module detects persistent congestion at any of the eight exits and produces calculated 5- and 10-minute forecasts from live or recorded simulation histories.

---

## Person 3 — Intervention and Optimization Engine

### Mission

Generate feasible operational responses, simulate their outcomes, and select the safest low-disruption option.

### Tasks

- Define the available interventions:
  - Do nothing
  - Reassign affected people to lower-cost open gates
  - Meter selected seating-section releases
  - Make a selected corridor one-way
  - Apply a combined reassignment and release action
- Validate route, capacity, operational, and accessibility constraints.
- Reject actions that:
  - Use closed or unsafe routes
  - Exceed route capacity
  - Remove accessible routing without an equivalent alternative
  - Create a secondary high-risk zone
- Clone the current simulation state for each candidate.
- Simulate each candidate for the next 10–15 minutes.
- Repeat rollouts using fixed seeds and multiple compliance levels.
- Calculate peak density, time above the risk threshold, maximum queue, clearance time, people redirected, extra walking distance, accessibility violations, and operational complexity.
- Rank only feasible candidates.
- Generate a plain-language explanation comparing the winner with doing nothing.

### Required Interface

```python
candidates = generator.generate(current_state, constraints)
results = evaluator.run_rollouts(snapshot, candidates)
recommendation = optimizer.rank(results)
```

### Deliverables

- Intervention schema and candidate generator.
- Constraint validator.
- Counterfactual rollout runner.
- Scoring and ranking engine.
- Recommendation explanation generator.
- Tests for infeasible actions and secondary bottlenecks.

### Definition of Done

Given a simulation snapshot, the module evaluates at least three interventions plus doing nothing and returns a feasible ranked recommendation with calculated trade-offs.

---

## Person 4 — React Frontend, Integration, and Demo

### Mission

Build a responsive React operator interface, connect it to the backend, and own final system integration.

### Tasks

- Scaffold the frontend with React, TypeScript, and Vite.
- Use the following frontend libraries:
  - Tailwind CSS for styling and responsive layout
  - shadcn/ui with Radix UI primitives for accessible interface components
  - TanStack Query for server-state fetching, caching, and mutations
  - Zustand for lightweight client and simulation-control state
  - Zod for runtime validation of API and WebSocket payloads
  - Recharts for forecasts and intervention comparisons
  - React Konva or SVG/D3 utilities for the live venue visualization
  - Lucide React for icons
  - Motion for focused transitions and state-change feedback
  - React Router for application routing if multiple screens are needed
- Create four primary interface areas:
  - Live venue map
  - Current alerts and forecast
  - Intervention comparison
  - Operator controls
- Display crowd movement, zone density, queues, gate status, incident markers, and predicted congestion.
- Compare interventions using calculated outcome metrics.
- Add controls to start, pause, reset, and replay the scenario.
- Maintain controls to open or close every gate and trigger the metro delay.
- Let the operator approve, modify, or reject a recommendation.
- Apply approved actions to the live simulation.
- Begin with typed mock JSON fixtures and Mock Service Worker so frontend work does not depend on unfinished backend modules.
- Generate or maintain TypeScript types that match the shared backend data contracts.
- Fetch snapshots, forecasts, and intervention results through a typed API client.
- Consume live telemetry through WebSocket, with polling as a fallback.
- Validate incoming payloads with Zod before placing them in application state.
- Provide responsive desktop and tablet layouts suitable for an operations center.
- Meet basic accessibility requirements for keyboard navigation, contrast, labels, and status announcements.
- Add component and interaction tests with Vitest and React Testing Library.
- Add one critical end-to-end demo test with Playwright.
- Integrate the simulation, forecasting, and optimization components.
- Add error handling, loading states, and a cached demo fallback.
- Own the frontend production build, Docker setup, run instructions, and final presentation flow.

### Required Integration Flow

```ts
const telemetry = useTelemetryStream();
const forecast = useForecastQuery(telemetry.latestTimestamp);
const recommendation = useRecommendationQuery(forecast.data);

const approveIntervention = useMutation({
  mutationFn: api.approveIntervention,
});
```

### Deliverables

- React and TypeScript operator application.
- Live map and forecast visualization.
- Intervention comparison screen.
- Human approval workflow.
- Typed API and WebSocket integration layer.
- Responsive, accessible component system.
- Vitest, React Testing Library, and Playwright coverage for critical flows.
- End-to-end orchestration.
- Cached fallback demonstration.
- Production frontend build, Docker configuration, and run documentation.
- Two-minute demonstration script.

### Definition of Done

A user can open the React application, trigger the incident, see live telemetry and forecasts, compare calculated interventions, approve one, and observe the simulated risk decrease without a page reload.

---

## Shared Data Contracts

### Zone Telemetry

```json
{
  "timestamp": "2026-10-17T19:30:00Z",
  "zone_id": "north_concourse",
  "people_count": 842,
  "density_estimate": 3.2,
  "inflow_per_min": 190,
  "outflow_per_min": 104,
  "mean_speed_mps": 0.61,
  "queue_length": 318,
  "dominant_direction": "north",
  "opposing_flow_ratio": 0.23,
  "status": "open"
}
```

### Forecast

```json
{
  "zone_id": "north_concourse",
  "horizon_minutes": 10,
  "predicted_density": 5.0,
  "risk_probability": 0.86,
  "time_to_congestion_minutes": 6.4,
  "confidence_interval": [4.4, 5.6],
  "top_factors": [
    "inflow exceeds outflow",
    "metro delay",
    "Gate B unavailable"
  ]
}
```

### Intervention Result

```json
{
  "intervention_id": "open_c_redirect_204_206",
  "actions": ["open_gate_c", "redirect_sections_204_206"],
  "rollouts": 5,
  "peak_density": 3.3,
  "clearance_time_minutes": 24.8,
  "people_redirected": 2860,
  "extra_walk_meters_mean": 71,
  "accessibility_violations": 0,
  "risk_reduction_percent": 34,
  "recommendation_rank": 1
}
```

## Integration Checkpoints

### Checkpoint 1 — Mocked modules

Every person demonstrates their component with static JSON fixtures. No module should initially require another person's unfinished code.

### Checkpoint 2 — First integration

Connect:

- Simulation telemetry to forecasting.
- Simulation snapshots to the response engine.
- Mock forecast and recommendation endpoints to the React frontend.

Keep the deterministic forecast baseline available if the trained model is not ready.

### Checkpoint 3 — Closed decision loop

Connect an approved frontend action back to the live simulation through the backend API. Verify that every displayed result is calculated from a real rollout rather than hard-coded.

### Checkpoint 4 — Demo freeze

Stop adding features. Rehearse the exact demonstration, fix instability, save backup results, and verify setup from a clean environment.

## Final Team Acceptance Criteria

The combined project is complete when it can:

1. Run normal post-match crowd flow.
2. Inject a gate closure and metro delay.
3. Detect the emerging risk.
4. Forecast congestion before it peaks.
5. Evaluate at least three interventions plus doing nothing.
6. Reject unsafe or inaccessible actions.
7. Recommend and explain the best feasible response.
8. Require human approval.
9. Apply the approved response to the simulation.
10. Show a calculated improvement in crowd-risk metrics.

## Scope Rule

If time becomes limited, reduce venue complexity, agent count, simulation fidelity, or ML sophistication. Do not remove the do-nothing comparison, counterfactual evaluation, accessibility constraints, human approval, or before-and-after measurement.
