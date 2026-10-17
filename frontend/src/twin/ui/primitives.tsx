import type { ReactNode } from "react";

import { cn } from "../../lib/cn";
import { RISK_LABEL, riskRank } from "../domain/risk";
import { RISK_ORDER, type ForecastHorizon, type RiskLevel } from "../domain/types";
import { useTwinStore } from "../state/twinStore";
import { RISK_COLOR } from "./palette";

export const RISK_GLYPH: Record<RiskLevel, string> = { normal: "○", elevated: "◐", high: "◆", critical: "▲" };

const RISK_TEXT: Record<RiskLevel, string> = {
  normal: "text-mineral-text",
  elevated: "text-amber",
  high: "text-signal-text",
  critical: "text-vermilion-text",
};

export function riskTextClass(level: RiskLevel) {
  return RISK_TEXT[level];
}

/** Level shown as glyph + word + colour, never colour alone. */
export function RiskTag({ level, className }: { level: RiskLevel; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 font-semibold", RISK_TEXT[level], className)}>
      <span aria-hidden>{RISK_GLYPH[level]}</span>
      {RISK_LABEL[level]}
    </span>
  );
}

/** Four-segment meter; filled segment count encodes level independent of hue. */
export function LevelMeter({ level, className }: { level: RiskLevel; className?: string }) {
  const rank = riskRank(level);
  return (
    <span className={cn("flex gap-[3px]", className)} aria-hidden>
      {RISK_ORDER.map((l, i) => (
        <span
          key={l}
          className={cn("h-1.5 flex-1 rounded-[1px]", i <= rank ? "" : "bg-ti-line", i === 3 && rank === 3 && "cg-hatch")}
          style={i <= rank ? { backgroundColor: RISK_COLOR[level] } : undefined}
        />
      ))}
    </span>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="cg-label">{children}</h2>
      {aside}
    </div>
  );
}

export function HorizonControl({ className }: { className?: string }) {
  const horizon = useTwinStore((s) => s.horizon);
  const setHorizon = useTwinStore((s) => s.setHorizon);
  const options: { value: ForecastHorizon; label: string; aria: string }[] = [
    { value: 0, label: "Now", aria: "Show current conditions" },
    { value: 5, label: "+5 min", aria: "Show 5-minute forecast" },
    { value: 10, label: "+10 min", aria: "Show 10-minute forecast" },
  ];
  return (
    <div className={cn("cg-seg", className)} role="group" aria-label="Forecast horizon">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={horizon === o.value} aria-label={o.aria} onClick={() => setHorizon(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
