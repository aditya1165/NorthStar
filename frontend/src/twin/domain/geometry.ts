import type { Point2 } from "./types";

export const DEG = Math.PI / 180;

/** Point on an ellipse ring. `scale` multiplies the bowl radii. */
export function ringPoint(rx: number, rz: number, angleDeg: number, scale: number): Point2 {
  const a = angleDeg * DEG;
  return [Math.cos(a) * rx * scale, Math.sin(a) * rz * scale];
}

/** Inverse of ringPoint: returns angle (deg, -180..180] and ring scale for a ground point. */
export function ringCoords(rx: number, rz: number, x: number, z: number): { angleDeg: number; scale: number } {
  const nx = x / rx;
  const nz = z / rz;
  return { angleDeg: Math.atan2(nz, nx) / DEG, scale: Math.hypot(nx, nz) };
}

/** Signed shortest angular difference b - a in degrees, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Sample an arc along the ring from `fromDeg` towards `toDeg` (direction as given, no wrapping logic). */
export function ringArc(rx: number, rz: number, fromDeg: number, toDeg: number, scale: number, steps = 24): Point2[] {
  const pts: Point2[] = [];
  for (let i = 0; i <= steps; i += 1) {
    pts.push(ringPoint(rx, rz, fromDeg + ((toDeg - fromDeg) * i) / steps, scale));
  }
  return pts;
}
