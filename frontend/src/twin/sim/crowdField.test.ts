import { describe, expect, it } from "vitest";

import { TOTAL_POPULATION } from "../congestion/types";
import { MockScenarioEngine } from "../mock/engine";
import { MOCK_VENUE } from "../mock/venue";
import { CrowdField } from "./crowdField";

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
    const engine = new MockScenarioEngine();
    engine.triggerIncident("gate_b_closure");
    const snapshot = engine.snapshot();
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);

    field.advanceTo(12, snapshot);
    const first = field.telemetry();
    const firstExited = new Set(first.exitedAgents.map((agent) => agent.personId));
    expect(firstExited.size).toBeGreaterThan(0);
    expect(first.agents.length + first.exitedAgents.length).toBe(TOTAL_POPULATION);

    field.advanceTo(20, snapshot);
    const later = field.telemetry();
    const laterActive = new Set(later.agents.map((agent) => agent.personId));
    expect([...firstExited].some((personId) => laterActive.has(personId))).toBe(false);
    expect(later.agents.length + later.exitedAgents.length).toBe(TOTAL_POPULATION);
  });

  it("reroutes every active Gate B pedestrian when the operator closes it", () => {
    const engine = new MockScenarioEngine();
    engine.triggerIncident("gate_b_closure");
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);

    expect(field.telemetry().agents.filter((agent) => agent.targetGate === "gate_b").length).toBeGreaterThan(400);

    field.advanceTo(8, engine.snapshot());
    const sample = field.telemetry();

    expect(sample.agents.filter((agent) => agent.targetGate === "gate_b")).toHaveLength(0);
    expect(sample.exitedAgents.filter((agent) => agent.targetGate === "gate_b")).toHaveLength(0);
  });

  it("reroutes Gate B pedestrians after backend-confirmed congestion", () => {
    const engine = new MockScenarioEngine();
    const field = new CrowdField(MOCK_VENUE, TOTAL_POPULATION);
    const congestion = {
      runId: "test-run",
      sequence: 1,
      simulationTimeSeconds: 10,
      gates: MOCK_VENUE.gates.map((gate) => ({
        gateId: gate.id,
        label: gate.label,
        level: gate.id === "gate_b" ? ("high" as const) : ("normal" as const),
        congested: gate.id === "gate_b",
        peopleCount: gate.id === "gate_b" ? 180 : 0,
        densityPerM2: gate.id === "gate_b" ? 3.4 : 0,
        queueLength: gate.id === "gate_b" ? 126 : 0,
        meanSpeedMps: gate.id === "gate_b" ? 0.3 : 1.2,
        throughputPerMin: gate.id === "gate_b" ? 20 : 90,
        detectedAtSeconds: gate.id === "gate_b" ? 5 : null,
        reason: gate.id === "gate_b" ? "Congestion detected" : "Operating normally",
      })),
    };

    field.advanceTo(8, engine.snapshot(), congestion);
    const sample = field.telemetry();

    expect(sample.agents.filter((agent) => agent.targetGate === "gate_b")).toHaveLength(0);
    expect(sample.exitedAgents.filter((agent) => agent.targetGate === "gate_b")).toHaveLength(0);
  });
});
