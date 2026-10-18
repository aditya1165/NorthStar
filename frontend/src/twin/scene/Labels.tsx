import { ringPoint } from "../domain/geometry";
import { RISK_LABEL } from "../domain/risk";
import type { GateState, RiskLevel, VenueLayout, ZoneState } from "../domain/types";
import { useTwinStore } from "../state/twinStore";
import { RISK_COLOR } from "../ui/palette";
import { ProjectedLabel } from "./labelRegistry";
import { zoneAnchor } from "./shapes";

const LEVEL_GLYPH: Record<RiskLevel, string> = { normal: "○", elevated: "◐", high: "◆", critical: "▲" };

function GateLabel({ venue, gate }: { venue: VenueLayout; gate: GateState }) {
  const layout = venue.gates.find((g) => g.id === gate.id)!;
  const [x, z] = ringPoint(venue.bowl.rx, venue.bowl.rz, layout.angleDeg, venue.ring.concourseOuter + 0.17);
  const closed = gate.status === "closed";
  const incident = closed;
  const tone = incident ? "border-signal/70 text-signal-text" : closed ? "border-ti-edge text-ti-text" : "border-mineral/60 text-mineral-text";
  return (
    <ProjectedLabel id={`gate-${gate.id}`} position={[x, 2.1, z]}>
      <div className={`rounded-[4px] border bg-void/85 px-2 py-1 text-center backdrop-blur-sm ${tone}`}>
        <div className="text-[11px] font-semibold tracking-wide text-warm">{layout.label}</div>
        <div className="text-[9px] font-medium uppercase tracking-[0.14em]">
          {closed ? "■ Closed" : "▶ Open"}
        </div>
      </div>
    </ProjectedLabel>
  );
}

function ZoneLabel({ venue, zone, compact }: { venue: VenueLayout; zone: ZoneState; compact: boolean }) {
  const layout = venue.zones.find((z) => z.id === zone.id)!;
  const [x, z] = zoneAnchor(venue, layout);
  const color = RISK_COLOR[zone.level];
  const emphasis = zone.level === "high" || zone.level === "critical";
  return (
    <ProjectedLabel id={`zone-${zone.id}`} position={[x, emphasis ? 3.2 : 0.9, z]}>
      <div className={`flex items-center gap-1.5 rounded-[4px] bg-void/70 px-1.5 py-0.5 ${emphasis ? "border border-ti-edge" : ""}`}>
        <span aria-hidden style={{ color }} className="text-[10px]">
          {LEVEL_GLYPH[zone.level]}
        </span>
        {!compact && <span className="text-[10px] font-medium text-ti-text">{layout.label}</span>}
        <span className="cg-num text-[10px] text-warm">{zone.density.toFixed(1)}</span>
        {emphasis && (
          <span className="text-[9px] font-semibold uppercase tracking-wider" style={{ color }}>
            {RISK_LABEL[zone.level]}
          </span>
        )}
      </div>
    </ProjectedLabel>
  );
}

export function Labels({ venue, compact }: { venue: VenueLayout; compact: boolean }) {
  const show = useTwinStore((s) => s.layers.labels);
  const gates = useTwinStore((s) => s.snapshot?.gates);
  const zones = useTwinStore((s) => s.snapshot?.zones);
  const transitDelayed = useTwinStore((s) => s.snapshot?.transit.status === "delayed");
  const highlight = useTwinStore((s) => s.snapshot?.recommendation !== null && s.snapshot?.recommendation !== undefined);

  if (!show || !gates || !zones) return null;
  const [mx, mz] = venue.transit.position;
  const [sx, sz] = ringPoint(venue.bowl.rx, venue.bowl.rz, 52, 0.78);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {gates.map((g) => (
        <GateLabel key={g.id} venue={venue} gate={g} />
      ))}
      {zones
        .filter((z) => !compact || z.level !== "normal")
        .map((z) => (
          <ZoneLabel key={z.id} venue={venue} zone={z} compact={compact} />
        ))}
      <ProjectedLabel id="transit" position={[mx + 1.2, 1.6, mz + 1]}>
        <div className="rounded-[4px] border border-ti-line bg-void/80 px-2 py-1 text-center">
          <div className="text-[10px] font-semibold text-warm">Metro</div>
          <div className={`text-[9px] font-medium uppercase tracking-[0.14em] ${transitDelayed ? "text-signal-text" : "text-ti-text"}`}>
            {transitDelayed ? "◆ Delayed · 45%" : "On time"}
          </div>
        </div>
      </ProjectedLabel>
      {highlight && !compact && (
        <ProjectedLabel id="sections" position={[sx, 2.2, sz]}>
          <div className="rounded-[4px] border border-violet/60 bg-void/80 px-1.5 py-0.5 text-[10px] font-medium text-violet-soft">
            Sections 205–208
          </div>
        </ProjectedLabel>
      )}
    </div>
  );
}
