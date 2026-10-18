import { Pause, Play, RefreshCcw, RotateCcw } from "lucide-react";

import { cn } from "../../lib/cn";
import { PLAYBACK_SPEEDS } from "../services/CrowdTwinService";
import { useTwinStore } from "../state/twinStore";

export function PlaybackControls({ compact = false, className }: { compact?: boolean; className?: string }) {
  const status = useTwinStore((s) => s.snapshot?.status ?? "idle");
  const speed = useTwinStore((s) => s.snapshot?.speed ?? 1);
  const { start, pause, resume, reset, replay, setSpeed } = useTwinStore.getState();

  const primary =
    status === "idle"
      ? { label: "Start", icon: Play, run: start }
      : status === "running"
        ? { label: "Pause", icon: Pause, run: pause }
        : status === "paused"
          ? { label: "Resume", icon: Play, run: resume }
          : { label: "Replay", icon: RefreshCcw, run: replay };
  const PrimaryIcon = primary.icon;

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <button type="button" className="cg-btn min-w-[84px] text-warm" onClick={primary.run}>
        <PrimaryIcon size={14} aria-hidden /> {primary.label}
      </button>
      <button type="button" className="cg-btn" onClick={reset} aria-label="Reset scenario">
        <RotateCcw size={14} aria-hidden /> {!compact && "Reset"}
      </button>
      <button type="button" className="cg-btn" onClick={replay} aria-label="Replay scenario from the start">
        <RefreshCcw size={14} aria-hidden /> {!compact && "Replay"}
      </button>
      <div className="cg-seg" role="group" aria-label="Playback speed">
        {PLAYBACK_SPEEDS.map((value) => (
          <button key={value} type="button" aria-pressed={speed === value} aria-label={`${value}× speed`} onClick={() => setSpeed(value)}>
            {value}×
          </button>
        ))}
      </div>
    </div>
  );
}
