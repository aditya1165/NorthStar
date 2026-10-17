import { cn } from "../../lib/cn";
import { formatClock, STAGE_LABEL, STAGE_ORDER } from "../domain/risk";
import { useTwinStore } from "../state/twinStore";
import { PlaybackControls } from "./Playback";

function Mark() {
  return (
    <svg viewBox="0 0 28 28" className="h-7 w-7" aria-hidden>
      <ellipse cx="14" cy="14" rx="12" ry="9" fill="none" stroke="#5a5a60" strokeWidth="1.2" />
      <ellipse cx="14" cy="14" rx="7" ry="5" fill="none" stroke="#f1ede6" strokeWidth="1.4" />
      <circle cx="21.5" cy="18.5" r="2.2" fill="#ee7a26" />
    </svg>
  );
}

export function StageTrack({ className }: { className?: string }) {
  const stage = useTwinStore((s) => s.snapshot?.stage ?? "normal");
  const index = STAGE_ORDER.indexOf(stage);
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex items-baseline gap-2">
        <span className="cg-label">Stage {index + 1}/8</span>
        <span className="truncate text-xs font-medium text-warm">{STAGE_LABEL[stage]}</span>
      </div>
      <ol className="flex gap-[3px]" aria-label="Scenario stages">
        {STAGE_ORDER.map((s, i) => (
          <li
            key={s}
            title={STAGE_LABEL[s]}
            aria-current={i === index ? "step" : undefined}
            className={cn(
              "h-1 w-6 rounded-[1px] transition-colors xl:w-8",
              i < index && "bg-ti-mid",
              i === index && (s === "stabilized" ? "bg-mineral" : s === "critical_forecast" || s === "recommendation_available" ? "bg-vermilion" : "bg-warm"),
              i > index && "bg-ti-line",
            )}
          >
            <span className="sr-only">{STAGE_LABEL[s]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ScenarioClock() {
  const minute = useTwinStore((s) => s.snapshot?.minute ?? 0);
  const status = useTwinStore((s) => s.snapshot?.status ?? "idle");
  const statusLabel = { idle: "Ready", running: "Live", paused: "Paused", complete: "Complete" }[status];
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", status === "running" ? "animate-pulse bg-warm" : "bg-ti-mid")}
      />
      <div className="leading-tight">
        <div className="cg-num text-sm text-warm">T+{formatClock(minute)}</div>
        <div className="text-[10px] uppercase tracking-[0.14em] text-ti-dim">{statusLabel}</div>
      </div>
    </div>
  );
}

export function Header({ compact, compactControls = false }: { compact: boolean; compactControls?: boolean }) {
  return (
    <header className="flex items-center gap-4 border-b border-ti-line bg-void/80 px-4 py-2.5 backdrop-blur-md md:px-5">
      <div className="flex shrink-0 items-center gap-2.5">
        <Mark />
        <div className="leading-tight">
          <h1 className="text-sm font-semibold tracking-tight text-warm">CrowdGuardian</h1>
          <p className="text-[10px] text-ti-dim">Meridian Stadium · Post-match egress</p>
        </div>
      </div>
      {!compact && <StageTrack className="ml-4 hidden xl:flex" />}
      <div className="ml-auto flex items-center gap-4">
        <span className="hidden whitespace-nowrap rounded-[3px] border border-violet/40 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-violet-soft sm:inline">
          Mock scenario
        </span>
        <ScenarioClock />
        {!compact && <PlaybackControls compact={compactControls} className="hidden flex-nowrap md:flex" />}
      </div>
    </header>
  );
}
