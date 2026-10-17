# CrowdGuardian — Person 1 to Person 2 Data Handoff

## Purpose

This document defines exactly what the Digital Twin and Telemetry owner (Person 1) must provide to the Risk Detection and Forecasting owner (Person 2).

The goal is to give Person 2 reproducible, correctly structured simulation data for:

- Current-risk detection
- Five-minute density and queue forecasting
- Ten-minute density and queue forecasting
- High-risk-state classification
- Time-to-congestion estimation
- Forecast uncertainty evaluation

## Ownership Boundary

### Person 1 owns

- Venue geometry and operational zones
- Pedestrian simulation
- Scenario generation
- Random parameter sampling
- Incident injection
- Agent-to-zone aggregation
- Raw telemetry export
- Scenario metadata
- Simulation reproducibility

### Person 2 owns

- Input validation
- Missing-data handling
- Rolling-window features
- Future-target construction
- Training, validation, and test splits
- Baseline and ML forecasting
- Model evaluation
- Saved forecasting artifacts

Person 1 must provide raw observations and scenario metadata. Person 1 should not calculate the future ML targets because target creation and leakage prevention belong to Person 2.

## Required Handoff Directory

```text
data/generated/
├── telemetry/
│   ├── scenario_0001.parquet
│   ├── scenario_0002.parquet
│   ├── scenario_0003.parquet
│   └── ...
├── scenario_metadata.parquet
├── zone_definitions.parquet
├── generation_manifest.json
└── README.md
```

Do not commit large generated datasets directly to Git. Store a small representative sample in the repository and share the complete dataset through the team's agreed artifact or storage location.

## Required Telemetry Schema

Person 1 must produce one record per operational zone at every sampling interval.

Recommended interval: **30 simulated seconds**.

Each scenario file must contain the following columns:

```text
scenario_id
seed
timestamp_seconds
zone_id
zone_area_m2
people_count
density_estimate
inflow_per_min
outflow_per_min
mean_speed_mps
queue_length
mean_wait_seconds
dominant_direction
opposing_flow_ratio
zone_status
gate_b_closed
metro_delayed
active_intervention
route_compliance
attendance
```

### Example telemetry record

```json
{
  "scenario_id": "egress_0042",
  "seed": 42,
  "timestamp_seconds": 360,
  "zone_id": "north_concourse",
  "zone_area_m2": 310.0,
  "people_count": 842,
  "density_estimate": 2.72,
  "inflow_per_min": 190.0,
  "outflow_per_min": 104.0,
  "mean_speed_mps": 0.61,
  "queue_length": 318,
  "mean_wait_seconds": 96.0,
  "dominant_direction": "north",
  "opposing_flow_ratio": 0.23,
  "zone_status": "open",
  "gate_b_closed": true,
  "metro_delayed": true,
  "active_intervention": null,
  "route_compliance": 0.78,
  "attendance": 12500
}
```

## Field Definitions

### Identifiers

- `scenario_id`: Unique stable identifier for one complete simulation run.
- `seed`: Random seed required to reproduce the run.
- `timestamp_seconds`: Simulated seconds elapsed since the beginning of the scenario.
- `zone_id`: Stable identifier matching the shared venue-zone definition.

### Zone measurements

- `zone_area_m2`: Walkable area used for density calculations.
- `people_count`: Number of active agents inside the zone.
- `density_estimate`: `people_count / zone_area_m2` unless a documented local-density method is used.
- `inflow_per_min`: Number of agents entering the zone during the rolling one-minute window.
- `outflow_per_min`: Number of agents leaving the zone during the rolling one-minute window.
- `mean_speed_mps`: Mean pedestrian speed for active agents in the zone.
- `queue_length`: Number of agents classified as waiting or moving below the configured queue-speed threshold.
- `mean_wait_seconds`: Mean waiting time for queued agents.
- `dominant_direction`: Dominant cardinal or route direction of travel.
- `opposing_flow_ratio`: Fraction of movement opposing the dominant direction, bounded between zero and one.
- `zone_status`: Operational status such as `open`, `restricted`, or `closed`.

