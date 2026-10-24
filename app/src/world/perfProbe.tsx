"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { perfEnabled, renderCounts } from "@/world/renderCounts";

export { useRenderCount } from "@/world/renderCounts";

/**
 * Dev-only performance probe behind `?perf` (phase 6). With the flag off every export here is a no-op.
 *
 * - **CPU per frame.** `FrameTimerStart` is mounted first in the scene and `FrameTimerEnd` last, so the time
 *   between them covers every `useFrame` callback of ours (robots, trails, arcs, anchors, camera, screens,
 *   dust). `scene.onAfterRender` closes the `gl.render` call (culling, sorting, uniform uploads and the shadow
 *   pass: CPU-side submission, not GPU time). Both are averaged and logged with `console.info` every 5 s,
 *   and published on `window.__aawPerf`.
 * - **React render counts.** `useRenderCount(name)` (renderCounts.ts) counts committed renders per component;
 *   they are published here. `window.__aawPerf.resetCounts()` starts a fresh window (e.g. while agents walk).
 */

interface PerfWindow {
  frames: number;
  frameMs: number;
  renderMs: number;
  maxFrameMs: number;
}

interface PerfReport {
  /** Average CPU ms per frame in our `useFrame` callbacks. */
  useFrameMs: number;
  /** Average CPU ms per frame inside `gl.render`. */
  renderMs: number;
  /** Worst single frame of `useFrame` work in the window. */
  maxUseFrameMs: number;
  frames: number;
  fps: number;
  calls: number;
  triangles: number;
  renderCounts: Record<string, number>;
  resetCounts: () => void;
}

const timing = { frameStart: 0, frameEnd: 0 };
const win: PerfWindow = { frames: 0, frameMs: 0, renderMs: 0, maxFrameMs: 0 };

export function FrameTimerStart() {
  useFrame(() => {
    if (perfEnabled()) timing.frameStart = performance.now();
  });
  return null;
}

const LOG_EVERY_MS = 5000;

export function FrameTimerEnd() {
  const get = useThree((s) => s.get);
  const gl = useThree((s) => s.gl);
  const windowStart = useRef(0);

  useEffect(() => {
    if (!perfEnabled()) return;
    const scene = get().scene;
    const prev = scene.onAfterRender;
    scene.onAfterRender = (...args) => {
      prev.apply(scene, args);
      if (timing.frameEnd > 0) win.renderMs += performance.now() - timing.frameEnd;
    };
    return () => {
      scene.onAfterRender = prev;
    };
  }, [get]);

  useFrame(() => {
    if (!perfEnabled()) return;
    const now = performance.now();
    timing.frameEnd = now;
    const ms = now - timing.frameStart;
    win.frames++;
    win.frameMs += ms;
    win.maxFrameMs = Math.max(win.maxFrameMs, ms);
    if (windowStart.current === 0) windowStart.current = now;
    if (now - windowStart.current < LOG_EVERY_MS) return;
    const n = Math.max(1, win.frames);
    const report: PerfReport = {
      useFrameMs: +(win.frameMs / n).toFixed(3),
      renderMs: +(win.renderMs / n).toFixed(3),
      maxUseFrameMs: +win.maxFrameMs.toFixed(2),
      frames: win.frames,
      fps: +((win.frames * 1000) / (now - windowStart.current)).toFixed(1),
      calls: gl.info.render.calls,
      triangles: gl.info.render.triangles,
      renderCounts: { ...renderCounts },
      resetCounts: () => {
        for (const k of Object.keys(renderCounts)) delete renderCounts[k];
      },
    };
    (window as unknown as { __aawPerf: PerfReport }).__aawPerf = report;
    console.info(
      `[aaw perf] useFrame ${report.useFrameMs} ms/frame (max ${report.maxUseFrameMs}), gl.render ${report.renderMs} ms/frame, ${report.fps} fps, ${report.calls} calls, ${report.triangles} tris`,
    );
    windowStart.current = now;
    win.frames = 0;
    win.frameMs = 0;
    win.renderMs = 0;
    win.maxFrameMs = 0;
  });
  return null;
}
