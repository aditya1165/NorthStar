from enum import StrEnum

from pydantic import BaseModel, Field


class RiskLevel(StrEnum):
    NORMAL = "normal"
    ELEVATED = "elevated"
    HIGH = "high"
    CRITICAL = "critical"


class SimulationStatus(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETE = "complete"


class ZoneTelemetry(BaseModel):
    zone_id: str
    name: str
    people_count: int = Field(ge=0)
    density_estimate: float = Field(ge=0)
    inflow_per_min: float = Field(ge=0)
    outflow_per_min: float = Field(ge=0)
    mean_speed_mps: float = Field(ge=0)
    queue_length: int = Field(ge=0)
    opposing_flow_ratio: float = Field(ge=0, le=1)
    risk_level: RiskLevel
    status: str = "open"


class IncidentState(BaseModel):
    gate_b_closed: bool = False
    metro_delayed: bool = False


class SimulationSnapshot(BaseModel):
    elapsed_minutes: float
    status: SimulationStatus
    incidents: IncidentState
    active_intervention: str | None = None
    zones: list[ZoneTelemetry]


class Forecast(BaseModel):
    zone_id: str
    horizon_minutes: int
    predicted_density: float
    predicted_queue_length: int
    risk_probability: float = Field(ge=0, le=1)
    time_to_congestion_minutes: float | None
    confidence_interval: tuple[float, float]
    top_factors: list[str]


class InterventionResult(BaseModel):
    intervention_id: str
    name: str
    actions: list[str]
    feasible: bool
    recommended: bool = False
    rollouts: int = 5
    peak_density: float
    clearance_time_minutes: float
    people_redirected: int
    extra_walk_meters_mean: float
    accessibility_violations: int = 0
    risk_reduction_percent: float
    operational_complexity: int = Field(ge=1, le=5)
    explanation: str


class IncidentRequest(BaseModel):
    active: bool = True


class ApprovalResponse(BaseModel):
    approved_intervention_id: str
    snapshot: SimulationSnapshot

