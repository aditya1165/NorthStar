import argparse
import csv
import json
import math
from pathlib import Path

from app.forecasting.gbm import DEFAULT_MODEL_PATH, FEATURES, HORIZONS, REPO_ROOT, feature_row

BUSY_DENSITY = 0.5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train the gradient-boosted zone forecaster and compare it with the baseline.",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=REPO_ROOT / "data" / "generated" / "crowd_v1",
        help="Directory produced by scripts/generate_dataset.py.",
    )
    parser.add_argument("--output", type=Path, default=DEFAULT_MODEL_PATH, help="Model output path.")
    return parser.parse_args()


def metrics(truth: list[float], predicted: list[float]) -> dict[str, float]:
    errors = [p - t for p, t in zip(predicted, truth, strict=True)]
    n = max(len(errors), 1)
    busy = [(p, t) for p, t in zip(predicted, truth, strict=True) if t >= BUSY_DENSITY]
    return {
        "mae": round(sum(abs(e) for e in errors) / n, 4),
        "rmse": round(math.sqrt(sum(e * e for e in errors) / n), 4),
        "busy_mae": round(sum(abs(p - t) for p, t in busy) / max(len(busy), 1), 4),
        "rows": len(errors),
        "busy_rows": len(busy),
    }


def main() -> None:
    try:
        import joblib
        from sklearn.ensemble import HistGradientBoostingRegressor
    except ImportError as error:
        raise SystemExit('scikit-learn is required: pip install -e ".[ml]"') from error

    args = parse_args()
    csv_path = args.dataset / "zone_telemetry.csv"
    if not csv_path.exists():
        raise SystemExit(f"{csv_path} not found. Run: python -m scripts.generate_dataset")
    with csv_path.open(encoding="utf-8") as handle:
        records = list(csv.DictReader(handle))

    run_ids = sorted({record["run_id"] for record in records})
    n_train = int(len(run_ids) * 0.7)
    n_val = int(len(run_ids) * 0.15)
    split = {run: "train" for run in run_ids[:n_train]}
    split |= {run: "validation" for run in run_ids[n_train : n_train + n_val]}
    split |= {run: "test" for run in run_ids[n_train + n_val :]}
    parts = {name: [r for r in records if split[r["run_id"]] == name] for name in ("train", "validation", "test")}

    models = {}
    report: dict[str, object] = {
        "dataset": str(args.dataset),
        "features": FEATURES,
        "split": {"by": "run_id (grouped, ordered)", **{k: len(v) for k, v in parts.items()}},
        "runs": {k: sum(1 for r in run_ids if split[r] == k) for k in ("train", "validation", "test")},
        "horizons": {},
    }
    for horizon in HORIZONS:
        target = f"target_density_t{horizon}"
        x_train = [feature_row(r) for r in parts["train"]]
        y_train = [float(r[target]) for r in parts["train"]]
        model = HistGradientBoostingRegressor(
            max_iter=300, learning_rate=0.06, max_leaf_nodes=31, l2_regularization=0.1, random_state=0
        )
        model.fit(x_train, y_train)
        models[horizon] = model
        horizon_report = {}
        for name in ("validation", "test"):
            rows = parts[name]
            truth = [float(r[target]) for r in rows]
            horizon_report[name] = {
                "gbm": metrics(truth, [max(0.0, float(v)) for v in model.predict([feature_row(r) for r in rows])]),
                "baseline": metrics(truth, [float(r[f"baseline_density_t{horizon}"]) for r in rows]),
                "persistence": metrics(truth, [float(r["density"]) for r in rows]),
            }
        report["horizons"][str(horizon)] = horizon_report

    args.output.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"models": models, "metadata": report}, args.output)
    report_path = args.output.with_suffix(".metrics.json")
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    print(f"Saved model to {args.output}")
    print(f"Runs: {report['runs']}  rows: {report['split']}")
    for horizon, horizon_report in report["horizons"].items():
        test = horizon_report["test"]
        print(
            f"  +{horizon} min test MAE  gbm={test['gbm']['mae']:.4f}  "
            f"baseline={test['baseline']['mae']:.4f}  persistence={test['persistence']['mae']:.4f}  "
            f"| busy-zone MAE gbm={test['gbm']['busy_mae']:.4f} baseline={test['baseline']['busy_mae']:.4f}"
        )


if __name__ == "__main__":
    main()
