"""Stadium geometry shared by the Python twin, routing, zones, and rollouts.

Everything is derived from ``shared/stadium-config.json`` so the Python model
and the React twin use identical gates, sections, and ring scales.
"""

import json
from dataclasses import dataclass
from math import cos, pi, sin
from pathlib import Path

import numpy as np

_CONFIG_PATH = Path(__file__).resolve().parents[3] / "shared" / "stadium-config.json"
with _CONFIG_PATH.open(encoding="utf-8") as config_file:
    STADIUM = json.load(config_file)

CONFIG_VERSION = str(STADIUM["version"])
POPULATION = int(STADIUM["population"])
METERS_PER_SCENE_UNIT = float(STADIUM["metersPerSceneUnit"])
BOWL_RX = float(STADIUM["bowl"]["rx"])
BOWL_RZ = float(STADIUM["bowl"]["rz"])
RING = {key: float(value) for key, value in STADIUM["ring"].items()}
BASE_SCALE = RING["basePath"]
MEAN_RADIUS = (BOWL_RX + BOWL_RZ) / 2

GATE_IDS: tuple[str, ...] = tuple(str(gate["id"]) for gate in STADIUM["gates"])
GATE_LABELS: tuple[str, ...] = tuple(str(gate["label"]) for gate in STADIUM["gates"])
GATE_INDEX = {gate_id: index for index, gate_id in enumerate(GATE_IDS)}
GATE_ANGLES = np.array([float(gate["angleDeg"]) for gate in STADIUM["gates"]])
GATE_CAPACITY = np.array(
    [
        float(gate.get("capacityPerMinute", STADIUM["gateDefaults"]["capacityPerMinute"]))
        for gate in STADIUM["gates"]
    ]
)

SECTION_COUNT = 24
SECTION_ANGLES = np.array([-30.0 + 15.0 * k for k in range(SECTION_COUNT)])
FIRST_SECTION_NUMBER = 201

DESTINATION_SCALE = 1.62
MOVEMENT = STADIUM["movement"]
CONCOURSE_SCALE = float(MOVEMENT["concourseScale"])
QUEUE_INNER_SCALE = float(MOVEMENT["queueInnerScale"])
QUEUE_OUTER_SCALE = float(MOVEMENT["queueOuterScale"])
GATE_PORTAL_SCALE = RING["concourseOuter"] + float(MOVEMENT["gatePortalOffset"])


def ring_point(angle_deg: float, scale: float) -> tuple[float, float]:
    angle = angle_deg * pi / 180
    return BOWL_RX * scale * cos(angle), BOWL_RZ * scale * sin(angle)


