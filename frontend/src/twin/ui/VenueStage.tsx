import { CircleCheck, X } from "lucide-react";
import { Component, lazy, Suspense, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { mostSevereCongestion } from "../congestion/types";
import { formatClock, RISK_LABEL } from "../domain/risk";
import type { RiskLevel } from "../domain/types";
import { useTwinStore } from "../state/twinStore";
import { hasWebGL, type ViewportTier } from "./hooks";
import { RISK_COLOR } from "./palette";
import { RISK_GLYPH } from "./primitives";

const VenueCanvas = lazy(() => import("../scene/VenueCanvas"));

class CanvasBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function Fallback({ reason }: { reason: string }) {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div className="max-w-sm">
        <p className="text-sm font-medium text-warm">3D venue unavailable</p>
        <p className="mt-1.5 text-xs leading-5 text-ti-text">{reason} Risk intelligence, interventions and controls remain fully available.</p>
      </div>
    </div>
  );
}

export function IncidentStrip() {
  const stage = useTwinStore((s) => s.snapshot?.stage ?? "normal");
  const unsafe = useTwinStore((s) => s.snapshot?.risk.minutesToUnsafe ?? null);
  const level = useTwinStore((s) => s.snapshot?.risk.level ?? "normal");
  const recommendationStatus = useTwinStore((s) => s.snapshot?.recommendation?.status);
  const congestion = useTwinStore((s) => mostSevereCongestion(s.congestion));
  const congestionConnection = useTwinStore((s) => s.congestionConnection);

  let tone: "critical" | "warning" | "info" | "safe" | null = null;
  let text = "";
  if (congestion) {
    tone = congestion.level === "critical" ? "critical" : "warning";
    text = `Congestion detected · ${congestion.label} · ${congestion.densityPerM2.toFixed(1)} p/m² · queue ${congestion.queueLength}`;
  } else if (congestionConnection === "unavailable") {
    tone = "warning";
    text = "Congestion monitoring unavailable · waiting for Python backend";
  }
  if (tone) {
    return (
      <div
        className={cn(
          "pointer-events-none flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium backdrop-blur-md",
          tone === "critical" && "border-vermilion/70 bg-[#2a1210]/85 text-vermilion-text",
          tone === "warning" && "border-signal/40 bg-void/80 text-signal-text",
        )}
      >
        <span aria-hidden>{tone === "critical" ? "▲" : "◆"}</span>
        {text}
      </div>
    );
  }
  switch (stage) {
    case "gate_closure":
      tone = "warning";
      text = "Gate B closed · turnstile fault · 240 people/min exit capacity lost";
      break;
    case "metro_delay":
      tone = "warning";
      text = "Metro delay · platform capacity reduced to 45%";
      break;
    case "elevated_risk":
      tone = "warning";
      text = `Density rising in Southeast Concourse · ${RISK_LABEL[level]}`;
      break;
    case "critical_forecast":
    case "recommendation_available":
      tone = "critical";
      text =
        unsafe === 0
          ? "Critical density now in Southeast Concourse"
          : `Critical congestion forecast · Southeast Concourse${unsafe !== null ? ` · unsafe in ${formatClock(unsafe)}` : ""}`;
      if (stage === "recommendation_available") text += recommendationStatus === "rejected" ? " · recommendation rejected" : " · response ready";
      break;
    case "intervention_approved":
      tone = "info";
      text = "Intervention active · pedestrians rerouting";
      break;
    default:
      break;
  }
  if (!tone) return null;
  return (
    <div
      className={cn(
        "pointer-events-none flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium backdrop-blur-md",
        tone === "critical" && "border-vermilion/70 bg-[#2a1210]/85 text-vermilion-text",
        tone === "warning" && "border-signal/40 bg-void/80 text-signal-text",
        tone === "info" && "border-ti-edge bg-void/80 text-warm",
      )}
    >
      <span aria-hidden>{tone === "critical" ? "▲" : tone === "warning" ? "◆" : "↻"}</span>
      {text}
    </div>
  );
}

function StabilizedNotice() {
  const stage = useTwinStore((s) => s.snapshot?.stage);
  const epoch = useTwinStore((s) => s.snapshot?.epoch);
  const dismissed = useTwinStore((s) => s.dismissedStabilizedEpoch);
  const dismiss = useTwinStore((s) => s.dismissStabilized);
  if (stage !== "stabilized" || dismissed === epoch) return null;
  return (
    <div className="flex items-center gap-3 rounded-md border border-mineral/40 bg-void/85 px-3 py-2 backdrop-blur-md">
      <CircleCheck size={16} className="text-mineral-text" aria-hidden />
      <div className="leading-tight">
        <p className="text-sm font-medium text-warm">Risk stabilized</p>
        <p className="text-[11px] text-ti-text">Southeast Concourse back within normal density</p>
      </div>
      <button type="button" onClick={dismiss} className="ml-2 grid h-7 w-7 place-items-center rounded text-ti-dim hover:text-warm" aria-label="Dismiss">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}

function Legend() {
  const levels: RiskLevel[] = ["normal", "elevated", "high", "critical"];
  return (
    <div className="pointer-events-none rounded-md border border-ti-line bg-void/75 px-3 py-2 text-[10px] text-ti-text backdrop-blur-md">
      <div className="flex gap-3">
        {levels.map((l) => (
          <span key={l} className="flex items-center gap-1">
            <span style={{ color: RISK_COLOR[l] }} aria-hidden>
              {RISK_GLYPH[l]}
            </span>
            {RISK_LABEL[l]}
          </span>
        ))}
      </div>
      <div className="mt-1.5 flex gap-3">
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2 w-2 rounded-full bg-silver" /> Pedestrian
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="h-2 w-3 border border-ti-mid bg-ti-mid/20" /> Forecast volume
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="w-4 border-t-2 border-dashed border-warm" /> Proposed
        </span>
        <span className="flex items-center gap-1">
          <span aria-hidden className="w-4 border-t-2 border-mineral" /> Active route
        </span>
      </div>
    </div>
  );
}

function HorizonBadge() {
  const horizon = useTwinStore((s) => s.horizon);
  const previewing = useTwinStore((s) => !s.snapshot?.activePlan && Boolean(s.snapshot?.recommendation));
  return (
    <div className="pointer-events-none rounded-md border border-ti-line bg-void/75 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-ti-text backdrop-blur-md">
      {horizon === 0 ? "Showing now" : `Forecast +${horizon} min`}
      {previewing && horizon !== 0 ? " · with selected response" : ""}
    </div>
  );
}

export function VenueStage({ tier, reducedMotion, className }: { tier: ViewportTier; reducedMotion: boolean; className?: string }) {
  const webgl = hasWebGL();
  const mobile = tier === "mobile";
  return (
    <div className={cn("relative overflow-hidden", className)}>
      {webgl ? (
        <CanvasBoundary fallback={<Fallback reason="The 3D renderer failed to start on this device." />}>
          <Suspense fallback={<div className="grid h-full place-items-center text-xs text-ti-dim">Loading venue model…</div>}>
            <VenueCanvas tier={tier} reducedMotion={reducedMotion} />
          </Suspense>
        </CanvasBoundary>
      ) : (
        <Fallback reason="WebGL is not available in this browser." />
      )}
      <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col items-center gap-2">
        {!mobile && <IncidentStrip />}
        <div className="pointer-events-auto">
          <StabilizedNotice />
        </div>
      </div>
      {!mobile && (
        <div className="absolute bottom-3 left-3 flex flex-col items-start gap-2">
          <HorizonBadge />
          <Legend />
        </div>
      )}
    </div>
  );
}
