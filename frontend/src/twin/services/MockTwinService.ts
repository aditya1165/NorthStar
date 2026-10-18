import type { IncidentKind, InterventionId, TwinSnapshot, VenueLayout } from "../domain/types";
import { MockScenarioEngine } from "../mock/engine";
import { SCENARIO } from "../mock/scenario";
import { MOCK_VENUE } from "../mock/venue";
import type { CrowdTwinService } from "./CrowdTwinService";

const TICK_MS = 100;

/** Frontend-only service that drives the deterministic mock scenario on a timer. */
export class MockTwinService implements CrowdTwinService {
  private engine = new MockScenarioEngine();
  private listeners = new Set<(snapshot: TwinSnapshot) => void>();
  private latest: TwinSnapshot;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;

  constructor() {
    this.latest = this.engine.snapshot();
  }

  async getVenue(): Promise<VenueLayout> {
    return MOCK_VENUE;
  }

  getSnapshot(): TwinSnapshot {
    return this.latest;
  }

  subscribe(listener: (snapshot: TwinSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.latest);
    return () => this.listeners.delete(listener);
  }

  async start() {
    if (this.engine.status === "complete") this.engine.reset();
    this.engine.setStatus("running");
    this.syncClock();
    this.emit();
  }

  async pause() {
    if (this.engine.status !== "running") return;
    this.engine.setStatus("paused");
    this.syncClock();
    this.emit();
  }

  async resume() {
    if (this.engine.status !== "paused" && this.engine.status !== "idle") return;
    this.engine.setStatus("running");
    this.syncClock();
    this.emit();
  }

  async reset() {
    this.engine.reset();
    this.syncClock();
    this.emit();
  }

  async setSpeed(speed: number) {
    this.engine.setSpeed(speed);
    this.emit();
  }

  async triggerIncident(kind: IncidentKind) {
    this.engine.triggerIncident(kind);
    this.emit();
  }

  async jumpToIncident() {
    this.engine.jumpTo(SCENARIO.incidentMinute);
    this.syncClock();
    this.emit();
  }

  async approveIntervention(id: InterventionId) {
    this.engine.approve(id);
    this.emit();
  }

  async rejectRecommendation() {
    this.engine.reject();
    this.emit();
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  private syncClock() {
    const running = this.engine.status === "running";
    if (running && !this.timer) {
      this.lastTick = performance.now();
      this.timer = setInterval(() => this.tick(), TICK_MS);
    } else if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick() {
    const now = performance.now();
    // Clamp long gaps (background tabs) so the scenario never leaps unexpectedly.
    const seconds = Math.min(0.5, (now - this.lastTick) / 1000);
    this.lastTick = now;
    this.engine.advance(seconds * SCENARIO.minutesPerSecond * this.latest.speed);
    this.syncClock();
    this.emit();
  }

  private emit() {
    this.latest = this.engine.snapshot();
    for (const listener of this.listeners) listener(this.latest);
  }
}
