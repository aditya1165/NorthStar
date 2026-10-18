"""Closed-loop twin runs: twin + zones + gate monitor + routing + metrics."""

from collections.abc import Callable
from dataclasses import asdict, dataclass, field

import numpy as np

from app.live.zones import HIGH_DENSITY, ZoneAggregator
from app.routing.engine import RoutingEngine, RoutingPlan
from app.shared.models import ZoneTelemetry
from app.twin.field import MAX_STEP, Phase, StadiumTwin
from app.twin.layout import GATE_IDS, GATE_INDEX
from app.twin.monitor import GateMonitor

POLICIES = ("engine", "local", "naive")


@dataclass(frozen=True)
class GateEvent:
    minute: float
    gate_id: str
    closed: bool


@dataclass
class RunMetrics:
    peak_density: float = 0.0
    peak_zone: str = ""
    seconds_above_high: float = 0.0
    max_queue: int = 0
    max_queue_gate: str = ""
    clearance_minutes: float | None = None
    projected_clearance_minutes: float = 0.0
    mean_egress_minutes: float = 0.0
    p95_egress_minutes: float = 0.0
    exited: int = 0
    not_exited: int = 0
    people_redirected: int = 0
    mean_extra_walk_m: float = 0.0
    zone_peaks: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


class TwinRunner:
    def __init__(
        self,
        twin: StadiumTwin,
        policy: str = "engine",
        routing_interval_seconds: float = 15.0,
        measure_interval_seconds: float = 5.0,
        plan: RoutingPlan | None = None,
        events: list[GateEvent] | None = None,
        step_minutes: float = MAX_STEP,
        on_measure: Callable[[float, list[ZoneTelemetry]], None] | None = None,
    ) -> None:
        if policy not in POLICIES:
            raise ValueError(f"Unknown routing policy {policy!r}")
        self.twin = twin
        self.policy = policy
        self.routing_interval = routing_interval_seconds
        self.measure_interval = measure_interval_seconds
        self.step_minutes = step_minutes
        self.events = sorted(events or [], key=lambda event: event.minute)
        self.zones = ZoneAggregator(population=twin.count)
        self.monitor = GateMonitor()
        self.engine = RoutingEngine()
        self.engine.set_plan(plan)
        self.on_measure = on_measure
        self.metrics = RunMetrics()
        self._start_time = twin.time
        self._redirected_before = twin.rerouted.copy()
        self._next_measure = twin.time * 60
        self._next_route = twin.time * 60
        self._closed_set: set[str] = {g for g, c in zip(GATE_IDS, twin.closed, strict=True) if c}
        self._apply_plan_holds(plan)

    def _apply_plan_holds(self, plan: RoutingPlan | None) -> None:
        if plan and plan.hold_sections:
            sections = [s - 201 for s in plan.hold_sections]
            self.twin.hold_sections(sections, plan.hold_until_seconds / 60)

    def _apply_events(self) -> None:
        while self.events and self.events[0].minute <= self.twin.time + 1e-9:
            event = self.events.pop(0)
            if event.closed:
                self._closed_set.add(event.gate_id)
            else:
                self._closed_set.discard(event.gate_id)
            self.twin.set_closed(self._closed_set)

    def _measure(self, seconds: float) -> None:
        twin = self.twin
        active = np.where(twin.phase != Phase.EXITED)[0]
        zones = self.zones.observe(
            seconds,
            active,
            twin.x[active],
            twin.z[active],
            twin.speed_mps[active],
            twin.target[active],
            self._closed_set,
        )
        twin.signals = self.monitor.update(seconds, zones)
        m = self.metrics
        above = False
        for zone in zones:
            density = zone.density_estimate
            if density > m.zone_peaks.get(zone.zone_id, 0.0):
                m.zone_peaks[zone.zone_id] = round(density, 3)
            if density > m.peak_density:
                m.peak_density = density
                m.peak_zone = zone.zone_id
            if zone.zone_id.endswith("_approach") and density >= HIGH_DENSITY:
                above = True
        if above:
            m.seconds_above_high += self.measure_interval
        queued = twin.queued_per_gate()
        gate = int(np.argmax(queued))
        if queued[gate] > m.max_queue:
            m.max_queue = int(queued[gate])
            m.max_queue_gate = GATE_IDS[gate]
        if self.on_measure:
            self.on_measure(seconds, zones)

    def _route(self, seconds: float) -> None:
        twin = self.twin
        active = np.where(twin.phase < Phase.EXIT)[0]
        decision = self.engine.decide(
            seconds,
            active,
            twin.x[active],
            twin.z[active],
            twin.target[active],
            twin.phase[active],
            twin.signals,
            twin.closed,
            twin.gate_capacity,
        )
        if decision.assignments:
            ids = np.array([a.person_id for a in decision.assignments])
            gates = np.array([a.to_gate for a in decision.assignments])
            twin.apply_assignments(ids, gates)

    def run_until(self, minute: float) -> RunMetrics:
        twin = self.twin
        twin_policy = self.policy if self.policy != "engine" else "none"
        while twin.time < minute - 1e-6:
            self._apply_events()
            seconds = round(twin.time * 60, 6)
            if seconds >= self._next_measure - 1e-6:
                self._measure(seconds)
                self._next_measure += self.measure_interval
            if self.policy == "engine" and seconds >= self._next_route - 1e-6:
                self._route(seconds)
                self._next_route += self.routing_interval
            to_measure = self._next_measure / 60 - twin.time
            dt = min(self.step_minutes, minute - twin.time)
            if to_measure > 1e-9:
                dt = min(dt, to_measure)
            twin.time += dt
            twin.step(dt, twin_policy)
        self._measure(twin.time * 60)
        return self.finalise()

    def run_until_clear(self, max_minute: float) -> RunMetrics:
        while self.twin.time < max_minute - 1e-6:
            self.run_until(min(max_minute, self.twin.time + 1.0))
            if self.twin.exited_count() == self.twin.count:
                break
        return self.finalise()

    def finalise(self) -> RunMetrics:
        twin = self.twin
        m = self.metrics
        exited = twin.phase == Phase.EXITED
        m.exited = int(exited.sum())
        m.not_exited = int(twin.count - m.exited)
        if m.exited:
            egress = twin.exited_at[exited] / 60
            m.mean_egress_minutes = round(float(egress.mean()), 2)
            m.p95_egress_minutes = round(float(np.percentile(egress, 95)), 2)
        if m.not_exited == 0:
            m.clearance_minutes = round(float(twin.exited_at.max() / 60), 2)
            m.projected_clearance_minutes = m.clearance_minutes
        else:
            recent = exited & (twin.exited_at >= (twin.time - 2) * 60)
            rate = recent.sum() / 2 if recent.any() else 0.0
            open_capacity = float(twin.gate_capacity[~twin.closed].sum())
            rate = max(rate, 1.0) if open_capacity > 0 else 0.0
            m.projected_clearance_minutes = round(
                twin.time + (m.not_exited / rate if rate else 999.0), 2
            )
        newly = twin.rerouted & ~self._redirected_before
        m.people_redirected = int(newly.sum())
        m.mean_extra_walk_m = round(float(twin.extra_walk_m[newly].mean()), 1) if newly.any() else 0.0
        m.peak_density = round(m.peak_density, 3)
        return m


def closure_events(closures: list[tuple[float, str, float | None]]) -> list[GateEvent]:
    events: list[GateEvent] = []
    for minute, gate_id, reopen in closures:
        if gate_id not in GATE_INDEX:
            raise ValueError(f"Unknown gate {gate_id}")
        events.append(GateEvent(minute, gate_id, True))
        if reopen is not None:
            events.append(GateEvent(reopen, gate_id, False))
    return events
