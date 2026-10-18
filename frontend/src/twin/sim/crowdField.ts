import type {
  CongestionSnapshot,
  PersonMovementState,
  PersonPhase,
  PersonTelemetrySample,
  RouteAssignment,
  SectionHold,
} from "../congestion/types";
import { angleDelta, ringCoords, ringPoint } from "../domain/geometry";
import type { GateId, TwinSnapshot, VenueLayout } from "../domain/types";
import { CONCOURSE_SCALE, GATE_PORTAL_SCALE, QUEUE_INNER_SCALE, QUEUE_OUTER_SCALE } from "./paths";

/**
 * Deterministic stadium egress model.
 *
 * Every person follows explicit waypoints: seat row -> section aisle -> lower
 * base path -> nearest access passage -> outer concourse -> boundary gate queue
 * -> doorway -> outside. The model
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
  ReturnToConcourse: 6,
  Concourse: 7,
  GateApproach: 8,
  Exit: 9,
  Exited: 10,
} as const;

export const AGENT_COLOR = { normal: 0, rerouted: 1, waiting: 2 } as const;

const PHASE_NAME: Record<number, PersonPhase> = {
  [Phase.Waiting]: "waiting",
  [Phase.Row]: "row",
  [Phase.Aisle]: "aisle",
  [Phase.BaseRing]: "base_ring",
  [Phase.GateCorridor]: "gate_corridor",
  [Phase.Queue]: "queue",
  [Phase.ReturnToConcourse]: "return_to_concourse",
  [Phase.Concourse]: "concourse",
  [Phase.GateApproach]: "gate_approach",
  [Phase.Exit]: "exit",
};
const FIRST_SECTION_NUMBER = 201;

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
const WALK_SPEED = 1.3;
const MAX_STEP = 0.04;
const METERS_PER_SCENE_UNIT = 6;

interface Context {
  closedGates: Set<GateId>;
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
  private accessGate: Uint8Array;
  private ex: Float32Array;
  private ez: Float32Array;
  private dx: Float32Array;
  private dz: Float32Array;
  private progress: Float32Array;
  private exitLen: Float32Array;
  private currentSpeedMps: Float32Array;
  private exitedAtSeconds: Float32Array;
  private gateAngles: number[];
  private gateDest: [number, number][];
  private gateCapacity: number[];
  private gateCredit: Float32Array;
  private queues: number[][];
  private queueHead: Uint32Array;
  private heldUntil: Float32Array;
  private closedGates = new Set<GateId>();

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
    this.accessGate = new Uint8Array(count);
    this.ex = new Float32Array(count);
    this.ez = new Float32Array(count);
    this.dx = new Float32Array(count);
    this.dz = new Float32Array(count);
    this.progress = new Float32Array(count);
    this.exitLen = new Float32Array(count);
    this.currentSpeedMps = new Float32Array(count);
    this.exitedAtSeconds = new Float32Array(count).fill(-1);

    const byId = Object.fromEntries(venue.gates.map((gate) => [gate.id, gate]));
    this.gateAngles = GATE_IDS.map((id) => byId[id].angleDeg);
    this.gateDest = GATE_IDS.map((id) => [byId[id].destination[0], byId[id].destination[1]]);
    this.gateCapacity = GATE_IDS.map((id) => byId[id].capacityPerMinute);
    this.gateCredit = new Float32Array(GATE_IDS.length);
    this.queues = GATE_IDS.map(() => []);
    this.queueHead = new Uint32Array(GATE_IDS.length);
    this.heldUntil = new Float32Array(venue.sections.length).fill(-Infinity);
    this.reset(0);
  }

  reset(time: number) {
    this.rand = rng(20260614);
    this.heldUntil.fill(-Infinity);
    this.gateCredit.fill(0);
    this.queueHead.fill(0);
    this.queues = GATE_IDS.map(() => []);
    this.closedGates.clear();
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
      this.timer[i] = (sectionIndex / sections.length) * 8 + this.hashA[i] * 8;
      this.visible[i] = 1;
      this.colorClass[i] = AGENT_COLOR.normal;
      this.angle[i] = this.seatAngle[i];
      this.scale[i] = this.seatScale[i];
      this.target[i] = this.nearestGate(this.seatAngle[i]);
      this.accessGate[i] = this.target[i];
      this.currentSpeedMps[i] = 0;
      this.exitedAtSeconds[i] = -1;
      this.writePosition(i, this.seatingHeight(this.scale[i]));
    }
    this.time = time;
  }

  /** Advance from the current time to `until`, in bounded sub-steps. */
  advanceTo(until: number, snapshot: TwinSnapshot, _congestion: CongestionSnapshot | null = null) {
    const context = this.context(snapshot);
    this.closedGates = context.closedGates;
    let guard = 0;
    while (this.time < until - 1e-6 && guard < 2000) {
      const dt = Math.min(MAX_STEP, until - this.time);
      this.time += dt;
      this.step(dt, context);
      guard += 1;
    }
  }

  private context(snapshot: TwinSnapshot): Context {
    return {
      closedGates: new Set(snapshot.gates.filter((gate) => gate.status === "closed").map((gate) => gate.id)),
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

  /**
   * Execute operator-approved Python routing deltas only to currently open gates.
   * Closure escape is a separate physical safety rule, not a plan approval.
   * Returns the number of people whose gate changed.
   */
  applyAssignments(assignments: readonly RouteAssignment[], closedGates: ReadonlySet<GateId> = this.closedGates): number {
    this.closedGates = new Set(closedGates);
    let applied = 0;
    for (const { personId, toGate, reason } of assignments) {
      if (reason !== "operator_plan" || !Number.isInteger(personId) || personId < 0 || personId >= this.count) continue;
      const phase = this.phase[personId];
      const gate = GATE_INDEX[toGate];
      if (gate === undefined || closedGates.has(toGate) || phase >= Phase.Exit || this.target[personId] === gate) continue;
      this.retarget(personId, gate);
      applied += 1;
    }
    return applied;
  }

  private retarget(personId: number, gate: number) {
    const phase = this.phase[personId];
    this.target[personId] = gate;
    this.colorClass[personId] = AGENT_COLOR.rerouted;
    if (phase === Phase.Queue || phase === Phase.GateApproach || (phase === Phase.Concourse && this.scale[personId] > CONCOURSE_SCALE + 1e-4)) {
      // Recover the actual rendered position before leaving a queue/doorway;
      // the safety detour must never jump sideways or go through the stands.
      const offset = personId * 3;
      const point = ringCoords(this.venue.bowl.rx, this.venue.bowl.rz, this.positions[offset], this.positions[offset + 2]);
      this.angle[personId] = point.angleDeg;
      this.scale[personId] = point.scale;
      this.phase[personId] = Phase.ReturnToConcourse;
    }
  }

  /** Nearest reachable boundary exit along the walkable circle, with stable ties. */
  private escapeClosedGate(personId: number, openGates: readonly number[]) {
    if (openGates.length === 0) return;
    const offset = personId * 3;
    const angle = this.phase[personId] <= Phase.GateCorridor
      ? this.gateAngles[this.accessGate[personId]]
      : ringCoords(this.venue.bowl.rx, this.venue.bowl.rz, this.positions[offset], this.positions[offset + 2]).angleDeg;
    const distances = openGates.map((gate) => Math.abs(angleDelta(angle, this.gateAngles[gate])));
    const nearest = Math.min(...distances);
    const tied = openGates.filter((_, index) => Math.abs(distances[index] - nearest) <= 1e-6);
    this.retarget(personId, tied[personId % tied.length]);
  }

  /** Keep seated people in the given sections from leaving until `untilSeconds` of simulation time. */
  setHolds(holds: readonly SectionHold[]) {
    this.heldUntil.fill(-Infinity);
    for (const { section, untilSeconds } of holds) {
      const index = section - FIRST_SECTION_NUMBER;
      if (index < 0 || index >= this.heldUntil.length) continue;
      this.heldUntil[index] = Math.max(this.heldUntil[index], untilSeconds / 60);
    }
  }

  private step(dt: number, ctx: Context) {
    const { rx, rz } = this.venue.bowl;
    const baseScale = this.venue.ring.basePath;
    const openGates = GATE_IDS.map((_, gate) => gate).filter((gate) => !ctx.closedGates.has(GATE_IDS[gate]));

    for (let i = 0; i < this.count; i += 1) {
      if (this.phase[i] < Phase.Exit && ctx.closedGates.has(GATE_IDS[this.target[i]])) {
        this.escapeClosedGate(i, openGates);
      }
      const stepDistance = this.speed[i] * WALK_SPEED * dt;
      const baseSpeedMps = (this.speed[i] * WALK_SPEED * METERS_PER_SCENE_UNIT) / 60;
      const offset = i * 3;
      switch (this.phase[i]) {
        case Phase.Waiting:
          this.currentSpeedMps[i] = 0;
          if (this.time >= this.heldUntil[this.section[i]]) this.timer[i] -= dt;
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
          if (this.moveAngle(i, this.gateAngles[this.accessGate[i]], stepDistance, baseScale)) {
            this.phase[i] = Phase.GateCorridor;
          }
          this.scale[i] = baseScale;
          this.writePosition(i, 0.02);
          break;
        }

        case Phase.GateCorridor: {
          this.currentSpeedMps[i] = baseSpeedMps;
          this.angle[i] = this.gateAngles[this.accessGate[i]];
          this.scale[i] = Math.min(CONCOURSE_SCALE, this.scale[i] + stepDistance / 10);
          if (this.scale[i] >= CONCOURSE_SCALE - 1e-4) {
            this.scale[i] = CONCOURSE_SCALE;
            this.phase[i] = Phase.Concourse;
          }
          this.writePosition(i, 0.02);
          break;
        }

        case Phase.Concourse: {
          this.currentSpeedMps[i] = baseSpeedMps;
          if (Math.abs(angleDelta(this.angle[i], this.gateAngles[this.target[i]])) > 1e-4) {
            this.moveAngle(i, this.gateAngles[this.target[i]], stepDistance, CONCOURSE_SCALE);
          } else {
            this.scale[i] = Math.min(QUEUE_INNER_SCALE, this.scale[i] + stepDistance / 10);
            if (this.scale[i] >= QUEUE_INNER_SCALE - 1e-4) this.enterQueue(i);
          }
          this.writePosition(i, 0.02);
          break;
        }

        case Phase.Queue: {
          this.currentSpeedMps[i] = 0;
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

        case Phase.ReturnToConcourse:
          this.currentSpeedMps[i] = baseSpeedMps;
          this.scale[i] = Math.max(CONCOURSE_SCALE, this.scale[i] - stepDistance / 10);
          if (this.scale[i] <= CONCOURSE_SCALE + 1e-4) {
            this.scale[i] = CONCOURSE_SCALE;
            this.phase[i] = Phase.Concourse;
          }
          this.writePosition(i, 0.02);
          break;

        case Phase.GateApproach:
        case Phase.Exit: {
          const approaching = this.phase[i] === Phase.GateApproach;
          if (approaching && ctx.closedGates.has(GATE_IDS[this.target[i]])) {
            this.currentSpeedMps[i] = 0;
            this.colorClass[i] = AGENT_COLOR.waiting;
            break;
          }
          this.currentSpeedMps[i] = baseSpeedMps;
          this.progress[i] += stepDistance;
          const progress = Math.min(1, this.progress[i] / this.exitLen[i]);
          this.positions[offset] = this.ex[i] + (this.dx[i] - this.ex[i]) * progress;
          this.positions[offset + 1] = 0.02;
          this.positions[offset + 2] = this.ez[i] + (this.dz[i] - this.ez[i]) * progress;
          if (progress >= 1) {
            if (approaching) this.beginOutsideWalk(i);
            else this.markExited(i);
          }
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
        this.beginGateApproach(person);
        this.gateCredit[gate] -= 1;
      }
      if (this.queueHead[gate] > 512 && this.queueHead[gate] * 2 > queue.length) {
        this.queues[gate] = queue.slice(this.queueHead[gate]);
        this.queueHead[gate] = 0;
      }
    }
  }

  private beginGateApproach(i: number) {
    const gate = this.target[i];
    const offset = i * 3;
    const [portalX, portalZ] = ringPoint(
      this.venue.bowl.rx,
      this.venue.bowl.rz,
      this.gateAngles[gate],
      GATE_PORTAL_SCALE,
    );
    this.ex[i] = this.positions[offset];
    this.ez[i] = this.positions[offset + 2];
    this.dx[i] = portalX;
    this.dz[i] = portalZ;
    this.exitLen[i] = Math.max(0.01, Math.hypot(portalX - this.ex[i], portalZ - this.ez[i]));
    this.progress[i] = 0;
    this.phase[i] = Phase.GateApproach;
    this.colorClass[i] = AGENT_COLOR.normal;
  }

  /** Only a completed, open doorway crossing starts the outside walk. */
  private beginOutsideWalk(i: number) {
    const gate = this.target[i];
    const offset = i * 3;
    const [destinationX, destinationZ] = this.gateDest[gate];
    this.ex[i] = this.positions[offset];
    this.ez[i] = this.positions[offset + 2];
    const angle = (this.gateAngles[gate] * Math.PI) / 180;
    const tangentX = -Math.sin(angle);
    const tangentZ = Math.cos(angle);
    const laneOffset = (this.hashA[i] - 0.5) * 1.1;
    this.dx[i] = destinationX + tangentX * laneOffset;
    this.dz[i] = destinationZ + tangentZ * laneOffset;
    this.exitLen[i] = Math.max(0.01, Math.hypot(this.dx[i] - this.ex[i], this.dz[i] - this.ez[i]));
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
      [Phase.ReturnToConcourse]: "moving",
      [Phase.Concourse]: "moving",
      [Phase.GateApproach]: "moving",
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
        movementState: this.phase[i] === Phase.GateApproach && this.currentSpeedMps[i] === 0 ? "queued" : movementState[this.phase[i]],
        phase: PHASE_NAME[this.phase[i]],
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
