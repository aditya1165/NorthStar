import argparse
import json
from pathlib import Path

from app.forecasting import FlowBaseline
from app.shared.models import SimulationSnapshot
from app.simulation import CrowdSimulation


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the deterministic CrowdGuardian forecast baseline.",
    )
    parser.add_argument(
        "--input",
        type=Path,
        help="Optional JSON file containing a SimulationSnapshot.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        help="Optional path for the forecast JSON. Defaults to stdout.",
    )
    parser.add_argument(
        "--horizons",
        type=int,
        nargs="+",
        default=[5, 10],
        help="Forecast horizons in minutes. Defaults to 5 and 10.",
    )
    parser.add_argument(
        "--steps",
        type=int,
        default=0,
        help="Number of 30-second demo-simulation steps before forecasting.",
    )
    parser.add_argument(
        "--gate-b-closed",
        action="store_true",
        help="Activate the Gate B closure in the built-in demo snapshot.",
    )
    parser.add_argument(
        "--metro-delayed",
        action="store_true",
        help="Activate the metro delay in the built-in demo snapshot.",
    )
    return parser.parse_args()


def load_snapshot(args: argparse.Namespace) -> SimulationSnapshot:
    if args.input:
        return SimulationSnapshot.model_validate_json(args.input.read_text())

    simulation = CrowdSimulation()
    if args.gate_b_closed:
        simulation.set_incident("gate-b-closure", True)
    if args.metro_delayed:
        simulation.set_incident("metro-delay", True)
    for _ in range(args.steps):
        simulation.step()
    return simulation.snapshot()


def main() -> None:
    args = parse_args()
    snapshot = load_snapshot(args)
    forecasts = FlowBaseline().predict(
        snapshot,
        horizons_minutes=tuple(args.horizons),
    )
    payload = json.dumps(
        [forecast.model_dump(mode="json") for forecast in forecasts],
        indent=2,
    )

    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(f"{payload}\n")
    else:
        print(payload)


if __name__ == "__main__":
    main()

