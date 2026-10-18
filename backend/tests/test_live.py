from concurrent.futures import ThreadPoolExecutor
from threading import Event

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.congestion import TelemetryBatch
from app.live.registry import EVALUATION_REVIEW_SECONDS, LiveRunRegistry
from app.live.zones import ZoneAggregator
from app.main import app, live_runs
from app.response.rollouts import CounterfactualEvaluator
from app.twin.field import StadiumTwin
from app.twin.layout import GATE_INDEX, ZONES, ring_point
from app.twin.runner import TwinRunner, closure_events

FAST_EVALUATOR = CounterfactualEvaluator(seeds=(1,), compliance_levels=(1.0,), horizon_minutes=6)


def _stream(registry: LiveRunRegistry, run_id: str, closures, minutes: list[float]):
    twin = StadiumTwin()
    runner = TwinRunner(twin, policy="operator", events=closure_events(closures))
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
    assert all(a.reason == "gate_closed" and a.to_gate != "gate_b" for a in result.routing.assignments)
    assert result.routing.holds == []
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
    for candidate in evaluation.candidates:
        if not candidate.feasible:
            with pytest.raises(ValueError):
                registry.approve("live-2", candidate.intervention_id, evaluation.evaluation_id)
    status = registry.approve("live-2", option.intervention_id, evaluation.evaluation_id)
    assert status.intervention_id == option.intervention_id
    assert registry.get("live-2").engine.plan is not None


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
    assert assignments
    assert all(a["reason"] == "gate_closed" and a["to_gate"] != "gate_d" for a in assignments)
    assert result["routing"]["holds"] == []
    assert result["routing"]["active_plan_id"] is None
    assert len(result["zones"]) == 12

    response = client.get("/api/runs/ws-routing/export")
    assert response.status_code == 200
    assert response.json()["people_redirected"] >= len(assignments)
    assert client.post("/api/runs/missing/interventions/evaluate").status_code == 404


def _review_run(run_id: str = "review"):
    evaluator = CounterfactualEvaluator(seeds=(1,), compliance_levels=(1.0,), horizon_minutes=0.02)
    registry = LiveRunRegistry(use_gbm=False, evaluator=evaluator)
    twin = StadiumTwin()
    registry.process(TelemetryBatch.model_validate(twin.telemetry_batch(run_id, 0)))
    return registry, twin


def test_exact_displayed_evaluation_remains_approvable_after_background_refresh() -> None:
    registry, twin = _review_run()
    first = registry.evaluate("review")
    second = registry.evaluate("review")
    assert first.evaluation_id != second.evaluation_id
    option = next(c for c in first.candidates if c.feasible and c.plan.redirect_gate)
    status = registry.approve("review", option.intervention_id, first.evaluation_id)
    assert status.actions == option.actions
    assert registry.get("review").state.closed == frozenset()
    result = registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 1)))
    assert result.routing is not None
    assert result.routing.assignments
    assert all(a.reason == "operator_plan" and a.to_gate == option.plan.redirect_gate for a in result.routing.assignments)
    with pytest.raises(ValueError, match="expired"):
        registry.approve("review", "do_nothing", second.evaluation_id)


def test_keep_current_routes_stops_plan_and_holds_without_changing_gates() -> None:
    registry, twin = _review_run()
    first = registry.evaluate("review")
    held = next(c for c in first.candidates if c.feasible and c.plan.hold_sections)
    registry.approve("review", held.intervention_id, first.evaluation_id)
    second = registry.evaluate("review")
    baseline = next(c for c in second.candidates if c.intervention_id == "do_nothing")
    assert baseline.name == "Keep current routes"
    registry.approve("review", baseline.intervention_id, second.evaluation_id)
    assert registry.get("review").engine.plan is None
    result = registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 1)))
    assert result.routing is not None
    assert result.routing.assignments == []
    assert result.routing.holds == []
    assert result.routing.active_plan_id is None
    assert registry.get("review").state.closed == frozenset()


