"""Generate a synthetic gate-level forecasting dataset for the stadium egress scenario.

The dataset is produced by a lightweight, seeded, standalone Python egress simulation.
It is NOT real-world sensor data and does not use JuPedSim or any external pedestrian
simulator. Venue population, gates, geometry, and capacities come from
``shared/stadium-config.json``; risk labels come from the backend congestion detector's
own thresholds and classification rules.

Run from the ``backend`` directory:

    python -m scripts.generate_forecasting_dataset --runs 120 --seed 20261017
"""

import argparse
import csv
import hashlib
import heapq
import json
import math
import random
from collections import Counter, deque
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from app.congestion.config import GATES, THRESHOLDS
from app.congestion.detector import CongestionDetector, _polygon_area

GENERATOR_VERSION = "1.1.0"
DEFAULT_MASTER_SEED = 20261017
DEFAULT_RUNS = 120
DEFAULT_DURATION_SECONDS = 30 * 60
DEFAULT_INTERVAL_SECONDS = 30
HORIZONS_MINUTES = (5, 10)
# The CLI fails if fewer rows than this have a non-zero 10-minute queue target.
DEFAULT_MIN_TEN_MINUTE_COVERAGE = 0.08

REPO_ROOT = Path(__file__).resolve().parents[2]
STADIUM_CONFIG_PATH = REPO_ROOT / "shared" / "stadium-config.json"
DEFAULT_OUTPUT_DIR = REPO_ROOT / "data" / "generated"
CSV_NAME = "stadium_forecasting.csv"
MANIFEST_NAME = "stadium_forecasting_manifest.json"

SCENARIO_TYPES = (
    "all_gates_open",
    "one_gate_closed",
    "two_gates_closed",
    "gate_reopens",
    "high_initial_load",
    "uneven_distribution",
    "reduced_walking_speed",
    "reduced_gate_capacity",
    "delayed_release",
)

# Movement constants mirrored from the live frontend model
# (frontend/src/twin/sim/crowdField.ts and frontend/src/twin/mock/venue.ts). The shared
# config does not define them, so they are documented here rather than invented.
SECTION_COUNT = 24
SECTION_START_DEG = -30.0
SECTION_STEP_DEG = 15.0
SEAT_JITTER_DEG = 5.5
WALK_SPEED_SCENE_UNITS_PER_MIN = 13.0
QUEUE_INNER_SCALE = 1.07
GATE_PORTAL_SCALE = 1.32
QUEUE_PENALTY_M_PER_PERSON = 0.12
DENSITY_PENALTY_M_PER_UNIT = 4.0
CONGESTION_PENALTY_M = 20.0
REROUTE_MARGIN_M = 12.0
REROUTE_COOLDOWN_SECONDS = 30.0

# One scenario block in five keeps the frontend's default release timing; the rest use
# wider or two-wave releases so crowds persist long enough for 10-minute targets.
FRONTEND_DEFAULT_RELEASE_EVERY = 5

ID_COLUMNS = ("run_id", "scenario_type", "seed")
FEATURE_COLUMNS = (
    "simulation_time_seconds",
    "gate_id",
    "gate_open",
    "gate_capacity_per_min",
    "people_count",
    "assigned_people",
    "arrivals_per_min",
    "queue_length",
    "density_per_m2",
    "mean_speed_mps",
    "throughput_per_min",
    "number_of_closed_gates",
    "people_remaining_in_venue",
    "nearby_gate_congested",
    "risk_level",
)
TARGET_COLUMNS = tuple(
    f"{metric}_after_{horizon}_minutes"
    for horizon in HORIZONS_MINUTES
    for metric in ("queue", "density", "risk")
)
CSV_COLUMNS = ID_COLUMNS + FEATURE_COLUMNS + TARGET_COLUMNS

DATA_LIMITATIONS = (
    "Synthetic simulation data only; no real-world sensor, ticketing, or video data is used.",
    "Produced by a simplified standalone Python egress model, not by JuPedSim or any "
    "calibrated pedestrian simulator, and not by recording the live frontend.",
    "Walkers follow fixed seat -> base path -> gate legs without collision physics or "
    "density-dependent slowdown; queued people are stationary (speed 0), as in the frontend.",
    "Gate choice mirrors the frontend rule: nearest gate first, rerouting only on closure "
    "or persistence-confirmed congestion, with the frontend route cost, margin and cooldown.",
    "Risk labels use the backend detector's instantaneous threshold rules without "
    "trigger/clear persistence.",
    "Gate capacities and congestion thresholds are prototype engineering defaults, not "
    "certified crowd-safety limits.",
    "Queue length counts every person waiting at a gate; the live detector counts only "
    "queued people inside the gate approach polygon, which holds the whole simulated queue.",
    "Rows near the end of each run without a full 10-minute future window are removed.",
    "Rows after every person has left the venue are removed; their targets are all zero.",
    "Release timing is varied beyond the frontend default (wider windows and two-wave "
    "releases) to cover longer-lived congestion; these profiles are assumptions, not "
    "measured stadium behaviour.",
)


