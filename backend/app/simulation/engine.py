from copy import deepcopy
from dataclasses import dataclass
from threading import RLock

from app.shared.models import (
    IncidentState,
    RiskLevel,
    SimulationSnapshot,
    SimulationStatus,
    ZoneTelemetry,
)


@dataclass(frozen=True)
class ZoneDefinition:
    zone_id: str
    name: str
    area_m2: float
    base_people: int
    base_inflow: float
    base_outflow: float


ZONES = (
    ZoneDefinition("north_concourse", "North Concourse", 310, 520, 125, 118),
    ZoneDefinition("east_corridor", "East Corridor", 260, 350, 92, 98),
    ZoneDefinition("west_concourse", "West Concourse", 340, 410, 105, 112),
    ZoneDefinition("gate_a", "Gate A", 220, 240, 76, 104),
    ZoneDefinition("gate_c", "Gate C", 230, 170, 54, 82),
    ZoneDefinition("metro_plaza", "Metro Plaza", 420, 460, 112, 124),
)


class CrowdSimulation:
    """Deterministic zone-level simulation used by the hackathon MVP."""

    def __init__(self) -> None:
        self._lock = RLock()
        self.reset()

    def reset(self) -> SimulationSnapshot:
        with self._lock:
            self.elapsed_minutes = 0.0
            self.status = SimulationStatus.IDLE
            self.incidents = IncidentState()
            self.active_intervention: str | None = None
            self._people = {zone.zone_id: float(zone.base_people) for zone in ZONES}
            self._previous_people = deepcopy(self._people)
            return self.snapshot()

    def start(self) -> SimulationSnapshot:
        with self._lock:
            self.status = SimulationStatus.RUNNING
            return self.snapshot()

    def pause(self) -> SimulationSnapshot:
        with self._lock:
            self.status = SimulationStatus.PAUSED
            return self.snapshot()

    def set_incident(self, incident: str, active: bool) -> SimulationSnapshot:
        with self._lock:
            if incident == "gate-b-closure":
                self.incidents.gate_b_closed = active
            elif incident == "metro-delay":
                self.incidents.metro_delayed = active
            else:
                raise ValueError(f"Unknown incident: {incident}")
            return self.snapshot()

    def apply_intervention(self, intervention_id: str) -> SimulationSnapshot:
        with self._lock:
            allowed = {"open-gate-c", "redirect-sections", "combined-action"}
            if intervention_id not in allowed:
                raise ValueError(f"Intervention cannot be applied: {intervention_id}")
            self.active_intervention = intervention_id
            return self.snapshot()

    def step(self, minutes: float = 0.5) -> SimulationSnapshot:
        with self._lock:
            if self.status in {SimulationStatus.IDLE, SimulationStatus.PAUSED}:
                self.status = SimulationStatus.RUNNING

            self._previous_people = deepcopy(self._people)
            for zone in ZONES:
                inflow, outflow = self._flows(zone)
                next_count = max(0.0, self._people[zone.zone_id] + (inflow - outflow) * minutes)
                self._people[zone.zone_id] = next_count

            self.elapsed_minutes = round(self.elapsed_minutes + minutes, 1)
            if self.elapsed_minutes >= 35 or sum(self._people.values()) < 120:
                self.status = SimulationStatus.COMPLETE
            return self.snapshot()

    def _flows(self, zone: ZoneDefinition) -> tuple[float, float]:
        inflow, outflow = zone.base_inflow, zone.base_outflow
        if zone.zone_id == "north_concourse" and self.incidents.gate_b_closed:
            inflow += 70
            outflow -= 42
        if zone.zone_id == "metro_plaza" and self.incidents.metro_delayed:
            outflow -= 76
        if zone.zone_id == "north_concourse" and self.incidents.metro_delayed:
            outflow -= 24

        if self.active_intervention in {"open-gate-c", "combined-action"}:
            if zone.zone_id == "north_concourse":
                inflow -= 35
                outflow += 28
            if zone.zone_id == "gate_c":
                inflow += 36
                outflow += 52
        if self.active_intervention in {"redirect-sections", "combined-action"}:
            if zone.zone_id == "north_concourse":
                inflow -= 48
            if zone.zone_id in {"east_corridor", "west_concourse"}:
                inflow += 18
        return max(0, inflow), max(1, outflow)

    def _zone_telemetry(self, zone: ZoneDefinition) -> ZoneTelemetry:
        people = self._people[zone.zone_id]
        inflow, outflow = self._flows(zone)
        density = people / zone.area_m2
        congestion = max(0.0, density - 1.2)
        speed = max(0.22, 1.34 - congestion * 0.22)
        queue = max(0, round((people - zone.area_m2 * 1.25) * 0.7))
        opposing = 0.08
        if zone.zone_id == "north_concourse" and self.incidents.gate_b_closed:
            opposing = 0.31 if self.active_intervention != "combined-action" else 0.13
        risk = self._risk_level(density, queue, speed)
        return ZoneTelemetry(
            zone_id=zone.zone_id,
            name=zone.name,
            people_count=round(people),
            density_estimate=round(density, 2),
            inflow_per_min=round(inflow, 1),
            outflow_per_min=round(outflow, 1),
            mean_speed_mps=round(speed, 2),
            queue_length=queue,
            opposing_flow_ratio=opposing,
            risk_level=risk,
            status="open",
        )

    @staticmethod
    def _risk_level(density: float, queue: int, speed: float) -> RiskLevel:
        if density >= 4.5 or speed <= 0.35:
            return RiskLevel.CRITICAL
        if density >= 3.2 or queue >= 380:
            return RiskLevel.HIGH
        if density >= 2.2 or queue >= 180:
            return RiskLevel.ELEVATED
        return RiskLevel.NORMAL

    def snapshot(self) -> SimulationSnapshot:
        with self._lock:
            return SimulationSnapshot(
                elapsed_minutes=self.elapsed_minutes,
                status=self.status,
                incidents=self.incidents.model_copy(),
                active_intervention=self.active_intervention,
                zones=[self._zone_telemetry(zone) for zone in ZONES],
            )

