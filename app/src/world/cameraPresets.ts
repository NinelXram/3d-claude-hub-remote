import type { CameraPresetId, ViewInsets } from "@/state/useWorldStore";

export interface CameraPreset {
  id: CameraPresetId;
  label: string;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
}

/** §6.6, authored for a wide, unobstructed view; `fitScale` stretches them for the actual free area. */
export const CAMERA_PRESETS: Record<CameraPresetId, CameraPreset> = {
  overview: { id: "overview", label: "Overview", position: [-1.2, 20, 25], target: [-1.2, 0, 0.8] },
  hub: { id: "hub", label: "Operations Hub", position: [0.6, 7.2, 9.6], target: [0, 1, -2.4] },
  development: { id: "development", label: "Development", position: [8.2, 6.2, 5.6], target: [8.25, 0.6, -2.8] },
  research: { id: "research", label: "Research", position: [-8.2, 6.2, 5.6], target: [-8.25, 0.6, -2.8] },
  collaboration: { id: "collaboration", label: "Collaboration", position: [-3.2, 8.4, 15], target: [-6.8, 0.5, 4.6] },
};

export const CAMERA_PRESET_IDS: CameraPresetId[] = ["overview", "hub", "research", "development", "collaboration"];

export const CAMERA_LIMITS = {
  minDistance: 3.5,
  maxDistance: 70,
  minPolarAngle: 0.18,
  maxPolarAngle: 1.36,
  target: { minX: -14, maxX: 14, minY: 0, maxY: 3, minZ: -8, maxZ: 10 },
} as const;

export const CAMERA_FOV = 40;
/** Narrow free areas widen the fov up to this so the overview still shows the whole office (phase 6). */
export const CAMERA_FOV_MAX = 60;
export const FOCUS_DISTANCE_AGENT = 7.5;
export const FOCUS_DISTANCE_STATION = 6.5;

/** Smallest free area we fit to, so a collapsed layout never divides by ~0. */
const MIN_FREE_PX = 120;

export interface FreeArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function freeArea(width: number, height: number, insets: ViewInsets): FreeArea {
  const left = Math.min(insets.left, width - MIN_FREE_PX);
  const top = Math.min(insets.top, height - MIN_FREE_PX);
  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
    width: Math.max(MIN_FREE_PX, width - insets.left - insets.right),
    height: Math.max(MIN_FREE_PX, height - insets.top - insets.bottom),
  };
}

/** §6.6: `clamp(max(1.17·h/freeW, 0.96·h/freeH), 1, 2.2)`, where h is the canvas height. */
export function fitScale(height: number, free: FreeArea): number {
  const s = Math.max((1.17 * height) / free.width, (0.96 * height) / free.height);
  return Math.min(2.2, Math.max(1, s));
}

export function clampTarget(v: { x: number; y: number; z: number }): boolean {
  const L = CAMERA_LIMITS.target;
  const x = Math.min(L.maxX, Math.max(L.minX, v.x));
  const y = Math.min(L.maxY, Math.max(L.minY, v.y));
  const z = Math.min(L.maxZ, Math.max(L.minZ, v.z));
  const changed = x !== v.x || y !== v.y || z !== v.z;
  v.x = x;
  v.y = y;
  v.z = z;
  return changed;
}
