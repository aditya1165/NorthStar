import { DENSITY_THRESHOLDS, levelForDensity, riskRank, UNSAFE_DENSITY } from "../domain/risk";
import type {
  ContributingFactor,
  GateId,
  GateState,
  IncidentKind,
  InterventionId,
  InterventionOption,
  PlaybackStatus,
  Recommendation,
  RiskLevel,
  RiskPoint,
  ScenarioEvents,
  ScenarioStage,
  TwinSnapshot,
  ZoneForecastPoint,
  ZoneId,
  ZoneState,
} from "../domain/types";
import {
  clearanceTotal,
  INTERVENTIONS,
  interventionDefinition,
  knowledge,
  knownAt,
  RECOMMENDATION_RATIONALE,
  SCENARIO,
  zoneDensities,
  type ModelEvents,
} from "./scenario";
import { MOCK_VENUE } from "./venue";

const ZONE_IDS: ZoneId[] = [
  "southeast_concourse",
  "east_concourse",
  "south_concourse",
  "west_concourse",
  "north_concourse",
  "metro_plaza",
];

const EMPTY_EVENTS: ScenarioEvents = {
  gateBClosedAt: null,
  metroDelayedAt: null,
  elevatedAt: null,
  criticalForecastAt: null,
  recommendationAt: null,
  approvedAt: null,
  stabilizedAt: null,
};

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const snap = (minute: number) => round(Math.round(minute / SCENARIO.step) * SCENARIO.step, 4);

interface EngineState {
  epoch: number;
  minute: number;
  status: PlaybackStatus;
  speed: number;
  events: ScenarioEvents;
  plan: { id: InterventionId; at: number } | null;
  recommendation: Recommendation | null;
  interventions: InterventionOption[];
  /** Sub-step remainder so playback is frame-rate independent. */
  carry: number;
  closedGates: Set<GateId>;
}

function initialState(epoch: number, speed: number): EngineState {
  return {
    epoch,
    minute: 0,
    status: "idle",
    speed,
    events: { ...EMPTY_EVENTS },
    plan: null,
    recommendation: null,
    interventions: [],
    carry: 0,
    closedGates: new Set(),
  };
}

function maxZone(densities: Record<ZoneId, number>): { zoneId: ZoneId; density: number } {
  let best: ZoneId = "southeast_concourse";
  for (const id of ZONE_IDS) if (densities[id] > densities[best]) best = id;
  return { zoneId: best, density: densities[best] };
}

/** Damped forecast for an observer at time t, `h` minutes ahead. */
function forecastDensities(t: number, h: number, events: ModelEvents): Record<ZoneId, number> {
  const known = knownAt(t, events);
  const now = zoneDensities(t, known);
  const future = zoneDensities(t + h, known);
  const k = knowledge(t, known);
  const out = {} as Record<ZoneId, number>;
  for (const id of ZONE_IDS) out[id] = now[id] + (future[id] - now[id]) * k;
  return out;
}

/** Per-zone maximum of the damped forecast over the next `h` minutes. */
function forecastWindowMax(t: number, h: number, events: ModelEvents): Record<ZoneId, number> {
  const out = zoneDensities(t, knownAt(t, events));
  for (let dt = 0.5; dt <= h + 1e-6; dt += 0.5) {
    const d = forecastDensities(t, dt, events);
    for (const id of ZONE_IDS) out[id] = Math.max(out[id], d[id]);
  }
  return out;
}

/**
 * Deterministic mock scenario engine. Pure state machine with no timers so it
 * can be driven by a clock (MockTwinService) or stepped directly in tests.
 */
export class MockScenarioEngine {
  private state: EngineState = initialState(0, 1);

  get minute() {
    return this.state.minute;
  }

  get status() {
    return this.state.status;
  }

  reset(): void {
    this.state = initialState(this.state.epoch + 1, this.state.speed);
  }

  setStatus(status: PlaybackStatus): void {
    if (this.state.status === "complete" && status === "running") return;
    this.state.status = status;
  }

  setSpeed(speed: number): void {
    this.state.speed = speed;
  }

