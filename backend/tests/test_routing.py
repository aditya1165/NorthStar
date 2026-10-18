import numpy as np

from app.routing.engine import COOLDOWN_SECONDS, RoutingEngine, RoutingPlan
from app.twin.field import GateSignals, Phase, StadiumTwin
from app.twin.layout import (
    GATE_ANGLES,
    GATE_IDS,
    GATE_INDEX,
    initial_access_angles,
    nearest_open_gate,
    ring_point,
)
from app.twin.runner import GateEvent, TwinRunner


def _decide(engine: RoutingEngine, twin: StadiumTwin, seconds: float, signals: GateSignals | None = None):
    active = np.where(twin.phase < Phase.EXIT)[0]
    return engine.decide(
        seconds,
        active,
        twin.x[active],
        twin.z[active],
        twin.target[active],
        twin.phase[active],
        signals or GateSignals.empty(),
        twin.closed,
    )


def test_closure_reassigns_everyone_heading_to_the_closed_gate() -> None:
    twin = StadiumTwin()
    TwinRunner(twin).run_until(2.0)
    twin.set_closed({"gate_b"})
    heading = int(np.count_nonzero((twin.phase < Phase.EXIT) & (twin.target == GATE_INDEX["gate_b"])))
    assert heading > 0

    decision = _decide(RoutingEngine(), twin, 120.0)
    closure_moves = [a for a in decision.assignments if a.reason == "gate_closed"]
    assert len(closure_moves) == heading
    assert all(a.from_gate == GATE_INDEX["gate_b"] for a in closure_moves)
    assert all(a.to_gate != GATE_INDEX["gate_b"] for a in decision.assignments)
    assert decision.gate_wait_seconds[GATE_INDEX["gate_b"]] == np.inf


def test_deltas_only_contain_people_whose_gate_changes() -> None:
    twin = StadiumTwin()
    TwinRunner(twin).run_until(1.0)
    decision = _decide(RoutingEngine(), twin, 60.0)
    assert all(a.from_gate != a.to_gate for a in decision.assignments)


def test_congestion_reassignments_respect_cooldown() -> None:
    twin = StadiumTwin()
    busiest = 0
    packed = np.arange(400)
    twin.phase[packed] = Phase.QUEUE
    twin.target[packed] = busiest
    twin.time = 5.0
    congested = np.zeros(len(GATE_IDS), dtype=bool)
    congested[busiest] = True
    signals = GateSignals(queue=twin.queued_per_gate(), density=np.zeros(8), congested=congested)
    engine = RoutingEngine(autonomous=True)
    now = twin.time * 60

    first = _decide(engine, twin, now, signals)
    moved = {a.person_id for a in first.assignments if a.reason == "congestion"}
    assert moved
    ids = np.array([a.person_id for a in first.assignments])
    twin.apply_assignments(ids, np.array([a.to_gate for a in first.assignments]))

    twin.target[list(moved)] = busiest  # simulate people drifting back before the cooldown expires
    twin.phase[list(moved)] = Phase.QUEUE
    second = _decide(engine, twin, now + COOLDOWN_SECONDS / 2, signals)
    assert not moved & {a.person_id for a in second.assignments if a.reason != "gate_closed"}


def test_operator_plan_redirects_selected_sections() -> None:
    twin = StadiumTwin()
    engine = RoutingEngine()
    engine.set_plan(RoutingPlan(plan_id="p", redirect_sections=(205, 206), redirect_gate=GATE_INDEX["gate_d"]))
    decision = _decide(engine, twin, 0.0)
    planned = [a for a in decision.assignments if a.reason == "operator_plan"]
    assert planned
    assert all(a.person_id % 24 in (4, 5) and a.to_gate == GATE_INDEX["gate_d"] for a in planned)


def test_live_default_only_bypasses_closed_gates_without_approval() -> None:
    twin = StadiumTwin()
    packed = np.arange(400)
    twin.phase[packed] = Phase.QUEUE
    twin.target[packed] = GATE_INDEX["gate_b"]
    signals = GateSignals(queue=twin.queued_per_gate(), density=np.full(8, 5.0), congested=np.ones(8, dtype=bool))
    engine = RoutingEngine()
    for closed in (set(), {"gate_b"}, set(GATE_IDS)):
        twin.set_closed(closed)
        decision = _decide(engine, twin, 120.0, signals)
        if closed == {"gate_b"}:
            assert decision.assignments
            assert all(a.reason == "gate_closed" and a.to_gate != GATE_INDEX["gate_b"] for a in decision.assignments)
        else:
            assert decision.assignments == []
        assert decision.holds == []


