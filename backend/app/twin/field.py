"""Vectorised Python port of the React ``CrowdField`` egress model.

The model uses the same seeded mulberry32 stream, draw order, phases, FIFO gate
queues, and gate service rule as ``frontend/src/twin/sim/crowdField.ts`` so the
backend can run isolated what-if rollouts and generate training data that match
what operators see in the 3D twin.
"""

from collections.abc import Callable
from dataclasses import dataclass
from enum import IntEnum
from math import pi

import numpy as np

from app.twin.layout import (
    BASE_SCALE,
    BOWL_RX,
    BOWL_RZ,
    GATE_ANGLES,
    GATE_CAPACITY,
    GATE_DESTINATIONS,
    GATE_IDS,
    GATE_PORTALS,
    MEAN_RADIUS,
    METERS_PER_SCENE_UNIT,
    POPULATION,
    QUEUE_INNER_SCALE,
    QUEUE_OUTER_SCALE,
    RING,
    SECTION_ANGLES,
    SECTION_COUNT,
    angle_delta,
    base_path_meters,
)

DEFAULT_SEED = 20260614
WALK_SPEED = 1.3
MAX_STEP = 0.04
REROUTE_MARGIN_METERS = 12.0
REROUTE_COOLDOWN_MINUTES = 0.5
NAIVE_DISCOVERY_MINUTES = 1.0


class Phase(IntEnum):
    WAITING = 0
    ROW = 1
    AISLE = 2
    BASE_RING = 3
    GATE_CORRIDOR = 4
    QUEUE = 5
    RETURN_TO_BASE = 6
    EXIT = 7
    EXITED = 8


PHASE_NAMES = {
    Phase.WAITING: "waiting",
    Phase.ROW: "row",
    Phase.AISLE: "aisle",
    Phase.BASE_RING: "base_ring",
    Phase.GATE_CORRIDOR: "gate_corridor",
    Phase.QUEUE: "queue",
    Phase.RETURN_TO_BASE: "return_to_base",
    Phase.EXIT: "exit",
    Phase.EXITED: "exited",
}
PHASE_BY_NAME = {name: phase for phase, name in PHASE_NAMES.items()}
MOVEMENT_STATE = {
    Phase.WAITING: "waiting",
    Phase.ROW: "moving",
    Phase.AISLE: "moving",
    Phase.BASE_RING: "moving",
    Phase.GATE_CORRIDOR: "moving",
    Phase.QUEUE: "queued",
    Phase.RETURN_TO_BASE: "moving",
    Phase.EXIT: "exiting",
}


