from collections import deque
from dataclasses import dataclass, field

from app.congestion.config import (
    CONFIG_VERSION,
    GATES,
    METERS_PER_SCENE_UNIT,
    POPULATION,
    THRESHOLDS,
    DetectorThresholds,
    GateDetectionConfig,
)
from app.congestion.models import (
    CongestionSnapshot,
    DetectorThresholdsResponse,
    GateCongestionState,
    MonitoringReady,
    TelemetryBatch,
)
from app.shared.models import RiskLevel


def _polygon_area(points: tuple[tuple[float, float], ...]) -> float:
    area = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2


def _inside_polygon(x: float, y: float, points: tuple[tuple[float, float], ...]) -> bool:
    inside = False
    previous = len(points) - 1
    for current, (xi, yi) in enumerate(points):
        xj, yj = points[previous]
        crosses = (yi > y) != (yj > y)
        if crosses:
            boundary_x = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x <= boundary_x:
                inside = not inside
        previous = current
    return inside


@dataclass
class _GateTracker:
    congested: bool = False
    candidate_since: float | None = None
    clear_since: float | None = None
    detected_at: float | None = None
    exits: deque[float] = field(default_factory=deque)


class CongestionDetector:
    """Deterministic gate-congestion detector driven only by person telemetry."""

    def __init__(
        self,
        gates: tuple[GateDetectionConfig, ...] = GATES,
        thresholds: DetectorThresholds = THRESHOLDS,
    ) -> None:
        self._gates = gates
        self._thresholds = thresholds
        self._run_id: str | None = None
        self._last_sequence = -1
        self._trackers = {gate.gate_id: _GateTracker() for gate in gates}
        self._exited_ids: set[int] = set()

    def ready(self) -> MonitoringReady:
        t = self._thresholds
        return MonitoringReady(
            config_version=CONFIG_VERSION,
            population=POPULATION,
            gate_ids=[gate.gate_id for gate in self._gates],
            thresholds=DetectorThresholdsResponse(
                high_density=t.high_density,
                critical_density=t.critical_density,
                high_queue=t.high_queue,
                critical_queue=t.critical_queue,
                queue_speed_mps=t.queue_speed_mps,
                trigger_persistence_seconds=t.trigger_persistence_seconds,
                clear_persistence_seconds=t.clear_persistence_seconds,
            ),
        )

    def process(self, batch: TelemetryBatch) -> CongestionSnapshot:
        if batch.run_id != self._run_id:
            self._reset(batch.run_id)
        if batch.sequence <= self._last_sequence:
            raise ValueError("Telemetry sequence must increase within a run")
        if batch.population != POPULATION:
            raise ValueError(f"Expected population {POPULATION}, received {batch.population}")

        active_ids = [agent.person_id for agent in batch.agents]
        exit_ids = [agent.person_id for agent in batch.exited_agents]
        if len(active_ids) != len(set(active_ids)):
            raise ValueError("Telemetry contains duplicate active person IDs")
        if len(exit_ids) != len(set(exit_ids)):
            raise ValueError("Telemetry contains duplicate exited person IDs")
        if set(active_ids) & set(exit_ids):
            raise ValueError("A person cannot be active and exited in the same telemetry batch")

        for exited in batch.exited_agents:
            if exited.person_id in self._exited_ids:
                continue
            self._exited_ids.add(exited.person_id)
            self._trackers[exited.target_gate].exits.append(exited.exited_at_seconds)

        if set(active_ids) & self._exited_ids:
            raise ValueError("An exited person cannot become active again within the same run")
        for tracker in self._trackers.values():
            tracker.exits = deque(sorted(tracker.exits))

        if len(active_ids) + len(self._exited_ids) != POPULATION:
            raise ValueError("Active and exited person records must account for all 4,000 people")

        self._last_sequence = batch.sequence
        gates = [self._measure_gate(gate, batch) for gate in self._gates]
        return CongestionSnapshot(
            run_id=batch.run_id,
            sequence=batch.sequence,
            simulation_time_seconds=batch.simulation_time_seconds,
            gates=gates,
        )

    def _reset(self, run_id: str) -> None:
        self._run_id = run_id
        self._last_sequence = -1
        self._trackers = {gate.gate_id: _GateTracker() for gate in self._gates}
        self._exited_ids.clear()

    def _measure_gate(
        self,
        gate: GateDetectionConfig,
        batch: TelemetryBatch,
    ) -> GateCongestionState:
        t = self._thresholds
        tracker = self._trackers[gate.gate_id]
        inside = [
            agent
            for agent in batch.agents
            if _inside_polygon(agent.x, agent.z, gate.approach_polygon)
        ]
        area_m2 = _polygon_area(gate.approach_polygon) * METERS_PER_SCENE_UNIT**2
        density = len(inside) / area_m2
        mean_speed = sum(agent.speed_mps for agent in inside) / len(inside) if inside else 0.0
        queue = sum(
            agent.target_gate == gate.gate_id and agent.speed_mps <= t.queue_speed_mps
            for agent in inside
        )

        cutoff = batch.simulation_time_seconds - 60
        while tracker.exits and tracker.exits[0] < cutoff:
            tracker.exits.popleft()

        raw_level = self._raw_level(density, queue, mean_speed, len(inside))
        candidate = (
            (density >= t.high_density and mean_speed <= t.queue_speed_mps)
            or queue >= t.high_queue
        )
        clear = (
            len(inside) == 0
            or (
                density < t.clear_density
                and queue < t.clear_queue
                and mean_speed > t.clear_speed_mps
            )
        )

        now = batch.simulation_time_seconds
        if candidate:
            tracker.clear_since = None
            if tracker.candidate_since is None:
                tracker.candidate_since = now
            if not tracker.congested and now - tracker.candidate_since >= t.trigger_persistence_seconds:
                tracker.congested = True
                tracker.detected_at = tracker.candidate_since + t.trigger_persistence_seconds
        else:
            tracker.candidate_since = None
            if tracker.congested and clear:
                if tracker.clear_since is None:
                    tracker.clear_since = now
                if now - tracker.clear_since >= t.clear_persistence_seconds:
                    tracker.congested = False
                    tracker.detected_at = None
                    tracker.clear_since = None
            else:
                tracker.clear_since = None

        if tracker.congested and raw_level in {RiskLevel.NORMAL, RiskLevel.ELEVATED}:
            level = RiskLevel.HIGH
        else:
            level = raw_level

        return GateCongestionState(
            gate_id=gate.gate_id,
            label=gate.label,
            level=level,
            congested=tracker.congested,
            people_count=len(inside),
            density_per_m2=round(density, 2),
            queue_length=queue,
            mean_speed_mps=round(mean_speed, 2),
            throughput_per_min=len(tracker.exits),
            detected_at_seconds=tracker.detected_at,
            reason=self._reason(level, tracker.congested, density, queue, mean_speed),
        )

    def _raw_level(
        self,
        density: float,
        queue: int,
        mean_speed: float,
        people_count: int,
    ) -> RiskLevel:
        t = self._thresholds
        if (
            density >= t.critical_density
            or queue >= t.critical_queue
            or (people_count >= t.minimum_speed_sample and mean_speed <= t.critical_speed_mps)
        ):
            return RiskLevel.CRITICAL
        if density >= t.high_density or queue >= t.high_queue:
            return RiskLevel.HIGH
        if density >= t.elevated_density or queue >= t.elevated_queue:
            return RiskLevel.ELEVATED
        return RiskLevel.NORMAL

    def _reason(
        self,
        level: RiskLevel,
        congested: bool,
        density: float,
        queue: int,
        mean_speed: float,
    ) -> str:
        if congested:
            return (
                f"Congestion detected: {density:.1f} people/m², "
                f"queue {queue}, mean speed {mean_speed:.1f} m/s"
            )
        if level in {RiskLevel.ELEVATED, RiskLevel.HIGH, RiskLevel.CRITICAL}:
            return "Threshold exceeded; waiting for persistence confirmation"
        return "Gate approach operating normally"