@dataclass(frozen=True)
class GateSpec:
    gate_id: str
    label: str
    angle_deg: float
    capacity_per_min: float
    approach_area_m2: float


@dataclass(frozen=True)
class Stadium:
    version: str
    population: int
    meters_per_unit: float
    average_radius_units: float
    base_path_scale: float
    seat_inner_scale: float
    seat_outer_scale: float
    gates: tuple[GateSpec, ...]

    @property
    def gate_ids(self) -> tuple[str, ...]:
        return tuple(gate.gate_id for gate in self.gates)

    def neighbours(self) -> dict[str, tuple[str, str]]:
        ordered = sorted(self.gates, key=lambda gate: gate.angle_deg % 360)
        count = len(ordered)
        return {
            gate.gate_id: (
                ordered[(index - 1) % count].gate_id,
                ordered[(index + 1) % count].gate_id,
            )
            for index, gate in enumerate(ordered)
        }


@dataclass(frozen=True)
class GateEvent:
    time_seconds: int
    gate_id: str
    open: bool


@dataclass(frozen=True)
class RunPlan:
    run_id: str
    scenario_type: str
    seed: int
    events: tuple[GateEvent, ...] = ()
    capacity_factors: tuple[tuple[str, float], ...] = ()
    speed_factor: float = 1.0
    release_delay_s: float = 0.0
    section_stagger_s: float = 120.0
    individual_spread_s: float = 120.0
    initial_queue_fraction: float = 0.0
    hotspot_angle_deg: float | None = None
    hotspot_concentration: float = 0.0
    release_profile: str = "frontend_default"
    second_wave_fraction: float = 0.0
    second_wave_delay_s: float = 0.0


def load_stadium(path: Path = STADIUM_CONFIG_PATH) -> Stadium:
    with path.open(encoding="utf-8") as config_file:
        config = json.load(config_file)

    meters_per_unit = float(config["metersPerSceneUnit"])
    polygons = {gate.gate_id: gate.approach_polygon for gate in GATES}
    default_capacity = float(config["gateDefaults"]["capacityPerMinute"])
    gates = []
    for gate in config["gates"]:
        gate_id = str(gate["id"])
        if gate_id not in polygons:
            raise ValueError(f"Gate {gate_id} has no detector approach polygon")
        gates.append(
            GateSpec(
                gate_id=gate_id,
                label=str(gate["label"]),
                angle_deg=float(gate["angleDeg"]),
                capacity_per_min=float(gate.get("capacityPerMinute", default_capacity)),
                approach_area_m2=_polygon_area(polygons[gate_id]) * meters_per_unit**2,
            )
        )
    return Stadium(
        version=str(config["version"]),
        population=int(config["population"]),
        meters_per_unit=meters_per_unit,
        average_radius_units=(float(config["bowl"]["rx"]) + float(config["bowl"]["rz"])) / 2,
        base_path_scale=float(config["ring"]["basePath"]),
        seat_inner_scale=float(config["ring"]["seatInner"]),
        seat_outer_scale=float(config["ring"]["seatOuter"]),
        gates=tuple(gates),
    )


# The detector's own classifier is reused so labels can never drift from its thresholds.
_RISK_CLASSIFIER = CongestionDetector()


def classify_risk(density: float, queue: int, mean_speed: float, people_count: int) -> str:
    return _RISK_CLASSIFIER._raw_level(density, queue, mean_speed, people_count).value


def _angle_delta(from_deg: float, to_deg: float) -> float:
    return (to_deg - from_deg + 180.0) % 360.0 - 180.0


def derive_run_seeds(master_seed: int, runs: int) -> list[int]:
    master = random.Random(master_seed)
    seeds: list[int] = []
    seen: set[int] = set()
    while len(seeds) < runs:
        seed = master.randrange(1, 2**31)
        if seed not in seen:
            seen.add(seed)
            seeds.append(seed)
    return seeds


