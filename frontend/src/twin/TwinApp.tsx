import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { STAGE_LABEL } from "./domain/risk";
import type { CrowdTwinService } from "./services/CrowdTwinService";
import { MockTwinService } from "./services/MockTwinService";
import { useTwinStore } from "./state/twinStore";
import { Header, StageTrack } from "./ui/Header";
import { useReducedMotion, useViewportTier } from "./ui/hooks";
import { DecisionPanel, InterventionList, InterventionPanelSection } from "./ui/Interventions";
import { NavRail } from "./ui/NavRail";
import { PlaybackControls } from "./ui/Playback";
import { ConfidenceBlock, FactorsBlock, GateStatusBlock, RiskPanel, RiskSummaryBlock } from "./ui/RiskPanel";
import { RiskTimeline, ScenarioTriggers, TimelinePanel } from "./ui/Timeline";
import { IncidentStrip, VenueStage } from "./ui/VenueStage";

/** Announces stage changes to assistive technology. */
function LiveAnnouncer() {
  const stage = useTwinStore((s) => s.snapshot?.stage);
  return (
    <div aria-live="polite" role="status" className="sr-only">
      {stage ? `Scenario stage: ${STAGE_LABEL[stage]}` : ""}
    </div>
  );
}

function DesktopLayout({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <div className="cg-root grid h-screen min-h-[760px] grid-rows-[auto_minmax(0,1fr)] text-warm">
      <Header compact={false} />
      <div className="grid min-h-0 grid-cols-[56px_minmax(0,1fr)_minmax(340px,380px)] grid-rows-[minmax(0,1fr)_auto]">
        <div className="row-span-2">
          <NavRail />
        </div>
        <main className="min-h-0">
          <VenueStage tier="desktop" reducedMotion={reducedMotion} className="h-full" />
        </main>
        <div className="min-h-0 border-l border-ti-line bg-graphite/70">
          <RiskPanel />
        </div>
        <div className="col-span-2 grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.7fr)] border-t border-ti-line bg-graphite/80">
          <TimelinePanel />
          <div className="border-l border-ti-line">
            <InterventionPanelSection />
          </div>
        </div>
      </div>
    </div>
  );
}

function TabletLayout({ reducedMotion }: { reducedMotion: boolean }) {
  return (
    <div className="cg-root min-h-screen text-warm">
      <div className="sticky top-0 z-20">
        <Header compact={false} compactControls />
      </div>
      <div className="flex items-center justify-between gap-3 border-b border-ti-line px-4 py-2">
        <StageTrack />
        <NavRail orientation="horizontal" />
      </div>
      <main>
        <VenueStage tier="tablet" reducedMotion={reducedMotion} className="h-[58vh] min-h-[380px]" />
      </main>
      <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-ti-line bg-graphite/70 p-4">
        <RiskSummaryBlock />
        <div className="space-y-5">
          <ConfidenceBlock />
          <FactorsBlock />
        </div>
        <GateStatusBlock />
        <div className="space-y-2">
          <RiskTimeline height={130} />
          <ScenarioTriggers className="flex flex-wrap gap-1.5" />
        </div>
      </div>
      <div className="border-t border-ti-line bg-graphite/80">
        <InterventionPanelSection />
      </div>
    </div>
  );
}

function MobileDecisionBar() {
  const pending = useTwinStore((s) => s.snapshot?.recommendation?.status === "pending" && !s.snapshot?.activePlan);
  const { approve, reject } = useTwinStore.getState();
  if (!pending) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 flex gap-2 border-t border-ti-line bg-void/95 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur-md">
      <button type="button" className="cg-btn-primary h-12 flex-1" onClick={approve}>
        <Check size={18} aria-hidden /> Approve
      </button>
      <button type="button" className="cg-btn-ghost h-12 px-5" onClick={reject} aria-label="Reject recommendation">
        <X size={16} aria-hidden /> Reject
      </button>
    </div>
  );
}

function MobileLayout({ reducedMotion }: { reducedMotion: boolean }) {
  const [open, setOpen] = useState(false);
  const hasRecommendation = useTwinStore((s) => Boolean(s.snapshot?.recommendation || s.snapshot?.activePlan));
  return (
    <div className="cg-root min-h-screen pb-24 text-warm">
      <div className="sticky top-0 z-20">
        <Header compact />
      </div>
      <div className="space-y-3 px-3 pt-3">
        <IncidentStrip />
        {hasRecommendation && (
          <section aria-label="Recommended response" className="cg-surface rounded-lg p-3">
            <DecisionPanel />
          </section>
        )}
      </div>
      <main className="mt-3">
        <VenueStage tier="mobile" reducedMotion={reducedMotion} className="h-[46vh] min-h-[300px] border-y border-ti-line" />
      </main>
      <div className="space-y-4 px-3 pt-3">
        <PlaybackControls compact />
        <ScenarioTriggers className="flex flex-wrap gap-1.5" />
        <RiskSummaryBlock />
        <section className="rounded-lg border border-ti-line">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-3 text-xs font-medium text-ti-text"
            aria-expanded={open}
            aria-controls="mobile-details"
            onClick={() => setOpen((v) => !v)}
          >
            Forecast, factors, gates &amp; all responses
            <ChevronDown size={16} aria-hidden className={open ? "rotate-180 transition-transform" : "transition-transform"} />
          </button>
          {open && (
            <div id="mobile-details" className="space-y-5 border-t border-ti-line p-3">
              <ConfidenceBlock />
              <FactorsBlock />
              <GateStatusBlock />
              <RiskTimeline height={130} />
              <div className="space-y-2">
                <h2 className="cg-label">Intervention comparison</h2>
                <InterventionList />
              </div>
              <div className="space-y-2">
                <h2 className="cg-label">View</h2>
                <NavRail orientation="horizontal" />
              </div>
            </div>
          )}
        </section>
      </div>
      <MobileDecisionBar />
    </div>
  );
}

export default function TwinApp({ service }: { service?: CrowdTwinService }) {
  const connect = useTwinStore((s) => s.connect);
  const ready = useTwinStore((s) => Boolean(s.snapshot && s.venue));
  const tier = useViewportTier();
  const reducedMotion = useReducedMotion();
  const injected = useRef(service);

  useEffect(() => connect(injected.current ?? new MockTwinService()), [connect]);

  if (!ready) {
    return <div className="cg-root grid min-h-screen place-items-center text-xs text-ti-dim">Initialising digital twin…</div>;
  }

  return (
    <>
      <LiveAnnouncer />
      {tier === "desktop" && <DesktopLayout reducedMotion={reducedMotion} />}
      {tier === "tablet" && <TabletLayout reducedMotion={reducedMotion} />}
      {tier === "mobile" && <MobileLayout reducedMotion={reducedMotion} />}
    </>
  );
}
