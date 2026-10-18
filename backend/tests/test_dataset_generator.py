import csv
import json
import sys
from dataclasses import asdict, replace
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app.congestion.config import THRESHOLDS  # noqa: E402
from app.shared.models import RiskLevel  # noqa: E402
from scripts import generate_forecasting_dataset as gen  # noqa: E402

SEED = 20261017
RUNS = len(gen.SCENARIO_TYPES)
DURATION_S = 900
INTERVAL_S = 30
REQUIRED_COLUMNS = (
    "run_id",
    "scenario_type",
    "seed",
    "simulation_time_seconds",
    "gate_id",
    "gate_open",
    "gate_capacity_per_min",
    "people_count",
    "assigned_people",
    "arrivals_per_min",
    "queue_length",
    "density_per_m2",
    "mean_speed_mps",
    "throughput_per_min",
    "number_of_closed_gates",
    "nearby_gate_congested",
    "queue_after_5_minutes",
    "density_after_5_minutes",
    "queue_after_10_minutes",
    "density_after_10_minutes",
    "risk_after_5_minutes",
    "risk_after_10_minutes",
)


@pytest.fixture(scope="module")
def stadium() -> gen.Stadium:
    return gen.load_stadium()


@pytest.fixture(scope="module")
def dataset(stadium: gen.Stadium) -> tuple[list[dict], list[gen.RunPlan], dict[str, int]]:
    return gen.generate_dataset(RUNS, SEED, DURATION_S, INTERVAL_S, stadium)


@pytest.fixture(scope="module")
def full_series(stadium: gen.Stadium, dataset) -> list[dict]:
    _, plans, _ = dataset
    rows: list[dict] = []
    for plan in plans:
        run_rows = gen.simulate_run(plan, stadium, DURATION_S, INTERVAL_S)
        gen.add_future_targets(run_rows)
        rows.extend(run_rows)
    return rows


@pytest.fixture(scope="module")
def written(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, dict]:
    output_dir = tmp_path_factory.mktemp("dataset")
    manifest = gen.write_outputs(output_dir, RUNS, SEED, DURATION_S, INTERVAL_S)
    return output_dir, manifest


def _index(rows: list[dict]) -> dict[tuple[str, str, int], dict]:
    return {(row["run_id"], row["gate_id"], row["simulation_time_seconds"]): row for row in rows}


def test_same_seed_reproduces_identical_output(tmp_path: Path, written) -> None:
    first_dir, first_manifest = written
    second_manifest = gen.write_outputs(tmp_path, RUNS, SEED, DURATION_S, INTERVAL_S)

    first_csv = (first_dir / gen.CSV_NAME).read_bytes()
    second_csv = (tmp_path / gen.CSV_NAME).read_bytes()
    assert first_csv == second_csv

    def without_timestamp(manifest: dict) -> dict:
        return {key: value for key, value in manifest.items() if key != "generated_at"}

    assert without_timestamp(first_manifest) == without_timestamp(second_manifest)


def test_different_seed_changes_output(dataset) -> None:
    rows, plans, _ = dataset
    other_rows, other_plans, _ = gen.generate_dataset(RUNS, SEED + 1, DURATION_S, INTERVAL_S)

    assert [plan.seed for plan in plans] != [plan.seed for plan in other_plans]
    assert rows != other_rows


def test_all_eight_gates_are_present_from_shared_config(stadium: gen.Stadium, dataset) -> None:
    rows, _, _ = dataset
    config = json.loads(gen.STADIUM_CONFIG_PATH.read_text(encoding="utf-8"))
    config_ids = [gate["id"] for gate in config["gates"]]

    assert len(config_ids) == 8
    assert list(stadium.gate_ids) == config_ids
    assert all(
        gate.capacity_per_min == config["gateDefaults"]["capacityPerMinute"]
        for gate in stadium.gates
    )
    gates_per_sample: dict[tuple[str, int], list[str]] = {}
    for row in rows:
        key = (row["run_id"], row["simulation_time_seconds"])
        gates_per_sample.setdefault(key, []).append(row["gate_id"])
    assert all(sorted(ids) == sorted(config_ids) for ids in gates_per_sample.values())


