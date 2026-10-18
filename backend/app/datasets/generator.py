"""Reproducible training dataset from closed-loop twin runs.

Writes, per dataset directory:

* ``zone_telemetry.csv``  one row per run x zone x 30 s sample, with lag
  features, the deterministic baseline prediction, and +5/+10 minute targets.
* ``runs.csv``            scenario metadata and per-run summary metrics,
  including the before/after comparison for closure runs.
* ``before_after.csv``    mean outcome per scenario kind and condition.
* ``manifest.json``       generator settings, row counts, schema, and hashes.
"""

import csv
import hashlib
import json
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import UTC, datetime
from pathlib import Path

from app.forecasting import FlowBaseline
from app.shared.models import IncidentState, SimulationSnapshot, SimulationStatus
from app.twin.layout import CONFIG_VERSION, ZONES
from app.twin.runner import RunMetrics
from app.twin.scenarios import Scenario, before_after, run_scenario, sample_scenarios

DATASET_VERSION = "crowdguardian-zone-telemetry-v1"
SAMPLE_SECONDS = 30.0
HORIZONS_MINUTES = (5, 10)
ZONE_KIND = {zone.zone_id: zone.kind for zone in ZONES}

ZONE_COLUMNS = [
    "run_id",
    "scenario",
    "time_seconds",
    "zone_id",
    "zone_kind",
    "gate_closed",
    "closed_gate_count",
    "exited_fraction",
    "people_count",
    "density",
    "inflow_per_min",
    "outflow_per_min",
    "net_flow_per_min",
    "mean_speed_mps",
    "queue_length",
    "opposing_flow_ratio",
    "density_lag_30s",
    "density_lag_60s",
    "inflow_lag_60s",
    "baseline_density_t5",
    "baseline_density_t10",
    "target_density_t5",
    "target_density_t10",
]
METRIC_FIELDS = [
    "peak_density",
    "peak_zone",
    "seconds_above_high",
    "max_queue",
    "max_queue_gate",
    "clearance_minutes",
    "projected_clearance_minutes",
    "mean_egress_minutes",
    "p95_egress_minutes",
    "not_exited",
    "people_redirected",
    "mean_extra_walk_m",
]
CONDITIONS = ("all_open", "closed_no_reroute", "closed_with_reroute")
COMPARED = ("clearance_minutes", "peak_density", "seconds_above_high", "max_queue", "people_redirected", "mean_extra_walk_m")


def _lag(points: list, k: int, n: int, attr: str) -> float:
    return float(getattr(points[k - n][1], attr)) if k - n >= 0 else 0.0


def _future(points: list, k: int, n: int) -> float:
    """Observed density ``n`` samples later; 0 once the run has cleared."""
    return float(points[k + n][1].density_estimate) if k + n < len(points) else 0.0


