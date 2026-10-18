import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

import { DEG, ringPoint } from "../domain/geometry";
import type { GateId, VenueLayout } from "../domain/types";
import { useTwinStore } from "../state/twinStore";
import { GATE_PORTAL_SCALE } from "../sim/paths";
import { PALETTE, RISK_COLOR } from "../ui/palette";

const GATE_WIDTH = 1.9;
const DOOR_HEIGHT = 1.05;

function Gate({ venue, id, reducedMotion }: { venue: VenueLayout; id: GateId; reducedMotion: boolean }) {
  const layout = venue.gates.find((g) => g.id === id)!;
  const door = useRef<THREE.Mesh>(null);
  const doorMat = useRef<THREE.MeshStandardMaterial>(null);
  const strip = useRef<THREE.MeshBasicMaterial>(null);
  const pulse = useRef<THREE.Mesh>(null);
  const pulseMat = useRef<THREE.MeshBasicMaterial>(null);
  const last = useRef<{ state: string | null; epoch: number; changedAt: number }>({ state: null, epoch: -1, changedAt: -10 });
  const tmp = useMemo(() => new THREE.Color(), []);

  const { position, rotation } = useMemo(() => {
    const { rx, rz } = venue.bowl;
    const [x, z] = ringPoint(rx, rz, layout.angleDeg, GATE_PORTAL_SCALE);
    const a = layout.angleDeg * DEG;
    // Tangent of the ellipse; the gate spans along it.
    const tx = -Math.sin(a) * rx;
    const tz = Math.cos(a) * rz;
    return { position: [x, 0, z] as [number, number, number], rotation: -Math.atan2(tz, tx) };
  }, [venue, layout]);

  useFrame((state, delta) => {
    const store = useTwinStore.getState();
    const gate = store.snapshot?.gates.find((g) => g.id === id);
    const congestion = store.congestion?.gates.find((item) => item.gateId === id);
    if (!gate || !door.current || !doorMat.current || !strip.current) return;
    const now = state.clock.elapsedTime;
    const epoch = store.snapshot?.epoch ?? 0;
    const visualState = `${gate.status}:${congestion?.congested ? congestion.level : "clear"}`;
    if (last.current.state !== visualState || last.current.epoch !== epoch) {
      // Pulse only for live changes, not first sync, resets or jumps.
      const live = last.current.state !== null && last.current.epoch === epoch;
      last.current = { state: visualState, epoch, changedAt: live ? now : -10 };
    }
    const closed = gate.status === "closed";
    const target = closed ? 1 : 0.001;
    const k = reducedMotion ? 1 : Math.min(1, delta * 3.2);
    door.current.scale.y += (target - door.current.scale.y) * k;
    door.current.position.y = (DOOR_HEIGHT * door.current.scale.y) / 2;
    door.current.visible = door.current.scale.y > 0.01;

    const incident = closed;
    const detected = congestion?.congested ?? false;
    const alertColor = detected ? RISK_COLOR[congestion?.level ?? "high"] : PALETTE.orange;
    doorMat.current.color.lerp(tmp.set(incident || detected ? "#4a2a1c" : "#2e2e33"), k);
    doorMat.current.emissive.lerp(tmp.set(incident || detected ? alertColor : "#000000"), k);
    doorMat.current.emissiveIntensity = incident || detected ? 0.35 : 0;
    strip.current.color.lerp(tmp.set(detected ? alertColor : closed ? (incident ? PALETTE.orange : PALETTE.titanium) : PALETTE.green), k);

    if (pulse.current && pulseMat.current) {
      const age = now - last.current.changedAt;
      const active = !reducedMotion && age < 2.4;
      pulse.current.visible = active;
      if (active) {
        const s = 1 + age * 2.2;
        pulse.current.scale.set(s, s, s);
        pulseMat.current.opacity = 0.55 * (1 - age / 2.4);
        pulseMat.current.color.set(detected ? alertColor : closed ? PALETTE.orange : PALETTE.green);
      }
    }

  });

  return (
    <group position={position} rotation-y={rotation}>
      {/* pillars + lintel */}
      {[-1, 1].map((side) => (
        <mesh key={side} position={[(side * GATE_WIDTH) / 2, 0.75, 0]}>
          <boxGeometry args={[0.18, 1.5, 0.28]} />
          <meshStandardMaterial color="#4a4a51" roughness={0.35} metalness={0.75} />
        </mesh>
      ))}
      <mesh position={[0, 1.55, 0]}>
        <boxGeometry args={[GATE_WIDTH + 0.36, 0.12, 0.32]} />
        <meshStandardMaterial color="#55555c" roughness={0.35} metalness={0.75} />
      </mesh>
      <mesh ref={door} position={[0, DOOR_HEIGHT / 2, 0]}>
        <boxGeometry args={[GATE_WIDTH - 0.2, DOOR_HEIGHT, 0.08]} />
        <meshStandardMaterial ref={doorMat} color="#2e2e33" roughness={0.5} metalness={0.5} />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[GATE_WIDTH - 0.1, 0.5]} />
        <meshBasicMaterial ref={strip} color={PALETTE.green} transparent opacity={0.85} />
      </mesh>
      <mesh ref={pulse} rotation-x={-Math.PI / 2} position-y={0.05} visible={false}>
        <ringGeometry args={[1.1, 1.25, 48]} />
        <meshBasicMaterial ref={pulseMat} transparent opacity={0} depthWrite={false} color={PALETTE.orange} />
      </mesh>
    </group>
  );
}

export function Gates({ venue, reducedMotion }: { venue: VenueLayout; reducedMotion: boolean }) {
  return (
    <group>
      {venue.gates.map((g) => (
        <Gate key={g.id} venue={venue} id={g.id} reducedMotion={reducedMotion} />
      ))}
    </group>
  );
}
