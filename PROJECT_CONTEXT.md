# CrowdGuardian — Current Project Context

**Status date:** 17 October 2026  
**Current scope:** Stadium egress only  
**Repository:** `aditya1165/NorthStar`

## 1. Product Goal

CrowdGuardian is a human-in-the-loop stadium crowd-management prototype. It simulates 4,000 people leaving a stadium, detects congestion at exits, and will recommend safer gate assignments and operational responses.

The current milestone is deliberately narrow:

```text
4,000-person stadium simulation
    -> per-person telemetry
    -> Python congestion detection
    -> visible operator warning
    -> deterministic gate reassignment
```

The wildfire scenario, trained forecasting model, and complete counterfactual optimization loop are deferred until this stadium loop is stable and measurable.

## 2. Current Stadium Model

- Exactly 4,000 stable person IDs exist in every run.
- The venue has 24 seating sections and eight evenly distributed exits, Gate A through Gate H.
- Each person follows explicit movement phases:

```text
seat
  -> row aisle
  -> section stairs/aisle
  -> ground-level base path
  -> selected gate corridor
  -> FIFO gate queue
  -> outside destination
  -> removed from the visible simulation
```

- An exited person never becomes active again during the same run.
- Every gate has a configurable service capacity. The current prototype default is 90 people per simulated minute per gate.
- Operators can open or close every gate independently.
- Gate B remains the scripted demonstration incident, but the movement model supports any combination of closed exits.
- The frontend preserves the existing 3D stadium design. It uses React Three Fiber and Three.js through an HTML WebGL canvas.

## 3. Shared Venue Configuration

[`shared/stadium-config.json`](shared/stadium-config.json) is the single source for:

- population;
- coordinate scale;
- bowl and ring geometry;
- gate IDs, labels, and angles;
- gate capacity defaults;
- backend gate-approach geometry parameters.

React uses the file to render and route through the venue. Python uses the same file to construct detection polygons. Gate geometry must not be duplicated in a second handwritten configuration.

## 4. Live Frontend-to-Backend Contract

React opens:

```text
ws://localhost:8000/ws/congestion
```

Once per real second, the frontend sends a complete logical snapshot containing:

- run ID and increasing sequence number;
- simulated time in seconds;
- configured population of 4,000;
- every active person's ID, ground-plane position, speed, assigned gate, and movement state;
- every exited person's ID, final gate, and simulated exit time.

The backend rejects malformed population accounting, duplicate IDs, non-increasing sequences, or an exited person reappearing in the same run.

The backend returns, for every gate:

- approach people count;
- people per square metre;
- queue length;
- mean speed;
- trailing one-minute throughput;
- congestion level and persistence state;
- detection time and a structured reason.

The connection automatically retries. If Python is unavailable, the stadium continues running, the UI displays `Detector unavailable`, and no local detection result is fabricated.

## 5. Current Congestion Rules

The detector is deterministic and backend-owned. Current prototype defaults include:

- high density: 3.2 people/m²;
- critical density: 4.5 people/m²;
- high queue: 80 people;
- critical queue: 160 people;
- queued-speed threshold: 0.6 m/s;
- detection persistence: 5 simulated seconds;
- clear persistence: 10 simulated seconds.

These are engineering demonstration values, not certified crowd-safety limits.

## 6. Current Rerouting Behavior

Automatic rerouting does not require an ML model.

The current frontend movement engine reassigns a person when:

- the assigned gate is closed by the operator; or
- Python confirms persistent congestion at the assigned gate.

Closed gates are excluded. Open alternatives are scored using:

```text
walking-distance cost
  + queue penalty
  + density penalty
  + confirmed-congestion penalty
```

A switching margin and cooldown reduce route oscillation. Approved mock interventions can still override selected sections.

This is a temporary integration boundary. The next milestone moves the routing decision into Python and leaves React responsible for executing and displaying returned assignments.

## 7. What Is Real and What Is Mocked

### Implemented and live