def validate_gate_schedule(plan: RunPlan, gate_ids: tuple[str, ...]) -> None:
    """Reject any schedule in which every gate is closed at the same time."""
    open_gates = set(gate_ids)
    for event in sorted(plan.events, key=lambda item: item.time_seconds):
        if event.gate_id not in gate_ids:
            raise ValueError(f"Unknown gate in schedule: {event.gate_id}")
        if event.open:
            open_gates.add(event.gate_id)
        else:
            open_gates.discard(event.gate_id)
        if not open_gates:
            raise ValueError(f"{plan.run_id}: every gate would be closed simultaneously")


def plan_run(index: int, seed: int, stadium: Stadium) -> RunPlan:
    scenario = SCENARIO_TYPES[index % len(SCENARIO_TYPES)]
    rng = random.Random(f"plan:{seed}")
    gate_ids = stadium.gate_ids
    params: dict = {
        "speed_factor": round(rng.uniform(0.95, 1.05), 3),
        "section_stagger_s": round(rng.uniform(90, 150), 1),
        "individual_spread_s": round(rng.uniform(90, 150), 1),
    }

    block = index // len(SCENARIO_TYPES)
    if block % FRONTEND_DEFAULT_RELEASE_EVERY == 0:
        profile = "frontend_default"
    else:
        profile = "spread" if rng.random() < 0.25 else "two_wave"
    if profile == "spread":
        window = rng.uniform(180, 480)
        share = rng.uniform(0.3, 0.6)
        params["section_stagger_s"] = round(window * share, 1)
        params["individual_spread_s"] = round(window * (1 - share), 1)
    elif profile == "two_wave":
        params["second_wave_fraction"] = round(rng.uniform(0.3, 0.7), 3)
        params["second_wave_delay_s"] = round(rng.uniform(300, 900), 1)

    if scenario == "one_gate_closed":
        params["events"] = (GateEvent(rng.randint(30, 480), rng.choice(gate_ids), False),)
    elif scenario == "two_gates_closed":
        first, second = rng.sample(gate_ids, 2)
        params["events"] = (
            GateEvent(rng.randint(30, 480), first, False),
            GateEvent(rng.randint(30, 600), second, False),
        )
    elif scenario == "gate_reopens":
        gate = rng.choice(gate_ids)
        closed_at = rng.randint(30, 360)
        params["events"] = (
            GateEvent(closed_at, gate, False),
            GateEvent(closed_at + rng.randint(120, 600), gate, True),
        )
    elif scenario == "high_initial_load":
        params["initial_queue_fraction"] = round(rng.uniform(0.15, 0.3), 3)
        params["section_stagger_s"] = round(rng.uniform(20, 50), 1)
        params["individual_spread_s"] = round(rng.uniform(20, 50), 1)
    elif scenario == "uneven_distribution":
        params["hotspot_angle_deg"] = round(rng.uniform(-180, 180), 1)
        params["hotspot_concentration"] = round(rng.uniform(1.0, 2.5), 3)
    elif scenario == "reduced_walking_speed":
        params["speed_factor"] = round(rng.uniform(0.55, 0.8), 3)
    elif scenario == "reduced_gate_capacity":
        if rng.random() < 0.5:
            reduced = sorted(rng.sample(gate_ids, rng.randint(1, 3)))
            params["capacity_factors"] = tuple(
                (gate, round(rng.uniform(0.4, 0.7), 3)) for gate in reduced
            )
        else:
            factor = round(rng.uniform(0.6, 0.85), 3)
            params["capacity_factors"] = tuple((gate, factor) for gate in gate_ids)
    elif scenario == "delayed_release":
        params["release_delay_s"] = round(rng.uniform(120, 480), 1)
        params["section_stagger_s"] = round(rng.uniform(150, 300), 1)
        params["individual_spread_s"] = round(rng.uniform(150, 300), 1)
    if scenario in {"high_initial_load", "delayed_release"} and profile != "two_wave":
        # These scenarios define their own first-wave release timing.
        profile = "scenario_defined"
    params["release_profile"] = profile

    plan = RunPlan(run_id=f"run_{index:04d}", scenario_type=scenario, seed=seed, **params)
    validate_gate_schedule(plan, gate_ids)
    return plan


def build_run_plans(runs: int, master_seed: int, stadium: Stadium) -> list[RunPlan]:
    if runs < 1:
        raise ValueError("At least one run is required")
    seeds = derive_run_seeds(master_seed, runs)
    return [plan_run(index, seed, stadium) for index, seed in enumerate(seeds)]


