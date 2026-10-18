import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Line2, LineMaterial } from "three-stdlib";

import type { Point2, VenueLayout } from "../domain/types";
import { useTwinStore } from "../state/twinStore";
import { boundaryRoute } from "../sim/paths";
import { PALETTE } from "../ui/palette";

function FlowLine({ route, mode, reducedMotion }: { route: { points: Point2[] }; mode: "preview" | "active"; reducedMotion: boolean }) {
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
  const evaluation = useTwinStore((s) => s.liveEvaluation);
  const selectedId = useTwinStore((s) => s.liveSelectedId);
  const approvedRoute = useTwinStore((s) => s.liveApprovedRoute);
  const redirectSuspended = useTwinStore((s) => s.congestion?.routing?.redirectSuspended ?? false);
  const gates = useTwinStore((s) => s.snapshot?.gates);
  const candidate = evaluation?.candidates.find((item) => item.interventionId === (selectedId ?? evaluation.recommendedId));
  const preview = candidate?.feasible && candidate.redirectGate && evaluation
    ? { from: evaluation.hotspotGate, to: candidate.redirectGate } : null;
  const route = preview ?? (redirectSuspended ? null : approvedRoute);
  const mode = preview ? "preview" : "active";
  const layout = useMemo(() => route ? { id: `${route.from}-${route.to}`, label: "Outer concourse diversion", points: boundaryRoute(venue, route.from, route.to) } : null, [venue, route?.from, route?.to]);
  if (!show || !layout || gates?.some((gate) => gate.id === route?.to && gate.status === "closed")) return null;
  return <FlowLine route={layout} mode={mode} reducedMotion={reducedMotion} />;
}
