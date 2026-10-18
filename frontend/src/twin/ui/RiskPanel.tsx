import { DoorClosed, DoorOpen, TrainFront } from "lucide-react";

import { cn } from "../../lib/cn";
import { mostSevereCongestion } from "../congestion/types";
import { formatClock, RISK_LABEL } from "../domain/risk";
import type { ZoneId } from "../domain/types";
import { useTwinStore } from "../state/twinStore";
import { HorizonControl, LevelMeter, RiskTag, riskTextClass, SectionTitle } from "./primitives";

function useZoneName() {
  const venue = useTwinStore((s) => s.venue);
  return (id: ZoneId) => venue?.zones.find((z) => z.id === id)?.label ?? id;
}

function Metric({ label, value, unit, detail, tone }: { label: string; value: string; unit?: string; detail?: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-ti-line bg-void/40 px-3 py-2.5">
      <dt className="cg-label">{label}</dt>
      <dd className="mt-1.5">
        <span className={cn("cg-num text-xl leading-none text-warm", tone)}>{value}</span>
        {unit && <span className="ml-1 text-[11px] text-ti-dim">{unit}</span>}
        {detail && <span className="mt-1 block truncate text-[11px] text-ti-text">{detail}</span>}
      </dd>
    </div>
  );
}

function useLiveForecast(h: 5 | 10) {
  const forecasts = useTwinStore((s) => s.congestion?.forecasts);
  const zones = useTwinStore((s) => s.congestion?.zones);
  if (!forecasts || forecasts.length === 0) return null;
  const atHorizon = forecasts.filter((f) => f.horizonMinutes === h);
  if (atHorizon.length === 0) return null;
  const peak = atHorizon.reduce((a, b) => (b.predictedDensity > a.predictedDensity ? b : a));
  const times = forecasts.map((f) => f.timeToCongestionMinutes).filter((t): t is number => t !== null);
  return {
    density: peak.predictedDensity,
    level: peak.level,
    zone: zones?.find((z) => z.zoneId === peak.zoneId)?.name ?? peak.zoneId,
    method: peak.method,
    minutesToCongestion: times.length ? Math.min(...times) : null,
  };
}

export function RiskSummaryBlock() {
  const risk = useTwinStore((s) => s.snapshot?.risk);
  const detected = useTwinStore((s) => mostSevereCongestion(s.congestion));
  const horizon = useTwinStore((s) => s.horizon);
  const zoneName = useZoneName();
  const h = horizon === 0 ? 10 : horizon;
  const live = useLiveForecast(h);
  if (!risk) return null;
  const peak = live
    ? { density: live.density, level: live.level, label: `${RISK_LABEL[live.level]} · ${live.zone} · ${live.method === "gbm" ? "GBM" : "baseline"}` }
    : { density: risk.predictedPeak[h].density, level: risk.predictedPeak[h].level, label: `${RISK_LABEL[risk.predictedPeak[h].level]} · ${zoneName(risk.predictedPeak[h].zoneId)}` };
  const unsafe = live ? live.minutesToCongestion : risk.minutesToUnsafe;
  const unsafeThreshold = live ? "Density ≥ 3.2 p/m²" : "Density ≥ 4.5 p/m²";
  const currentLevel = detected?.level ?? risk.level;
  const currentDensity = detected?.densityPerM2 ?? risk.hotspotDensity;
  const currentLocation = detected?.label ?? zoneName(risk.hotspotZoneId);

  return (
    <section aria-labelledby="risk-current" className="space-y-3">
      <div className="rounded-md border border-ti-line bg-void/40 px-3 py-3">
        <div className="flex items-baseline justify-between">
          <span id="risk-current" className="cg-label">{detected ? "Backend detection" : "Current risk"}</span>
          <span className="text-[11px] text-ti-text">{currentLocation}</span>
        </div>
        <div className="mt-2 flex items-end justify-between gap-3">
          <RiskTag level={currentLevel} className="text-2xl tracking-tight" />
          <span className="cg-num text-sm text-ti-text">
            {currentDensity.toFixed(1)} <span className="text-[11px] text-ti-dim">p/m²</span>
          </span>
        </div>
        <LevelMeter level={currentLevel} className="mt-3" />
        {detected && <p className="mt-2 text-[11px] text-ti-text">Queue {detected.queueLength} · mean speed {detected.meanSpeedMps.toFixed(1)} m/s</p>}
      </div>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3 xl:grid-cols-1 2xl:grid-cols-3">
        <Metric
          label={`Predicted peak · ${h} min`}
          value={peak.density.toFixed(1)}
          unit="p/m²"
          detail={peak.label}
          tone={riskTextClass(peak.level)}
        />
        <Metric
          label={live ? "Until congested" : "Until unsafe"}
          value={unsafe === null ? "—" : unsafe === 0 ? "Now" : formatClock(unsafe)}
          unit={unsafe ? "min" : undefined}
          detail={unsafe === null ? "Not forecast" : unsafe === 0 ? `Above ${live ? "3.2" : "4.5"} p/m²` : unsafeThreshold}
          tone={unsafe !== null ? "text-vermilion-text" : undefined}
        />
        <Metric label="Est. clearance" value={String(risk.clearanceMinutes)} unit="min" detail="Until venue is clear" />
      </dl>
    </section>
  );
}

