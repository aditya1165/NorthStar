import * as Tabs from "@radix-ui/react-tabs";
import { Check, ShieldCheck } from "lucide-react";

import { cn } from "../lib/cn";
import { useOperatorStore } from "../stores/operator";
import type { InterventionResult } from "../types/contracts";

type Props = {
  interventions: InterventionResult[];
  onApprove: (id: string) => void;
  pending: boolean;
};

export function InterventionPanel({ interventions, onApprove, pending }: Props) {
  const { selectedIntervention, setSelectedIntervention } = useOperatorStore();
  const recommended = interventions.find((item) => item.recommended);
  const selected = interventions.find((item) => item.intervention_id === selectedIntervention) ?? recommended ?? interventions[0];

  if (!selected) return null;

  return (
    <section className="panel p-4 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Counterfactual analysis</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Intervention comparison</h2>
        </div>
        {recommended && (
          <div className="flex items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
            <ShieldCheck size={15} /> Recommendation ready
          </div>
        )}
      </div>
      <Tabs.Root
        className="mt-4"
        value={selected.intervention_id}
        onValueChange={setSelectedIntervention}
      >
        <Tabs.List className="grid gap-2 md:grid-cols-4" aria-label="Intervention candidates">
          {interventions.map((item) => (
            <Tabs.Trigger
              key={item.intervention_id}
              value={item.intervention_id}
              className={cn(
                "rounded-xl border border-slate-700/70 bg-slate-900/50 p-3 text-left text-xs text-slate-300 transition hover:border-cyan-400/40 data-[state=active]:border-cyan-400 data-[state=active]:bg-cyan-400/8",
                item.recommended && "ring-1 ring-emerald-400/40",
              )}
            >
              <span className="font-semibold text-white">{item.name}</span>
              <span className="mt-2 block text-slate-500">Peak {item.peak_density.toFixed(1)} people/m²</span>
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto]">
          <div>
            <p className="text-sm leading-6 text-slate-300">{selected.explanation}</p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Risk reduction" value={`${selected.risk_reduction_percent}%`} />
              <Stat label="Clearance" value={`${selected.clearance_time_minutes} min`} />
              <Stat label="Redirected" value={selected.people_redirected.toLocaleString()} />
              <Stat label="Extra walk" value={`${selected.extra_walk_meters_mean} m`} />
            </div>
          </div>
          <button
            className="button-primary self-end disabled:cursor-not-allowed disabled:opacity-40"
            disabled={pending || selected.intervention_id === "do-nothing"}
            onClick={() => onApprove(selected.intervention_id)}
          >
            <Check size={17} /> Approve action
          </button>
        </div>
      </Tabs.Root>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-900/60 p-3">
      <p className="text-[10px] uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

