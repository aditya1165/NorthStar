# CrowdGuardian — Person 1 HTML Canvas Simulation Expectations

## 1. Purpose

This document is the implementation and data-delivery contract for Person 1, who owns the
CrowdGuardian simulation layer.

Person 1 must build two deterministic, browser-based simulation families:

1. **Stadium Evacuation**
   - Normal post-event evacuation of exactly 4,000 people through eight exits.
   - Controlled earthquake variant in which exits and internal routes become unavailable.
2. **Mountain Wildfire Evacuation**
   - Mixed pedestrian and vehicle evacuation through roads and a mountain trail.
   - A physically computed surface-fire perimeter, dynamic road danger, and controlled road
     blockages.

The simulations must run in TypeScript and render through React and the HTML Canvas API. They
must generate deterministic zone telemetry for the existing Person 2 forecasting algorithm:

- current-risk detection;
- deterministic 5- and 10-minute mass-balance forecasts;
- future gradient-boosted density, queue, and high-risk models;
- matched counterfactual evaluation of interventions.

This is a decision-support demonstrator. It is **not** a certified evacuation, structural,
traffic-engineering, or wildfire prediction system. Prototype thresholds and synthetic geometry
must never be presented as official safety guidance.

## 2. Approved Product Decisions

The following decisions are fixed for the first implementation:

- React owns the interface; HTML Canvas renders the world.
- A TypeScript Web Worker owns simulation state and time progression.
- Visible and headless runs use the same simulation engine.
- Person 2's Python/FastAPI service continues to own forecasting.
- Telemetry is exported every 30 simulated seconds.
- Forecast targets are 5 and 10 minutes into the future.
- Stadium reference runs contain exactly 4,000 people.
- The fictional stadium contains eight seating sectors and eight unequal-capacity exits.
- Stadium optimization prioritizes safety, then gate-burden balance, clearance time, and added
  walking distance.
- The earthquake can occur during evacuation and uses deterministic damage presets.
- The wildfire reference run contains 2,000 people and supports 500–4,000 through configuration.
- Wildfire evacuation includes both pedestrians and vehicles.
- Wildfire spread is computed from environmental inputs rather than played from a scripted
  perimeter animation.
- The mountain network contains three road routes, one pedestrian trail, two safe areas, and one
  or two controlled road blockages.
- No demographic or mobility categories are required in the first version.
- Interventions require operator approval before they modify a live run.
- Existing prototype thresholds remain in force: congestion density `3.2 people/m²` and critical
  queue length `400`.

## 3. Ownership Boundary

### 3.1 Person 1 owns

- deterministic simulation time and seeded random generation;
- stadium and mountain geometry;
- pedestrian movement and collision avoidance;
- vehicle movement, lane queues, and road capacity;
- wildfire spread and fire-state updates;
- incident injection, route closures, and route reopening where supported;
- route selection and execution of approved interventions;
- agent-to-zone telemetry aggregation;
- visible Canvas rendering and headless batch execution;
- scenario metadata, event logs, route definitions, and reproducibility;
- simulation-level validation and conservation checks.

### 3.2 Person 1 does not own

- the Person 2 risk-score weights;
- future-target construction;
- ML feature engineering;
- train/validation/test splitting;
- trained prediction models;
- final intervention ranking policy;
- LLM-generated explanations;
- camera ingestion or OpenCV.

Person 1 exports raw observations and complete scenario context. Person 1 must not precompute the
5- or 10-minute ML targets.

## 4. Required Browser Architecture

```text
React controls and dashboards
        │ commands / approved interventions
        ▼
SimulationController
        │ typed worker messages
        ▼
Simulation Web Worker
  ├── deterministic clock and random generator
  ├── pedestrian engine
  ├── vehicle engine
  ├── route graph and pathfinding
  ├── earthquake incident controller
  ├── wildfire spread engine
  ├── intervention executor
  └── telemetry aggregator
        │ render snapshots + 30-second telemetry
        ├──────────────────────────────┐
        ▼                              ▼
HTML Canvas renderer            FastAPI forecasting API
                                       │
                                       ▼
                              5- and 10-minute forecasts
```

### 4.1 Separation of simulation and rendering

The Canvas renderer must never be the source of truth. It only draws immutable snapshots received
from the worker.

The simulation must produce identical telemetry when:

- the Canvas is visible or hidden;
- the browser renders at 30, 60, or 144 frames per second;
- the user zooms or pans;
- animations are disabled;
- the simulation runs in visible or headless batch mode.

Use simulation coordinates in meters. Convert meters to pixels only in the renderer.

### 4.2 Time stepping

Required clocks:

- Pedestrian and vehicle physics step: fixed `0.1 s` target step.
- Wildfire propagation step: fixed `1.0 s` maximum step.
- Route-cost refresh: every `5 s` and immediately after a closure or approved intervention.
- Canvas render target: `30–60 FPS`, interpolated from simulation snapshots.
- API/dashboard snapshot: every `2.5 s` simulated time.
- Training telemetry export: every `30 s` simulated time.

The worker may execute multiple fixed steps per browser message. It must not use variable physics
steps derived from `requestAnimationFrame` timing.

### 4.3 Web Worker message contract

At minimum, support these commands:

