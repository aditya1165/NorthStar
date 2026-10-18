import numpy as np

from app.congestion.models import AgentTelemetry, TelemetryBatch
from app.live.registry import LiveRunRegistry
from app.live.zones import ZoneAggregator
from app.twin.layout import ring_point


def test_explicit_queue_state_does_not_classify_slow_circulation_as_waiting() -> None:
    x, z = ring_point(30, 1.12)
    args = (
        0.0,
        np.array([0, 1]),
        np.array([x, x]),
        np.array([z, z]),
        np.array([0.13, 0.0]),
        np.array([1, 1]),
    )
    zones = ZoneAggregator().observe(*args, queued_mask=np.array([False, True]))
    gate = next(zone for zone in zones if zone.zone_id == "gate_b_approach")
    assert gate.people_count == 2
    assert gate.queue_length == 1

    # Callers without explicit phases retain the older speed-based fallback.
    legacy = ZoneAggregator().observe(*args)
    legacy_gate = next(zone for zone in legacy if zone.zone_id == "gate_b_approach")
    assert legacy_gate.queue_length == 2


def test_live_gate_and_zone_metrics_use_the_same_inside_queue_state() -> None:
    agents = [
        AgentTelemetry(
            person_id=person, x=0, z=0, speed_mps=0, target_gate="gate_a",
            phase="waiting", movement_state="waiting",
        )
        for person in range(4000)
    ]
    for person, phase, scale, state in (
        (0, "concourse", 1.12, "moving"),
        (1, "queue", 1.24, "queued"),
        (2, "exit", 1.332, "exiting"),
        (3, "gate_approach", 1.30, "queued"),
    ):
        x, z = ring_point(30, scale)
        agents[person] = agents[person].model_copy(update={
            "x": x, "z": z, "target_gate": "gate_b", "phase": phase,
            "movement_state": state, "speed_mps": 0 if state == "queued" else 0.13,
        })
    telemetry = TelemetryBatch(
        run_id="boundary-queues", sequence=0, simulation_time_seconds=10,
        agents=agents, closed_gates=["gate_b"],
    )
    snapshot = LiveRunRegistry(use_gbm=False).process(telemetry)
    gate = next(gate for gate in snapshot.gates if gate.gate_id == "gate_b")
    zone = next(zone for zone in snapshot.zones if zone.zone_id == "gate_b_approach")
    assert gate.people_count == zone.people_count == 3
    assert gate.queue_length == zone.queue_length == 2
    assert {assignment.person_id for assignment in snapshot.routing.assignments} == {0, 1, 3}
    assert all(assignment.reason == "gate_closed" for assignment in snapshot.routing.assignments)
    assert all(assignment.to_gate != "gate_b" for assignment in snapshot.routing.assignments)
