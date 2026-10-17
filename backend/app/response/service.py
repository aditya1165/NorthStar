from app.shared.models import InterventionResult, SimulationSnapshot


class ResponseService:
    """Deterministic counterfactual scorer for the initial integration contract."""

    def evaluate(self, snapshot: SimulationSnapshot) -> list[InterventionResult]:
        north = next(zone for zone in snapshot.zones if zone.zone_id == "north_concourse")
        base_peak = max(north.density_estimate, north.density_estimate + 2.1)
        candidates = [
            self._result(
                "do-nothing",
                "Do nothing",
                [],
                base_peak,
                31.0,
                0,
                0,
                0,
                1,
                "No operational change; congestion continues under current flow conditions.",
            ),
            self._result(
                "open-gate-c",
                "Open Gate C",
                ["open_gate_c"],
                base_peak * 0.80,
                27.0,
                820,
                24,
                20,
                2,
                "Adds exit capacity but leaves opposing flow in the north concourse.",
            ),
            self._result(
                "redirect-sections",
                "Redirect sections 204–206",
                ["redirect_sections_204_206"],
                base_peak * 0.74,
                26.0,
                1480,
                108,
                26,
                3,
                "Reduces north-concourse inflow but adds walking distance for more attendees.",
            ),
            self._result(
                "combined-action",
                "Open Gate C and redirect sections",
                ["open_gate_c", "redirect_sections_204_206"],
                base_peak * 0.59,
                23.4,
                960,
                74,
                41,
                4,
                "Best safety-disruption trade-off with no accessibility violations.",
            ),
        ]
        feasible = [item for item in candidates if item.feasible and item.intervention_id != "do-nothing"]
        if snapshot.incidents.gate_b_closed and feasible:
            min(feasible, key=lambda item: (item.peak_density, item.people_redirected)).recommended = True
        return candidates

    @staticmethod
    def _result(
        intervention_id: str,
        name: str,
        actions: list[str],
        peak_density: float,
        clearance: float,
        redirected: int,
        extra_walk: float,
        reduction: float,
        complexity: int,
        explanation: str,
    ) -> InterventionResult:
        return InterventionResult(
            intervention_id=intervention_id,
            name=name,
            actions=actions,
            feasible=True,
            peak_density=round(peak_density, 2),
            clearance_time_minutes=clearance,
            people_redirected=redirected,
            extra_walk_meters_mean=extra_walk,
            risk_reduction_percent=reduction,
            operational_complexity=complexity,
            explanation=explanation,
        )

