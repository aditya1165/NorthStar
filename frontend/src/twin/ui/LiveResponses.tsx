import { AlertTriangle, Check, CircleCheck, Download, Loader2 } from "lucide-react";

import { cn } from "../../lib/cn";
import { formatClock, levelForDensity } from "../domain/risk";
import { exportRunUrl, type LiveCandidate } from "../live/api";
import { useTwinStore } from "../state/twinStore";
import { RiskTag, SectionTitle } from "./primitives";

function gateLabel(gateId: string | null) {
  return gateId ? `Gate ${gateId.replace("gate_", "").toUpperCase()}` : "—";
}

function CandidateRow({ candidate, selected, locked }: { candidate: LiveCandidate; selected: boolean; locked: boolean }) {
  const select = useTwinStore((s) => s.selectLive);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={locked || !candidate.feasible}
      onClick={() => select(candidate.interventionId)}
      className={cn(
        "grid w-full grid-cols-[14px_minmax(0,1.8fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,0.8fr)] items-center gap-x-3 rounded-md border px-3 py-1.5 text-left transition-colors",
        selected ? "border-ti-mid bg-[#202023]" : "border-ti-line bg-void/30 hover:border-ti-edge",
        (!candidate.feasible || (locked && !selected)) && "opacity-55",
      )}
    >
      <span aria-hidden className={cn("grid h-3.5 w-3.5 place-items-center rounded-full border", selected ? "border-warm" : "border-ti-mid")}>
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-warm" />}
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-xs font-medium text-warm">{candidate.name}</span>
          {candidate.recommended && (
            <span className="rounded-[3px] border border-mineral/50 px-1 text-[9px] font-semibold uppercase tracking-wider text-mineral-text">
              Recommended
            </span>
          )}
        </span>
        {candidate.feasible ? (
          <span className="block truncate text-[10px] text-ti-text">{candidate.summary}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[10px] text-signal-text">
            <AlertTriangle size={11} aria-hidden /> Rejected · {candidate.rejectionReason}
          </span>
        )}
      </span>
      <span className="whitespace-nowrap">
        <span className="cg-num text-xs text-warm">{candidate.maxQueue.toFixed(0)}</span>{" "}
        <span className="text-[10px] text-ti-dim">{gateLabel(candidate.maxQueueGate)}</span>
      </span>
      <span className="whitespace-nowrap">
        <span className="cg-num text-xs text-warm">{candidate.peakDensity.toFixed(1)}</span>{" "}
        <RiskTag level={levelForDensity(candidate.peakDensity)} className="text-[10px]" />
      </span>
      <span className="cg-num text-xs whitespace-nowrap text-warm" title={`range ${candidate.clearanceRange[0]}–${candidate.clearanceRange[1]} min`}>
        {candidate.clearanceMinutes.toFixed(1)} min
      </span>
      <span className="cg-num text-xs whitespace-nowrap text-warm">
        {candidate.riskReductionPercent > 0 ? `−${candidate.riskReductionPercent.toFixed(0)}%` : "0%"} ·{" "}
        {Math.round(candidate.peopleRedirected).toLocaleString()}
      </span>
    </button>
  );
}

