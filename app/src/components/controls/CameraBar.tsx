"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, Crosshair, FlaskConical, LayoutGrid, Network, Users, Video, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getAgent } from "@/agents/AgentRegistry";
import { useWorldStore } from "@/state/useWorldStore";
import type { CameraPresetId } from "@/state/useWorldStore";
import { CAMERA_PRESETS, CAMERA_PRESET_IDS } from "@/world/cameraPresets";
import { useRenderCount } from "@/world/renderCounts";

const ICONS: Record<CameraPresetId, LucideIcon> = {
  overview: LayoutGrid,
  hub: Network,
  research: FlaskConical,
  development: Crosshair,
  collaboration: Users,
};

const SHORT: Record<CameraPresetId, string> = {
  overview: "Overview",
  hub: "Ops Hub",
  research: "Research",
  development: "Development",
  collaboration: "Collaboration",
};

/**
 * Camera presets, floating at the bottom of the free area (§6.6, §7). Also shows and releases follow mode.
 * Landscape phones get one button with an upward menu at the bottom left of the world instead of the row, so
 * it never sits over the top bar or the panel. `.camera-bar` hides itself when the free area gets too short
 * (globals.css), e.g. under a full bottom sheet.
 */
export function CameraBar() {
  useRenderCount("CameraBar");
  const requestCamera = useWorldStore((s) => s.requestCamera);
  const active = useWorldStore((s) => s.camera.preset ?? null);
  const followId = useWorldStore((s) => s.followAgentId);
  const setFollow = useWorldStore((s) => s.setFollow);
  const follow = followId ? getAgent(followId) : null;

  return (
    <div className="camera-bar pointer-events-auto flex max-w-full flex-col items-center gap-2 phl:items-start phl:self-start" data-testid="camera-bar">
      {follow ? (
        <div className="surface flex items-center gap-2 py-1 pl-3 pr-1 text-[12px] text-mist-300" role="status">
          <span className="h-2 w-2 rounded-full" style={{ background: follow.color }} />
          Following <b className="font-semibold text-mist-100">{follow.name}</b>
          <span className="hidden text-mist-500 sm:inline">· drag or Esc to release</span>
          <button type="button" className="btn btn-quiet h-6 px-1.5" onClick={() => setFollow(null)} aria-label="Stop following">
            <X size={13} />
          </button>
        </div>
      ) : null}
      <CompactCameraMenu active={active} />
      <div className="surface flex max-w-full items-center gap-1 overflow-x-auto p-1 phl:hidden" role="toolbar" aria-label="Camera presets">
        {CAMERA_PRESET_IDS.map((id) => {
          const Icon = ICONS[id];
          const pressed = active === id;
          return (
            <button
              key={id}
              type="button"
              className={`btn h-8 px-2.5 ${pressed ? "border-signal/40 bg-ink-600/90 text-mist-100" : "btn-ghost text-mist-300"}`}
              aria-pressed={pressed}
              title={CAMERA_PRESETS[id].label}
              onClick={() => requestCamera({ preset: id })}
            >
              <Icon size={14} />
              <span className="hidden lg:inline">{SHORT[id]}</span>
              <span className="sr-only lg:hidden">{CAMERA_PRESETS[id].label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Landscape phones: the presets behind one button, opening upward over the world. */
function CompactCameraMenu({ active }: { active: CameraPresetId | null }) {
  const requestCamera = useWorldStore((s) => s.requestCamera);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const ActiveIcon = active ? ICONS[active] : Video;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrap} className="relative hidden phl:block">
      <button
        type="button"
        className="btn h-11 gap-1.5 rounded-[14px] bg-ink-850/90 px-3 shadow-[0_10px_28px_-10px_rgb(0_0_0/0.7)] backdrop-blur-md"
        aria-expanded={open}
        aria-controls="aaw-camera-menu"
        onClick={() => setOpen((o) => !o)}
        title="Camera presets"
      >
        <ActiveIcon size={16} />
        <span className="text-[12.5px]">{active ? SHORT[active] : "Camera"}</span>
        <ChevronUp size={14} className={`text-mist-500 transition-transform ${open ? "" : "rotate-180"}`} aria-hidden />
      </button>
      {open ? (
        <div
          id="aaw-camera-menu"
          role="menu"
          aria-label="Camera presets"
          className="surface absolute bottom-[calc(100%+8px)] left-0 z-20 flex w-52 flex-col gap-0.5 bg-ink-900/95 p-1.5 [animation:aaw-rise-in_140ms_ease-out]"
        >
          {CAMERA_PRESET_IDS.map((id) => {
            const Icon = ICONS[id];
            const pressed = active === id;
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={pressed}
                className={`btn h-11 w-full justify-start gap-2.5 px-3 text-[13px] ${pressed ? "border-signal/40 bg-ink-600/90 text-mist-100" : "btn-ghost border-transparent text-mist-300"}`}
                onClick={() => {
                  setOpen(false);
                  requestCamera({ preset: id });
                }}
              >
                <Icon size={15} />
                {CAMERA_PRESETS[id].label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
