import { motion } from "motion/react";

import type { ZoneTelemetry } from "../types/contracts";

const geometry: Record<string, { x: number; y: number; width: number; height: number }> = {
  north_concourse: { x: 140, y: 40, width: 220, height: 78 },
  east_corridor: { x: 330, y: 136, width: 116, height: 130 },
  west_concourse: { x: 54, y: 136, width: 116, height: 130 },
  gate_a: { x: 54, y: 286, width: 116, height: 62 },
  gate_c: { x: 330, y: 286, width: 116, height: 62 },
  metro_plaza: { x: 140, y: 286, width: 220, height: 92 },
};

const colors = {
  normal: "#34d399",
  elevated: "#fbbf24",
  high: "#fb923c",
  critical: "#f87171",
};

export function VenueMap({ zones }: { zones: ZoneTelemetry[] }) {
  return (
    <div className="panel overflow-hidden p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <p className="eyebrow">Live digital twin</p>
          <h2 className="mt-1 text-lg font-semibold text-white">Venue flow map</h2>
        </div>
        <div className="flex items-center gap-2 text-xs text-emerald-300">
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" /> Live
        </div>
      </div>
      <svg viewBox="0 0 500 410" className="h-auto w-full" role="img" aria-label="Venue zone risk map">
        <rect x="16" y="16" width="468" height="378" rx="28" fill="#091827" stroke="#1e3446" />
        <circle cx="250" cy="202" r="75" fill="#0d2233" stroke="#294155" strokeDasharray="6 6" />
        <text x="250" y="198" textAnchor="middle" fill="#64748b" fontSize="12">STADIUM</text>
        <text x="250" y="216" textAnchor="middle" fill="#94a3b8" fontSize="10">PITCH / SEATING</text>
        {zones.map((zone) => {
          const box = geometry[zone.zone_id];
          if (!box) return null;
          const color = colors[zone.risk_level];
          return (
            <motion.g key={zone.zone_id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              <rect {...box} rx="14" fill={`${color}18`} stroke={color} strokeWidth="1.5" />
              <text x={box.x + 12} y={box.y + 22} fill="#e2e8f0" fontSize="11" fontWeight="600">
                {zone.name}
              </text>
              <text x={box.x + 12} y={box.y + 43} fill={color} fontSize="16" fontWeight="700">
                {zone.density_estimate.toFixed(1)}
              </text>
              <text x={box.x + 47} y={box.y + 43} fill="#94a3b8" fontSize="9">people/m²</text>
              <text x={box.x + 12} y={box.y + 60} fill="#64748b" fontSize="9">
                {zone.people_count} people · queue {zone.queue_length}
              </text>
            </motion.g>
          );
        })}
      </svg>
    </div>
  );
}

