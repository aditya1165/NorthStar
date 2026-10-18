from fastapi.testclient import TestClient

from app.congestion import CongestionDetector, TelemetryBatch
from app.congestion.models import ExitedAgentTelemetry
from app.main import app
from app.twin.layout import ring_point


def agents_with_gate_b_queue(queue_size: int) -> list[dict[str, object]]:
    agents: list[dict[str, object]] = []
    for person_id in range(4_000):
        queued = person_id < queue_size
        agents.append(
            {
                "person_id": person_id,
                "x": 12.4 if queued else 0.0,
                "z": 5.4 if queued else 0.0,
                "speed_mps": 0.1 if queued else 1.2,
                "target_gate": "gate_b" if queued else "gate_a",
                "movement_state": "queued" if queued else "moving",
            }
        )
    return agents


def batch(sequence: int, at: float, queue_size: int, run_id: str = "run-1") -> TelemetryBatch:
    return TelemetryBatch.model_validate(
        {
            "run_id": run_id,
            "sequence": sequence,
            "simulation_time_seconds": at,
            "population": 4_000,
            "agents": agents_with_gate_b_queue(queue_size),
            "exited_agents": [],
        }
    )


def gate_b(snapshot):
    return next(gate for gate in snapshot.gates if gate.gate_id == "gate_b")


def test_detects_persistent_gate_b_congestion() -> None:
    detector = CongestionDetector()

    initial = gate_b(detector.process(batch(0, 0, 100)))
    detected = gate_b(detector.process(batch(1, 6, 100)))

    assert initial.congested is False
    assert detected.congested is True
    assert detected.level == "critical"
    assert detected.queue_length == 100
    assert detected.detected_at_seconds == 5


def test_clears_only_after_recovery_persists() -> None:
    detector = CongestionDetector()
    detector.process(batch(0, 0, 100))
    detector.process(batch(1, 6, 100))

    recovering = gate_b(detector.process(batch(2, 8, 0)))
    cleared = gate_b(detector.process(batch(3, 19, 0)))

    assert recovering.congested is True
    assert cleared.congested is False
    assert cleared.level == "normal"


def test_new_run_resets_detection_state() -> None:
    detector = CongestionDetector()
    detector.process(batch(0, 0, 100))
    detector.process(batch(1, 6, 100))

    fresh = gate_b(detector.process(batch(0, 0, 0, run_id="run-2")))

    assert fresh.congested is False
    assert fresh.detected_at_seconds is None


def test_congestion_websocket_contract() -> None:
    client = TestClient(app)
    with client.websocket_connect("/ws/congestion") as websocket:
        ready = websocket.receive_json()
        assert ready["message_type"] == "ready"
        assert ready["population"] == 4_000

        websocket.send_json(batch(0, 0, 0).model_dump(mode="json"))
        result = websocket.receive_json()

    assert result["message_type"] == "congestion"
    assert result["run_id"] == "run-1"
    assert len(result["gates"]) == 8


def test_gate_metrics_distinguish_circulation_queue_and_outside_people() -> None:
    detector = CongestionDetector()
    current = batch(0, 0, 0)
    for person, phase, scale, state in (
        (0, "concourse", 1.12, "moving"),
        (1, "gate_corridor", 0.8, "moving"),
        (2, "queue", 1.24, "queued"),
        (3, "gate_approach", 1.30, "queued"),
        (4, "exit", 1.332, "exiting"),
    ):
        x, z = ring_point(30, scale)
        current.agents[person] = current.agents[person].model_copy(
            update={
                "x": x, "z": z, "target_gate": "gate_b", "phase": phase,
                "movement_state": state, "speed_mps": 0.0 if state == "queued" else 0.13,
            }
        )
    measured = gate_b(detector.process(current))
    # The lower section passage is not an exit, and an outside pedestrian does
    # not contribute to the boundary's holding area. Slow walking is not a queue.
    assert measured.people_count == 3
    assert measured.queue_length == 2
    assert measured.throughput_per_min == 1


def test_boundary_crossing_is_counted_once_not_again_after_closed_gate() -> None:
    detector = CongestionDetector()
    current = batch(0, 0, 0)
    x, z = ring_point(30, 1.30)
    current.agents[0] = current.agents[0].model_copy(
        update={"x": x, "z": z, "target_gate": "gate_b", "phase": "gate_approach"}
    )
    assert gate_b(detector.process(current)).throughput_per_min == 0

    current = current.model_copy(deep=True, update={"sequence": 1, "simulation_time_seconds": 10})
    current.agents[0] = current.agents[0].model_copy(
        update={"phase": "exit", "movement_state": "exiting"}
    )
    assert gate_b(detector.process(current)).throughput_per_min == 1

    current = current.model_copy(deep=True, update={
        "sequence": 2, "simulation_time_seconds": 20, "closed_gates": ["gate_b"],
    })
    assert gate_b(detector.process(current)).throughput_per_min == 1

    # This person completes their already-outside walk after the crossing has
    # aged out of the throughput window. Removal is not another gate crossing.
    current = current.model_copy(deep=True, update={
        "sequence": 3, "simulation_time_seconds": 71,
        "agents": current.agents[1:],
        "exited_agents": [ExitedAgentTelemetry(
            person_id=0, target_gate="gate_b", exited_at_seconds=71,
        )],
    })
    assert gate_b(detector.process(current)).throughput_per_min == 0


def test_legacy_completed_exit_records_still_count_once() -> None:
    detector = CongestionDetector()
    current = batch(0, 0, 0)
    detector.process(current)
    completed = current.model_copy(deep=True, update={
        "sequence": 1, "simulation_time_seconds": 20,
        "agents": current.agents[1:],
        "exited_agents": [ExitedAgentTelemetry(
            person_id=0, target_gate="gate_b", exited_at_seconds=20,
        )],
    })
    assert gate_b(detector.process(completed)).throughput_per_min == 1
    repeated = completed.model_copy(update={"sequence": 2, "simulation_time_seconds": 30})
    assert gate_b(detector.process(repeated)).throughput_per_min == 1