def test_approved_plan_redirects_outer_concourse_but_never_outside_people() -> None:
    twin = StadiumTwin()
    ids = np.array([0, 24, 48, 72, 96])
    twin.phase[ids] = [Phase.CONCOURSE, Phase.QUEUE, Phase.GATE_APPROACH, Phase.EXIT, Phase.EXITED]
    twin.target[ids] = GATE_INDEX["gate_b"]
    engine = RoutingEngine()
    engine.set_plan(RoutingPlan(plan_id="approved", redirect_sections=(201,), redirect_gate=GATE_INDEX["gate_c"]))
    decision = _decide(engine, twin, 120.0)
    moves = {a.person_id: a for a in decision.assignments}
    assert all(person in moves for person in ids[:3])
    assert all(person not in moves for person in ids[3:])
    assert all(a.reason == "operator_plan" and a.to_gate == GATE_INDEX["gate_c"] for a in moves.values())


def test_closed_approved_destination_still_escapes_to_nearest_open_exit() -> None:
    twin = StadiumTwin()
    twin.target[:] = GATE_INDEX["gate_b"]
    twin.set_closed({"gate_b", "gate_c"})
    engine = RoutingEngine()
    engine.set_plan(RoutingPlan(plan_id="approved", redirect_sections=(201,), redirect_gate=GATE_INDEX["gate_c"]))
    decision = _decide(engine, twin, 120.0)
    assert len(decision.assignments) == twin.count
    expected = nearest_open_gate(initial_access_angles(np.arange(twin.count)), np.arange(twin.count), twin.closed)
    assert all(a.reason == "gate_closed" and a.to_gate == expected[a.person_id] for a in decision.assignments)


def test_closed_escape_uses_access_passage_inside_and_actual_angle_on_outer_circle() -> None:
    twin = StadiumTwin()
    engine = RoutingEngine()
    twin.set_closed({"gate_b"})
    ids = np.array([0, 24])
    twin.target[ids] = GATE_INDEX["gate_b"]
    twin.phase[ids] = [Phase.AISLE, Phase.CONCOURSE]
    # Same coordinates, but an inside person must first reach their fixed passage.
    twin.x[ids], twin.z[ids] = ring_point(GATE_ANGLES[GATE_INDEX["gate_f"]], 1.12)
    decisions = {a.person_id: a for a in _decide(engine, twin, 0).assignments}
    assert decisions[0].to_gate == nearest_open_gate(initial_access_angles(ids[:1]), ids[:1], twin.closed)[0]
    assert decisions[24].to_gate == GATE_INDEX["gate_f"]


def test_pending_assignment_grace_cannot_delay_escape_from_a_newly_closed_target() -> None:
    twin = StadiumTwin()
    twin.target[:] = GATE_INDEX["gate_b"]
    engine = RoutingEngine()
    twin.set_closed({"gate_b"})
    first = _decide(engine, twin, 0)
    assert first.assignments
    first_target = first.assignments[0].to_gate
    # The first assignment is still unacknowledged when its destination also closes.
    twin.set_closed({"gate_b", GATE_IDS[first_target]})
    second = _decide(engine, twin, 1)
    assert len(second.assignments) == twin.count
    assert all(a.reason == "gate_closed" and not twin.closed[a.to_gate] for a in second.assignments)


def test_reopening_a_gate_does_not_reassign_people_with_an_open_destination() -> None:
    twin = StadiumTwin()
    engine = RoutingEngine()
    twin.set_closed({"gate_b"})
    first = _decide(engine, twin, 0)
    assert first.assignments
    twin.target[[a.person_id for a in first.assignments]] = [a.to_gate for a in first.assignments]
    twin.set_closed(set())
    assert _decide(engine, twin, 1).assignments == []


def test_closed_escape_uses_nearest_distance_not_unapproved_queue_optimization() -> None:
    twin = StadiumTwin()
    twin.phase[0] = Phase.GATE_APPROACH
    twin.target[0] = GATE_INDEX["gate_b"]
    twin.x[0], twin.z[0] = ring_point(GATE_ANGLES[GATE_INDEX["gate_b"]], 1.30)
    twin.set_closed({"gate_b"})
    signals = GateSignals.empty()
    signals.density[GATE_INDEX["gate_a"]] = 100
    signals.congested[GATE_INDEX["gate_a"]] = True
    decisions = {a.person_id: a for a in _decide(RoutingEngine(), twin, 0, signals).assignments}
    # Gate A and C are equidistant; person 0 deterministically chooses A even
    # though optional congestion optimisation would prefer the empty Gate C.
    assert decisions[0].to_gate == GATE_INDEX["gate_a"]
    assert decisions[0].reason == "gate_closed"


