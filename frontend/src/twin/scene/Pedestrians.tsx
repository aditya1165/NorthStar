import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { TOTAL_POPULATION } from "../congestion/types";
import type { VenueLayout } from "../domain/types";
import { AGENT_COLOR, CrowdField } from "../sim/crowdField";
import { useTwinStore } from "../state/twinStore";

const COLORS: Record<number, THREE.Color> = {
  [AGENT_COLOR.normal]: new THREE.Color("#c8cacf"),
  [AGENT_COLOR.rerouted]: new THREE.Color("#9ccfb3"),
  [AGENT_COLOR.waiting]: new THREE.Color("#b3aea6"),
};

const TELEMETRY_INTERVAL_MS = 1_000;

/**
 * All pedestrians in a single InstancedMesh. Positions come from CrowdField and
 * are written straight into the instance matrix buffer each frame.
 */
export function Pedestrians({ venue, count }: { venue: VenueLayout; count: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const field = useMemo(() => new CrowdField(venue, count), [venue, count]);
  const prevColor = useMemo(() => new Uint8Array(count).fill(255), [count]);
  const sync = useRef({ epoch: -1, snapMinute: -1, snapAt: 0, rate: 0 });
  const telemetry = useRef({ epoch: -1, sequence: 0, sentAt: -Infinity, minute: -1 });

  const geometry = useMemo(() => {
    const g = new THREE.CapsuleGeometry(0.075, 0.17, 2, 6);
    g.translate(0, 0.16, 0);
    return g;
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const identity = new THREE.Matrix4();
    for (let i = 0; i < count; i += 1) {
      m.setMatrixAt(i, identity);
      m.setColorAt(i, COLORS[AGENT_COLOR.normal]);
    }
    prevColor.fill(255);
    sync.current.epoch = -1;
  }, [count, prevColor]);

  useFrame(() => {
    const m = mesh.current;
    const store = useTwinStore.getState();
    const snapshot = store.snapshot;
    const congestion = store.congestion;
    const visible = store.layers.agents;
    if (!m || !snapshot) return;
    m.visible = visible;

    const s = sync.current;
    const now = performance.now();
    if (snapshot.epoch !== s.epoch || snapshot.minute < s.snapMinute - 1e-6) {
      // Reset / jump: rebuild deterministically and fast-forward to the snapshot time.
      field.reset(0);
      field.advanceTo(snapshot.minute, snapshot, congestion);
      s.epoch = snapshot.epoch;
      s.snapMinute = snapshot.minute;
      s.snapAt = now;
      s.rate = 0;
    } else if (snapshot.minute !== s.snapMinute) {
      const dtMs = now - s.snapAt;
      if (dtMs > 0) {
        const measured = (snapshot.minute - s.snapMinute) / dtMs;
        s.rate = s.rate === 0 ? measured : s.rate * 0.7 + measured * 0.3;
      }
      s.snapMinute = snapshot.minute;
      s.snapAt = now;
    }

    // Interpolate between 10 Hz snapshots for smooth motion.
    const running = snapshot.status === "running";
    if (!running) s.rate = 0;
    const predicted = running ? Math.min(snapshot.minute + s.rate * (now - s.snapAt), snapshot.minute + 0.12) : snapshot.minute;
    if (predicted > field.time) field.advanceTo(predicted, snapshot, congestion);

    const stream = telemetry.current;
    if (stream.epoch !== snapshot.epoch) {
      stream.epoch = snapshot.epoch;
      stream.sequence = 0;
      stream.sentAt = -Infinity;
      stream.minute = -1;
    }
    if (count === TOTAL_POPULATION && field.time !== stream.minute && now - stream.sentAt >= TELEMETRY_INTERVAL_MS) {
      const sample = field.telemetry();
      useTwinStore.getState().publishTelemetry({
        runId: `${venue.id}:${snapshot.epoch}`,
        sequence: stream.sequence,
        simulationTimeSeconds: Math.max(0, field.time * 60),
        population: TOTAL_POPULATION,
        ...sample,
      });
      stream.sequence += 1;
      stream.sentAt = now;
      stream.minute = field.time;
    }

    if (!visible) return;
    const arr = m.instanceMatrix.array as Float32Array;
    const pos = field.positions;
    let colorDirty = false;
    for (let i = 0; i < count; i += 1) {
      const o = i * 16;
      const sc = field.visible[i] ? 1 : 0;
      arr[o] = sc;
      arr[o + 5] = sc;
      arr[o + 10] = sc;
      arr[o + 12] = pos[i * 3];
      arr[o + 13] = pos[i * 3 + 1];
      arr[o + 14] = pos[i * 3 + 2];
      const c = field.colorClass[i];
      if (c !== prevColor[i]) {
        prevColor[i] = c;
        m.setColorAt(i, COLORS[c]);
        colorDirty = true;
      }
    }
    m.instanceMatrix.needsUpdate = true;
    if (colorDirty && m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[geometry, undefined, count]} frustumCulled={false}>
      <meshStandardMaterial color="#ffffff" roughness={0.42} metalness={0.35} />
    </instancedMesh>
  );
}