```ts
type SimulationCommand =
  | { type: "LOAD_SCENARIO"; config: ScenarioConfig }
  | { type: "START" }
  | { type: "PAUSE" }
  | { type: "STEP"; seconds: number }
  | { type: "SET_SPEED"; multiplier: 1 | 2 | 5 | 10 | 20 }
  | { type: "REQUEST_SNAPSHOT" }
  | { type: "PROPOSE_INTERVENTION"; interventionId: string }
  | { type: "APPROVE_INTERVENTION"; interventionId: string }
  | { type: "REJECT_INTERVENTION"; interventionId: string }
  | { type: "RESET" }
  | { type: "RUN_HEADLESS"; configs: ScenarioConfig[] };
```

At minimum, emit:

```ts
type SimulationEvent =
  | { type: "READY"; scenarioId: string }
  | { type: "RENDER_SNAPSHOT"; snapshot: RenderSnapshot }
  | { type: "TELEMETRY"; snapshot: TelemetrySnapshot }
  | { type: "INCIDENT"; event: IncidentEvent }
  | { type: "INTERVENTION_PROPOSED"; proposal: InterventionProposal }
  | { type: "INTERVENTION_APPLIED"; event: InterventionEvent }
  | { type: "RUN_COMPLETE"; summary: RunSummary }
  | { type: "RUN_FAILED"; failure: SimulationFailure };
```

Every command and event must include simulated time, scenario ID, and a monotonically increasing
sequence number.

### 4.4 Determinism

- Do not call `Math.random()` inside simulation code.
- Use one documented seeded pseudo-random generator.
- Derive independent random streams for geometry, demand, pedestrians, vehicles, incidents, and
  wildfire inputs from the base seed.
- Store the base seed and derived seeds in scenario metadata.
- Iterate agents, cells, nodes, and edges in stable order.
- Resolve equal-cost routes using stable route IDs, not object insertion order.
- Round only at the export boundary; do not round internal state.
- Record the simulator commit, schema version, and browser/runtime version.

## 5. Common Simulation Models

### 5.1 Pedestrians

Each pedestrian has:

```text
agent_id_internal
position_m
velocity_mps
desired_speed_mps
radius_m
origin_id
destination_id
route_id
route_progress
state
reroute_eligible_at_seconds
compliance_draw
```

`agent_id_internal` must never appear in exported training telemetry.

Required pedestrian states:

```text
waiting_to_depart
moving
queued
rerouting
waiting_for_route
arrived_safe
stranded
```

Use a deterministic collision-avoidance model. The minimum implementation may combine desired
velocity, separation, obstacle avoidance, route-following, and speed clamping. Agents must not
overlap walls, cross closed barriers, or pass through burning cells.

Reference parameters, all configurable:

```text
desired_speed_mean_mps: 1.30
desired_speed_stddev_mps: 0.18
desired_speed_min_mps: 0.70
desired_speed_max_mps: 1.80
agent_radius_m: 0.25
queue_speed_threshold_mps: 0.30
stopped_speed_threshold_mps: 0.10
route_learning_delay_seconds: 10–120, seeded
route_compliance: 0.45–0.95
```

Although movement parameters vary, the first version must not assign demographic labels or infer
age, disability, gender, or health.

### 5.2 Vehicles

Vehicles exist only in the wildfire family. Each vehicle is one moving entity with a fixed person
occupancy. People inside a vehicle count toward evacuated-person totals but must not also exist as
pedestrian agents.

Required state:

```text
vehicle_id_internal
edge_id
lane_index
position_on_edge_m
speed_mps
length_m
occupancy_people
destination_safe_area_id
route_id
state
```

Use a deterministic lane-based car-following model with:

- acceleration toward an edge speed limit;
- deceleration based on the leading vehicle and stopping distance;
- no overlapping vehicles;
- first-in-first-out discharge at single-lane bottlenecks;
- explicit intersection and merge capacity;
- no lane changing in the first version unless the edge configuration permits it;
- no entry into a closed or fire-unsafe road edge.

Reference configurable values:

```text
vehicle_length_m: 4.5
minimum_gap_m: 2.0
maximum_acceleration_mps2: 1.5
comfortable_deceleration_mps2: 2.0
reaction_time_seconds: 1.2
default_occupancy_people: 3
```

The vehicle model is an evacuation-flow approximation, not a full traffic-engineering model.

### 5.3 Route graph

All walkable corridors, gates, roads, intersections, trail segments, and safe areas must be
represented in a directed graph.

Every edge contains:

```text
edge_id
from_node_id
to_node_id
mode: pedestrian | vehicle | shared
length_m
width_m
free_speed_mps
nominal_capacity_per_min
status: open | restricted | closed
capacity_multiplier
geometry_polyline
zone_ids
is_accessible
```

Required pathfinding behavior:

- Use deterministic Dijkstra or A*.
- Closed edges have infinite cost.
- Restricted edges use their current capacity and speed multipliers.
- A route is feasible only when every edge permits the entity's transport mode.
- Recalculate after incidents, approved interventions, and material congestion changes.
- Prevent route oscillation with a configurable reroute cooldown and improvement threshold.
- If no safe route exists, set the entity to `stranded` and report it; never delete it.

General route cost is expressed in seconds:

```text
route_cost =
    expected_travel_time
  + queue_delay_weight × expected_queue_delay
  + congestion_weight × congestion_delay
  + hazard_exposure_penalty
  + reroute_penalty
```

The default weights are `2.0`, `1.0`, and `30 s` respectively. All weights must be recorded in
scenario metadata.

## 6. Scenario Family 1 — Stadium Evacuation