def test_run_ids_and_seeds_are_unique(stadium: gen.Stadium) -> None:
    plans = gen.build_run_plans(gen.DEFAULT_RUNS, SEED, stadium)

    assert len({plan.run_id for plan in plans}) == gen.DEFAULT_RUNS
    assert len({plan.seed for plan in plans}) == gen.DEFAULT_RUNS


def test_rows_keep_one_seed_and_scenario_per_run(dataset) -> None:
    rows, plans, _ = dataset
    by_run = {plan.run_id: (plan.seed, plan.scenario_type) for plan in plans}

    assert {row["run_id"] for row in rows} == set(by_run)
    assert all((row["seed"], row["scenario_type"]) == by_run[row["run_id"]] for row in rows)


def test_no_negative_measurements(dataset) -> None:
    rows, _, _ = dataset
    columns = (
        "people_count",
        "assigned_people",
        "arrivals_per_min",
        "queue_length",
        "density_per_m2",
        "mean_speed_mps",
        "throughput_per_min",
        "queue_after_5_minutes",
        "density_after_5_minutes",
        "queue_after_10_minutes",
        "density_after_10_minutes",
    )
    assert all(row[column] >= 0 for row in rows for column in columns)


def test_no_run_closes_every_gate(stadium: gen.Stadium, dataset) -> None:
    rows, _, _ = dataset
    open_by_sample: dict[tuple[str, int], int] = {}
    for row in rows:
        key = (row["run_id"], row["simulation_time_seconds"])
        open_by_sample[key] = open_by_sample.get(key, 0) + row["gate_open"]

    assert all(row["number_of_closed_gates"] < len(stadium.gates) for row in rows)
    assert all(count >= 1 for count in open_by_sample.values())
    for plan in gen.build_run_plans(gen.DEFAULT_RUNS, SEED, stadium):
        gen.validate_gate_schedule(plan, stadium.gate_ids)


def test_schedule_closing_every_gate_is_rejected(stadium: gen.Stadium) -> None:
    plan = gen.RunPlan(
        run_id="run_bad",
        scenario_type="one_gate_closed",
        seed=1,
        events=tuple(gen.GateEvent(60, gate_id, False) for gate_id in stadium.gate_ids),
    )
    with pytest.raises(ValueError, match="every gate"):
        gen.validate_gate_schedule(plan, stadium.gate_ids)


@pytest.mark.parametrize("horizon", [5, 10])
def test_future_targets_align_with_horizon(dataset, full_series, horizon: int) -> None:
    rows, _, _ = dataset
    series = _index(full_series)

    for row in rows:
        future = series[
            (row["run_id"], row["gate_id"], row["simulation_time_seconds"] + horizon * 60)
        ]
        assert row[f"queue_after_{horizon}_minutes"] == future["queue_length"]
        assert row[f"density_after_{horizon}_minutes"] == future["density_per_m2"]
        assert row[f"risk_after_{horizon}_minutes"] == future["risk_level"]


def test_incomplete_target_rows_are_removed(dataset, full_series) -> None:
    rows, _, row_counts = dataset
    complete_until = DURATION_S - max(gen.HORIZONS_MINUTES) * 60

    assert row_counts["simulated"] == len(full_series)
    assert row_counts["final"] == len(rows)
    assert row_counts["simulated"] == (
        row_counts["final"]
        + row_counts["removed_incomplete_targets"]
        + row_counts["removed_cleared_venue"]
    )
    assert max(row["simulation_time_seconds"] for row in rows) <= complete_until
    assert all(row[column] is not None for row in rows for column in gen.TARGET_COLUMNS)
    tail = [row for row in full_series if row["simulation_time_seconds"] > complete_until]
    assert tail and all(row["queue_after_10_minutes"] is None for row in tail)


