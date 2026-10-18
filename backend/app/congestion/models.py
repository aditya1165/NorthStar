from typing import Literal

from pydantic import BaseModel, Field

from app.shared.models import RiskLevel

GateId = Literal[
    "gate_a",
    "gate_b",
    "gate_c",
    "gate_d",
    "gate_e",
    "gate_f",
    "gate_g",
    "gate_h",
]
MovementState = Literal["waiting", "moving", "queued", "exiting", "transit_wait"]
PhaseName = Literal[
    "waiting", "row", "aisle", "base_ring", "gate_corridor", "queue", "return_to_base", "exit"
]


class AgentTelemetry(BaseModel):
    person_id: int = Field(ge=0, lt=4_000)
    x: float
    z: float
    speed_mps: float = Field(ge=0)
    target_gate: GateId
    movement_state: MovementState
    phase: PhaseName | None = None


class ExitedAgentTelemetry(BaseModel):
    person_id: int = Field(ge=0, lt=4_000)
    target_gate: GateId
    exited_at_seconds: float = Field(ge=0)


class TelemetryBatch(BaseModel):
    message_type: Literal["telemetry"] = "telemetry"
    run_id: str = Field(min_length=1, max_length=120)
    sequence: int = Field(ge=0)
    simulation_time_seconds: float = Field(ge=0)
    population: int = Field(default=4_000, ge=1)
    agents: list[AgentTelemetry]
    exited_agents: list[ExitedAgentTelemetry] = Field(default_factory=list)
    closed_gates: list[GateId] = Field(default_factory=list)


class GateCongestionState(BaseModel):
    gate_id: GateId
    label: str
    level: RiskLevel
    congested: bool
    people_count: int = Field(ge=0)
    density_per_m2: float = Field(ge=0)
    queue_length: int = Field(ge=0)
    mean_speed_mps: float = Field(ge=0)
    throughput_per_min: int = Field(ge=0)
    detected_at_seconds: float | None = None
    reason: str


class RouteAssignment(BaseModel):
    person_id: int
    from_gate: GateId
    to_gate: GateId
    reason: Literal["gate_closed", "congestion", "load_balance", "operator_plan"]
    estimated_benefit_seconds: float


class SectionHold(BaseModel):
    section: int
    until_seconds: float


class RoutingUpdate(BaseModel):
    assignments: list[RouteAssignment]
    holds: list[SectionHold] = Field(default_factory=list)
    gate_wait_seconds: dict[str, float | None]
    redirected_total: int
    active_plan_id: str | None = None


class LiveZoneState(BaseModel):
    zone_id: str
    name: str
    kind: str
    gate_id: GateId | None = None
    people_count: int
    density_per_m2: float
    inflow_per_min: float
    outflow_per_min: float
    mean_speed_mps: float
    queue_length: int
    level: RiskLevel
    status: str


class LiveZoneForecast(BaseModel):
    zone_id: str
    horizon_minutes: int
    predicted_density: float
    baseline_density: float
    low: float
    high: float
    level: RiskLevel
    risk_probability: float
    time_to_congestion_minutes: float | None
    method: Literal["baseline", "gbm"]
    top_factors: list[str]


class CongestionSnapshot(BaseModel):
    message_type: Literal["congestion"] = "congestion"
    run_id: str
    sequence: int
    simulation_time_seconds: float
    gates: list[GateCongestionState]
    routing: RoutingUpdate | None = None
    zones: list[LiveZoneState] | None = None
    forecasts: list[LiveZoneForecast] | None = None


class DetectorThresholdsResponse(BaseModel):
    high_density: float
    critical_density: float
    high_queue: int
    critical_queue: int
    queue_speed_mps: float
    trigger_persistence_seconds: float
    clear_persistence_seconds: float


class MonitoringReady(BaseModel):
    message_type: Literal["ready"] = "ready"
    config_version: str
    population: int
    gate_ids: list[GateId]
    thresholds: DetectorThresholdsResponse


class ProtocolError(BaseModel):
    message_type: Literal["error"] = "error"
    detail: str
