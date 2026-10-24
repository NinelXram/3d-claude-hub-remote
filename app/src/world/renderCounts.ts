"use client";

import { useEffect } from "react";

/**
 * The three-free half of the `?perf` probe (see perfProbe.tsx), so DOM components can count renders without
 * pulling @react-three/fiber into the main bundle.
 */

let enabled: boolean | null = null;

export function perfEnabled(): boolean {
  if (enabled === null) enabled = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("perf");
  return enabled;
}

export const renderCounts: Record<string, number> = {};

/**
 * Counts this component's committed renders while `?perf` is on. It counts from an effect, so it never writes
 * during render and also works in production builds, where `<Profiler>` callbacks are inert.
 */
export function useRenderCount(name: string): void {
  useEffect(() => {
    if (!perfEnabled()) return;
    renderCounts[name] = (renderCounts[name] ?? 0) + 1;
  });
}
