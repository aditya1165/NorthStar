"""Isolated multi-seed counterfactual rollouts for operator interventions.

Every candidate is simulated from the same restored live state in separate twin
copies, across several stochastic seeds and compliance levels. Live state is
never mutated; the operator's approval is what applies a plan.
"""

from collections import Counter
from dataclasses import dataclass

import numpy as np
from pydantic import BaseModel

from app.congestion.config import THRESHOLDS
from app.routing.engine import RoutingPlan
from app.twin.field import Phase
from app.twin.layout import (
    GATE_ANGLES,
    GATE_IDS,
    GATE_INDEX,
    GATE_LABELS,
    SECTION_COUNT,
    angle_delta,
    section_number,
)
from app.twin.restore import LiveState, restore_twin
from app.twin.runner import RunMetrics, TwinRunner

DEFAULT_SEEDS = (1, 2, 3)
DEFAULT_COMPLIANCE = (0.7, 1.0)
HORIZON_MINUTES = 12.0
HOLD_MINUTES = 2.0
MAX_REDIRECT_SECTIONS = 4
MIN_RISK_REDUCTION_PERCENT = 3.0


class PlanSpec(BaseModel):
    redirect_sections: list[int] = []
    redirect_gate: str | None = None
    hold_sections: list[int] = []
    hold_minutes: float = 0.0


class CandidateResult(BaseModel):
    intervention_id: str
    name: str
    summary: str
    actions: list[str]
    feasible: bool
    rejection_reason: str | None = None
    recommended: bool = False
    rollouts: int
    peak_density: float
    peak_density_range: tuple[float, float]
    seconds_above_high: float
    max_queue: float
    max_queue_gate: str
    clearance_minutes: float
    clearance_range: tuple[float, float]
    people_redirected: float
    extra_walk_m_mean: float
    risk_index: float
    risk_reduction_percent: float
    secondary_bottleneck: str | None = None
    operational_complexity: int
    plan: PlanSpec


class InterventionEvaluation(BaseModel):
    run_id: str
    evaluated_at_seconds: float
    hotspot_gate: str
    closed_gates: list[str]
    horizon_minutes: float
    seeds: list[int]
    compliance_levels: list[float]
    candidates: list[CandidateResult]
    recommended_id: str
    rationale: str


@dataclass(frozen=True)
class _Candidate:
    intervention_id: str
    name: str
    summary: str
    actions: list[str]
    complexity: int
    spec: PlanSpec


def risk_index(metrics: RunMetrics) -> float:
    """Dimensionless pressure: density and queue relative to the detector's high thresholds."""
    return metrics.peak_density / THRESHOLDS.high_density + metrics.max_queue / THRESHOLDS.high_queue


def _run(state: LiveState, seed: int, plan: RoutingPlan | None, horizon: float) -> RunMetrics:
    twin = restore_twin(state, rollout_seed=seed)
    runner = TwinRunner(twin, policy="engine", plan=plan)
    end = twin.time + horizon
    while twin.time < end - 1e-6:
        runner.run_until(min(end, twin.time + 1.0))
        if twin.exited_count() == twin.count:
            break
    return runner.finalise()


def to_routing_plan(
    candidate_id: str, spec: PlanSpec, now_seconds: float, compliance: float = 1.0
) -> RoutingPlan | None:
    if not spec.redirect_sections and not spec.hold_sections:
        return None
    return RoutingPlan(
        plan_id=candidate_id,
        redirect_sections=tuple(spec.redirect_sections),
        redirect_gate=GATE_INDEX[spec.redirect_gate] if spec.redirect_gate else None,
        hold_sections=tuple(spec.hold_sections),
        hold_until_seconds=now_seconds + spec.hold_minutes * 60,
        compliance=compliance,
    )


