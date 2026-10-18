import type { CongestionSnapshot, PersonMovementState, PersonTelemetrySample } from "../congestion/types";
import { angleDelta, ringPoint } from "../domain/geometry";
import type { GateId, InterventionOption, TwinSnapshot, VenueLayout } from "../domain/types";

/**
 * Deterministic stadium egress model.
 *
 * Every person follows explicit waypoints: seat row -> section aisle -> lower
 * base path -> assigned gate corridor -> FIFO gate queue -> outside. The model
 * intentionally avoids collision physics; gate capacity and queue order are
 * deterministic and therefore straightforward to test.
 */

const Phase = {
  Waiting: 0,
  Row: 1,
  Aisle: 2,
  BaseRing: 3,
  GateCorridor: 4,
  Queue: 5,
  ReturnToBase: 6,
  Exit: 7,
  Exited: 8,
} as const;

export const AGENT_COLOR = { normal: 0, rerouted: 1, waiting: 2 } as const;

const GATE_IDS: GateId[] = [
  "gate_a",
  "gate_b",
  "gate_c",
  "gate_d",
  "gate_e",
  "gate_f",
  "gate_g",
  "gate_h",
];
const GATE_INDEX = Object.fromEntries(GATE_IDS.map((id, index) => [id, index])) as Record<GateId, number>;
const WALK_SPEED = 13;
const MAX_STEP = 0.04;
const METERS_PER_SCENE_UNIT = 6;
const QUEUE_INNER_SCALE = 1.07;
const QUEUE_OUTER_SCALE = 1.28;
const GATE_PORTAL_SCALE = 1.32;
const REROUTE_MARGIN_METERS = 12;
const REROUTE_COOLDOWN_MINUTES = 0.5;

interface Context {
  closedGates: Set<GateId>;
  signals: Map<GateId, CongestionSnapshot["gates"][number]>;
  plan: InterventionOption | null;
}

