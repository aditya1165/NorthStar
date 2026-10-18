import csv
import json

from app.datasets import ZONE_COLUMNS, generate_dataset
from app.twin.scenarios import SCENARIO_KINDS, sample_scenarios


def test_scenario_sampling_is_reproducible_and_covers_every_kind() -> None:
    first = sample_scenarios(100, master_seed=3)
    assert first == sample_scenarios(100, master_seed=3)
    assert {s.kind for s in first} == set(SCENARIO_KINDS)
    assert len({s.seed for s in first}) == 100
    for scenario in first:
        if scenario.kind == "reopen":
            start, _, reopen = scenario.closures[0]
            assert reopen is not None and reopen > start


def test_generated_dataset_has_schema_targets_and_manifest(tmp_path) -> None:
    result = generate_dataset(tmp_path, runs=4, master_seed=2, workers=1)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["runs"] == 4
    assert manifest["zone_columns"] == ZONE_COLUMNS
    assert set(manifest["files"]) == {"zone_telemetry.csv", "runs.csv", "before_after.csv"}

    with (tmp_path / "zone_telemetry.csv").open() as handle:
        rows = list(csv.DictReader(handle))
    assert len(rows) == manifest["zone_rows"] > 0
    assert len({r["run_id"] for r in rows}) == 4
    assert all(float(r["target_density_t5"]) >= 0 for r in rows)
    times = sorted({float(r["time_seconds"]) for r in rows if r["run_id"] == rows[0]["run_id"]})
    assert times[1] - times[0] == 30.0

    with (tmp_path / "runs.csv").open() as handle:
        runs = list(csv.DictReader(handle))
    assert len(runs) == 4
    for run in runs:
        prefix = "closed_with_reroute" if json.loads(run["closures"]) else "all_open"
        assert run[f"{prefix}__not_exited"] == "0"
    assert result["before_after"]
