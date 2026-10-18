"""Live run registry: one closed-loop session per telemetry ``run_id``.

Each WebSocket batch flows through detection -> zone aggregation -> routing ->
forecasting. The registry keeps the latest state per run so REST endpoints can
evaluate interventions, apply an approved plan, and export the run.
"""

import threading
from collections import OrderedDict, deque
from dataclasses import dataclass, field

import numpy as np
from pydantic import BaseModel

from app.congestion import CongestionDetector, TelemetryBatch
from app.congestion.models import (
    CongestionSnapshot,
    LiveZoneState,
    RouteAssignment,
    RoutingUpdate,
    SectionHold,
)
from app.live.forecast import LiveForecaster
from app.live.zones import ZoneAggregator
from app.response.rollouts import CounterfactualEvaluator, InterventionEvaluation, to_routing_plan
from app.routing.engine import RoutingEngine
from app.twin.field import GateSignals
from app.twin.layout import GATE_IDS, POPULATION, ZONES
from app.twin.restore import LiveState

MAX_RUNS = 16
ZONE_GATE = {zone.zone_id: zone.gate_id for zone in ZONES}
ZONE_KIND = {zone.zone_id: zone.kind for zone in ZONES}


class PlanStatus(BaseModel):
    run_id: str
    intervention_id: str
    name: str
    approved_at_seconds: float
    actions: list[str]


@dataclass
class LiveRun:
    run_id: str
    detector: CongestionDetector = field(default_factory=CongestionDetector)
    zones: ZoneAggregator = field(default_factory=ZoneAggregator)
    engine: RoutingEngine = field(default_factory=RoutingEngine)
    state: LiveState | None = None
    evaluation: InterventionEvaluation | None = None
    plan: PlanStatus | None = None
    timeline: deque = field(default_factory=lambda: deque(maxlen=720))
    assignment_log: deque = field(default_factory=lambda: deque(maxlen=5000))