def test_live_routing_reports_redirect_suspended_after_destination_reopens() -> None:
    registry, twin = _review_run()
    evaluated = registry.evaluate("review")
    option = next(c for c in evaluated.candidates if c.feasible and c.plan.redirect_gate)
    registry.approve("review", option.intervention_id, evaluated.evaluation_id)
    first = registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 1)))
    assert first.routing is not None and not first.routing.redirect_suspended
    for assignment in first.routing.assignments:
        twin.target[assignment.person_id] = GATE_INDEX[assignment.to_gate]

    twin.set_closed({option.plan.redirect_gate})
    closed = registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 2)))
    assert closed.routing is not None and closed.routing.redirect_suspended
    assert closed.routing.assignments
    assert all(a.reason == "gate_closed" for a in closed.routing.assignments)
    for assignment in closed.routing.assignments:
        twin.target[assignment.person_id] = GATE_INDEX[assignment.to_gate]

    twin.set_closed(set())
    reopened = registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 3)))
    assert reopened.routing is not None and reopened.routing.redirect_suspended
    assert reopened.routing.assignments == []
    assert reopened.routing.active_plan_id == option.intervention_id
    assert registry.export("review")["redirect_suspended"] is True
    registry.clear_plan("review")
    cleared = registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 4)))
    assert cleared.routing is not None and not cleared.routing.redirect_suspended
    assert cleared.routing.active_plan_id is None


def test_gate_change_invalidates_reviewed_evaluation() -> None:
    registry, twin = _review_run()
    evaluation = registry.evaluate("review")
    twin.set_closed({"gate_a"})
    registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 1)))
    with pytest.raises(ValueError, match="expired"):
        registry.approve("review", "do_nothing", evaluation.evaluation_id)
    assert registry.get("review").engine.plan is None


def test_review_cache_has_bounded_count_and_wall_clock_expiry(monkeypatch) -> None:
    registry, _ = _review_run()
    clock = [10.0]
    monkeypatch.setattr("app.live.registry.monotonic", lambda: clock[0])
    evaluations = [registry.evaluate("review") for _ in range(5)]
    assert len(registry.get("review").reviewable_evaluations) == 4
    with pytest.raises(ValueError, match="expired"):
        registry.approve("review", "do_nothing", evaluations[0].evaluation_id)
    clock[0] += EVALUATION_REVIEW_SECONDS
    with pytest.raises(ValueError, match="expired"):
        registry.approve("review", "do_nothing", evaluations[-1].evaluation_id)


def test_inflight_evaluation_does_not_block_telemetry_or_override_gate_context(monkeypatch) -> None:
    registry, twin = _review_run()
    original_evaluate = registry.evaluator.evaluate
    entered, release = Event(), Event()

    def blocked_evaluate(run_id, state):
        entered.set()
        assert release.wait(timeout=5)
        return original_evaluate(run_id, state)

    monkeypatch.setattr(registry.evaluator, "evaluate", blocked_evaluate)
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(registry.evaluate, "review")
        try:
            assert entered.wait(timeout=5)
            with pytest.raises(ValueError, match="already running"):
                registry.evaluate("review")
            twin.set_closed({"gate_a"})
            registry.process(TelemetryBatch.model_validate(twin.telemetry_batch("review", 1)))
        finally:
            release.set()
        with pytest.raises(ValueError, match="changed during evaluation"):
            future.result(timeout=5)
    assert registry.get("review").evaluation is None


def test_live_approval_endpoint_requires_exact_evaluation_id(monkeypatch) -> None:
    run_id = "approval-api"
    registry, _ = _review_run(run_id)
    evaluation = registry.evaluate(run_id)
    monkeypatch.setattr(live_runs, "approve", registry.approve)
    client = TestClient(app)
    path = f"/api/runs/{run_id}/interventions/do_nothing/approve"
    assert client.post(path).status_code == 422
    assert client.post(path, json={"evaluation_id": "unknown"}).status_code == 400
    assert client.post(path, json={"evaluation_id": evaluation.evaluation_id}).status_code == 200
