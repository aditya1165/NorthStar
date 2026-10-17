import type React from "react";
import { AlertTriangle, Check, CircleCheck, Accessibility, Pencil, X } from "lucide-react";

import { cn } from "../../lib/cn";
import { formatClock, STAGE_LABEL } from "../domain/risk";
import type { InterventionOption } from "../domain/types";
import { selectedIntervention, useTwinStore } from "../state/twinStore";
import { RiskTag, SectionTitle } from "./primitives";

function useDecision() {
  const recommendation = useTwinStore((s) => s.snapshot?.recommendation ?? null);
  const activePlan = useTwinStore((s) => s.snapshot?.activePlan ?? null);
  const stage = useTwinStore((s) => s.snapshot?.stage ?? "normal");
  const options = useTwinStore((s) => s.snapshot?.interventions ?? []);
  const selected = useTwinStore(selectedIntervention);
  const modifying = useTwinStore((s) => s.modifying);
  return { recommendation, activePlan, stage, options, selected, modifying };
}

function Flags({ option }: { option: InterventionOption }) {
  const o = option.outcome;
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px]">
      <span className={cn("inline-flex items-center gap-1", o.accessibleRoutesPreserved ? "text-ti-text" : "text-signal-text")}>
        <Accessibility size={11} aria-hidden />
        {o.accessibleRoutesPreserved ? "Step-free kept" : "Step-free route lost"}
      </span>
      {o.secondaryBottleneck && (
        <span className="inline-flex items-center gap-1 text-signal-text">
          <AlertTriangle size={11} aria-hidden /> Secondary bottleneck
        </span>
      )}
    </span>
  );
}

function OptionRow({ option, selected, locked, active }: { option: InterventionOption; selected: boolean; locked: boolean; active: boolean }) {
  const select = useTwinStore((s) => s.selectIntervention);
  const o = option.outcome;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={locked && !selected}
      onClick={() => select(option.id)}
      className={cn(
        "grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5 text-left transition-colors md:grid-cols-(--cg-option-cols)",
        selected ? "border-ti-mid bg-[#202023]" : "border-ti-line bg-void/30 hover:border-ti-edge",
        locked && !selected && "opacity-45",
      )}
    >
      <span
        aria-hidden
        className={cn("grid h-3.5 w-3.5 place-items-center rounded-full border", selected ? "border-warm" : "border-ti-mid")}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-warm" />}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium text-warm">{option.name}</span>
          {option.recommended && (
            <span className="rounded-[3px] border border-mineral/50 px-1 text-[9px] font-semibold uppercase tracking-wider text-mineral-text">
              Recommended
            </span>
          )}
          {active && (
            <span className="rounded-[3px] bg-mineral/20 px-1 text-[9px] font-semibold uppercase tracking-wider text-mineral-text">Active</span>
          )}
        </span>
        <span className="mt-0.5 block">
          <Flags option={option} />
        </span>
      </span>
      <span className="text-right md:text-left">
        <span className="whitespace-nowrap">
          <span className="cg-num text-xs text-warm">{o.peakDensity.toFixed(1)}</span>{" "}
          <RiskTag level={o.peakLevel} className="text-[10px]" />
        </span>
      </span>
      <Stat label="Risk Δ" value={o.riskReductionPercent === 0 ? "0%" : `−${o.riskReductionPercent}%`} />
      <Stat label="Clearance" value={`${o.clearanceMinutes} min`} />
      <Stat label="Moved · walk" value={o.extraWalkMeters ? `${o.peopleRedirected.toLocaleString()} · +${o.extraWalkMeters}m` : "—"} />
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="hidden md:block" aria-label={`${label}: ${value}`}>
      <span className="cg-num text-xs whitespace-nowrap text-warm">{value}</span>
    </span>
  );
}

const COLUMN_STYLE = { "--cg-option-cols": "14px minmax(0,1.7fr) minmax(0,0.8fr) minmax(0,0.5fr) minmax(0,0.55fr) minmax(0,0.9fr)" } as React.CSSProperties;

export function InterventionList() {
  const { options, selected, activePlan, stage, recommendation } = useDecision();
  if (options.length === 0) {
    return (
      <div className="grid h-full min-h-28 place-items-center rounded-md border border-dashed border-ti-line p-4 text-center">
        <p className="max-w-sm text-xs text-ti-dim">
          {stage === "critical_forecast"
            ? "Critical congestion forecast. Evaluating candidate responses…"
            : "Monitoring. Candidate responses are evaluated once a critical forecast is confirmed."}
        </p>
      </div>
    );
  }
  return (
    <div role="radiogroup" aria-label="Candidate responses" className="space-y-1" style={COLUMN_STYLE}>
      <div aria-hidden className="hidden grid-cols-(--cg-option-cols) gap-x-3 px-3 text-[9px] font-medium uppercase tracking-[0.14em] text-ti-dim md:grid">
        <span />
        <span>Response</span>
        <span>Peak p/m²</span>
        <span>Risk Δ</span>
        <span>Clearance</span>
        <span>Moved · walk</span>
      </div>
      {options.map((o) => (
        <OptionRow
          key={o.id}
          option={o}
          selected={selected?.id === o.id}
          locked={Boolean(activePlan) || !recommendation}
          active={activePlan?.interventionId === o.id}
        />
      ))}
    </div>
  );
}

