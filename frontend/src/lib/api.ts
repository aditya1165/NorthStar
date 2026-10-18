import {
  forecastSchema,
  interventionResultSchema,
  simulationSnapshotSchema,
  type Forecast,
  type InterventionResult,
  type SimulationSnapshot,
} from "../types/contracts";
import { apiBaseUrl } from "./endpoints";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  async getState(): Promise<SimulationSnapshot> {
    return simulationSnapshotSchema.parse(await request("/api/state"));
  },
  async start(): Promise<SimulationSnapshot> {
    return simulationSnapshotSchema.parse(await request("/api/simulation/start", { method: "POST" }));
  },
  async pause(): Promise<SimulationSnapshot> {
    return simulationSnapshotSchema.parse(await request("/api/simulation/pause", { method: "POST" }));
  },
  async step(): Promise<SimulationSnapshot> {
    return simulationSnapshotSchema.parse(await request("/api/simulation/step", { method: "POST" }));
  },
  async reset(): Promise<SimulationSnapshot> {
    return simulationSnapshotSchema.parse(await request("/api/simulation/reset", { method: "POST" }));
  },
  async setIncident(incident: string, active: boolean): Promise<SimulationSnapshot> {
    return simulationSnapshotSchema.parse(
      await request(`/api/incidents/${incident}`, {
        method: "POST",
        body: JSON.stringify({ active }),
      }),
    );
  },
  async getForecasts(): Promise<Forecast[]> {
    return forecastSchema.array().parse(await request("/api/forecasts"));
  },
  async getInterventions(): Promise<InterventionResult[]> {
    return interventionResultSchema.array().parse(await request("/api/interventions"));
  },
  async approveIntervention(interventionId: string): Promise<void> {
    await request(`/api/interventions/${interventionId}/approve`, { method: "POST" });
  },
};