def test_targets_never_cross_run_or_gate_boundaries() -> None:
    rows = [
        {
            "run_id": run_id,
            "gate_id": gate_id,
            "simulation_time_seconds": time,
            "queue_length": offset + time,
            "density_per_m2": float(offset + time),
            "risk_level": f"{run_id}:{gate_id}",
        }
        for run_id, gate_id, offset in (
            ("run_a", "gate_a", 0),
            ("run_a", "gate_b", 10_000),
            ("run_b", "gate_a", 20_000),
        )
        for time in range(0, 601, 30)
        # run_b/gate_a is shorter so a leaking lookup would find run_a values.
        if not (run_id == "run_b" and time > 300)
    ]
    gen.add_future_targets(rows)

    for row in rows:
        future = row["simulation_time_seconds"] + 300
        expected = [
            other
            for other in rows
            if (other["run_id"], other["gate_id"], other["simulation_time_seconds"])
            == (row["run_id"], row["gate_id"], future)
        ]
        if expected:
            assert row["queue_after_5_minutes"] == expected[0]["queue_length"]
            assert row["risk_after_5_minutes"] == f"{row['run_id']}:{row['gate_id']}"
        else:
            assert row["queue_after_5_minutes"] is None
    run_b = [row for row in rows if row["run_id"] == "run_b"]
    assert all(row["queue_after_10_minutes"] is None for row in run_b)


def test_risk_labels_use_detector_thresholds(dataset, written) -> None:
    rows, _, _ = dataset
    _, manifest = written
    levels = {level.value for level in RiskLevel}

    assert manifest["risk_thresholds"] == asdict(THRESHOLDS)
    assert all(row["risk_after_5_minutes"] in levels for row in rows)
    assert all(row["risk_after_10_minutes"] in levels for row in rows)
    assert gen.classify_risk(THRESHOLDS.critical_density, 0, 1.0, 1) == RiskLevel.CRITICAL
    assert gen.classify_risk(0.0, THRESHOLDS.high_queue, 1.0, 1) == RiskLevel.HIGH
    assert gen.classify_risk(0.0, 0, 1.0, 0) == RiskLevel.NORMAL


def test_csv_has_expected_columns(written) -> None:
    output_dir, _ = written
    with (output_dir / gen.CSV_NAME).open(encoding="utf-8", newline="") as csv_file:
        header = next(csv.reader(csv_file))

    assert tuple(header) == gen.CSV_COLUMNS
    assert set(REQUIRED_COLUMNS) <= set(header)


def test_manifest_matches_csv(written) -> None:
    output_dir, manifest = written
    with (output_dir / gen.CSV_NAME).open(encoding="utf-8", newline="") as csv_file:
        csv_rows = list(csv.DictReader(csv_file))
    stored = json.loads((output_dir / gen.MANIFEST_NAME).read_text(encoding="utf-8"))

    assert stored == manifest
    assert manifest["number_of_rows"] == len(csv_rows)
    assert manifest["number_of_runs"] == RUNS == len({row["run_id"] for row in csv_rows})
    assert manifest["master_seed"] == SEED
    assert manifest["sampling_interval_seconds"] == INTERVAL_S
    assert manifest["simulation_duration_seconds"] == DURATION_S
    assert manifest["generator_version"] == gen.GENERATOR_VERSION
    assert manifest["generated_at"]
    assert manifest["data_origin"] == "synthetic simulation"
    assert manifest["data_limitations"]
    assert manifest["target_columns"] == list(gen.TARGET_COLUMNS)
    assert manifest["id_columns"] + manifest["feature_columns"] + manifest[
        "target_columns"
    ] == list(csv_rows[0])
    scenario_counts: dict[str, int] = {}
    for run in manifest["runs"]:
        scenario_counts[run["scenario_type"]] = scenario_counts.get(run["scenario_type"], 0) + 1
    assert manifest["scenario_counts"] == scenario_counts


def test_every_scenario_category_is_generated(stadium: gen.Stadium, dataset) -> None:
    rows, _, _ = dataset
    default_plans = gen.build_run_plans(gen.DEFAULT_RUNS, SEED, stadium)
    counts = {
        scenario: sum(plan.scenario_type == scenario for plan in default_plans)
        for scenario in gen.SCENARIO_TYPES
    }

    assert gen.DEFAULT_RUNS >= 120
    assert {row["scenario_type"] for row in rows} == set(gen.SCENARIO_TYPES)
    assert min(counts.values()) >= 13
    assert len(gen.SCENARIO_TYPES) == 9