_WAITING, _EN_ROUTE, _QUEUED, _EXITED = range(4)


def simulate_run(
    plan: RunPlan,
    stadium: Stadium,
    duration_seconds: int = DEFAULT_DURATION_SECONDS,
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
) -> list[dict]:
    """Simulate one run at 1-second resolution and return one row per gate per sample."""
    rng = random.Random(f"agents:{plan.seed}")
    population = stadium.population
    gate_ids = stadium.gate_ids
    gate_count = len(gate_ids)
    gate_index = {gate_id: index for index, gate_id in enumerate(gate_ids)}
    gate_angles = [gate.angle_deg for gate in stadium.gates]
    areas = [gate.approach_area_m2 for gate in stadium.gates]
    factors = dict(plan.capacity_factors)
    capacities = [gate.capacity_per_min * factors.get(gate.gate_id, 1.0) for gate in stadium.gates]
    neighbours = {
        gate_index[gate_id]: tuple(gate_index[other] for other in pair)
        for gate_id, pair in stadium.neighbours().items()
    }
    events: dict[int, list[GateEvent]] = {}
    for event in plan.events:
        events.setdefault(event.time_seconds, []).append(event)

    meters = stadium.meters_per_unit * stadium.average_radius_units
    base_radius_m = meters * stadium.base_path_scale
    outward_m = meters * (QUEUE_INNER_SCALE - stadium.base_path_scale)
    portal_m = meters * (GATE_PORTAL_SCALE - QUEUE_INNER_SCALE)

    # Seating layout and per-person walking speed, mirroring the frontend model.
    if plan.hotspot_angle_deg is not None:
        weights = [
            math.exp(
                plan.hotspot_concentration
                * math.cos(
                    math.radians(
                        _angle_delta(
                            plan.hotspot_angle_deg, SECTION_START_DEG + k * SECTION_STEP_DEG
                        )
                    )
                )
            )
            for k in range(SECTION_COUNT)
        ]
        sections = rng.choices(range(SECTION_COUNT), weights=weights, k=population)
    else:
        sections = [person % SECTION_COUNT for person in range(population)]

    seat_span = stadium.seat_outer_scale - stadium.seat_inner_scale - 0.08
    seat_angle = [0.0] * population
    leg1_m = [0.0] * population  # distance still needed to reach the base path
    origin_angle = [0.0] * population  # base-path angle where the gate arc starts
    speed = [0.0] * population
    release = [0.0] * population
    for person in range(population):
        section = sections[person]
        seat_angle[person] = (
            SECTION_START_DEG
            + section * SECTION_STEP_DEG
            + (rng.random() - 0.5) * 2 * SEAT_JITTER_DEG
        )
        seat_scale = stadium.seat_inner_scale + 0.05 + rng.random() * seat_span
        leg1_m[person] = (seat_scale - stadium.base_path_scale) * meters
        origin_angle[person] = seat_angle[person]
        base_mps = (
            (0.8 + rng.random() * 0.4)
            * WALK_SPEED_SCENE_UNITS_PER_MIN
            * stadium.meters_per_unit
            / 60
        )
        speed[person] = base_mps * plan.speed_factor
        second_wave = plan.second_wave_fraction > 0 and rng.random() < plan.second_wave_fraction
        release[person] = (
            plan.release_delay_s
            + (plan.second_wave_delay_s if second_wave else 0.0)
            + section / SECTION_COUNT * plan.section_stagger_s
            + rng.random() * plan.individual_spread_s
        )

    status = [_WAITING] * population
    target = [-1] * population
    version = [0] * population
    depart = [0.0] * population
    last_reroute = [-math.inf] * population
    arrival_heap: list[tuple[float, int, int]] = []

    gate_open = [True] * gate_count
    queues: list[deque[int]] = [deque() for _ in range(gate_count)]
    en_route: list[set[int]] = [set() for _ in range(gate_count)]
    credit = [0.0] * gate_count
    exit_times: list[deque[int]] = [deque() for _ in range(gate_count)]
    exiting: list[list[tuple[float, float]]] = [[] for _ in range(gate_count)]
    exiting_speed_sum = [0.0] * gate_count
    arrivals_since_sample = [0] * gate_count
    queue_signal = [0] * gate_count
    density_signal = [0.0] * gate_count
    # Persistence-confirmed congestion, which is what the frontend router consumes.
    congested = [False] * gate_count
    candidate_since: list[float | None] = [None] * gate_count
    clear_since: list[float | None] = [None] * gate_count
    exited_total = 0
    waiting_total = population
    t = THRESHOLDS

    def arc_m(from_angle: float, gate: int) -> float:
        return abs(math.radians(_angle_delta(from_angle, gate_angles[gate]))) * base_radius_m

    def nearest_gate(angle: float) -> int:
        return min(range(gate_count), key=lambda gate: abs(_angle_delta(angle, gate_angles[gate])))

    def route_cost(person: int, angle: float, gate: int) -> float:
        return (
            arc_m(angle, gate)
            + queue_signal[gate] * QUEUE_PENALTY_M_PER_PERSON
            + density_signal[gate] * DENSITY_PENALTY_M_PER_UNIT
            + (CONGESTION_PENALTY_M if congested[gate] else 0.0)
            + ((person * 17 + gate * 31) % 19) * 0.03
        )

    def select_gate(person: int, angle: float, current: int) -> int:
        """Keep the current gate unless it is closed or confirmed congested (frontend rule)."""
        if gate_open[current] and not congested[current]:
            return current
        options = [gate for gate in range(gate_count) if gate_open[gate] and gate != current]
        if not options:
            return current
        best = min(options, key=lambda gate: (route_cost(person, angle, gate), gate))
        if gate_open[current] and (
            route_cost(person, angle, best) + REROUTE_MARGIN_M >= route_cost(person, angle, current)
        ):
            return current
        return best

    def dispatch(person: int, now: float, gate: int) -> None:
        target[person] = gate
        status[person] = _EN_ROUTE
        version[person] += 1
        depart[person] = now
        en_route[gate].add(person)
        walk = leg1_m[person] + arc_m(origin_angle[person], gate) + outward_m
        heapq.heappush(arrival_heap, (now + walk / speed[person], person, version[person]))

    def current_position(person: int, now: float) -> tuple[float, float, bool]:
        """Return (distance back to the base path, base-path angle, has reached base path)."""
        gate = target[person]
        traveled = (now - depart[person]) * speed[person]
        arc = arc_m(origin_angle[person], gate)
        if traveled < leg1_m[person]:
            return leg1_m[person] - traveled, origin_angle[person], False
        if traveled < leg1_m[person] + arc:
            direction = math.copysign(1.0, _angle_delta(origin_angle[person], gate_angles[gate]))
            along = traveled - leg1_m[person]
            return 0.0, origin_angle[person] + direction * math.degrees(along / base_radius_m), True
        return min(outward_m, traveled - leg1_m[person] - arc), gate_angles[gate], True

    def reroute_walker(person: int, now: float, forced: bool) -> None:
        if not forced and now - last_reroute[person] < REROUTE_COOLDOWN_SECONDS:
            return
        old_gate = target[person]
        back_m, angle, on_base_path = current_position(person, now)
        if not forced and not on_base_path:
            return  # The frontend re-evaluates only on the base path and gate corridor.
        new_gate = select_gate(person, angle, old_gate)
        if new_gate == old_gate:
            return
        en_route[old_gate].discard(person)
        leg1_m[person], origin_angle[person] = back_m, angle
        last_reroute[person] = now
        dispatch(person, now, new_gate)

    def close_gate(gate: int, now: float) -> None:
        for person in queues[gate]:
            # Queued people walk back to the base path before choosing a new gate.
            leg1_m[person] = outward_m
            origin_angle[person] = gate_angles[gate]
            last_reroute[person] = now
            dispatch(person, now, select_gate(person, gate_angles[gate], gate))
        queues[gate].clear()
        for person in sorted(en_route[gate]):
            reroute_walker(person, now, forced=True)

    # High-initial-load runs start with part of the crowd already queued at gates.
    order = sorted(range(population), key=lambda person: (release[person], person))
    if plan.initial_queue_fraction > 0:
        count = round(population * plan.initial_queue_fraction)
        preloaded = set(rng.sample(range(population), count))
        for person in sorted(preloaded):
            gate = nearest_gate(seat_angle[person])
            target[person] = gate
            status[person] = _QUEUED
            queues[gate].append(person)
        waiting_total -= len(preloaded)
        order = [person for person in order if person not in preloaded]

    rows: list[dict] = []
    next_release = 0
    for now in range(duration_seconds + 1):
        for event in events.get(now, ()):
            gate = gate_index[event.gate_id]
            gate_open[gate] = event.open
            if not event.open:
                credit[gate] = 0.0
                close_gate(gate, now)

        while next_release < len(order) and release[order[next_release]] <= now:
            person = order[next_release]
            nearest = nearest_gate(seat_angle[person])
            dispatch(person, now, select_gate(person, seat_angle[person], nearest))
            waiting_total -= 1
            next_release += 1

        for gate in range(gate_count):
            if congested[gate] and gate_open[gate]:
                for person in sorted(en_route[gate]):
                    reroute_walker(person, now, forced=False)

        while arrival_heap and arrival_heap[0][0] <= now:
            _, person, person_version = heapq.heappop(arrival_heap)
            if version[person] != person_version or status[person] != _EN_ROUTE:
                continue
            gate = target[person]
            en_route[gate].discard(person)
            status[person] = _QUEUED
            queues[gate].append(person)
            arrivals_since_sample[gate] += 1

        for gate in range(gate_count):
            if not gate_open[gate]:
                continue
            per_second = capacities[gate] / 60
            # Leftover fractional credit carries over, but an idle gate cannot bank a burst.
            credit[gate] = min(credit[gate], 1.0) + per_second
            while credit[gate] >= 1 and queues[gate]:
                person = queues[gate].popleft()
                credit[gate] -= 1
                status[person] = _EXITED
                exited_total += 1
                exit_times[gate].append(now)
                heapq.heappush(exiting[gate], (now + portal_m / speed[person], speed[person]))
                exiting_speed_sum[gate] += speed[person]

        levels = [""] * gate_count
        people_counts = [0] * gate_count
        mean_speeds = [0.0] * gate_count
        for gate in range(gate_count):
            while exiting[gate] and exiting[gate][0][0] <= now:
                _, walker_speed = heapq.heappop(exiting[gate])
                exiting_speed_sum[gate] -= walker_speed
            while exit_times[gate] and exit_times[gate][0] < now - 60:
                exit_times[gate].popleft()
            queue = len(queues[gate])
            people = queue + len(exiting[gate])
            density = people / areas[gate]
            mean_speed = max(0.0, exiting_speed_sum[gate]) / people if people else 0.0
            levels[gate] = classify_risk(density, queue, mean_speed, people)
            people_counts[gate] = people
            mean_speeds[gate] = mean_speed
            queue_signal[gate] = queue
            density_signal[gate] = density

            # Same trigger/clear conditions and persistence as CongestionDetector.
            candidate = (
                density >= t.high_density and mean_speed <= t.queue_speed_mps
            ) or queue >= t.high_queue
            clear = people == 0 or (
                density < t.clear_density
                and queue < t.clear_queue
                and mean_speed > t.clear_speed_mps
            )
            if candidate:
                clear_since[gate] = None
                if candidate_since[gate] is None:
                    candidate_since[gate] = now
                if now - candidate_since[gate] >= t.trigger_persistence_seconds:
                    congested[gate] = True
            else:
                candidate_since[gate] = None
                if congested[gate] and clear:
                    if clear_since[gate] is None:
                        clear_since[gate] = now
                    if now - clear_since[gate] >= t.clear_persistence_seconds:
                        congested[gate] = False
                        clear_since[gate] = None
                else:
                    clear_since[gate] = None

        if now % interval_seconds:
            continue

        queued_total = sum(len(queue) for queue in queues)
        if waiting_total + sum(map(len, en_route)) + queued_total + exited_total != population:
            raise RuntimeError(f"{plan.run_id}: population accounting error at t={now}s")
        closed_count = gate_open.count(False)
        if closed_count == gate_count:
            raise RuntimeError(f"{plan.run_id}: every gate closed at t={now}s")

        for gate, gate_id in enumerate(gate_ids):
            rows.append(
                {
                    "run_id": plan.run_id,
                    "scenario_type": plan.scenario_type,
                    "seed": plan.seed,
                    "simulation_time_seconds": now,
                    "gate_id": gate_id,
                    "gate_open": int(gate_open[gate]),
                    "gate_capacity_per_min": round(capacities[gate], 2),
                    "people_count": people_counts[gate],
                    "assigned_people": len(en_route[gate]) + len(queues[gate]),
                    "arrivals_per_min": round(
                        arrivals_since_sample[gate] * 60 / interval_seconds, 2
                    ),
                    "queue_length": len(queues[gate]),
                    "density_per_m2": round(density_signal[gate], 3),
                    "mean_speed_mps": round(mean_speeds[gate], 3),
                    "throughput_per_min": len(exit_times[gate]),
                    "number_of_closed_gates": closed_count,
                    "people_remaining_in_venue": population - exited_total,
                    "nearby_gate_congested": int(
                        any(congested[other] for other in neighbours[gate])
                    ),
                    "risk_level": levels[gate],
                }
            )
            arrivals_since_sample[gate] = 0
    return rows


