import { describe, expect, it } from "vitest";

import { TOTAL_POPULATION, type CongestionSnapshot, type PersonTelemetry, type RouteAssignment } from "../congestion/types";
import { angleDelta, ringCoords } from "../domain/geometry";
import type { GateId, TwinSnapshot } from "../domain/types";
import { MockScenarioEngine } from "../mock/engine";
import { MOCK_VENUE } from "../mock/venue";
import { CrowdField } from "./crowdField";
import { CONCOURSE_SCALE, GATE_PORTAL_SCALE } from "./paths";

const openSnapshot = (): TwinSnapshot => new MockScenarioEngine().snapshot();
const closedSnapshot = (): TwinSnapshot => {
  const snapshot = openSnapshot();
  return { ...snapshot, gates: snapshot.gates.map((gate) => ({ ...gate, status: "closed" })) };
};
const withClosedGates = (...closed: GateId[]): TwinSnapshot => {
  const snapshot = openSnapshot();
  return { ...snapshot, gates: snapshot.gates.map((gate) => ({ ...gate, status: closed.includes(gate.id) ? "closed" : "open" })) };
};
const point = (field: CrowdField, id: number) => ({
  x: field.positions[id * 3],
  z: field.positions[id * 3 + 2],
});
const polar = (position: { x: number; z: number }) =>
  ringCoords(MOCK_VENUE.bowl.rx, MOCK_VENUE.bowl.rz, position.x, position.z);
const assignment = (person: PersonTelemetry, toGate: GateId): RouteAssignment => ({
  personId: person.personId,
  fromGate: person.targetGate,
  toGate,
  reason: "operator_plan",
  estimatedBenefitSeconds: 30,
});

describe("CrowdField person lifecycle", () => {
  it("creates exactly 4,000 persistent identities", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const sample = field.telemetry();
    expect(sample.agents).toHaveLength(TOTAL_POPULATION);
    expect(sample.exitedAgents).toHaveLength(0);
    expect(new Set(sample.agents.map((agent) => agent.personId)).size).toBe(TOTAL_POPULATION);
    expect(sample.agents.every((agent) => agent.movementState === "waiting")).toBe(true);
  });

  it("never respawns a person after exit", () => {
    const snapshot = openSnapshot();
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(36, snapshot);
    const first = field.telemetry();
    const firstExited = new Set(first.exitedAgents.map((agent) => agent.personId));
    expect(firstExited.size).toBeGreaterThan(0);
    expect(first.agents.length + first.exitedAgents.length).toBe(TOTAL_POPULATION);
    field.advanceTo(44, snapshot);
    const later = field.telemetry();
    const laterActive = new Set(later.agents.map((agent) => agent.personId));
    expect([...firstExited].some((personId) => laterActive.has(personId))).toBe(false);
    expect(later.agents.length + later.exitedAgents.length).toBe(TOTAL_POPULATION);
  });

  it("waits inside without crossing or inventing a route when every gate is closed", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const initial = field.telemetry().agents.map((agent) => agent.targetGate);
    field.advanceTo(60, closedSnapshot());
    const sample = field.telemetry();
    expect(sample.exitedAgents).toHaveLength(0);
    expect(sample.agents.map((agent) => agent.targetGate)).toEqual(initial);
    expect(sample.agents.every((agent) => polar(point(field, agent.personId)).scale < GATE_PORTAL_SCALE)).toBe(true);
    expect(sample.agents.some((agent) => agent.phase === "queue")).toBe(true);
  });

  it("does not autonomously change gates after backend-confirmed congestion", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const initial = new Map(field.telemetry().agents.map((agent) => [agent.personId, agent.targetGate]));
    const congestion: CongestionSnapshot = {
      runId: "test-run", sequence: 1, simulationTimeSeconds: 10,
      gates: MOCK_VENUE.gates.map((gate) => ({
        gateId: gate.id, label: gate.label, level: "high", congested: true,
        peopleCount: 180, densityPerM2: 3.4, queueLength: 126,
        meanSpeedMps: 0.3, throughputPerMin: 20, detectedAtSeconds: 5, reason: "Congestion detected",
      })),
    };
    field.advanceTo(28, openSnapshot(), congestion);
    const sample = field.telemetry();
    expect(sample.agents.every((agent) => agent.targetGate === initial.get(agent.personId))).toBe(true);
    expect(sample.exitedAgents.every((agent) => agent.targetGate === initial.get(agent.personId))).toBe(true);
  });
});

