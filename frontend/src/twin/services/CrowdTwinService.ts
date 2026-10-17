import type { IncidentKind, InterventionId, TwinSnapshot, VenueLayout } from "../domain/types";

/**
 * Boundary between the visual layer and whatever produces twin data.
 *
 * The UI only talks to this interface (through the zustand store). Today it is
 * backed by `MockTwinService`; a future `ApiTwinService` can implement the same
 * contract over REST + WebSocket without touching any components.
 */
export interface CrowdTwinService {
  /** Static venue geometry (gates, zones, sections, routes). */
  getVenue(): Promise<VenueLayout>;
  /** Latest snapshot, or null before the first one has arrived. */
  getSnapshot(): TwinSnapshot | null;
  /** Push-based updates. Returns an unsubscribe function. */
  subscribe(listener: (snapshot: TwinSnapshot) => void): () => void;

  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  reset(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  triggerIncident(kind: IncidentKind): Promise<void>;
  /** Move to the moment a recommendation is available. */
  jumpToIncident(): Promise<void>;
  approveIntervention(id: InterventionId): Promise<void>;
  rejectRecommendation(): Promise<void>;

  dispose(): void;
}

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
