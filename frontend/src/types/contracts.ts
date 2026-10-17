import { z } from "zod";

export const riskLevelSchema = z.enum(["normal", "elevated", "high", "critical"]);

export const zoneTelemetrySchema = z.object({
  zone_id: z.string(),
  name: z.string(),
  people_count: z.number().nonnegative(),
  density_estimate: z.number().nonnegative(),
  inflow_per_min: z.number().nonnegative(),
  outflow_per_min: z.number().nonnegative(),
  mean_speed_mps: z.number().nonnegative(),
  queue_length: z.number().nonnegative(),
  opposing_flow_ratio: z.number().min(0).max(1),
  risk_level: riskLevelSchema,
  status: z.string(),
});

export const simulationSnapshotSchema = z.object({
  elapsed_minutes: z.number().nonnegative(),
  status: z.enum(["idle", "running", "paused", "complete"]),
  incidents: z.object({
    gate_b_closed: z.boolean(),
    metro_delayed: z.boolean(),
  }),
  active_intervention: z.string().nullable(),
  zones: z.array(zoneTelemetrySchema),
});

export const forecastSchema = z.object({
  zone_id: z.string(),
  horizon_minutes: z.number(),
  predicted_density: z.number(),
  predicted_queue_length: z.number(),
  risk_probability: z.number().min(0).max(1),
  time_to_congestion_minutes: z.number().nullable(),
  confidence_interval: z.tuple([z.number(), z.number()]),
  top_factors: z.array(z.string()),
});

export const interventionResultSchema = z.object({
  intervention_id: z.string(),
  name: z.string(),
  actions: z.array(z.string()),
  feasible: z.boolean(),
  recommended: z.boolean(),
  rollouts: z.number(),
  peak_density: z.number(),
  clearance_time_minutes: z.number(),
  people_redirected: z.number(),
  extra_walk_meters_mean: z.number(),
  accessibility_violations: z.number(),
  risk_reduction_percent: z.number(),
  operational_complexity: z.number(),
  explanation: z.string(),
});

export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type ZoneTelemetry = z.infer<typeof zoneTelemetrySchema>;
export type SimulationSnapshot = z.infer<typeof simulationSnapshotSchema>;
export type Forecast = z.infer<typeof forecastSchema>;
export type InterventionResult = z.infer<typeof interventionResultSchema>;

