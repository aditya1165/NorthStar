import { create } from "zustand";

import type {
  ForecastHorizon,
  IncidentKind,
  InterventionId,
  InterventionOption,
  TwinSnapshot,
  VenueLayout,
} from "../domain/types";
import type { CrowdTwinService } from "../services/CrowdTwinService";

export type LayerKey = "agents" | "density" | "forecast" | "routes" | "labels";
export type CameraPreset = "overview" | "top" | "incident";

interface TwinState {
  service: CrowdTwinService | null;
  venue: VenueLayout | null;
  snapshot: TwinSnapshot | null;

  horizon: ForecastHorizon;
  /** Operator's chosen candidate; null means "follow the recommendation". */
  selectedInterventionId: InterventionId | null;
  modifying: boolean;
  layers: Record<LayerKey, boolean>;
  camera: { preset: CameraPreset; nonce: number };
  dismissedStabilizedEpoch: number | null;

  connect: (service: CrowdTwinService) => () => void;

  start: () => void;
  pause: () => void;
  resume: () => void;
  reset: () => void;
  replay: () => void;
  setSpeed: (speed: number) => void;
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

  return {
    service: null,
    venue: null,
    snapshot: null,
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
