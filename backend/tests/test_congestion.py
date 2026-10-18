from fastapi.testclient import TestClient

from app.congestion import CongestionDetector, TelemetryBatch
from app.main import app


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
