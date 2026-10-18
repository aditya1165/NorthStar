"""Python-owned pedestrian routing.

The engine converts live person telemetry and gate state into *assignment
deltas*: closed-door escape is automatic, while congestion optimisation requires
an operator-approved plan in live runs. The physical twins also enforce the
same nearest-open escape rule immediately, without waiting for network traffic.
"""

from dataclasses import dataclass, field

import numpy as np

from app.twin.field import GateSignals, Phase
from app.twin.layout import (
    CONCOURSE_SCALE,
    GATE_ANGLES,
    GATE_CAPACITY,
    GATE_IDS,
    MEAN_RADIUS,
    METERS_PER_SCENE_UNIT,
    SECTION_COUNT,
    concourse_path_meters,
    initial_access_angles,
    nearest_open_gate,
    ring_coords,
    section_number,
)

WALK_SPEED_MPS = 0.13
SWITCH_PENALTY_SECONDS = 10.0
CONGESTION_PENALTY_SECONDS = 20.0
DENSITY_PENALTY_SECONDS = 4.0
MIN_BENEFIT_SECONDS = 20.0
LONG_WAIT_SECONDS = 120.0
COOLDOWN_SECONDS = 30.0
PENDING_GRACE_SECONDS = 20.0
MAX_OPTIONAL_PER_TICK = 120

ELIGIBLE = (
    Phase.WAITING,
    Phase.ROW,
    Phase.AISLE,
    Phase.BASE_RING,
    Phase.GATE_CORRIDOR,
    Phase.QUEUE,
    Phase.RETURN_TO_CONCOURSE,
    Phase.CONCOURSE,
    Phase.GATE_APPROACH,
)
ON_CONCOURSE = (Phase.CONCOURSE, Phase.QUEUE, Phase.RETURN_TO_CONCOURSE, Phase.GATE_APPROACH)
APPROACHING = (Phase.BASE_RING, Phase.GATE_CORRIDOR, Phase.RETURN_TO_CONCOURSE, Phase.CONCOURSE)


@dataclass(frozen=True)
class RoutingPlan:
    """Explicitly approved routing actions; gate controls are never modified.

    Closing the redirect destination suspends that redirect until another
    explicit approval. Release holds retain their original deadline, or end
    when the operator clears/replaces the plan.
    """

    plan_id: str
    redirect_sections: tuple[int, ...] = ()
    redirect_gate: int | None = None
    hold_sections: tuple[int, ...] = ()
    hold_until_seconds: float = 0.0
    compliance: float = 1.0


@dataclass(frozen=True)
class Assignment:
    person_id: int
    from_gate: int
    to_gate: int
    reason: str
    estimated_benefit_seconds: float


@dataclass
class RoutingDecision:
    assignments: list[Assignment]
    gate_wait_seconds: np.ndarray
    holds: list[tuple[int, float]] = field(default_factory=list)


def compliant(person_ids: np.ndarray, compliance: float) -> np.ndarray:
    """Stable per-person compliance draw so repeated ticks pick the same people."""
    if compliance >= 1:
        return np.ones(person_ids.shape, dtype=bool)
    draw = ((person_ids.astype(np.int64) * 2654435761) % 4294967296) / 4294967296
    return draw < compliance


