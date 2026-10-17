from app.forecasting.baseline import FlowBaseline
from app.shared.models import Forecast, SimulationSnapshot


class ForecastService:
    """Explainable flow-extrapolation baseline, replaceable by a trained model."""

    def __init__(self, baseline: FlowBaseline | None = None) -> None:
        self.baseline = baseline or FlowBaseline()

    def predict(self, snapshot: SimulationSnapshot) -> list[Forecast]:
        return self.baseline.predict(snapshot)