def test_cleared_venue_rows_are_removed(dataset, full_series) -> None:
    rows, _, row_counts = dataset
    complete = gen.drop_incomplete_targets(full_series)
    cleared = [row for row in complete if row["people_remaining_in_venue"] == 0]

    assert all(row["people_remaining_in_venue"] > 0 for row in rows)
    assert len(cleared) == row_counts["removed_cleared_venue"]
    assert all(
        row[column] == 0
        for row in cleared
        for column in gen.TARGET_COLUMNS
        if not column.startswith("risk_")
    )


def test_release_profiles_keep_frontend_default_share(stadium: gen.Stadium) -> None:
    plans = gen.build_run_plans(gen.DEFAULT_RUNS, SEED, stadium)
    profiles = {plan.release_profile for plan in plans}
    default_blocks = [
        plan
        for index, plan in enumerate(plans)
        if index // len(gen.SCENARIO_TYPES) % gen.FRONTEND_DEFAULT_RELEASE_EVERY == 0
    ]

    assert {"frontend_default", "spread", "two_wave"} <= profiles
    assert len(default_blocks) / len(plans) >= 0.2
    # Scenarios that define their own release keep it; nothing else alters default timing.
    assert all(
        plan.release_profile in {"frontend_default", "scenario_defined"} for plan in default_blocks
    )
    for plan in plans:
        if plan.release_profile == "two_wave":
            assert 0.3 <= plan.second_wave_fraction <= 0.7
            assert 300 <= plan.second_wave_delay_s <= 900
        else:
            assert plan.second_wave_fraction == 0
        if plan.release_profile == "scenario_defined":
            assert plan.scenario_type in {"high_initial_load", "delayed_release"}


def test_second_wave_shifts_arrivals_later(stadium: gen.Stadium) -> None:
    plans = gen.build_run_plans(gen.DEFAULT_RUNS, SEED, stadium)
    plan = next(
        plan
        for plan in plans
        if plan.release_profile == "two_wave" and plan.scenario_type == "all_gates_open"
    )
    single_wave = replace(plan, second_wave_fraction=0.0, second_wave_delay_s=0.0)

    def late_arrivals(run_plan: gen.RunPlan) -> float:
        return sum(
            row["arrivals_per_min"]
            for row in gen.simulate_run(run_plan, stadium)
            if row["simulation_time_seconds"] > plan.second_wave_delay_s
        )

    assert late_arrivals(plan) > late_arrivals(single_wave)


def test_default_plans_meet_ten_minute_coverage_floor(stadium: gen.Stadium) -> None:
    # Every fourth default run still covers all nine scenarios and every release block.
    rows: list[dict] = []
    for plan in gen.build_run_plans(gen.DEFAULT_RUNS, SEED, stadium)[::4]:
        run_rows = gen.simulate_run(plan, stadium)
        gen.add_future_targets(run_rows)
        rows.extend(run_rows)
    rows = gen.drop_cleared_venue_rows(gen.drop_incomplete_targets(rows))

    coverage = gen.target_coverage(rows)
    assert coverage["queue_after_10_minutes"] >= gen.DEFAULT_MIN_TEN_MINUTE_COVERAGE
    assert coverage["queue_after_5_minutes"] > coverage["queue_after_10_minutes"]


def test_manifest_reports_target_coverage(written) -> None:
    output_dir, manifest = written
    with (output_dir / gen.CSV_NAME).open(encoding="utf-8", newline="") as csv_file:
        csv_rows = list(csv.DictReader(csv_file))
    queue_10 = sum(float(row["queue_after_10_minutes"]) > 0 for row in csv_rows) / len(csv_rows)

    assert manifest["target_nonzero_fraction"]["queue_after_10_minutes"] == round(queue_10, 4)
    assert manifest["minimum_ten_minute_queue_coverage"] == gen.DEFAULT_MIN_TEN_MINUTE_COVERAGE
    assert sum(manifest["release_profile_counts"].values()) == RUNS
    assert manifest["row_counts"]["final"] == len(csv_rows)


def test_cli_fails_below_coverage_floor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "generate_forecasting_dataset",
            "--runs",
            "2",
            "--duration-minutes",
            "15",
            "--output-dir",
            str(tmp_path),
            "--min-coverage",
            "1.0",
        ],
    )
    with pytest.raises(SystemExit, match="below"):
        gen.main()
