import type { GateId, RiskLevel } from "../domain/types";

export const TOTAL_POPULATION = 4_000;

export type PersonMovementState = "waiting" | "moving" | "queued" | "exiting" | "transit_wait";

export type PersonPhase =
  | "waiting"
  | "row"
  | "aisle"
  | "base_ring"
  | "gate_corridor"
  | "queue"
  | "return_to_base"
  | "exit";

export interface PersonTelemetry {
  personId: number;
  x: number;
  z: number;
  speedMps: number;
  targetGate: GateId;
  movementState: PersonMovementState;
  phase?: PersonPhase;
}

export interface ExitedPersonTelemetry {
  personId: number;
  targetGate: GateId;
  exitedAtSeconds: number;
}

export interface PersonTelemetrySample {
  agents: PersonTelemetry[];
  exitedAgents: ExitedPersonTelemetry[];
}

export interface CongestionTelemetryBatch extends PersonTelemetrySample {
  runId: string;
  sequence: number;
  simulationTimeSeconds: number;
  population: number;
  closedGates?: GateId[];
}

export interface GateCongestionState {
  gateId: GateId;
  label: string;
  level: RiskLevel;
  congested: boolean;
  peopleCount: number;
  densityPerM2: number;
  queueLength: number;
  meanSpeedMps: number;
  throughputPerMin: number;
  detectedAtSeconds: number | null;
  reason: string;
}

export type RouteReason = "gate_closed" | "congestion" | "load_balance" | "operator_plan";

export interface RouteAssignment {
  personId: number;
  fromGate: GateId;
  toGate: GateId;
  reason: RouteReason;
  estimatedBenefitSeconds: number;
}

export interface SectionHold {
  /** Seating section number, e.g. 205. */
  section: number;
  untilSeconds: number;
}

export interface RoutingUpdate {
  assignments: RouteAssignment[];
  holds: SectionHold[];
  gateWaitSeconds: Partial<Record<GateId, number | null>>;
  redirectedTotal: number;
  activePlanId: string | null;
}

export interface LiveZoneState {
  zoneId: string;
  name: string;
  kind: string;
  gateId: GateId | null;
  peopleCount: number;
  densityPerM2: number;
  inflowPerMin: number;
  outflowPerMin: number;
  meanSpeedMps: number;
  queueLength: number;
  level: RiskLevel;
  status: string;
}

export interface LiveZoneForecast {
  zoneId: string;
  horizonMinutes: number;
  predictedDensity: number;
  baselineDensity: number;
  low: number;
  high: number;
  level: RiskLevel;
  riskProbability: number;
  timeToCongestionMinutes: number | null;
  method: "baseline" | "gbm";
  topFactors: string[];
}

export interface CongestionSnapshot {
  runId: string;
  sequence: number;
  simulationTimeSeconds: number;
  gates: GateCongestionState[];
  /** Present when the Python routing engine is active. */
  routing?: RoutingUpdate;
  zones?: LiveZoneState[];
  forecasts?: LiveZoneForecast[];
}

export type CongestionConnectionStatus = "connecting" | "connected" | "unavailable";

export function mostSevereCongestion(snapshot: CongestionSnapshot | null): GateCongestionState | null {
  if (!snapshot) return null;
  const rank: Record<RiskLevel, number> = { normal: 0, elevated: 1, high: 2, critical: 3 };
  return (
    snapshot.gates
      .filter((gate) => gate.congested)
      .sort((a, b) => rank[b.level] - rank[a.level] || b.queueLength - a.queueLength)[0] ?? null
  );
}
