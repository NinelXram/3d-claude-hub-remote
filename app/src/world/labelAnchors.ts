import type { AgentId } from "@/agents/agentTypes";

/**
 * Screen-space anchors for the DOM speech bubbles (§6.4). The 3D layer writes them inside `useFrame` (Phase 4:
 * AgentsLayer projects `(x, labelY·scale, z)` through the camera); `AgentLabelsOverlay` reads them from one
 * `requestAnimationFrame` loop. A plain module-level Map: writing it never re-renders React, and nothing
 * here touches three, so the overlay can import it without pulling in the canvas bundle.
 */
export interface LabelAnchor {
  /** CSS pixels from the left of the canvas. */
  x: number;
  /** CSS pixels from the top of the canvas. */
  y: number;
  /** `clamp(6.5 / (2·tan(fov/2)·distance), 0.72, 1.05)`. */
  scale: number;
  /** In front of the camera and inside the viewport. */
  onScreen: boolean;
}

export const labelAnchors = new Map<AgentId, LabelAnchor>();

export const LABEL_SCALE_MIN = 0.72;
export const LABEL_SCALE_MAX = 1.05;

/** Bubble scale from the camera's vertical fov (radians) and the distance to the anchor. */
export function labelScale(fovRad: number, distance: number): number {
  const s = 6.5 / (2 * Math.tan(fovRad / 2) * Math.max(distance, 1e-3));
  return Math.min(LABEL_SCALE_MAX, Math.max(LABEL_SCALE_MIN, s));
}

export function writeLabelAnchor(id: AgentId, x: number, y: number, scale: number, onScreen: boolean): void {
  const a = labelAnchors.get(id);
  if (a) {
    a.x = x;
    a.y = y;
    a.scale = scale;
    a.onScreen = onScreen;
  } else {
    labelAnchors.set(id, { x, y, scale, onScreen });
  }
}
