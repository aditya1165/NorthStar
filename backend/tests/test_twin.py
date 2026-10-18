import numpy as np
import pytest

from app.congestion.models import TelemetryBatch
from app.twin.field import Phase, StadiumTwin, TwinParams, mulberry32
from app.twin.layout import (
    BOWL_RX,
    BOWL_RZ,
    CONCOURSE_SCALE,
    GATE_ANGLES,
    GATE_IDS,
    GATE_INDEX,
    GATE_PORTAL_SCALE,
    POPULATION,
    QUEUE_INNER_SCALE,
    ZONES,
    angle_delta,
    initial_access_angles,
    nearest_open_gate,
    ring_coords,
    ring_point,
)
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


@pytest.mark.parametrize("restore", [False, True])
def test_closing_all_boundary_gates_stops_every_inside_person(restore: bool) -> None:
    twin = StadiumTwin()
    twin.advance_to(24, policy="none")
    assert np.any(twin.phase == Phase.QUEUE)
    assert np.any(twin.phase == Phase.GATE_APPROACH)
    assert np.any(twin.phase == Phase.EXIT)
    if restore:
        batch = TelemetryBatch.model_validate(twin.telemetry_batch("live", 1))
        twin = restore_twin(LiveState.from_batch(batch), speed_noise=0)

    outside_at_closure = np.where(twin.phase >= Phase.EXIT)[0]
    approaching = np.where(twin.phase == Phase.GATE_APPROACH)[0]
    before = np.column_stack((twin.x[approaching], twin.z[approaching]))
    twin.set_closed(GATE_IDS)
    inside_at_closure = np.where(twin.phase < Phase.EXIT)[0]
    while twin.time < 60 - 1e-6:
        twin.advance_to(min(60, twin.time + 0.04), policy="none")
        # Check actual geometry every step, not just phase labels at the end.
        scales = np.hypot(twin.x[inside_at_closure] / BOWL_RX, twin.z[inside_at_closure] / BOWL_RZ)
        assert np.all(scales < GATE_PORTAL_SCALE)

    # Leaving the FIFO queue is not the boundary crossing. Every person still
    # inside must remain inside, including those already walking toward a door.
    assert np.array_equal(np.where(twin.phase == Phase.EXITED)[0], outside_at_closure)
    assert np.array_equal(np.column_stack((twin.x[approaching], twin.z[approaching])), before)
    assert np.all(twin.speed_mps[approaching] == 0)
    _, scales = ring_coords(twin.x[twin.active_mask], twin.z[twin.active_mask])
    assert np.all(scales < GATE_PORTAL_SCALE)
    batch = twin.telemetry_batch("live", 2)
    approaches = [a for a in batch["agents"] if a["phase"] == "gate_approach"]
    assert approaches and all(a["movement_state"] == "queued" for a in approaches)

    twin.set_closed([])
    twin.advance_to(90, policy="none")
    assert twin.exited_count() == POPULATION


@pytest.mark.parametrize("phase", [Phase.QUEUE, Phase.GATE_APPROACH, Phase.CONCOURSE])
def test_reroutes_return_to_outer_concourse_then_follow_ellipse(phase: Phase) -> None:
    twin = StadiumTwin(TwinParams(population=1))
    twin.target[0] = 0
    twin.phase[0] = phase
    twin.angle[0] = GATE_ANGLES[0] + (2 if phase == Phase.QUEUE else 0)
    twin.scale[0] = QUEUE_INNER_SCALE + 0.04
    twin.x[0], twin.z[0] = ring_point(twin.angle[0], twin.scale[0])
    if phase == Phase.GATE_APPROACH:
        twin._begin_exit(0)
        twin.advance_to(0.16, policy="none")
    before = (twin.x[0], twin.z[0])
    assert twin.apply_assignments(np.array([0]), np.array([2])) == 1
    assert (twin.x[0], twin.z[0]) == before
    assert twin.phase[0] == Phase.RETURN_TO_CONCOURSE

    angles_on_arc = []
    for _ in range(1000):
        previous = np.array([twin.x[0], twin.z[0]])
        twin.advance_to(twin.time + 0.04, policy="none")
        current = np.array([twin.x[0], twin.z[0]])
        assert np.linalg.norm(current - previous) < 0.11
        angle, scale = ring_coords(twin.x, twin.z)
        assert scale[0] >= CONCOURSE_SCALE - 1e-6
        assert twin.phase[0] not in (Phase.BASE_RING, Phase.AISLE, Phase.GATE_CORRIDOR)
        if twin.phase[0] == Phase.CONCOURSE and abs(scale[0] - CONCOURSE_SCALE) < 1e-6:
            angles_on_arc.append(angle[0])
        if twin.phase[0] >= Phase.GATE_APPROACH:
            break
    assert len(angles_on_arc) > 20
    assert abs(float(angle_delta(angles_on_arc[0], angles_on_arc[-1]))) > 80
    assert twin.target[0] == 2
    assert twin.phase[0] == Phase.GATE_APPROACH