def ring_coords(x: np.ndarray, z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Inverse of ``ring_point`` for arrays: (angle in degrees, ring scale)."""
    nx = x / BOWL_RX
    nz = z / BOWL_RZ
    return np.degrees(np.arctan2(nz, nx)), np.hypot(nx, nz)


def angle_delta(a: np.ndarray | float, b: np.ndarray | float) -> np.ndarray:
    """Signed shortest angular difference ``b - a`` in degrees, in (-180, 180]."""
    d = np.mod(np.asarray(b) - np.asarray(a) + 180.0, 360.0) - 180.0
    return np.where(d <= -180.0, d + 360.0, d)


SECTION_ACCESS_GATE_ANGLES = GATE_ANGLES[
    np.argmin(np.abs(angle_delta(SECTION_ANGLES[:, None], GATE_ANGLES[None, :])), axis=1)
]


def initial_access_angles(person_ids: np.ndarray) -> np.ndarray:
    """Fixed section-passage angles for live telemetry and restored people.

    With this stadium's 15-degree sections and 45-degree gates, the seat jitter
    of +/-5.5 degrees cannot cross the nearest-passage boundary (7.5 degrees).
    """
    return SECTION_ACCESS_GATE_ANGLES[np.asarray(person_ids, dtype=np.int64) % SECTION_COUNT]


def nearest_open_gate(
    angles: np.ndarray, person_ids: np.ndarray, closed: np.ndarray
) -> np.ndarray:
    """Nearest circular escape, stably splitting equal-distance choices by ID.

    Gate indices provide a stable ordering for exact ties. No open gate returns
    -1, allowing pedestrians to wait safely without changing their destination.
    """
    person_ids = np.asarray(person_ids, dtype=np.int64)
    if person_ids.size == 0 or np.all(closed):
        return np.full(person_ids.size, -1, dtype=np.int64)
    distances = np.abs(angle_delta(np.asarray(angles)[:, None], GATE_ANGLES[None, :]))
    distances[:, closed] = np.inf
    tied = np.abs(distances - distances.min(axis=1)[:, None]) <= 1e-6
    chosen_rank = person_ids % tied.sum(axis=1)
    selected = tied & (np.cumsum(tied, axis=1) == chosen_rank[:, None] + 1)
    return np.argmax(selected, axis=1)


def base_path_meters(angle_from: np.ndarray | float, angle_to: np.ndarray | float) -> np.ndarray:
    """Walking distance along the lower base path between two angles."""
    radians = np.abs(angle_delta(angle_from, angle_to)) * pi / 180
    return radians * MEAN_RADIUS * BASE_SCALE * METERS_PER_SCENE_UNIT


def concourse_path_meters(angle_from: np.ndarray | float, angle_to: np.ndarray | float) -> np.ndarray:
    """Walking distance along the outer circulation ring between boundary gates."""
    radians = np.abs(angle_delta(angle_from, angle_to)) * pi / 180
    return radians * MEAN_RADIUS * CONCOURSE_SCALE * METERS_PER_SCENE_UNIT


GATE_DESTINATIONS = np.array([ring_point(angle, DESTINATION_SCALE) for angle in GATE_ANGLES])
GATE_PORTALS = np.array([ring_point(angle, GATE_PORTAL_SCALE) for angle in GATE_ANGLES])


def section_number(section_index: int) -> int:
    return FIRST_SECTION_NUMBER + section_index


@dataclass(frozen=True)
class ZoneDefinition:
    zone_id: str
    name: str
    kind: str
    polygon: tuple[tuple[float, float], ...]
    area_m2: float
    gate_id: str | None = None


def _polygon_area(points: tuple[tuple[float, float], ...]) -> float:
    area = 0.0
    for index, (x1, y1) in enumerate(points):
        x2, y2 = points[(index + 1) % len(points)]
        area += x1 * y2 - x2 * y1
    return abs(area) / 2


def _band_polygon(
    from_deg: float, to_deg: float, inner: float, outer: float, steps: int = 12
) -> tuple[tuple[float, float], ...]:
    inner_arc = [
        ring_point(from_deg + (to_deg - from_deg) * i / steps, inner) for i in range(steps + 1)
    ]
    outer_arc = [
        ring_point(to_deg - (to_deg - from_deg) * i / steps, outer) for i in range(steps + 1)
    ]
    return tuple(inner_arc + outer_arc)


def _build_zones() -> tuple[ZoneDefinition, ...]:
    defaults = STADIUM["gateDefaults"]
    half = float(defaults["approachHalfAngleDeg"])
    inner = float(defaults["approachInnerScale"])
    outer = float(defaults["approachOuterScale"])
    zones: list[ZoneDefinition] = []
    for gate_id, label, angle in zip(GATE_IDS, GATE_LABELS, GATE_ANGLES, strict=True):
        polygon = (
            ring_point(angle - half, inner),
            ring_point(angle + half, inner),
            ring_point(angle + half, outer),
            ring_point(angle - half, outer),
        )
        zones.append(
            ZoneDefinition(
                zone_id=f"{gate_id}_approach",
                name=f"{label} approach",
                kind="gate_approach",
                polygon=polygon,
                area_m2=_polygon_area(polygon) * METERS_PER_SCENE_UNIT**2,
                gate_id=gate_id,
            )
        )
    band_inner = RING["pitch"]
    band_outer = RING["seatInner"]
    for zone_id, name, centre in (
        ("north_base_path", "North base path", -90.0),
        ("east_base_path", "East base path", 0.0),
        ("south_base_path", "South base path", 90.0),
        ("west_base_path", "West base path", 180.0),
    ):
        polygon = _band_polygon(centre - 45, centre + 45, band_inner, band_outer)
        zones.append(
            ZoneDefinition(
                zone_id=zone_id,
                name=name,
                kind="base_path",
                polygon=polygon,
                area_m2=_polygon_area(polygon) * METERS_PER_SCENE_UNIT**2,
            )
        )
    return tuple(zones)


ZONES = _build_zones()
ZONE_IDS = tuple(zone.zone_id for zone in ZONES)


def points_in_polygon(
    x: np.ndarray, z: np.ndarray, polygon: tuple[tuple[float, float], ...]
) -> np.ndarray:
    """Vectorised even-odd ray casting, matching the detector's boundary rule."""
    inside = np.zeros(x.shape, dtype=bool)
    count = len(polygon)
    for current in range(count):
        xi, yi = polygon[current]
        xj, yj = polygon[current - 1]
        crosses = (yi > z) != (yj > z)
        if not np.any(crosses):
            continue
        with np.errstate(divide="ignore", invalid="ignore"):
            boundary = (xj - xi) * (z - yi) / (yj - yi) + xi
        inside ^= crosses & (x <= boundary)
    return inside


def zone_membership(x: np.ndarray, z: np.ndarray) -> np.ndarray:
    """Zone index per point, or -1 when outside every monitored zone."""
    membership = np.full(x.shape, -1, dtype=np.int16)
    for index, zone in enumerate(ZONES):
        inside = points_in_polygon(x, z, zone.polygon) & (membership < 0)
        membership[inside] = index
    return membership