describe("CrowdField closed boundary gates", () => {
  it("stops even queue-served pedestrians before the portal; only already-outside people finish", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(24, openSnapshot());
    const before = field.telemetry();
    const approaching = before.agents.filter((agent) => agent.phase === "gate_approach");
    expect(approaching.length).toBeGreaterThan(0);
    expect(before.agents.some((agent) => agent.phase === "queue")).toBe(true);
    expect(before.agents.some((agent) => agent.phase === "exit")).toBe(true);
    const frozen = new Map(approaching.map((agent) => [agent.personId, point(field, agent.personId)]));
    const alreadyOutside = new Set([
      ...before.exitedAgents.map((agent) => agent.personId),
      ...before.agents.filter((agent) => agent.phase === "exit").map((agent) => agent.personId),
    ]);

    field.advanceTo(60, closedSnapshot());
    const after = field.telemetry();
    expect(new Set(after.exitedAgents.map((agent) => agent.personId))).toEqual(alreadyOutside);
    for (const agent of after.agents) {
      expect(polar(point(field, agent.personId)).scale).toBeLessThan(GATE_PORTAL_SCALE);
      if (frozen.has(agent.personId)) {
        expect(point(field, agent.personId)).toEqual(frozen.get(agent.personId));
        expect(agent.phase).toBe("gate_approach");
        expect(agent.speedMps).toBe(0);
        expect(agent.movementState).toBe("queued");
      }
    }

    field.advanceTo(78, openSnapshot());
    expect(field.telemetry().exitedAgents.length).toBeGreaterThan(alreadyOutside.size);
  });

  it("automatically leaves a closed gate for the nearest open doorway without backend approval", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(24, openSnapshot());
    const before = field.telemetry();
    const trapped = before.agents.filter((agent) => agent.targetGate === "gate_b" && (agent.phase === "queue" || agent.phase === "gate_approach"));
    expect(trapped.some((agent) => agent.phase === "queue")).toBe(true);
    expect(trapped.some((agent) => agent.phase === "gate_approach")).toBe(true);
    const originalPositions = new Map(trapped.map((agent) => [agent.personId, point(field, agent.personId)]));
    const outsideB = new Set([
      ...before.exitedAgents.filter((agent) => agent.targetGate === "gate_b").map((agent) => agent.personId),
      ...before.agents.filter((agent) => agent.targetGate === "gate_b" && agent.phase === "exit").map((agent) => agent.personId),
    ]);
    const closed = withClosedGates("gate_b");
    field.advanceTo(24.04, closed);
    const escaped = new Map(field.telemetry().agents.map((agent) => [agent.personId, agent]));
    for (const person of trapped) {
      const current = escaped.get(person.personId)!;
      const previous = originalPositions.get(person.personId)!;
      const next = point(field, person.personId);
      const reference = polar(previous).angleDeg;
      const distances = MOCK_VENUE.gates.filter((gate) => gate.id !== "gate_b").map((gate) => ({ gate, distance: Math.abs(angleDelta(reference, gate.angleDeg)) }));
      const nearest = Math.min(...distances.map((item) => item.distance));
      const tied = distances.filter((item) => Math.abs(item.distance - nearest) <= 1e-6);
      expect(current.targetGate).toBe(tied[person.personId % tied.length].gate.id);
      expect(current.phase).toBe("return_to_concourse");
      expect(Math.hypot(next.x - previous.x, next.z - previous.z)).toBeLessThan(0.11);
      expect(polar(next).scale).toBeGreaterThanOrEqual(CONCOURSE_SCALE - 0.0001);
    }
    field.advanceTo(80, closed);
    const after = field.telemetry();
    expect(after.agents.some((agent) => agent.targetGate === "gate_b")).toBe(false);
    expect(new Set(after.exitedAgents.filter((agent) => agent.targetGate === "gate_b").map((agent) => agent.personId))).toEqual(outsideB);
    expect(trapped.every((person) => after.exitedAgents.some((agent) => agent.personId === person.personId && agent.targetGate !== "gate_b"))).toBe(true);
  });

  it.each([8, 16, 24])("reassigns every inside phase at minute %s when its destination closes, but never outside walkers", (minute) => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(minute, openSnapshot());
    const before = field.telemetry();
    const outside = before.agents.filter((agent) => agent.phase === "exit");
    const insideB = before.agents.filter((agent) => agent.targetGate === "gate_b" && agent.phase !== "exit");
    expect(insideB.length).toBeGreaterThan(0);
    field.advanceTo(minute + 0.04, withClosedGates("gate_b"));
    const after = new Map(field.telemetry().agents.map((agent) => [agent.personId, agent]));
    for (const person of insideB) expect(after.get(person.personId)?.targetGate).not.toBe("gate_b");
    for (const person of outside) {
      const current = after.get(person.personId);
      if (current) expect(current.targetGate).toBe(person.targetGate);
    }
  });

  it("disperses exact-distance ties deterministically and does not turn people back when the old gate reopens", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const original = field.telemetry().agents.filter((agent) => agent.targetGate === "gate_b");
    field.advanceTo(0.04, withClosedGates("gate_b"));
    const escaped = new Map(field.telemetry().agents.map((agent) => [agent.personId, agent.targetGate]));
    expect(new Set(original.map((person) => escaped.get(person.personId)))).toEqual(new Set(["gate_a", "gate_c"]));
    for (const person of original) expect(escaped.get(person.personId)).toBe(person.personId % 2 === 0 ? "gate_a" : "gate_c");
    field.advanceTo(0.08, openSnapshot());
    expect(new Map(field.telemetry().agents.map((agent) => [agent.personId, agent.targetGate]))).toEqual(escaped);
  });

  it("rechecks blocked people when one gate opens and drains them along the circle", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(45, closedSnapshot());
    expect(field.telemetry().exitedAgents).toHaveLength(0);
    const onlyA = withClosedGates("gate_b", "gate_c", "gate_d", "gate_e", "gate_f", "gate_g", "gate_h");
    field.advanceTo(45.04, onlyA);
    expect(field.telemetry().agents.every((agent) => agent.targetGate === "gate_a")).toBe(true);
    field.advanceTo(110, onlyA);
    const after = field.telemetry();
    expect(after.exitedAgents.length).toBeGreaterThan(100);
    expect(after.exitedAgents.every((agent) => agent.targetGate === "gate_a")).toBe(true);
    expect(after.agents.every((agent) => agent.targetGate === "gate_a")).toBe(true);
  });

  it("rejects stale approved assignments to closed gates before or after local escape", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(24, openSnapshot());
    const person = field.telemetry().agents.find((agent) => agent.targetGate !== "gate_b" && agent.phase !== "exit")!;
    const previous = point(field, person.personId);
    expect(field.applyAssignments([assignment(person, "gate_b")], new Set(["gate_b"]))).toBe(0);
    expect(point(field, person.personId)).toEqual(previous);
    const originalB = field.telemetry().agents.find((agent) => agent.targetGate === "gate_b" && agent.phase === "queue")!;
    field.advanceTo(24.04, withClosedGates("gate_b"));
    const escaped = field.telemetry().agents.find((agent) => agent.personId === originalB.personId)!;
    expect(escaped.targetGate).not.toBe("gate_b");
    for (let step = 0; step < 20; step += 1) {
      expect(field.applyAssignments([assignment(escaped, "gate_b")])).toBe(0);
      field.advanceTo(field.time + 0.04, withClosedGates("gate_b"));
      expect(field.telemetry().agents.find((agent) => agent.personId === originalB.personId)?.targetGate).toBe(escaped.targetGate);
    }
  });

  it("physically walks a closed-gate escape along the circular lane without crossing the stands or jumping", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(24, openSnapshot());
    const person = field.telemetry().agents.find((agent) => agent.targetGate === "gate_b" && agent.phase === "gate_approach")!;
    const closed = withClosedGates("gate_b");
    let previous = point(field, person.personId);
    const sourceAngle = polar(previous).angleDeg;
    let arcTravel = 0;
    let reachedDoorway = false;
    for (let step = 0; step < 1200; step += 1) {
      field.advanceTo(field.time + 0.04, closed);
      const next = point(field, person.personId);
      const current = field.telemetry().agents.find((agent) => agent.personId === person.personId)!;
      expect(Math.hypot(next.x - previous.x, next.z - previous.z)).toBeLessThan(0.11);
      const position = polar(next);
      expect(position.scale).toBeGreaterThanOrEqual(CONCOURSE_SCALE - 0.0001);
      expect(position.scale).toBeLessThan(GATE_PORTAL_SCALE);
      if (current.phase === "concourse" && position.scale < CONCOURSE_SCALE + 0.0001) {
        arcTravel = Math.max(arcTravel, Math.abs(angleDelta(sourceAngle, position.angleDeg)));
      }
      if (current.phase === "queue" || current.phase === "gate_approach") {
        expect(current.targetGate).not.toBe("gate_b");
        reachedDoorway = true;
        break;
      }
      previous = next;
    }
    expect(arcTravel).toBeGreaterThan(30);
    expect(reachedDoorway).toBe(true);
  });
});

