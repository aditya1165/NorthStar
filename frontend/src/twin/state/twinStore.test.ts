import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CongestionClient } from "../congestion/CongestionClient";
import type { CongestionConnectionStatus, CongestionSnapshot, CongestionTelemetryBatch } from "../congestion/types";
import type { GateId, TwinSnapshot } from "../domain/types";
import type { LiveEvaluation, LivePlan } from "../live/api";
import { MockScenarioEngine } from "../mock/engine";
import { MOCK_VENUE } from "../mock/venue";
import type { CrowdTwinService } from "../services/CrowdTwinService";

const api = vi.hoisted(() => ({ evaluate: vi.fn(), approve: vi.fn() }));
vi.mock("../live/api", () => ({ evaluateInterventions: api.evaluate, approveIntervention: api.approve }));

function evaluation(id = "evaluation-1", runId = "run-1"): LiveEvaluation {
  const candidate = {
    interventionId: "redirect_sections", name: "Redirect to Gate C", summary: "Use the outer concourse",
    actions: ["Redirect sections 201 to Gate C"], feasible: true, rejectionReason: null, recommended: true,
    rollouts: 1, peakDensity: 1, peakDensityRange: [1, 1] as [number, number], secondsAboveHigh: 0,
    maxQueue: 10, maxQueueGate: "gate_b" as GateId, clearanceMinutes: 20,
    clearanceRange: [20, 20] as [number, number], peopleRedirected: 100, extraWalkMeters: 20,
    riskReductionPercent: 20, secondaryBottleneck: null, operationalComplexity: 1,
    redirectGate: "gate_c" as GateId,
  };
  return {
    evaluationId: id, runId, evaluatedAtSeconds: 60, hotspotGate: "gate_b", closedGates: [],
    horizonMinutes: 12, seeds: [1], complianceLevels: [1], recommendedId: candidate.interventionId,
    rationale: "Lower boundary-gate queue", candidates: [candidate, {
      ...candidate, interventionId: "do_nothing", name: "Keep current routes", actions: ["Keep current routes"],
      recommended: false, redirectGate: null,
    }],
  };
}