  setGateStatus(gateId: GateId, status: "open" | "closed"): void {
    if (status === "closed") this.state.closedGates.add(gateId);
    else this.state.closedGates.delete(gateId);
    if (gateId === "gate_b") {
      this.state.events.gateBClosedAt = status === "closed" ? snap(this.state.minute) : null;
    }
  }

  /** Advance by a number of scenario minutes using fixed sub-steps. */
  advance(minutes: number): void {
    if (this.state.status !== "running") return;
    this.state.carry += minutes;
    while (this.state.carry >= SCENARIO.step - 1e-9 && this.state.status === "running") {
      this.state.carry -= SCENARIO.step;
      this.step();
    }
  }

  /** Reset and fast-forward with scripted incidents to the given minute. */
  jumpTo(minute: number): void {
    const keepSpeed = this.state.speed;
    this.state = initialState(this.state.epoch + 1, keepSpeed);
    this.state.status = "running";
    while (this.state.minute < minute - 1e-6) this.step();
    this.state.status = "paused";
  }

  triggerIncident(kind: IncidentKind): void {
    const at = snap(this.state.minute);
    if (kind === "gate_b_closure" && this.state.events.gateBClosedAt === null) {
      this.state.events.gateBClosedAt = at;
      this.state.closedGates.add("gate_b");
    }
    if (kind === "metro_delay" && this.state.events.metroDelayedAt === null) this.state.events.metroDelayedAt = at;
  }

  approve(id: InterventionId): void {
    if (id === "do_nothing" || this.state.plan) return;
    const at = snap(this.state.minute);
    this.state.plan = { id, at };
    this.state.events.approvedAt = at;
    if (this.state.recommendation) this.state.recommendation = { ...this.state.recommendation, status: "approved" };
    if (this.state.status === "idle") this.state.status = "paused";
  }

  reject(): void {
    if (this.state.recommendation?.status === "pending") {
      this.state.recommendation = { ...this.state.recommendation, status: "rejected" };
    }
  }

  private modelEvents(): ModelEvents {
    return { gateBClosedAt: this.state.events.gateBClosedAt, metroDelayedAt: this.state.events.metroDelayedAt, plan: this.state.plan };
  }

  private step(): void {
    const s = this.state;
    s.minute = snap(s.minute + SCENARIO.step);
    const t = s.minute;

    if (s.events.metroDelayedAt === null && t >= SCENARIO.scripted.metroDelay) s.events.metroDelayedAt = SCENARIO.scripted.metroDelay;

    const events = this.modelEvents();
    const current = maxZone(zoneDensities(t, events));
    const currentLevel = levelForDensity(current.density);

    if (!s.plan) {
      if (s.events.elevatedAt === null && riskRank(currentLevel) >= riskRank("elevated")) s.events.elevatedAt = t;
      const ahead = maxZone(forecastWindowMax(t, 10, events));
      if (s.events.criticalForecastAt === null && ahead.density >= UNSAFE_DENSITY) s.events.criticalForecastAt = t;
    }

    if (
      s.events.criticalForecastAt !== null &&
      s.events.recommendationAt === null &&
      t >= s.events.criticalForecastAt + SCENARIO.recommendationLatency - 1e-6
    ) {
      s.events.recommendationAt = t;
      s.interventions = this.evaluateInterventions(t);
      const best = s.interventions.find((item) => item.recommended);
      if (best && !s.plan) {
        s.recommendation = { interventionId: best.id, rationale: RECOMMENDATION_RATIONALE, status: "pending", issuedAt: t };
      }
    }

    if (s.plan && s.events.stabilizedAt === null && t > s.plan.at && currentLevel === "normal") s.events.stabilizedAt = t;

    if (t >= SCENARIO.duration - 1e-6) s.status = "complete";
  }