### 6.1 Decision question

The stadium simulation must answer:

> How should 4,000 spectators be released and routed through eight unequal-capacity exits so that
> dangerous congestion is avoided and the maximum burden on any one gate is minimized?

The earthquake variant must additionally answer:

> When selected exits and corridors become unusable during evacuation, which safe reassignment
> and release plan produces the lowest remaining gate burden without routing anyone through the
> damaged layout?

### 6.2 Reference geometry

Use a fictional, top-down stadium in a `180 m × 140 m` simulation world.

Required elements:

- Eight seating-origin sectors: `S01` through `S08`.
- Inner circulation ring connecting all eight sectors.
- Outer concourse split into eight measurable zones: `C01` through `C08`.
- At least eight radial connectors: `R01` through `R08`.
- Eight exits: `E01` through `E08`.
- At least four cross-connectors allowing reassignment to a neighboring exit.
- A safe exterior zone beyond every exit.
- Explicit wall, barrier, and gate geometries.

No agent may spawn inside a wall, gate, barrier, or another agent.

### 6.3 Reference crowd distribution

Every reference run starts with exactly 4,000 people. Use this intentionally uneven sector
distribution:

| Sector | People |
|---|---:|
| S01 | 650 |
| S02 | 600 |
| S03 | 450 |
| S04 | 300 |
| S05 | 700 |
| S06 | 550 |
| S07 | 450 |
| S08 | 300 |
| **Total** | **4,000** |

For batch data, keep the total at 4,000 but vary sector allocations while enforcing `200–800`
people per sector.

### 6.4 Exit capacities

Use unequal synthetic effective capacities so that simple nearest-exit routing creates overload.
The capacity represents the narrowest combined corridor/gate service rate, not merely the drawn
door width.

| Exit | Effective capacity, people/min | Reference initial demand |
|---|---:|---:|
| E01 | 35 | 300 |
| E02 | 30 | 800 |
| E03 | 45 | 800 |
| E04 | 25 | 250 |
| E05 | 35 | 300 |
| E06 | 30 | 750 |
| E07 | 45 | 600 |
| E08 | 25 | 200 |
| **Total** | **270** | **4,000** |

The values are prototype assumptions and must be configurable. Person 1 must not label them as
measured stadium capacities.

The approximate capacity-proportional assignment for an undamaged reference run is:

```text
E01 519   E02 444   E03 667   E04 370
E05 519   E06 444   E07 667   E08 370
```

This is a comparison target, not a hard routing rule. Route length, congestion, connectivity, and
closed edges may make a different feasible assignment preferable.

### 6.5 Gate burden and optimization objective

For every exit `g` and export time `t`, compute:

```text
arrival_pressure(g,t) = rolling_60s_arrivals / effective_capacity_per_min
queue_pressure(g,t)   = queue_length / configured_queue_reference
density_pressure(g,t) = gate_zone_density / 3.2

gate_burden(g,t) = max(
    arrival_pressure,
    queue_pressure,
    density_pressure
)
```

Use `queue_reference = 400` for algorithm compatibility, while also retaining a smaller
gate-specific operational queue threshold in configuration.

The intervention objective is lexicographic:

1. Reject any plan that uses a closed or disconnected route.
2. Minimize time spent above the `3.2 people/m²` prototype congestion threshold.
3. Minimize peak density and agents stranded without a route.
4. Minimize `max(gate_burden)` across all available gates.
5. Minimize the coefficient of variation of gate utilization.
6. Minimize total clearance time.
7. Minimize mean and 95th-percentile additional walking distance.

No later objective may improve at the cost of violating an earlier safety constraint.

### 6.6 Normal post-event egress phases

Reference timeline:

```text
t=0–120 s      pre-release observation; spectators remain in sector holding areas
t=120 s        event ends; evacuation demand begins
t=120–300 s    section release ramps up
t=300 s onward full egress until all agents reach exterior safe zones
t=1800 s       nominal run end
t=2400 s       hard run limit; incomplete runs are failures
```

Batch runs vary event end, release rate, initial gate preference, compliance, walking speed,
intervention time, and exit capacities. Every run must contain enough observations to construct
5- and 10-minute targets.

### 6.7 Normal-egress interventions

Generate matched runs for:

1. `stadium_do_nothing`
   - Agents retain their initial nearest/preferred exit unless it becomes impossible.
2. `stadium_balanced_assignment`
   - Assign demand using available capacity, path length, and predicted burden.
3. `stadium_adaptive_rerouting`
   - Re-evaluate routes every 30 seconds; reassign only when expected cost improves by at least
     15% and the reroute cooldown has expired.
4. `stadium_phased_release`
   - Hold selected seating sectors temporarily when their downstream concourse or exit is above
     the configured threshold.
5. `stadium_combined_control`
   - Balanced initial assignment, adaptive rerouting, and phased release.

The system may calculate these proposals automatically, but a live run changes only after the
operator selects **Approve**. Rejected proposals are logged without changing routes.

### 6.8 Controlled earthquake variant

The earthquake is a controlled topology-change event. Person 1 is not expected to simulate
structural mechanics, falling debris physics, injuries, or building collapse.

The event must change the route graph by closing specified exits and corridor polygons. The Canvas
must visibly mark the damaged geometry. The simulation must then route only through the remaining
connected safe layout.

Reference incident time: `t=300 s`, after crowd movement has begun.

