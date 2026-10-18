from dataclasses import dataclass

from app.shared.models import Forecast, SimulationSnapshot, ZoneTelemetry


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


@dataclass(frozen=True)
class BaselineConfig:
    """Configuration for the explainable mass-balance forecast."""

    congestion_density: float = 3.2
    density_warning_floor: float = 1.5
    critical_queue_length: int = 400
    free_flow_speed_mps: float = 1.2
    minimum_speed_mps: float = 0.3
    queue_capture_ratio: float = 0.7
    default_zone_area_m2: float = 300.0
    minimum_risk_probability: float = 0.02
    maximum_risk_probability: float = 0.99


class FlowBaseline:
    """Forecast zone conditions by extending the current mass balance.

    The baseline assumes current inflow and outflow remain constant throughout
    the forecast horizon. It is intentionally transparent and deterministic so
    it can be used as an evaluation benchmark and a production fallback.
    """

    def __init__(self, config: BaselineConfig | None = None) -> None:
        self.config = config or BaselineConfig()

    def predict(
        self,
        snapshot: SimulationSnapshot,
        horizons_minutes: tuple[int, ...] = (5, 10),
    ) -> list[Forecast]:
        if not horizons_minutes:
            raise ValueError("At least one forecast horizon is required")
        if any(horizon <= 0 for horizon in horizons_minutes):
            raise ValueError("Forecast horizons must be positive")

        return [
            self.predict_zone(zone, horizon, snapshot)
            for zone in snapshot.zones
            for horizon in horizons_minutes
        ]

    def predict_zone(
        self,
        zone: ZoneTelemetry,
        horizon_minutes: int,
        snapshot: SimulationSnapshot,
    ) -> Forecast:
        if horizon_minutes <= 0:
            raise ValueError("Forecast horizon must be positive")

        area_m2 = self._infer_zone_area(zone)
        net_flow_per_min = zone.inflow_per_min - zone.outflow_per_min
        projected_people = max(
            0.0,
            zone.people_count + net_flow_per_min * horizon_minutes,
        )
        projected_density = projected_people / area_m2
        projected_queue = max(
            0,
            round(
                zone.queue_length
                + net_flow_per_min * horizon_minutes * self.config.queue_capture_ratio
            ),
        )
        time_to_congestion = self._time_to_congestion(
            zone=zone,
            area_m2=area_m2,
            net_flow_per_min=net_flow_per_min,
        )
        risk_probability = self._risk_probability(
            zone=zone,
            projected_density=projected_density,
            projected_queue=projected_queue,
            snapshot=snapshot,
        )
        lower, upper = self._prediction_interval(
            projected_density=projected_density,
            horizon_minutes=horizon_minutes,
            net_flow_per_min=net_flow_per_min,
            area_m2=area_m2,
        )

        return Forecast(
            zone_id=zone.zone_id,
            horizon_minutes=horizon_minutes,
            predicted_density=round(projected_density, 2),
            predicted_queue_length=projected_queue,
            risk_probability=round(risk_probability, 2),
            time_to_congestion_minutes=(
                round(time_to_congestion, 1) if time_to_congestion is not None else None
            ),
            confidence_interval=(round(lower, 2), round(upper, 2)),
            top_factors=self._top_factors(
                zone=zone,
                net_flow_per_min=net_flow_per_min,
                projected_density=projected_density,
                snapshot=snapshot,
            ),
        )

    def _infer_zone_area(self, zone: ZoneTelemetry) -> float:
        if zone.area_m2:
            return zone.area_m2
        if zone.people_count > 0 and zone.density_estimate > 0:
            return zone.people_count / zone.density_estimate
        return self.config.default_zone_area_m2

    def _time_to_congestion(
        self,
        zone: ZoneTelemetry,
        area_m2: float,
        net_flow_per_min: float,
    ) -> float | None:
        if zone.density_estimate >= self.config.congestion_density:
            return 0.0
        if net_flow_per_min <= 0:
            return None

        congestion_people = self.config.congestion_density * area_m2
        return max(0.0, (congestion_people - zone.people_count) / net_flow_per_min)

    def _risk_probability(
        self,
        zone: ZoneTelemetry,
        projected_density: float,
        projected_queue: int,
        snapshot: SimulationSnapshot,
    ) -> float:
        density_range = max(
            0.01,
            self.config.congestion_density - self.config.density_warning_floor,
        )
        density_pressure = _clamp(
            (projected_density - self.config.density_warning_floor) / density_range,
            0.0,
            1.0,
        )
        queue_pressure = _clamp(
            projected_queue / self.config.critical_queue_length,
            0.0,
            1.0,
        )
        speed_range = max(
            0.01,
            self.config.free_flow_speed_mps - self.config.minimum_speed_mps,
        )
        speed_pressure = _clamp(
            (self.config.free_flow_speed_mps - zone.mean_speed_mps) / speed_range,
            0.0,
            1.0,
        )
        opposing_pressure = _clamp(zone.opposing_flow_ratio, 0.0, 1.0)
        incident_pressure = float(
            (snapshot.incidents.gate_b_closed and zone.zone_id == "north_concourse")
            or (snapshot.incidents.metro_delayed and zone.zone_id == "metro_plaza")
            or zone.status == "closed"
        )

        probability = (
            self.config.minimum_risk_probability
            + 0.58 * density_pressure
            + 0.16 * queue_pressure
            + 0.10 * speed_pressure
            + 0.10 * opposing_pressure
            + 0.06 * incident_pressure
        )
        return _clamp(
            probability,
            self.config.minimum_risk_probability,
            self.config.maximum_risk_probability,
        )

    @staticmethod
    def _prediction_interval(
        projected_density: float,
        horizon_minutes: int,
        net_flow_per_min: float,
        area_m2: float,
    ) -> tuple[float, float]:
        horizon_uncertainty = 0.06 + 0.015 * horizon_minutes
        flow_uncertainty = min(0.18, abs(net_flow_per_min) / max(area_m2, 1.0) * 0.25)
        relative_uncertainty = horizon_uncertainty + flow_uncertainty
        spread = max(0.12, projected_density * relative_uncertainty)
        return max(0.0, projected_density - spread), projected_density + spread

    def _top_factors(
        self,
        zone: ZoneTelemetry,
        net_flow_per_min: float,
        projected_density: float,
        snapshot: SimulationSnapshot,
    ) -> list[str]:
        factors: list[str] = []
        if net_flow_per_min > 0:
            factors.append("inflow exceeds outflow")
        elif net_flow_per_min < 0:
            factors.append("outflow exceeds inflow")
        if snapshot.incidents.gate_b_closed and zone.zone_id == "north_concourse":
            factors.append("Gate B unavailable")
        if zone.status == "closed":
            factors.append("gate closed")
        if snapshot.incidents.metro_delayed and zone.zone_id in {
            "north_concourse",
            "metro_plaza",
        }:
            factors.append("metro delay")
        if zone.opposing_flow_ratio >= 0.2:
            factors.append("opposing pedestrian flows")
        if zone.mean_speed_mps <= 0.7:
            factors.append("walking speed is reduced")
        if projected_density >= self.config.congestion_density:
            factors.append("projected density exceeds the configured threshold")
        if not factors:
            factors.append("stable flow conditions")
        return factors[:3]