def mulberry32(seed: int) -> Callable[[], float]:
    """Bit-exact port of the frontend PRNG."""
    state = seed & 0xFFFFFFFF

    def imul(a: int, b: int) -> int:
        return (a * b) & 0xFFFFFFFF

    def next_value() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = state
        t = imul(t ^ (t >> 15), t | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return next_value


@dataclass
class GateSignals:
    """Per-gate monitoring inputs for routing (index order follows ``GATE_IDS``)."""

    queue: np.ndarray
    density: np.ndarray
    congested: np.ndarray

    @classmethod
    def empty(cls) -> "GateSignals":
        n = len(GATE_IDS)
        return cls(np.zeros(n), np.zeros(n), np.zeros(n, dtype=bool))


@dataclass(frozen=True)
class TwinParams:
    seed: int = DEFAULT_SEED
    population: int = POPULATION
    speed_scale: float = 1.0
    release_scale: float = 1.0
    capacity_scale: float = 1.0


class StadiumTwin:
    """Deterministic 4,000-person stadium egress twin."""

    def __init__(self, params: TwinParams | None = None) -> None:
        self.params = params or TwinParams()
        n = self.params.population
        self.count = n
        rand = mulberry32(self.params.seed)
        draws = np.array([[rand() for _ in range(5)] for _ in range(n)], dtype=np.float64)
        self.section = np.arange(n) % SECTION_COUNT
        section_angles = SECTION_ANGLES[self.section]
        self.seat_angle = section_angles + (draws[:, 0] - 0.5) * 11
        self.aisle_angle = section_angles.copy()
        self.seat_scale = (
            RING["seatInner"] + 0.05 + draws[:, 1] * (RING["seatOuter"] - RING["seatInner"] - 0.08)
        )
        self.speed = (0.8 + draws[:, 2] * 0.4) * self.params.speed_scale
        self.hash_a = draws[:, 3]
        self.hash_b = draws[:, 4]
        self.gate_capacity = GATE_CAPACITY * self.params.capacity_scale
        self.held_until = np.full(SECTION_COUNT, -np.inf)
        self.reset()

    # ------------------------------------------------------------------ state

    def reset(self) -> None:
        n = self.count
        self.time = 0.0
        self.phase = np.full(n, Phase.WAITING, dtype=np.int8)
        self.timer = (
            (self.section / SECTION_COUNT) * 8 + self.hash_a * 8
        ) * self.params.release_scale
        self.angle = self.seat_angle.copy()
        self.scale = self.seat_scale.copy()
        self.target = self._nearest_gate(self.seat_angle)
        self.initial_target = self.target.copy()
        self.x, self.z = self._ring_xy(self.angle, self.scale)
        self.ex = np.zeros(n)
        self.ez = np.zeros(n)
        self.dx = np.zeros(n)
        self.dz = np.zeros(n)
        self.progress = np.zeros(n)
        self.exit_len = np.ones(n)
        self.speed_mps = np.zeros(n)
        self.exited_at = np.full(n, -1.0)
        self.last_reroute = np.full(n, -100.0)
        self.queued_at = np.full(n, np.inf)
        self.rerouted = np.zeros(n, dtype=bool)
        self.reroute_count = np.zeros(n, dtype=np.int16)
        self.extra_walk_m = np.zeros(n)
        self.gate_credit = np.zeros(len(GATE_IDS))
        self.queues: list[list[int]] = [[] for _ in GATE_IDS]
        self.queue_head = [0] * len(GATE_IDS)
        self.closed = np.zeros(len(GATE_IDS), dtype=bool)
        self.signals = GateSignals.empty()
        self.held_until[:] = -np.inf

    @staticmethod
    def _ring_xy(angle: np.ndarray, scale: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        radians = angle * pi / 180
        return np.cos(radians) * BOWL_RX * scale, np.sin(radians) * BOWL_RZ * scale

    @staticmethod
    def _nearest_gate(angles: np.ndarray) -> np.ndarray:
        distance = np.abs(angle_delta(angles[:, None], GATE_ANGLES[None, :]))
        return np.argmin(distance, axis=1).astype(np.int8)

    def set_closed(self, gate_ids: set[str] | list[str] | tuple[str, ...]) -> None:
        closed = set(gate_ids)
        self.closed = np.array([gate in closed for gate in GATE_IDS], dtype=bool)

    def hold_sections(self, section_indices: list[int], until_minute: float) -> None:
        for index in section_indices:
            self.held_until[index] = max(self.held_until[index], until_minute)

    # ---------------------------------------------------------------- routing

    def apply_assignments(self, person_ids: np.ndarray, gates: np.ndarray) -> int:
        """Execute routing deltas exactly as the React twin does. Returns count applied."""
        person_ids = np.asarray(person_ids, dtype=np.int64)
        gates = np.asarray(gates, dtype=np.int8)
        if person_ids.size == 0:
            return 0
        phase = self.phase[person_ids]
        valid = (phase < Phase.EXIT) & (self.target[person_ids] != gates)
        ids = person_ids[valid]
        new = gates[valid]
        if ids.size == 0:
            return 0
        old = self.target[ids]
        detour = base_path_meters(self.angle[ids], GATE_ANGLES[new]) - base_path_meters(
            self.angle[ids], GATE_ANGLES[old]
        )
        leaving = np.isin(self.phase[ids], (Phase.GATE_CORRIDOR, Phase.QUEUE))
        climb = np.maximum(0.0, self.scale[ids] - BASE_SCALE) * MEAN_RADIUS * METERS_PER_SCENE_UNIT
        detour = detour + np.where(leaving, 2 * climb, 0.0)
        self.extra_walk_m[ids] += detour
        self.target[ids] = new
        self.rerouted[ids] = True
        self.reroute_count[ids] += 1
        self.last_reroute[ids] = self.time
        self.phase[ids[leaving]] = Phase.RETURN_TO_BASE
        self.queued_at[ids[leaving]] = np.inf
        return int(ids.size)

    def _route_cost(self, idx: np.ndarray, gate: np.ndarray) -> np.ndarray:
        s = self.signals
        walking = base_path_meters(self.angle[idx], GATE_ANGLES[gate])
        tie = ((idx * 17 + gate * 31) % 19) * 0.03
        return walking + s.queue[gate] * 0.12 + s.density[gate] * 4 + s.congested[gate] * 20 + tie

    def _select_local(self, idx: np.ndarray) -> np.ndarray:
        """Vectorised port of ``CrowdField.selectGate`` (closure / congestion aware)."""
        current = self.target[idx].astype(np.int64)
        if idx.size == 0:
            return current
        closed_now = self.closed[current]
        congested_now = self.signals.congested[current]
        cooled = (self.time - self.last_reroute[idx]) >= REROUTE_COOLDOWN_MINUTES
        consider = closed_now | (congested_now & cooled)
        if not np.any(consider) or np.all(self.closed):
            return current
        cand = idx[consider]
        cur = current[consider]
        n_gates = len(GATE_IDS)
        costs = np.stack(
            [self._route_cost(cand, np.full(cand.size, g)) for g in range(n_gates)], axis=1
        )
        costs[:, self.closed] = np.inf
        costs[np.arange(cand.size), cur] = np.inf
        best = np.argmin(costs, axis=1)
        best_cost = costs[np.arange(cand.size), best]
        current_cost = self._route_cost(cand, cur)
        switch = np.isfinite(best_cost) & (
            self.closed[cur] | (best_cost + REROUTE_MARGIN_METERS < current_cost)
        )
        result = current.copy()
        chosen = np.where(consider)[0][switch]
        result[chosen] = best[switch]
        self.last_reroute[idx[chosen]] = self.time
        return result

    def _select_naive(self, idx: np.ndarray) -> np.ndarray:
        """No guidance: people only discover a closure after waiting at the closed gate."""
        current = self.target[idx].astype(np.int64)
        stuck = (
            (self.phase[idx] == Phase.QUEUE)
            & self.closed[current]
            & (self.time - self.queued_at[idx] >= NAIVE_DISCOVERY_MINUTES)
        )
        if not np.any(stuck) or np.all(self.closed):
            return current
        cand = idx[stuck]
        distance = np.abs(angle_delta(GATE_ANGLES[current[stuck]][:, None], GATE_ANGLES[None, :]))
        distance[:, self.closed] = np.inf
        result = current.copy()
        result[stuck] = np.argmin(distance, axis=1)
        self.last_reroute[cand] = self.time
        return result

    def _select(self, idx: np.ndarray, policy: str) -> np.ndarray:
        if policy == "local":
            return self._select_local(idx)
        if policy == "naive":
            return self._select_naive(idx)
        return self.target[idx].astype(np.int64)

    def _retarget(self, idx: np.ndarray, selected: np.ndarray) -> np.ndarray:
        changed = selected != self.target[idx]
        if np.any(changed):
            ids = idx[changed]
            old = self.target[ids]
            new = selected[changed]
            self.extra_walk_m[ids] += base_path_meters(
                self.angle[ids], GATE_ANGLES[new]
            ) - base_path_meters(self.angle[ids], GATE_ANGLES[old])
            self.target[ids] = new
            self.rerouted[ids] = True
            self.reroute_count[ids] += 1
        return changed

    # ------------------------------------------------------------- simulation

    def advance_to(self, until: float, policy: str = "local", step: float = MAX_STEP) -> None:
        guard = 0
        while self.time < until - 1e-6 and guard < 100_000:
            dt = min(step, until - self.time)
            self.time += dt
            self.step(dt, policy)
            guard += 1

    def step(self, dt: float, policy: str = "local") -> None:
        phase = self.phase.copy()
        step_distance = self.speed * WALK_SPEED * dt
        base_mps = self.speed * WALK_SPEED * METERS_PER_SCENE_UNIT / 60

        moving = (phase >= Phase.ROW) & (phase <= Phase.EXIT) & (phase != Phase.QUEUE)
        self.speed_mps = np.where(moving, base_mps, 0.0)

        waiting = np.where(phase == Phase.WAITING)[0]
        if waiting.size:
            released = self.time >= self.held_until[self.section[waiting]]
            self.timer[waiting[released]] -= dt
            ready = waiting[self.timer[waiting] <= 0]
            self.phase[ready] = Phase.ROW

        row = np.where(phase == Phase.ROW)[0]
        if row.size:
            arrived = self._move_angle(row, self.aisle_angle[row], step_distance[row], self.scale[row])
            self.phase[row[arrived]] = Phase.AISLE
            self.x[row], self.z[row] = self._ring_xy(self.angle[row], self.scale[row])

        aisle = np.where(phase == Phase.AISLE)[0]
        if aisle.size:
            self.scale[aisle] = np.maximum(BASE_SCALE, self.scale[aisle] - step_distance[aisle] / 10)
            done = aisle[self.scale[aisle] <= BASE_SCALE + 1e-4]
            self.scale[done] = BASE_SCALE
            self.phase[done] = Phase.BASE_RING
            self.x[aisle], self.z[aisle] = self._ring_xy(self.angle[aisle], self.scale[aisle])

        ring = np.where(phase == Phase.BASE_RING)[0]
        if ring.size:
            self._retarget(ring, self._select(ring, policy))
            goal = GATE_ANGLES[self.target[ring]]
            arrived = self._move_angle(
                ring, goal, step_distance[ring], np.full(ring.size, BASE_SCALE)
            )
            self.phase[ring[arrived]] = Phase.GATE_CORRIDOR
            self.scale[ring] = BASE_SCALE
            self.x[ring], self.z[ring] = self._ring_xy(self.angle[ring], self.scale[ring])

        corridor = np.where(phase == Phase.GATE_CORRIDOR)[0]
        if corridor.size:
            changed = self._retarget(corridor, self._select(corridor, policy))
            self.phase[corridor[changed]] = Phase.RETURN_TO_BASE
            stay = corridor[~changed]
            self.angle[stay] = GATE_ANGLES[self.target[stay]]
            self.scale[stay] = np.minimum(QUEUE_INNER_SCALE, self.scale[stay] + step_distance[stay] / 10)
            self.x[stay], self.z[stay] = self._ring_xy(self.angle[stay], self.scale[stay])
            entering = stay[self.scale[stay] >= QUEUE_INNER_SCALE - 1e-4]
            for person in entering.tolist():
                self.phase[person] = Phase.QUEUE
                self.queued_at[person] = self.time
                self.queues[int(self.target[person])].append(person)

        queue = np.where(phase == Phase.QUEUE)[0]
        if queue.size:
            changed = self._retarget(queue, self._select(queue, policy))
            self.phase[queue[changed]] = Phase.RETURN_TO_BASE
            self.queued_at[queue[changed]] = np.inf
            stay = queue[~changed]
            gate_angle = GATE_ANGLES[self.target[stay]] + (self.hash_a[stay] - 0.5) * 7
            queue_scale = QUEUE_INNER_SCALE + self.hash_b[stay] * (QUEUE_OUTER_SCALE - QUEUE_INNER_SCALE)
            qx, qz = self._ring_xy(gate_angle, queue_scale)
            k = min(1.0, dt * 4)
            self.x[stay] += (qx - self.x[stay]) * k
            self.z[stay] += (qz - self.z[stay]) * k

        back = np.where(phase == Phase.RETURN_TO_BASE)[0]
        if back.size:
            self.scale[back] = np.maximum(BASE_SCALE, self.scale[back] - step_distance[back] / 10)
            self.x[back], self.z[back] = self._ring_xy(self.angle[back], self.scale[back])
            self.phase[back[self.scale[back] <= BASE_SCALE + 1e-4]] = Phase.BASE_RING

        leaving = np.where(phase == Phase.EXIT)[0]
        if leaving.size:
            self.progress[leaving] += step_distance[leaving]
            fraction = np.minimum(1.0, self.progress[leaving] / self.exit_len[leaving])
            self.x[leaving] = self.ex[leaving] + (self.dx[leaving] - self.ex[leaving]) * fraction
            self.z[leaving] = self.ez[leaving] + (self.dz[leaving] - self.ez[leaving]) * fraction
            done = leaving[fraction >= 1]
            self.phase[done] = Phase.EXITED
            self.speed_mps[done] = 0.0
            self.exited_at[done] = max(0.0, self.time * 60)

        self._serve_queues(dt)

    def _move_angle(
        self, idx: np.ndarray, goal: np.ndarray, distance: np.ndarray, scale: np.ndarray
    ) -> np.ndarray:
        delta = angle_delta(self.angle[idx], goal)
        radius = np.maximum(1.0, MEAN_RADIUS * scale)
        step_degrees = (distance / radius) * (180 / pi)
        arrived = np.abs(delta) <= step_degrees + 0.1
        self.angle[idx] = np.where(arrived, goal, self.angle[idx] + np.sign(delta) * step_degrees)
        return arrived

    def _serve_queues(self, dt: float) -> None:
        for gate in range(len(GATE_IDS)):
            if self.closed[gate]:
                self.gate_credit[gate] = 0.0
                continue
            capacity = self.gate_capacity[gate]
            self.gate_credit[gate] = min(capacity, self.gate_credit[gate] + capacity * dt)
            queue = self.queues[gate]
            head = self.queue_head[gate]
            while self.gate_credit[gate] >= 1 and head < len(queue):
                person = queue[head]
                head += 1
                if self.phase[person] != Phase.QUEUE or self.target[person] != gate:
                    continue
                self._begin_exit(person)
                self.gate_credit[gate] -= 1
            if head > 512 and head * 2 > len(queue):
                self.queues[gate] = queue[head:]
                head = 0
            self.queue_head[gate] = head

    def _begin_exit(self, person: int) -> None:
        gate = int(self.target[person])
        portal_x, portal_z = GATE_PORTALS[gate]
        dest_x, dest_z = GATE_DESTINATIONS[gate]
        angle = GATE_ANGLES[gate] * pi / 180
        lane = (self.hash_a[person] - 0.5) * 1.1
        self.ex[person] = self.x[person]
        self.ez[person] = self.z[person]
        self.dx[person] = dest_x - np.sin(angle) * lane
        self.dz[person] = dest_z + np.cos(angle) * lane
        length = np.hypot(portal_x - self.ex[person], portal_z - self.ez[person]) + np.hypot(
            self.dx[person] - portal_x, self.dz[person] - portal_z
        )
        self.exit_len[person] = max(0.01, float(length))
        self.progress[person] = 0.0
        self.phase[person] = Phase.EXIT
        self.queued_at[person] = np.inf

    # ------------------------------------------------------------- telemetry

    @property
    def active_mask(self) -> np.ndarray:
        return self.phase != Phase.EXITED

    def queued_per_gate(self) -> np.ndarray:
        queued = self.phase == Phase.QUEUE
        return np.bincount(self.target[queued], minlength=len(GATE_IDS)).astype(float)

    def exited_count(self) -> int:
        return int(np.count_nonzero(self.phase == Phase.EXITED))

    def telemetry_batch(self, run_id: str, sequence: int) -> dict:
        """Wire-format telemetry identical to what the React twin publishes."""
        agents = []
        exited = []
        for i in range(self.count):
            gate = GATE_IDS[int(self.target[i])]
            phase = Phase(int(self.phase[i]))
            if phase == Phase.EXITED:
                exited.append(
                    {"person_id": i, "target_gate": gate, "exited_at_seconds": float(self.exited_at[i])}
                )
                continue
            agents.append(
                {
                    "person_id": i,
                    "x": round(float(self.x[i]), 3),
                    "z": round(float(self.z[i]), 3),
                    "speed_mps": round(float(self.speed_mps[i]), 2),
                    "target_gate": gate,
                    "movement_state": MOVEMENT_STATE[phase],
                    "phase": PHASE_NAMES[phase],
                }
            )
        return {
            "message_type": "telemetry",
            "run_id": run_id,
            "sequence": sequence,
            "simulation_time_seconds": max(0.0, self.time * 60),
            "population": self.count,
            "agents": agents,
            "exited_agents": exited,
            "closed_gates": [gate for gate, closed in zip(GATE_IDS, self.closed, strict=True) if closed],
        }
