import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type ReactNode } from "react";
import * as THREE from "three";

/**
 * Screen-space labels for the 3D view.
 *
 * Labels are ordinary DOM nodes rendered by the main React tree in an overlay;
 * `LabelProjector` (inside the Canvas) repositions them every frame. This
 * avoids creating a separate React root per label.
 */
type Entry = { el: HTMLElement; position: [number, number, number] };
const registry = new Map<string, Entry>();

export function ProjectedLabel({ id, position, children }: { id: string; position: [number, number, number]; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [x, y, z] = position;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    registry.set(id, { el, position: [x, y, z] });
    return () => {
      if (registry.get(id)?.el === el) registry.delete(id);
    };
  }, [id, x, y, z]);
  return (
    <div ref={ref} className="cg-label-3d absolute top-0 left-0" style={{ visibility: "hidden" }}>
      {children}
    </div>
  );
}

export function LabelProjector() {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const v = useRef(new THREE.Vector3());
  useFrame(() => {
    for (const { el, position } of registry.values()) {
      v.current.set(position[0], position[1], position[2]).project(camera);
      const behind = v.current.z > 1;
      el.style.visibility = behind ? "hidden" : "visible";
      if (behind) continue;
      const px = ((v.current.x + 1) / 2) * size.width;
      const py = ((1 - v.current.y) / 2) * size.height;
      el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -50%)`;
    }
  });
  return null;
}
