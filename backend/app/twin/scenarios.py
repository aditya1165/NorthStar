"""Scenario sampling and before/after comparison for reproducible twin runs."""

import json
import random
from dataclasses import asdict, dataclass, field

from app.shared.models import ZoneTelemetry
from app.twin.field import StadiumTwin, TwinParams
from app.twin.layout import GATE_IDS
from app.twin.runner import RunMetrics, TwinRunner, closure_events

SCENARIO_KINDS = ("normal", "single_closure", "multi_closure", "reopen")
DEFAULT_MIX = {"normal": 0.25, "single_closure": 0.35, "multi_closure": 0.2, "reopen": 0.2}
MAX_RUN_MINUTES = 120.0


@dataclass(frozen=True)
class Scenario:
    run_id: str
    kind: str
    seed: int
    speed_scale: float = 1.0
    release_scale: float = 1.0
    capacity_scale: float = 1.0
    closures: tuple[tuple[float, str, float | None], ...] = ()

    @property
    def params(self) -> TwinParams:
        return TwinParams(
            seed=self.seed,
            speed_scale=self.speed_scale,
            release_scale=self.release_scale,
            capacity_scale=self.capacity_scale,
        )

    def closures_json(self) -> str:
        return json.dumps([list(c) for c in self.closures])

    def as_dict(self) -> dict:
        data = asdict(self)
        data["closures"] = self.closures_json()
        return data


def sample_scenarios(runs: int, master_seed: int = 7, mix: dict[str, float] | None = None) -> list[Scenario]:
    """Deterministically sample ``runs`` scenarios covering every scenario kind."""
    rng = random.Random(master_seed)
    mix = mix or DEFAULT_MIX
    kinds: list[str] = []
    for kind in SCENARIO_KINDS:
        kinds.extend([kind] * round(runs * mix.get(kind, 0)))
    while len(kinds) < runs:
        kinds.append(SCENARIO_KINDS[len(kinds) % len(SCENARIO_KINDS)])
    kinds = kinds[:runs]
    rng.shuffle(kinds)

    scenarios = []
    for index, kind in enumerate(kinds):
        closures: list[tuple[float, str, float | None]] = []
        if kind == "single_closure":
            closures.append((round(rng.uniform(0.5, 5.0), 2), rng.choice(GATE_IDS), None))
        elif kind == "multi_closure":
            gates = rng.sample(GATE_IDS, rng.choice((2, 3)))
            start = rng.uniform(0.5, 4.0)
            for offset, gate in enumerate(gates):
                closures.append((round(start + offset * rng.uniform(0.3, 1.5), 2), gate, None))
        elif kind == "reopen":
            start = rng.uniform(0.5, 3.5)
            closures.append((round(start, 2), rng.choice(GATE_IDS), round(start + rng.uniform(1.5, 4.5), 2)))
        scenarios.append(
            Scenario(
                run_id=f"run_{index:04d}",
                kind=kind,
                seed=1_000 + index,
                speed_scale=round(rng.uniform(0.85, 1.15), 3),
                release_scale=round(rng.uniform(0.7, 1.5), 3),
                capacity_scale=round(rng.uniform(0.75, 1.1), 3),
                closures=tuple(closures),
            )
        )
    return scenarios


@dataclass
class ScenarioRun:
    scenario: Scenario
    policy: str
    metrics: RunMetrics
    samples: list[tuple[float, list[ZoneTelemetry]]] = field(default_factory=list)
    exited_fraction: list[float] = field(default_factory=list)


def run_scenario(
    scenario: Scenario,
    policy: str = "engine",
    with_closures: bool = True,
    record_every_seconds: float | None = None,
) -> ScenarioRun:
    twin = StadiumTwin(scenario.params)
    events = closure_events(list(scenario.closures)) if with_closures else []
    result = ScenarioRun(scenario=scenario, policy=policy, metrics=RunMetrics())
    next_record = [0.0]

    def record(seconds: float, zones: list[ZoneTelemetry]) -> None:
        if record_every_seconds is None or seconds < next_record[0] - 1e-6:
            return
        next_record[0] += record_every_seconds
        result.samples.append((seconds, zones))
        result.exited_fraction.append(twin.exited_count() / twin.count)

    runner = TwinRunner(twin, policy=policy, events=events, on_measure=record)
    result.metrics = runner.run_until_clear(MAX_RUN_MINUTES)
    return result


def before_after(scenario: Scenario) -> dict[str, RunMetrics]:
    """All gates open vs closure without guidance vs closure with Python routing."""
    return {
        "all_open": run_scenario(scenario, "engine", with_closures=False).metrics,
        "closed_no_reroute": run_scenario(scenario, "naive").metrics,
        "closed_with_reroute": run_scenario(scenario, "engine").metrics,
    }