def test_destination_change_does_not_change_access_passage() -> None:
    twin = StadiumTwin(TwinParams(population=1))
    access = int(twin.access_gate[0])
    twin.phase[0] = Phase.GATE_CORRIDOR
    twin.angle[0] = GATE_ANGLES[access]
    twin.scale[0] = 0.8
    twin.x[0], twin.z[0] = ring_point(twin.angle[0], twin.scale[0])
    twin.apply_assignments(np.array([0]), np.array([(access + 2) % len(GATE_IDS)]))
    twin.advance_to(0.04, policy="none")
    assert twin.phase[0] == Phase.GATE_CORRIDOR
    assert twin.angle[0] == GATE_ANGLES[access]
    assert twin.scale[0] > 0.8


@pytest.mark.parametrize("phase", [Phase.WAITING, Phase.ROW, Phase.AISLE, Phase.BASE_RING, Phase.GATE_CORRIDOR])
def test_closed_door_escape_uses_fixed_section_passage_before_outer_ring(phase: Phase) -> None:
    twin = StadiumTwin(TwinParams(population=1))
    twin.target[0] = twin.access_gate[0] = 0
    twin.phase[0] = phase
    twin.angle[0] = GATE_ANGLES[0] if phase == Phase.GATE_CORRIDOR else -30
    twin.scale[0] = 0.8
    twin.x[0], twin.z[0] = ring_point(twin.angle[0], twin.scale[0])
    twin.set_closed(["gate_a"])
    twin.advance_to(0.04, policy="none")
    # Passage A is equally close to B/H: stable even person 0 picks B. Using the
    # current seat/aisle angle (-30) would incorrectly prefer H instead.
    assert twin.target[0] == GATE_INDEX["gate_b"]
    assert twin.access_gate[0] == 0


@pytest.mark.parametrize("phase", [Phase.QUEUE, Phase.CONCOURSE, Phase.RETURN_TO_CONCOURSE, Phase.GATE_APPROACH])
def test_closed_door_escape_uses_actual_outer_position_without_jumping(phase: Phase) -> None:
    twin = StadiumTwin(TwinParams(population=1))
    twin.target[0] = 0
    twin.phase[0] = phase
    twin.angle[0] = -20
    twin.scale[0] = CONCOURSE_SCALE if phase == Phase.CONCOURSE else 1.24
    twin.x[0], twin.z[0] = ring_point(twin.angle[0], twin.scale[0])
    if phase == Phase.GATE_APPROACH:
        twin._begin_exit(0)
    before = np.array([twin.x[0], twin.z[0]])
    twin.set_closed(["gate_a"])
    twin.advance_to(0.04, policy="none")
    assert twin.target[0] == GATE_INDEX["gate_h"]
    assert np.linalg.norm(np.array([twin.x[0], twin.z[0]]) - before) < 0.11
    assert twin.phase[0] in (Phase.RETURN_TO_CONCOURSE, Phase.CONCOURSE)
    _, scale = ring_coords(twin.x, twin.z)
    assert scale[0] >= CONCOURSE_SCALE - 1e-6


def test_equal_nearest_open_doors_split_stably_by_identity() -> None:
    ids = np.arange(20)
    closed = np.zeros(len(GATE_IDS), dtype=bool)
    closed[0] = True
    result = nearest_open_gate(np.full(ids.size, GATE_ANGLES[0]), ids, closed)
    assert result.tolist() == [1, 7] * 10
    assert np.array_equal(result, nearest_open_gate(np.full(ids.size, -15), ids, closed))
    assert np.all(nearest_open_gate(np.full(ids.size, -15), ids, np.ones(8, dtype=bool)) == -1)


