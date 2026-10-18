import { ringArc, ringPoint } from "../domain/geometry";
import type { GateId, Point2, SeatingSection, VenueLayout } from "../domain/types";
import stadiumConfig from "../../../../shared/stadium-config.json";

/**
 * Stadium geometry is sourced from the same checked-in configuration that the
 * Python detector loads. Angles: 0° east, 90° south.
 */
const RX = stadiumConfig.bowl.rx;
const RZ = stadiumConfig.bowl.rz;
const LANE = 1.2;

const sections: SeatingSection[] = Array.from({ length: 24 }, (_, k) => ({
  id: `s${201 + k}`,
  label: String(201 + k),
  angleDeg: -30 + k * 15,
}));

const p = (angleDeg: number, scale: number): Point2 => ringPoint(RX, RZ, angleDeg, scale);

export const MOCK_VENUE: VenueLayout = {
  id: "meridian-stadium",
  name: "Meridian Stadium",
  bowl: { rx: RX, rz: RZ },
  ring: stadiumConfig.ring,
  sections,
  gates: stadiumConfig.gates.map((gate) => ({
    id: gate.id as GateId,
    label: gate.label,
    angleDeg: gate.angleDeg,
    capacityPerMinute: stadiumConfig.gateDefaults.capacityPerMinute,
    destination: p(gate.angleDeg, 1.62),
  })),
  zones: [
    { id: "north_concourse", label: "North Concourse", shape: { kind: "ring", fromDeg: -130, toDeg: -50 }, areaM2: 1450 },
    { id: "east_concourse", label: "East Concourse", shape: { kind: "ring", fromDeg: -50, toDeg: 20, labelDeg: -38 }, areaM2: 1180 },
    { id: "southeast_concourse", label: "Southeast Concourse", shape: { kind: "ring", fromDeg: 20, toDeg: 95, labelDeg: 84 }, areaM2: 1240 },
    { id: "south_concourse", label: "South Concourse", shape: { kind: "ring", fromDeg: 95, toDeg: 150 }, areaM2: 980 },
    { id: "west_concourse", label: "West Concourse", shape: { kind: "ring", fromDeg: 150, toDeg: 230, labelDeg: 214 }, areaM2: 1460 },
    { id: "metro_plaza", label: "Metro Plaza", shape: { kind: "plaza", center: p(57, 1.66), radius: 3.1 }, areaM2: 620 },
  ],
  transit: { id: "metro", label: "Metro · Stadium Line", position: p(57, 1.95), angleDeg: 57 },
  routes: [
    { id: "gate_c_ring", label: "Southeast concourse → Gate C", points: [...ringArc(RX, RZ, 50, -15, LANE, 28), p(-15, 1.36)] },
    {
      id: "redirect_205_208_inner",
      label: "Sections 205–208 → Gate C (inner concourse)",
      points: [p(76, 0.98), ...ringArc(RX, RZ, 76, -11, 1.1, 32), p(-15, 1.3), p(-15, 1.36)],
    },
    { id: "redirect_to_gate_a", label: "Sections 205–208 → Gate A (south)", points: [...ringArc(RX, RZ, 70, 190, LANE, 40), p(190, 1.36)] },
    { id: "one_way_east_corridor", label: "One-way southbound corridor", points: ringArc(RX, RZ, 28, 120, LANE, 30) },
  ],
};