Required deterministic presets:

#### EQ-1 — Single-exit failure

- Close `E03` at `t=300 s`.
- Block new entry into the final `R03 → E03` connector.
- Keep adjacent outer-concourse cross-connectors available.

#### EQ-2 — Adjacent-exit failure

- Close `E02` and `E03` at `t=300 s`.
- Close the direct outer-concourse segment between `C02` and `C03`.
- Preserve at least one path from sectors `S02` and `S03` to exits `E01` or `E04`.

#### EQ-3 — Compound damage

- Close `E02`, `E03`, and `E07` at `t=300 s`.
- Close one east-concourse segment and one radial connector.
- Preserve at least two independent routes from every occupied sector to an undamaged exit.
- If the geometry fails this connectivity rule, configuration loading must fail before the run.

#### Agents already inside newly damaged geometry

- Never teleport or delete them.
- Split the affected route at the damage boundary.
- Stop motion toward the blockage.
- Route the agent back to the nearest reachable upstream node.
- If neither side is connected to a safe exit, mark the agent `stranded` and expose the count.

### 6.9 Earthquake interventions

For each damage preset, generate:

- `earthquake_do_nothing`: reroute only agents whose path becomes impossible;
- `earthquake_capacity_rebalance`: redistribute demand in proportion to remaining route capacity;
- `earthquake_neighbor_diversion`: move affected sectors to the nearest safe neighboring exits;
- `earthquake_phased_release`: pause upstream sectors while damaged-area queues dissipate;
- `earthquake_combined_control`: capacity rebalance plus phased release and adaptive routing.

Matched variants must use the same seed, initial positions, initial routes, desired speeds,
earthquake time, and damage preset. Their telemetry must be identical until the first approved
intervention.

### 6.10 Stadium completion and failure conditions

A run succeeds when:

- all 4,000 people are in exterior safe zones;
- the conservation equation balances exactly;
- nobody traversed closed geometry;
- every intervention and closure is logged;
- at least 10 minutes of telemetry exists after the earthquake or intervention when the run has
  not already cleared.

Conservation equation:

```text
4000 = waiting + active + queued + arrived_safe + stranded
```

A run fails and must be retained with a reason if:

- geometry is disconnected before an intended incident;
- agents penetrate obstacles or damaged areas;
- conservation fails;
- simulation time exceeds the hard limit with unexplained active agents;
- non-finite positions, speeds, or telemetry appear;
- the worker crashes or times out.

## 7. Scenario Family 2 — Mountain Wildfire Evacuation

### 7.1 Decision question

The wildfire simulation must answer:

> As a physically computed wildfire changes route safety and road blockages reduce capacity, how
> should pedestrians and vehicles be routed to safe areas—including use of a mountain trail—while
> minimizing hazard exposure, stranded people, congestion, and clearance time?

### 7.2 Scope of physical fire simulation

The fire cannot be a prerecorded expanding polygon. Its spread must emerge from:

- ignition location and time;
- spatial fuel type and fuel load;
- fuel moisture;
- terrain slope and aspect;
- wind direction and speed;
- cell-to-cell propagation;
- fuel consumption and burnout.

Implement a reduced-order **Rothermel-based surface-fire spread model**. The Rothermel model
calculates surface-fire rate of spread and intensity from fuel and environmental properties. Use
directional spread shaped by wind and slope, then propagate ignition across the terrain grid.

This first version explicitly excludes:

- crown-fire transition;
- long-range ember spotting;
- structure ignition;
- firefighting or suppression;
- dynamically changing weather unless supplied by the scenario;
- smoke-fluid dynamics;
- fatalities or injury prediction.

The exclusion list must appear in the UI and generated README.

### 7.3 Mountain world

Use a fictional `2,000 m × 1,400 m` mountain region with:

- four populated origin zones;
- three road routes;
- one pedestrian-only mountain trail;
- two safe assembly areas outside the expected fire-growth region;
- elevation, slope, fuel, moisture, and non-burnable rasters;
- road intersections, trail junctions, bridges, and chokepoints;
- explicit road and trail capacities;
- at least one alternate path from each origin under the undamaged reference layout.

Required origins and reference population:

| Origin | Vehicle evacuees | Pedestrians | Total people |
|---|---:|---:|---:|
| Pine Village | 800 | 200 | 1,000 |
| Ridge Campground | 300 | 100 | 400 |
| Mountain Lodges | 200 | 150 | 350 |
| Ranger Settlement | 200 | 50 | 250 |
| **Total** | **1,500** | **500** | **2,000** |

Represent the 1,500 vehicle evacuees as 500 vehicles with a reference occupancy of three. Batch
runs may vary occupancy and mode share, but exported totals must remain person-equivalent counts.

### 7.4 Required route network

#### Road R1 — Valley Road

- Main route to `SAFE_WEST`.
- Two directions under normal operation.
- Highest vehicle capacity and moderate distance.
- Passes through a low-elevation fuel corridor that can become fire-threatened.

#### Road R2 — Ridge Road

- Route to `SAFE_NORTH`.
- Lower capacity and steeper grade.
- Contains a controlled blockage point representing a fallen tree or rockfall.

#### Road R3 — Service Road

- Longest road route.
- Lowest road capacity.
- Serves as the principal fallback when R1 and R2 are unsafe.

#### Trail T1 — Mountain Trail