  /** Mock outcomes for every candidate response if applied at time t. */
  private evaluateInterventions(t: number): InterventionOption[] {
    const base = this.modelEvents();
    const { from, to } = SCENARIO.outcomeWindow;

    const evaluate = (id: InterventionId) => {
      const events: ModelEvents = { ...base, plan: id === "do_nothing" ? null : { id, at: t } };
      const zonePeaks = Object.fromEntries(ZONE_IDS.map((z) => [z, 0])) as Record<ZoneId, number>;
      for (let tau = t + from; tau <= t + to + 1e-6; tau += 0.25) {
        const d = zoneDensities(tau, events);
        for (const z of ZONE_IDS) zonePeaks[z] = Math.max(zonePeaks[z], d[z]);
      }
      const zoneForecast = Object.fromEntries(
        ZONE_IDS.map((z) => [z, { 5: round(zoneDensities(t + 5, events)[z]), 10: round(zoneDensities(t + 10, events)[z]) }]),
      ) as Record<ZoneId, Record<5 | 10, number>>;
      return { events, zonePeaks, zoneForecast };
    };

    const baseline = evaluate("do_nothing");
    const baselinePeak = maxZone(baseline.zonePeaks).density;

    const options: InterventionOption[] = INTERVENTIONS.map((def) => {
      const result = evaluate(def.id);
      const peak = maxZone(result.zonePeaks);
      const bottleneck = ZONE_IDS.find(
        (z) =>
          z !== "southeast_concourse" &&
          result.zonePeaks[z] >= DENSITY_THRESHOLDS.high &&
          baseline.zonePeaks[z] < DENSITY_THRESHOLDS.high,
      );
      return {
        id: def.id,
        name: def.name,
        shortName: def.shortName,
        summary: def.summary,
        routeIds: def.routeIds,
        opensGateC: def.opensGateC,
        reroute: def.rerouteGate ? { sections: def.reroutedSections, gate: def.rerouteGate } : null,
        oneWay: def.routeIds.includes("one_way_east_corridor"),
        zoneForecast: result.zoneForecast,
        recommended: false,
        outcome: {
          peakDensity: round(peak.density, 1),
          peakLevel: levelForDensity(peak.density),
          riskReductionPercent: Math.round(((baselinePeak - peak.density) / baselinePeak) * 100),
          clearanceMinutes: Math.round(def.totalClearance - t),
          peopleRedirected: def.peopleRedirected,
          extraWalkMeters: def.extraWalkMeters,
          accessibleRoutesPreserved: def.accessibleRoutesPreserved,
          secondaryBottleneck: bottleneck ?? null,
          operationalComplexity: def.operationalComplexity,
        },
      };
    });

    // Rank: lowest peak, heavily penalising secondary bottlenecks and accessibility loss.
    const score = (o: InterventionOption) =>
      o.outcome.peakDensity +
      (o.outcome.secondaryBottleneck ? 1.5 : 0) +
      (o.outcome.accessibleRoutesPreserved ? 0 : 1.5) +
      o.outcome.operationalComplexity * 0.05;
    const best = options.filter((o) => o.id !== "do_nothing").sort((a, b) => score(a) - score(b))[0];
    return options.map((o) => ({ ...o, recommended: o.id === best?.id }));
  }

  private stage(level: RiskLevel): ScenarioStage {
    const { events, plan, recommendation } = this.state;
    if (plan) return events.stabilizedAt !== null ? "stabilized" : "intervention_approved";
    if (recommendation) return "recommendation_available";
    if (events.criticalForecastAt !== null) return "critical_forecast";
    if (events.elevatedAt !== null || riskRank(level) >= riskRank("elevated")) return "elevated_risk";
    if (events.metroDelayedAt !== null) return "metro_delay";
    if (events.gateBClosedAt !== null) return "gate_closure";
    return "normal";
  }