/** Seeded PRNG so agent layouts and movement are identical on every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class CrowdField {
  readonly count: number;
  /** x, y, z per agent. */
  readonly positions: Float32Array;
  readonly visible: Uint8Array;
  readonly colorClass: Uint8Array;

  private venue: VenueLayout;
  private rand: () => number;
  private section: Uint8Array;
  private seatAngle: Float32Array;
  private aisleAngle: Float32Array;
  private seatScale: Float32Array;
  private speed: Float32Array;
  private hashA: Float32Array;
  private hashB: Float32Array;
  private phase: Uint8Array;
  private angle: Float32Array;
  private scale: Float32Array;
  private timer: Float32Array;
  private target: Uint8Array;
  private ex: Float32Array;
  private ez: Float32Array;
  private dx: Float32Array;
  private dz: Float32Array;
  private progress: Float32Array;
  private exitLen: Float32Array;
  private currentSpeedMps: Float32Array;
  private exitedAtSeconds: Float32Array;
  private lastRerouteAt: Float32Array;
  private gateAngles: number[];
  private gateDest: [number, number][];
  private gateCapacity: number[];
  private gateCredit: Float32Array;
  private queues: number[][];
  private queueHead: Uint32Array;

  time = -3;

  constructor(venue: VenueLayout, count: number) {
    this.venue = venue;
    this.count = count;
    this.rand = rng(20260614);
    this.positions = new Float32Array(count * 3);
    this.visible = new Uint8Array(count);
    this.colorClass = new Uint8Array(count);
    this.section = new Uint8Array(count);
    this.seatAngle = new Float32Array(count);
    this.aisleAngle = new Float32Array(count);
    this.seatScale = new Float32Array(count);
    this.speed = new Float32Array(count);
    this.hashA = new Float32Array(count);
    this.hashB = new Float32Array(count);
    this.phase = new Uint8Array(count);
    this.angle = new Float32Array(count);
    this.scale = new Float32Array(count);
    this.timer = new Float32Array(count);
    this.target = new Uint8Array(count);
    this.ex = new Float32Array(count);
    this.ez = new Float32Array(count);
    this.dx = new Float32Array(count);
    this.dz = new Float32Array(count);
    this.progress = new Float32Array(count);
    this.exitLen = new Float32Array(count);
    this.currentSpeedMps = new Float32Array(count);
    this.exitedAtSeconds = new Float32Array(count).fill(-1);
    this.lastRerouteAt = new Float32Array(count).fill(-100);

    const byId = Object.fromEntries(venue.gates.map((gate) => [gate.id, gate]));
    this.gateAngles = GATE_IDS.map((id) => byId[id].angleDeg);
    this.gateDest = GATE_IDS.map((id) => [byId[id].destination[0], byId[id].destination[1]]);
    this.gateCapacity = GATE_IDS.map((id) => byId[id].capacityPerMinute);
    this.gateCredit = new Float32Array(GATE_IDS.length);
    this.queues = GATE_IDS.map(() => []);
    this.queueHead = new Uint32Array(GATE_IDS.length);
    this.reset(0);
  }

  reset(time: number) {
    this.rand = rng(20260614);
    this.gateCredit.fill(0);
    this.queueHead.fill(0);
    this.queues = GATE_IDS.map(() => []);
    const sections = this.venue.sections;
    for (let i = 0; i < this.count; i += 1) {
      const sectionIndex = i % sections.length;
      const section = sections[sectionIndex];
      this.section[i] = sectionIndex;
      this.seatAngle[i] = section.angleDeg + (this.rand() - 0.5) * 11;
      this.aisleAngle[i] = section.angleDeg;
      this.seatScale[i] =
        this.venue.ring.seatInner +
        0.05 +
        this.rand() * (this.venue.ring.seatOuter - this.venue.ring.seatInner - 0.08);
      this.speed[i] = 0.8 + this.rand() * 0.4;
      this.hashA[i] = this.rand();
      this.hashB[i] = this.rand();
      this.phase[i] = Phase.Waiting;
      this.timer[i] = (sectionIndex / sections.length) * 2 + this.hashA[i] * 2;
      this.visible[i] = 1;
      this.colorClass[i] = AGENT_COLOR.normal;
      this.angle[i] = this.seatAngle[i];
      this.scale[i] = this.seatScale[i];
      this.target[i] = this.nearestGate(this.seatAngle[i]);
      this.currentSpeedMps[i] = 0;
      this.exitedAtSeconds[i] = -1;
      this.lastRerouteAt[i] = -100;
      this.writePosition(i, this.seatingHeight(this.scale[i]));
    }
    this.time = time;
  }

  /** Advance from the current time to `until`, in bounded sub-steps. */
  advanceTo(until: number, snapshot: TwinSnapshot, congestion: CongestionSnapshot | null = null) {
    let guard = 0;
    while (this.time < until - 1e-6 && guard < 2000) {
      const dt = Math.min(MAX_STEP, until - this.time);
      this.time += dt;
      this.step(dt, this.context(snapshot, congestion));
      guard += 1;
    }
  }

  private context(snapshot: TwinSnapshot, congestion: CongestionSnapshot | null): Context {
    const plan =
      snapshot.activePlan && this.time >= snapshot.activePlan.approvedAt
        ? (snapshot.interventions.find((option) => option.id === snapshot.activePlan?.interventionId) ?? null)
        : null;
    return {
      closedGates: new Set(snapshot.gates.filter((gate) => gate.status === "closed").map((gate) => gate.id)),
      signals: new Map(congestion?.gates.map((gate) => [gate.gateId, gate]) ?? []),
      plan,
    };
  }

  private nearestGate(angle: number): number {
    let best = 0;
    let distance = Infinity;
    for (let gate = 0; gate < this.gateAngles.length; gate += 1) {
      const candidate = Math.abs(angleDelta(angle, this.gateAngles[gate]));
      if (candidate < distance) {
        distance = candidate;
        best = gate;
      }
    }
    return best;
  }

  private plannedGate(i: number, ctx: Context): number | null {
    const reroute = ctx.plan?.reroute;
    const sectionNumber = 201 + this.section[i];
    if (!reroute || !reroute.sections.includes(sectionNumber)) return null;
    const gate = GATE_INDEX[reroute.gate];
    return ctx.closedGates.has(reroute.gate) ? null : gate;
  }

  /** Load-aware routing driven by gate state and backend-confirmed congestion. */
  private selectGate(i: number, ctx: Context): number {
    const planned = this.plannedGate(i, ctx);
    if (planned !== null) return planned;

    const current = this.target[i];
    const currentId = GATE_IDS[current];
    const signal = ctx.signals.get(currentId);
    const closed = ctx.closedGates.has(currentId);
    if (!closed && !signal?.congested) return current;
    if (!closed && this.time - this.lastRerouteAt[i] < REROUTE_COOLDOWN_MINUTES) return current;

    const open = GATE_IDS.map((id, gate) => ({ id, gate })).filter(({ id }) => !ctx.closedGates.has(id));
    if (open.length === 0) return current;
    const currentCost = this.routeCost(i, current, ctx);
    const alternatives = open
      .filter(({ gate }) => gate !== current)
      .map(({ gate }) => ({ gate, cost: this.routeCost(i, gate, ctx) }))
      .sort((a, b) => a.cost - b.cost || a.gate - b.gate);
    const best = alternatives[0];
    if (!best || (!closed && best.cost + REROUTE_MARGIN_METERS >= currentCost)) return current;
    this.lastRerouteAt[i] = this.time;
    return best.gate;
  }

  private routeCost(i: number, gate: number, ctx: Context): number {
    const signal = ctx.signals.get(GATE_IDS[gate]);
    const angleDistance = Math.abs(angleDelta(this.angle[i], this.gateAngles[gate])) * (Math.PI / 180);
    const averageRadius = ((this.venue.bowl.rx + this.venue.bowl.rz) / 2) * this.venue.ring.basePath;
    const walkingMeters = angleDistance * averageRadius * METERS_PER_SCENE_UNIT;
    const queuePenalty = (signal?.queueLength ?? 0) * 0.12;
    const densityPenalty = (signal?.densityPerM2 ?? 0) * 4;
    const congestionPenalty = signal?.congested ? 20 : 0;
    const stableTieBreaker = ((i * 17 + gate * 31) % 19) * 0.03;
    return walkingMeters + queuePenalty + densityPenalty + congestionPenalty + stableTieBreaker;
  }

  private step(dt: number, ctx: Context) {
    const { rx, rz } = this.venue.bowl;
    const baseScale = this.venue.ring.basePath;

    for (let i = 0; i < this.count; i += 1) {
      const stepDistance = this.speed[i] * WALK_SPEED * dt;
      const baseSpeedMps = (this.speed[i] * WALK_SPEED * METERS_PER_SCENE_UNIT) / 60;
      const offset = i * 3;
      switch (this.phase[i]) {
        case Phase.Waiting:
          this.currentSpeedMps[i] = 0;
          this.timer[i] -= dt;
          if (this.timer[i] <= 0) this.phase[i] = Phase.Row;
          break;

        case Phase.Row:
          this.currentSpeedMps[i] = baseSpeedMps;
          if (this.moveAngle(i, this.aisleAngle[i], stepDistance, this.scale[i])) this.phase[i] = Phase.Aisle;
          this.writePosition(i, this.seatingHeight(this.scale[i]));
          break;

        case Phase.Aisle:
          this.currentSpeedMps[i] = baseSpeedMps;
          this.scale[i] = Math.max(baseScale, this.scale[i] - stepDistance / 10);
          if (this.scale[i] <= baseScale + 1e-4) {
            this.scale[i] = baseScale;
            this.phase[i] = Phase.BaseRing;
          }
          this.writePosition(i, this.seatingHeight(this.scale[i]));
          break;

        case Phase.BaseRing: {
          this.currentSpeedMps[i] = baseSpeedMps;
          const selected = this.selectGate(i, ctx);
          if (selected !== this.target[i]) {
            this.target[i] = selected;
            this.colorClass[i] = AGENT_COLOR.rerouted;
          }
          if (this.moveAngle(i, this.gateAngles[this.target[i]], stepDistance, baseScale)) {
            this.phase[i] = Phase.GateCorridor;
          }
          this.scale[i] = baseScale;
          this.writePosition(i, 0.02);
          break;
        }

        case Phase.GateCorridor: {
          this.currentSpeedMps[i] = baseSpeedMps;
          const selected = this.selectGate(i, ctx);
          if (selected !== this.target[i]) {
            this.target[i] = selected;
            this.colorClass[i] = AGENT_COLOR.rerouted;
            this.phase[i] = Phase.ReturnToBase;
            break;
          }
          this.angle[i] = this.gateAngles[this.target[i]];
          this.scale[i] = Math.min(QUEUE_INNER_SCALE, this.scale[i] + stepDistance / 10);
          this.writePosition(i, 0.02);
          if (this.scale[i] >= QUEUE_INNER_SCALE - 1e-4) this.enterQueue(i);
          break;
        }

        case Phase.Queue: {
          this.currentSpeedMps[i] = 0;
          const selected = this.selectGate(i, ctx);
          if (selected !== this.target[i]) {
            this.target[i] = selected;
            this.colorClass[i] = AGENT_COLOR.rerouted;
            this.phase[i] = Phase.ReturnToBase;
            break;
          }
          const gateAngle = this.gateAngles[this.target[i]] + (this.hashA[i] - 0.5) * 7;
          const queueScale = QUEUE_INNER_SCALE + this.hashB[i] * (QUEUE_OUTER_SCALE - QUEUE_INNER_SCALE);
          const [qx, qz] = ringPoint(rx, rz, gateAngle, queueScale);
          const k = Math.min(1, dt * 4);
          this.positions[offset] += (qx - this.positions[offset]) * k;
          this.positions[offset + 1] = 0.02;
          this.positions[offset + 2] += (qz - this.positions[offset + 2]) * k;
          this.colorClass[i] = AGENT_COLOR.waiting;
          break;
        }

        case Phase.ReturnToBase:
          this.currentSpeedMps[i] = baseSpeedMps;
          this.scale[i] = Math.max(baseScale, this.scale[i] - stepDistance / 10);
          this.writePosition(i, 0.02);
          if (this.scale[i] <= baseScale + 1e-4) this.phase[i] = Phase.BaseRing;
          break;

        case Phase.Exit: {
          this.currentSpeedMps[i] = baseSpeedMps;
          this.progress[i] += stepDistance;
          const progress = Math.min(1, this.progress[i] / this.exitLen[i]);
          this.positions[offset] = this.ex[i] + (this.dx[i] - this.ex[i]) * progress;
          this.positions[offset + 1] = 0.02;
          this.positions[offset + 2] = this.ez[i] + (this.dz[i] - this.ez[i]) * progress;
          if (progress >= 1) this.markExited(i);
          break;
        }

        case Phase.Exited:
          this.currentSpeedMps[i] = 0;
          break;
      }
    }
    this.serveQueues(dt, ctx);
  }

  private moveAngle(i: number, goal: number, distance: number, scale: number): boolean {
    const delta = angleDelta(this.angle[i], goal);
    const radius = Math.max(1, ((this.venue.bowl.rx + this.venue.bowl.rz) / 2) * scale);
    const stepDegrees = (distance / radius) * (180 / Math.PI);
    if (Math.abs(delta) <= stepDegrees + 0.1) {
      this.angle[i] = goal;
      return true;
    }
    this.angle[i] += Math.sign(delta) * stepDegrees;
    return false;
  }

  private enterQueue(i: number) {
    const gate = this.target[i];
    this.phase[i] = Phase.Queue;
    this.colorClass[i] = AGENT_COLOR.waiting;
    this.queues[gate].push(i);
  }

  private serveQueues(dt: number, ctx: Context) {
    for (let gate = 0; gate < GATE_IDS.length; gate += 1) {
      if (ctx.closedGates.has(GATE_IDS[gate])) {
        this.gateCredit[gate] = 0;
        continue;
      }
      this.gateCredit[gate] = Math.min(
        this.gateCapacity[gate],
        this.gateCredit[gate] + this.gateCapacity[gate] * dt,
      );
      const queue = this.queues[gate];
      while (this.gateCredit[gate] >= 1 && this.queueHead[gate] < queue.length) {
        const person = queue[this.queueHead[gate]];
        this.queueHead[gate] += 1;
        if (this.phase[person] !== Phase.Queue || this.target[person] !== gate) continue;
        this.beginExit(person);
        this.gateCredit[gate] -= 1;
      }
      if (this.queueHead[gate] > 512 && this.queueHead[gate] * 2 > queue.length) {
        this.queues[gate] = queue.slice(this.queueHead[gate]);
        this.queueHead[gate] = 0;
      }
    }
  }

  private beginExit(i: number) {
    const gate = this.target[i];
    const offset = i * 3;
    const [portalX, portalZ] = ringPoint(
      this.venue.bowl.rx,
      this.venue.bowl.rz,
      this.gateAngles[gate],
      GATE_PORTAL_SCALE,
    );
    const [destinationX, destinationZ] = this.gateDest[gate];
    this.ex[i] = this.positions[offset];
    this.ez[i] = this.positions[offset + 2];
    const angle = (this.gateAngles[gate] * Math.PI) / 180;
    const tangentX = -Math.sin(angle);
    const tangentZ = Math.cos(angle);
    const laneOffset = (this.hashA[i] - 0.5) * 1.1;
    this.dx[i] = destinationX + tangentX * laneOffset;
    this.dz[i] = destinationZ + tangentZ * laneOffset;
    this.exitLen[i] =
      Math.hypot(portalX - this.ex[i], portalZ - this.ez[i]) +
      Math.hypot(this.dx[i] - portalX, this.dz[i] - portalZ);
    this.exitLen[i] = Math.max(0.01, this.exitLen[i]);
    this.progress[i] = 0;
    this.phase[i] = Phase.Exit;
    this.colorClass[i] = AGENT_COLOR.normal;
  }

  private markExited(i: number) {
    this.phase[i] = Phase.Exited;
    this.visible[i] = 0;
    this.currentSpeedMps[i] = 0;
    this.exitedAtSeconds[i] = Math.max(0, this.time * 60);
  }

  /** Snapshot all 4,000 logical identities for the backend telemetry contract. */
  telemetry(): PersonTelemetrySample {
    const agents: PersonTelemetrySample["agents"] = [];
    const exitedAgents: PersonTelemetrySample["exitedAgents"] = [];
    const movementState: Record<number, PersonMovementState> = {
      [Phase.Waiting]: "waiting",
      [Phase.Row]: "moving",
      [Phase.Aisle]: "moving",
      [Phase.BaseRing]: "moving",
      [Phase.GateCorridor]: "moving",
      [Phase.Queue]: "queued",
      [Phase.ReturnToBase]: "moving",
      [Phase.Exit]: "exiting",
    };

    for (let i = 0; i < this.count; i += 1) {
      const targetGate = GATE_IDS[this.target[i]];
      if (this.phase[i] === Phase.Exited) {
        exitedAgents.push({ personId: i, targetGate, exitedAtSeconds: this.exitedAtSeconds[i] });
        continue;
      }
      const offset = i * 3;
      agents.push({
        personId: i,
        x: Math.round(this.positions[offset] * 1_000) / 1_000,
        z: Math.round(this.positions[offset + 2] * 1_000) / 1_000,
        speedMps: Math.round(this.currentSpeedMps[i] * 100) / 100,
        targetGate,
        movementState: movementState[this.phase[i]],
      });
    }
    return { agents, exitedAgents };
  }

  private writePosition(i: number, height: number) {
    const offset = i * 3;
    const [x, z] = ringPoint(this.venue.bowl.rx, this.venue.bowl.rz, this.angle[i], this.scale[i]);
    this.positions[offset] = x;
    this.positions[offset + 1] = height;
    this.positions[offset + 2] = z;
  }

  /** The seating tiers rise away from the pitch; the base path is at ground level. */
  private seatingHeight(scale: number) {
    const { seatInner, seatOuter } = this.venue.ring;
    if (scale <= seatInner) return 0.02;
    return 0.08 + ((Math.min(scale, seatOuter) - seatInner) / (seatOuter - seatInner)) * 1.37;
  }
}
