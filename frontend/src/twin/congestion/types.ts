import type { GateId, RiskLevel } from "../domain/types";

export const TOTAL_POPULATION = 4_000;

export type PersonMovementState = "waiting" | "moving" | "queued" | "exiting" | "transit_wait";

export interface PersonTelemetry {
  personId: number;
  x: number;
  z: number;
  speedMps: number;
  targetGate: GateId;
  movementState: PersonMovementState;
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

export interface CongestionSnapshot {
  runId: string;
  sequence: number;
  simulationTimeSeconds: number;
  gates: GateCongestionState[];
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
