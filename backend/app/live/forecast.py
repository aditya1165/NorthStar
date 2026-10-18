"""Live 5/10-minute zone forecasts from the rolling zone stream."""

from app.congestion.models import LiveZoneForecast
from app.forecasting import FlowBaseline
from app.forecasting.gbm import GbmForecaster
from app.live.zones import ZoneAggregator, risk_for_density
from app.shared.models import IncidentState, SimulationSnapshot, SimulationStatus, ZoneTelemetry
from app.twin.layout import ZONES

HORIZONS = (5, 10)
ZONE_KIND = {zone.zone_id: zone.kind for zone in ZONES}

_gbm_cache: dict[str, GbmForecaster | None] = {}


def load_gbm() -> GbmForecaster | None:
    if "model" not in _gbm_cache:
        try:
            _gbm_cache["model"] = GbmForecaster.load()
        except Exception:  # noqa: BLE001 - a corrupt or incompatible model must not break live mode
            _gbm_cache["model"] = None
    return _gbm_cache["model"]


class LiveForecaster:
    def __init__(self, use_gbm: bool = True) -> None:
        self.baseline = FlowBaseline()
        self.gbm = load_gbm() if use_gbm else None

    def forecast(
        self,
        aggregator: ZoneAggregator,
        zones: list[ZoneTelemetry],
        time_seconds: float,
        exited_fraction: float,
        closed_gate_count: int,
    ) -> list[LiveZoneForecast]:
        snapshot = SimulationSnapshot(
            elapsed_minutes=time_seconds / 60,
            status=SimulationStatus.RUNNING,
            incidents=IncidentState(),
            zones=zones,
        )
        gbm_predictions: dict[int, list[float]] = {}
        if self.gbm is not None:
            lag30 = aggregator.lagged(30)
            lag60 = aggregator.lagged(60)
            records = [
                {
                    "zone_kind": ZONE_KIND.get(zone.zone_id, ""),
                    "gate_closed": int(zone.status == "closed"),
                    "closed_gate_count": closed_gate_count,
                    "exited_fraction": exited_fraction,
                    "time_seconds": time_seconds,
                    "people_count": zone.people_count,
                    "density": zone.density_estimate,
                    "inflow_per_min": zone.inflow_per_min,
                    "outflow_per_min": zone.outflow_per_min,
                    "net_flow_per_min": zone.inflow_per_min - zone.outflow_per_min,
                    "mean_speed_mps": zone.mean_speed_mps,
                    "queue_length": zone.queue_length,
                    "opposing_flow_ratio": zone.opposing_flow_ratio,
                    "density_lag_30s": lag30[zone.zone_id].density_estimate if zone.zone_id in lag30 else 0.0,
                    "density_lag_60s": lag60[zone.zone_id].density_estimate if zone.zone_id in lag60 else 0.0,
                    "inflow_lag_60s": lag60[zone.zone_id].inflow_per_min if zone.zone_id in lag60 else 0.0,
                }
                for zone in zones
            ]
            gbm_predictions = self.gbm.predict(records)

        forecasts: list[LiveZoneForecast] = []
        for index, zone in enumerate(zones):
            for horizon in HORIZONS:
                base = self.baseline.predict_zone(zone, horizon, snapshot)
                low, high = base.confidence_interval
                predicted = base.predicted_density
                method = "baseline"
                if horizon in gbm_predictions:
                    predicted = gbm_predictions[horizon][index]
                    spread = (high - low) / 2
                    low, high = max(0.0, predicted - spread), predicted + spread
                    method = "gbm"
                forecasts.append(
                    LiveZoneForecast(
                        zone_id=zone.zone_id,
                        horizon_minutes=horizon,
                        predicted_density=round(predicted, 3),
                        baseline_density=base.predicted_density,
                        low=round(low, 3),
                        high=round(high, 3),
                        level=risk_for_density(predicted),
                        risk_probability=base.risk_probability,
                        time_to_congestion_minutes=base.time_to_congestion_minutes,
                        method=method,
                        top_factors=base.top_factors,
                    )
                )
        return forecasts