- Pedestrian only; vehicles can never enter it.
- Connects Ridge Campground and Mountain Lodges to `SAFE_NORTH`.
- Narrower, slower, and lower-capacity than a road walking corridor.
- Contains at least two trail zones so congestion can be measured along it.
- Closes when its fire-safety buffer is violated.

#### Safe areas

- `SAFE_WEST` and `SAFE_NORTH` must lie in non-burnable cells.
- Each safe area must have an explicit intake capacity.
- Arrival occurs only after crossing the safe-area boundary.
- Arrived entities are removed from route congestion but retained in cumulative totals.

### 7.5 Fire grid and state machine

Reference raster cell size: `10 m × 10 m`.

Each cell contains:

```text
cell_id
center_x_m
center_y_m
elevation_m
slope_radians
aspect_radians
fuel_model_id
fuel_load_kg_m2
fuel_moisture_fraction
is_burnable
state
ignition_time_seconds
remaining_fuel_fraction
spread_rate_mps
fireline_intensity_kw_m
```

Required states:

```text
unburned
heating
burning
burned
non_burnable
```

At each fire step:

1. Calculate the no-wind/no-slope surface spread rate from the configured fuel model.
2. Apply wind and slope factors.
3. Compute directional spread toward each of the eight neighboring cells.
4. Accumulate propagation progress using neighbor distance divided by directional spread rate.
5. Ignite a neighbor when accumulated propagation reaches its ignition threshold.
6. Calculate fireline intensity from heat yield, available fuel, and rate of spread.
7. Reduce remaining fuel and transition cells to `burned` when their burn duration ends.
8. Emit the new perimeter and intensity grid for hazard routing and rendering.

All environmental inputs, equations, coefficients, clamps, and unit conversions must be documented
and tested against simple analytical fixtures such as flat terrain, uniform fuel, zero wind, and a
single ignition point.

### 7.6 Reference environmental configuration

Use one documented synthetic reference case:

```text
simulation_start:               t=0 s
ignition_time:                  t=300 s
evacuation_alert_time:          t=420 s
ignition_location:              southeast of Mountain Lodges
wind_speed_at_reference_mps:    6.0
wind_direction:                 southwest toward northeast
fuel_moisture_fraction:         0.08–0.16 by zone
terrain_elevation_range_m:      900–1,450
fire_grid_cell_size_m:          10
nominal_run_end:                t=3,600 s
hard_run_limit:                 t=5,400 s
```

The configured wind convention must say whether direction means "from" or "toward." Store the
resolved Cartesian vector in metadata to eliminate ambiguity.

### 7.7 Hazard-to-route coupling

The fire engine and evacuation engine exchange state every fire step.

For each road or trail edge, calculate:

```text
minimum_distance_to_burning_cell_m
maximum_adjacent_fireline_intensity_kw_m
burning_intersection_length_m
threatened_time_seconds
```

Reference route rules:

- `closed`: geometry intersects a burning cell or is within `30 m` of one;
- `restricted`: nearest burning cell is `30–100 m` away;
- `open`: nearest burning cell is more than `100 m` away;
- non-burnable barriers may prevent Euclidean distance alone from deciding exposure, but any such
  shielding rule must be explicit and tested;
- a route closure applies to new entry immediately;
- entities already on an affected edge must stop before the unsafe boundary and reverse or reroute;
- no entity may move through a burning cell.

The values are demonstrator thresholds, not operational wildfire safety distances.

Hazard exposure penalty in path cost:

```text
distance <= 30 m:       infinite cost
30 m < distance < 100:  1,800 × (100 - distance) / 70 seconds
100–250 m:              300 × (250 - distance) / 150 seconds
distance >= 250 m:      0 seconds
```

Add an intensity-dependent penalty for adjacent high-intensity cells. Store all coefficients in
the scenario configuration.

### 7.8 Controlled non-fire road blockages

Road blockages are deterministic incident inputs layered on top of physically computed fire
spread.

Required presets:

1. `WB-1`
   - Full closure of one segment of R2 at `t=720 s`.
2. `WB-2`
   - Partial R2 blockage at `t=720 s`, reducing capacity to 35%.
   - Full closure of one R1 segment at `t=1,080 s`.
3. `WB-3`
   - No scripted blockage; closures come only from the computed wildfire.

Canvas symbols and telemetry must distinguish `fire`, `fallen_tree`, `rockfall`, and
`operator_closed` causes.

### 7.9 Wildfire interventions

Generate matched variants for:

1. `wildfire_do_nothing`
   - Entities keep the initial shortest feasible route and reroute only when it closes.
2. `wildfire_hazard_aware_routing`
   - Use predicted travel time, queue delay, fire proximity, and current spread direction.
3. `wildfire_phased_zone_evacuation`
   - Release the most threatened origins first while preventing a merge from exceeding downstream
     capacity.
4. `wildfire_activate_trail`
   - Assign eligible pedestrian demand to T1 when its safety buffer remains valid.
5. `wildfire_road_trail_split`
   - Balance vehicles across R1–R3 and pedestrians across safe roads and T1.
6. `wildfire_combined_control`
   - Hazard-aware routing, phased release, and road/trail balancing.

The system must show an operator proposal before applying it. The proposal includes:

```text
proposed_at_seconds
routes_opened_or_closed
origins_affected
people_or_vehicles_to_reroute
predicted_peak_density
predicted_peak_vehicle_queue
predicted_clearance_time
predicted_hazard_exposure_count
predicted_stranded_count
extra_distance_mean_m
reason_codes
```

