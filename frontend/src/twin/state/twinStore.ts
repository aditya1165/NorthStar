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
  liveApprovedRoute: { from: GateId; to: GateId } | null;
  liveEvaluationReceivedAt: number;
  liveApprovalPending: boolean;
  liveApprovalMessage: string | null;
  /** Force a same-time batch after operator controls, including while paused. */
  telemetryNonce: number;

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
  selectLive: (id: string | null) => void;
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
const gateKey = (snapshot: TwinSnapshot | null) => snapshot?.gates.filter((gate) => gate.status === "closed").map((gate) => gate.id).sort().join(",") ?? "";
const REVIEW_WINDOW_MS = 120_000;

export const useTwinStore = create<TwinState>((set, get) => {
  let revision = 0;
  let evaluationRequest: { runId: string } | null = null;
  let approvalRequest: { interventionId: string } | null = null;
  let lastAttemptAt = -Infinity;
  let lastEvaluatedMinute = -1;
  let sentGateKey = "";
  let sentSequence = -1;
  const invalidateEvaluation = () => {
    revision += 1;
    lastAttemptAt = -Infinity;
    set({ liveEvaluation: null, liveSelectedId: null, liveEvaluationReceivedAt: 0, liveEvaluationError: null, telemetryNonce: get().telemetryNonce + 1 });
  };
  const call = (fn: (service: CrowdTwinService) => Promise<void>) => {
    const { service } = get();
    if (service) void fn(service);
  };
  const clearDecisionUi = () => set({ selectedInterventionId: null, modifying: false, dismissedStabilizedEpoch: null });
  const clearLive = () => {
    invalidateEvaluation();
    evaluationRequest = null;
    approvalRequest = null;
    sentGateKey = "";
    sentSequence = -1;
    lastEvaluatedMinute = -1;
    set({
      liveRunId: null,
      congestion: null,
      liveHistory: [],
      liveEvaluation: null,
      liveEvaluationStatus: "idle",
      liveEvaluationError: null,
      liveSelectedId: null,
      livePlan: null,
      liveApprovedRoute: null,
      liveApprovalPending: false,
      liveApprovalMessage: null,
    });
  };

  const maybeEvaluate = () => {
    const state = get();
    if (state.liveApprovalPending) return;
    if (state.liveEvaluation && Date.now() - state.liveEvaluationReceivedAt >= REVIEW_WINDOW_MS) invalidateEvaluation();
    const current = get();
    if (current.liveSelectedId || evaluationRequest?.runId === current.liveRunId) return;
    if (Date.now() - lastAttemptAt < 30_000) return;
    if (current.liveEvaluation && current.snapshot?.minute === lastEvaluatedMinute) return;
    void current.evaluateLive();
  };

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
    liveApprovedRoute: null,
    liveEvaluationReceivedAt: 0,
    liveApprovalPending: false,
    liveApprovalMessage: null,
    telemetryNonce: 0,
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
        if (gateKey(snapshot) !== gateKey(get().snapshot)) invalidateEvaluation();
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
        if (get().service === service) set({ service: null });
      };
    },

    connectCongestion: (client) => {
      set({ congestionClient: client, congestionConnection: "connecting" });
      client.connect({
        onConnection: (congestionConnection) => {
          if (get().congestionConnection !== congestionConnection) {
            invalidateEvaluation();
            set({ congestion: null });
          }
          set({ congestionConnection });
        },
        onSnapshot: (congestion) => {
          if (congestion.runId !== get().liveRunId) return;
          const previous = get().congestion;
          if (previous?.routing && congestion.routing && previous.routing.activePlanId !== congestion.routing.activePlanId) {
            const approvedId = approvalRequest?.interventionId;
            const ownApprovalEcho = approvedId !== undefined && congestion.routing.activePlanId === (approvedId === "do_nothing" ? null : approvedId);
            if (!ownApprovalEcho) invalidateEvaluation();
            if (!congestion.routing.activePlanId) set({ livePlan: null, liveApprovedRoute: null });
          }
          const zones = congestion.zones;
          if (!zones || zones.length === 0) {
            set({ congestion });
            maybeEvaluate();
            return;
          }
          const peak = zones.reduce((a, b) => (b.densityPerM2 > a.densityPerM2 ? b : a));
          const point = { minute: congestion.simulationTimeSeconds / 60, density: peak.densityPerM2, zoneId: peak.zoneId };
          const history = get().liveHistory;
          const last = history[history.length - 1];
          const next = last && point.minute <= last.minute ? history : [...history, point].slice(-LIVE_HISTORY_LIMIT);
          set({ congestion, liveHistory: next });
          maybeEvaluate();
        },
      });
      const timer = setInterval(maybeEvaluate, 1_000);
      return () => {
        clearInterval(timer);
        client.dispose();
        if (get().congestionClient === client) {
          invalidateEvaluation();
          set({ congestionClient: null, congestion: null, congestionConnection: "unavailable" });
        }
      };
    },

    publishTelemetry: (batch) => {
      const state = get();
      if (state.congestion && state.congestion.runId !== batch.runId) set({ congestion: null });
      if (state.liveRunId !== batch.runId) {
        clearLive();
        set({ liveRunId: batch.runId });
      }
      sentGateKey = [...(batch.closedGates ?? [])].sort().join(",");
      sentSequence = batch.sequence;
      state.congestionClient?.publish(batch);
    },

    evaluateLive: async () => {
      const state = get();
      const runId = state.liveRunId;
      if (!runId || evaluationRequest?.runId === runId || state.liveSelectedId || state.liveApprovalPending || state.congestionConnection !== "connected") return;
      if (!state.snapshot || state.snapshot.status === "idle" || state.snapshot.status === "complete" || !state.congestion?.routing) return;
      if (sentGateKey !== gateKey(state.snapshot) || state.congestion.sequence < sentSequence) return;
      const context = revision;
      const request = { runId };
      evaluationRequest = request;
      lastAttemptAt = Date.now();
      lastEvaluatedMinute = state.snapshot.minute;
      set({ liveEvaluationStatus: "evaluating", liveEvaluationError: null });
      try {
        const evaluation = await evaluateInterventions(runId);
        if (evaluationRequest !== request || get().liveRunId !== runId || revision !== context || get().liveSelectedId || get().liveApprovalPending) return;
        set({ liveEvaluation: evaluation, liveEvaluationReceivedAt: Date.now(), liveEvaluationStatus: "idle" });
      } catch (error) {
        if (evaluationRequest !== request || get().liveRunId !== runId || revision !== context || get().liveSelectedId || get().liveApprovalPending) return;
        set({ liveEvaluationStatus: "error", liveEvaluationError: error instanceof Error ? error.message : String(error) });
      } finally {
        if (evaluationRequest === request) {
          evaluationRequest = null;
          if (get().liveEvaluationStatus === "evaluating") set({ liveEvaluationStatus: "idle" });
        }
      }
    },

    selectLive: (id) => {
      set({ liveSelectedId: id });
      if (id === null) {
        lastAttemptAt = -Infinity;
        lastEvaluatedMinute = -1;
        maybeEvaluate();
      }
    },

    approveLive: async () => {
      const { liveRunId, liveEvaluation, liveSelectedId, liveEvaluationReceivedAt, congestionConnection, liveApprovalPending } = get();
      const id = liveSelectedId ?? liveEvaluation?.recommendedId;
      if (!liveRunId || !id || !liveEvaluation || liveApprovalPending || congestionConnection !== "connected") return;
      if (Date.now() - liveEvaluationReceivedAt >= REVIEW_WINDOW_MS) { invalidateEvaluation(); return; }
      const candidate = liveEvaluation.candidates.find((item) => item.interventionId === id);
      if (!candidate?.feasible) return;
      set({ liveApprovalPending: true, liveApprovalMessage: null });
      const request = { interventionId: id };
      approvalRequest = request;
      const context = revision;
      try {
        const plan = await approveLiveIntervention(liveRunId, id, liveEvaluation.evaluationId);
        if (approvalRequest !== request || get().liveRunId !== liveRunId || revision !== context) return;
        invalidateEvaluation();
        set({
          livePlan: id === "do_nothing" ? null : plan,
          liveApprovedRoute: candidate.redirectGate ? { from: liveEvaluation.hotspotGate, to: candidate.redirectGate } : null,
          liveApprovalMessage: id === "do_nothing" ? "Current routes kept. No active routing plan." : "Approved. People will follow this route along the outer concourse.",
        });
      } catch (error) {
        if (approvalRequest === request && get().liveRunId === liveRunId && revision === context) set({ liveEvaluationError: error instanceof Error ? error.message : String(error) });
      } finally {
        if (approvalRequest === request) {
          approvalRequest = null;
          set({ liveApprovalPending: false });
        }
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
