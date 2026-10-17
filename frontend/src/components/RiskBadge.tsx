import { cn } from "../lib/cn";
import type { RiskLevel } from "../types/contracts";

const styles: Record<RiskLevel, string> = {
  normal: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
  elevated: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  high: "border-orange-400/30 bg-orange-400/10 text-orange-300",
  critical: "border-red-400/30 bg-red-400/10 text-red-300",
};

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold capitalize", styles[level])}>
      {level}
    </span>
  );
}

