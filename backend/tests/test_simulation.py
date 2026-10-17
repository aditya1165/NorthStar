from app.forecasting import ForecastService
from app.response import ResponseService
from app.simulation import CrowdSimulation


def test_incident_increases_north_concourse_risk() -> None:
    simulation = CrowdSimulation()
    simulation.start()
    simulation.set_incident("gate-b-closure", True)
    simulation.set_incident("metro-delay", True)
    for _ in range(8):
        snapshot = simulation.step()

    north = next(zone for zone in snapshot.zones if zone.zone_id == "north_concourse")
    assert north.density_estimate > 3.0
    assert north.inflow_per_min > north.outflow_per_min


def test_forecast_explains_incident() -> None:
    simulation = CrowdSimulation()
    snapshot = simulation.set_incident("gate-b-closure", True)
    forecasts = ForecastService().predict(snapshot)
    north = next(
        forecast
        for forecast in forecasts
        if forecast.zone_id == "north_concourse" and forecast.horizon_minutes == 10
    )
    assert "Gate B unavailable" in north.top_factors
    assert north.risk_probability > 0.5


def test_combined_action_is_recommended_during_incident() -> None:
    simulation = CrowdSimulation()
    snapshot = simulation.set_incident("gate-b-closure", True)
    results = ResponseService().evaluate(snapshot)
    recommended = next(result for result in results if result.recommended)
    assert recommended.intervention_id == "combined-action"
    assert recommended.accessibility_violations == 0

