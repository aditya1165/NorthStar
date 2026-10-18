import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveCandidate, LiveEvaluation, LivePlan } from "../live/api";
import { useTwinStore } from "../state/twinStore";
import { LiveResponsePanel } from "./LiveResponses";

const candidate = (overrides: Partial<LiveCandidate> = {}): LiveCandidate => ({
  interventionId: "redirect_c",
  name: "Use Gate C",
  summary: "Walk around the outer concourse to Gate C.",
  actions: ["Redirect sections 205–208 to Gate C.", "Leave all boundary gate controls unchanged."],
  feasible: true,
  rejectionReason: null,
  recommended: true,
  rollouts: 4,
  peakDensity: 2.5,
  peakDensityRange: [2.2, 2.8],
  secondsAboveHigh: 0,
  maxQueue: 80,
  maxQueueGate: "gate_c",
  clearanceMinutes: 18,
  clearanceRange: [17, 19],
  peopleRedirected: 120,
  extraWalkMeters: 40,
  riskReductionPercent: 20,
  secondaryBottleneck: null,
  operationalComplexity: 1,
  redirectGate: "gate_c",
  ...overrides,
});

const baseline = candidate({
  interventionId: "do_nothing",
  name: "Keep current routes",
  summary: "Retain current assignments without opening or closing a gate.",
  actions: ["Keep existing gate assignments.", "Stop the active routing plan and release holds."],
  recommended: false,
  peopleRedirected: 0,
  riskReductionPercent: 0,
  redirectGate: null,
});

const evaluation: LiveEvaluation = {
  evaluationId: "evaluation-exact-review",
  runId: "test-run",
  evaluatedAtSeconds: 1440,
  hotspotGate: "gate_b",
  closedGates: ["gate_b"],
  horizonMinutes: 10,
  seeds: [7, 9],
  complianceLevels: [0.8, 1],
  candidates: [baseline, candidate(), candidate({
    interventionId: "redirect_d", name: "Use Gate D", recommended: false,
    redirectGate: "gate_d", actions: ["Redirect sections 205–208 to Gate D."],
  })],
  recommendedId: "redirect_c",
  rationale: "Gate C is the least-loaded feasible boundary exit in these rollouts.",
};

const initialState = useTwinStore.getInitialState();
const approveLive = vi.fn<() => Promise<void>>();

beforeEach(() => {
  approveLive.mockReset().mockResolvedValue(undefined);
  useTwinStore.setState({
    ...initialState,
    congestionConnection: "connected",
    liveRunId: "test-run",
    liveEvaluation: evaluation,
    liveEvaluationReceivedAt: Date.now(),
    approveLive,
  }, true);
});

afterEach(() => {
  cleanup();
  useTwinStore.setState(initialState, true);
});

describe("LiveResponsePanel operator approval", () => {
  it("shows the recommended actions without executing them and allows explicit approval", () => {
    render(<LiveResponsePanel />);
    expect(screen.getByRole("radio", { name: /Use Gate C/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Redirect sections 205–208 to Gate C.")).toBeVisible();
    expect(screen.getByText("Leave all boundary gate controls unchanged.")).toBeVisible();
    expect(approveLive).not.toHaveBeenCalled();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    expect(approveLive).toHaveBeenCalledOnce();
  });

  it("pins an explicitly selected feasible alternative and displays its exact proposed actions", () => {
    render(<LiveResponsePanel />);
    fireEvent.click(screen.getByRole("radio", { name: /Use Gate D/ }));
    expect(useTwinStore.getState().liveSelectedId).toBe("redirect_d");
    expect(screen.getByRole("radio", { name: /Use Gate D/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Redirect sections 205–208 to Gate D.")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Review pinned");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(approveLive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Resume recommendations" }));
    expect(useTwinStore.getState().liveSelectedId).toBeNull();
    expect(screen.getByRole("radio", { name: /Use Gate C/ })).toHaveAttribute("aria-checked", "true");
  });

  it("allows the baseline decision even when no routing plan is currently active", () => {
    useTwinStore.setState({ liveSelectedId: "do_nothing" });
    render(<LiveResponsePanel />);
    expect(screen.getByRole("radio", { name: /Keep current routes/ })).toBeEnabled();
    const keep = screen.getByRole("button", { name: "Keep current routes" });
    expect(keep).toBeEnabled();
    fireEvent.click(keep);
    expect(approveLive).toHaveBeenCalledOnce();
  });

  it("keeps a valid displayed recommendation approvable during background evaluation", () => {
    useTwinStore.setState({ liveEvaluationStatus: "evaluating" });
    render(<LiveResponsePanel />);
    expect(screen.getByRole("status")).toHaveTextContent("Updating recommendations");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Use Gate D/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("radio", { name: /Use Gate D/ }));
    expect(screen.getByRole("status")).toHaveTextContent("Review pinned");
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("explains why approval is disabled when Python is disconnected", () => {
    useTwinStore.setState({ congestionConnection: "unavailable" });
    render(<LiveResponsePanel />);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription("Connect to Python to review and approve routes.");
    expect(screen.getByRole("radio", { name: /Use Gate C/ })).toBeDisabled();
    fireEvent.click(approve);
    expect(approveLive).not.toHaveBeenCalled();
    act(() => useTwinStore.setState({ congestionConnection: "connected" }));
    expect(approve).toBeEnabled();
  });

  it("lets an operator replace or stop an active plan instead of locking all decisions", () => {
    const plan: LivePlan = {
      runId: "test-run", interventionId: "old_route", name: "Earlier Gate A plan",
      approvedAtSeconds: 1200, actions: ["Previously route section 201 to Gate A."],
    };
    useTwinStore.setState({ livePlan: plan });
    render(<LiveResponsePanel />);
    expect(screen.getByText("Earlier Gate A plan")).toBeVisible();
    expect(screen.getByText("Proposed: Use Gate C")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(approveLive).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("radio", { name: /Keep current routes/ }));
    expect(screen.getByRole("button", { name: "Stop active plan" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop active plan" }));
    expect(approveLive).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate approval while the explicit request is pending", () => {
    useTwinStore.setState({ liveApprovalPending: true, liveSelectedId: "redirect_c" });
    render(<LiveResponsePanel />);
    expect(screen.getByRole("button", { name: "Approving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume recommendations" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Use Gate D/ })).toBeDisabled();
    expect(approveLive).not.toHaveBeenCalled();
  });

  it("explains a closure-suspended plan while keeping explicit replacement approval available", () => {
    useTwinStore.setState({
      livePlan: {
        runId: "test-run", interventionId: "earlier_plan", name: "Earlier Gate B route",
        approvedAtSeconds: 1200, actions: ["Previously redirect section 205 to Gate B."],
      },
      congestion: {
        runId: "test-run", sequence: 8, simulationTimeSeconds: 1440, gates: [],
        routing: {
          assignments: [], holds: [], gateWaitSeconds: {}, redirectedTotal: 120,
          activePlanId: "earlier_plan", redirectSuspended: true,
        },
      },
    });
    render(<LiveResponsePanel />);
    expect(screen.getByText(/reroute suspended after gate closure/)).toBeVisible();
    expect(screen.getByText("Closed-gate escape remains active. Approve a new plan to resume optional rerouting.")).toBeVisible();
    expect(screen.getByText("Proposed: Use Gate C")).toBeVisible();
    expect(screen.getByRole("radio", { name: /Use Gate D/ })).toBeEnabled();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    expect(approveLive).not.toHaveBeenCalled();
    fireEvent.click(approve);
    expect(approveLive).toHaveBeenCalledOnce();
  });
});
