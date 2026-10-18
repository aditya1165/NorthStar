"""Rolling zone aggregation from per-person telemetry.

Twelve zones are monitored: the eight gate approaches (identical polygons to the
congestion detector) and four base-path quadrants. Inflow and outflow are
measured from person-level zone membership changes over a rolling 60 s window.
"""

from collections import deque
from dataclasses import dataclass, field

import numpy as np

from app.shared.models import RiskLevel, ZoneTelemetry
from app.twin.layout import (
    GATE_INDEX,
    POPULATION,
    ZONES,
    angle_delta,
    ring_coords,
    zone_membership,
)

ELEVATED_DENSITY = 2.2
HIGH_DENSITY = 3.2
CRITICAL_DENSITY = 4.5
QUEUE_SPEED_MPS = 0.6
FLOW_WINDOW_SECONDS = 60.0
SAMPLE_INTERVAL_SECONDS = 30.0
HISTORY_LIMIT = 240


def risk_for_density(density: float) -> RiskLevel:
    if density >= CRITICAL_DENSITY:
        return RiskLevel.CRITICAL
    if density >= HIGH_DENSITY:
        return RiskLevel.HIGH
    if density >= ELEVATED_DENSITY:
        return RiskLevel.ELEVATED
    return RiskLevel.NORMAL


@dataclass
class ZoneSample:
    time_seconds: float
    zones: list[ZoneTelemetry]


@dataclass
class ZoneAggregator:
    population: int = POPULATION
    window_seconds: float = FLOW_WINDOW_SECONDS
    sample_interval_seconds: float = SAMPLE_INTERVAL_SECONDS
    history: deque[ZoneSample] = field(default_factory=lambda: deque(maxlen=HISTORY_LIMIT))

    def __post_init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._membership = np.full(self.population, -1, dtype=np.int16)
        self._angle = np.full(self.population, np.nan)
        self._events: deque[tuple[float, np.ndarray, np.ndarray]] = deque()
        self._first_time: float | None = None
        self._last_sample_time: float | None = None
        self.history.clear()
        self.latest: list[ZoneTelemetry] = []
        self.latest_time = 0.0

    def lagged(self, seconds_ago: float) -> dict[str, ZoneTelemetry]:
        """Zone sample closest to (and not after) ``seconds_ago`` before the latest sample."""
        cutoff = self.latest_time - seconds_ago + 1e-6
        for sample in reversed(self.history):
            if sample.time_seconds <= cutoff:
                return {zone.zone_id: zone for zone in sample.zones}
        return {}

    def observe(
        self,
        time_seconds: float,
        person_ids: np.ndarray,
        x: np.ndarray,
        z: np.ndarray,
        speed_mps: np.ndarray,
        target_gate: np.ndarray,
        closed_gates: set[str] | None = None,
        *,
        queued_mask: np.ndarray | None = None,
    ) -> list[ZoneTelemetry]:
        closed_gates = closed_gates or set()
        # Explicit simulation state distinguishes slow circulation from waiting.
        # Speed fallback preserves callers using older telemetry without phases.
        queued = speed_mps <= QUEUE_SPEED_MPS if queued_mask is None else queued_mask
        n_zones = len(ZONES)
        current = np.full(self.population, -1, dtype=np.int16)
        member = zone_membership(x, z)
        current[person_ids] = member

        if self._first_time is None:
            self._first_time = time_seconds
            inflow = np.zeros(n_zones)
            outflow = np.zeros(n_zones)
        else:
            changed = current != self._membership
            old = self._membership[changed]
            new = current[changed]
            outflow = np.bincount(old[old >= 0], minlength=n_zones).astype(float)
            inflow = np.bincount(new[new >= 0], minlength=n_zones).astype(float)
        self._events.append((time_seconds, inflow, outflow))
        while self._events and self._events[0][0] <= time_seconds - self.window_seconds:
            self._events.popleft()

        elapsed = time_seconds - self._first_time
        window_minutes = max(min(self.window_seconds, elapsed), 1.0) / 60
        inflow_rate = sum(event[1] for event in self._events) / window_minutes
        outflow_rate = sum(event[2] for event in self._events) / window_minutes

        angle, _ = ring_coords(x, z)
        previous_angle = self._angle[person_ids]
        turning = angle_delta(previous_angle, angle)
        self._angle[:] = np.nan
        self._angle[person_ids] = angle
        self._membership = current

        zones: list[ZoneTelemetry] = []
        for index, zone in enumerate(ZONES):
            inside = member == index
            count = int(np.count_nonzero(inside))
            speeds = speed_mps[inside]
            if zone.gate_id is not None:
                gate = GATE_INDEX[zone.gate_id]
                queue = int(np.count_nonzero(inside & (target_gate == gate) & queued))
            else:
                queue = int(np.count_nonzero(inside & queued))
            moving = turning[inside]
            moving = moving[np.isfinite(moving) & (np.abs(moving) > 0.05)]
            clockwise = int(np.count_nonzero(moving > 0))
            opposing = min(clockwise, moving.size - clockwise) / moving.size if moving.size else 0.0
            density = count / zone.area_m2
            closed = zone.gate_id in closed_gates
            zones.append(
                ZoneTelemetry(
                    zone_id=zone.zone_id,
                    name=zone.name,
                    people_count=count,
                    density_estimate=round(density, 3),
                    inflow_per_min=round(float(inflow_rate[index]), 2),
                    outflow_per_min=round(float(outflow_rate[index]), 2),
                    mean_speed_mps=round(float(speeds.mean()) if count else 0.0, 3),
                    queue_length=queue,
                    opposing_flow_ratio=round(float(opposing), 3),
                    risk_level=risk_for_density(density),
                    status="closed" if closed else "open",
                    area_m2=round(zone.area_m2, 1),
                )
            )
        self.latest = zones
        self.latest_time = time_seconds
        if (
            self._last_sample_time is None
            or time_seconds - self._last_sample_time >= self.sample_interval_seconds - 1e-6
        ):
            self._last_sample_time = time_seconds
            self.history.append(ZoneSample(time_seconds=time_seconds, zones=zones))
        return zones
