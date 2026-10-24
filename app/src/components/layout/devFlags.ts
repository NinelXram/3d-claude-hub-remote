"use client";

import type { PanelTab } from "@/state/useWorldStore";

/**
 * URL flags for headless checks and screenshots. All are harmless: they only do what a user could do by
 * clicking (run the demo, pick a speed, open a tab, select something). Nothing here is needed in normal use.
 *
 *   ?autodemo           run the demo as soon as the scene is ready
 *   ?autodemo=4         … at 4× (any value in SIM_CONFIG.speeds)
 *   ?autosprint         load the sprint as soon as the scene is ready (accepts a speed the same way)
 *   ?tab=tasks          open a side-panel tab (overview | agents | tasks | activity | sessions | settings)
 *   ?select=T-001       select a task once it exists; ?select=kai selects an agent
 *   ?dialog             open the New task dialog after load
 *   ?stats              publish renderer counters on window.__aawStats and the store on window.__aawStore
 *                       (WorldCanvas; for headless driver scripts)
 *   ?noagents           hide the agents layer, to compare draw calls with and without robots (AgentsLayer)
 *   ?perf               count React renders and time CPU per frame; logs averages every 5 s (perfProbe, renderCounts)
 *
 * `?quality=high|low` is not a dev flag: it is the documented quality override of §7.2.
 */
export interface DevFlags {
  scenario: "demo" | "sprint" | null;
  speed: number | null;
  tab: PanelTab | null;
  select: string | null;
  dialog: boolean;
}

const TABS: readonly PanelTab[] = ["overview", "agents", "tasks", "activity", "sessions", "settings"];

export function readDevFlags(search: string): DevFlags {
  const p = new URLSearchParams(search);
  const scenario = p.has("autodemo") ? "demo" : p.has("autosprint") ? "sprint" : null;
  const raw = p.get("autodemo") ?? p.get("autosprint") ?? "";
  const speed = raw && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const tab = p.get("tab");
  return {
    scenario,
    speed,
    tab: tab && (TABS as readonly string[]).includes(tab) ? (tab as PanelTab) : null,
    select: p.get("select"),
    dialog: p.has("dialog"),
  };
}
