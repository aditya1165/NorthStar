import { apiBaseUrl } from "../congestion/CongestionClient";
import type { GateId } from "../domain/types";

/** Counterfactual rollout result for one candidate response (backend `CandidateResult`). */
export interface LiveCandidate {
  interventionId: string;
  name: string;
  summary: string;
  actions: string[];
  feasible: boolean;
  rejectionReason: string | null;
  recommended: boolean;
  rollouts: number;
  peakDensity: number;
  peakDensityRange: [number, number];
  secondsAboveHigh: number;
  maxQueue: number;
  maxQueueGate: GateId;
  clearanceMinutes: number;
  clearanceRange: [number, number];
  peopleRedirected: number;
  extraWalkMeters: number;
  riskReductionPercent: number;
  secondaryBottleneck: GateId | null;
  operationalComplexity: number;
  redirectGate: GateId | null;
}

export interface LiveEvaluation {
  evaluationId: string;
  runId: string;
  evaluatedAtSeconds: number;
  hotspotGate: GateId;
  closedGates: GateId[];
  horizonMinutes: number;
  seeds: number[];
  complianceLevels: number[];
  candidates: LiveCandidate[];
  recommendedId: string;
  rationale: string;
}

export interface LivePlan {
  runId: string;
  interventionId: string;
  name: string;
  approvedAtSeconds: number;
  actions: string[];
}

interface WireCandidate {
  intervention_id: string;
  name: string;
  summary: string;
  actions: string[];
  feasible: boolean;
  rejection_reason: string | null;
  recommended: boolean;
  rollouts: number;
  peak_density: number;
  peak_density_range: [number, number];
  seconds_above_high: number;
  max_queue: number;
  max_queue_gate: GateId;
  clearance_minutes: number;
  clearance_range: [number, number];
  people_redirected: number;
  extra_walk_m_mean: number;
  risk_reduction_percent: number;
  secondary_bottleneck: GateId | null;
  operational_complexity: number;
  plan: { redirect_gate: GateId | null };
}

interface WireEvaluation {
  evaluation_id: string;
  run_id: string;
  evaluated_at_seconds: number;
  hotspot_gate: GateId;
  closed_gates: GateId[];
  horizon_minutes: number;
  seeds: number[];
  compliance_levels: number[];
  candidates: WireCandidate[];
  recommended_id: string;
  rationale: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(body?.detail ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function parseEvaluation(wire: WireEvaluation): LiveEvaluation {
  return {
    evaluationId: wire.evaluation_id,
    runId: wire.run_id,
    evaluatedAtSeconds: wire.evaluated_at_seconds,
    hotspotGate: wire.hotspot_gate,
    closedGates: wire.closed_gates,
    horizonMinutes: wire.horizon_minutes,
    seeds: wire.seeds,
    complianceLevels: wire.compliance_levels,
    recommendedId: wire.recommended_id,
    rationale: wire.rationale,
    candidates: wire.candidates.map((c) => ({
      interventionId: c.intervention_id,
      name: c.name,
      summary: c.summary,
      actions: c.actions,
      feasible: c.feasible,
      rejectionReason: c.rejection_reason,
      recommended: c.recommended,
      rollouts: c.rollouts,
      peakDensity: c.peak_density,
      peakDensityRange: c.peak_density_range,
      secondsAboveHigh: c.seconds_above_high,
      maxQueue: c.max_queue,
      maxQueueGate: c.max_queue_gate,
      clearanceMinutes: c.clearance_minutes,
      clearanceRange: c.clearance_range,
      peopleRedirected: c.people_redirected,
      extraWalkMeters: c.extra_walk_m_mean,
      riskReductionPercent: c.risk_reduction_percent,
      secondaryBottleneck: c.secondary_bottleneck,
      operationalComplexity: c.operational_complexity,
      redirectGate: c.plan.redirect_gate,
    })),
  };
}

export async function evaluateInterventions(runId: string): Promise<LiveEvaluation> {
  const wire = await request<WireEvaluation>(`/api/runs/${encodeURIComponent(runId)}/interventions/evaluate`, {
    method: "POST",
  });
  return parseEvaluation(wire);
}

export async function approveIntervention(runId: string, interventionId: string, evaluationId: string): Promise<LivePlan> {
  const wire = await request<{
    run_id: string;
    intervention_id: string;
    name: string;
    approved_at_seconds: number;
    actions: string[];
  }>(`/api/runs/${encodeURIComponent(runId)}/interventions/${encodeURIComponent(interventionId)}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evaluation_id: evaluationId }),
  });
  return {
    runId: wire.run_id,
    interventionId: wire.intervention_id,
    name: wire.name,
    approvedAtSeconds: wire.approved_at_seconds,
    actions: wire.actions,
  };
}

export function exportRunUrl(runId: string): string {
  return `${apiBaseUrl()}/api/runs/${encodeURIComponent(runId)}/export`;
}