Approval records the operator decision and applies the route changes at the next simulation step.
Rejection leaves the current policy unchanged.

### 7.10 Wildfire completion and failure conditions

Person conservation:

```text
initial_people =
    pedestrian_waiting
  + pedestrian_active
  + people_in_waiting_vehicles
  + people_in_active_vehicles
  + arrived_safe
  + stranded
```

A run succeeds when all non-stranded people reach a safe area, conservation holds, and all
remaining stranded people have a documented reason.

A run fails if:

- a vehicle enters the pedestrian-only trail;
- an entity crosses a closed edge or burning cell;
- a route is reported feasible when its graph is disconnected;
- fire state produces negative fuel, moisture, rate, or intensity;
- person or vehicle conservation fails;
- the same seed and configuration do not reproduce the same telemetry;
- the worker exceeds the hard time limit without an explicit incomplete-run status.

## 8. Telemetry Contract Required by Person 2

### 8.1 Core zone telemetry

Export exactly one record per scenario, zone, and 30-second timestamp.

| Field | Type | Definition |
|---|---|---|
| `scenario_id` | string | Unique run ID. |
| `scenario_family_id` | string | Shared ID for matched intervention variants. |
| `scenario_domain` | string | `stadium` or `wildfire`. |
| `seed` | integer | Base deterministic seed. |
| `timestamp_seconds` | integer | Simulated elapsed time. |
| `zone_id` | string | Stable zone identifier. |
| `zone_area_m2` | float | Walkable/usable zone area. |
| `people_count` | integer | Person-equivalent count currently in the zone. |
| `density_estimate` | float | `people_count / zone_area_m2` for pedestrian zones. |
| `inflow_per_min` | float | People entering during the trailing 60 seconds. |
| `outflow_per_min` | float | People leaving during the trailing 60 seconds. |
| `mean_speed_mps` | float | Mean pedestrian or person-equivalent movement speed. |
| `queue_length` | integer | People considered queued under the zone rule. |
| `mean_wait_seconds` | float | Mean current waiting duration of queued people. |
| `dominant_direction` | string | `north`, `east`, `south`, `west`, or `none`. |
| `opposing_flow_ratio` | float | Fraction moving against the dominant direction, `[0,1]`. |
| `zone_status` | string | `open`, `restricted`, or `closed`. |
| `incident_active` | boolean | Whether a scenario incident currently affects the run. |
| `incident_type` | string | `none`, `earthquake`, `wildfire`, or `road_blockage`. |
| `zone_impacted` | boolean | Whether the incident directly affects this zone. |
| `active_intervention` | string | Applied intervention or `do_nothing`. |
| `route_compliance` | float | Configured compliance fraction, `[0,1]`. |
| `population_total` | integer | Total people configured for the run. |

For compatibility during migration, stadium exports may additionally populate
`gate_b_closed=false` and `metro_delayed=false`; Person 2 must replace hard-coded Gate B/metro
incident logic with `incident_active` and `zone_impacted` before wildfire forecasting is enabled.

### 8.2 Domain-specific extensions

Stadium telemetry adds:

```text
available_exit_count
assigned_exit_id
exit_capacity_per_min
exit_utilization_ratio
gate_burden
people_arrived_safe_total
people_stranded_total
```

Wildfire telemetry adds:

```text
pedestrian_count
vehicle_count
people_in_vehicles
nearest_fire_distance_m
adjacent_fireline_intensity_kw_m
burning_cell_count
road_blocked
road_capacity_multiplier
people_arrived_safe_total
people_stranded_total
```

Fields that do not apply to a zone must be nullable according to the schema; they must not be
filled with misleading zeros.

### 8.3 Metric definitions

- `people_count` is a stock measured at the timestamp.
- `inflow_per_min` and `outflow_per_min` are trailing-window counts, not instantaneous rates.
- A pedestrian is queued when speed is below `0.30 m/s` for at least 10 continuous seconds while
  still having a feasible destination.
- A vehicle queue is converted to people using occupancy for `queue_length`; raw vehicle queue is
  also exported in the wildfire extension.
- `density_estimate` is meaningful only for pedestrian-usable area. Vehicle-only road zones must
  expose pedestrian density as null and provide vehicle density separately if needed.
- `opposing_flow_ratio` uses movement vectors with speed at least `0.10 m/s`.
- Empty zones use `mean_speed_mps=0`, `dominant_direction=none`, and
  `opposing_flow_ratio=0`.

## 9. Supporting Dataset Files

Required handoff structure:

```text
data/generated/
├── stadium/
│   ├── telemetry/
│   │   └── scenario_*.parquet
│   ├── scenario_metadata.parquet
│   ├── zone_definitions.parquet
│   ├── route_definitions.parquet
│   ├── event_log.parquet
│   ├── generation_manifest.json
│   └── README.md
└── wildfire/
    ├── telemetry/
    │   └── scenario_*.parquet
    ├── scenario_metadata.parquet
    ├── zone_definitions.parquet
    ├── route_definitions.parquet
    ├── event_log.parquet
    ├── fire_cells.parquet
    ├── generation_manifest.json
    └── README.md
```

### 9.1 Scenario metadata

Every run records:

