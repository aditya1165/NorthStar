# Person 2 — Risk Detection and Forecasting Implementation

## Current Implementation Status

Implemented now:

- FastAPI WebSocket ingestion at `/ws/congestion`;
- strict accounting for all 4,000 stable person identities;
- shared detection geometry for Gate A through Gate H;
- per-gate density, queue length, mean speed, and one-minute throughput;
- five-simulated-second congestion persistence and ten-second clearing hysteresis;
- live congestion results in the existing React stadium UI;
- deterministic mass-balance forecasting baseline in `backend/app/forecasting`.

Still TODO:

1. Aggregate the per-person stream into rolling zone histories.
2. Connect those live histories to the deterministic 5- and 10-minute baseline.
3. Receive at least 100 reproducible simulation runs from Person 1.
4. Construct future targets and scenario-level train/validation/test splits.
5. Train gradient-boosted models only after the dataset passes validation.
6. Compare every trained model against the deterministic baseline.

The current routing proof is deterministic and does not require ML. Backend-owned routing belongs to the next integration milestone and should consume Person 2's gate metrics. See [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for the complete project status.

## Decision

The core forecasting system should use neither an LLM nor OpenCV.

Use three layers:

1. Explainable current-risk rules
2. A deterministic flow-extrapolation baseline
3. Gradient-boosted forecasting models

OpenCV is an optional upstream component for converting camera footage into anonymous zone telemetry. An LLM is an optional downstream component for rewriting structured results into operator-friendly language. Neither should calculate or decide the crowd-risk forecast.

```text
Simulation or sensors
        ↓
Zone telemetry
        ↓
Feature engineering
        ↓
Rules + deterministic baseline + gradient boosting
        ↓
Density, queue, risk probability, and time to congestion
        ↓
Structured explanation
        ↓
Optional LLM wording
```

## Why Not Use an LLM for Forecasting?

An LLM is unsuitable for producing the core prediction because:

- Numerical results are difficult to validate and reproduce.
- Outputs may be nondeterministic.
- Physical flow constraints are not naturally preserved.
- Generated probabilities may not be calibrated.
- Explanations can disagree with the underlying measurements.
- It adds unnecessary latency and operational complexity.

An LLM may later receive an already calculated result:

```json
{
  "risk_probability": 0.86,
  "time_to_congestion_minutes": 6.4,
  "top_factors": [
    "inflow exceeds outflow",
    "Gate B unavailable",
    "metro delay"
  ]
}
```

It may turn this structure into readable text, but it must not change the values, risk level, or recommended action.

For the MVP, use deterministic templates instead:

```python
explanation = (
    f"{zone_name} may reach high congestion in "
    f"{time_to_congestion:.1f} minutes because "
    f"{', '.join(top_factors)}."
)
```

## Where OpenCV Fits

OpenCV is useful only if CrowdGuardian later consumes real camera footage.

```text
Camera
  → person detection and tracking
  → anonymous counts and movement vectors
  → zone telemetry
  → forecasting system
```

Computer vision could estimate:

- People entering and leaving a zone
- Aggregate crowd count
- Average movement direction
- Approximate walking speed
- Opposing-flow ratio

OpenCV should not perform the 5–10 minute operational forecast. The hackathon simulation already provides perfect ground-truth telemetry, so computer vision is not an MVP dependency.

## Algorithm 1 — Explainable Current-Risk Detector

Calculate features over rolling windows of approximately 30 seconds, 60 seconds, and 2 minutes.

Recommended features:

```text
current_density
density_change_30s
density_change_60s
density_slope
inflow_per_min
outflow_per_min
net_flow
inflow_outflow_ratio
current_speed
speed_change_60s
queue_length
queue_growth_rate
opposing_flow_ratio
neighbor_density_mean
gate_closed
metro_delayed
minutes_since_event_end
```

Normalize each risk indicator to a value between zero and one. Calculate a transparent composite score:

```python
risk_score = (
    0.30 * density_pressure
    + 0.20 * density_growth
    + 0.15 * flow_imbalance
    + 0.15 * speed_reduction
    + 0.10 * queue_growth
    + 0.10 * opposing_flow
)
```

Convert the score into demonstration bands:

```python
if risk_score >= 0.80:
    level = "critical"
elif risk_score >= 0.60:
    level = "high"
elif risk_score >= 0.35:
    level = "elevated"
else:
    level = "normal"
```

Keep the weights and thresholds in configuration. They are prototype values, not certified safety limits.

Add hard escalation conditions where appropriate:

```python
if gate_closed and inflow_per_min > outflow_per_min * 1.5:
    level = max_risk(level, "high")

if density_is_high and mean_speed_is_very_low:
    level = "critical"
```

## Algorithm 2 — Deterministic Forecast Baseline

The initial baseline uses mass-balance extrapolation:

```python
net_flow = inflow_per_min - outflow_per_min

future_people = max(
    0,
    current_people + net_flow * horizon_minutes,
)

future_density = future_people / zone_area
```

Estimate time to congestion using:

```python
threshold_people = configured_density_threshold * zone_area

if net_flow > 0:
    time_to_congestion = (
        threshold_people - current_people
    ) / net_flow
else:
    time_to_congestion = None
```

Keep this baseline permanently. If the trained model cannot load, receives invalid inputs, or encounters an unsupported scenario, the service should automatically fall back to deterministic forecasting.

