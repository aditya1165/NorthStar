import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { levelForDensity } from "../domain/risk";
import type { VenueLayout, ZoneId } from "../domain/types";
import { previewIntervention, useTwinStore } from "../state/twinStore";
import { RISK_COLOR } from "../ui/palette";
import { extrudedGeometry, flatGeometry, zoneShape } from "./shapes";

const VOLUME_SCALE = 0.55;
const FORECAST_MIN_DENSITY = 2.1;

interface ZoneMeshes {
  floor: THREE.Mesh;
  floorMat: THREE.MeshBasicMaterial;
  volume: THREE.Mesh;
  volumeMat: THREE.MeshBasicMaterial;
  edges: THREE.LineSegments;
  edgesMat: THREE.LineBasicMaterial;
}

/**
 * Current density as tinted concourse floor, and predicted density at the
 * selected horizon as translucent extruded volumes (height ∝ density).
 */
export function ZoneField({ venue, reducedMotion }: { venue: VenueLayout; reducedMotion: boolean }) {
  const refs = useRef<Partial<Record<ZoneId, ZoneMeshes>>>({});
  const tmp = useMemo(() => new THREE.Color(), []);

  const assets = useMemo(
    () =>
      venue.zones.map((zone) => {
        const shape = zoneShape(venue, zone);
        const floor = flatGeometry(shape);
        const volume = extrudedGeometry(shape, 1);
        const edges = new THREE.EdgesGeometry(volume, 20);
        return { zone, floor, volume, edges };
      }),
    [venue],
  );

  useEffect(
    () => () => {
      for (const a of assets) {
        a.floor.dispose();
        a.volume.dispose();
        a.edges.dispose();
      }
    },
    [assets],
  );

  useFrame((state, delta) => {
    const store = useTwinStore.getState();
    const { snapshot, horizon, layers } = store;
    if (!snapshot) return;
    const preview = previewIntervention(store);
    const k = reducedMotion ? 1 : Math.min(1, delta * 4);
    const pulse = reducedMotion ? 1 : 0.8 + 0.2 * Math.sin(state.clock.elapsedTime * 3.2);

    for (const zone of snapshot.zones) {
      const m = refs.current[zone.id];
      if (!m) continue;

      // Current density
      m.floor.visible = layers.density;
      m.floorMat.color.lerp(tmp.set(RISK_COLOR[zone.level]), k);
      const base = 0.07 + Math.min(1, zone.density / 5) * 0.32;
      const targetOpacity = zone.level === "critical" ? base * pulse : base;
      m.floorMat.opacity += (targetOpacity - m.floorMat.opacity) * k;

      // Forecast volume
      let predicted = 0;
      if (horizon !== 0) {
        predicted = preview ? preview.zoneForecast[zone.id][horizon] : zone.forecast[horizon].density;
      }
      const show = layers.forecast && horizon !== 0 && predicted >= FORECAST_MIN_DENSITY;
      const targetHeight = show ? Math.max(0.05, predicted * VOLUME_SCALE) : 0.001;
      const h = m.volume.scale.y + (targetHeight - m.volume.scale.y) * k;
      m.volume.scale.y = h;
      m.edges.scale.y = h;
      m.volume.visible = h > 0.01;
      m.edges.visible = h > 0.01;
      const level = levelForDensity(predicted);
      m.volumeMat.color.lerp(tmp.set(RISK_COLOR[level]), k);
      m.edgesMat.color.lerp(tmp.set(RISK_COLOR[level]), k);
      m.volumeMat.opacity = horizon === 5 ? 0.2 : 0.13;
      m.edgesMat.opacity = horizon === 5 ? 0.75 : 0.55;
    }
  });

  return (
    <group>
      {assets.map(({ zone, floor, volume, edges }) => (
        <group key={zone.id}>
          <mesh
            geometry={floor}
            position-y={0.03}
            renderOrder={1}
            ref={(mesh) => {
              if (!mesh) return;
              const entry = (refs.current[zone.id] ??= {} as ZoneMeshes);
              entry.floor = mesh;
              entry.floorMat = mesh.material as THREE.MeshBasicMaterial;
            }}
          >
            <meshBasicMaterial transparent opacity={0.08} depthWrite={false} color={RISK_COLOR.normal} />
          </mesh>
          <mesh
            geometry={volume}
            position-y={0.035}
            scale-y={0.001}
            renderOrder={3}
            ref={(mesh) => {
              if (!mesh) return;
              const entry = (refs.current[zone.id] ??= {} as ZoneMeshes);
              entry.volume = mesh;
              entry.volumeMat = mesh.material as THREE.MeshBasicMaterial;
            }}
          >
            <meshBasicMaterial transparent opacity={0.13} depthWrite={false} side={THREE.DoubleSide} color={RISK_COLOR.normal} />
          </mesh>
          <lineSegments
            geometry={edges}
            position-y={0.035}
            scale-y={0.001}
            renderOrder={4}
            ref={(line) => {
              if (!line) return;
              const entry = (refs.current[zone.id] ??= {} as ZoneMeshes);
              entry.edges = line;
              entry.edgesMat = line.material as THREE.LineBasicMaterial;
            }}
          >
            <lineBasicMaterial transparent opacity={0.55} color={RISK_COLOR.normal} />
          </lineSegments>
        </group>
      ))}
    </group>
  );
}