def _zone_rows(scenario: Scenario) -> tuple[list[dict], dict[str, RunMetrics]]:
    routed = run_scenario(scenario, "engine", record_every_seconds=SAMPLE_SECONDS)
    baseline = FlowBaseline()
    series: dict[str, list[tuple[float, object]]] = defaultdict(list)
    for (seconds, zones), exited in zip(routed.samples, routed.exited_fraction, strict=True):
        for zone in zones:
            series[zone.zone_id].append((seconds, zone, exited))

    rows: list[dict] = []
    steps = {h: round(h * 60 / SAMPLE_SECONDS) for h in HORIZONS_MINUTES}
    for zone_id, points in series.items():
        for k, (seconds, zone, exited) in enumerate(points):
            closed_count = sum(
                1
                for start, _, reopen in scenario.closures
                if start * 60 <= seconds and (reopen is None or reopen * 60 > seconds)
            )
            snapshot = SimulationSnapshot(
                elapsed_minutes=seconds / 60,
                status=SimulationStatus.RUNNING,
                incidents=IncidentState(),
                zones=[zone],
            )

            predictions = {
                h: baseline.predict_zone(zone, h, snapshot).predicted_density
                for h in HORIZONS_MINUTES
            }
            rows.append(
                {
                    "run_id": scenario.run_id,
                    "scenario": scenario.kind,
                    "time_seconds": round(seconds, 1),
                    "zone_id": zone_id,
                    "zone_kind": ZONE_KIND[zone_id],
                    "gate_closed": int(zone.status == "closed"),
                    "closed_gate_count": closed_count,
                    "exited_fraction": round(exited, 4),
                    "people_count": zone.people_count,
                    "density": zone.density_estimate,
                    "inflow_per_min": zone.inflow_per_min,
                    "outflow_per_min": zone.outflow_per_min,
                    "net_flow_per_min": round(zone.inflow_per_min - zone.outflow_per_min, 2),
                    "mean_speed_mps": zone.mean_speed_mps,
                    "queue_length": zone.queue_length,
                    "opposing_flow_ratio": zone.opposing_flow_ratio,
                    "density_lag_30s": _lag(points, k, 1, "density_estimate"),
                    "density_lag_60s": _lag(points, k, 2, "density_estimate"),
                    "inflow_lag_60s": _lag(points, k, 2, "inflow_per_min"),
                    "baseline_density_t5": predictions[5],
                    "baseline_density_t10": predictions[10],
                    "target_density_t5": _future(points, k, steps[5]),
                    "target_density_t10": _future(points, k, steps[10]),
                }
            )
    rows.sort(key=lambda row: (row["time_seconds"], row["zone_id"]))
    if not scenario.closures:
        return rows, {"all_open": routed.metrics}
    if not scenario.closures:
        return rows, {"all_open": routed.metrics}
    conditions = {"closed_with_reroute": routed.metrics}
    if scenario.closures:
        comparison = before_after(scenario)
        conditions["all_open"] = comparison["all_open"]
        conditions["closed_no_reroute"] = comparison["closed_no_reroute"]
    return rows, conditions


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generate_dataset(output: Path, runs: int = 100, master_seed: int = 7, workers: int = 1) -> dict:
    if runs < 1:
        raise ValueError("At least one run is required")
    output.mkdir(parents=True, exist_ok=True)
    scenarios = sample_scenarios(runs, master_seed)
    if workers > 1:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            results = list(pool.map(_zone_rows, scenarios))
    else:
        results = [_zone_rows(scenario) for scenario in scenarios]

    zone_path = output / "zone_telemetry.csv"
    with zone_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=ZONE_COLUMNS)
        writer.writeheader()
        for rows, _ in results:
            writer.writerows(rows)

    run_columns = list(Scenario.__dataclass_fields__) + ["zone_rows"]
    for condition in CONDITIONS:
        run_columns += [f"{condition}__{name}" for name in METRIC_FIELDS]
    runs_path = output / "runs.csv"
    grouped: dict[tuple[str, str], list[RunMetrics]] = defaultdict(list)
    with runs_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=run_columns)
        writer.writeheader()
        for scenario, (rows, conditions) in zip(scenarios, results, strict=True):
            record = scenario.as_dict() | {"zone_rows": len(rows)}
            for condition, metrics in conditions.items():
                data = metrics.as_dict()
                for name in METRIC_FIELDS:
                    record[f"{condition}__{name}"] = data[name]
                grouped[(scenario.kind, condition)].append(metrics)
            writer.writerow(record)

    summary_path = output / "before_after.csv"
    summary_rows = []
    for (kind, condition), items in sorted(grouped.items()):
        row: dict[str, object] = {"scenario": kind, "condition": condition, "runs": len(items)}
        for name in COMPARED:
            values = [
                getattr(m, name) if getattr(m, name) is not None else m.projected_clearance_minutes
                for m in items
            ]
            row[f"mean_{name}"] = round(sum(values) / len(values), 3)
        summary_rows.append(row)
    with summary_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(summary_rows[0]))
        writer.writeheader()
        writer.writerows(summary_rows)

    kinds: dict[str, int] = defaultdict(int)
    for scenario in scenarios:
        kinds[scenario.kind] += 1
    manifest = {
        "dataset_version": DATASET_VERSION,
        "stadium_config_version": CONFIG_VERSION,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "generator": "backend/scripts/generate_dataset.py",
        "master_seed": master_seed,
        "runs": runs,
        "scenario_counts": dict(kinds),
        "sample_interval_seconds": SAMPLE_SECONDS,
        "forecast_horizons_minutes": list(HORIZONS_MINUTES),
        "routing_policy": "engine (Python-owned routing, 15 s decision interval)",
        "zones": [{"zone_id": z.zone_id, "kind": z.kind, "area_m2": round(z.area_m2, 1)} for z in ZONES],
        "files": {
            path.name: {"sha256": _sha256(path), "bytes": path.stat().st_size}
            for path in (zone_path, runs_path, summary_path)
        },
        "zone_rows": sum(len(rows) for rows, _ in results),
        "zone_columns": ZONE_COLUMNS,
        "notes": (
            "Targets are the observed zone density 5 and 10 minutes later in the same run "
            "(0 after the venue clears). Split by run_id to avoid leakage."
        ),
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return {"manifest": manifest, "before_after": summary_rows}
