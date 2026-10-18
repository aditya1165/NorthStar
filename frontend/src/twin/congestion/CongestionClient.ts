import { congestionWebSocketUrl } from "../../lib/endpoints";
import type { GateId, RiskLevel } from "../domain/types";
import type {
  CongestionConnectionStatus,
  CongestionSnapshot,
  CongestionTelemetryBatch,
  GateCongestionState,
  LiveZoneForecast,
  LiveZoneState,
  RouteReason,
  RoutingUpdate,
} from "./types";

export { apiBaseUrl } from "../../lib/endpoints";

interface CongestionClientHandlers {
  onConnection(status: CongestionConnectionStatus): void;
  onSnapshot(snapshot: CongestionSnapshot): void;
}

interface WireGateState {
  gate_id: GateId;
  label: string;
  level: RiskLevel;
  congested: boolean;
  people_count: number;
  density_per_m2: number;
  queue_length: number;
  mean_speed_mps: number;
  throughput_per_min: number;
  detected_at_seconds: number | null;
  reason: string;
}

interface WireRouting {
  assignments: {
    person_id: number;
    from_gate: GateId;
    to_gate: GateId;
    reason: RouteReason;
    estimated_benefit_seconds: number;
  }[];
  holds?: { section: number; until_seconds: number }[];
  gate_wait_seconds: Partial<Record<GateId, number | null>>;
  redirected_total: number;
  active_plan_id: string | null;
}

interface WireZone {
  zone_id: string;
  name: string;
  kind: string;
  gate_id: GateId | null;
  people_count: number;
  density_per_m2: number;
  inflow_per_min: number;
  outflow_per_min: number;
  mean_speed_mps: number;
  queue_length: number;
  level: RiskLevel;
  status: string;
}

interface WireForecast {
  zone_id: string;
  horizon_minutes: number;
  predicted_density: number;
  baseline_density: number;
  low: number;
  high: number;
  level: RiskLevel;
  risk_probability: number;
  time_to_congestion_minutes: number | null;
  method: "baseline" | "gbm";
  top_factors: string[];
}

interface WireCongestionSnapshot {
  message_type: "congestion";
  run_id: string;
  sequence: number;
  simulation_time_seconds: number;
  gates: WireGateState[];
  routing?: WireRouting | null;
  zones?: WireZone[] | null;
  forecasts?: WireForecast[] | null;
}

const RECONNECT_MS = 2_000;

function gateState(value: WireGateState): GateCongestionState {
  return {
    gateId: value.gate_id,
    label: value.label,
    level: value.level,
    congested: value.congested,
    peopleCount: value.people_count,
    densityPerM2: value.density_per_m2,
    queueLength: value.queue_length,
    meanSpeedMps: value.mean_speed_mps,
    throughputPerMin: value.throughput_per_min,
    detectedAtSeconds: value.detected_at_seconds,
    reason: value.reason,
  };
}

function routingUpdate(value: WireRouting): RoutingUpdate {
  return {
    assignments: value.assignments.map((a) => ({
      personId: a.person_id,
      fromGate: a.from_gate,
      toGate: a.to_gate,
      reason: a.reason,
      estimatedBenefitSeconds: a.estimated_benefit_seconds,
    })),
    holds: (value.holds ?? []).map((h) => ({ section: h.section, untilSeconds: h.until_seconds })),
    gateWaitSeconds: value.gate_wait_seconds,
    redirectedTotal: value.redirected_total,
    activePlanId: value.active_plan_id,
  };
}

function zoneState(value: WireZone): LiveZoneState {
  return {
    zoneId: value.zone_id,
    name: value.name,
    kind: value.kind,
    gateId: value.gate_id,
    peopleCount: value.people_count,
    densityPerM2: value.density_per_m2,
    inflowPerMin: value.inflow_per_min,
    outflowPerMin: value.outflow_per_min,
    meanSpeedMps: value.mean_speed_mps,
    queueLength: value.queue_length,
    level: value.level,
    status: value.status,
  };
}

function zoneForecast(value: WireForecast): LiveZoneForecast {
  return {
    zoneId: value.zone_id,
    horizonMinutes: value.horizon_minutes,
    predictedDensity: value.predicted_density,
    baselineDensity: value.baseline_density,
    low: value.low,
    high: value.high,
    level: value.level,
    riskProbability: value.risk_probability,
    timeToCongestionMinutes: value.time_to_congestion_minutes,
    method: value.method,
    topFactors: value.top_factors,
  };
}

