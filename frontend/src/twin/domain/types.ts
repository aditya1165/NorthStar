/**
 * Frontend domain model for the CrowdGuardian digital twin.
 *
 * These types describe what the UI consumes. They are intentionally independent
 * of how the data is produced: the current implementation is a deterministic
 * mock service, and a future API/WebSocket service only needs to emit the same
 * shapes.
 */

export type RiskLevel = "normal" | "elevated" | "high" | "critical";

export const RISK_ORDER: readonly RiskLevel[] = ["normal", "elevated", "high", "critical"];

export type ScenarioStage =
  | "normal"
  | "gate_closure"
  | "metro_delay"
  | "elevated_risk"
  | "critical_forecast"
  | "recommendation_available"
  | "intervention_approved"
  | "stabilized";

export type PlaybackStatus = "idle" | "running" | "paused" | "complete";

export type ForecastHorizon = 0 | 5 | 10;

export type GateId =
  | "gate_a"
  | "gate_b"
  | "gate_c"
  | "gate_d"
  | "gate_e"
  | "gate_f"
  | "gate_g"
  | "gate_h";

export type ZoneId =
  | "north_concourse"
  | "east_concourse"
  | "southeast_concourse"
  | "south_concourse"
  | "west_concourse"
  | "metro_plaza";

export type InterventionId =
  | "do_nothing"
  | "open_gate_c"
  | "redirect_205_208"
  | "one_way_corridor"
  | "gate_c_and_redirect";

export type RouteId =
  | "gate_c_ring"
  | "redirect_205_208_inner"
  | "redirect_to_gate_a"
  | "one_way_east_corridor";

/* ------------------------------------------------------------------ venue */

/** Venue coordinates are in metres-ish scene units on the ground plane (x east, z south). */
export type Point2 = readonly [x: number, z: number];

export interface SeatingSection {
  id: string;
  label: string;
  /** Centre angle in degrees. 0° = east, 90° = south (clockwise seen from above). */
  angleDeg: number;
}

export interface GateLayout {
  id: GateId;
  label: string;
  angleDeg: number;
  /** Maximum number of people that can cross the exit per simulated minute. */
  capacityPerMinute: number;
  /** Where people go after passing this gate. */
  destination: Point2;
}

export type ZoneShape =
  | { kind: "ring"; fromDeg: number; toDeg: number; labelDeg?: number }
  | { kind: "plaza"; center: Point2; radius: number };

export interface ZoneLayout {
  id: ZoneId;
  label: string;
  shape: ZoneShape;
  /** Usable walking area in m², used to convert people counts to density. */
  areaM2: number;
}

export interface RouteLayout {
  id: RouteId;
  label: string;
  points: readonly Point2[];
}

export interface VenueLayout {
  id: string;
  name: string;
  /** Bowl ellipse radii. All ring geometry is expressed as a scale of these. */
  bowl: { rx: number; rz: number };
  ring: {
    pitch: number;
    seatInner: number;
    seatOuter: number;
    concourseInner: number;
    concourseOuter: number;
    /** Ground-level circulation path reached after descending a seating aisle. */
    basePath: number;
  };
  sections: readonly SeatingSection[];
  gates: readonly GateLayout[];
  zones: readonly ZoneLayout[];
  transit: { id: string; label: string; position: Point2; angleDeg: number };
  routes: readonly RouteLayout[];
}

/* --------------------------------------------------------------- snapshot */

export type GateStatus = "open" | "closed";

export interface GateState {
  id: GateId;
  status: GateStatus;
  /** People per minute currently passing. */
  throughputPerMin: number;
  note: string;
}

export interface TransitState {
  status: "normal" | "delayed";
  /** Fraction of nominal platform capacity currently available (0–1). */
  capacityRatio: number;
}

export interface ZoneForecastPoint {
  density: number;
  level: RiskLevel;
  /** Uncertainty band around density. */
  low: number;
  high: number;
}

export interface ZoneState {
  id: ZoneId;
  density: number;
  level: RiskLevel;
  forecast: Record<5 | 10, ZoneForecastPoint>;
}

export interface ContributingFactor {
  id: string;
  label: string;
  /** Relative contribution 0–1. */
  weight: number;
}

export interface RiskSummary {
  level: RiskLevel;
  hotspotZoneId: ZoneId;
  hotspotDensity: number;
  /** Peak density predicted within each horizon across all zones. */
  predictedPeak: Record<5 | 10, { density: number; level: RiskLevel; zoneId: ZoneId }>;
  /** Minutes until any zone is predicted to exceed the unsafe threshold, or null if not forecast. */
  minutesToUnsafe: number | null;
  /** Estimated minutes until the venue is clear. */
  clearanceMinutes: number;
  /** Forecast confidence 0–1. */
  confidence: number;
  factors: ContributingFactor[];
}

export interface InterventionOutcome {
  peakDensity: number;
  peakLevel: RiskLevel;
  riskReductionPercent: number;
  clearanceMinutes: number;
  peopleRedirected: number;
  extraWalkMeters: number;
  accessibleRoutesPreserved: boolean;
  secondaryBottleneck: ZoneId | null;
  operationalComplexity: 1 | 2 | 3 | 4 | 5;
}

export interface InterventionOption {
  id: InterventionId;
  name: string;
  shortName: string;
  summary: string;
  routeIds: RouteId[];
  opensGateC: boolean;
  /** Seating sections whose pedestrians are sent to a different gate. */
  reroute: { sections: number[]; gate: GateId } | null;
  /** Converts the southeast corridor to one-way flow. */
  oneWay: boolean;
  outcome: InterventionOutcome;
  /** Predicted zone densities if this response were applied now. */
  zoneForecast: Record<ZoneId, Record<5 | 10, number>>;
  recommended: boolean;
}

export type DecisionStatus = "pending" | "approved" | "rejected";

export interface Recommendation {
  interventionId: InterventionId;
  rationale: string;
  status: DecisionStatus;
  issuedAt: number;
}

export interface ActivePlan {
  interventionId: InterventionId;
  approvedAt: number;
}

export interface ScenarioEvents {
  gateBClosedAt: number | null;
  metroDelayedAt: number | null;
  elevatedAt: number | null;
  criticalForecastAt: number | null;
  recommendationAt: number | null;
  approvedAt: number | null;
  stabilizedAt: number | null;
}

export interface RiskPoint {
  minute: number;
  density: number;
  low?: number;
  high?: number;
}

export interface TwinSnapshot {
  /** Increments on reset/jump so views can resynchronise discontinuous state. */
  epoch: number;
  minute: number;
  duration: number;
  status: PlaybackStatus;
  speed: number;
  stage: ScenarioStage;
  events: ScenarioEvents;
  gates: GateState[];
  transit: TransitState;
  zones: ZoneState[];
  risk: RiskSummary;
  /** Empty until a recommendation has been prepared. */
  interventions: InterventionOption[];
  recommendation: Recommendation | null;
  activePlan: ActivePlan | null;
  /** Hotspot density history up to now. */
  history: RiskPoint[];
  /** Hotspot density projection for the next 10 minutes under the current plan. */
  projection: RiskPoint[];
}

export type IncidentKind = "gate_b_closure" | "metro_delay";
