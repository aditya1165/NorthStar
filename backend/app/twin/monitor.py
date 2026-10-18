"""Detector-equivalent gate congestion signals for offline twin runs.

Live runs use ``CongestionDetector`` on WebSocket telemetry. Offline rollouts and
dataset runs use this vectorised equivalent built on the same zone polygons and
the same thresholds and persistence windows.
"""

import numpy as np

from app.congestion.config import THRESHOLDS, DetectorThresholds
from app.shared.models import ZoneTelemetry
from app.twin.field import GateSignals
from app.twin.layout import GATE_IDS, GATE_INDEX


class GateMonitor:
    def __init__(self, thresholds: DetectorThresholds = THRESHOLDS) -> None:
        self.t = thresholds
        n = len(GATE_IDS)
        self._congested = np.zeros(n, dtype=bool)
        self._candidate_since = np.full(n, np.nan)
        self._clear_since = np.full(n, np.nan)

    def update(self, time_seconds: float, zones: list[ZoneTelemetry]) -> GateSignals:
        t = self.t
        n = len(GATE_IDS)
        queue = np.zeros(n)
        density = np.zeros(n)
        for zone in zones:
            gate_id = zone.zone_id.removesuffix("_approach")
            if gate_id not in GATE_INDEX:
                continue
            gate = GATE_INDEX[gate_id]
            queue[gate] = zone.queue_length
            density[gate] = zone.density_estimate
            speed = zone.mean_speed_mps
            candidate = (zone.density_estimate >= t.high_density and speed <= t.queue_speed_mps) or (
                zone.queue_length >= t.high_queue
            )
            clear = zone.people_count == 0 or (
                zone.density_estimate < t.clear_density
                and zone.queue_length < t.clear_queue
                and speed > t.clear_speed_mps
            )
            if candidate:
                self._clear_since[gate] = np.nan
                if np.isnan(self._candidate_since[gate]):
                    self._candidate_since[gate] = time_seconds
                if time_seconds - self._candidate_since[gate] >= t.trigger_persistence_seconds:
                    self._congested[gate] = True
            else:
                self._candidate_since[gate] = np.nan
                if self._congested[gate] and clear:
                    if np.isnan(self._clear_since[gate]):
                        self._clear_since[gate] = time_seconds
                    if time_seconds - self._clear_since[gate] >= t.clear_persistence_seconds:
                        self._congested[gate] = False
                        self._clear_since[gate] = np.nan
                else:
                    self._clear_since[gate] = np.nan
        return GateSignals(queue=queue, density=density, congested=self._congested.copy())
