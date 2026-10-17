import { angleDelta, ringCoords, ringPoint } from "../domain/geometry";
import type { GateId, InterventionOption, TwinSnapshot, VenueLayout } from "../domain/types";

/**
 * Lightweight pedestrian motion for the 3D view.
 *
 * This is a visual stand-in for streamed agent positions (e.g. from JuPedSim).
 * It is driven only by snapshot events and venue geometry, writes into typed
 * arrays, and allocates nothing per frame so thousands of agents stay cheap.
 */

const Phase = {
  Hidden: 0,
  Descend: 1,
  Ring: 2,
  Queue: 3,
  Exit: 4,
  TransitWait: 5,
} as const;

export const AGENT_COLOR = { normal: 0, rerouted: 1, waiting: 2 } as const;

interface Context {
  gateBClosed: boolean;
  gateCOpen: boolean;
  metroDelayed: boolean;
  plan: InterventionOption | null;
}

const GATE_INDEX: Record<GateId, number> = { gate_a: 0, gate_b: 1, gate_c: 2 };
const WALK_SPEED = 13; // scene units per scenario minute
const LANE = 1.2;
const INNER_LANE = 1.1;
const GATE_SCALE = 1.32;
const MAX_STEP = 0.04;

/** Seeded PRNG (mulberry32) so agent layouts are identical on every run. */
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