@pytest.mark.parametrize("seed", [1, 11, 20260614, 123456789])
def test_telemetry_access_angle_helper_matches_seeded_seat_layout(seed: int) -> None:
    twin = StadiumTwin(TwinParams(seed=seed))
    assert np.array_equal(initial_access_angles(np.arange(twin.count)), GATE_ANGLES[twin.access_gate])


@pytest.mark.parametrize("restore", [False, True])
def test_mid_run_closure_escapes_without_approval_and_reopening_does_not_flip_routes(restore: bool) -> None:
    twin = StadiumTwin()
    twin.advance_to(24, policy="none")
    if restore:
        batch = TelemetryBatch.model_validate(twin.telemetry_batch("closure", 1))
        twin = restore_twin(LiveState.from_batch(batch), speed_noise=0)
    affected = np.where((twin.phase < Phase.EXIT) & (twin.target == GATE_INDEX["gate_b"]))[0]
    outside = np.where(twin.phase >= Phase.EXIT)[0]
    outside_targets = twin.target[outside].copy()
    assert affected.size > 0
    twin.set_closed(["gate_b"])
    twin.advance_to(twin.time + 0.04, policy="none")
    assert np.all(twin.target[affected] != GATE_INDEX["gate_b"])
    assert np.array_equal(twin.target[outside], outside_targets)
    escaped_targets = twin.target[affected].copy()
    twin.set_closed([])
    twin.advance_to(twin.time + 2, policy="none")
    assert np.array_equal(twin.target[affected], escaped_targets)


def test_all_closed_waits_then_one_reopened_gate_releases_everyone() -> None:
    twin = StadiumTwin(TwinParams(population=16))
    twin.set_closed(GATE_IDS)
    original = twin.target.copy()
    twin.advance_to(24, policy="none")
    assert twin.exited_count() == 0
    assert np.array_equal(twin.target, original)
    twin.set_closed([gate for gate in GATE_IDS if gate != "gate_c"])
    twin.advance_to(twin.time + 0.04, policy="none")
    assert np.all(twin.target == GATE_INDEX["gate_c"])
    twin.advance_to(90, policy="none")
    assert twin.exited_count() == twin.count


def test_closed_target_assignments_are_rejected_and_congestion_alone_is_advisory() -> None:
    twin = StadiumTwin(TwinParams(population=16))
    twin.set_closed(["gate_b"])
    ids = np.arange(twin.count)
    assert twin.apply_assignments(ids, np.full(twin.count, GATE_INDEX["gate_b"])) == 0
    twin.set_closed([])
    original = twin.target.copy()
    twin.signals.queue[:] = 1000
    twin.signals.congested[:] = True
    twin.advance_to(24, policy="none")
    assert np.array_equal(twin.target, original)


def test_telemetry_roundtrip_preserves_outer_movement_phases_and_positions() -> None:
    twin = StadiumTwin()
    twin.advance_to(24, policy="none")
    for phase in (Phase.CONCOURSE, Phase.QUEUE, Phase.GATE_APPROACH, Phase.EXIT):
        assert np.any(twin.phase == phase)
    queued = np.where(twin.phase == Phase.QUEUE)[0][:5]
    twin.apply_assignments(queued, (twin.target[queued] + 1) % len(GATE_IDS))
    batch = TelemetryBatch.model_validate(twin.telemetry_batch("roundtrip", 1))
    state = LiveState.from_batch(batch)
    restored = restore_twin(state, speed_noise=0)
    assert np.array_equal(restored.phase, twin.phase)
    assert np.array_equal(restored.target, twin.target)
    ids = state.person_ids
    assert np.array_equal(restored.x[ids], state.x)
    assert np.array_equal(restored.z[ids], state.z)
    outer = ids[np.isin(state.phase, (Phase.CONCOURSE, Phase.RETURN_TO_CONCOURSE))]
    assert np.all(restored.scale[outer] >= CONCOURSE_SCALE - 0.001)
    # Resumption must remain continuous rather than reconstructing people at base.
    restored.advance_to(restored.time + 0.04, policy="none")
    movement = np.hypot(restored.x[ids] - state.x, restored.z[ids] - state.z)
    assert movement.max() < 0.2


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