describe("CrowdField operator-approved outer-concourse routing", () => {
  it("rejects autonomous assignments and leaves outside pedestrians untouched", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const seated = field.telemetry().agents[0];
    const toGate = seated.targetGate === "gate_d" ? "gate_e" : "gate_d";
    expect(field.applyAssignments([{ ...assignment(seated, toGate), reason: "congestion" }])).toBe(0);
    field.advanceTo(24, openSnapshot());
    const outside = field.telemetry().agents.find((agent) => agent.phase === "exit")!;
    expect(outside).toBeDefined();
    expect(field.applyAssignments([assignment(outside, outside.targetGate === "gate_d" ? "gate_e" : "gate_d")])).toBe(0);
  });

  it.each(["queue", "gate_approach"] as const)("reroutes %s pedestrians around the outer circle, without teleporting or returning through the stands", (phase) => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.advanceTo(24, openSnapshot());
    const person = field.telemetry().agents.find((agent) => agent.phase === phase)!;
    expect(person).toBeDefined();
    const sourceIndex = MOCK_VENUE.gates.findIndex((gate) => gate.id === person.targetGate);
    const destination = MOCK_VENUE.gates[(sourceIndex + 2) % MOCK_VENUE.gates.length];
    let previous = point(field, person.personId);
    const sourceAngle = polar(previous).angleDeg;
    expect(field.applyAssignments([assignment(person, destination.id)])).toBe(1);
    expect(point(field, person.personId)).toEqual(previous);
    expect(field.telemetry().agents.find((agent) => agent.personId === person.personId)?.phase).toBe("return_to_concourse");

    let arcTravel = 0;
    let reachedQueue = false;
    const closed = openSnapshot();
    for (let step = 0; step < 1800; step += 1) {
      field.advanceTo(field.time + 0.04, closed);
      const next = point(field, person.personId);
      const current = field.telemetry().agents.find((agent) => agent.personId === person.personId)!;
      expect(Math.hypot(next.x - previous.x, next.z - previous.z)).toBeLessThan(0.11);
      const position = polar(next);
      expect(position.scale).toBeGreaterThanOrEqual(CONCOURSE_SCALE - 0.0001);
      expect(position.scale).toBeLessThan(GATE_PORTAL_SCALE);
      if (current.phase === "concourse" && position.scale < CONCOURSE_SCALE + 0.0001) {
        arcTravel = Math.max(arcTravel, Math.abs(angleDelta(sourceAngle, position.angleDeg)));
      }
      if (current.phase === "queue" || current.phase === "gate_approach") {
        expect(current.targetGate).toBe(destination.id);
        expect(Math.abs(angleDelta(position.angleDeg, destination.angleDeg))).toBeLessThan(0.01);
        reachedQueue = true;
        break;
      }
      previous = next;
    }
    expect(arcTravel).toBeGreaterThan(30);
    expect(reachedQueue).toBe(true);
  });

  it("uses the nearest access passage independently of the approved boundary exit", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const person = field.telemetry().agents[0];
    const source = MOCK_VENUE.gates.find((gate) => gate.id === person.targetGate)!;
    const destination = MOCK_VENUE.gates.find((gate) => Math.abs(angleDelta(source.angleDeg, gate.angleDeg)) > 90)!;
    expect(field.applyAssignments([assignment(person, destination.id)])).toBe(1);
    let reachedPassage = false;
    const closed = openSnapshot();
    for (let step = 0; step < 750; step += 1) {
      field.advanceTo(field.time + 0.04, closed);
      const current = field.telemetry().agents.find((agent) => agent.personId === person.personId)!;
      if (current.phase === "gate_corridor") {
        expect(Math.abs(angleDelta(polar(point(field, person.personId)).angleDeg, source.angleDeg))).toBeLessThan(0.001);
        expect(current.targetGate).toBe(destination.id);
        reachedPassage = true;
        break;
      }
    }
    expect(reachedPassage).toBe(true);
  });

  it("finishes its access passage before circulating after a mid-passage reassignment", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const closed = openSnapshot();
    field.advanceTo(12, closed);
    const person = field.telemetry().agents.find((agent) => agent.phase === "gate_corridor")!;
    expect(person).toBeDefined();
    const source = polar(point(field, person.personId));
    const destination = MOCK_VENUE.gates.find((gate) => Math.abs(angleDelta(source.angleDeg, gate.angleDeg)) > 90)!;
    expect(field.applyAssignments([assignment(person, destination.id)])).toBe(1);
    field.advanceTo(field.time + 0.04, closed);
    const next = polar(point(field, person.personId));
    expect(Math.abs(angleDelta(source.angleDeg, next.angleDeg))).toBeLessThan(0.001);
    expect(next.scale).toBeGreaterThan(source.scale);
    expect(next.scale).toBeLessThanOrEqual(CONCOURSE_SCALE + 0.0001);
  });

  it("returns to the circulation lane before turning during a last-moment queue approach reroute", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const closed = openSnapshot();
    field.advanceTo(20, closed);
    const person = field.telemetry().agents.find((agent) => agent.phase === "concourse" && polar(point(field, agent.personId)).scale > CONCOURSE_SCALE + 0.01)!;
    expect(person).toBeDefined();
    const previous = point(field, person.personId);
    const source = polar(previous);
    const destination = MOCK_VENUE.gates.find((gate) => Math.abs(angleDelta(source.angleDeg, gate.angleDeg)) > 90)!;
    expect(field.applyAssignments([assignment(person, destination.id)])).toBe(1);
    expect(point(field, person.personId)).toEqual(previous);
    expect(field.telemetry().agents.find((agent) => agent.personId === person.personId)?.phase).toBe("return_to_concourse");
    field.advanceTo(field.time + 0.04, closed);
    const next = polar(point(field, person.personId));
    expect(Math.abs(angleDelta(source.angleDeg, next.angleDeg))).toBeLessThan(0.001);
    expect(next.scale).toBeLessThan(source.scale);
    expect(next.scale).toBeGreaterThanOrEqual(CONCOURSE_SCALE - 0.0001);
  });

  it("replaces section holds so stopping a plan releases seated people", () => {
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    field.setHolds([{ section: 201, untilSeconds: 3600 }]);
    field.advanceTo(20, openSnapshot());
    expect(field.telemetry().agents.filter((agent) => agent.personId % 24 === 0).every((agent) => agent.phase === "waiting")).toBe(true);
    field.setHolds([]);
    field.advanceTo(30, openSnapshot());
    expect(field.telemetry().agents.filter((agent) => agent.personId % 24 === 0).some((agent) => agent.phase !== "waiting")).toBe(true);
  });
});
