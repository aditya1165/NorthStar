import { describe, expect, it } from "vitest";

import { parseSnapshot } from "./CongestionClient";

describe("parseSnapshot", () => {
  const base = {
    message_type: "congestion",
    run_id: "run",
    sequence: 3,
    simulation_time_seconds: 90,
    gates: [],
  };

  it("keeps detector-only replies backwards compatible", () => {
    const snapshot = parseSnapshot(base);
    expect(snapshot?.routing).toBeUndefined();
    expect(snapshot?.zones).toBeUndefined();
  });

  it("parses routing deltas, holds, zones, and forecasts", () => {
    const snapshot = parseSnapshot({
      ...base,
      routing: {
        assignments: [{ person_id: 7, from_gate: "gate_b", to_gate: "gate_c", reason: "gate_closed", estimated_benefit_seconds: 0 }],
        holds: [{ section: 205, until_seconds: 300 }],
        gate_wait_seconds: { gate_b: null, gate_c: 42 },
        redirected_total: 1,
        active_plan_id: null,
      },
      zones: [
        {
          zone_id: "gate_b_approach",
          name: "Gate B approach",
          kind: "gate_approach",
          gate_id: "gate_b",
          people_count: 10,
          density_per_m2: 0.4,
          inflow_per_min: 5,
          outflow_per_min: 1,
          mean_speed_mps: 0.9,
          queue_length: 2,
          level: "normal",
          status: "closed",
        },
      ],
      forecasts: [
        {
          zone_id: "gate_b_approach",
          horizon_minutes: 5,
          predicted_density: 0.6,
          baseline_density: 0.8,
          low: 0.4,
          high: 0.8,
          level: "normal",
          risk_probability: 0.1,
          time_to_congestion_minutes: null,
          method: "gbm",
          top_factors: ["gate closed"],
        },
      ],
    });
    expect(snapshot?.routing?.assignments[0]).toEqual({
      personId: 7,
      fromGate: "gate_b",
      toGate: "gate_c",
      reason: "gate_closed",
      estimatedBenefitSeconds: 0,
    });
    expect(snapshot?.routing?.holds).toEqual([{ section: 205, untilSeconds: 300 }]);
    expect(snapshot?.zones?.[0].status).toBe("closed");
    expect(snapshot?.forecasts?.[0].method).toBe("gbm");
  });
});
