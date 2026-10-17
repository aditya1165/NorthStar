import { Activity, Gauge, Shield, Users } from "lucide-react";

import { ControlPanel } from "./components/ControlPanel";
import { ForecastPanel } from "./components/ForecastPanel";
import { InterventionPanel } from "./components/InterventionPanel";
import { MetricCard } from "./components/MetricCard";
import { VenueMap } from "./components/VenueMap";
import { api } from "./lib/api";
import { useDashboardData } from "./hooks/useDashboardData";

export default function App() {
  const { state, forecasts, interventions, action } = useDashboardData();

  if (state.isLoading) {
    return <main className="grid min-h-screen place-items-center text-slate-300">Loading operations console…</main>;
  }
  if (state.isError || !state.data) {
    return (
      <main className="grid min-h-screen place-items-center p-8 text-center text-slate-300">
        <div><h1 className="text-xl font-semibold text-white">Backend unavailable</h1><p className="mt-2 text-sm text-slate-400">Start the FastAPI service on port 8000 and refresh this page.</p></div>
      </main>
    );
  }

  const snapshot = state.data;
  const totalPeople = snapshot.zones.reduce((sum, zone) => sum + zone.people_count, 0);
  const highestRisk = [...snapshot.zones].sort((a, b) => b.density_estimate - a.density_estimate)[0];
  const totalQueue = snapshot.zones.reduce((sum, zone) => sum + zone.queue_length, 0);
  const run = (operation: () => Promise<unknown>) => action.mutate(operation);

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-800/80 bg-slate-950/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-cyan-400/10 p-2 text-cyan-300"><Shield size={24} /></div>
            <div><h1 className="font-semibold tracking-tight text-white">CrowdGuardian</h1><p className="text-xs text-slate-500">World Cup Stadium · Operations Center</p></div>
          </div>
          <div className="flex items-center gap-2 text-xs text-emerald-300"><span className="h-2 w-2 rounded-full bg-emerald-400" /> System operational</div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-4 p-5 lg:p-8">
        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="People monitored" value={totalPeople.toLocaleString()} detail="Anonymous zone aggregates" icon={Users} />
          <MetricCard label="Highest density" value={`${highestRisk?.density_estimate.toFixed(1) ?? "0.0"} /m²`} detail={highestRisk?.name ?? "No active zones"} icon={Gauge} />
          <MetricCard label="Total queue" value={totalQueue.toLocaleString()} detail="Across all monitored zones" icon={Activity} />
          <MetricCard label="Forecast horizon" value="10 min" detail="Updated from live telemetry" icon={Shield} />
        </section>

        <section className="grid gap-4 xl:grid-cols-[1.55fr_0.9fr_0.72fr]">
          <VenueMap zones={snapshot.zones} />
          <ForecastPanel forecasts={forecasts.data ?? []} />
          <ControlPanel state={snapshot} run={run} pending={action.isPending} />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <InterventionPanel
            interventions={interventions.data ?? []}
            pending={action.isPending}
            onApprove={(id) => run(() => api.approveIntervention(id))}
          />
        </section>
      </main>
    </div>
  );
}

