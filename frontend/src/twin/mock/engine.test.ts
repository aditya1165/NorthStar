import { describe, expect, it } from "vitest";

import type { ScenarioStage } from "../domain/types";
import { MockScenarioEngine } from "./engine";
import { SCENARIO } from "./scenario";

function runUntil(engine: MockScenarioEngine, predicate: () => boolean, limit = SCENARIO.duration) {
  while (!predicate() && engine.minute < limit) engine.advance(SCENARIO.step);
}

describe("MockScenarioEngine", () => {
  it("progresses through every stage from normal egress to stabilized", () => {
    const engine = new MockScenarioEngine();
    engine.setStatus("running");
    const seen: ScenarioStage[] = [engine.snapshot().stage];
    const levels = new Set<string>();

    runUntil(engine, () => engine.snapshot().stage === "recommendation_available");
    // Re-run deterministically to record intermediate stages.
    const replay = new MockScenarioEngine();
    replay.setStatus("running");
    while (replay.minute < engine.minute) {
      replay.advance(SCENARIO.step);
      const snap = replay.snapshot();
      levels.add(snap.risk.level);
      if (seen.at(-1) !== snap.stage) seen.push(snap.stage);
    }

    const snap = engine.snapshot();
    expect(snap.recommendation?.interventionId).toBe("gate_c_and_redirect");
    expect(snap.risk.minutesToUnsafe).toBeGreaterThan(3);
    expect(snap.interventions).toHaveLength(5);

    engine.approve("gate_c_and_redirect");
    runUntil(engine, () => engine.snapshot().stage === "stabilized");
    const done = engine.snapshot();
    expect(done.stage).toBe("stabilized");
    expect(done.gates.find((g) => g.id === "gate_c")?.status).toBe("open");
    expect(done.risk.level).toBe("normal");
    expect(done.risk.clearanceMinutes).toBeLessThan(snap.risk.clearanceMinutes);

    expect(seen).toEqual([
      "normal",
      "gate_closure",
      "metro_delay",
      "elevated_risk",
      "critical_forecast",
      "recommendation_available",
    ]);
    expect(levels.has("elevated")).toBe(true);
  });

  it("reaches critical density when nobody intervenes", () => {
    const engine = new MockScenarioEngine();
    engine.setStatus("running");
    runUntil(engine, () => engine.snapshot().risk.level === "critical");
    expect(engine.snapshot().risk.level).toBe("critical");
    expect(engine.snapshot().stage).toBe("recommendation_available");
  });

  it("ranks the combined response best and flags trade-offs of the others", () => {
    const engine = new MockScenarioEngine();
    engine.jumpTo(SCENARIO.incidentMinute);
    const options = Object.fromEntries(engine.snapshot().interventions.map((o) => [o.id, o]));
    expect(options.gate_c_and_redirect.recommended).toBe(true);
    expect(options.gate_c_and_redirect.outcome.peakDensity).toBeLessThan(options.open_gate_c.outcome.peakDensity);
    expect(options.one_way_corridor.outcome.secondaryBottleneck).toBe("south_concourse");
    expect(options.one_way_corridor.outcome.accessibleRoutesPreserved).toBe(false);
    expect(options.do_nothing.outcome.peakLevel).toBe("critical");
  });

  it("is deterministic and reset returns to the initial state", () => {
    const a = new MockScenarioEngine();
    const b = new MockScenarioEngine();
    a.jumpTo(SCENARIO.incidentMinute);
    b.jumpTo(SCENARIO.incidentMinute);
    expect(a.snapshot().zones).toEqual(b.snapshot().zones);

    const before = a.snapshot().epoch;
    a.reset();
    const snap = a.snapshot();
    expect(snap.epoch).toBe(before + 1);
    expect(snap.minute).toBe(0);
    expect(snap.stage).toBe("normal");
    expect(snap.status).toBe("idle");
    expect(snap.interventions).toHaveLength(0);
  });

  it("supports manual incidents and rejection", () => {
    const engine = new MockScenarioEngine();
    engine.setStatus("running");
    engine.advance(1);
    engine.triggerIncident("gate_b_closure");
    expect(engine.snapshot().events.gateBClosedAt).toBe(1);
    expect(engine.snapshot().stage).toBe("gate_closure");

    engine.jumpTo(SCENARIO.incidentMinute);
    engine.reject();
    expect(engine.snapshot().recommendation?.status).toBe("rejected");
    expect(engine.snapshot().activePlan).toBeNull();
  });
});
