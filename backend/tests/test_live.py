import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.congestion import TelemetryBatch
from app.live.registry import LiveRunRegistry
from app.live.zones import ZoneAggregator
from app.main import app
from app.response.rollouts import CounterfactualEvaluator
from app.twin.field import StadiumTwin
from app.twin.layout import ZONES, ring_point
from app.twin.runner import TwinRunner, closure_events

FAST_EVALUATOR = CounterfactualEvaluator(seeds=(1,), compliance_levels=(1.0,), horizon_minutes=6)


def _stream(registry: LiveRunRegistry, run_id: str, closures, minutes: list[float]):
    twin = StadiumTwin()
    runner = TwinRunner(twin, policy="engine", events=closure_events(closures))
    result = None
    for sequence, minute in enumerate(minutes):
        runner.run_until(minute)
        batch = TelemetryBatch.model_validate(twin.telemetry_batch(run_id, sequence))
        result = registry.process(batch)
    return twin, result


def test_zone_aggregator_counts_inflow_and_outflow() -> None:
    aggregator = ZoneAggregator(population=2)
    zone = ZONES[0]
    gate_angle = {"gate_a_approach": -15.0}[zone.zone_id]
    inside = ring_point(gate_angle, 1.2)
    outside = ring_point(gate_angle + 90, 0.8)
    ids = np.array([0, 1])
    speeds = np.array([1.0, 1.0])
    targets = np.array([0, 0])
    aggregator.observe(0.0, ids, np.array([outside[0]] * 2), np.array([outside[1]] * 2), speeds, targets)
    zones = aggregator.observe(30.0, ids, np.array([inside[0]] * 2), np.array([inside[1]] * 2), speeds, targets)
    first = zones[0]
    assert first.people_count == 2
    assert first.inflow_per_min == pytest.approx(4.0)
    assert first.area_m2 == pytest.approx(zone.area_m2, rel=1e-3)
    zones = aggregator.observe(60.0, np.array([0]), np.array([outside[0]]), np.array([outside[1]]), speeds[:1], targets[:1])
    assert zones[0].people_count == 0
    assert zones[0].outflow_per_min == pytest.approx(2.0)


def test_live_pipeline_returns_routing_zones_and_forecasts() -> None:
    registry = LiveRunRegistry(use_gbm=False, evaluator=FAST_EVALUATOR)
    _, result = _stream(registry, "live-1", [(0.5, "gate_b", None)], [0.5, 1.0, 1.5, 2.0])
    assert result is not None
    assert result.routing is not None
    assert result.zones is not None and len(result.zones) == 12
    assert result.forecasts is not None and len(result.forecasts) == 24
    assert {f.horizon_minutes for f in result.forecasts} == {5, 10}
    assert result.routing.gate_wait_seconds["gate_b"] is None
    assert all(a.to_gate != "gate_b" for a in result.routing.assignments)
    exported = registry.export("live-1")
    assert exported["timeline"] and exported["zone_history"]


def test_evaluate_and_approve_applies_plan_to_routing() -> None:
    registry = LiveRunRegistry(use_gbm=False, evaluator=FAST_EVALUATOR)
    _stream(registry, "live-2", [(0.5, "gate_b", None), (0.6, "gate_c", None)], [0.5, 1.0])
    evaluation = registry.evaluate("live-2")
    ids = [c.intervention_id for c in evaluation.candidates]
    assert ids[0] == "do_nothing"
    assert sum(c.recommended for c in evaluation.candidates) == 1
    assert all(c.feasible for c in evaluation.candidates if c.recommended)
    assert all(c.plan.redirect_gate not in ("gate_b", "gate_c") for c in evaluation.candidates)

    option = next((c for c in evaluation.candidates if c.feasible and c.intervention_id != "do_nothing"), None)
    if option is None:
        pytest.skip("No feasible non-trivial plan for this state")
    status = registry.approve("live-2", option.intervention_id)
    assert status.intervention_id == option.intervention_id
    assert registry.get("live-2").engine.plan is not None
    for candidate in evaluation.candidates:
        if not candidate.feasible:
            with pytest.raises(ValueError):
                registry.approve("live-2", candidate.intervention_id)


def test_websocket_returns_routing_for_twin_telemetry() -> None:
    twin = StadiumTwin()
    runner = TwinRunner(twin, policy="engine")
    runner.run_until(2.0)
    twin.set_closed({"gate_d"})
    payload = twin.telemetry_batch("ws-routing", 0)
    client = TestClient(app)
    with client.websocket_connect("/ws/congestion") as websocket:
        assert websocket.receive_json()["message_type"] == "ready"
        websocket.send_json(payload)
        result = websocket.receive_json()
    assert result["message_type"] == "congestion"
    assignments = result["routing"]["assignments"]
    assert assignments and all(a["to_gate"] != "gate_d" for a in assignments)
    assert {a["reason"] for a in assignments} >= {"gate_closed"}
    assert len(result["zones"]) == 12

    response = client.get("/api/runs/ws-routing/export")
    assert response.status_code == 200
    assert response.json()["people_redirected"] >= len(assignments)
    assert client.post("/api/runs/missing/interventions/evaluate").status_code == 404
