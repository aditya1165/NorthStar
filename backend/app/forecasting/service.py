from app.shared.models import Forecast, SimulationSnapshot, ZoneTelemetry


class ForecastService:
    """Explainable flow-extrapolation baseline, replaceable by a trained model."""

    def predict(self, snapshot: SimulationSnapshot) -> list[Forecast]:
        forecasts: list[Forecast] = []
        for zone in snapshot.zones:
            for horizon in (5, 10):
                forecasts.append(self._predict_zone(zone, horizon, snapshot))
        return forecasts

    @staticmethod
    def _predict_zone(
        zone: ZoneTelemetry, horizon: int, snapshot: SimulationSnapshot
    ) -> Forecast:
        area = max(1.0, zone.people_count / max(zone.density_estimate, 0.01))
        net_flow = zone.inflow_per_min - zone.outflow_per_min
        projected_people = max(0, zone.people_count + net_flow * horizon)
        projected_density = max(0.0, projected_people / area)
        projected_queue = max(0, zone.queue_length + round(max(0, net_flow) * horizon * 0.7))
        risk_probability = min(0.99, max(0.02, (projected_density - 1.5) / 3.5))
        threshold_people = 3.2 * area
        time_to_congestion = None
        if net_flow > 0:
            time_to_congestion = max(0.0, (threshold_people - zone.people_count) / net_flow)

        factors: list[str] = []
        if net_flow > 0:
            factors.append("inflow exceeds outflow")
        if snapshot.incidents.gate_b_closed and zone.zone_id == "north_concourse":
            factors.append("Gate B unavailable")
        if snapshot.incidents.metro_delayed and zone.zone_id in {"north_concourse", "metro_plaza"}:
            factors.append("metro delay")
        if zone.opposing_flow_ratio >= 0.2:
            factors.append("opposing pedestrian flows")
        if not factors:
            factors.append("stable flow conditions")

        uncertainty = 0.12 * max(1.0, projected_density)
        return Forecast(
            zone_id=zone.zone_id,
            horizon_minutes=horizon,
            predicted_density=round(projected_density, 2),
            predicted_queue_length=projected_queue,
            risk_probability=round(risk_probability, 2),
            time_to_congestion_minutes=(
                round(time_to_congestion, 1) if time_to_congestion is not None else None
            ),
            confidence_interval=(
                round(max(0, projected_density - uncertainty), 2),
                round(projected_density + uncertainty, 2),
            ),
            top_factors=factors[:3],
        )