export function DecisionPanel({ className }: { className?: string }) {
  const { recommendation, activePlan, stage, options, selected, modifying } = useDecision();
  const minute = useTwinStore((s) => s.snapshot?.minute ?? 0);
  const stabilizedAt = useTwinStore((s) => s.snapshot?.events.stabilizedAt ?? null);
  const { approve, modify, cancelModify, reject } = useTwinStore.getState();
  const recommended = options.find((o) => o.recommended);

  if (activePlan) {
    const plan = options.find((o) => o.id === activePlan.interventionId);
    return (
      <div className={cn("space-y-2", className)}>
        <p className="cg-label">Decision</p>
        <div className="flex items-start gap-2">
          <CircleCheck size={16} className="mt-0.5 shrink-0 text-mineral-text" aria-hidden />
          <div>
            <p className="text-sm font-medium text-warm">{plan?.name}</p>
            <p className="text-xs text-ti-text">Approved at T+{formatClock(activePlan.approvedAt)}</p>
          </div>
        </div>
        <p className="text-xs leading-5 text-ti-text">
          {stabilizedAt !== null
            ? `Risk stabilized at T+${formatClock(stabilizedAt)}. Southeast Concourse back within normal density.`
            : `Intervention in progress · ${STAGE_LABEL[stage]}. Monitoring for ${Math.max(0, Math.round((minute - activePlan.approvedAt) * 60))} s.`}
        </p>
      </div>
    );
  }

  if (!recommendation) {
    return (
      <div className={cn("space-y-2", className)}>
        <p className="cg-label">Decision</p>
        <p className="text-xs leading-5 text-ti-dim">No operator decision required. A recommendation will appear here when a critical forecast is confirmed.</p>
      </div>
    );
  }

  const isRecommended = selected?.id === recommendation.interventionId;
  const rejected = recommendation.status === "rejected";
  const canApprove = Boolean(selected && selected.id !== "do_nothing");

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div>
        <p className="cg-label">{modifying ? "Modify response" : rejected ? "Recommendation rejected" : "Recommended response"}</p>
        <p className={cn("mt-1.5 text-sm leading-5", rejected ? "text-ti-dim line-through decoration-ti-mid" : "text-warm")}>
          {recommended?.name}
        </p>
        <p className="mt-1 text-xs leading-5 text-ti-text">
          {modifying
            ? "Select a different response in the comparison, then approve it."
            : rejected
              ? "Situation still monitored. You may select and approve any response."
              : recommendation.rationale}
        </p>
      </div>
      {selected && !isRecommended && (
        <p className="rounded-md border border-ti-line bg-void/40 px-2.5 py-1.5 text-[11px] text-ti-text">
          Selected: <span className="text-warm">{selected.name}</span>
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-2">
        <button type="button" className="cg-btn-primary flex-1 whitespace-nowrap" disabled={!canApprove} onClick={approve}>
          <Check size={16} aria-hidden /> {isRecommended ? "Approve" : "Approve choice"}
        </button>
        {modifying ? (
          <button type="button" className="cg-btn-ghost" onClick={cancelModify}>
            Cancel
          </button>
        ) : (
          <button type="button" className="cg-btn-ghost" onClick={modify} aria-label="Modify response">
            <Pencil size={14} aria-hidden /> Modify
          </button>
        )}
        <button type="button" className="cg-btn-ghost" onClick={reject} disabled={rejected} aria-label="Reject recommendation">
          <X size={14} aria-hidden /> Reject
        </button>
      </div>
      {!canApprove && selected?.id === "do_nothing" && <p className="text-[11px] text-ti-dim">“Do nothing” requires no approval.</p>}
    </div>
  );
}

export function InterventionPanelSection() {
  const modifying = useTwinStore((s) => s.modifying);
  return (
    <section aria-label="Intervention comparison" className="grid min-w-0 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className={cn("min-w-0 space-y-2 rounded-md", modifying && "outline outline-1 outline-offset-4 outline-violet/50")}>
        <SectionTitle aside={<span className="text-[10px] text-ti-dim">Mock outcomes · 15-min rollout</span>}>Intervention comparison</SectionTitle>
        <InterventionList />
      </div>
      <DecisionPanel className="border-t border-ti-line pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4" />
    </section>
  );
}
