import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Line2, LineMaterial } from "three-stdlib";

import type { RouteLayout, VenueLayout } from "../domain/types";
import { previewIntervention, useTwinStore } from "../state/twinStore";
import { PALETTE } from "../ui/palette";

function FlowLine({ route, mode, reducedMotion }: { route: RouteLayout; mode: "preview" | "active"; reducedMotion: boolean }) {
  const ref = useRef<Line2>(null);
  const points = useMemo(() => route.points.map(([x, z]) => [x, 0.12, z] as [number, number, number]), [route]);
  const under = useMemo(() => route.points.map(([x, z]) => [x, 0.08, z] as [number, number, number]), [route]);

  useFrame((_, delta) => {
    if (reducedMotion || !ref.current) return;
    const material = ref.current.material as LineMaterial;
    material.dashOffset -= delta * (mode === "active" ? 1.6 : 0.9);
  });

  const active = mode === "active";
  return (
    <group>
      {/* soft underlay keeps the route readable over busy floors */}
      <Line points={under} color="#000000" lineWidth={active ? 7 : 5} transparent opacity={0.45} depthWrite={false} renderOrder={5} />
      <Line
        ref={ref}
        points={points}
        color={active ? PALETTE.green : PALETTE.warmWhite}
        lineWidth={active ? 3.2 : 2.2}
        dashed
        dashSize={active ? 0.9 : 0.5}
        gapSize={active ? 0.35 : 0.4}
        transparent
        opacity={active ? 1 : 0.9}
        depthWrite={false}
        renderOrder={6}
      />
    </group>
  );
}

export function Routes({ venue, reducedMotion }: { venue: VenueLayout; reducedMotion: boolean }) {
  const show = useTwinStore((s) => s.layers.routes);
  const preview = useTwinStore(previewIntervention);
  const activePlan = useTwinStore((s) => s.snapshot?.activePlan ?? null);
  const interventions = useTwinStore((s) => s.snapshot?.interventions);

  const activeOption = activePlan ? interventions?.find((o) => o.id === activePlan.interventionId) : undefined;
  const mode: "preview" | "active" = activeOption ? "active" : "preview";
  const routeIds = activeOption?.routeIds ?? preview?.routeIds ?? [];

  if (!show || routeIds.length === 0) return null;
  return (
    <group>
      {routeIds.map((id) => {
        const route = venue.routes.find((r) => r.id === id);
        return route ? <FlowLine key={`${mode}-${id}`} route={route} mode={mode} reducedMotion={reducedMotion} /> : null;
      })}
    </group>
  );
}
