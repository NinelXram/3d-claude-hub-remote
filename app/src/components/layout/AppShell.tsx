"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { AGENT_IDS } from "@/agents/AgentRegistry";
import { useSoundEffects } from "@/audio/useSoundEffects";
import { CameraBar } from "@/components/controls/CameraBar";
import type { AgentId } from "@/agents/agentTypes";
import { readDevFlags } from "@/components/layout/devFlags";
import { currentLayoutMode } from "@/components/layout/layoutMode";
import { LoadingScreen } from "@/components/layout/LoadingScreen";
import { NavRail } from "@/components/layout/NavRail";
import { TopBar } from "@/components/layout/TopBar";
import { SidePanel } from "@/components/panels/SidePanel";
import { PermissionStack } from "@/components/sessions/PermissionStack";
import { TaskDialog } from "@/components/panels/TaskDialog";
import { commands, connectBackend } from "@/integrations/backendClient";
import { AgentLabelsOverlay } from "@/world/AgentLabelsOverlay";
import { useWorldStore } from "@/state/useWorldStore";
import type { ViewInsets } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

// Client-only: WebGL cannot render on the server.
const WorldCanvas = dynamic(() => import("@/world/WorldCanvas"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[#080b10]" />,
});

/**
 * Three layouts (layoutMode.ts, notes/mobile.md): desktop (≥ 1024 px: rail, top bar, right column), landscape
 * phones (rail | world | panel) and the bottom sheet below 1024 px otherwise (phase-6 notes: between 768 and
 * 1023 px a 380 px column would leave the world a 300 px slot).
 */
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "range", "button", "submit"].includes(type);
}

/** Pick the quality tier once, before the canvas mounts (§7.2). */
function pickInitialQuality(): void {
  const forced = new URLSearchParams(window.location.search).get("quality");
  const { setQuality } = useWorldStore.getState();
  if (forced === "high" || forced === "low") return setQuality(forced, "url");
  const weak = (navigator.hardwareConcurrency ?? 8) <= 4;
  const reduced = window.matchMedia(REDUCED_MOTION).matches;
  const narrow = window.innerWidth < 768;
  setQuality(weak || reduced || narrow ? "low" : "high", "auto");
}

/** Mirrors `prefers-reduced-motion` into the store and follows changes while the page is open. */
function useReducedMotionPreference(): void {
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION);
    const sync = () => useWorldStore.getState().setReducedMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
}

function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useWorldStore.getState();
      if (st.dialog.open || isTyping(e.target)) return;
      const caps = st.backend;
      const online = caps.connection === "open";
      const simulated = caps.simulated && caps.identified;
      switch (e.key) {
        case " ":
          e.preventDefault();
          if (online) void commands.toggleRun();
          break;
        case "n":
        case "N":
          if (online && simulated) {
            e.preventDefault();
            st.openDialog();
          }
          break;
        case "b":
        case "B":
          if (online && simulated) void commands.loadSprint();
          break;
        case "m":
        case "M":
          st.setSound({ enabled: !st.sound.enabled });
          break;
        case "Escape":
          st.clearSelection();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/**
 * Measures the floating UI and writes the free-area insets the camera fit uses (§6.6). While the bottom sheet
 * is being dragged (`data-dragging` on it) the measure waits: the camera reframes once, when the sheet
 * settles (the sheet fires `aaw:sheet-settled`), instead of on every pointer move.
 */
function useViewInsets(regions: {
  nav: React.RefObject<HTMLElement | null>;
  top: React.RefObject<HTMLElement | null>;
  side: React.RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    const measure = () => {
      if (regions.side.current?.dataset.dragging) return;
      const w = window.innerWidth;
      const h = window.innerHeight;
      const mode = currentLayoutMode();
      const rect = (r: React.RefObject<HTMLElement | null>) => r.current?.getBoundingClientRect() ?? null;
      const nav = rect(regions.nav);
      const top = rect(regions.top);
      const side = rect(regions.side);
      const insets: ViewInsets = { top: 0, right: 0, bottom: 0, left: 0 };
      if (top) insets.top = Math.round(top.bottom);
      if (mode !== "sheet") {
        // Desktop and landscape phones: rail on the left, panel on the right (landscape: the top bar spans
        // the world column only, which the right inset already excludes).
        if (nav) insets.left = Math.round(nav.right);
        if (side) insets.right = Math.round(w - side.left);
      } else {
        // Mobile: the side panel is a bottom sheet and the nav rail a bottom bar.
        const tops = [side, nav].filter((r): r is DOMRect => r !== null).map((r) => r.top);
        if (tops.length) insets.bottom = Math.round(h - Math.min(...tops));
      }
      useWorldStore.getState().setViewInsets(insets);
    };
    const ro = new ResizeObserver(measure);
    for (const r of [regions.nav, regions.top, regions.side]) if (r.current) ro.observe(r.current);
    window.addEventListener("resize", measure);
    window.addEventListener("aaw:sheet-settled", measure);
    measure();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("aaw:sheet-settled", measure);
    };
  }, [regions.nav, regions.top, regions.side]);
}

