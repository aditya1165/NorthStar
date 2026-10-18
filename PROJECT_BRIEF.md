# CrowdGuardian

## Project Definition

CrowdGuardian is a hackathon-scale, human-in-the-loop decision-support system for crowd-crisis mitigation at stadiums, arenas, festivals, transit hubs, and other high-density venues.

It predicts congestion 5–10 minutes before it becomes critical, tests feasible operational responses in a digital twin, and recommends the safest response that disrupts the fewest people.

> **One-line pitch:** Predict the bottleneck, simulate the options, and recommend the safest low-disruption response before conditions become dangerous.

The canonical description of the code that exists today and the ordered work backlog is [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md). This brief describes the target product; whenever a future capability in this file differs from the implementation, the status recorded in `PROJECT_CONTEXT.md` takes precedence.

## Current Implementation Snapshot

As of 17 October 2026:

- The active MVP scope is the stadium scenario only.
- React simulates exactly 4,000 stable person identities in the existing 3D stadium.
- The venue has 24 seating sections and eight exits, Gate A through Gate H.
- People use row aisles, section descents, a base path, gate corridors, and FIFO queues; they do not jump directly from the stands.
- Operators can open and close every gate.
- React sends complete per-person telemetry to FastAPI once per real second.
- Python detects persistent congestion at all eight gate approaches and returns live metrics to the existing UI.
- Closed or backend-confirmed congested gates currently cause deterministic frontend rerouting.
- The forecast and intervention panels still use deterministic demonstration data.
- The next milestone moves routing decisions into Python and connects the existing deterministic forecast baseline to the live 3D stream.

## Problem

Existing venue systems primarily show current conditions. Operators must still determine:

- Where congestion will develop next.
- What is causing it.
- Which available intervention will reduce risk.
- Whether that intervention will create another bottleneck.
- How to preserve accessibility while minimizing delay and rerouting.

CrowdGuardian closes this decision loop by combining detection, forecasting, counterfactual simulation, constrained optimization, and human approval.

## Primary Demo Scenario

The demonstration models post-match egress from a fictional stadium:

1. Exactly 4,000 spectators leave 24 seating sections through eight exits.
2. People follow explicit aisles to the base path and join a capacity-limited FIFO gate queue.
3. An operator closes Gate B or another selected combination of exits.
4. The Python detector confirms persistent congestion using person positions, speeds, queues, and throughput.
5. The UI identifies the congested gate and displays the measured cause.
6. A deterministic routing engine reassigns affected people to feasible open exits.
7. The completed MVP will forecast the next 5–10 minutes and compare doing nothing with at least three feasible interventions.
8. A human operator reviews and approves the selected operational response.
9. The live simulation applies the action and shows measured risk reduction.

All displayed results must be calculated from simulation output. Demo metrics must not be hard-coded.

## Decision Loop

```text
Venue digital twin
    -> zone telemetry
    -> current-risk detection
    -> 5–10 minute forecast
    -> feasible intervention generation
    -> parallel counterfactual rollouts
    -> constrained ranking
    -> operator review and approval
    -> approved action applied to the digital twin
```

## System Components

### 1. Venue digital twin

Represent:

- Walkable areas, corridors, stairs, ramps, gates, and exits.
- Seating-section release points and queueing areas.
- Restricted areas, incident zones, and transit entrances.
- Route capacities and operational constraints.
- Accessible routes and equivalent alternatives.

Each simulated visitor may have a destination, desired walking speed, group membership, route-compliance probability, venue familiarity, and mobility requirements.

### 2. Telemetry

Aggregate simulation state into fixed operational zones. Track:

- People count and estimated density.
- Inflow and outflow per minute.
- Mean walking speed and speed trend.
- Queue length and waiting time.
- Dominant direction and opposing-flow ratio.
- Gate, corridor, transit, incident, and weather status.

### 3. Current-risk detection

Use explainable, configurable rules combining multiple signals:

- High or rapidly increasing density.
- Falling speed while inflow remains high.
- Sustained inflow greater than available outflow.
- Consecutive queue growth.
- Opposing movement through a narrow corridor.
- A closed or capacity-reduced route.

Prototype thresholds are demonstration values, not certified safety limits.

### 4. Forecasting

Forecast per zone:

- Density after 5 and 10 minutes.
- Queue length.
- Probability of entering a configured high-risk state.
- Time to congestion.
- Expected clearance time.

Start with a deterministic persistence or flow-extrapolation baseline. Use gradient-boosted trees as the primary ML model and validate chronologically on held-out scenarios.

### 5. Intervention generation

Generate only actions that are currently available and operationally permitted, such as:

- Open an auxiliary gate or exit.
- Make a corridor temporarily one-way.
- Meter entry into a zone.
- Delay the release of selected seating sections.
- Redirect selected sections to another route.
- Change digital signage.
- Dispatch staff to a junction.
- Establish an incident exclusion zone.

Routes must never pass through blocked or unsafe areas. Accessibility constraints must be preserved.

### 6. Counterfactual simulation

For every candidate intervention and the do-nothing baseline:

1. Snapshot the current digital-twin state.
2. Clone the state into an isolated rollout.
3. Apply the candidate action.
4. Simulate the next 10–15 minutes.
5. Repeat across several fixed random seeds and compliance levels.
6. Aggregate outcomes and uncertainty.

Score the entire venue so that an action cannot improve one zone by creating a dangerous condition elsewhere.

### 7. Ranking and recommendation

Treat safety and accessibility as hard constraints where possible. Rank feasible candidates using:

