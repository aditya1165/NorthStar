import { RISK_ORDER, type RiskLevel, type ScenarioStage } from "./types";

/** Density thresholds in people per m² (lower bound of each level). */
export const DENSITY_THRESHOLDS: Record<Exclude<RiskLevel, "normal">, number> = {
  elevated: 2.5,
  high: 3.5,
  critical: 4.5,
};

/** Density at which congestion is treated as unsafe. */
export const UNSAFE_DENSITY = DENSITY_THRESHOLDS.critical;

export function levelForDensity(density: number): RiskLevel {
  if (density >= DENSITY_THRESHOLDS.critical) return "critical";
  if (density >= DENSITY_THRESHOLDS.high) return "high";
  if (density >= DENSITY_THRESHOLDS.elevated) return "elevated";
  return "normal";
}

export function riskRank(level: RiskLevel): number {
  return RISK_ORDER.indexOf(level);
}

export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

export const RISK_LABEL: Record<RiskLevel, string> = {
  normal: "Normal",
  elevated: "Elevated",
  high: "High",
  critical: "Critical",
};

export const STAGE_ORDER: readonly ScenarioStage[] = [
  "normal",
  "gate_closure",
  "metro_delay",
  "elevated_risk",
  "critical_forecast",
  "recommendation_available",
  "intervention_approved",
  "stabilized",
];

export const STAGE_LABEL: Record<ScenarioStage, string> = {
  normal: "Normal egress",
  gate_closure: "Gate B closed",
  metro_delay: "Metro delay",
  elevated_risk: "Elevated risk",
  critical_forecast: "Critical forecast",
  recommendation_available: "Recommendation ready",
  intervention_approved: "Intervention active",
  stabilized: "Stabilized",
};

export function formatClock(minute: number): string {
  const total = Math.max(0, Math.round(minute * 60));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
