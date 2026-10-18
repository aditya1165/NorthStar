import { Line, RoundedBox } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { DEG, ringPoint } from "../domain/geometry";
import type { VenueLayout } from "../domain/types";
import { CONCOURSE_SCALE, GATE_PORTAL_SCALE } from "../sim/paths";
import { PALETTE } from "../ui/palette";
import { ellipsePoints, ellipseShape, extrudedGeometry, flatGeometry, sectorShape } from "./shapes";

const TIERS = [
  { from: 0, to: 0.33, height: 0.4 },
  { from: 0.33, to: 0.66, height: 0.9 },
  { from: 0.66, to: 1, height: 1.45 },
];

function buildSeating(venue: VenueLayout, filter: (sectionNumber: number) => boolean) {
  const { rx, rz } = venue.bowl;
  const { seatInner, seatOuter } = venue.ring;
  const parts: THREE.BufferGeometry[] = [];
  for (const section of venue.sections) {
    if (!filter(Number(section.label))) continue;
    for (const tier of TIERS) {
      const inner = seatInner + (seatOuter - seatInner) * tier.from;
      const outer = seatInner + (seatOuter - seatInner) * tier.to;
      // Split every block around its centre aisle. Agents first move to this
      // visible gap and then descend it instead of cutting across the stands.
      parts.push(
        extrudedGeometry(
          sectorShape(rx, rz, section.angleDeg - 6.9, section.angleDeg - 0.9, inner, outer, 4),
          tier.height,
        ),
        extrudedGeometry(
          sectorShape(rx, rz, section.angleDeg + 0.9, section.angleDeg + 6.9, inner, outer, 4),
          tier.height,
        ),
      );
    }
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  return merged;
}

export function Stadium({ venue, highlightSections, detail }: { venue: VenueLayout; highlightSections: boolean; detail: "high" | "low" }) {
  const { rx, rz } = venue.bowl;
  const ring = venue.ring;

  const geometries = useMemo(() => {
    const isHighlight = (n: number) => n >= 205 && n <= 208;
    const seating = buildSeating(venue, (n) => !isHighlight(n));
    const highlight = buildSeating(venue, isHighlight);
    const concourse = flatGeometry(sectorShape(rx, rz, -180, 180, ring.concourseInner, ring.concourseOuter, 120));
    const walkway = flatGeometry(sectorShape(rx, rz, -180, 180, CONCOURSE_SCALE - 0.045, CONCOURSE_SCALE + 0.045, 180));
    const apron = flatGeometry(sectorShape(rx, rz, -180, 180, ring.seatOuter, ring.concourseInner, 120));
    const pitch = flatGeometry(ellipseShape(0, 0, rx * ring.pitch, rz * ring.pitch, 72));

    // Outer wall with openings at each gate.
    const openings = venue.gates.map((g) => g.angleDeg).sort((a, b) => a - b);
    const walls: THREE.BufferGeometry[] = [];
    for (let i = 0; i < openings.length; i += 1) {
      const from = openings[i] + 4.5;
      const to = (i + 1 < openings.length ? openings[i + 1] : openings[0] + 360) - 4.5;
      walls.push(extrudedGeometry(sectorShape(rx, rz, from, to, ring.concourseOuter, ring.concourseOuter + 0.022, 48), 0.55));
    }
    const wall = mergeGeometries(walls, false);
    walls.forEach((w) => w.dispose());

    // Canopy struts between sections.
    const struts: THREE.BufferGeometry[] = [];
    for (const section of venue.sections) {
      const [x, z] = ringPoint(rx, rz, section.angleDeg + 7.5, ring.seatOuter + 0.012);
      const box = new THREE.BoxGeometry(0.09, 3.1, 0.09);
      box.translate(x, 1.55, z);
      struts.push(box);
    }
    const strut = mergeGeometries(struts, false);
    struts.forEach((s) => s.dispose());

    const seatingEdges = new THREE.EdgesGeometry(seating, 25);
    const highlightEdges = new THREE.EdgesGeometry(highlight, 25);
    return { seating, highlight, concourse, walkway, apron, pitch, wall, strut, seatingEdges, highlightEdges };
  }, [venue, rx, rz, ring]);

  useEffect(() => () => Object.values(geometries).forEach((g) => g.dispose()), [geometries]);

  const lines = useMemo(
    () => ({
      concourseOuter: ellipsePoints(rx, rz, ring.concourseOuter, 0.012),
      concourseInner: ellipsePoints(rx, rz, ring.concourseInner, 0.012),
      circulation: ellipsePoints(rx, rz, CONCOURSE_SCALE, 0.04),
      walkwayInner: ellipsePoints(rx, rz, CONCOURSE_SCALE - 0.045, 0.04),
      walkwayOuter: ellipsePoints(rx, rz, CONCOURSE_SCALE + 0.045, 0.04),
      basePath: ellipsePoints(rx, rz, ring.basePath, 0.018),
      canopy: ellipsePoints(rx, rz, ring.seatOuter + 0.012, 3.1),
      canopyInner: ellipsePoints(rx, rz, ring.seatOuter - 0.16, 2.95),
      pitchLine: ellipsePoints(rx, rz, ring.pitch - 0.035, 0.03),
      halfway: [
        [0, 0.03, -rz * (ring.pitch - 0.035)],
        [0, 0.03, rz * (ring.pitch - 0.035)],
      ] as [number, number, number][],
      centre: ellipsePoints(1.1, 1.1, 1, 0.03, 40),
      exits: venue.gates.map((g) => {
        const [x, z] = ringPoint(rx, rz, g.angleDeg, ring.basePath);
        const [cx, cz] = ringPoint(rx, rz, g.angleDeg, CONCOURSE_SCALE);
        const [gx, gz] = ringPoint(rx, rz, g.angleDeg, GATE_PORTAL_SCALE);
        return [
          [x, 0.012, z],
          [cx, 0.012, cz],
          [gx, 0.012, gz],
          [g.destination[0], 0.012, g.destination[1]],
        ] as [number, number, number][];
      }),
      aisles: venue.sections.map((section) =>
        Array.from({ length: 10 }, (_, index) => {
          const scale = ring.basePath + ((ring.seatOuter - ring.basePath) * index) / 9;
          const [x, z] = ringPoint(rx, rz, section.angleDeg, scale);
          const y =
            scale <= ring.seatInner
              ? 0.025
              : 0.08 + ((scale - ring.seatInner) / (ring.seatOuter - ring.seatInner)) * 1.37;
          return [x, y, z] as [number, number, number];
        }),
      ),
    }),
    [venue, rx, rz, ring],
  );

  const transitAngle = venue.transit.angleDeg * DEG;

  return (
    <group>
      {/* Floating architectural slab */}
      <RoundedBox args={[60, 1.4, 48]} radius={0.7} smoothness={3} position={[0, -0.72, 1]}>
        <meshStandardMaterial color={PALETTE.slab} roughness={0.92} metalness={0.05} />
      </RoundedBox>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.002, 1]}>
        <planeGeometry args={[58.6, 46.6]} />
        <meshStandardMaterial color={PALETTE.graphite} roughness={1} />
      </mesh>

      <mesh geometry={geometries.pitch} position-y={0.01}>
        <meshStandardMaterial color={PALETTE.pitch} roughness={1} />
      </mesh>
      <Line points={lines.pitchLine} color={PALETTE.titaniumLight} lineWidth={1} transparent opacity={0.45} />
      <Line points={lines.halfway} color={PALETTE.titaniumLight} lineWidth={1} transparent opacity={0.45} />
      <Line points={lines.centre} color={PALETTE.titaniumLight} lineWidth={1} transparent opacity={0.45} />

      <mesh geometry={geometries.seating}>
        <meshStandardMaterial color="#26262a" roughness={0.75} metalness={0.2} />
      </mesh>
      <lineSegments geometry={geometries.seatingEdges}>
        <lineBasicMaterial color={PALETTE.titanium} transparent opacity={0.75} />
      </lineSegments>
      <mesh geometry={geometries.highlight}>
        <meshStandardMaterial
          color={highlightSections ? "#36334a" : "#26262a"}
          emissive={highlightSections ? PALETTE.violet : "#000000"}
          emissiveIntensity={highlightSections ? 0.18 : 0}
          roughness={0.75}
          metalness={0.2}
        />
      </mesh>
      <lineSegments geometry={geometries.highlightEdges}>
        <lineBasicMaterial color={highlightSections ? PALETTE.violet : PALETTE.titanium} transparent opacity={highlightSections ? 0.95 : 0.75} />
      </lineSegments>

      <mesh geometry={geometries.apron}>
        <meshStandardMaterial color="#1d1d20" roughness={0.9} />
      </mesh>
      <mesh geometry={geometries.concourse} position-y={0.004}>
        <meshStandardMaterial color={PALETTE.smoke} roughness={0.95} />
      </mesh>
      {/* Continuous walkable lane, clear of stands, queues and boundary doors. */}
      <mesh geometry={geometries.walkway} position-y={0.009}>
        <meshStandardMaterial color="#3b4743" roughness={0.92} />
      </mesh>
      <Line points={lines.concourseOuter} color={PALETTE.titanium} lineWidth={1} />
      <Line points={lines.concourseInner} color={PALETTE.titanium} lineWidth={1} transparent opacity={0.6} />
      <Line points={lines.circulation} color={PALETTE.titaniumLight} lineWidth={1.2} dashed dashSize={0.35} gapSize={0.22} transparent opacity={0.65} />
      <Line points={lines.walkwayInner} color="#91aaa0" lineWidth={1} transparent opacity={0.65} />
      <Line points={lines.walkwayOuter} color="#91aaa0" lineWidth={1} transparent opacity={0.65} />
      <Line points={lines.basePath} color={PALETTE.titaniumLight} lineWidth={1} transparent opacity={0.45} />
      <mesh geometry={geometries.wall}>
        <meshStandardMaterial color="#2c2c31" roughness={0.6} metalness={0.4} />
      </mesh>

      {detail === "high" && (
        <>
          <mesh geometry={geometries.strut}>
            <meshStandardMaterial color="#34343a" roughness={0.5} metalness={0.6} />
          </mesh>
          <Line points={lines.canopy} color={PALETTE.titaniumLight} lineWidth={1.2} transparent opacity={0.7} />
          <Line points={lines.canopyInner} color={PALETTE.titanium} lineWidth={1} transparent opacity={0.5} />
        </>
      )}

      {lines.exits.map((pts, i) => (
        <Line key={i} points={pts} color={PALETTE.titaniumLight} lineWidth={1.2} transparent opacity={0.5} />
      ))}
      {lines.aisles.map((pts, i) => (
        <Line key={`aisle-${i}`} points={pts} color={PALETTE.titaniumLight} lineWidth={1.4} transparent opacity={0.7} />
      ))}

      {/* Metro station */}
      <group position={[venue.transit.position[0], 0, venue.transit.position[1]]} rotation-y={-transitAngle}>
        <mesh position={[0, 0.45, 0]}>
          <boxGeometry args={[2.2, 0.9, 5]} />
          <meshStandardMaterial color="#232327" roughness={0.6} metalness={0.35} />
        </mesh>
        <mesh position={[0, 0.92, 0]}>
          <boxGeometry args={[2.5, 0.06, 5.4]} />
          <meshStandardMaterial color="#38383e" roughness={0.4} metalness={0.6} />
        </mesh>
        <Line
          points={[
            [1.8, 0.01, -10],
            [1.8, 0.01, 10],
          ]}
          color={PALETTE.titanium}
          lineWidth={1}
        />
        <Line
          points={[
            [2.4, 0.01, -10],
            [2.4, 0.01, 10],
          ]}
          color={PALETTE.titanium}
          lineWidth={1}
        />
      </group>
    </group>
  );
}