function plan(id = "redirect_sections", runId = "run-1"): LivePlan {
  return { runId, interventionId: id, name: id, approvedAtSeconds: 60, actions: [id] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let store: typeof import("./twinStore").useTwinStore;
let dispose: (() => void)[];
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

function harness(status: TwinSnapshot["status"] = "running") {
  let snapshot: TwinSnapshot = { ...new MockScenarioEngine().snapshot(), minute: 1, status };
  let listener: (value: TwinSnapshot) => void = () => {};
  const emit = (patch: Partial<TwinSnapshot>) => { snapshot = { ...snapshot, ...patch }; listener(snapshot); };
  const service: CrowdTwinService = {
    getSnapshot: () => snapshot, getVenue: async () => MOCK_VENUE,
    subscribe: (fn) => { listener = fn; fn(snapshot); return () => { listener = () => {}; }; },
    start: vi.fn(async () => emit({ status: "running" })), pause: vi.fn(async () => emit({ status: "paused" })),
    resume: vi.fn(async () => emit({ status: "running" })),
    reset: vi.fn(async () => emit({ epoch: snapshot.epoch + 1, minute: 0, status: "idle" })),
    setSpeed: vi.fn(async () => {}),
    setGateStatus: vi.fn(async (gateId, gateStatus) => emit({ gates: snapshot.gates.map((gate) => gate.id === gateId ? { ...gate, status: gateStatus } : gate) })),
    triggerIncident: vi.fn(async () => {}), jumpToIncident: vi.fn(async () => {}),
    approveIntervention: vi.fn(async () => {}), rejectRecommendation: vi.fn(async () => {}), dispose: vi.fn(),
  };
  let handlers!: { onConnection(status: CongestionConnectionStatus): void; onSnapshot(snapshot: CongestionSnapshot): void };
  const client = {
    connect: (value: typeof handlers) => { handlers = value; }, publish: vi.fn(), dispose: vi.fn(),
  };
  dispose.push(store.getState().connect(service));
  dispose.push(store.getState().connectCongestion(client as unknown as CongestionClient));
  handlers.onConnection("connected");
  const publish = (sequence = 0, runId = "run-1", closedGates: GateId[] = []) => {
    const batch: CongestionTelemetryBatch = {
      runId, sequence, simulationTimeSeconds: snapshot.minute * 60, population: 4000,
      closedGates, agents: [], exitedAgents: [],
    };
    store.getState().publishTelemetry(batch);
  };
  const reply = (sequence = 0, runId = "run-1", activePlanId: string | null = null) => handlers.onSnapshot({
    runId, sequence, simulationTimeSeconds: snapshot.minute * 60, gates: [],
    routing: { assignments: [], holds: [], gateWaitSeconds: {}, redirectedTotal: 0, activePlanId },
  });
  return { emit, publish, reply, service, client, connection: handlers.onConnection };
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.resetModules();
  api.evaluate.mockReset().mockImplementation(async (runId: string) => evaluation("evaluation-1", runId));
  api.approve.mockReset().mockImplementation(async (runId: string, id: string) => plan(id, runId));
  store = (await import("./twinStore")).useTwinStore;
  dispose = [];
});

afterEach(() => { dispose.reverse().forEach((fn) => fn()); vi.useRealTimers(); });

describe("live operator decisions", () => {
  it("automatically evaluates after Start and acknowledged telemetry, never auto-approves", async () => {
    const h = harness("idle");
    h.publish(); h.reply();
    expect(api.evaluate).not.toHaveBeenCalled();
    store.getState().start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.evaluate).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(store.getState().liveEvaluation?.evaluationId).toBe("evaluation-1");
    expect(api.approve).not.toHaveBeenCalled();
    expect(h.service.approveIntervention).not.toHaveBeenCalled();
  });

  it("does not evaluate before telemetry acknowledgement or when disconnected", async () => {
    const h = harness();
    h.publish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.evaluate).not.toHaveBeenCalled();
    h.connection("unavailable"); h.reply();
    expect(api.evaluate).not.toHaveBeenCalled();
    h.connection("connected");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.evaluate).not.toHaveBeenCalled();
    h.publish(1); h.reply(1);
    await flush();
    expect(api.evaluate).toHaveBeenCalledOnce();
  });

  it("keeps paused evaluations stable and refreshes after manual gate changes and fresh same-time telemetry", async () => {
    const h = harness("paused"); h.publish(); h.reply(); await flush();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(api.evaluate).toHaveBeenCalledOnce();
    const nonce = store.getState().telemetryNonce;
    store.getState().setGateStatus("gate_b", "closed");
    expect(store.getState().liveEvaluation).toBeNull();
    expect(store.getState().telemetryNonce).toBeGreaterThan(nonce);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.evaluate).toHaveBeenCalledOnce();
    h.publish(1, "run-1", ["gate_b"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.evaluate).toHaveBeenCalledOnce();
    h.reply(1); await flush();
    expect(api.evaluate).toHaveBeenCalledTimes(2);
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("pins the exact displayed result while a background refresh finishes", async () => {
    const h = harness(); h.publish(); h.reply(); await flush();
    const next = deferred<LiveEvaluation>(); api.evaluate.mockReturnValueOnce(next.promise);
    h.emit({ minute: 2 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.getState().liveEvaluationStatus).toBe("evaluating");
    store.getState().selectLive("redirect_sections");
    next.resolve(evaluation("replacement")); await flush();
    expect(store.getState().liveEvaluation?.evaluationId).toBe("evaluation-1");
    expect(store.getState().liveSelectedId).toBe("redirect_sections");
    await vi.advanceTimersByTimeAsync(31_000);
    expect(api.evaluate).toHaveBeenCalledTimes(2);
    await store.getState().approveLive();
    expect(api.approve).toHaveBeenCalledExactlyOnceWith("run-1", "redirect_sections", "evaluation-1");
    expect(store.getState().liveApprovedRoute).toEqual({ from: "gate_b", to: "gate_c" });
  });

  it("does not replace a displayed decision during approval, even without pinning", async () => {
    const h = harness(); h.publish(); h.reply(); await flush();
    const background = deferred<LiveEvaluation>(); api.evaluate.mockReturnValueOnce(background.promise);
    h.emit({ minute: 2 }); await vi.advanceTimersByTimeAsync(30_000);
    const approval = deferred<LivePlan>(); api.approve.mockReturnValueOnce(approval.promise);
    const pending = store.getState().approveLive();
    background.resolve(evaluation("background")); await flush();
    expect(store.getState().liveEvaluation?.evaluationId).toBe("evaluation-1");
    // A routing response can arrive before the HTTP approval response.
    h.publish(1); h.reply(1, "run-1", "redirect_sections");
    approval.resolve(plan()); await pending;
    expect(store.getState().livePlan?.interventionId).toBe("redirect_sections");
  });

  it("resumes recommendations immediately when a paused operator unpins", async () => {
    const h = harness("paused"); h.publish(); h.reply(); await flush();
    store.getState().selectLive("redirect_sections");
    store.getState().selectLive(null); await flush();
    expect(api.evaluate).toHaveBeenCalledTimes(2);
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("keeps a pinned valid decision when a background refresh fails", async () => {
    const h = harness(); h.publish(); h.reply(); await flush();
    const background = deferred<LiveEvaluation>(); api.evaluate.mockReturnValueOnce(background.promise);
    h.emit({ minute: 2 }); await vi.advanceTimersByTimeAsync(30_000);
    store.getState().selectLive("redirect_sections");
    background.reject(new Error("Background temporarily unavailable")); await flush();
    expect(store.getState().liveEvaluation?.evaluationId).toBe("evaluation-1");
    expect(store.getState().liveEvaluationError).toBeNull();
    await store.getState().approveLive();
    expect(api.approve).toHaveBeenCalledExactlyOnceWith("run-1", "redirect_sections", "evaluation-1");
  });

  it("lets an operator explicitly choose Keep current routes without a previous plan", async () => {
    const h = harness(); h.publish(); h.reply(); await flush();
    store.getState().selectLive("do_nothing");
    await store.getState().approveLive();
    expect(api.approve).toHaveBeenCalledExactlyOnceWith("run-1", "do_nothing", "evaluation-1");
    expect(store.getState().livePlan).toBeNull();
    expect(store.getState().liveApprovalMessage).toContain("Current routes kept");
    expect(h.service.setGateStatus).not.toHaveBeenCalled();
  });

  it("expires a pinned evaluation after 120 seconds and refreshes without auto-approval", async () => {
    const h = harness("paused"); h.publish(); h.reply(); await flush();
    store.getState().selectLive("redirect_sections");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.getState().liveSelectedId).toBeNull();
    expect(api.evaluate).toHaveBeenCalledTimes(2);
    expect(api.approve).not.toHaveBeenCalled();
  });

  it("rejects expired approval synchronously, before the periodic expiry tick", async () => {
    const h = harness(); h.publish(); h.reply(); await flush();
    vi.setSystemTime(Date.now() + 120_000);
    await store.getState().approveLive();
    expect(api.approve).not.toHaveBeenCalled();
    expect(store.getState().liveEvaluation).toBeNull();
  });

  it("ignores an old evaluation after reset without clearing the new run's pending state", async () => {
    const old = deferred<LiveEvaluation>(); const current = deferred<LiveEvaluation>();
    api.evaluate.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const h = harness(); h.publish(); h.reply();
    store.getState().reset(); store.getState().start();
    h.publish(0, "run-2"); h.reply(0, "run-2");
    expect(api.evaluate).toHaveBeenCalledTimes(2);
    old.resolve(evaluation("old")); await flush();
    expect(store.getState().liveEvaluation).toBeNull();
    expect(store.getState().liveEvaluationStatus).toBe("evaluating");
    current.resolve(evaluation("new", "run-2")); await flush();
    expect(store.getState().liveEvaluation?.evaluationId).toBe("new");
  });

  it("ignores an old approval after reset without unlocking a new approval", async () => {
    const h = harness(); h.publish(); h.reply(); await flush();
    const old = deferred<LivePlan>(); const current = deferred<LivePlan>();
    api.approve.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const oldPending = store.getState().approveLive();
    store.getState().reset(); store.getState().start();
    h.publish(0, "run-2"); h.reply(0, "run-2"); await flush();
    const newPending = store.getState().approveLive();
    old.resolve(plan()); await oldPending;
    expect(store.getState().liveApprovalPending).toBe(true);
    expect(store.getState().livePlan).toBeNull();
    current.resolve(plan("redirect_sections", "run-2")); await newPending;
    expect(store.getState().livePlan?.runId).toBe("run-2");
    expect(store.getState().liveApprovalPending).toBe(false);
  });

  it("discards a result evaluated with previous gate settings", async () => {
    const pending = deferred<LiveEvaluation>(); api.evaluate.mockReturnValueOnce(pending.promise);
    const h = harness(); h.publish(); h.reply();
    store.getState().setGateStatus("gate_d", "closed");
    pending.resolve(evaluation("old-gates")); await flush();
    expect(store.getState().liveEvaluation).toBeNull();
    expect(api.approve).not.toHaveBeenCalled();
  });
});
