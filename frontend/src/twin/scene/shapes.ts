import * as THREE from "three";

import { DEG } from "../domain/geometry";
import type { Point2, VenueLayout, ZoneLayout } from "../domain/types";

/**
 * Shapes are drawn in (x, -z) and rotated onto the ground plane so that
 * extrusion depth becomes height (+y).
 */
function toGround(geometry: THREE.BufferGeometry) {
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function sectorShape(rx: number, rz: number, fromDeg: number, toDeg: number, inner: number, outer: number, steps = 24) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= steps; i += 1) {
    const a = (fromDeg + ((toDeg - fromDeg) * i) / steps) * DEG;
    const x = Math.cos(a) * rx * outer;
    const y = -Math.sin(a) * rz * outer;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  for (let i = steps; i >= 0; i -= 1) {
    const a = (fromDeg + ((toDeg - fromDeg) * i) / steps) * DEG;
    shape.lineTo(Math.cos(a) * rx * inner, -Math.sin(a) * rz * inner);
  }
  shape.closePath();
  return shape;
}

export function ellipseShape(cx: number, cz: number, rx: number, rz: number, steps = 48) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const x = cx + Math.cos(a) * rx;
    const y = -(cz + Math.sin(a) * rz);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  return shape;
}

export function flatGeometry(shape: THREE.Shape) {
  return toGround(new THREE.ShapeGeometry(shape));
}

export function extrudedGeometry(shape: THREE.Shape, depth: number) {
  return toGround(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 1 }));
}

export function zoneShape(venue: VenueLayout, zone: ZoneLayout) {
  const { rx, rz } = venue.bowl;
  if (zone.shape.kind === "ring") {
    return sectorShape(rx, rz, zone.shape.fromDeg, zone.shape.toDeg, venue.ring.concourseInner + 0.01, venue.ring.concourseOuter - 0.01, 28);
  }
  const [cx, cz] = zone.shape.center;
  return ellipseShape(cx, cz, zone.shape.radius, zone.shape.radius * 0.8);
}

export function zoneAnchor(venue: VenueLayout, zone: ZoneLayout): Point2 {
  const { rx, rz } = venue.bowl;
  if (zone.shape.kind === "ring") {
    const mid = (zone.shape.labelDeg ?? (zone.shape.fromDeg + zone.shape.toDeg) / 2) * DEG;
    const s = (venue.ring.concourseInner + venue.ring.concourseOuter) / 2;
    return [Math.cos(mid) * rx * s, Math.sin(mid) * rz * s];
  }
  return zone.shape.center;
}

export function ellipsePoints(rx: number, rz: number, scale: number, y: number, steps = 96): [number, number, number][] {
  const pts: [number, number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([Math.cos(a) * rx * scale, y, Math.sin(a) * rz * scale]);
  }
  return pts;
}
