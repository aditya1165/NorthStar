import { AlertTriangle, Clock3 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { Forecast } from "../types/contracts";

export function ForecastPanel({ forecasts }: { forecasts: Forecast[] }) {
  const tenMinute = forecasts.filter((forecast) => forecast.horizon_minutes === 10);
  const highest = [...tenMinute].sort((a, b) => b.risk_probability - a.risk_probability)[0];

  return (
    <section className="panel p-4">
      <div className="flex items-start justify-between">
        <div>
          <p className="eyebrow">Predictive outlook</p>
          <h2 className="mt-1 text-lg font-semibold text-white">10-minute forecast</h2>
        </div>
        <Clock3 size={19} className="text-cyan-300" aria-hidden="true" />
      </div>
      {highest && highest.risk_probability >= 0.65 && (
        <div className="mt-4 rounded-xl border border-orange-400/25 bg-orange-400/8 p-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-orange-300">
            <AlertTriangle size={16} /> Congestion likely
          </div>
          <p className="mt-1 text-xs leading-5 text-slate-300">
            {highest.zone_id.replaceAll("_", " ")} has a {Math.round(highest.risk_probability * 100)}% risk probability.
          </p>
        </div>
      )}
      <div className="mt-4 h-52">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={tenMinute} margin={{ left: -20, right: 4 }}>
            <CartesianGrid stroke="#1e3446" vertical={false} />
            <XAxis dataKey="zone_id" tick={{ fill: "#64748b", fontSize: 9 }} tickFormatter={(value) => value.split("_")[0]} />
            <YAxis tick={{ fill: "#64748b", fontSize: 10 }} />
            <Tooltip contentStyle={{ background: "#0b1a2a", border: "1px solid #274057", borderRadius: 12 }} />
            <Bar dataKey="predicted_density" fill="#22d3ee" radius={[5, 5, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      {highest && (
        <div className="mt-2 flex flex-wrap gap-2">
          {highest.top_factors.map((factor) => (
            <span key={factor} className="rounded-full bg-slate-800 px-2.5 py-1 text-[11px] text-slate-300">
              {factor}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