- 4,000-person deterministic frontend simulation;
- eight rendered exits and section aisles;
- individual gate open/close control;
- FIFO capacity-limited gate queues;
- permanent removal after exit;
- per-person WebSocket telemetry;
- Python gate congestion detection;
- backend connection and reconnect handling;
- congestion display in the existing header, incident strip, risk panel, gate list, and 3D gate treatment;
- deterministic client-side rerouting from closures and confirmed congestion;
- shared React/Python venue configuration;
- backend, frontend, browser, and Docker configuration tests.

### Present but still demonstration data

- 5- and 10-minute risk curves in the 3D dashboard;
- intervention outcome comparisons;
- recommendation ranking and approval narrative;
- zone forecast confidence and contributing factors.

The Python deterministic forecasting baseline exists in the backend, but the 3D per-person stream is not yet connected to it.

### Not implemented yet

- backend-owned per-person routing assignments;
- recorded multi-run training dataset;
- gradient-boosted forecasting models;
- live counterfactual rollouts;
- production-calibrated capacities or safety thresholds;
- wildfire evacuation simulation.

## 8. Immediate TODO — Ordered

### P0.1 — Move intelligent routing into Python

**Owner:** Person 3, with Person 2 supplying live risk metrics and Person 4 integrating the response.

- Add a deterministic backend routing engine.
- Calculate travel time, expected queue delay, density penalty, and route-change penalty in consistent seconds.
- Exclude closed gates.
- Return only changed person-to-gate assignments.
- Include the reason and estimated benefit for every assignment.
- Add cooldown and improvement thresholds.
- Make the frontend execute backend assignments instead of deciding them locally.

**Done when:** Closing or congesting any gate produces reproducible Python assignments, and the UI applies them without route oscillation.

### P0.2 — Produce the first simulation dataset

**Owner:** Person 1.

- Record 30-second zone aggregates and run metadata.
- Run normal, single-gate closure, multi-gate closure, and reopen scenarios.
- Vary gate combinations, release timing, walking speed, and seed.
- Export Parquet or CSV plus a generation manifest.
- Preserve complete run boundaries for leakage-safe splitting.

**Done when:** Person 2 receives at least 100 reproducible stadium runs with valid schemas and no population-accounting errors.

### P0.3 — Connect the deterministic forecast baseline

**Owner:** Person 2.

- Convert live telemetry into zone histories.
- Feed those histories into the existing mass-balance baseline.
- Return calculated 5- and 10-minute density and queue forecasts.
- Replace mock risk curves only after the live result is stable.
- Preserve explicit fallback and error states.

**Done when:** The 3D dashboard's forecast values are calculated from the current run instead of scenario fixtures.

### P0.4 — Add measurable scenario evaluation

**Owners:** Persons 1–3.

For every controlled test, record:

- maximum queue at each gate;
- peak approach density;
- gate throughput;
- total and percentile exit time;
- number of people rerouted;
- additional walking distance;
- number of route switches;
- time from closure to detection;
- time from detection to stable redistribution.

Compare all-open, closed-gate without rerouting, and closed-gate with rerouting runs.

### P0.5 — Replace mock interventions with backend rollouts

**Owner:** Person 3.

- Keep the do-nothing baseline.
- Evaluate at least three feasible response plans.
- Reject closed or capacity-invalid routes.
- Compare peak density, maximum queue, clearance time, and disruption.
- Require operator approval before applying a response.

### P1 — Hardening

- Calibrate gate capacities and detection thresholds from documented assumptions.
- Add a compact telemetry or changed-agent protocol if full snapshots become a performance problem.
- Add structured run logging and export.
- Test multiple simultaneous gate closures and all-gates-closed behavior.
- Verify Docker startup from a clean checkout.
- Remove deprecated Three.js clock usage when the rendering dependency is updated.
- Freeze the stadium demo before beginning the wildfire scenario.

## 9. Testing Status

Current automated checks:

- Python linting with Ruff;
- 15 backend tests;
- 11 frontend unit tests;
- four Playwright browser tests;
- TypeScript and Vite production build;
- Docker Compose configuration validation.

The browser tests cover stadium rendering, backend congestion presentation, gate control, and the existing operator decision flow.

## 10. Safety Position

CrowdGuardian is a simulation and decision-support prototype. It is not certified evacuation software, must not claim guaranteed safety, and must not autonomously control a real crowd. All gate capacities and detection thresholds remain configurable prototype assumptions until validated by qualified specialists.
