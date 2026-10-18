import { create } from "zustand";

import type { CongestionClient } from "../congestion/CongestionClient";
import type {
  CongestionConnectionStatus,
  CongestionSnapshot,
  CongestionTelemetryBatch,
} from "../congestion/types";
import type {
  ForecastHorizon,
  GateId,
  IncidentKind,
  InterventionId,
  InterventionOption,
  TwinSnapshot,
  VenueLayout,
} from "../domain/types";
import { approveIntervention as approveLiveIntervention, evaluateInterventions, type LiveEvaluation, type LivePlan } from "../live/api";
import type { CrowdTwinService } from "../services/CrowdTwinService";

export interface LiveHistoryPoint {
  minute: number;
  density: number;
  zoneId: string;
}

type LiveEvaluationStatus = "idle" | "evaluating" | "error";

const LIVE_HISTORY_LIMIT = 600;

export type LayerKey = "agents" | "density" | "forecast" | "routes" | "labels";
export type CameraPreset = "overview" | "top" | "incident";

interface TwinState {
  service: CrowdTwinService | null;
  congestionClient: CongestionClient | null;
  venue: VenueLayout | null;
  snapshot: TwinSnapshot | null;
  congestion: CongestionSnapshot | null;
  congestionConnection: CongestionConnectionStatus;

  /** Telemetry run id currently streamed to the backend. */
  liveRunId: string | null;
  /** Peak live zone density per backend reply, for the timeline. */
  liveHistory: LiveHistoryPoint[];
  liveEvaluation: LiveEvaluation | null;
  liveEvaluationStatus: LiveEvaluationStatus;
  liveEvaluationError: string | null;
  liveSelectedId: string | null;
  livePlan: LivePlan | null;

  horizon: ForecastHorizon;
  /** Operator's chosen candidate; null means "follow the recommendation". */
  selectedInterventionId: InterventionId | null;
  modifying: boolean;
  layers: Record<LayerKey, boolean>;
  camera: { preset: CameraPreset; nonce: number };
  dismissedStabilizedEpoch: number | null;

  connect: (service: CrowdTwinService) => () => void;
  connectCongestion: (client: CongestionClient) => () => void;
  publishTelemetry: (batch: CongestionTelemetryBatch) => void;
  evaluateLive: () => Promise<void>;
  selectLive: (id: string) => void;
  approveLive: () => Promise<void>;

  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  replay: () => void;
  setSpeed: (speed: number) => void;
  setGateStatus: (gateId: GateId, status: "open" | "closed") => void;
  triggerIncident: (kind: IncidentKind) => void;
  jumpToIncident: () => void;

  setHorizon: (horizon: ForecastHorizon) => void;
  selectIntervention: (id: InterventionId) => void;
  approve: () => void;
  modify: () => void;
  cancelModify: () => void;
  reject: () => void;

  toggleLayer: (layer: LayerKey) => void;
  setCamera: (preset: CameraPreset) => void;
  dismissStabilized: () => void;
}

const DEFAULT_LAYERS: Record<LayerKey, boolean> = { agents: true, density: true, forecast: true, routes: true, labels: true };