## Algorithm 3 — Gradient-Boosted Forecasting

Use scikit-learn's `HistGradientBoostingRegressor` for density and queue predictions. It is suitable for tabular data, supports missing values, and supports quantile loss for uncertainty ranges.

Train separate models for:

- Density after 5 minutes
- Density after 10 minutes
- Queue length after 5 minutes
- Queue length after 10 minutes
- High-risk state after 5 minutes
- High-risk state after 10 minutes

Separate models are easier to train, evaluate, debug, and replace than a multi-output neural network during a hackathon.

Example configuration:

```python
from sklearn.ensemble import (
    HistGradientBoostingClassifier,
    HistGradientBoostingRegressor,
)

density_5m = HistGradientBoostingRegressor(
    max_depth=6,
    learning_rate=0.05,
    max_iter=250,
    random_state=42,
)

risk_10m = HistGradientBoostingClassifier(
    max_depth=6,
    learning_rate=0.05,
    max_iter=250,
    random_state=42,
)
```

## Training Dataset

Generate hundreds or thousands of synthetic simulation runs with varied:

- Attendance levels
- Gate availability
- Metro delays
- Section-release timing
- Route compliance
- Walking speeds
- Group sizes
- Intervention timing
- Random seeds

For each zone and timestamp, create one training row:

```text
scenario_id
seed
zone_id
timestamp
current telemetry features
rolling-window features
neighbor features
incident flags
target_density_5m
target_density_10m
target_queue_5m
target_queue_10m
target_high_risk_5m
target_high_risk_10m
```

Generate future targets from later simulation records:

```python
row["target_density_5m"] = density_at(timestamp + 5_minutes)
row["target_density_10m"] = density_at(timestamp + 10_minutes)
```

## Preventing Data Leakage

Do not randomly shuffle individual telemetry rows into training and testing datasets. Nearby timestamps from the same simulation are highly correlated and would create misleading results.

Split complete scenarios or seeds instead:

```text
Training:   scenario seeds 1–70
Validation: scenario seeds 71–85
Testing:    scenario seeds 86–100
```

Use `TimeSeriesSplit` when chronological validation is needed within a scenario family.

## Prediction Uncertainty

Train lower, median, and upper quantile models:

```python
lower_model = HistGradientBoostingRegressor(
    loss="quantile",
    quantile=0.10,
)

median_model = HistGradientBoostingRegressor(
    loss="quantile",
    quantile=0.50,
)

upper_model = HistGradientBoostingRegressor(
    loss="quantile",
    quantile=0.90,
)
```

Return a prediction interval:

```json
{
  "predicted_density": 4.9,
  "confidence_interval": [4.2, 5.7]
}
```

The API currently uses the `confidence_interval` field name. Internally, document this as a quantile-based prediction interval.

## Recommended Code Structure

```text
backend/app/forecasting/
├── __init__.py
├── baseline.py
├── features.py
├── risk_detector.py
├── model.py
├── service.py
├── explanations.py
└── training/
    ├── build_dataset.py
    ├── train.py
    └── evaluate.py

data/
├── generated/
│   ├── telemetry.parquet
│   └── training_features.parquet
└── models/
    ├── density_5m.joblib
    ├── density_10m.joblib
    ├── queue_5m.joblib
    ├── queue_10m.joblib
    ├── risk_5m.joblib
    └── risk_10m.joblib
```

## Implementation Order

1. Move deterministic flow extrapolation into `baseline.py`.
2. Implement rolling feature generation in `features.py`.
3. Implement configurable risk rules in `risk_detector.py`.
4. Obtain multiple synthetic scenario runs from Person 1.
5. Build future targets without time leakage.
6. Train density and queue regressors.
7. Train high-risk classifiers.
8. Add quantile-based prediction intervals.
9. Compare every model with the deterministic baseline.
10. Integrate trained models behind `ForecastService`.
11. Preserve automatic baseline fallback.
12. Return structured top factors with every forecast.

## Evaluation

Measure:

- Density mean absolute error at 5 and 10 minutes
- Queue-length mean absolute error
- High-risk precision and recall
- F1 score and AUROC
- Probability calibration or Brier score
- Time-to-congestion mean absolute error
- Improvement relative to the deterministic baseline
- Prediction latency

Missing a dangerous condition is more serious than producing a moderate number of false warnings. Optimize first for high recall, then control false alarms through probability calibration, persistence rules, and operator review.

## Definition of Done

Person 2's module is complete when it can:

1. Accept the shared zone-telemetry contract.
2. Detect current risk using explainable rules.
3. Produce deterministic 5- and 10-minute forecasts.
4. Produce trained-model density and queue forecasts.
5. Return calibrated high-risk probabilities.
6. Estimate time to congestion.
7. Return prediction intervals and top contributing factors.
8. Fall back safely when model artifacts are unavailable.
9. Beat or justify any failure to beat the deterministic baseline on held-out scenarios.
10. Reproduce results using fixed seeds.

## Recommended Final Approach

```text
Explainable rules
+ deterministic physics-inspired baseline
+ gradient-boosted forecasting
+ structured explanations
```

Do not use an LLM for risk calculation. Do not add OpenCV unless the team explicitly adds real camera ingestion.

## References

- [scikit-learn: HistGradientBoostingRegressor](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.HistGradientBoostingRegressor.html)
- [scikit-learn: TimeSeriesSplit](https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.TimeSeriesSplit.html)