  snapshot(): TwinSnapshot {
    const s = this.state;
    const t = s.minute;
    const events = this.modelEvents();
    const now = zoneDensities(t, events);
    const f5 = forecastWindowMax(t, 5, events);
    const f10 = forecastWindowMax(t, 10, events);
    const k = knowledge(t, knownAt(t, events));
    const band = (density: number, h: number) => density * (0.04 + 0.012 * h) * (2 - k);
    const point = (density: number, h: number): ZoneForecastPoint => ({
      density: round(density),
      level: levelForDensity(density),
      low: round(Math.max(0, density - band(density, h))),
      high: round(density + band(density, h)),
    });

    const zones: ZoneState[] = ZONE_IDS.map((id) => ({
      id,
      density: round(now[id]),
      level: levelForDensity(now[id]),
      forecast: { 5: point(f5[id], 5), 10: point(f10[id], 10) },
    }));

    const hottest = maxZone(now);
    const peak5 = maxZone(f5);
    const peak10 = maxZone(f10);
    const level = levelForDensity(hottest.density);

    let minutesToUnsafe: number | null = null;
    if (hottest.density >= UNSAFE_DENSITY) minutesToUnsafe = 0;
    else {
      for (let dt = 0.1; dt <= 15 + 1e-6; dt += 0.1) {
        if (maxZone(forecastDensities(t, dt, events)).density >= UNSAFE_DENSITY) {
          minutesToUnsafe = round(dt, 1);
          break;
        }
      }
    }

    const history: RiskPoint[] = [];
    for (let tau = 0; tau <= t + 1e-6; tau += 0.25) {
      history.push({ minute: round(tau), density: round(zoneDensities(tau, events).southeast_concourse) });
    }
    const projection: RiskPoint[] = [];
    for (let dt = 0; dt <= 10 + 1e-6; dt += 0.5) {
      const d = forecastDensities(t, dt, events).southeast_concourse;
      projection.push({ minute: round(t + dt), density: round(d), low: round(d - band(d, dt)), high: round(d + band(d, dt)) });
    }

    const metroDelayed = s.events.metroDelayedAt !== null;
    const gates: GateState[] = MOCK_VENUE.gates.map((gate) => {
      const closed = s.closedGates.has(gate.id);
      return {
        id: gate.id,
        status: closed ? "closed" : "open",
        throughputPerMin: closed ? 0 : gate.capacityPerMinute,
        note: closed ? "Closed · operator control" : "Open · available exit",
      };
    });

    return {
      epoch: s.epoch,
      minute: t,
      duration: SCENARIO.duration,
      status: s.status,
      speed: s.speed,
      stage: this.stage(level),
      events: { ...s.events },
      gates,
      transit: { status: metroDelayed ? "delayed" : "normal", capacityRatio: metroDelayed ? 0.45 : 1 },
      zones,
      risk: {
        level,
        hotspotZoneId: hottest.zoneId,
        hotspotDensity: round(hottest.density),
        predictedPeak: {
          5: { density: round(peak5.density), level: levelForDensity(peak5.density), zoneId: peak5.zoneId },
          10: { density: round(peak10.density), level: levelForDensity(peak10.density), zoneId: peak10.zoneId },
        },
        minutesToUnsafe,
        clearanceMinutes: Math.max(0, Math.round(clearanceTotal(events) - t)),
        confidence: round(0.6 + 0.34 * k),
        factors: this.factors(t, events),
      },
      interventions: s.interventions,
      recommendation: s.recommendation,
      activePlan: s.plan ? { interventionId: s.plan.id, approvedAt: s.plan.at } : null,
      history,
      projection,
    };
  }

  private factors(t: number, events: ModelEvents): ContributingFactor[] {
    const r = (at: number | null, tau: number) => (at === null || t < at ? 0 : 1 - Math.exp(-(t - at) / tau));
    const def = events.plan ? interventionDefinition(events.plan.id) : null;
    const relief = def && events.plan ? 1 - def.hotspotRelief * r(events.plan.at, SCENARIO.planTimeConstant) : 1;
    const gate = 1.6 * r(events.gateBClosedAt, 3.5) * relief;
    const metro = 2.4 * r(events.metroDelayedAt, 6) * relief;
    const hot = zoneDensities(t, events).southeast_concourse;
    const raw: ContributingFactor[] = [
      { id: "gate_b", label: "Gate B closed — 90 people/min of exit capacity lost", weight: gate },
      { id: "metro", label: "Metro delay — platform capacity at 45%", weight: metro },
      { id: "inflow", label: "Inflow exceeds outflow in Southeast Concourse", weight: Math.max(0, (gate + metro) * 0.55) },
      { id: "counterflow", label: "Counter-flow at Section 207 vomitory", weight: hot > 2.8 ? (hot - 2.8) * 0.7 : 0 },
    ];
    const total = raw.reduce((sum, f) => sum + f.weight, 0);
    if (total < 0.15) return [];
    return raw
      .filter((f) => f.weight / total > 0.04)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 3)
      .map((f) => ({ ...f, weight: round(f.weight / total) }));
  }
}