export function parseSnapshot(value: unknown): CongestionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const wire = value as Partial<WireCongestionSnapshot>;
  if (
    wire.message_type !== "congestion" ||
    typeof wire.run_id !== "string" ||
    typeof wire.sequence !== "number" ||
    typeof wire.simulation_time_seconds !== "number" ||
    !Array.isArray(wire.gates)
  ) {
    return null;
  }
  return {
    runId: wire.run_id,
    sequence: wire.sequence,
    simulationTimeSeconds: wire.simulation_time_seconds,
    gates: wire.gates.map(gateState),
    ...(wire.routing ? { routing: routingUpdate(wire.routing) } : {}),
    ...(Array.isArray(wire.zones) ? { zones: wire.zones.map(zoneState) } : {}),
    ...(Array.isArray(wire.forecasts) ? { forecasts: wire.forecasts.map(zoneForecast) } : {}),
  };
}

function wireBatch(batch: CongestionTelemetryBatch) {
  return {
    message_type: "telemetry",
    run_id: batch.runId,
    sequence: batch.sequence,
    simulation_time_seconds: batch.simulationTimeSeconds,
    population: batch.population,
    agents: batch.agents.map((agent) => ({
      person_id: agent.personId,
      x: agent.x,
      z: agent.z,
      speed_mps: agent.speedMps,
      target_gate: agent.targetGate,
      movement_state: agent.movementState,
      ...(agent.phase ? { phase: agent.phase } : {}),
    })),
    exited_agents: batch.exitedAgents.map((agent) => ({
      person_id: agent.personId,
      target_gate: agent.targetGate,
      exited_at_seconds: agent.exitedAtSeconds,
    })),
    closed_gates: batch.closedGates ?? [],
  };
}

/** One reconnecting WebSocket dedicated to backend-owned congestion detection. */
export class CongestionClient {
  private socket: WebSocket | null = null;
  private handlers: CongestionClientHandlers | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private ready = false;
  private pending: CongestionTelemetryBatch | null = null;
  private latestPublished: { runId: string; sequence: number } | null = null;
  private latestResult = { runId: "", sequence: -1 };

  connect(handlers: CongestionClientHandlers): void {
    this.handlers = handlers;
    this.disposed = false;
    this.open();
  }

  publish(batch: CongestionTelemetryBatch): void {
    this.pending = batch;
    this.latestPublished = { runId: batch.runId, sequence: batch.sequence };
    if (
      !this.ready ||
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 1_000_000
    ) {
      return;
    }
    this.send(batch);
  }

  dispose(): void {
    this.disposed = true;
    this.ready = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.handlers = null;
  }

  private open(): void {
    if (this.disposed || !this.handlers) return;
    this.handlers.onConnection("connecting");
    const socket = new WebSocket(congestionWebSocketUrl());
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      let message: unknown;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message && typeof message === "object" && (message as { message_type?: string }).message_type === "ready") {
        this.ready = true;
        this.handlers?.onConnection("connected");
        if (this.pending) this.send(this.pending);
        return;
      }
      const snapshot = parseSnapshot(message);
      if (!snapshot || !this.latestPublished || snapshot.runId !== this.latestPublished.runId) return;
      if (
        snapshot.runId === this.latestResult.runId &&
        snapshot.sequence <= this.latestResult.sequence
      ) {
        return;
      }
      this.latestResult = { runId: snapshot.runId, sequence: snapshot.sequence };
      this.handlers?.onSnapshot(snapshot);
    });

    socket.addEventListener("close", () => {
      this.ready = false;
      this.socket = null;
      if (this.disposed) return;
      this.handlers?.onConnection("unavailable");
      this.reconnectTimer = setTimeout(() => this.open(), RECONNECT_MS);
    });

    socket.addEventListener("error", () => socket.close());
  }

  private send(batch: CongestionTelemetryBatch): void {
    this.socket?.send(JSON.stringify(wireBatch(batch)));
    if (this.pending?.runId === batch.runId && this.pending.sequence === batch.sequence) {
      this.pending = null;
    }
  }
}
