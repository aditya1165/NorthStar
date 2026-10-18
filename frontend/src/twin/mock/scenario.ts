import type { InterventionId, InterventionOutcome, RouteId, ZoneId } from "../domain/types";

/**
 * Deterministic mock scenario: World Cup post-match egress at Meridian Stadium.
 *
 * Everything here is hand-tuned closed-form curves, NOT a forecasting or
 * optimisation algorithm. It exists so the frontend can demonstrate the full
 * operator workflow before the real simulation/forecast services are wired in.
 * All times are scenario minutes after the final whistle.
 */
export const SCENARIO = {
  id: "world-cup-egress",
  name: "Post-match egress · Gate B closure + metro delay",
  duration: 48,
  /** Fixed simulation step used for event detection (keeps results frame-rate independent). */
  step: 0.05,
  /** Scenario minutes advanced per real second at 1× playback. */
  minutesPerSecond: 0.1,
  speeds: [0.5, 1, 2, 4] as const,
  scripted: { gateBClosure: 3, metroDelay: 5 },
  /** Time the mock "analysis" takes after a critical forecast before a recommendation is issued. */
  recommendationLatency: 1,
  /** Where "Jump to incident" lands (with scripted incidents applied). */
  incidentMinute: 8.25,
  /** Minutes of post-event data before forecasts reach full confidence. */
  knowledgeWindow: { incident: 2.5, plan: 1 },
  /** How quickly an approved plan takes effect (time constant, minutes). */
  planTimeConstant: 2.2,
  /** Outcomes are evaluated over this window after implementation lag. */
  outcomeWindow: { from: 2, to: 15 },
} as const;

export const BASE_DENSITY: Record<ZoneId, number> = {
  north_concourse: 0.95,
  east_concourse: 1.05,
  southeast_concourse: 1.25,
  south_concourse: 1.1,
  west_concourse: 1.3,
  metro_plaza: 1.15,
};

export interface InterventionDefinition {
  id: InterventionId;
  name: string;
  shortName: string;
  summary: string;
  routeIds: RouteId[];
  opensGateC: boolean;
  /** Fraction of southeast accumulation removed once fully effective. */
  hotspotRelief: number;
  /** Extra density added to other zones once fully effective. */
  zoneLoad: Partial<Record<ZoneId, number>>;
  /** Total venue clearance time (minutes after final whistle) if applied. */
  totalClearance: number;
  peopleRedirected: number;
  extraWalkMeters: number;
  accessibleRoutesPreserved: boolean;
  operationalComplexity: InterventionOutcome["operationalComplexity"];
  /** Section numbers whose pedestrians change destination. */
  reroutedSections: number[];
  /** Destination gate for rerouted sections. */
  rerouteGate: "gate_a" | "gate_c" | null;
}

export const INTERVENTIONS: readonly InterventionDefinition[] = [
  {
    id: "do_nothing",
    name: "Do nothing",
    shortName: "No action",
    summary: "Maintain current gate plan and monitor.",
    routeIds: [],
    opensGateC: false,
    hotspotRelief: 0,
    zoneLoad: {},
    totalClearance: 38,
    peopleRedirected: 0,
    extraWalkMeters: 0,
    accessibleRoutesPreserved: true,
    operationalComplexity: 1,
    reroutedSections: [],
    rerouteGate: null,
  },
  {
    id: "open_gate_c",
    name: "Open Gate C",
    shortName: "Gate C",
    summary: "Open reserve Gate C; nearby sections self-divert along the east concourse.",
    routeIds: ["gate_c_ring"],
    opensGateC: true,
    hotspotRelief: 0.38,
    zoneLoad: { east_concourse: 1.1 },
    totalClearance: 31,
    peopleRedirected: 1400,
    extraWalkMeters: 45,
    accessibleRoutesPreserved: true,
    operationalComplexity: 2,
    reroutedSections: [203, 204, 205],
    rerouteGate: "gate_c",
  },
  {
    id: "redirect_205_208",
    name: "Redirect Sections 205–208",
    shortName: "Redirect 205–208",
    summary: "Signage and stewards send Sections 205–208 south to Gate A.",
    routeIds: ["redirect_to_gate_a"],
    opensGateC: false,
    hotspotRelief: 0.3,
    zoneLoad: { south_concourse: 0.7, west_concourse: 0.85 },
    totalClearance: 33,
    peopleRedirected: 2100,
    extraWalkMeters: 160,
    accessibleRoutesPreserved: true,
    operationalComplexity: 3,
    reroutedSections: [205, 206, 207, 208],
    rerouteGate: "gate_a",
  },
  {
    id: "one_way_corridor",
    name: "Make corridor one-way",
    shortName: "One-way corridor",
    summary: "Convert the southeast corridor to southbound only to remove counter-flow.",
    routeIds: ["one_way_east_corridor"],
    opensGateC: false,
    hotspotRelief: 0.22,
    zoneLoad: { south_concourse: 2.0 },
    totalClearance: 35,
    peopleRedirected: 900,
    extraWalkMeters: 85,
    accessibleRoutesPreserved: false,
    operationalComplexity: 2,
    reroutedSections: [],
    rerouteGate: null,
  },
  {
    id: "gate_c_and_redirect",
    name: "Open Gate C + redirect Sections 205–208",
    shortName: "Gate C + redirect",
    summary: "Open Gate C and send Sections 205–208 via the inner concourse to Gate C.",
    routeIds: ["gate_c_ring", "redirect_205_208_inner"],
    opensGateC: true,
    hotspotRelief: 0.66,
    zoneLoad: { east_concourse: 1.0 },
    totalClearance: 26,
    peopleRedirected: 3200,
    extraWalkMeters: 70,
    accessibleRoutesPreserved: true,
    operationalComplexity: 3,
    reroutedSections: [203, 204, 205, 206, 207, 208],
    rerouteGate: "gate_c",
  },
];

