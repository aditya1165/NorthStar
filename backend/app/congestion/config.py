import json
from dataclasses import dataclass
from math import cos, pi, sin
from pathlib import Path

Point = tuple[float, float]


@dataclass(frozen=True)
class GateDetectionConfig:
    gate_id: str
    label: str
    approach_polygon: tuple[Point, ...]


@dataclass(frozen=True)
class DetectorThresholds:
    # Prototype engineering defaults. These are not certified safety limits.
    elevated_density: float = 2.2
    high_density: float = 3.2
    critical_density: float = 4.5
    elevated_queue: int = 40
    high_queue: int = 80
    critical_queue: int = 160
    queue_speed_mps: float = 0.6
    critical_speed_mps: float = 0.35
    minimum_speed_sample: int = 20
    trigger_persistence_seconds: float = 5.0
    clear_persistence_seconds: float = 10.0
    clear_density: float = 2.0
    clear_queue: int = 20
    clear_speed_mps: float = 0.8


_CONFIG_PATH = Path(__file__).resolve().parents[3] / "shared" / "stadium-config.json"
with _CONFIG_PATH.open(encoding="utf-8") as config_file:
    _STADIUM = json.load(config_file)

CONFIG_VERSION = str(_STADIUM["version"])
POPULATION = int(_STADIUM["population"])
METERS_PER_SCENE_UNIT = float(_STADIUM["metersPerSceneUnit"])
THRESHOLDS = DetectorThresholds()


def _ring_point(angle_deg: float, scale: float) -> Point:
    angle = angle_deg * pi / 180
    return (
        float(_STADIUM["bowl"]["rx"]) * scale * cos(angle),
        float(_STADIUM["bowl"]["rz"]) * scale * sin(angle),
    )


def _approach_polygon(angle_deg: float) -> tuple[Point, ...]:
    defaults = _STADIUM["gateDefaults"]
    half_angle = float(defaults["approachHalfAngleDeg"])
    inner = float(defaults["approachInnerScale"])
    outer = float(defaults["approachOuterScale"])
    return (
        _ring_point(angle_deg - half_angle, inner),
        _ring_point(angle_deg + half_angle, inner),
        _ring_point(angle_deg + half_angle, outer),
        _ring_point(angle_deg - half_angle, outer),
    )


# Polygons follow the 3D ground plane: x points east and z points south.
GATES = tuple(
    GateDetectionConfig(
        gate_id=str(gate["id"]),
        label=str(gate["label"]),
        approach_polygon=_approach_polygon(float(gate["angleDeg"])),
    )
    for gate in _STADIUM["gates"]
)
