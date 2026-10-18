# Forecasting Dataset Generation

> **Synthetic simulation data only.** This dataset is not real-world sensor data and is not
> produced by JuPedSim or any calibrated pedestrian simulator. It comes from a lightweight,
> seeded, standalone Python egress model written for training and evaluating forecasts.

## Generate

From `backend/`:

```bash
python -m scripts.generate_forecasting_dataset --runs 120 --seed 20261017
```

Options: `--runs`, `--seed`, `--duration-minutes` (default 30, must exceed 10),
`--interval-seconds` (default 30, must divide 300 and 600), `--output-dir`
(default `data/generated/`), and `--min-coverage` (default 0.08). The command exits with an
error if fewer than that share of rows have a non-zero 10-minute queue target.

Outputs:

- `data/generated/stadium_forecasting.csv`, with one row per gate per 30 simulated seconds
- `data/generated/stadium_forecasting_manifest.json`, which records the seeds, scenario counts,
  release-profile counts, row counts at each filter stage, the share of non-zero targets,
  columns, thresholds, per-run parameters, CSV SHA-256, and limitations

`data/generated/*` is gitignored, so regenerate locally with the command above. The default
run takes about a minute and writes about 3.3 MB. The same master seed always produces a
byte-identical CSV.

## Sources of truth

- **Gates, capacities, population, and geometry:** `shared/stadium-config.json`.
- **Approach area for density:** the detector's existing gate polygons
  (`app.congestion.config.GATES`).
- **Risk labels:** `CongestionDetector`'s own classifier and `THRESHOLDS` from
  `backend/app/congestion/config.py`. No separate thresholds exist.
- **Movement constants not in the shared config:** mirrored from the live frontend model
  (`frontend/src/twin/sim/crowdField.ts`). These are the 24 sections, 1.04–1.56 m/s walking
  speeds, stationary queues, nearest-gate-first routing, and rerouting only on closure or
  persistence-confirmed congestion, using the frontend route cost, 12 m margin, and 30 s
  cooldown.

## Scenarios

Runs cycle through nine categories, so 120 runs give 13–14 of each. Every run gets its own
seed, derived from the master seed.

| Scenario | Variation |
| --- | --- |
| `all_gates_open` | Baseline release |
| `one_gate_closed` | One random gate closes at 30–480 s |
| `two_gates_closed` | Two random gates close at 30–600 s |
| `gate_reopens` | One gate closes, then reopens 2–10 min later |
| `high_initial_load` | 15–30 % of the crowd starts already queued, and the rest leave quickly |
| `uneven_distribution` | Seating concentrated around a random hotspot angle |
| `reduced_walking_speed` | Walking speed × 0.55–0.80 |
| `reduced_gate_capacity` | 1–3 gates at 40–70 % capacity, or all gates at 60–85 % |
| `delayed_release` | Release starts 2–8 min late and is spread more widely |

At most two gates are ever closed. Any schedule that would close every gate is rejected.

### Release profiles

Each run also gets a release profile. This keeps crowds in the venue long enough for
10-minute targets to carry signal.

| Profile | Runs (of 120) | Timing |
| --- | --- | --- |
| `frontend_default` | 21 | The frontend's timing: everyone leaves their seats within about 4 minutes |
| `two_wave` | 72 | 30–70 % of the crowd leaves 5–15 minutes after the first wave |
| `spread` | 20 | Release spread over 3–8 minutes |
| `scenario_defined` | 7 | `high_initial_load` or `delayed_release` keep their own timing |

Every fifth block of nine runs uses frontend timing only. That covers 27 runs: the 21
`frontend_default` runs plus 6 of the 7 `scenario_defined` ones. So the live demo's behaviour stays in the data. Release windows
longer than about 5.5 minutes never build queues, because the gates together serve 720 people
per minute. Second waves and the scenario stressors are what produce longer-lived congestion.
These profiles are modelling assumptions, not measured stadium behaviour.

## Targets and row filtering

`queue_after_{5,10}_minutes`, `density_after_{5,10}_minutes`, and `risk_after_{5,10}_minutes`
are looked up from the row exactly 5 or 10 simulated minutes later with the same `run_id` and
`gate_id`. Rows without a full 10-minute future window (the last 10 minutes of each run) are
**removed**. The CSV contains no missing targets. Rows sampled after every person has left
the venue are also removed, because every target there is zero. `people_remaining_in_venue`
is included as a feature.

With the default settings, 9.7 % of rows (2,591) have a non-zero 10-minute queue target and
20.4 % (5,455) have a non-zero 5-minute target.

**Training guidance:** train regressors for the queue and density targets, then turn the
predictions into a risk level with the detector's classifier. Don't train directly on the
risk labels (see the limitations below).

Split training and test data **by `run_id`** to avoid leakage. `scenario_type` is metadata for
stratification and is not available live.

## Known limitations

- There is no collision physics or density-dependent slowdown. Queued people have speed 0, as
  in the frontend.
- Risk labels are the detector's instantaneous level and have no trigger/clear persistence.
  Because queued speed is 0, the detector's low-speed rule (≥ 20 people at ≤ 0.35 m/s) makes
  most busy gates `critical`. `high` does not appear in the default dataset. A fix belongs
  in the backend detector (owned by the backend teammate), for example leaving people who are
  intentionally queued out of the low-speed rule. Because the labels use the detector
  directly, they update automatically once that change lands.
- `queue_length` counts everyone waiting at the gate. All of them sit inside the approach
  polygon.
- `throughput_per_min` uses the detector's trailing-window rule and can slightly exceed
  capacity (up to 92 against a capacity of 90).
- With evenly spread seating, each gate's share of the crowd clears in about 5.5 minutes of
  service, so queues lasting 10 minutes or more come mainly from second waves, closures,
  reduced capacity, or uneven seating. About 10 % coverage is close to the realistic ceiling
  without inventing overload.
- Capacities and thresholds are prototype defaults, not certified crowd-safety limits.