/** Share of fans still leaving their seats; egress tails off late in the scenario. */
function egressFraction(minute: number) {
  if (minute <= 15) return 1;
  return Math.max(0.25, 1 - (minute - 15) / 12);
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
  private seatScale: Float32Array;
  private lane: Float32Array;
  private speed: Float32Array;
  private hashA: Float32Array;
  private hashB: Float32Array;
  private phase: Uint8Array;
  private angle: Float32Array;
  private scale: Float32Array;
  private timer: Float32Array;
  private target: Uint8Array;
  private innerLane: Uint8Array;
  private ex: Float32Array;
  private ez: Float32Array;
  private dx: Float32Array;
  private dz: Float32Array;
  private progress: Float32Array;
  private exitLen: Float32Array;
  private gateAngles: number[];
  private gateDest: [number, number][];
  private transit: [number, number];
  private queueCount = 0;

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
    this.seatScale = new Float32Array(count);
    this.lane = new Float32Array(count);
    this.speed = new Float32Array(count);
    this.hashA = new Float32Array(count);
    this.hashB = new Float32Array(count);
    this.phase = new Uint8Array(count);
    this.angle = new Float32Array(count);
    this.scale = new Float32Array(count);
    this.timer = new Float32Array(count);
    this.target = new Uint8Array(count);
    this.innerLane = new Uint8Array(count);
    this.ex = new Float32Array(count);
    this.ez = new Float32Array(count);
    this.dx = new Float32Array(count);
    this.dz = new Float32Array(count);
    this.progress = new Float32Array(count);
    this.exitLen = new Float32Array(count);
    const byId = Object.fromEntries(venue.gates.map((g) => [g.id, g]));
    this.gateAngles = (["gate_a", "gate_b", "gate_c"] as GateId[]).map((id) => byId[id].angleDeg);
    this.gateDest = (["gate_a", "gate_b", "gate_c"] as GateId[]).map((id) => [byId[id].destination[0], byId[id].destination[1]]);
    this.transit = [venue.transit.position[0], venue.transit.position[1]];
    this.reset(-3);
  }

  reset(time: number) {
    this.rand = rng(20260614);
    const sections = this.venue.sections;
    for (let i = 0; i < this.count; i += 1) {
      const s = i % sections.length;
      this.section[i] = s;
      this.seatAngle[i] = sections[s].angleDeg + (this.rand() - 0.5) * 12;
      this.seatScale[i] = this.venue.ring.seatInner + 0.05 + this.rand() * (this.venue.ring.seatOuter - this.venue.ring.seatInner - 0.08);
      this.lane[i] = LANE + (this.rand() - 0.5) * 0.16;
      this.speed[i] = 0.8 + this.rand() * 0.4;
      this.hashA[i] = this.rand();
      this.hashB[i] = this.rand();
      this.phase[i] = Phase.Hidden;
      this.timer[i] = this.rand() * 3;
      this.visible[i] = 0;
      this.colorClass[i] = AGENT_COLOR.normal;
    }
    this.time = time;
  }

  /** Advance from the current time to `until`, in bounded sub-steps. */
  advanceTo(until: number, snapshot: TwinSnapshot) {
    let guard = 0;
    while (this.time < until - 1e-6 && guard < 2000) {
      const dt = Math.min(MAX_STEP, until - this.time);
      this.time += dt;
      this.step(dt, this.context(this.time, snapshot));
      guard += 1;
    }
  }

  private context(t: number, snapshot: TwinSnapshot): Context {
    const { events, activePlan, interventions } = snapshot;
    const plan =
      activePlan && t >= activePlan.approvedAt ? (interventions.find((o) => o.id === activePlan.interventionId) ?? null) : null;
    return {
      gateBClosed: events.gateBClosedAt !== null && t >= events.gateBClosedAt,
      metroDelayed: events.metroDelayedAt !== null && t >= events.metroDelayedAt,
      gateCOpen: plan?.opensGateC ?? false,
      plan,
    };
  }

  /** Habitual gate (ignoring closure) and plan overrides. */
  private chooseGate(i: number, ctx: Context): { gate: number; rerouted: boolean; inner: boolean } {
    const sectionNumber = 201 + this.section[i];
    const a = this.seatAngle[i];
    const da = Math.abs(angleDelta(a, this.gateAngles[0]));
    const db = Math.abs(angleDelta(a, this.gateAngles[1]));
    let habitual = da < db ? 0 : 1;
    if (ctx.gateCOpen && Math.abs(angleDelta(a, this.gateAngles[2])) < Math.min(da, db)) habitual = 2;
    const reroute = ctx.plan?.reroute;
    if (reroute && reroute.sections.includes(sectionNumber)) {
      const gate = GATE_INDEX[reroute.gate];
      const inner = reroute.gate === "gate_c" && sectionNumber >= 205;
      return { gate, rerouted: gate !== 1 || habitual !== 1, inner };
    }
    if (habitual === 1 && ctx.gateBClosed && ctx.plan) {
      // Once a response is active, stewards divert remaining Gate B traffic to the nearest open gate.
      const dc = Math.abs(angleDelta(a, this.gateAngles[2]));
      return { gate: ctx.gateCOpen && dc < da ? 2 : 0, rerouted: true, inner: false };
    }
    return { gate: habitual, rerouted: ctx.plan !== null && habitual === 2, inner: false };
  }

  private gateOpen(gate: number, ctx: Context) {
    if (gate === 1) return !ctx.gateBClosed;
    if (gate === 2) return ctx.gateCOpen;
    return true;
  }

  private step(dt: number, ctx: Context) {
    const { rx, rz } = this.venue.bowl;
    const fraction = egressFraction(this.time);
    let queued = 0;
    const queueSpread = Math.min(46, 14 + this.queueCount * 0.05);

    for (let i = 0; i < this.count; i += 1) {
      const sp = this.speed[i] * WALK_SPEED * dt;
      const o = i * 3;
      switch (this.phase[i]) {
        case Phase.Hidden: {
          this.timer[i] -= dt;
          if (this.timer[i] <= 0) {
            if (this.hashB[i] > fraction) {
              this.timer[i] = 1 + this.hashA[i] * 2;
              break;
            }
            this.phase[i] = Phase.Descend;
            this.angle[i] = this.seatAngle[i];
            this.scale[i] = this.seatScale[i];
            const choice = this.chooseGate(i, ctx);
            this.target[i] = choice.gate;
            this.innerLane[i] = choice.inner ? 1 : 0;
            this.colorClass[i] = choice.rerouted ? AGENT_COLOR.rerouted : AGENT_COLOR.normal;
            this.visible[i] = 1;
          }
          break;
        }
        case Phase.Descend: {
          const lane = this.innerLane[i] ? INNER_LANE : this.lane[i];
          this.scale[i] = Math.min(lane, this.scale[i] + (sp / 10) * 0.9);
          if (this.scale[i] >= lane - 1e-4) this.phase[i] = Phase.Ring;
          this.writeRing(i, rx, rz);
          break;
        }
        case Phase.Ring: {
          const choice = this.chooseGate(i, ctx);
          if (choice.gate !== this.target[i]) {
            this.target[i] = choice.gate;
            this.innerLane[i] = choice.inner ? 1 : 0;
          }
          this.colorClass[i] = choice.rerouted ? AGENT_COLOR.rerouted : AGENT_COLOR.normal;
          const goal = this.gateAngles[this.target[i]];
          const delta = angleDelta(this.angle[i], goal);
          let slow = 1;
          if (ctx.gateBClosed && this.target[i] === 1 && Math.abs(delta) < 30) slow = 0.45;
          const lane = this.innerLane[i] ? INNER_LANE : this.lane[i];
          this.scale[i] += (lane - this.scale[i]) * Math.min(1, dt * 4);
          const stepDeg = ((sp * slow) / (10.5 * this.scale[i])) * 57.2958;
          if (Math.abs(delta) <= stepDeg + 0.4) {
            this.angle[i] = goal;
            if (this.gateOpen(this.target[i], ctx)) this.beginExit(i, rx, rz);
            else this.phase[i] = Phase.Queue;
          } else {
            this.angle[i] += Math.sign(delta) * stepDeg;
          }
          this.writeRing(i, rx, rz);
          break;
        }
        case Phase.Queue: {
          queued += 1;
          const choice = this.chooseGate(i, ctx);
          if (choice.gate !== 1 || !ctx.gateBClosed) {
            const c = ringCoords(rx, rz, this.positions[o], this.positions[o + 2]);
            this.angle[i] = c.angleDeg;
            this.scale[i] = c.scale;
            this.target[i] = choice.gate;
            this.innerLane[i] = choice.inner ? 1 : 0;
            this.colorClass[i] = choice.rerouted ? AGENT_COLOR.rerouted : AGENT_COLOR.normal;
            this.phase[i] = Phase.Ring;
            break;
          }
          const oneWay = ctx.plan?.oneWay ?? false;
          const slotAngle = oneWay
            ? this.gateAngles[1] + this.hashA[i] * queueSpread * 1.7
            : this.gateAngles[1] + (this.hashA[i] - 0.5) * queueSpread;
          const slotScale = 1.07 + this.hashB[i] * 0.23;
          const [sx, sz] = ringPoint(rx, rz, slotAngle, slotScale);
          const k = Math.min(1, dt * 3);
          this.positions[o] += (sx - this.positions[o]) * k;
          this.positions[o + 2] += (sz - this.positions[o + 2]) * k;
          this.positions[o + 1] = 0.02;
          this.colorClass[i] = AGENT_COLOR.waiting;
          break;
        }
        case Phase.Exit: {
          this.progress[i] += sp * (ctx.metroDelayed && this.target[i] === 1 ? 0.6 : 1);
          const u = Math.min(1, this.progress[i] / this.exitLen[i]);
          this.positions[o] = this.ex[i] + (this.dx[i] - this.ex[i]) * u;
          this.positions[o + 2] = this.ez[i] + (this.dz[i] - this.ez[i]) * u;
          this.positions[o + 1] = 0.02;
          if (u >= 1) {
            if (this.target[i] === 1 && ctx.metroDelayed) {
              this.phase[i] = Phase.TransitWait;
              this.timer[i] = 1.2 + this.hashA[i] * 1.6;
            } else this.hide(i);
          }
          break;
        }
        case Phase.TransitWait: {
          this.timer[i] -= dt;
          const ang = this.hashA[i] * Math.PI * 2;
          const r = 0.5 + this.hashB[i] * 1.6;
          const tx = this.transit[0] - 1.2 + Math.cos(ang) * r;
          const tz = this.transit[1] - 1.0 + Math.sin(ang) * r * 0.7;
          const k = Math.min(1, dt * 3);
          this.positions[o] += (tx - this.positions[o]) * k;
          this.positions[o + 2] += (tz - this.positions[o + 2]) * k;
          this.colorClass[i] = AGENT_COLOR.waiting;
          if (this.timer[i] <= 0) this.hide(i);
          break;
        }
      }
    }
    this.queueCount = queued;
  }

  private beginExit(i: number, rx: number, rz: number) {
    const gate = this.target[i];
    const [gx, gz] = ringPoint(rx, rz, this.gateAngles[gate] + (this.hashA[i] - 0.5) * 3, GATE_SCALE);
    const [destX, destZ] = this.gateDest[gate];
    this.ex[i] = gx;
    this.ez[i] = gz;
    this.dx[i] = destX + (this.hashA[i] - 0.5) * 2.4;
    this.dz[i] = destZ + (this.hashB[i] - 0.5) * 2.4;
    this.exitLen[i] = Math.hypot(this.dx[i] - gx, this.dz[i] - gz);
    this.progress[i] = 0;
    this.phase[i] = Phase.Exit;
  }

  private hide(i: number) {
    this.phase[i] = Phase.Hidden;
    this.visible[i] = 0;
    this.timer[i] = 0.4 + this.hashA[i] * 2.6;
  }

  private writeRing(i: number, rx: number, rz: number) {
    const o = i * 3;
    const [x, z] = ringPoint(rx, rz, this.angle[i], this.scale[i]);
    this.positions[o] = x;
    this.positions[o + 2] = z;
    this.positions[o + 1] = this.heightAt(this.scale[i]);
  }

  /** Seating bowl rises outward; concourse sits at ground level. */
  private heightAt(scale: number) {
    const { seatInner, seatOuter, concourseInner } = this.venue.ring;
    if (scale <= seatOuter) return 0.25 + ((scale - seatInner) / (seatOuter - seatInner)) * 1.25;
    if (scale < concourseInner) return 1.5 * (1 - (scale - seatOuter) / (concourseInner - seatOuter));
    return 0.02;
  }
}