class RoutingEngine:
    def __init__(self, *, autonomous: bool = False) -> None:
        # Congestion optimisation is offline-only unless approved. Closed-door
        # escape is a movement safety rule in every policy, including live runs.
        self.autonomous = autonomous
        self.plan: RoutingPlan | None = None
        self.redirect_suspended = False
        self.reset()

    def reset(self) -> None:
        self._last_assigned: dict[int, float] = {}
        self._pending: dict[int, tuple[int, float]] = {}
        self.redirected: set[int] = set()

    def set_plan(self, plan: RoutingPlan | None) -> None:
        self.plan = plan
        self.redirect_suspended = False
        self._pending.clear()

    def observe_gates(self, closed: np.ndarray) -> None:
        """Latch a destination closure even between periodic routing decisions."""
        plan = self.plan
        if (
            plan and plan.redirect_gate is not None and closed[plan.redirect_gate]
            and not self.redirect_suspended
        ):
            self.redirect_suspended = True
            # Never revive an unacknowledged redirect after its door reopens.
            self._pending = {
                person: pending for person, pending in self._pending.items()
                if pending[0] != plan.redirect_gate
            }

    def decide(
        self,
        time_seconds: float,
        person_ids: np.ndarray,
        x: np.ndarray,
        z: np.ndarray,
        target: np.ndarray,
        phase: np.ndarray,
        signals: GateSignals,
        closed: np.ndarray,
        capacity: np.ndarray | None = None,
    ) -> RoutingDecision:
        capacity = GATE_CAPACITY if capacity is None else capacity
        n_gates = len(GATE_IDS)
        plan = self.plan
        self.observe_gates(closed)
        target = target.astype(np.int64).copy()
        for k, person in enumerate(person_ids.tolist()):
            pending = self._pending.get(person)
            if (
                pending and not closed[pending[0]] and not closed[target[k]]
                and target[k] != pending[0] and time_seconds - pending[1] < PENDING_GRACE_SECONDS
            ):
                target[k] = pending[0]

        eligible = np.isin(phase, ELIGIBLE)
        concourse = np.isin(phase, ON_CONCOURSE)
        queued = np.bincount(
            target[np.isin(phase, (Phase.QUEUE, Phase.GATE_APPROACH))], minlength=n_gates
        ).astype(float)
        approaching = np.bincount(
            target[np.isin(phase, APPROACHING)], minlength=n_gates
        ).astype(float)
        open_capacity = np.where(closed, np.nan, capacity)

        def wait_seconds() -> np.ndarray:
            with np.errstate(invalid="ignore"):
                wait = (queued + 0.5 * approaching) / open_capacity * 60
            return np.where(closed, np.inf, wait)

        angle, scale = ring_coords(x, z)
        climb = np.maximum(0.0, scale - CONCOURSE_SCALE) * MEAN_RADIUS * METERS_PER_SCENE_UNIT
        leaving_corridor = np.isin(phase, (Phase.QUEUE, Phase.GATE_APPROACH)) | (
            (phase == Phase.CONCOURSE) & (scale > CONCOURSE_SCALE + 1e-4)
        )
        static_penalty = signals.density * DENSITY_PENALTY_SECONDS + np.where(
            signals.congested, CONGESTION_PENALTY_SECONDS, 0.0
        )

        def costs_for(k: np.ndarray, wait: np.ndarray) -> np.ndarray:
            walk = concourse_path_meters(angle[k][:, None], GATE_ANGLES[None, :]) / WALK_SPEED_MPS
            switch = np.where(
                np.arange(n_gates)[None, :] != target[k][:, None],
                SWITCH_PENALTY_SECONDS + np.where(leaving_corridor[k], 2 * climb[k], 0.0)[:, None]
                / WALK_SPEED_MPS,
                0.0,
            )
            cost = walk + switch + wait[None, :] + static_penalty[None, :]
            cost[:, closed] = np.inf
            return cost

        assignments: list[Assignment] = []

        def assign(k: int, gate: int, reason: str, benefit: float) -> None:
            person = int(person_ids[k])
            old = int(target[k])
            assignments.append(
                Assignment(person, old, gate, reason, round(float(benefit), 1))
            )
            if phase[k] in (Phase.QUEUE, Phase.GATE_APPROACH):
                queued[old] = max(0.0, queued[old] - 1)
                approaching[gate] += 1
            elif phase[k] in APPROACHING:
                approaching[old] = max(0.0, approaching[old] - 1)
                approaching[gate] += 1
            target[k] = gate
            self._pending[person] = (gate, time_seconds)
            self._last_assigned[person] = time_seconds
            self.redirected.add(person)

        holds: list[tuple[int, float]] = []
        if plan and plan.hold_sections and time_seconds < plan.hold_until_seconds:
            holds = [(section, plan.hold_until_seconds) for section in plan.hold_sections]
        if closed.all():
            return RoutingDecision([], wait_seconds(), holds)

        # Mandatory closed-door escape uses only shortest circular distance,
        # never queue forecasts or an optional intervention's congestion score.
        escape_angle = np.where(
            phase <= Phase.GATE_CORRIDOR, initial_access_angles(person_ids), angle
        )
        escaping = eligible & closed[target]
        mandatory = np.where(escaping)[0]
        alternatives = nearest_open_gate(escape_angle[mandatory], person_ids[mandatory], closed)
        for k, gate in zip(mandatory.tolist(), alternatives.tolist(), strict=True):
            if gate >= 0:
                assign(k, gate, "gate_closed", 0.0)

        planned = np.zeros(person_ids.shape, dtype=bool)
        if plan and plan.redirect_gate is not None and not self.redirect_suspended:
            sections = np.array([s - section_number(0) for s in plan.redirect_sections])
            in_plan = (
                eligible & ~escaping
                & np.isin(person_ids % SECTION_COUNT, sections)
                & compliant(person_ids, plan.compliance)
            )
            planned = in_plan
            for k in np.where(in_plan & (target != plan.redirect_gate))[0].tolist():
                assign(k, plan.redirect_gate, "operator_plan", 0.0)

        if not self.autonomous:
            # Crowding alone never authorises a route change. Closed gates have
            # already received nearest-open escape assignments above.
            return RoutingDecision(assignments, wait_seconds(), holds)

        wait = wait_seconds()
        cooled = np.array(
            [time_seconds - self._last_assigned.get(int(p), -1e9) >= COOLDOWN_SECONDS for p in person_ids],
            dtype=bool,
        )
        stressed = signals.congested | (wait > LONG_WAIT_SECONDS)
        optional = np.where(eligible & concourse & ~planned & ~closed[target] & stressed[target] & cooled)[0]
        if optional.size:
            cost = costs_for(optional, wait)
            current = cost[np.arange(optional.size), target[optional]]
            benefit = current - cost.min(axis=1)
            order = np.argsort(-benefit, kind="stable")
            ranked = optional[order][benefit[order] >= MIN_BENEFIT_SECONDS][:MAX_OPTIONAL_PER_TICK]
            for k in ranked.tolist():
                cost_k = costs_for(np.array([k]), wait_seconds())[0]
                best = int(np.argmin(cost_k))
                gain = cost_k[target[k]] - cost_k[best]
                if best != target[k] and gain >= MIN_BENEFIT_SECONDS:
                    reason = "congestion" if signals.congested[target[k]] else "load_balance"
                    assign(k, best, reason, gain)

        return RoutingDecision(assignments, wait_seconds(), holds)