/** Operator view of backend counterfactual rollouts, approval, and the active plan. */
export function LiveResponsePanel() {
  const runId = useTwinStore((s) => s.liveRunId);
  const evaluation = useTwinStore((s) => s.liveEvaluation);
  const status = useTwinStore((s) => s.liveEvaluationStatus);
  const error = useTwinStore((s) => s.liveEvaluationError);
  const selectedId = useTwinStore((s) => s.liveSelectedId);
  const plan = useTwinStore((s) => s.livePlan);
  const redirectSuspended = useTwinStore((s) => s.congestion?.routing?.redirectSuspended ?? false);
  const connection = useTwinStore((s) => s.congestionConnection);
  const approving = useTwinStore((s) => s.liveApprovalPending);
  const message = useTwinStore((s) => s.liveApprovalMessage);
  const redirected = useTwinStore((s) => s.congestion?.routing?.redirectedTotal ?? 0);
  const { selectLive, approveLive } = useTwinStore.getState();
  const chosenId = selectedId ?? evaluation?.recommendedId ?? null;
  const chosen = evaluation?.candidates.find((c) => c.interventionId === chosenId) ?? null;
  const evaluating = status === "evaluating";
  const locked = connection !== "connected" || approving;
  const disabledReason = connection !== "connected" ? "Connect to Python to review and approve routes." : !chosen ? "Waiting for an automatic evaluation of the current boundary gates." : !chosen.feasible ? chosen.rejectionReason : null;

  return (
    <section aria-label="Intervention comparison" className="grid min-w-0 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 space-y-2">
        <SectionTitle
          aside={
            <span className="text-[10px] text-ti-dim">
              {evaluation
                ? `Python rollouts · ${evaluation.seeds.length} seeds × ${evaluation.complianceLevels.length} compliance · ${evaluation.horizonMinutes} min`
                : `Python-issued assignments · ${redirected.toLocaleString()} people`}
            </span>
          }
        >
          Intervention comparison
        </SectionTitle>
        {evaluation ? (
          <div role="radiogroup" aria-label="Candidate responses" className="space-y-1">
            <div aria-hidden className="grid grid-cols-[14px_minmax(0,1.8fr)_minmax(0,0.8fr)_minmax(0,0.6fr)_minmax(0,0.8fr)_minmax(0,0.8fr)] gap-x-3 px-3 text-[9px] font-medium uppercase tracking-[0.14em] text-ti-dim">
              <span />
              <span>Response</span>
              <span>Max queue</span>
              <span>Peak p/m²</span>
              <span>Clearance</span>
              <span>Risk Δ · moved</span>
            </div>
            {evaluation.candidates.map((candidate) => (
              <CandidateRow key={candidate.interventionId} candidate={candidate} selected={chosenId === candidate.interventionId} locked={locked} />
            ))}
          </div>
        ) : (
          <div className="grid min-h-28 place-items-center rounded-md border border-dashed border-ti-line p-4 text-center">
            <p className="max-w-sm text-xs text-ti-dim">
              {evaluating
                ? "Running isolated counterfactual rollouts from the latest telemetry…"
                : "Start the simulation to evaluate boundary-gate congestion automatically."}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t border-ti-line pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-4">
        <p className="cg-label">Decision</p>
        {plan ? (
          <div className="flex items-start gap-2">
            <CircleCheck size={16} className="mt-0.5 shrink-0 text-mineral-text" aria-hidden />
            <div>
              <p className="text-sm font-medium text-warm">{plan.name}</p>
              <p className="text-xs text-ti-text">Approved at T+{formatClock(plan.approvedAtSeconds / 60)} · {redirectSuspended ? "reroute suspended after gate closure" : "executing via Python routing"}</p>
              {redirectSuspended && <p className="text-[11px] text-signal-text">Closed-gate escape remains active. Approve a new plan to resume optional rerouting.</p>}
              <ul className="mt-1 list-disc pl-4 text-[11px] text-ti-text">
                {plan.actions.map((action) => (
                  <li key={action}>{action}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : evaluation ? (
          <p className="text-xs leading-5 text-ti-text">{evaluation.rationale}</p>
        ) : (
          <p className="text-xs leading-5 text-ti-dim">Closed-gate detours happen automatically. You control gates A–H and approve optional congestion-management plans.</p>
        )}
        {chosen && (
          <div className="text-xs text-ti-text">
            <p className="font-medium text-warm">Proposed: {chosen.name}</p>
            <ul className="mt-1 list-disc pl-4">{chosen.actions.map((action) => <li key={action}>{action}</li>)}</ul>
          </div>
        )}
        <p role="status" className="text-[11px] text-ti-dim">
          {selectedId ? "Review pinned · this exact response stays selected until you approve or resume recommendations." : evaluating ? "Updating recommendations…" : evaluation ? "Automatic evaluation is up to date." : disabledReason}
        </p>
        {message && <p className="text-[11px] text-mineral-text">{message}</p>}
        {error && <p className="text-[11px] text-signal-text">{error}</p>}
        <div className="mt-auto flex flex-wrap gap-2">
          {selectedId && <button type="button" className="cg-btn" disabled={approving} onClick={() => selectLive(null)}>Resume recommendations</button>}
          {evaluation && (
            <button
              type="button"
              className="cg-btn-primary flex-1 whitespace-nowrap"
              disabled={locked || !chosen || !chosen.feasible}
              aria-describedby={disabledReason ? "approval-disabled-reason" : undefined}
              onClick={() => void approveLive()}
            >
              {approving ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Check size={16} aria-hidden />}
              {approving ? "Approving…" : chosen?.interventionId === "do_nothing" ? plan ? "Stop active plan" : "Keep current routes" : "Approve"}
            </button>
          )}
          {runId && (
            <a className="cg-btn-ghost" href={exportRunUrl(runId)} target="_blank" rel="noreferrer" aria-label="Export run">
              <Download size={14} aria-hidden />
            </a>
          )}
        </div>
        {disabledReason && evaluation && <p id="approval-disabled-reason" className="text-[11px] text-ti-dim">{disabledReason}</p>}
      </div>
    </section>
  );
}