- Peak density and time above the configured risk level.
- Maximum queue and total clearance time.
- Number and percentage of people redirected or delayed.
- Additional walking distance.
- Operational complexity and cost.
- Accessibility or equity penalties.
- Robustness across random seeds and compliance assumptions.

The recommendation must explain why it is preferred and show its improvement relative to doing nothing.

### 8. Operator control

The interface must let an operator:

- Review the detected problem and likely cause.
- Inspect the forecast, confidence, and assumptions.
- Compare the recommended action with alternatives.
- Approve, modify, or reject an intervention.
- Apply an approved response to the simulation.
- Return to the baseline or replay a scenario.

CrowdGuardian recommends actions; it does not autonomously control a real crowd.

## MVP Scope

### Required

- Simplified fictional venue with 6–12 operational zones.
- Synthetic pedestrian movement and zone telemetry.
- Gate-closure and transit-delay incident injection.
- Explainable current-risk detection.
- A 5–10 minute congestion forecast.
- At least three interventions plus doing nothing.
- Counterfactual rollouts using multiple fixed seeds.
- Ranked recommendation with quantified trade-offs.
- Human approval before application.
- Before-and-after visualization and metrics.
- Replayable demo scenario and cached fallback output.

### Optional after the closed loop works

- Statistical anomaly detection or Isolation Forest.
- Live GTFS-Realtime or weather data.
- Pretrained camera-based aggregate people counting.
- SUMO integration for city-scale transport.
- Graph neural networks or temporal deep-learning models.
- Natural-language operator queries.

### Out of scope

- Facial recognition or individual identity tracking.
- Training a vision model from scratch.
- A production-grade real-stadium digital twin.
- Autonomous real-world crowd control.
- Certified evacuation or public-safety advice.
- City-wide multimodal optimization in the MVP.

## Recommended Technology

- **Current simulation:** deterministic TypeScript waypoint and FIFO-queue engine
- **Current rendering:** React Three Fiber and Three.js in an HTML WebGL canvas
- **Future routing services:** Python graph/cost engine; NetworkX is optional if the route graph outgrows the current stadium model
- **Data processing:** Python, NumPy, pandas
- **Forecasting:** scikit-learn gradient boosting or XGBoost
- **Optimization:** Google OR-Tools
- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui, TanStack Query, Zustand, Zod, and Recharts
- **API:** FastAPI with REST endpoints and WebSocket telemetry
- **Storage:** SQLite for metadata, Parquet for simulation output
- **Testing:** pytest with deterministic simulation seeds
- **Packaging:** Docker

JuPedSim is not part of the current stadium implementation. It may be evaluated later, but the active frontend and telemetry contract must not be replaced during the MVP without a team decision.

## Core Data Contracts

### Zone telemetry

```json
{
  "timestamp": "ISO-8601 UTC timestamp",
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

### Intervention result

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

## Evaluation

Measure forecast quality using density and queue MAE, high-risk classification performance, time-to-congestion error, probability calibration, and comparison with a persistence baseline.

Measure intervention quality using peak-density reduction, time above the risk threshold, maximum queue, total clearance time, people redirected, additional walking distance, accessibility violations, and recommendation runtime.

## Acceptance Criteria

The MVP is complete when it can:

1. Run a normal post-match flow scenario.
2. Inject a gate closure and metro delay.
3. Detect the resulting flow imbalance.
4. Forecast the affected bottleneck before peak congestion.
5. Evaluate at least three feasible interventions and doing nothing.
6. Reject actions that violate constraints or create secondary congestion.
7. Recommend and explain the best low-disruption safe response.
8. Require operator approval before applying it.
9. Show a measurable improvement after application.
10. Reproduce the demonstration using deterministic seeds.

## Build Order

1. [x] Build eight-gate venue geometry and basic pedestrian simulation.
2. [x] Add explicit aisle-to-base movement, FIFO gate queues, and permanent exit lifecycle.
3. [x] Stream per-person telemetry to Python and display backend congestion results.
4. [x] Add individual control over every gate and deterministic closure response.
5. [ ] Move person-to-gate assignment decisions into the Python backend.
6. [ ] Generate reproducible stadium datasets and establish live zone histories.
7. [ ] Connect the deterministic 5- and 10-minute forecast baseline to the 3D run.
8. [ ] Train and validate gradient-boosted forecasting only after the dataset exists.
9. [ ] Implement feasible interventions and isolated counterfactual rollouts.
10. [ ] Replace mock recommendation data with calculated backend results.
11. [ ] Add full run export, clean-checkout Docker validation, demo freeze, and presentation polish.

## Current Work TODO

The immediate work order is:

1. Implement backend-owned routing assignments with reasons and estimated time benefit.
2. Make React execute returned assignment deltas instead of selecting the alternative gate itself.
3. Generate at least 100 reproducible normal and damaged-gate stadium runs.
4. Aggregate 30-second zone telemetry and connect it to the existing deterministic forecast baseline.
5. Add controlled before/after metrics for maximum queue, peak density, clearance time, walking distance, and number rerouted.
6. Replace mocked forecasts and interventions incrementally, never hiding unavailable backend results behind fabricated values.

See [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for owners, acceptance criteria, and the complete ordered backlog.

## Safety and Product Positioning

CrowdGuardian is a planning and operational decision-support prototype. It must display assumptions and uncertainty, use anonymous aggregate data, preserve accessible routes, and keep a qualified human responsible for every operational decision. It must not claim certification, deployment readiness, or guaranteed crowd safety.