```text
scenario_id
scenario_family_id
scenario_domain
seed
derived_seeds_json
population_total
pedestrian_population
vehicle_population_people
vehicle_count
simulation_duration_seconds
sampling_interval_seconds
incident_type
incident_start_seconds
damage_or_blockage_preset
intervention_id
intervention_proposed_seconds
intervention_decision
intervention_start_seconds
route_compliance
completed_successfully
failure_reason
simulator_version
git_commit
generated_at_utc
config_json
run_summary_json
```

Wildfire metadata additionally records fuel models, raster resolution, ignition, wind convention,
wind vector, moisture ranges, spread-model version, and excluded physical processes.

### 9.2 Event log

Record every state-changing event:

```text
scenario_id
sequence_number
timestamp_seconds
event_type
event_source
target_type
target_id
previous_state
new_state
reason_code
details_json
```

Required event types include incident start, fire-cell ignition, route restriction, route closure,
road blockage, intervention proposal, approval, rejection, application, agent reroute aggregate,
safe-area arrival aggregate, completion, and failure.

Do not export one event for every individual agent; aggregate reroutes and arrivals by route and
time step.

### 9.3 Manifest

The generation manifest must include an exact ordered list of expected telemetry files and a
SHA-256 checksum for each file. Quality checks must fail on both missing and unexpected files.
This prevents stale telemetry from an older generation being silently included.

## 10. Person 2 Algorithm Compatibility

The current deterministic baseline assumes constant flow over a forecast horizon:

```text
net_flow_per_min = inflow_per_min - outflow_per_min
future_people = max(0, people_count + net_flow_per_min × horizon_minutes)
future_density = future_people / zone_area_m2
```

Person 1 must therefore guarantee:

- counts and rates refer to the same zone boundary;
- flow units are people per minute;
- zone area is stable within a dataset version;
- no negative counts or flows;
- a continuous 30-second time grid;
- enough future time for 5- and 10-minute target joins;
- incident and intervention changes occur at recorded timestamps;
- closed/restricted states are visible in telemetry immediately.

The existing forecasting thresholds are prototype values:

```text
congestion_density:       3.2 people/m²
density_warning_floor:    1.5 people/m²
critical_queue_length:    400 people
free_flow_speed:          1.2 m/s
minimum_speed:            0.3 m/s
```

These values are useful for consistent demonstrations and labels but must not be described as
validated emergency limits.

## 11. Counterfactual Generation

For every `scenario_family_id`:

- keep geometry, population, initial positions, desired speeds, routes, vehicle occupancies,
  incident inputs, fire inputs, and random draws identical;
- vary only the intervention policy and, where explicitly studied, its approval time;
- require identical telemetry before intervention application;
- use stable intervention IDs;
- record rejected and approved decisions separately;
- compare outcomes only within the same family.

Required outcome summary:

```text
clearance_time_seconds
peak_density
seconds_above_congestion_threshold
peak_queue_people
peak_vehicle_queue
maximum_gate_burden
gate_utilization_coefficient_of_variation
people_rerouted
mean_extra_distance_m
p95_extra_distance_m
people_exposed_to_hazard_buffer
people_stranded
people_arrived_safe
route_closure_count
```

## 12. Dataset Delivery Sizes

### 12.1 Golden fixture

Commit a small, deterministic fixture containing:

- one stadium normal family with all five intervention variants;
- one stadium EQ-2 family with all five intervention variants;
- one wildfire WB-2 family with all six intervention variants;
- all supporting definitions, manifests, and event logs.

### 12.2 Pipeline-development delivery

Deliver at least 100 total runs per scenario domain with:

- normal, disrupted, and boundary conditions;
- multiple intervention timings and compliance values;
- at least 20% of runs reaching the prototype high-risk definition;
- at least 20% remaining entirely below it;
- no single preset exceeding 40% of a domain's runs.

### 12.3 Training delivery

Deliver at least 500 total runs per domain, grouped into matched scenario families. Scenario-family
IDs—not telemetry rows—must be used for the Person 2 split:

```text
training:   70%
validation: 15%
testing:    15%
```

No seed, base configuration, or matched counterfactual family may cross a split boundary.

## 13. Canvas Interface Requirements

### 13.1 Common controls

- scenario-family selector;
- preset selector;
- seed input;
- Start, Pause, Step, Reset;
- 1×, 2×, 5×, 10×, and 20× speed;
- intervention proposal panel;
- explicit Approve and Reject buttons;
- layer toggles;
- current simulated time and run status;
- export button for the current run.

### 13.2 Stadium visualization

Draw:

- seating sectors, concourses, connectors, exits, and exterior safe zones;
- individual agents at normal zoom and aggregated density at low zoom;
- gate status and effective capacity;
- current route assignments;
- queues and direction arrows;
- damaged exits/corridors using a distinct pattern, not color alone;
- per-gate burden bars with the most burdened gate highlighted;
- total evacuated, active, queued, and stranded counts.

### 13.3 Wildfire visualization

Draw:

- terrain shading and contours;
- fuel-type overlay;
- roads, intersections, trail, origins, and safe areas;
- pedestrian agents and vehicle entities with distinct symbols;
- unburned, heating, burning, and burned fire cells;
- fire perimeter and intensity bands;
- wind vector and simulation legend;
- fire-distance buffers;
- closure cause and capacity state on every affected route;
- active and proposed evacuation routes;
- safe, active, queued, exposed, and stranded people totals.

### 13.4 Accessibility

Canvas must not be the only information channel. Provide DOM-based text for:

