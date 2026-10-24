"use client";

import { useEffect, useRef } from "react";
import { AGENTS } from "@/agents/AgentRegistry";
import type { AgentId, AgentState } from "@/agents/agentTypes";
import { useShallow } from "zustand/react/shallow";
import { useWorldStore } from "@/state/useWorldStore";
import { labelAnchors } from "@/world/labelAnchors";
import { useRenderCount } from "@/world/renderCounts";

/**
 * DOM speech bubbles (§6.4, pitfall 1: never drei `<Html>`). Content and visibility rules come from the
 * throttled store mirror (name, activity or "Paused", success/error tone); a single `requestAnimationFrame`
 * loop positions every bubble from `labelAnchors`, which the canvas writes each frame. Mounted above the canvas
 * and below the floating UI, `pointer-events: none`. No three import, so it stays out of the canvas bundle.
 */

const SPEECH_STATUSES = new Set(["communicating", "success", "error"]);

const EDGE_PX = 8;

/** The part of the viewport not covered by the floating UI, in CSS pixels. */
interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function freeBounds(): Bounds {
  const i = useWorldStore.getState().viewInsets;
  return { left: i.left, top: i.top, right: window.innerWidth - i.right, bottom: window.innerHeight - i.bottom };
}

/**
 * Positions one bubble over its anchor. A bubble shows only while its anchor is on screen (in front of the
 * camera, inside the canvas) *and* inside the free area: a robot behind the side panel, the bottom sheet or
 * the camera has no bubble. Only then is the bubble's box nudged sideways so a long activity line does not
 * run under the panels; the anchor itself is never clamped onto the screen.
 * `width` is the bubble's unscaled width, read before any writes so a frame costs at most one layout.
 */
function place(el: HTMLDivElement, id: AgentId, width: number, b: Bounds): void {
  const a = labelAnchors.get(id);
  const on = !!a && a.onScreen && a.x >= b.left && a.x <= b.right && a.y >= b.top && a.y <= b.bottom;
  el.style.visibility = on ? "visible" : "hidden";
  if (!a || !on) return;
  const half = (width * a.scale) / 2;
  const lo = b.left + EDGE_PX + half;
  const hi = b.right - EDGE_PX - half;
  const x = lo > hi ? (b.left + b.right) / 2 : Math.min(Math.max(a.x, lo), hi);
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${(a.y - 6).toFixed(1)}px, 0) translate(-50%, -100%) scale(${a.scale.toFixed(3)})`;
}

const widths: number[] = [];

function placeAll(els: Map<AgentId, HTMLDivElement>): void {
  if (els.size === 0) return;
  const b = freeBounds();
  widths.length = 0;
  for (const el of els.values()) widths.push(el.offsetWidth);
  let i = 0;
  for (const [id, el] of els) place(el, id, widths[i++]!, b);
}

/**
 * Why a robot may have a bubble at all: it is selected, hovered or paused, or (with speech indicators on)
 * it is talking, celebrating or reporting an error. Idle, walking, working and thinking robots have none.
 */
type BubbleAgent = Pick<AgentState, "id" | "status" | "paused" | "activity">;

/** One primitive per agent, so `useShallow` can tell "nothing a bubble shows changed". */
function bubbleKey(a: AgentState): string {
  return JSON.stringify([a.id, a.status, a.paused, a.activity]);
}

function parseBubbleKey(key: string): BubbleAgent {
  const [id, status, paused, activity] = JSON.parse(key) as [AgentId, AgentState["status"], boolean, string];
  return { id, status, paused, activity };
}

function wantsBubble(a: BubbleAgent, selected: AgentId | null, hovered: string | null, speech: boolean): boolean {
  if (selected === a.id || hovered === `agent:${a.id}` || a.paused) return true;
  return speech && SPEECH_STATUSES.has(a.status);
}

export function AgentLabelsOverlay() {
  useRenderCount("AgentLabelsOverlay");
  // Just what a bubble shows: progress-only mirror updates (every ~160 ms while agents work) change none of
  // these strings, so the overlay does not re-render for them. Positions never reach React at all.
  const bubbleKeys = useWorldStore(useShallow((s) => s.agents.map(bubbleKey)));
  const selected = useWorldStore((s) => s.selectedAgentId);
  const hovered = useWorldStore((s) => s.hovered);
  const speech = useWorldStore((s) => s.overlays.speech);
  const sceneReady = useWorldStore((s) => s.sceneReady);
  const els = useRef(new Map<AgentId, HTMLDivElement>());

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      placeAll(els.current);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!sceneReady) return null;
  const byId = new Map(bubbleKeys.map(parseBubbleKey).map((a) => [a.id, a] as const));
  return (
    <div className="pointer-events-none absolute inset-0 z-[5] overflow-hidden" aria-hidden="true" data-testid="agent-labels">
      {AGENTS.map((p) => {
        const a = byId.get(p.id);
        if (!a || !wantsBubble(a, selected, hovered, speech)) return null;
        const tone = a.paused ? "" : a.status === "success" ? " agent-bubble-success" : a.status === "error" ? " agent-bubble-error" : "";
        const text = a.paused ? "Paused" : a.activity;
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) {
                els.current.set(p.id, el);
                place(el, p.id, el.offsetWidth, freeBounds());
              } else els.current.delete(p.id);
            }}
            className={`agent-bubble${tone}`}
            style={{ visibility: "hidden", transformOrigin: "50% 100%" }}
            data-agent={p.id}
          >
            <span className="agent-bubble-dot" style={{ background: p.color, boxShadow: `0 0 8px ${p.color}` }} />
            <span className="agent-bubble-name">{p.name}</span>
            {text ? <span className="agent-bubble-activity">{text}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