### Scenario conditions

- `gate_b_closed`: Whether the scripted gate failure is active.
- `metro_delayed`: Whether reduced metro capacity is active.
- `active_intervention`: Applied intervention identifier or `null`.
- `route_compliance`: Fraction of affected agents expected to follow updated routing.
- `attendance`: Total attendance configured for the simulation.

## Scenario Metadata

`scenario_metadata.parquet` must contain one record per simulation run with:

```text
scenario_id
seed
scenario_type
attendance
simulation_duration_seconds
sampling_interval_seconds
gate_b_closed
gate_b_closure_start_seconds
metro_delayed
metro_delay_start_seconds
metro_capacity_multiplier
route_compliance
mean_walking_speed_mps
walking_speed_stddev
mean_group_size
section_release_multiplier
intervention_id
intervention_start_seconds
completed_successfully
failure_reason
simulator_version
generated_at_utc
```

This metadata lets Person 2 split the data by complete scenarios and audit how each run was generated.

## Zone Definitions

`zone_definitions.parquet` must contain:

```text
zone_id
zone_name
zone_area_m2
nominal_capacity
configured_risk_density
neighbor_zone_ids
accessible_route_available
```

Zone identifiers and areas must not change between scenario files created for the same dataset version.

## Required Scenario Coverage

Generate both normal and disrupted operations. The training dataset must not contain only dangerous scenarios.

Recommended scenario distribution:

- 25% normal operations
- 25% Gate B closure only
- 20% metro delay only
- 20% Gate B closure plus metro delay
- 10% unusual combinations and boundary cases

Vary at least these parameters:

```text
attendance
section_release_rate
gate_availability
metro_capacity
metro_delay_duration
walking_speed_distribution
group_size_distribution
route_compliance
initial_route_choice
incident_start_time
intervention_start_time
random_seed
```

Suggested ranges for the first dataset:

```python
attendance = random.randint(5_000, 20_000)
route_compliance = random.uniform(0.45, 0.95)
mean_walking_speed_mps = random.uniform(1.0, 1.5)
incident_start_minute = random.uniform(2.0, 12.0)
section_release_multiplier = random.uniform(0.7, 1.4)
metro_capacity_multiplier = random.uniform(0.25, 1.0)
```

## Dataset Size

Minimum first delivery:

- 100 scenario runs for pipeline development
- 6–12 operational zones
- At least 20 simulated minutes per run
- One record per zone every 30 seconds

Recommended model-training delivery:

- 500–1,000 scenario runs
- At least 30 simulated minutes per run
- Multiple seeds for every major scenario type

Example for 500 runs and six zones:

```text
500 scenarios × 6 zones × 60 timestamps = 180,000 telemetry rows
```

Scenario diversity is more important than generating extremely frequent observations from a small number of nearly identical runs.

## Simulation Requirements

Every scenario must:

1. Use an explicit random seed.
2. Produce the same result when rerun with the same configuration and software version.
3. Start with enough history before an incident for baseline feature generation.
4. Continue for at least ten minutes after the incident or intervention.
5. Record unsuccessful or incomplete runs in scenario metadata.
6. Never silently omit a failed scenario.
7. Use consistent units across every run.

Required units:

```text
time: seconds
distance: meters
speed: meters per second
area: square meters
density: people per square meter
flow: people per minute
```

## Intervention Data

Person 1 should generate separate scenarios for:

- Do nothing
- Open Gate C
- Redirect sections 204–206
- Make the east corridor one-way
- Open Gate C and redirect sections

Use a common `scenario_family_id` when several runs share the same initial state but apply different interventions. This allows later comparison of outcomes under matched conditions.

Add these metadata fields when counterfactual scenarios are available:

