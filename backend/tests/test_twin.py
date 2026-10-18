import numpy as np
import pytest

from app.twin.field import Phase, StadiumTwin, TwinParams, mulberry32
from app.twin.layout import GATE_INDEX, POPULATION, ZONES
from app.twin.restore import LiveState, restore_twin
from app.twin.runner import TwinRunner, closure_events
from app.twin.scenarios import Scenario, before_after


def test_prng_matches_frontend_mulberry32() -> None:
    rand = mulberry32(20260614)
    # Reference values produced by the TypeScript rng() in crowdField.ts.
    expected = [0.5947930107358843, 0.9652073117904365, 0.8128513272386044, 0.8046817814465612]
    assert [rand() for _ in range(4)] == expected


def test_twin_starts_with_4000_seated_people() -> None:
    twin = StadiumTwin()
    batch = twin.telemetry_batch("run", 0)
    assert len(batch["agents"]) == POPULATION
    assert batch["exited_agents"] == []
    assert {agent["movement_state"] for agent in batch["agents"]} == {"waiting"}


def test_everyone_exits_once_and_people_are_conserved() -> None:
    twin = StadiumTwin()
    runner = TwinRunner(twin, policy="engine")
    while twin.exited_count() == 0 and twin.time < 90:
        runner.run_until(twin.time + 2.0)
    exited_early = set(np.where(twin.phase == Phase.EXITED)[0].tolist())
    assert exited_early
    metrics = runner.run_until_clear(120)
    assert metrics.not_exited == 0
    assert metrics.exited == POPULATION
    assert np.all(twin.exited_at >= 0)
    assert metrics.clearance_minutes is not None


@pytest.mark.parametrize("policy", ["engine", "local", "naive"])
def test_no_one_exits_through_a_closed_gate(policy: str) -> None:
    twin = StadiumTwin()
    runner = TwinRunner(twin, policy=policy, events=closure_events([(0.0, "gate_b", None)]))
    runner.run_until_clear(120)
    assert twin.exited_count() == POPULATION
    assert not np.any(twin.target == GATE_INDEX["gate_b"])


def test_runs_are_deterministic() -> None:
    def run() -> dict:
        twin = StadiumTwin(TwinParams(seed=11, speed_scale=0.9))
        return TwinRunner(twin, events=closure_events([(2.0, "gate_e", None)])).run_until_clear(120).as_dict()

    assert run() == run()


def test_restore_reproduces_live_state() -> None:
    twin = StadiumTwin()
    TwinRunner(twin, events=closure_events([(1.0, "gate_c", None)])).run_until(3.0)
    restored = restore_twin(LiveState.from_twin(twin))
    assert np.array_equal(restored.phase, twin.phase)
    assert np.array_equal(restored.target, twin.target)
    assert restored.closed[GATE_INDEX["gate_c"]]
    queued = [len(q) - h for q, h in zip(restored.queues, restored.queue_head, strict=True)]
    assert sum(queued) == int(np.count_nonzero(twin.phase == Phase.QUEUE))


def test_zone_definitions_cover_gates_and_base_path() -> None:
    assert len(ZONES) == 12
    assert sum(zone.kind == "gate_approach" for zone in ZONES) == 8
    assert all(zone.area_m2 > 50 for zone in ZONES)


def test_python_routing_beats_no_guidance_after_a_closure() -> None:
    scenario = Scenario(run_id="t", kind="single_closure", seed=5, closures=((1.0, "gate_b", None),))
    result = before_after(scenario)
    with_reroute = result["closed_with_reroute"].clearance_minutes
    without = result["closed_no_reroute"].clearance_minutes
    all_open = result["all_open"].clearance_minutes
    assert with_reroute is not None and without is not None and all_open is not None
    assert with_reroute < without
    assert all_open <= with_reroute + 0.5
