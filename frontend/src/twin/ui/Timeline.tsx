import { Crosshair, DoorClosed, TrainFront } from "lucide-react";
import { useMemo } from "react";
import { Area, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { DENSITY_THRESHOLDS, formatClock, levelForDensity, RISK_LABEL } from "../domain/risk";
import { useTwinStore } from "../state/twinStore";
import { PALETTE, RISK_COLOR } from "./palette";
import { RISK_GLYPH, SectionTitle } from "./primitives";

interface Row {
  minute: number;
  observed?: number;
  forecast?: number;
  band?: [number, number];
}

const EVENT_LABEL: Record<string, string> = {
  gateBClosedAt: "Gate B",
  metroDelayedAt: "Metro",
  criticalForecastAt: "Forecast",
  approvedAt: "Approved",
  stabilizedAt: "Stable",
};

function ChartTooltip({ active, payload }: { active?: boolean; payload?: { payload: Row }[] }) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const value = row.observed ?? row.forecast;
  if (value === undefined) return null;
  const level = levelForDensity(value);
  return (
    <div className="rounded-md border border-ti-edge bg-void/95 px-2.5 py-1.5 text-[11px] shadow-xl">
      <div className="cg-num text-ti-dim">T+{formatClock(row.minute)}</div>
      <div className="mt-0.5 text-warm">
        <span className="cg-num">{value.toFixed(2)}</span> p/m² · {row.observed !== undefined ? "observed" : "forecast"}
      </div>
      <div style={{ color: RISK_COLOR[level] }}>
        {RISK_GLYPH[level]} {RISK_LABEL[level]}
      </div>
      {row.band && row.observed === undefined && (
        <div className="cg-num text-ti-dim">
          range {row.band[0].toFixed(1)}–{row.band[1].toFixed(1)}
        </div>
      )}
    </div>
  );
}

export function RiskTimeline({ height = 150 }: { height?: number }) {
  const history = useTwinStore((s) => s.snapshot?.history);
  const projection = useTwinStore((s) => s.snapshot?.projection);
  const minute = useTwinStore((s) => s.snapshot?.minute ?? 0);
  const duration = useTwinStore((s) => s.snapshot?.duration ?? 24);
  const events = useTwinStore((s) => s.snapshot?.events);

  const data = useMemo(() => {
    const rows = new Map<number, Row>();
    for (const p of history ?? []) rows.set(p.minute, { minute: p.minute, observed: p.density });
    for (const p of projection ?? []) {
      const row = rows.get(p.minute) ?? { minute: p.minute };
      row.forecast = p.density;
      if (p.low !== undefined && p.high !== undefined) row.band = [p.low, p.high];
      rows.set(p.minute, row);
    }
    return [...rows.values()].sort((a, b) => a.minute - b.minute);
  }, [history, projection]);

  const markers = Object.entries(EVENT_LABEL).flatMap(([key, label]) => {
    const at = events?.[key as keyof typeof events];
    return typeof at === "number" ? [{ key, label, at }] : [];
  });

  return (
    <figure className="min-w-0">
      <figcaption className="sr-only">
        Southeast Concourse density over time, observed up to now and forecast for the next 10 minutes, with thresholds for elevated (2.5), high (3.5) and
        critical (4.5) people per square metre.
      </figcaption>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 14, right: 46, bottom: 0, left: -18 }}>
            <XAxis
              dataKey="minute"
              type="number"
              domain={[0, Math.max(duration, minute + 10)]}
              ticks={[0, 4, 8, 12, 16, 20, 24, 28, 32].filter((t) => t <= Math.max(duration, minute + 10))}
              tickFormatter={(v: number) => `${v}m`}
              tick={{ fill: PALETTE.titaniumText, fontSize: 10 }}
              axisLine={{ stroke: "#2a2a2e" }}
              tickLine={false}
            />
            <YAxis domain={[0, 6]} ticks={[0, 2, 4, 6]} tick={{ fill: PALETTE.titaniumText, fontSize: 10 }} axisLine={false} tickLine={false} />
            {(["elevated", "high", "critical"] as const).map((level) => (
              <ReferenceLine
                key={level}
                y={DENSITY_THRESHOLDS[level]}
                stroke={RISK_COLOR[level]}
                strokeOpacity={level === "critical" ? 0.7 : 0.35}
                strokeDasharray="2 4"
                label={{ value: RISK_LABEL[level], position: "right", fill: PALETTE.titaniumText, fontSize: 9 }}
              />
            ))}
            {markers.map((m, i) => (
              <ReferenceLine
                key={m.key}
                x={m.at}
                stroke="#3a3a3f"
                label={{ value: m.label, position: "insideTopLeft", fill: PALETTE.titaniumText, fontSize: 9, offset: 4, dy: i % 2 === 1 ? 11 : 0 }}
              />
            ))}
            <Area dataKey="band" stroke="none" fill={PALETTE.violet} fillOpacity={0.16} isAnimationActive={false} connectNulls />
            <Line dataKey="forecast" stroke={PALETTE.violet} strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />
            <Line dataKey="observed" stroke={PALETTE.warmWhite} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            <ReferenceLine x={minute} stroke={PALETTE.warmWhite} strokeOpacity={0.6} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#5a5a60", strokeWidth: 1 }} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-1 flex items-center gap-4 pl-6 text-[10px] text-ti-text">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-[2px] w-4 bg-warm" /> Observed
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="h-[2px] w-4 border-t-2 border-dashed border-violet" /> Forecast &amp; range
        </span>
      </div>
    </figure>
  );
}

export function ScenarioTriggers({ className }: { className?: string }) {
  const events = useTwinStore((s) => s.snapshot?.events);
  const status = useTwinStore((s) => s.snapshot?.status);
  const { triggerIncident, jumpToIncident } = useTwinStore.getState();
  const done = status === "complete";
  return (
    <div className={className} role="group" aria-label="Scenario triggers">
      <button type="button" className="cg-btn" disabled={events?.gateBClosedAt !== null || done} onClick={() => triggerIncident("gate_b_closure")}>
        <DoorClosed size={14} aria-hidden /> {events?.gateBClosedAt !== null ? "Gate B closed" : "Close Gate B"}
      </button>
      <button type="button" className="cg-btn" disabled={events?.metroDelayedAt !== null || done} onClick={() => triggerIncident("metro_delay")}>
        <TrainFront size={14} aria-hidden /> {events?.metroDelayedAt !== null ? "Metro delayed" : "Metro delay"}
      </button>
      <button type="button" className="cg-btn" onClick={jumpToIncident}>
        <Crosshair size={14} aria-hidden /> Jump to incident
      </button>
    </div>
  );
}

export function TimelinePanel() {
  return (
    <section aria-label="Timeline" className="flex min-w-0 flex-col gap-2 p-4">
      <SectionTitle aside={<span className="text-[10px] text-ti-dim">Southeast Concourse · p/m²</span>}>Timeline</SectionTitle>
      <RiskTimeline height={168} />
      <ScenarioTriggers className="mt-auto flex flex-wrap gap-1.5" />
    </section>
  );
}
