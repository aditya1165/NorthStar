import { CirclePause, Play, RotateCcw, Siren, StepForward, TrainFront } from "lucide-react";

import { api } from "../lib/api";
import type { SimulationSnapshot } from "../types/contracts";

type Props = {
  state: SimulationSnapshot;
  run: (operation: () => Promise<unknown>) => void;
  pending: boolean;
};

export function ControlPanel({ state, run, pending }: Props) {
  return (
    <aside className="panel p-4">
      <p className="eyebrow">Operator controls</p>
      <h2 className="mt-1 text-lg font-semibold text-white">Scenario console</h2>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button className="button-secondary" disabled={pending} onClick={() => run(api.start)}><Play size={16} /> Start</button>
        <button className="button-secondary" disabled={pending} onClick={() => run(api.pause)}><CirclePause size={16} /> Pause</button>
        <button className="button-secondary" disabled={pending} onClick={() => run(api.step)}><StepForward size={16} /> Step</button>
        <button className="button-secondary" disabled={pending} onClick={() => run(api.reset)}><RotateCcw size={16} /> Reset</button>
      </div>
      <div className="mt-5 space-y-2 border-t border-slate-800 pt-5">
        <button
          className="incident-button"
          disabled={pending}
          onClick={() => run(() => api.setIncident("gate-b-closure", !state.incidents.gate_b_closed))}
        >
          <Siren size={17} className="text-orange-300" />
          <span><strong>Gate B closure</strong><small>{state.incidents.gate_b_closed ? "Active" : "Inactive"}</small></span>
          <span className={state.incidents.gate_b_closed ? "status-on" : "status-off"} />
        </button>
        <button
          className="incident-button"
          disabled={pending}
          onClick={() => run(() => api.setIncident("metro-delay", !state.incidents.metro_delayed))}
        >
          <TrainFront size={17} className="text-cyan-300" />
          <span><strong>Metro delay</strong><small>{state.incidents.metro_delayed ? "Active" : "Inactive"}</small></span>
          <span className={state.incidents.metro_delayed ? "status-on" : "status-off"} />
        </button>
      </div>
      <div className="mt-5 rounded-xl bg-slate-900/60 p-3 text-xs text-slate-400">
        <div className="flex justify-between"><span>Simulation</span><strong className="capitalize text-slate-200">{state.status}</strong></div>
        <div className="mt-2 flex justify-between"><span>Elapsed</span><strong className="text-slate-200">{state.elapsed_minutes.toFixed(1)} min</strong></div>
        <div className="mt-2 flex justify-between"><span>Active action</span><strong className="max-w-28 truncate text-slate-200">{state.active_intervention ?? "None"}</strong></div>
      </div>
    </aside>
  );
}