- simulation status;
- counts and key metrics;
- active incidents and closures;
- proposed interventions;
- approval controls;
- selected-zone details;
- color legend equivalents.

## 14. Required Quality Checks

Person 1 must automate all of the following.

### 14.1 Universal checks

- Schema and data types exactly match the versioned contract.
- Scenario, family, zone, route, and intervention IDs are valid.
- Every expected file exists and no unexpected telemetry file exists.
- Scenario-zone-timestamp keys are unique.
- Timestamps are monotonic and exactly 30 seconds apart.
- Counts, densities, queues, speeds, flows, distances, fire rates, and intensities are finite and
  non-negative.
- Ratios remain within `[0,1]`.
- Same seed and configuration reproduce identical telemetry.
- Visible and headless modes produce identical telemetry.
- Rendering frame rate does not change simulation output.
- Matched counterfactuals are identical before intervention.
- Failed runs remain in metadata with a reason.
- No internal agent or vehicle identifier enters training telemetry.

### 14.2 Stadium checks

- Population conservation equals exactly 4,000 throughout the run.
- Eight exits and eight origin sectors exist.
- Initial reference demand sums to 4,000.
- Closed exits have zero successful outflow after closure.
- No agent crosses damaged geometry.
- Every earthquake preset passes its required connectivity rule before execution.
- Gate burden can be recomputed from raw telemetry.
- Combined control improves or explicitly explains failure to improve maximum burden relative to
  the matched do-nothing run.

### 14.3 Wildfire checks

- Initial people equal pedestrians plus vehicle occupancy.
- Vehicle occupancy is conserved through safe-area arrival.
- Vehicles never enter T1.
- Fire never ignites a non-burnable cell.
- With zero wind and uniform flat fuel, spread remains approximately radially symmetric within a
  documented grid tolerance.
- Increasing fuel moisture does not increase spread rate for the same fixture.
- Increasing aligned wind does not reduce head-fire spread for the same fixture.
- Uphill spread is not slower than downhill spread when all other fixture inputs are equal under
  the selected model formulation.
- Routes transition to restricted/closed at the configured fire distances.
- No entity crosses a burning cell or fully closed route.
- Fire and evacuation results reproduce exactly with the same seed and configuration.

## 15. Definition of Done

Person 1's work is accepted only when:

1. Both scenario families run entirely without JuPedSim.
2. The same TypeScript engine powers visible Canvas and headless batch modes.
3. Fixed-step simulation is independent of browser frame rate.
4. The stadium reference run contains exactly 4,000 people and eight functional exits.
5. Normal stadium interventions measurably compare gate burden.
6. All three earthquake presets safely change the route topology.
7. Wildfire spread responds to fuel, moisture, wind, and slope inputs.
8. Vehicles, pedestrians, three roads, one trail, two safe areas, and controlled road blockages
   operate together.
9. Operator approval gates every live intervention.
10. Telemetry supports the existing 5- and 10-minute Person 2 algorithms.
11. Golden fixtures and automated quality checks pass.
12. At least 100 clean pipeline-development runs per domain are delivered.
13. Manifests reject missing and stale files.
14. Assumptions, exclusions, and prototype thresholds are visible in documentation and the UI.

## 16. Recommended Source Layout

```text
frontend/src/simulation/
├── contracts/
│   ├── commands.ts
│   ├── events.ts
│   ├── scenario.ts
│   └── telemetry.ts
├── core/
│   ├── clock.ts
│   ├── random.ts
│   ├── geometry.ts
│   ├── routeGraph.ts
│   └── telemetryAggregator.ts
├── agents/
│   ├── pedestrians.ts
│   ├── vehicles.ts
│   └── queues.ts
├── stadium/
│   ├── geometry.ts
│   ├── scenarios.ts
│   ├── earthquake.ts
│   └── interventions.ts
├── wildfire/
│   ├── terrain.ts
│   ├── fuels.ts
│   ├── fireSpread.ts
│   ├── roadNetwork.ts
│   └── interventions.ts
├── worker/
│   ├── simulation.worker.ts
│   └── headlessRunner.ts
├── rendering/
│   ├── CanvasViewport.tsx
│   ├── StadiumRenderer.ts
│   └── WildfireRenderer.ts
└── tests/
    ├── determinism.test.ts
    ├── conservation.test.ts
    ├── counterfactuals.test.ts
    ├── stadium.test.ts
    └── wildfire.test.ts
```

## 17. Scientific and Platform References

- Rothermel, R. C. (1972), [A mathematical model for predicting fire spread in wildland
  fuels](https://research.fs.usda.gov/treesearch/32533), USDA Forest Service Research Paper
  INT-115.
- Andrews, P. L. (2018), [The Rothermel surface fire spread model and associated developments: A
  comprehensive explanation](https://research.fs.usda.gov/treesearch/55928), USDA Forest Service
  General Technical Report RMRS-GTR-371.
- Finney, M. A. (1998), [FARSITE: Fire Area Simulator—model development and
  evaluation](https://www.fs.usda.gov/rm/pubs/rmrs_rp004.pdf), USDA Forest Service Research Paper
  RMRS-RP-4.
- WHATWG, [HTML Standard: Canvas and
  OffscreenCanvas](https://html.spec.whatwg.org/multipage/canvas.html).

These sources define the technical basis for a reduced-order fire-spread implementation and a
worker-compatible Canvas architecture. Their inclusion does not make CrowdGuardian an operational
wildfire forecasting product.
