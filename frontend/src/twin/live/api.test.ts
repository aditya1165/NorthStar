import { afterEach, describe, expect, it, vi } from "vitest";

import { approveIntervention, evaluateInterventions } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("live decision HTTP contract", () => {
  it("posts the exact evaluation UUID for approval and parses the plan", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      run_id: "run 1", intervention_id: "do_nothing", name: "Keep current routes",
      approved_at_seconds: 120, actions: ["Leave gate controls unchanged"],
    })));
    vi.stubGlobal("fetch", fetch);
    const result = await approveIntervention("run 1", "do_nothing", "exact-evaluation-uuid");
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/runs/run%201/interventions/do_nothing/approve"), expect.objectContaining({
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evaluation_id: "exact-evaluation-uuid" }), signal: expect.any(AbortSignal),
    }));
    expect(result).toMatchObject({ runId: "run 1", interventionId: "do_nothing", approvedAtSeconds: 120 });
  });

  it("retains the backend evaluation identity and target gate when parsing recommendations", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      evaluation_id: "immutable-id", run_id: "run-1", evaluated_at_seconds: 60,
      hotspot_gate: "gate_b", closed_gates: ["gate_b"], horizon_minutes: 12, seeds: [1], compliance_levels: [1],
      candidates: [{ intervention_id: "redirect_sections", plan: { redirect_gate: "gate_c" } }],
      recommended_id: "redirect_sections", rationale: "Avoid the closed boundary gate",
    }))));
    const result = await evaluateInterventions("run-1");
    expect(result.evaluationId).toBe("immutable-id");
    expect(result.candidates[0].redirectGate).toBe("gate_c");
    expect(result.closedGates).toEqual(["gate_b"]);
  });

  it("surfaces the backend reason when an evaluation can no longer be approved", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Gates changed; evaluate again" }), { status: 400 })));
    await expect(approveIntervention("run-1", "do_nothing", "expired")).rejects.toThrow("Gates changed; evaluate again");
  });
});
