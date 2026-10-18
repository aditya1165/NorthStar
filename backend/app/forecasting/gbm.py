"""Optional gradient-boosted zone forecaster trained on the generated dataset.

scikit-learn is an optional dependency (``pip install -e ".[ml]"``). When it or
the model file is missing, the live service falls back to ``FlowBaseline``.
"""

from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODEL_PATH = REPO_ROOT / "data" / "models" / "zone_forecaster_v1.joblib"

FEATURES = [
    "is_gate_approach",
    "gate_closed",
    "closed_gate_count",
    "exited_fraction",
    "time_seconds",
    "people_count",
    "density",
    "inflow_per_min",
    "outflow_per_min",
    "net_flow_per_min",
    "mean_speed_mps",
    "queue_length",
    "opposing_flow_ratio",
    "density_lag_30s",
    "density_lag_60s",
    "inflow_lag_60s",
]
HORIZONS = (5, 10)


def feature_row(record: dict) -> list[float]:
    values = dict(record)
    values["is_gate_approach"] = 1.0 if record.get("zone_kind") == "gate_approach" else 0.0
    return [float(values[name]) for name in FEATURES]


class GbmForecaster:
    def __init__(self, models: dict[int, object], metadata: dict) -> None:
        self.models = models
        self.metadata = metadata

    @classmethod
    def load(cls, path: Path = DEFAULT_MODEL_PATH) -> "GbmForecaster | None":
        if not path.exists():
            return None
        try:
            import joblib
        except ImportError:
            return None
        bundle = joblib.load(path)
        return cls(bundle["models"], bundle.get("metadata", {}))

    def predict(self, records: list[dict]) -> dict[int, list[float]]:
        if not records:
            return {h: [] for h in self.models}
        rows = [feature_row(record) for record in records]
        return {
            horizon: [max(0.0, round(float(value), 3)) for value in model.predict(rows)]
            for horizon, model in self.models.items()
        }
