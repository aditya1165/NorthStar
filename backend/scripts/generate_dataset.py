import argparse
import os
from pathlib import Path

from app.datasets import generate_dataset

REPO_ROOT = Path(__file__).resolve().parents[2]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the reproducible CrowdGuardian zone-telemetry dataset.",
    )
    parser.add_argument("--runs", type=int, default=100, help="Number of scenario runs (default 100).")
    parser.add_argument("--seed", type=int, default=7, help="Master seed for scenario sampling.")
    parser.add_argument(
        "--output",
        type=Path,
        default=REPO_ROOT / "data" / "generated" / "crowd_v1",
        help="Output directory (default data/generated/crowd_v1).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, min(8, (os.cpu_count() or 2) - 1)),
        help="Parallel worker processes.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    result = generate_dataset(args.output, runs=args.runs, master_seed=args.seed, workers=args.workers)
    manifest = result["manifest"]
    print(f"Wrote {manifest['runs']} runs / {manifest['zone_rows']} zone rows to {args.output}")
    print(f"Scenario mix: {manifest['scenario_counts']}")
    print("\nBefore/after (means per scenario kind):")
    for row in result["before_after"]:
        print(
            f"  {row['scenario']:<15} {row['condition']:<20} runs={row['runs']:<3} "
            f"clearance={row['mean_clearance_minutes']:>6} min  "
            f"peak={row['mean_peak_density']:>5} p/m²  "
            f"max_queue={row['mean_max_queue']:>6}  "
            f"redirected={row['mean_people_redirected']}"
        )


if __name__ == "__main__":
    main()