```text
scenario_family_id
intervention_id
intervention_start_seconds
compliance_assumption
```

The Person 2 forecasting model should initially be trained primarily on pre-intervention and do-nothing trajectories. Intervention outcomes are mainly consumed by Person 3's response engine, but retaining them allows later forecasting extensions.

## Output Format

Use Parquet for telemetry and metadata because it preserves types, compresses efficiently, and loads directly into pandas.

Use JSON only for:

- Generation manifests
- Scenario configuration
- Small fixtures
- API examples

Do not use one large JSON array for the full training dataset.

## Generation Manifest

`generation_manifest.json` must describe the delivery:

```json
{
  "dataset_version": "0.1.0",
  "simulator": "JuPedSim",
  "simulator_version": "record-installed-version",
  "generated_at_utc": "ISO-8601 timestamp",
  "scenario_count": 500,
  "successful_scenario_count": 496,
  "failed_scenario_count": 4,
  "sampling_interval_seconds": 30,
  "zone_count": 6,
  "telemetry_schema_version": "1.0.0",
  "scenario_seed_range": [1, 500]
}
```

## Quality Checks Person 1 Must Run

Before delivering the dataset, verify:

- Every `scenario_id` is unique in scenario metadata.
- Every telemetry `scenario_id` exists in scenario metadata.
- Every `zone_id` exists in zone definitions.
- Timestamps increase monotonically within each scenario and zone.
- Sampling intervals are consistent or explicitly documented.
- No people counts, densities, queues, speeds, or flows are negative.
- `opposing_flow_ratio` stays between zero and one.
- `density_estimate` agrees with people count and zone area within the agreed tolerance.
- Incident flags change at the configured incident times.
- Intervention identifiers match the shared intervention contract.
- Failed simulations are recorded with a failure reason.
- Repeating a scenario with the same seed reproduces the same telemetry.
- No personally identifiable information is present.

## Person 2 Validation on Receipt

Person 2 should independently verify:

1. Schema and data types.
2. Required-column completeness.
3. Missing-value rates.
4. Scenario and zone coverage.
5. Class balance for future high-risk states.
6. Distribution of density, speed, flow, and queue values.
7. Availability of five- and ten-minute future records.
8. Absence of duplicate scenario-zone-timestamp rows.
9. Reproducibility for a small sample of seeds.
10. Separation of scenario identifiers before model splitting.

## Handoff Acceptance Criteria

The first delivery is accepted when:

1. At least 100 reproducible scenarios are present.
2. Normal, single-incident, and compound-incident scenarios are included.
3. Telemetry is sampled every 30 simulated seconds.
4. Every required zone and telemetry field is present.
5. Each run continues for at least ten minutes after its incident.
6. Scenario metadata and zone definitions are included.
7. Person 2 can generate five- and ten-minute targets without joining errors.
8. No scenario identifier crosses a proposed train/test boundary.
9. Quality checks complete without unexplained failures.
10. A small sample dataset is committed for automated tests.

## Immediate Implementation Tasks

### Person 1

Create:

```text
backend/scripts/generate_training_data.py
backend/app/simulation/telemetry_writer.py
backend/tests/test_telemetry_export.py
```

The generator should accept:

```bash
python backend/scripts/generate_training_data.py \
  --scenarios 100 \
  --seed-start 1 \
  --sampling-interval 30 \
  --output data/generated
```

### Person 2

Create:

```text
backend/app/forecasting/training/validate_data.py
backend/app/forecasting/training/build_dataset.py
backend/tests/test_training_dataset.py
```

Person 2's dataset builder will add rolling features and future targets after validating the raw handoff.

## Final Handoff Rule

Person 1 provides reproducible raw simulation telemetry and complete scenario context. Person 2 transforms that data into leak-free training features and future prediction targets. Neither person should silently redefine shared fields, units, zones, or thresholds without updating the common schema and notifying the other module owners.