class LiveRunRegistry:
    def __init__(self, use_gbm: bool = True, evaluator: CounterfactualEvaluator | None = None) -> None:
        self._runs: OrderedDict[str, LiveRun] = OrderedDict()
        self._lock = threading.Lock()
        self.forecaster = LiveForecaster(use_gbm=use_gbm)
        self.evaluator = evaluator or CounterfactualEvaluator()

    def _run(self, run_id: str) -> LiveRun:
        run = self._runs.get(run_id)
        if run is None:
            run = LiveRun(run_id=run_id)
            self._runs[run_id] = run
            while len(self._runs) > MAX_RUNS:
                self._runs.popitem(last=False)
        self._runs.move_to_end(run_id)
        return run

    def get(self, run_id: str) -> LiveRun:
        with self._lock:
            run = self._runs.get(run_id)
        if run is None:
            raise KeyError(run_id)
        return run

    def run_ids(self) -> list[str]:
        with self._lock:
            return list(self._runs)

    def process(self, batch: TelemetryBatch) -> CongestionSnapshot:
        with self._lock:
            run = self._run(batch.run_id)
        congestion = run.detector.process(batch)
        state = LiveState.from_batch(batch)
        closed = np.array([gate in state.closed for gate in GATE_IDS], dtype=bool)
        now = batch.simulation_time_seconds

        zone_states = run.zones.observe(
            now, state.person_ids, state.x, state.z, state.speed_mps, state.target, set(state.closed)
        )
        by_gate = {gate.gate_id: gate for gate in congestion.gates}
        signals = GateSignals(
            queue=np.array([by_gate[g].queue_length if g in by_gate else 0 for g in GATE_IDS], dtype=float),
            density=np.array([by_gate[g].density_per_m2 if g in by_gate else 0.0 for g in GATE_IDS]),
            congested=np.array([bool(by_gate[g].congested) if g in by_gate else False for g in GATE_IDS]),
        )
        decision = run.engine.decide(
            now, state.person_ids, state.x, state.z, state.target, state.phase, signals, closed
        )
        exited_fraction = state.exited_ids.size / POPULATION
        forecasts = self.forecaster.forecast(
            run.zones, zone_states, now, exited_fraction, int(closed.sum())
        )

        assignments = [
            RouteAssignment(
                person_id=a.person_id,
                from_gate=GATE_IDS[a.from_gate],
                to_gate=GATE_IDS[a.to_gate],
                reason=a.reason,
                estimated_benefit_seconds=a.estimated_benefit_seconds,
            )
            for a in decision.assignments
        ]
        with self._lock:
            run.state = state
            for a in assignments:
                run.assignment_log.append((now, a.person_id, a.from_gate, a.to_gate, a.reason))
            peak = max(zone_states, key=lambda z: z.density_estimate)
            run.timeline.append(
                {
                    "time_seconds": now,
                    "active": int(state.person_ids.size),
                    "exited": int(state.exited_ids.size),
                    "closed_gates": sorted(state.closed),
                    "peak_zone": peak.zone_id,
                    "peak_density": peak.density_estimate,
                    "congested_gates": [g.gate_id for g in congestion.gates if g.congested],
                    "assignments": len(assignments),
                    "plan": run.plan.intervention_id if run.plan else None,
                }
            )

        congestion.routing = RoutingUpdate(
            assignments=assignments,
            holds=[SectionHold(section=s, until_seconds=u) for s, u in decision.holds],
            gate_wait_seconds={
                gate: (None if not np.isfinite(wait) else round(float(wait), 1))
                for gate, wait in zip(GATE_IDS, decision.gate_wait_seconds, strict=True)
            },
            redirected_total=len(run.engine.redirected),
            active_plan_id=run.plan.intervention_id if run.plan else None,
        )
        congestion.zones = [
            LiveZoneState(
                zone_id=z.zone_id,
                name=z.name,
                kind=ZONE_KIND[z.zone_id],
                gate_id=ZONE_GATE[z.zone_id],
                people_count=z.people_count,
                density_per_m2=z.density_estimate,
                inflow_per_min=z.inflow_per_min,
                outflow_per_min=z.outflow_per_min,
                mean_speed_mps=z.mean_speed_mps,
                queue_length=z.queue_length,
                level=z.risk_level,
                status=z.status,
            )
            for z in zone_states
        ]
        congestion.forecasts = forecasts
        return congestion

    def evaluate(self, run_id: str) -> InterventionEvaluation:
        run = self.get(run_id)
        with self._lock:
            state = run.state
        if state is None:
            raise ValueError("No telemetry received for this run yet")
        evaluation = self.evaluator.evaluate(run_id, state)
        with self._lock:
            run.evaluation = evaluation
        return evaluation

    def approve(self, run_id: str, intervention_id: str) -> PlanStatus:
        run = self.get(run_id)
        with self._lock:
            evaluation = run.evaluation
            state = run.state
        if evaluation is None or state is None:
            raise ValueError("Evaluate interventions before approving one")
        candidate = next((c for c in evaluation.candidates if c.intervention_id == intervention_id), None)
        if candidate is None:
            raise ValueError(f"Unknown intervention {intervention_id}")
        if not candidate.feasible:
            raise ValueError(candidate.rejection_reason or "Intervention is not feasible")
        if candidate.plan.redirect_gate and candidate.plan.redirect_gate in state.closed:
            raise ValueError("Redirect gate is closed")
        now = state.time_seconds
        plan = to_routing_plan(intervention_id, candidate.plan, now)
        status = PlanStatus(
            run_id=run_id,
            intervention_id=intervention_id,
            name=candidate.name,
            approved_at_seconds=now,
            actions=candidate.actions,
        )
        with self._lock:
            run.engine.set_plan(plan)
            run.plan = status if plan else None
        return status

    def clear_plan(self, run_id: str) -> None:
        run = self.get(run_id)
        with self._lock:
            run.engine.set_plan(None)
            run.plan = None

    def export(self, run_id: str) -> dict:
        run = self.get(run_id)
        with self._lock:
            history = [
                {
                    "time_seconds": sample.time_seconds,
                    "zones": [zone.model_dump(mode="json") for zone in sample.zones],
                }
                for sample in run.zones.history
            ]
            reasons: dict[str, int] = {}
            for _, _, _, _, reason in run.assignment_log:
                reasons[reason] = reasons.get(reason, 0) + 1
            return {
                "run_id": run_id,
                "people_redirected": len(run.engine.redirected),
                "assignments_by_reason": reasons,
                "assignments": [
                    {"time_seconds": t, "person_id": p, "from_gate": f, "to_gate": g, "reason": r}
                    for t, p, f, g, r in run.assignment_log
                ],
                "timeline": list(run.timeline),
                "zone_history": history,
                "evaluation": run.evaluation.model_dump(mode="json") if run.evaluation else None,
                "active_plan": run.plan.model_dump(mode="json") if run.plan else None,
            }