export const RECOMMENDATION_RATIONALE =
  "Open Gate C and redirect Sections 205–208. This is predicted to reduce peak density while preserving accessible routes and avoiding a secondary bottleneck.";

export const NORMAL_CLEARANCE = 22;
export const GATE_B_CLEARANCE = 30;

export function interventionDefinition(id: InterventionId): InterventionDefinition {
  const def = INTERVENTIONS.find((item) => item.id === id);
  if (!def) throw new Error(`Unknown intervention ${id}`);
  return def;
}

/* ------------------------------------------------------------ curve model */

export interface ModelEvents {
  gateBClosedAt: number | null;
  metroDelayedAt: number | null;
  plan: { id: InterventionId; at: number } | null;
}

const ramp = (t: number, at: number | null, tau: number) => (at === null || t < at ? 0 : 1 - Math.exp(-(t - at) / tau));

/** Crowd volume envelope: egress tails off after ~17 minutes. */
export function envelope(t: number): number {
  if (t <= 17) return 1;
  return 1 - 0.5 * Math.min(1, (t - 17) / 9);
}

/** Southeast concourse density with no intervention, given which incidents are known at time t. */
export function hotspotUnmitigated(t: number, events: Pick<ModelEvents, "gateBClosedAt" | "metroDelayedAt">): number {
  const gate = 1.6 * ramp(t, events.gateBClosedAt, 3.5);
  const metro = 2.4 * ramp(t, events.metroDelayedAt, 6);
  const texture = 0.035 * Math.sin(t * 1.9) + 0.02 * Math.sin(t * 4.3);
  return (BASE_DENSITY.southeast_concourse + gate + metro + texture) * envelope(t);
}

/** Density for every zone at time t. Only events at or before t take effect. */
export function zoneDensities(t: number, events: ModelEvents): Record<ZoneId, number> {
  const env = envelope(t);
  const plan = events.plan && events.plan.at <= t ? events.plan : null;
  const def = plan ? interventionDefinition(plan.id) : null;
  const effect = def && plan ? def.hotspotRelief * ramp(t, plan.at, SCENARIO.planTimeConstant) : 0;
  const loadRamp = plan ? ramp(t, plan.at, SCENARIO.planTimeConstant * 1.3) : 0;
  const load = (zone: ZoneId) => (def?.zoneLoad[zone] ?? 0) * loadRamp;

  const southeast = hotspotUnmitigated(t, events) * (1 - effect);
  const excess = Math.max(0, southeast / env - BASE_DENSITY.southeast_concourse);
  const metro = 1.2 * ramp(t, events.metroDelayedAt, 4);

  return {
    southeast_concourse: southeast,
    east_concourse: (BASE_DENSITY.east_concourse + 0.12 * excess + load("east_concourse")) * env,
    south_concourse: (BASE_DENSITY.south_concourse + 0.22 * excess + load("south_concourse")) * env,
    west_concourse: (BASE_DENSITY.west_concourse + 0.08 * excess + load("west_concourse")) * env,
    north_concourse: (BASE_DENSITY.north_concourse + 0.05 * excess) * env,
    metro_plaza: (BASE_DENSITY.metro_plaza + metro + 0.06 * Math.sin(t * 1.3)) * env,
  };
}

/** Forecast confidence: drops right after a new event, recovers as data accumulates. */
export function knowledge(t: number, events: ModelEvents): number {
  let k = 1;
  const consider = (at: number | null, window: number) => {
    if (at !== null && at <= t) k = Math.min(k, (t - at) / window);
  };
  consider(events.gateBClosedAt, SCENARIO.knowledgeWindow.incident);
  consider(events.metroDelayedAt, SCENARIO.knowledgeWindow.incident);
  consider(events.plan?.at ?? null, SCENARIO.knowledgeWindow.plan);
  return Math.max(0, Math.min(1, k));
}

/** Events visible to an observer at time t (no knowledge of the future). */
export function knownAt(t: number, events: ModelEvents): ModelEvents {
  return {
    gateBClosedAt: events.gateBClosedAt !== null && events.gateBClosedAt <= t ? events.gateBClosedAt : null,
    metroDelayedAt: events.metroDelayedAt !== null && events.metroDelayedAt <= t ? events.metroDelayedAt : null,
    plan: events.plan && events.plan.at <= t ? events.plan : null,
  };
}

export function clearanceTotal(events: ModelEvents): number {
  if (events.plan) return interventionDefinition(events.plan.id).totalClearance;
  if (events.metroDelayedAt !== null && events.gateBClosedAt !== null) return 38;
  if (events.metroDelayedAt !== null) return 27;
  if (events.gateBClosedAt !== null) return GATE_B_CLEARANCE;
  return NORMAL_CLEARANCE;
}
