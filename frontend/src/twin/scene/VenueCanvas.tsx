import { Canvas } from "@react-three/fiber";
import { useMemo } from "react";

import { TOTAL_POPULATION } from "../congestion/types";
import { useTwinStore } from "../state/twinStore";
import type { ViewportTier } from "../ui/hooks";
import { PALETTE } from "../ui/palette";
import { CameraRig, FOV } from "./CameraRig";
import { Gates } from "./Gates";
import { LabelProjector } from "./labelRegistry";
import { Labels } from "./Labels";
import { Pedestrians } from "./Pedestrians";
import { Routes } from "./Routes";
import { Stadium } from "./Stadium";
import { ZoneField } from "./ZoneField";

const QUALITY: Record<ViewportTier, { dpr: [number, number]; antialias: boolean; detail: "high" | "low" }> = {
  desktop: { dpr: [1, 1.75], antialias: true, detail: "high" },
  tablet: { dpr: [1, 1.5], antialias: true, detail: "high" },
  mobile: { dpr: [1, 1.25], antialias: false, detail: "low" },
};

export default function VenueCanvas({ tier, reducedMotion }: { tier: ViewportTier; reducedMotion: boolean }) {
  const venue = useTwinStore((s) => s.venue);
  const highlight = useTwinStore((s) => Boolean(s.snapshot?.recommendation));
  const quality = QUALITY[tier];
  const mobile = tier === "mobile";
  const gl = useMemo(() => ({ antialias: quality.antialias, powerPreference: "high-performance" as const, alpha: true }), [quality.antialias]);

  if (!venue) return null;

  return (
    <>
    <Canvas
      dpr={quality.dpr}
      gl={gl}
      camera={{ fov: FOV, near: 0.5, far: 400, position: [0, 30, 36] }}
      aria-label="3D digital twin of Meridian Stadium showing pedestrians, gate status, congestion and forecast"
      role="img"
    >
      <fog attach="fog" args={[PALETTE.void, 70, 150]} />
      <ambientLight intensity={0.45} />
      <hemisphereLight args={["#e8e2d6", "#0a0a0b", 0.55]} />
      <directionalLight position={[-18, 32, 14]} intensity={1.35} color="#f4ede2" />
      <directionalLight position={[20, 14, -18]} intensity={0.35} color="#9d97c9" />

      <Stadium venue={venue} highlightSections={highlight} detail={quality.detail} />
      <ZoneField venue={venue} reducedMotion={reducedMotion} />
      <Routes venue={venue} reducedMotion={reducedMotion} />
      <Gates venue={venue} reducedMotion={reducedMotion} />
      <Pedestrians venue={venue} count={TOTAL_POPULATION} />
      <LabelProjector />
      <CameraRig mobile={mobile} reducedMotion={reducedMotion} />
    </Canvas>
    <Labels venue={venue} compact={mobile} />
    </>
  );
}
