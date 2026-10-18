import config from "../../../../shared/stadium-config.json";
import { angleDelta, ringArc, ringPoint } from "../domain/geometry";
import type { GateId, Point2, VenueLayout } from "../domain/types";

/** Shared with Python: circulation is inside the boundary, outside the stands. */
export const CONCOURSE_SCALE = config.movement.concourseScale;
export const QUEUE_INNER_SCALE = config.movement.queueInnerScale;
export const QUEUE_OUTER_SCALE = config.movement.queueOuterScale;
export const GATE_PORTAL_SCALE = config.ring.concourseOuter + config.movement.gatePortalOffset;

/** Preview exactly the same shortest circular path used by the pedestrians. */
export function boundaryRoute(venue: VenueLayout, from: GateId, to: GateId): Point2[] {
  const source = venue.gates.find((gate) => gate.id === from)!;
  const destination = venue.gates.find((gate) => gate.id === to)!;
  const end = source.angleDeg + angleDelta(source.angleDeg, destination.angleDeg);
  const { rx, rz } = venue.bowl;
  return [
    ringPoint(rx, rz, source.angleDeg, QUEUE_INNER_SCALE),
    ...ringArc(rx, rz, source.angleDeg, end, CONCOURSE_SCALE, 48),
    ringPoint(rx, rz, destination.angleDeg, GATE_PORTAL_SCALE),
    destination.destination,
  ];
}
