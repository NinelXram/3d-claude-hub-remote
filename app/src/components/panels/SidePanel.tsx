"use client";

import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { NAV_ITEMS } from "@/components/layout/NavRail";
import { useLayoutMode } from "@/components/layout/layoutMode";
import { ActivityPanel, AgentsPanel, OverviewPanel, SettingsPanel, TasksPanel } from "@/components/panels/Panels";
import { SessionsPanel } from "@/components/sessions/SessionsPanel";
import { useSessionStore } from "@/state/useSessionStore";
import type { PanelTab } from "@/state/useWorldStore";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

/**
 * Desktop (≥ 1024 px): the right column (380–400 px). Landscape phones: the right column of a two-column grid
 * (300–380 px), full height. Everything else below 1024 px: a bottom sheet with three snap points
 * (notes/mobile.md):
 * - `peek`: the grab handle and the title only, so the world is nearly full screen;
 * - `half`: the default (46 dvh; 56 dvh on Sessions, where a conversation needs room);
 * - `full`: everything between the top bar and the tab bar.
 * Drag the header, or tap it (peek ↔ half, full → half); the chevron goes to full and back. Opening a task, an
 * agent, a session or a tab raises a peeking sheet to half; focusing the Sessions composer goes to full.
 *
 * The height lives on the DOM node, not in React state: a drag writes `style.height` per pointer move and React
 * renders only when the snap point changes. AppShell's inset measure skips while `data-dragging` is set and
 * re-measures on `aaw:sheet-settled`, so the camera reframes once per settle. Nothing here parents the Canvas.
 */
export type SheetSnap = "peek" | "half" | "full";

const HALF_SHARE: Partial<Record<PanelTab, number>> = { sessions: 0.56 };
const HALF_DEFAULT = 0.46;
/** px of travel before a press on the header counts as a drag rather than a tap. */
const DRAG_SLOP = 6;
/** px/ms; a flick faster than this goes to the next snap point in its direction. */
const FLICK = 0.45;

function settled(): void {
  window.dispatchEvent(new Event("aaw:sheet-settled"));
}

