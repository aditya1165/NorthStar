import { describe, expect, it } from "vitest";

import config from "../../../../shared/stadium-config.json";
import { angleDelta, ringCoords, ringPoint } from "../domain/geometry";
import { MOCK_VENUE } from "../mock/venue";
import { boundaryRoute, CONCOURSE_SCALE, GATE_PORTAL_SCALE, QUEUE_INNER_SCALE, QUEUE_OUTER_SCALE } from "./paths";

describe("Boundary-gate route preview", () => {
  it("uses the shared circulation, queue, and actual doorway geometry", () => {
    expect(CONCOURSE_SCALE).toBe(config.movement.concourseScale);
    expect(QUEUE_INNER_SCALE).toBe(config.movement.queueInnerScale);
    expect(QUEUE_OUTER_SCALE).toBe(config.movement.queueOuterScale);
    expect(GATE_PORTAL_SCALE).toBeCloseTo(config.ring.concourseOuter + config.movement.gatePortalOffset, 10);
    expect(CONCOURSE_SCALE).toBeGreaterThan(config.ring.seatOuter);
    expect(QUEUE_INNER_SCALE).toBeGreaterThan(CONCOURSE_SCALE);
    expect(QUEUE_OUTER_SCALE).toBeLessThan(GATE_PORTAL_SCALE);
  });

  it("takes the shortest circular route for every gate pair, staying outside the stands before crossing the destination doorway", () => {
    const { rx, rz } = MOCK_VENUE.bowl;
    for (const source of MOCK_VENUE.gates) {
      for (const destination of MOCK_VENUE.gates) {
        const route = boundaryRoute(MOCK_VENUE, source.id, destination.id);
        expect(route[0]).toEqual(ringPoint(rx, rz, source.angleDeg, QUEUE_INNER_SCALE));
        const arc = route.slice(1, -2).map(([x, z]) => ringCoords(rx, rz, x, z));
        expect(arc).toHaveLength(49);
        let travel = 0;
        for (let index = 0; index < arc.length; index += 1) {
          expect(arc[index].scale).toBeCloseTo(CONCOURSE_SCALE, 10);
          expect(arc[index].scale).toBeGreaterThan(MOCK_VENUE.ring.seatOuter);
          expect(arc[index].scale).toBeLessThan(QUEUE_INNER_SCALE);
          if (index > 0) travel += angleDelta(arc[index - 1].angleDeg, arc[index].angleDeg);
        }
        expect(travel).toBeCloseTo(angleDelta(source.angleDeg, destination.angleDeg), 8);
        expect(Math.abs(travel)).toBeLessThanOrEqual(180 + 1e-8);
        expect(route.at(-2)).toEqual(ringPoint(rx, rz, destination.angleDeg, GATE_PORTAL_SCALE));
        expect(route.at(-1)).toEqual(destination.destination);
        for (const [x, z] of route.slice(0, -1)) {
          const { scale } = ringCoords(rx, rz, x, z);
          expect(scale).toBeGreaterThanOrEqual(CONCOURSE_SCALE - 1e-8);
          expect(scale).toBeLessThanOrEqual(GATE_PORTAL_SCALE + 1e-8);
        }
      }
    }
  });
});
