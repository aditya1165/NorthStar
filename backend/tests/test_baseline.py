import pytest

from app.forecasting import BaselineConfig, FlowBaseline
from app.shared.models import (
    IncidentState,
    RiskLevel,
    SimulationSnapshot,
    SimulationStatus,
    ZoneTelemetry,
)


def make_snapshot(
    *,
    people: int = 600,
    density: float = 2.0,
    inflow: float = 100,
    outflow: float = 100,
    queue: int = 100,
    speed: float = 1.0,
    opposing_flow: float = 0.1,
    gate_b_closed: bool = False,
) -> SimulationSnapshot:
    return SimulationSnapshot(
        elapsed_minutes=4,
        status=SimulationStatus.RUNNING,
        incidents=IncidentState(gate_b_closed=gate_b_closed),
        zones=[
            ZoneTelemetry(
                zone_id="north_concourse",
                name="North Concourse",
                people_count=people,
                density_estimate=density,
                inflow_per_min=inflow,
                outflow_per_min=outflow,
                mean_speed_mps=speed,
                queue_length=queue,
                opposing_flow_ratio=opposing_flow,
                risk_level=RiskLevel.ELEVATED,
            )
        ],
    )


def test_rising_flow_predicts_higher_density_and_queue() -> None:
    snapshot = make_snapshot(inflow=150, outflow=80)
    forecast = FlowBaseline().predict(snapshot, (5,))[0]

    assert forecast.predicted_density > snapshot.zones[0].density_estimate
    assert forecast.predicted_queue_length > snapshot.zones[0].queue_length
    assert forecast.time_to_congestion_minutes is not None
    assert "inflow exceeds outflow" in forecast.top_factors


def test_balanced_flow_preserves_density() -> None:
    snapshot = make_snapshot(inflow=100, outflow=100)
    forecast = FlowBaseline().predict(snapshot, (10,))[0]

    assert forecast.predicted_density == pytest.approx(2.0)
    assert forecast.predicted_queue_length == 100
    assert forecast.time_to_congestion_minutes is None


def test_clearing_flow_reduces_density_and_queue() -> None:
    snapshot = make_snapshot(inflow=50, outflow=100, queue=160)
    forecast = FlowBaseline().predict(snapshot, (5,))[0]

    assert forecast.predicted_density < snapshot.zones[0].density_estimate
    assert forecast.predicted_queue_length == 0
    assert forecast.time_to_congestion_minutes is None
    assert "outflow exceeds inflow" in forecast.top_factors


def test_incident_is_included_in_explanation() -> None:
    snapshot = make_snapshot(inflow=150, outflow=70, gate_b_closed=True)
    forecast = FlowBaseline().predict(snapshot, (10,))[0]

    assert forecast.risk_probability > 0.5
    assert "Gate B unavailable" in forecast.top_factors


def test_empty_zone_uses_default_area_without_division_error() -> None:
    snapshot = make_snapshot(people=0, density=0, inflow=0, outflow=0, queue=0)
    baseline = FlowBaseline(BaselineConfig(default_zone_area_m2=250))
    forecast = baseline.predict(snapshot, (5,))[0]

    assert forecast.predicted_density == 0
    assert forecast.confidence_interval[0] == 0


def test_invalid_horizon_is_rejected() -> None:
    with pytest.raises(ValueError, match="positive"):
        FlowBaseline().predict(make_snapshot(), (0,))

