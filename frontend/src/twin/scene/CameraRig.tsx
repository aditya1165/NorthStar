import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

import { useTwinStore, type CameraPreset } from "../state/twinStore";

const FOV = 38;
/** Direction, target and on-screen half-extents each preset keeps in frame. */
const PRESETS: Record<CameraPreset, { dir: THREE.Vector3; target: THREE.Vector3; halfWidth: number; halfDepth: number }> = {
  overview: { dir: new THREE.Vector3(0, 0.72, 0.7).normalize(), target: new THREE.Vector3(0.5, 0, 3), halfWidth: 21, halfDepth: 12 },
  top: { dir: new THREE.Vector3(0, 1, 0.0001).normalize(), target: new THREE.Vector3(0, 0, 1.5), halfWidth: 21, halfDepth: 17 },
  incident: { dir: new THREE.Vector3(0.42, 0.62, 0.66).normalize(), target: new THREE.Vector3(7, 0, 4.5), halfWidth: 14, halfDepth: 8.5 },
};

function presetPose(preset: CameraPreset, aspect: number) {
  const p = PRESETS[preset];
  const vHalf = (FOV / 2) * (Math.PI / 180);
  const hHalf = Math.atan(Math.tan(vHalf) * aspect);
  // Fit the requested half-extents horizontally and vertically (depth is already foreshortened).
  const distance = Math.max(p.halfWidth / Math.tan(hHalf), p.halfDepth / Math.tan(vHalf));
  return { position: p.target.clone().addScaledVector(p.dir, distance), target: p.target.clone() };
}

export function CameraRig({ mobile, reducedMotion }: { mobile: boolean; reducedMotion: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const nonce = useTwinStore((s) => s.camera.nonce);
  const preset = useTwinStore((s) => s.camera.preset);
  const goal = useRef<{ position: THREE.Vector3; target: THREE.Vector3 } | null>(null);
  const initialised = useRef(false);

  useEffect(() => {
    // Mobile always uses the simplified top-down view.
    const effective: CameraPreset = mobile ? "top" : preset;
    const pose = presetPose(effective, size.width / Math.max(1, size.height));
    if (!initialised.current || reducedMotion) {
      camera.position.copy(pose.position);
      controls.current?.target.copy(pose.target);
      controls.current?.update();
      initialised.current = true;
      goal.current = null;
    } else {
      goal.current = pose;
    }
    // Re-fit on preset change and on resize.
  }, [nonce, preset, mobile, size.width, size.height, camera, reducedMotion]);

  useFrame((_, delta) => {
    const g = goal.current;
    const c = controls.current;
    if (!g || !c) return;
    const k = Math.min(1, delta * 3);
    camera.position.lerp(g.position, k);
    c.target.lerp(g.target, k);
    c.update();
    if (camera.position.distanceTo(g.position) < 0.05) goal.current = null;
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping={!reducedMotion}
      dampingFactor={0.08}
      enableRotate={!mobile}
      minDistance={12}
      maxDistance={120}
      maxPolarAngle={Math.PI * 0.43}
      screenSpacePanning={false}
      onStart={() => {
        goal.current = null;
      }}
    />
  );
}

export { FOV };
