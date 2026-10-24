"use client";

import { useCallback, useEffect, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { useWorldStore } from "@/state/useWorldStore";
import { CAMERA_FOV, CAMERA_PRESETS } from "@/world/cameraPresets";
import { AgentsLayer, LabelAnchorWriter } from "@/world/AgentsLayer";
import { CameraController, cameraFitInfo } from "@/world/CameraController";
import { InteractionManager } from "@/world/InteractionManager";
import { Lighting } from "@/world/Lighting";
import { OfficeEnvironment } from "@/world/OfficeEnvironment";
import { Workstations } from "@/world/Workstations";
import { FrameTimerEnd, FrameTimerStart, useRenderCount } from "@/world/perfProbe";

/**
 * §6.1. One Canvas for the page's lifetime: it is never keyed or remounted on quality (pitfall 2); `shadows`
 * and `dpr` are reactive props and the environment/shadow/skyline components read quality from the store.
 * AppShell loads this file with `next/dynamic` + `ssr: false`.
 */

/** Flips `sceneReady` once three frames have actually rendered (drives the loading screen). */
function ReadySignal() {
  const frames = useRef(0);
  const done = useRef(false);
  useFrame(() => {
    if (done.current) return;
    if (++frames.current >= 3) {
      done.current = true;
      useWorldStore.getState().setSceneReady(true);
    }
  });
  return null;
}

/**
 * Debug only, behind `?stats`: publishes the renderer's per-frame counters on `window.__aawStats` once a
 * second (draw calls include the shadow pass). Read after render, so the numbers describe a whole frame.
 */
function RenderStats() {
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("stats")) return;
    // Headless verification only: lets a driver script issue the same store actions a click would.
    (window as unknown as { __aawStore: unknown }).__aawStore = useWorldStore;
    const id = setInterval(() => {
      const { calls, triangles, points, lines } = gl.info.render;
      const { geometries, textures } = gl.info.memory;
      const st = useWorldStore.getState();
      (window as unknown as { __aawStats: unknown }).__aawStats = {
        calls,
        triangles,
        points,
        lines,
        geometries,
        textures,
        programs: gl.info.programs?.length ?? 0,
        quality: st.quality,
        qualitySource: st.qualitySource,
        dpr: gl.getPixelRatio(),
        shadows: gl.shadowMap.enabled,
        camera: { ...cameraFitInfo, free: { ...cameraFitInfo.free }, fovNow: (get().camera as THREE.PerspectiveCamera).fov },
      };
    }, 1000);
    return () => clearInterval(id);
  }, [gl, get]);
  return null;
}

// Module constants: R3F compares these props on every render, and stable objects make that trivially true.
const OVERVIEW = CAMERA_PRESETS.overview.position;
const CAMERA_OPTIONS = { position: [OVERVIEW[0], OVERVIEW[1], OVERVIEW[2]] as [number, number, number], fov: CAMERA_FOV, near: 0.1, far: 220 };
const GL_OPTIONS = { antialias: true, powerPreference: "high-performance" as const };
const DPR_HIGH: [number, number] = [1, 1.75];
const DPR_LOW: [number, number] = [1, 1.2];
/** Consecutive PerformanceMonitor declines (each ≈ 2.5 s below 40 fps) before switching to low. */
const DECLINES_TO_FALLBACK = 2;

export default function WorldCanvas() {
  const high = useWorldStore((s) => s.quality === "high");
  const declines = useRef(0);
  useRenderCount("WorldCanvas");

  /**
   * §6.1 asks for `flipflops={2}` + `onFallback`. drei counts *every* incline and decline as a flip, and a
   * steady 60 Hz display reads as ~64 fps (N timestamps over N−1 intervals), so a fast laptop "inclines"
   * every 2.5 s and would hit onFallback, and drop to low, after about 7.5 s. Only sustained declines count
   * here; any incline resets the streak.
   */
  const onDecline = useCallback(() => {
    if (++declines.current < DECLINES_TO_FALLBACK) return;
    const st = useWorldStore.getState();
    // An explicit choice (Settings or ?quality=) wins over the frame-rate monitor.
    if (st.qualitySource === "user" || st.qualitySource === "url") return;
    if (st.quality !== "low") st.setQuality("low", "fallback");
  }, []);
  const onIncline = useCallback(() => {
    declines.current = 0;
  }, []);

  return (
    <div className="absolute inset-0" data-testid="world-canvas">
      <Canvas
        shadows={high ? "percentage" : false}
        dpr={high ? DPR_HIGH : DPR_LOW}
        camera={CAMERA_OPTIONS}
        gl={GL_OPTIONS}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.15;
        }}
        aria-label="3D office: six AI agents' stations, the operations hub, mission control and meeting areas"
        role="img"
      >
        <color attach="background" args={["#080b10"]} />
        <fog attach="fog" args={["#0a0e15", 48, 130]} />
        <PerformanceMonitor onDecline={onDecline} onIncline={onIncline}>
          <FrameTimerStart />
          <Lighting />
          <OfficeEnvironment />
          <Workstations />
          <AgentsLayer />
          <InteractionManager />
          <CameraController />
          {/* After the camera: anchors must be projected with this frame's camera. */}
          <LabelAnchorWriter />
          <ReadySignal />
          <RenderStats />
          <FrameTimerEnd />
        </PerformanceMonitor>
      </Canvas>
    </div>
  );
}