def add_future_targets(
    rows: list[dict], horizons_minutes: tuple[int, ...] = HORIZONS_MINUTES
) -> None:
    """Attach future targets in place, looking forward only within the same run and gate.

    Targets without a matching future row are set to ``None``.
    """
    by_key = {(row["run_id"], row["gate_id"], row["simulation_time_seconds"]): row for row in rows}
    for row in rows:
        for horizon in horizons_minutes:
            future = by_key.get(
                (row["run_id"], row["gate_id"], row["simulation_time_seconds"] + horizon * 60)
            )
            row[f"queue_after_{horizon}_minutes"] = future["queue_length"] if future else None
            row[f"density_after_{horizon}_minutes"] = future["density_per_m2"] if future else None
            # risk_level was assigned by the detector's classifier when the row was recorded.
            row[f"risk_after_{horizon}_minutes"] = future["risk_level"] if future else None


def drop_incomplete_targets(rows: list[dict]) -> list[dict]:
    return [row for row in rows if all(row.get(column) is not None for column in TARGET_COLUMNS)]


def drop_cleared_venue_rows(rows: list[dict]) -> list[dict]:
    """Remove rows after everyone has left; the venue stays empty, so targets are zero."""
    return [row for row in rows if row["people_remaining_in_venue"] > 0]