function Notice() {
  const notice = useWorldStore((s) => s.notice);
  const dismiss = useWorldStore((s) => s.dismissNotice);
  if (!notice) return null;
  return (
    <div
      key={notice.id}
      role={notice.tone === "error" ? "alert" : "status"}
      className={`surface pointer-events-auto flex max-w-[min(520px,100%)] items-start gap-2 px-3 py-2 text-[12.5px] [animation:aaw-rise-in_160ms_ease-out] ${notice.tone === "error" ? "border-bad/40 text-bad" : "text-mist-100"}`}
    >
      <span className="min-w-0 flex-1 leading-snug">{notice.text}</span>
      <button type="button" className="flex-none text-mist-500 hover:text-mist-100" onClick={dismiss} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  );
}

export function AppShell() {
  useRenderCount("AppShell");
  const navRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLElement>(null);
  const sideRef = useRef<HTMLElement>(null);
  const sceneReady = useWorldStore((s) => s.sceneReady);
  const autoStart = useWorldStore((s) => s.autoStart);
  const connection = useWorldStore((s) => s.backend.connection);
  const identified = useWorldStore((s) => s.backend.identified);

  // Sound first, so its listeners exist before the backend's first events (§8).
  useSoundEffects();

  // Mount: quality, then the backend (§7.2).
  useEffect(() => {
    pickInitialQuality();
    return connectBackend();
  }, []);

  useEffect(() => {
    if (sceneReady && autoStart && identified && connection === "open") void commands.autoStartIfReady();
  }, [sceneReady, autoStart, identified, connection]);

  useDevFlags(sceneReady && identified && connection === "open");
  useReducedMotionPreference();
  useKeyboardShortcuts();
  useViewInsets({ nav: navRef, top: topRef, side: sideRef });

  return (
    <div className="fixed inset-0 overflow-hidden bg-ink-950 text-mist-100">
      <div className="absolute inset-0 z-0">
        <WorldCanvas />
      </div>
      <AgentLabelsOverlay />

      {/*
        Phones get 8 px gutters plus the safe areas (notch, home indicator, landscape sides); desktop keeps 12 px.
        Landscape phones (`phl`): a row of rail | grid(top bar over world, panel spanning both rows).
      */}
      <div className="pointer-events-none absolute inset-0 z-10 flex flex-col gap-2 p-2 pb-[max(8px,env(safe-area-inset-bottom))] pl-[max(8px,env(safe-area-inset-left))] pr-[max(8px,env(safe-area-inset-right))] pt-[max(8px,env(safe-area-inset-top))] lg:flex-row lg:gap-3 lg:p-3 lg:pb-[max(12px,env(safe-area-inset-bottom))] phl:flex-row">
        <div className="order-last flex lg:order-first phl:order-first">
          <NavRail ref={navRef} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 lg:gap-3 phl:grid phl:grid-cols-[minmax(0,1fr)_clamp(300px,44vw,380px)] phl:grid-rows-[auto_minmax(0,1fr)]">
          {/* z-20: the phone controls menu drops out of the top bar and must stay over the camera bar and sheet. */}
          <div className="relative z-20 min-w-0 flex-none phl:col-start-1 phl:row-start-1">
            <TopBar ref={topRef} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 lg:flex-row lg:gap-3 phl:contents">
            {/* Free area: the 3D world shows through here; CameraBar floats at its bottom. */}
            <div className="free-area relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-end gap-2 phl:col-start-1 phl:row-start-2" data-testid="free-area">
              <Notice />
              <CameraBar />
              {/*
                Permission asks float over the world on every tab; they cover the camera bar while present. Under
                the bottom sheet the free area can shrink to nothing (sheet at full), so there the layer hangs from
                the top of the free area over the sheet instead of being clipped to it.
              */}
              <div className="pointer-events-none absolute inset-0 z-10 flex justify-center sheet:bottom-auto sheet:h-[calc(100dvh-10rem)]">
                <PermissionStack />
              </div>
            </div>
            <SidePanel ref={sideRef} />
          </div>
        </div>
      </div>

      <TaskDialog />
      <LoadingScreen />
    </div>
  );
}

function useDevFlags(ready: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const flags = readDevFlags(window.location.search);
    const st = useWorldStore.getState();
    if (flags.tab) st.setTab(flags.tab);
    if (flags.dialog) st.openDialog();
    void (async () => {
      if (flags.speed !== null) await commands.setSpeed(flags.speed);
      if (flags.scenario === "demo") await commands.runDemo();
      else if (flags.scenario === "sprint") await commands.loadSprint();
      if (flags.select) {
        const sel = flags.select;
        if ((AGENT_IDS as string[]).includes(sel)) useWorldStore.getState().selectAgent(sel as AgentId, { tab: !flags.tab });
        else useWorldStore.getState().selectTask(sel, { tab: !flags.tab });
      }
      if (flags.tab) useWorldStore.getState().setTab(flags.tab);
    })();
  }, [ready]);
}
