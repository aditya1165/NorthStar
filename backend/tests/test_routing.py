import numpy as np

from app.routing.engine import COOLDOWN_SECONDS, RoutingEngine, RoutingPlan
from app.twin.field import GateSignals, Phase, StadiumTwin
from app.twin.layout import GATE_IDS, GATE_INDEX
from app.twin.runner import TwinRunner


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
    TwinRunner(twin).run_until(3.0)
    congested = np.zeros(len(GATE_IDS), dtype=bool)
    busiest = int(np.argmax(twin.queued_per_gate()))
    congested[busiest] = True
    signals = GateSignals(queue=twin.queued_per_gate(), density=np.zeros(8), congested=congested)
    engine = RoutingEngine()

    first = _decide(engine, twin, 180.0, signals)
    moved = {a.person_id for a in first.assignments if a.reason == "congestion"}
    assert moved
    ids = np.array([a.person_id for a in first.assignments])
    twin.apply_assignments(ids, np.array([a.to_gate for a in first.assignments]))

    twin.target[list(moved)] = busiest  # simulate people drifting back before the cooldown expires
    second = _decide(engine, twin, 180.0 + COOLDOWN_SECONDS / 2, signals)
    assert not moved & {a.person_id for a in second.assignments if a.reason != "gate_closed"}


def test_operator_plan_redirects_selected_sections() -> None:
    twin = StadiumTwin()
    engine = RoutingEngine()
    engine.set_plan(RoutingPlan(plan_id="p", redirect_sections=(205, 206), redirect_gate=GATE_INDEX["gate_d"]))
    decision = _decide(engine, twin, 0.0)
    planned = [a for a in decision.assignments if a.reason == "operator_plan"]
    assert planned
    assert all(a.person_id % 24 in (4, 5) and a.to_gate == GATE_INDEX["gate_d"] for a in planned)


def test_twin_executes_assignment_deltas() -> None:
    twin = StadiumTwin()
    TwinRunner(twin).run_until(3.0)
    queued = np.where(twin.phase == Phase.QUEUE)[0][:5]
    new_gate = (twin.target[queued] + 1) % 8
    applied = twin.apply_assignments(queued, new_gate)
    assert applied == len(queued)
    assert np.all(twin.phase[queued] == Phase.RETURN_TO_BASE)
    assert np.array_equal(twin.target[queued], new_gate)