def test_reopening_suspended_approved_destination_requires_fresh_approval() -> None:
    twin = StadiumTwin()
    twin.target[:] = GATE_INDEX["gate_b"]
    engine = RoutingEngine()
    approved = RoutingPlan(
        plan_id="approved", redirect_sections=(201,), redirect_gate=GATE_INDEX["gate_c"],
        hold_sections=(201,), hold_until_seconds=200,
    )
    engine.set_plan(approved)
    first = _decide(engine, twin, 120)
    assert first.assignments
    for assignment in first.assignments:
        twin.target[assignment.person_id] = assignment.to_gate

    twin.set_closed({"gate_c"})
    escaped = _decide(engine, twin, 121)
    assert engine.redirect_suspended
    assert escaped.assignments
    assert all(a.reason == "gate_closed" and a.to_gate != GATE_INDEX["gate_c"] for a in escaped.assignments)
    for assignment in escaped.assignments:
        twin.target[assignment.person_id] = assignment.to_gate
    assert escaped.holds == [(201, 200)]

    twin.set_closed(set())
    reopened = _decide(engine, twin, 122)
    assert reopened.assignments == []
    assert reopened.holds == [(201, 200)]
    assert _decide(engine, twin, 200).holds == []
    assert engine.redirect_suspended

    engine.set_plan(approved)
    reapproved = _decide(engine, twin, 201)
    assert reapproved.assignments
    assert all(a.reason == "operator_plan" and a.to_gate == GATE_INDEX["gate_c"] for a in reapproved.assignments)
    assert not engine.redirect_suspended
    assert not twin.closed.any()


def test_all_closed_suspends_redirect_even_without_an_available_escape() -> None:
    twin = StadiumTwin()
    engine = RoutingEngine()
    engine.set_plan(RoutingPlan(plan_id="p", redirect_sections=(201,), redirect_gate=GATE_INDEX["gate_c"]))
    twin.set_closed(set(GATE_IDS))
    assert _decide(engine, twin, 0).assignments == []
    assert engine.redirect_suspended
    twin.set_closed(set())
    assert _decide(engine, twin, 1).assignments == []


def test_runner_latches_destination_closure_between_routing_ticks() -> None:
    twin = StadiumTwin()
    runner = TwinRunner(
        twin, policy="operator", routing_interval_seconds=15,
        plan=RoutingPlan(plan_id="approved", redirect_sections=(201,), redirect_gate=GATE_INDEX["gate_c"]),
        events=[GateEvent(0.05, "gate_c", True), GateEvent(0.10, "gate_c", False)],
    )
    runner.run_until(0.30)
    assert not twin.closed.any()
    assert runner.engine.redirect_suspended
    # The close/reopen happened between T+0 and T+15 routing decisions; the
    # second routing tick must not send the escaped section back to Gate C.
    section = np.arange(twin.count) % 24 == 0
    assert np.all(twin.target[section] != GATE_INDEX["gate_c"])


def test_only_approved_holds_are_returned_and_clearing_plan_releases_them() -> None:
    twin = StadiumTwin()
    engine = RoutingEngine()
    engine.set_plan(RoutingPlan(plan_id="hold", hold_sections=(201,), hold_until_seconds=200))
    twin.set_closed(set(GATE_IDS))
    assert _decide(engine, twin, 120.0).holds == [(201, 200)]
    assert _decide(engine, twin, 200.0).holds == []
    engine.set_plan(None)
    assert _decide(engine, twin, 120.0).holds == []


def test_twin_executes_assignment_deltas() -> None:
    twin = StadiumTwin()
    TwinRunner(twin).run_until(3.0)
    queued = np.where(twin.phase == Phase.QUEUE)[0][:5]
    new_gate = (twin.target[queued] + 1) % 8
    applied = twin.apply_assignments(queued, new_gate)
    assert applied == len(queued)
    assert np.all(twin.phase[queued] == Phase.RETURN_TO_BASE)
    assert np.array_equal(twin.target[queued], new_gate)
