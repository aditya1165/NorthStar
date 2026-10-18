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


class AgentTelemetry(BaseModel):
    person_id: int = Field(ge=0, lt=4_000)
    x: float
    z: float
    speed_mps: float = Field(ge=0)
    target_gate: GateId
    movement_state: MovementState


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


class CongestionSnapshot(BaseModel):
    message_type: Literal["congestion"] = "congestion"
    run_id: str
    sequence: int
    simulation_time_seconds: float
    gates: list[GateCongestionState]


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