def target_coverage(rows: list[dict]) -> dict[str, float]:
    """Fraction of rows with a non-zero value for each numeric target."""
    return {
        column: round(sum(row[column] > 0 for row in rows) / len(rows), 4) if rows else 0.0
        for column in TARGET_COLUMNS
        if not column.startswith("risk_")
    }


def generate_dataset(
    runs: int = DEFAULT_RUNS,
    master_seed: int = DEFAULT_MASTER_SEED,
    duration_seconds: int = DEFAULT_DURATION_SECONDS,
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
    stadium: Stadium | None = None,
) -> tuple[list[dict], list[RunPlan], dict[str, int]]:
    """Return (training rows, run plans, row counts at each filtering stage)."""
    longest_horizon_s = max(HORIZONS_MINUTES) * 60
    if duration_seconds <= longest_horizon_s:
        raise ValueError(f"Duration must exceed the {longest_horizon_s}s forecast horizon")
    if any(horizon * 60 % interval_seconds for horizon in HORIZONS_MINUTES):
        raise ValueError("Sampling interval must divide every forecast horizon")

    stadium = stadium or load_stadium()
    plans = build_run_plans(runs, master_seed, stadium)
    rows: list[dict] = []
    for plan in plans:
        run_rows = simulate_run(plan, stadium, duration_seconds, interval_seconds)
        add_future_targets(run_rows)
        rows.extend(run_rows)
    complete = drop_incomplete_targets(rows)
    final = drop_cleared_venue_rows(complete)
    row_counts = {
        "simulated": len(rows),
        "removed_incomplete_targets": len(rows) - len(complete),
        "removed_cleared_venue": len(complete) - len(final),
        "final": len(final),
    }
    return final, plans, row_counts


