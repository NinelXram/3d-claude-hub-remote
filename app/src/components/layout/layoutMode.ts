"use client";

import { useSyncExternalStore } from "react";

/**
 * The three shell layouts (notes/mobile.md). The CSS side is the `phl` / `sheet` custom variants in
 * globals.css plus Tailwind `lg`; these queries must match them.
 * - `desktop`: ≥ 1024 px wide. Left rail, top bar, right column. Unchanged from Phase 6.
 * - `landscape`: a phone on its side (landscape, ≤ 500 px tall, < 1024 px wide). Rail | world | panel.
 * - `sheet`: everything else below 1024 px. Top bar, world, draggable bottom sheet, bottom tab bar.
 */
export type LayoutMode = "desktop" | "landscape" | "sheet";

export const DESKTOP_QUERY = "(min-width: 1024px)";
export const LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 500px) and (max-width: 1023.98px)";

export function currentLayoutMode(): LayoutMode {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia(DESKTOP_QUERY).matches) return "desktop";
  if (window.matchMedia(LANDSCAPE_QUERY).matches) return "landscape";
  return "sheet";
}

function subscribe(onChange: () => void): () => void {
  const queries = [window.matchMedia(DESKTOP_QUERY), window.matchMedia(LANDSCAPE_QUERY)];
  for (const q of queries) q.addEventListener("change", onChange);
  return () => {
    for (const q of queries) q.removeEventListener("change", onChange);
  };
}

/**
 * The current layout, re-rendering only the calling component when it changes (rotation, resize across a
 * breakpoint). Never call it from AppShell or anything that parents the Canvas. The server snapshot is
 * `desktop`; the CSS variants carry the first paint on phones, so this only gates behaviour, not layout.
 */
export function useLayoutMode(): LayoutMode {
  return useSyncExternalStore(subscribe, currentLayoutMode, () => "desktop");
}