export const useTwinStore = create<TwinState>((set, get) => {
  const call = (fn: (service: CrowdTwinService) => Promise<void>) => {
    const { service } = get();
    if (service) void fn(service);
  };
  const clearDecisionUi = () => set({ selectedInterventionId: null, modifying: false, dismissedStabilizedEpoch: null });
  const clearLive = () =>
    set({
      liveHistory: [],
      liveEvaluation: null,
      liveEvaluationStatus: "idle",
      liveEvaluationError: null,
      liveSelectedId: null,
      livePlan: null,
    });

  return {
    service: null,
    congestionClient: null,
    venue: null,
    snapshot: null,
    congestion: null,
    congestionConnection: "connecting",
    liveRunId: null,
    liveHistory: [],
    liveEvaluation: null,
    liveEvaluationStatus: "idle",
    liveEvaluationError: null,
    liveSelectedId: null,
    livePlan: null,
    horizon: 10,
    selectedInterventionId: null,
    modifying: false,
    layers: DEFAULT_LAYERS,
    camera: { preset: "overview", nonce: 0 },
    dismissedStabilizedEpoch: null,

    connect: (service) => {
      set({ service, snapshot: service.getSnapshot() });
      let cancelled = false;
      void service.getVenue().then((venue) => {
        if (!cancelled) set({ venue });
      });
      let lastEpoch = service.getSnapshot()?.epoch ?? -1;
      const unsubscribe = service.subscribe((snapshot) => {
        if (snapshot.epoch !== lastEpoch) {
          lastEpoch = snapshot.epoch;
          clearDecisionUi();
          clearLive();
          set({ congestion: null });
        }
        set({ snapshot });
      });
      return () => {
        cancelled = true;
        unsubscribe();
        service.dispose();
        set({ service: null });
      };
    },

    connectCongestion: (client) => {
      set({ congestionClient: client, congestionConnection: "connecting" });
      client.connect({
        onConnection: (congestionConnection) => set({ congestionConnection }),
        onSnapshot: (congestion) => {
          const zones = congestion.zones;
          if (!zones || zones.length === 0) {
            set({ congestion });
            return;
          }
          const peak = zones.reduce((a, b) => (b.densityPerM2 > a.densityPerM2 ? b : a));
          const point = { minute: congestion.simulationTimeSeconds / 60, density: peak.densityPerM2, zoneId: peak.zoneId };
          const history = get().liveHistory;
          const last = history[history.length - 1];
          const next = last && point.minute <= last.minute ? history : [...history, point].slice(-LIVE_HISTORY_LIMIT);
          set({ congestion, liveHistory: next });
        },
      });
      return () => {
        client.dispose();
        set({ congestionClient: null, congestion: null, congestionConnection: "unavailable" });
      };
    },

    publishTelemetry: (batch) => {
      const state = get();
      if (state.congestion && state.congestion.runId !== batch.runId) set({ congestion: null });
      if (state.liveRunId !== batch.runId) {
        clearLive();
        set({ liveRunId: batch.runId });
      }
      state.congestionClient?.publish(batch);
    },

    evaluateLive: async () => {
      const runId = get().liveRunId;
      if (!runId || get().liveEvaluationStatus === "evaluating") return;
      set({ liveEvaluationStatus: "evaluating", liveEvaluationError: null });
      try {
        const evaluation = await evaluateInterventions(runId);
        if (get().liveRunId !== runId) return;
        set({ liveEvaluation: evaluation, liveEvaluationStatus: "idle", liveSelectedId: null });
      } catch (error) {
        if (get().liveRunId !== runId) return;
        set({ liveEvaluationStatus: "error", liveEvaluationError: error instanceof Error ? error.message : String(error) });
      }
    },

    selectLive: (id) => set({ liveSelectedId: id }),

    approveLive: async () => {
      const { liveRunId, liveEvaluation, liveSelectedId } = get();
      const id = liveSelectedId ?? liveEvaluation?.recommendedId;
      if (!liveRunId || !id || id === "do_nothing") return;
      try {
        const plan = await approveLiveIntervention(liveRunId, id);
        if (get().liveRunId === liveRunId) set({ livePlan: plan, liveEvaluationError: null });
      } catch (error) {
        set({ liveEvaluationError: error instanceof Error ? error.message : String(error) });
      }
    },

    start: () => call((s) => s.start()),
    pause: () => call((s) => s.pause()),
    resume: () => call((s) => s.resume()),
    reset: () => {
      clearDecisionUi();
      call((s) => s.reset());
    },
    replay: () => {
      clearDecisionUi();
      call(async (s) => {
        await s.reset();
        await s.start();
      });
    },
    setSpeed: (speed) => call((s) => s.setSpeed(speed)),
    setGateStatus: (gateId, status) => call((s) => s.setGateStatus(gateId, status)),
    triggerIncident: (kind) => call((s) => s.triggerIncident(kind)),
    jumpToIncident: () => {
      clearDecisionUi();
      set({ camera: { preset: "incident", nonce: get().camera.nonce + 1 } });
      call((s) => s.jumpToIncident());
    },

    setHorizon: (horizon) => set({ horizon }),
    selectIntervention: (id) => set({ selectedInterventionId: id }),
    approve: () => {
      const id = selectedIntervention(get())?.id;
      if (!id || id === "do_nothing") return;
      set({ modifying: false });
      call((s) => s.approveIntervention(id));
    },
    modify: () => set({ modifying: true }),
    cancelModify: () => set({ modifying: false, selectedInterventionId: null }),
    reject: () => {
      set({ modifying: false });
      call((s) => s.rejectRecommendation());
    },

    toggleLayer: (layer) => set({ layers: { ...get().layers, [layer]: !get().layers[layer] } }),
    setCamera: (preset) => set({ camera: { preset, nonce: get().camera.nonce + 1 } }),
    dismissStabilized: () => set({ dismissedStabilizedEpoch: get().snapshot?.epoch ?? null }),
  };
});

/* ------------------------------------------------------------- selectors */

export function selectedIntervention(state: Pick<TwinState, "snapshot" | "selectedInterventionId">): InterventionOption | null {
  const options = state.snapshot?.interventions ?? [];
  if (options.length === 0) return null;
  const active = state.snapshot?.activePlan?.interventionId;
  const id = active ?? state.selectedInterventionId ?? state.snapshot?.recommendation?.interventionId;
  return options.find((o) => o.id === id) ?? options.find((o) => o.recommended) ?? null;
}

/** The candidate whose effect the 3D view should preview (null once a plan is active). */
export function previewIntervention(state: Pick<TwinState, "snapshot" | "selectedInterventionId">): InterventionOption | null {
  if (state.snapshot?.activePlan) return null;
  return selectedIntervention(state);
}