def write_csv(rows: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=CSV_COLUMNS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def build_manifest(
    rows: list[dict],
    plans: list[RunPlan],
    row_counts: dict[str, int],
    master_seed: int,
    duration_seconds: int,
    interval_seconds: int,
    stadium: Stadium,
    csv_path: Path,
) -> dict:
    return {
        "dataset": "CrowdGuardian synthetic stadium egress forecasting dataset",
        "data_origin": "synthetic simulation",
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "generator": "backend/scripts/generate_forecasting_dataset.py",
        "generator_version": GENERATOR_VERSION,
        "stadium_config_version": stadium.version,
        "population": stadium.population,
        "gate_ids": list(stadium.gate_ids),
        "gate_capacities_per_min": {gate.gate_id: gate.capacity_per_min for gate in stadium.gates},
        "master_seed": master_seed,
        "number_of_runs": len(plans),
        "number_of_rows": len(rows),
        "row_counts": row_counts,
        "missing_target_policy": "Rows without a complete 5- and 10-minute future window "
        "within the same run and gate are removed.",
        "cleared_venue_policy": "Rows sampled after every person has exited are removed.",
        "scenario_counts": dict(Counter(plan.scenario_type for plan in plans)),
        "release_profile_counts": dict(Counter(plan.release_profile for plan in plans)),
        "target_nonzero_fraction": target_coverage(rows),
        "minimum_ten_minute_queue_coverage": DEFAULT_MIN_TEN_MINUTE_COVERAGE,
        "sampling_interval_seconds": interval_seconds,
        "simulation_duration_seconds": duration_seconds,
        "simulation_step_seconds": 1,
        "forecast_horizons_minutes": list(HORIZONS_MINUTES),
        "id_columns": list(ID_COLUMNS),
        "feature_columns": list(FEATURE_COLUMNS),
        "target_columns": list(TARGET_COLUMNS),
        "split_guidance": "Split by run_id to avoid leakage; scenario_type is metadata "
        "for stratification and is not available live.",
        "risk_label_source": "app.congestion.detector.CongestionDetector raw level "
        "(instantaneous, no persistence)",
        "risk_thresholds": asdict(THRESHOLDS),
        "training_guidance": "Train regressors for the queue and density targets and "
        "derive risk from the predictions with the detector classifier; instantaneous risk "
        "labels are dominated by the detector's low-speed rule because queued people "
        "are stationary.",
        "csv_file": csv_path.name,
        "csv_sha256": hashlib.sha256(csv_path.read_bytes()).hexdigest(),
        "data_limitations": list(DATA_LIMITATIONS),
        "runs": [
            {
                "run_id": plan.run_id,
                "scenario_type": plan.scenario_type,
                "seed": plan.seed,
                "gate_events": [asdict(event) for event in plan.events],
                "capacity_factors": dict(plan.capacity_factors),
                "speed_factor": plan.speed_factor,
                "release_delay_s": plan.release_delay_s,
                "section_stagger_s": plan.section_stagger_s,
                "individual_spread_s": plan.individual_spread_s,
                "initial_queue_fraction": plan.initial_queue_fraction,
                "hotspot_angle_deg": plan.hotspot_angle_deg,
                "hotspot_concentration": plan.hotspot_concentration,
                "release_profile": plan.release_profile,
                "second_wave_fraction": plan.second_wave_fraction,
                "second_wave_delay_s": plan.second_wave_delay_s,
            }
            for plan in plans
        ],
    }


def write_outputs(
    output_dir: Path,
    runs: int = DEFAULT_RUNS,
    master_seed: int = DEFAULT_MASTER_SEED,
    duration_seconds: int = DEFAULT_DURATION_SECONDS,
    interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
) -> dict:
    stadium = load_stadium()
    rows, plans, row_counts = generate_dataset(
        runs, master_seed, duration_seconds, interval_seconds, stadium
    )
    csv_path = output_dir / CSV_NAME
    write_csv(rows, csv_path)
    manifest = build_manifest(
        rows,
        plans,
        row_counts,
        master_seed,
        duration_seconds,
        interval_seconds,
        stadium,
        csv_path,
    )
    (output_dir / MANIFEST_NAME).write_text(f"{json.dumps(manifest, indent=2)}\n", encoding="utf-8")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the synthetic gate-level stadium forecasting dataset.",
    )
    parser.add_argument("--runs", type=int, default=DEFAULT_RUNS, help="Number of runs.")
    parser.add_argument("--seed", type=int, default=DEFAULT_MASTER_SEED, help="Master seed.")
    parser.add_argument(
        "--duration-minutes",
        type=int,
        default=DEFAULT_DURATION_SECONDS // 60,
        help="Simulated minutes per run (must exceed 10).",
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=DEFAULT_INTERVAL_SECONDS,
        help="Sampling interval in simulated seconds.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Directory for the CSV and manifest.",
    )
    parser.add_argument(
        "--min-coverage",
        type=float,
        default=DEFAULT_MIN_TEN_MINUTE_COVERAGE,
        help="Fail if fewer rows than this have a non-zero 10-minute queue target.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    manifest = write_outputs(
        args.output_dir,
        runs=args.runs,
        master_seed=args.seed,
        duration_seconds=args.duration_minutes * 60,
        interval_seconds=args.interval_seconds,
    )
    print(
        f"Wrote {manifest['number_of_rows']} rows from {manifest['number_of_runs']} runs "
        f"to {args.output_dir / CSV_NAME}"
    )
    coverage = manifest["target_nonzero_fraction"]["queue_after_10_minutes"]
    print(f"Non-zero 10-minute queue targets: {coverage:.1%}")
    if coverage < args.min_coverage:
        raise SystemExit(
            f"10-minute queue target coverage {coverage:.1%} is below {args.min_coverage:.1%}"
        )


if __name__ == "__main__":
    main()