export function FactorsBlock() {
  const factors = useTwinStore((s) => s.snapshot?.risk.factors ?? []);
  return (
    <section className="space-y-2">
      <SectionTitle>Top contributing factors</SectionTitle>
      {factors.length === 0 ? (
        <p className="text-xs text-ti-dim">No significant contributors. Egress within normal parameters.</p>
      ) : (
        <ul className="space-y-2">
          {factors.map((f) => (
            <li key={f.id}>
              <div className="flex justify-between gap-3 text-xs">
                <span className="text-warm/90">{f.label}</span>
                <span className="cg-num shrink-0 text-ti-dim">{Math.round(f.weight * 100)}%</span>
              </div>
              <div className="mt-1 h-[3px] rounded-full bg-ti-line">
                <div className="h-full rounded-full bg-violet transition-[width] duration-500" style={{ width: `${f.weight * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function GateStatusBlock() {
  const gates = useTwinStore((s) => s.snapshot?.gates ?? []);
  const transit = useTwinStore((s) => s.snapshot?.transit);
  const venue = useTwinStore((s) => s.venue);
  const congestion = useTwinStore((s) => s.congestion);
  const connection = useTwinStore((s) => s.congestionConnection);
  const setGateStatus = useTwinStore((s) => s.setGateStatus);
  return (
    <section className="space-y-2">
      <SectionTitle>Gates &amp; transit</SectionTitle>
      <ul className="divide-y divide-ti-line rounded-md border border-ti-line">
        {gates.map((g) => {
          const closed = g.status === "closed";
          const detected = congestion?.gates.find((item) => item.gateId === g.id);
          const incident = closed || Boolean(detected?.congested);
          const Icon = closed ? DoorClosed : DoorOpen;
          return (
            <li key={g.id} className="flex items-center gap-2.5 px-3 py-2 text-xs">
              <Icon size={14} aria-hidden className={incident ? "text-signal-text" : closed ? "text-ti-dim" : "text-mineral-text"} />
              <span className="w-14 font-medium text-warm">{venue?.gates.find((v) => v.id === g.id)?.label}</span>
              <span className={cn("flex-1", incident ? "text-signal-text" : "text-ti-text")}>
                {detected?.congested ? `${g.note} · queue ${detected.queueLength}` : g.note}
              </span>
              <span className="cg-num text-ti-dim">{detected ? `${detected.densityPerM2.toFixed(1)} p/m²` : `${g.throughputPerMin}/min`}</span>
              <button
                type="button"
                className="cg-btn h-7 min-w-14 px-2 text-[10px]"
                onClick={() => setGateStatus(g.id, closed ? "open" : "closed")}
                aria-label={`${closed ? "Open" : "Close"} ${venue?.gates.find((v) => v.id === g.id)?.label}`}
              >
                {closed ? "Open" : "Close"}
              </button>
            </li>
          );
        })}
        {transit && (
          <li className="flex items-center gap-2.5 px-3 py-2 text-xs">
            <TrainFront size={14} aria-hidden className={transit.status === "delayed" ? "text-signal-text" : "text-ti-dim"} />
            <span className="w-14 font-medium text-warm">Metro</span>
            <span className={cn("flex-1", transit.status === "delayed" ? "text-signal-text" : "text-ti-text")}>
              {transit.status === "delayed" ? "Delayed · reduced platform capacity" : "On schedule"}
            </span>
            <span className="cg-num text-ti-dim">{Math.round(transit.capacityRatio * 100)}%</span>
          </li>
        )}
      </ul>
      <p className="text-[10px] uppercase tracking-[0.12em] text-ti-dim">
        Python detector · {connection === "connected" ? "live" : connection}
      </p>
    </section>
  );
}

export function ConfidenceBlock() {
  const confidence = useTwinStore((s) => s.snapshot?.risk.confidence ?? 0);
  const pct = Math.round(confidence * 100);
  return (
    <section className="space-y-2">
      <SectionTitle aside={<HorizonControl />}>Forecast horizon</SectionTitle>
      <div className="flex items-center gap-3">
        <span className="cg-label shrink-0">Data confidence</span>
        <div className="h-[3px] flex-1 rounded-full bg-ti-line" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Data confidence">
          <div className="h-full rounded-full bg-violet transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
        <span className="cg-num text-xs text-warm">{pct}%</span>
      </div>
      {pct < 80 && <p className="text-[11px] text-ti-dim">Confidence reduced while new incident data accumulates.</p>}
    </section>
  );
}

export function RiskPanel() {
  return (
    <aside aria-label="Risk intelligence" className="flex h-full flex-col gap-5 overflow-y-auto p-4">
      <RiskSummaryBlock />
      <ConfidenceBlock />
      <FactorsBlock />
      <GateStatusBlock />
    </aside>
  );
}
