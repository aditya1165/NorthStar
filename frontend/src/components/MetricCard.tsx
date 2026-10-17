import type { LucideIcon } from "lucide-react";

type Props = {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
};

export function MetricCard({ label, value, detail, icon: Icon }: Props) {
  return (
    <article className="panel flex items-start justify-between gap-4 p-4">
      <div>
        <p className="eyebrow">{label}</p>
        <p className="mt-2 text-2xl font-semibold tracking-tight text-white">{value}</p>
        <p className="mt-1 text-xs text-slate-400">{detail}</p>
      </div>
      <span className="rounded-xl bg-cyan-400/10 p-2.5 text-cyan-300">
        <Icon size={19} aria-hidden="true" />
      </span>
    </article>
  );
}

