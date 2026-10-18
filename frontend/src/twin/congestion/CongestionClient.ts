import type { GateId, RiskLevel } from "../domain/types";
import type {
  CongestionConnectionStatus,
  CongestionSnapshot,
  CongestionTelemetryBatch,
  GateCongestionState,
} from "./types";

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

interface WireCongestionSnapshot {
  message_type: "congestion";
  run_id: string;
  sequence: number;
  simulation_time_seconds: number;
  gates: WireGateState[];
}

const RECONNECT_MS = 2_000;

function websocketUrl(): string {
  const configured = import.meta.env.VITE_CONGESTION_WS_URL as string | undefined;
  if (configured) return configured;
  const apiUrl = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8000";
  return `${apiUrl.replace(/^http/, "ws")}/ws/congestion`;
}

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

function parseSnapshot(value: unknown): CongestionSnapshot | null {
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
    })),
    exited_agents: batch.exitedAgents.map((agent) => ({
      person_id: agent.personId,
      target_gate: agent.targetGate,
      exited_at_seconds: agent.exitedAtSeconds,
    })),
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
    const socket = new WebSocket(websocketUrl());
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
