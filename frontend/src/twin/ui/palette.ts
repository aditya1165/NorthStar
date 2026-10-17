import type { RiskLevel } from "../domain/types";

/** Shared colour tokens for the 3D scene. Mirrors the CSS custom properties in index.css. */
export const PALETTE = {
  void: "#0a0a0b",
  graphite: "#111113",
  smoke: "#161618",
  slab: "#1a1a1d",
  slabEdge: "#2b2b2f",
  titanium: "#3c3c41",
  titaniumLight: "#5a5a60",
  pitch: "#141614",
  warmWhite: "#f1ede6",
  titaniumText: "#9b9890",
  silver: "#c8cacf",
  violet: "#8c84c4",
  orange: "#ee7a26",
  vermilion: "#c8371f",
  green: "#5fae88",
} as const;

export const RISK_COLOR: Record<RiskLevel, string> = {
  normal: PALETTE.green,
  elevated: "#ead9a6",
  high: PALETTE.orange,
  critical: PALETTE.vermilion,
};