export const SidePanel = forwardRef<HTMLElement>(function SidePanel(_props, ref) {
  useRenderCount("SidePanel");
  const tab = useWorldStore((s) => s.tab);
  const title = NAV_ITEMS.find((n) => n.tab === tab)?.label ?? "";
  const sheet = useLayoutMode() === "sheet";
  const [snap, setSnap] = useState<SheetSnap>("half");
  const node = useRef<HTMLElement | null>(null);
  const header = useRef<HTMLDivElement>(null);
  const snapRef = useRef<SheetSnap>(snap);
  const drag = useRef<{ id: number; y0: number; h0: number; y: number; t: number; v: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  const setRefs = useCallback(
    (el: HTMLElement | null) => {
      node.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  /** Snap heights in px for the current viewport and tab. */
  const heights = useCallback((): Record<SheetSnap, number> => {
    const el = node.current;
    const row = el?.parentElement;
    const gap = row ? parseFloat(getComputedStyle(row).rowGap) || 0 : 0;
    const full = Math.max(0, (row?.clientHeight ?? window.innerHeight) - gap);
    // The header plus the sheet's own border: the handle and the title stay whole.
    const borders = el ? el.offsetHeight - el.clientHeight : 2;
    const peek = Math.min(full, (header.current?.offsetHeight ?? 60) + borders);
    const half = Math.max(peek, Math.min(full, Math.round(window.innerHeight * (HALF_SHARE[tab] ?? HALF_DEFAULT))));
    return { peek, half, full };
  }, [tab]);

  const apply = useCallback(
    (to: SheetSnap) => {
      const el = node.current;
      if (!el) return;
      el.style.height = `${heights()[to]}px`;
    },
    [heights],
  );

  // Keep the node's height on its snap point (and off it entirely outside the sheet layout).
  useLayoutEffect(() => {
    snapRef.current = snap;
    const el = node.current;
    if (!el) return;
    if (!sheet) {
      el.style.height = "";
      return;
    }
    apply(snap);
    settled();
    const onResize = () => apply(snapRef.current);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sheet, snap, apply]);

  // Opening something (a task, an agent, a session, a tab) raises a peeking sheet so it can be read.
  useEffect(() => {
    if (!sheet) return;
    const raise = () => {
      if (snapRef.current === "peek") setSnap("half");
    };
    const offWorld = useWorldStore.subscribe((st, prev) => {
      if (st.tab !== prev.tab || (st.selectedTaskId && st.selectedTaskId !== prev.selectedTaskId) || (st.selectedAgentId && st.selectedAgentId !== prev.selectedAgentId)) raise();
    });
    const offSessions = useSessionStore.subscribe((st, prev) => {
      if (st.openId && st.openId !== prev.openId) raise();
    });
    // Typing (the Sessions composer) takes the whole sheet: the keyboard already halves the screen.
    const expand = () => setSnap("full");
    window.addEventListener("aaw:sheet-raise", raise);
    window.addEventListener("aaw:sheet-full", expand);
    return () => {
      offWorld();
      offSessions();
      window.removeEventListener("aaw:sheet-raise", raise);
      window.removeEventListener("aaw:sheet-full", expand);
    };
  }, [sheet]);

  const goTo = (to: SheetSnap) => {
    if (to === snapRef.current) {
      apply(to);
      settled();
    }
    setSnap(to);
  };

  const onTap = () => {
    if (justDragged.current) return;
    goTo(snap === "peek" ? "half" : snap === "half" ? "peek" : "half");
  };

  const onHandleKey = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const order: SheetSnap[] = ["peek", "half", "full"];
    const i = order.indexOf(snap);
    if (e.key === "ArrowUp" && i < 2) {
      e.preventDefault();
      goTo(order[i + 1]);
    } else if (e.key === "ArrowDown" && i > 0) {
      e.preventDefault();
      goTo(order[i - 1]);
    }
  };

  // The press starts on the header; the move and release are followed on the window, because the finger leaves
  // the header at once (pointer capture on press would retarget the tap's click away from the handle).
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = node.current;
    if (!sheet || !el || drag.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    // The chevron is a plain button; only the header surface (and the handle under it) drags.
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    drag.current = { id: e.pointerId, y0: e.clientY, h0: el.getBoundingClientRect().height, y: e.clientY, t: e.timeStamp, v: 0, moved: false };

    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.id) return;
      if (!d.moved) {
        if (Math.abs(ev.clientY - d.y0) < DRAG_SLOP) return;
        d.moved = true;
        el.dataset.dragging = "1";
      }
      ev.preventDefault();
      const dt = Math.max(1, ev.timeStamp - d.t);
      // Upward is positive; a light low-pass keeps one jittery event from deciding the flick.
      d.v = 0.6 * ((d.y - ev.clientY) / dt) + 0.4 * d.v;
      d.y = ev.clientY;
      d.t = ev.timeStamp;
      const h = heights();
      el.style.height = `${Math.min(h.full, Math.max(h.peek, d.h0 + (d.y0 - ev.clientY)))}px`;
    };
    const onEnd = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d || ev.pointerId !== d.id) return;
      drag.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      if (!d.moved) return;
      delete el.dataset.dragging;
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false), 0);
      const h = heights();
      const now = el.getBoundingClientRect().height;
      const order: SheetSnap[] = ["peek", "half", "full"];
      let to: SheetSnap;
      if (d.v > FLICK) to = order.find((s) => h[s] > now + 1) ?? "full";
      else if (d.v < -FLICK) to = [...order].reverse().find((s) => h[s] < now - 1) ?? "peek";
      else to = order.reduce((best, s) => (Math.abs(h[s] - now) < Math.abs(h[best] - now) ? s : best), "half" as SheetSnap);
      goTo(to);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const full = snap === "full";
  const halfClass = tab === "sessions" ? "h-[56dvh]" : "h-[46dvh]";

  return (
    <aside
      ref={setRefs}
      aria-label={`${title} panel`}
      data-testid="side-panel"
      data-sheet={sheet ? snap : undefined}
      className={`surface pointer-events-auto relative flex ${halfClass} min-h-0 w-full flex-none flex-col overflow-hidden transition-[height] duration-[260ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[dragging]:transition-none motion-reduce:transition-none lg:h-auto lg:w-[clamp(380px,28vw,400px)] lg:transition-none phl:col-start-2 phl:row-span-2 phl:row-start-1 phl:h-auto phl:w-auto phl:transition-none`}
    >
      <div
        ref={header}
        className="relative flex-none sheet:touch-none sheet:select-none"
        onPointerDown={onPointerDown}
      >
        {/* The whole header is the grab handle on the sheet: a 60 px tall target; tap toggles, drag resizes. */}
        <button
          type="button"
          className="absolute inset-0 hidden cursor-grab justify-center pt-1.5 outline-none focus-visible:bg-ink-700/40 active:cursor-grabbing sheet:flex"
          onClick={onTap}
          onKeyDown={onHandleKey}
          aria-label={snap === "peek" ? `Show the ${title} panel` : `Collapse the ${title} panel`}
          aria-expanded={snap !== "peek"}
          title="Drag to resize; tap to show or collapse"
          data-testid="sheet-handle"
        >
          <span className="h-1 w-10 rounded-full bg-mist-500/50" aria-hidden />
        </button>
        <div className="pointer-events-none relative flex h-11 items-center border-b border-mist-500/10 px-4 sheet:mt-3.5 phl:h-9">
          <h2 className="text-[13px] font-semibold tracking-tight text-mist-100">{title}</h2>
        </div>
        <button
          type="button"
          data-no-drag
          className="btn btn-quiet absolute bottom-0 right-1 hidden size-11 px-0 sheet:inline-flex"
          onClick={() => goTo(full ? "half" : "full")}
          aria-label={full ? "Shrink the panel" : "Expand the panel"}
          title={full ? "Shrink" : "Expand"}
        >
          {full ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
        </button>
      </div>
      {tab === "sessions" ? (
        <div key={tab} inert={sheet && snap === "peek"} className="flex min-h-0 flex-1 flex-col overflow-hidden [animation:aaw-fade-in_160ms_ease-out]">
          <SessionsPanel />
        </div>
      ) : (
        <div key={tab} inert={sheet && snap === "peek"} className="scroll-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-4 [animation:aaw-fade-in_160ms_ease-out]">
          {tab === "overview" ? <OverviewPanel /> : tab === "agents" ? <AgentsPanel /> : tab === "tasks" ? <TasksPanel /> : tab === "activity" ? <ActivityPanel /> : <SettingsPanel />}
        </div>
      )}
    </aside>
  );
});
