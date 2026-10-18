"""Rebuild an isolated twin from the latest live telemetry for counterfactual rollouts."""

from dataclasses import dataclass

import numpy as np

from app.twin.field import PHASE_BY_NAME, Phase, StadiumTwin, TwinParams
from app.twin.layout import BASE_SCALE, GATE_ANGLES, GATE_IDS, GATE_INDEX, POPULATION, ring_coords

MOVEMENT_FALLBACK = {
    "waiting": Phase.WAITING,
    "moving": Phase.BASE_RING,
    "queued": Phase.QUEUE,
    "exiting": Phase.EXIT,
    "transit_wait": Phase.EXIT,
}


@dataclass
class LiveState:
    """Array view of one telemetry batch (active people) plus exits."""

    time_seconds: float
    person_ids: np.ndarray
    x: np.ndarray
    z: np.ndarray
    speed_mps: np.ndarray
    target: np.ndarray
    phase: np.ndarray
    exited_ids: np.ndarray
    exited_at_seconds: np.ndarray
    exited_target: np.ndarray
    closed: frozenset[str]

    @classmethod
    def from_batch(cls, batch) -> "LiveState":
        agents = batch.agents
        exited = batch.exited_agents
        return cls(
            time_seconds=batch.simulation_time_seconds,
            person_ids=np.array([a.person_id for a in agents], dtype=np.int64),
            x=np.array([a.x for a in agents], dtype=float),
            z=np.array([a.z for a in agents], dtype=float),
            speed_mps=np.array([a.speed_mps for a in agents], dtype=float),
            target=np.array([GATE_INDEX[a.target_gate] for a in agents], dtype=np.int64),
            phase=np.array(
                [
                    PHASE_BY_NAME[a.phase] if a.phase else MOVEMENT_FALLBACK[a.movement_state]
                    for a in agents
                ],
                dtype=np.int8,
            ),
            exited_ids=np.array([a.person_id for a in exited], dtype=np.int64),
            exited_at_seconds=np.array([a.exited_at_seconds for a in exited], dtype=float),
            exited_target=np.array([GATE_INDEX[a.target_gate] for a in exited], dtype=np.int64),
            closed=frozenset(batch.closed_gates),
        )

    @classmethod
    def from_twin(cls, twin: StadiumTwin) -> "LiveState":
        active = np.where(twin.phase != Phase.EXITED)[0]
        exited = np.where(twin.phase == Phase.EXITED)[0]
        return cls(
            time_seconds=twin.time * 60,
            person_ids=active,
            x=twin.x[active].copy(),
            z=twin.z[active].copy(),
            speed_mps=twin.speed_mps[active].copy(),
            target=twin.target[active].astype(np.int64),
            phase=twin.phase[active].copy(),
            exited_ids=exited,
            exited_at_seconds=twin.exited_at[exited].copy(),
            exited_target=twin.target[exited].astype(np.int64),
            closed=frozenset(g for g, c in zip(GATE_IDS, twin.closed, strict=True) if c),
        )


def restore_twin(state: LiveState, rollout_seed: int = 0, speed_noise: float = 0.05) -> StadiumTwin:
    """Create a twin whose people match ``state``; static attributes come from the seeded layout."""
    twin = StadiumTwin(TwinParams(population=POPULATION))
    minute = state.time_seconds / 60
    twin.time = minute
    twin.set_closed(state.closed)
    if rollout_seed:
        rng = np.random.default_rng(rollout_seed)
        twin.speed = twin.speed * np.clip(1 + rng.normal(0, speed_noise, twin.count), 0.8, 1.2)

    twin.phase[:] = Phase.EXITED
    twin.exited_at[:] = 0.0
    if state.exited_ids.size:
        twin.exited_at[state.exited_ids] = state.exited_at_seconds
        twin.target[state.exited_ids] = state.exited_target
    ids = state.person_ids
    if ids.size == 0:
        return twin

    twin.phase[ids] = state.phase
    twin.target[ids] = state.target
    twin.x[ids] = state.x
    twin.z[ids] = state.z
    angle, scale = ring_coords(state.x, state.z)
    twin.angle[ids] = angle
    twin.scale[ids] = scale
    twin.timer[ids] -= minute
    twin.exited_at[ids] = -1.0

    ring = ids[state.phase == Phase.BASE_RING]
    twin.scale[ring] = BASE_SCALE
    corridor = ids[np.isin(state.phase, (Phase.GATE_CORRIDOR, Phase.QUEUE))]
    twin.angle[corridor] = GATE_ANGLES[twin.target[corridor]]

    queued = ids[state.phase == Phase.QUEUE]
    order = queued[np.lexsort((queued, scale[state.phase == Phase.QUEUE]))]
    twin.queued_at[order] = minute
    for person in order.tolist():
        twin.queues[int(twin.target[person])].append(person)

    for person in ids[state.phase == Phase.EXIT].tolist():
        twin._begin_exit(person)
    return twin
