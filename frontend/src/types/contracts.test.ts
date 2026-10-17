import { describe, expect, it } from "vitest";

import { simulationSnapshotSchema } from "./contracts";

describe("simulationSnapshotSchema", () => {
  it("accepts a valid backend snapshot", () => {
    const parsed = simulationSnapshotSchema.parse({
      elapsed_minutes: 0,
      status: "idle",
      incidents: { gate_b_closed: false, metro_delayed: false },
      active_intervention: null,
      zones: [],
    });
    expect(parsed.status).toBe("idle");
  });
});