class CounterfactualEvaluator:
    def __init__(
        self,
        seeds: tuple[int, ...] = DEFAULT_SEEDS,
        compliance_levels: tuple[float, ...] = DEFAULT_COMPLIANCE,
        horizon_minutes: float = HORIZON_MINUTES,
    ) -> None:
        self.seeds = seeds
        self.compliance_levels = compliance_levels
        self.horizon = horizon_minutes

    def _candidates(self, state: LiveState, hotspot: int, baseline: RunMetrics) -> list[_Candidate]:
        closed = np.array([g in state.closed for g in GATE_IDS])
        active = state.phase < Phase.EXIT
        sections = state.person_ids % SECTION_COUNT
        heading = active & (state.target == hotspot)
        counts = np.bincount(sections[heading], minlength=SECTION_COUNT)
        ranked = [int(s) for s in np.argsort(-counts, kind="stable") if counts[s] > 0][:MAX_REDIRECT_SECTIONS]
        seated = state.phase == Phase.WAITING
        seated_counts = np.bincount(sections[seated & heading], minlength=SECTION_COUNT)
        holdable = [s for s in ranked if seated_counts[s] > 0]

        neighbours = sorted(
            (g for g in range(len(GATE_IDS)) if g != hotspot and not closed[g]),
            key=lambda g: (abs(float(angle_delta(GATE_ANGLES[hotspot], GATE_ANGLES[g]))), g),
        )[:4]
        alternative = min(
            neighbours,
            key=lambda g: (
                baseline.zone_peaks.get(f"{GATE_IDS[g]}_approach", 0.0)
                + abs(float(angle_delta(GATE_ANGLES[hotspot], GATE_ANGLES[g]))) / 90,
                g,
            ),
            default=None,
        )

        section_labels = [section_number(s) for s in ranked]
        hotspot_label = GATE_LABELS[hotspot]
        candidates = [
            _Candidate(
                "do_nothing",
                "Do nothing",
                "Keep automatic per-person routing only.",
                ["Continue automatic Python routing"],
                1,
                PlanSpec(),
            )
        ]
        if alternative is not None and section_labels:
            alt_label = GATE_LABELS[alternative]
            sections_text = ", ".join(str(s) for s in section_labels)
            candidates.append(
                _Candidate(
                    "redirect_sections",
                    f"Redirect sections {sections_text} to {alt_label}",
                    f"Steward sections {sections_text} away from {hotspot_label} to {alt_label}.",
                    [f"Redirect sections {sections_text} to {alt_label}", "Update concourse signage"],
                    2,
                    PlanSpec(redirect_sections=section_labels, redirect_gate=GATE_IDS[alternative]),
                )
            )
        if holdable:
            held = [section_number(s) for s in holdable]
            held_text = ", ".join(str(s) for s in held)
            candidates.append(
                _Candidate(
                    "meter_release",
                    f"Hold sections {held_text} for {HOLD_MINUTES:.0f} min",
                    f"Meter release of seated sections feeding {hotspot_label}.",
                    [f"Hold sections {held_text} in seats for {HOLD_MINUTES:.0f} min", "PA announcement"],
                    2,
                    PlanSpec(hold_sections=held, hold_minutes=HOLD_MINUTES),
                )
            )
        if alternative is not None and section_labels and holdable:
            held = [section_number(s) for s in holdable]
            candidates.append(
                _Candidate(
                    "redirect_and_meter",
                    f"Redirect to {GATE_LABELS[alternative]} + meter release",
                    f"Combine the section redirect with a {HOLD_MINUTES:.0f}-minute release hold.",
                    [
                        f"Redirect sections {', '.join(str(s) for s in section_labels)} to {GATE_LABELS[alternative]}",
                        f"Hold sections {', '.join(str(s) for s in held)} for {HOLD_MINUTES:.0f} min",
                    ],
                    3,
                    PlanSpec(
                        redirect_sections=section_labels,
                        redirect_gate=GATE_IDS[alternative],
                        hold_sections=held,
                        hold_minutes=HOLD_MINUTES,
                    ),
                )
            )
        return candidates

    def evaluate(self, run_id: str, state: LiveState) -> InterventionEvaluation:
        now = state.time_seconds
        baseline_runs = [_run(state, seed, None, self.horizon) for seed in self.seeds]
        gate_votes = Counter(m.max_queue_gate for m in baseline_runs if m.max_queue_gate)
        if gate_votes:
            hotspot = GATE_INDEX[gate_votes.most_common(1)[0][0]]
        else:
            open_gates = [g for g in range(len(GATE_IDS)) if GATE_IDS[g] not in state.closed]
            hotspot = open_gates[0] if open_gates else 0

        baseline_mean = self._mean(baseline_runs)
        candidates = self._candidates(state, hotspot, baseline_mean)
        base_risk = risk_index(baseline_mean)
        results: list[CandidateResult] = []
        for candidate in candidates:
            if candidate.intervention_id == "do_nothing":
                runs = baseline_runs
            else:
                if candidate.spec.redirect_gate and candidate.spec.redirect_gate in state.closed:
                    continue
                runs = [
                    _run(
                        state,
                        seed,
                        to_routing_plan(candidate.intervention_id, candidate.spec, now, compliance),
                        self.horizon,
                    )
                    for compliance in self.compliance_levels
                    for seed in self.seeds
                ]
            results.append(self._summarise(candidate, runs, baseline_mean, base_risk))

        feasible = [r for r in results if r.feasible and r.intervention_id != "do_nothing"]
        feasible.sort(key=self._score)
        best = feasible[0] if feasible else None
        do_nothing = next(r for r in results if r.intervention_id == "do_nothing")
        if best and best.risk_reduction_percent >= MIN_RISK_REDUCTION_PERCENT and self._score(best) < self._score(do_nothing):
            recommended = best
            rationale = (
                f"{best.name}: projected peak queue {best.max_queue:.0f} vs {do_nothing.max_queue:.0f} "
                f"and clearance {best.clearance_minutes:.1f} vs {do_nothing.clearance_minutes:.1f} min "
                f"across {best.rollouts} rollouts ({best.risk_reduction_percent:.0f}% lower risk index)."
            )
        else:
            recommended = do_nothing
            rejected = [r for r in results if not r.feasible]
            reason = (
                f" {len(rejected)} candidate(s) rejected for secondary bottlenecks." if rejected else ""
            )
            rationale = (
                "No candidate meaningfully beats automatic routing; keep monitoring." + reason
            )
        recommended.recommended = True
        return InterventionEvaluation(
            run_id=run_id,
            evaluated_at_seconds=now,
            hotspot_gate=GATE_IDS[hotspot],
            closed_gates=sorted(state.closed),
            horizon_minutes=self.horizon,
            seeds=list(self.seeds),
            compliance_levels=list(self.compliance_levels),
            candidates=results,
            recommended_id=recommended.intervention_id,
            rationale=rationale,
        )

    @staticmethod
    def _score(result: CandidateResult) -> float:
        return (
            result.risk_index
            + 0.1 * result.clearance_minutes
            + 0.0002 * result.people_redirected * max(result.extra_walk_m_mean, 0) / 10
            + 0.05 * result.operational_complexity
        )

    @staticmethod
    def _mean(runs: list[RunMetrics]) -> RunMetrics:
        mean = RunMetrics()
        mean.peak_density = float(np.mean([m.peak_density for m in runs]))
        mean.max_queue = float(np.mean([m.max_queue for m in runs]))
        mean.seconds_above_high = float(np.mean([m.seconds_above_high for m in runs]))
        mean.projected_clearance_minutes = float(np.mean([m.projected_clearance_minutes for m in runs]))
        mean.zone_peaks = {
            zone: float(np.mean([m.zone_peaks.get(zone, 0.0) for m in runs]))
            for zone in runs[0].zone_peaks
        }
        return mean

    def _summarise(
        self, candidate: _Candidate, runs: list[RunMetrics], baseline: RunMetrics, base_risk: float
    ) -> CandidateResult:
        mean = self._mean(runs)
        risk = risk_index(mean)
        reduction = 0.0 if base_risk <= 0 else max(0.0, (base_risk - risk) / base_risk * 100)
        queue_gate = Counter(m.max_queue_gate for m in runs).most_common(1)[0][0]
        secondary = None
        rejection = None
        target_gate = candidate.spec.redirect_gate
        if target_gate:
            zone = f"{target_gate}_approach"
            if mean.zone_peaks.get(zone, 0.0) > max(baseline.peak_density, THRESHOLDS.high_density * 0.75) or (
                queue_gate == target_gate and mean.max_queue > baseline.max_queue
            ):
                secondary = target_gate
                rejection = f"Creates a secondary bottleneck at {GATE_LABELS[GATE_INDEX[target_gate]]}"
        clearance = [m.projected_clearance_minutes for m in runs]
        peaks = [m.peak_density for m in runs]
        return CandidateResult(
            intervention_id=candidate.intervention_id,
            name=candidate.name,
            summary=candidate.summary,
            actions=candidate.actions,
            feasible=rejection is None,
            rejection_reason=rejection,
            rollouts=len(runs),
            peak_density=round(mean.peak_density, 2),
            peak_density_range=(round(min(peaks), 2), round(max(peaks), 2)),
            seconds_above_high=round(mean.seconds_above_high, 1),
            max_queue=round(mean.max_queue, 1),
            max_queue_gate=queue_gate,
            clearance_minutes=round(mean.projected_clearance_minutes, 2),
            clearance_range=(round(min(clearance), 2), round(max(clearance), 2)),
            people_redirected=round(float(np.mean([m.people_redirected for m in runs])), 1),
            extra_walk_m_mean=round(float(np.mean([m.mean_extra_walk_m for m in runs])), 1),
            risk_index=round(risk, 3),
            risk_reduction_percent=round(reduction, 1),
            secondary_bottleneck=secondary,
            operational_complexity=candidate.complexity,
            plan=candidate.spec,
        )
