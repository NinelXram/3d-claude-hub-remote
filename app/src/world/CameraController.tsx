"use client";

import { useRef } from "react";
import type { ComponentRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { liveWorld, useWorldStore } from "@/state/useWorldStore";
import type { FreeArea } from "@/world/cameraPresets";
import type { CameraRequest } from "@/state/useWorldStore";
import { CAMERA_FOV, CAMERA_FOV_MAX, CAMERA_LIMITS, CAMERA_PRESETS, clampTarget, fitScale, freeArea } from "@/world/cameraPresets";
import { pointerState } from "@/world/InteractionManager";
import { useRenderCount } from "@/world/renderCounts";

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

/**
 * §6.6. drei OrbitControls with damping for the user; programmatic moves (presets, focus, follow) damp the
 * orbit target (λ 4), the orbit angles (λ 4) and the distance (λ 2) towards a goal, frame-rate independent.
 * Any drag or wheel cancels the move; a drag also releases follow mode. With reduced motion the moves cut.
 *
 * Fit by free area: the projection is shifted with `setViewOffset` so the orbit target sits in the middle
 * of the area the floating UI leaves uncovered, and preset/focus distances are multiplied by `fitScale`.
 */

interface Goal {
  target: THREE.Vector3;
  theta: number;
  phi: number;
  distance: number;
}

const TARGET_LAMBDA = 4;
const ANGLE_LAMBDA = 4;
const DISTANCE_LAMBDA = 2;
const FOLLOW_LAMBDA = 4;
const FOLLOW_HEIGHT = 1;

const tmpOffset = new THREE.Vector3();
const tmpSpherical = new THREE.Spherical();
const tmpBefore = new THREE.Vector3();
const tmpWanted = new THREE.Vector3();

function clampDistance(d: number): number {
  return Math.min(CAMERA_LIMITS.maxDistance, Math.max(CAMERA_LIMITS.minDistance, d));
}

function clampPhi(phi: number): number {
  return Math.min(CAMERA_LIMITS.maxPolarAngle, Math.max(CAMERA_LIMITS.minPolarAngle, phi));
}

/** Shortest signed difference b − a on the circle. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function goalFor(request: CameraRequest, fit: number, overview: OverviewFrame, camera: THREE.Camera, target: THREE.Vector3): Goal | null {
  if (request.preset) {
    const p = CAMERA_PRESETS[request.preset];
    const t = new THREE.Vector3(...p.target);
    if (request.preset === "overview") {
      fit = overview.scale;
      t.x += overview.dx;
    }
    tmpOffset.set(p.position[0] - p.target[0], p.position[1] - p.target[1], p.position[2] - p.target[2]);
    tmpSpherical.setFromVector3(tmpOffset);
    return { target: t, theta: tmpSpherical.theta, phi: clampPhi(tmpSpherical.phi), distance: clampDistance(tmpSpherical.radius * fit) };
  }
  if (request.focus) {
    const t = new THREE.Vector3(request.focus.x, request.focus.y, request.focus.z);
    clampTarget(t);
    tmpOffset.subVectors(camera.position, target);
    tmpSpherical.setFromVector3(tmpOffset);
    const distance = (request.distance ?? tmpSpherical.radius / fit) * fit;
    // Keep the user's bearing, but never look along the floor when focusing something small.
    return { target: t, theta: tmpSpherical.theta, phi: clampPhi(Math.min(tmpSpherical.phi, 1.05)), distance: clampDistance(distance) };
  }
  return null;
}

/** Floor corners plus the top of the window wall: what "the whole office" means for the overview. */
const OFFICE_EXTENT: readonly [number, number, number][] = [
  [-15, 0, -9.5],
  [15, 0, -9.5],
  [-15, 0, 11.6],
  [15, 0, 11.6],
  [-15, 4.4, -9.5],
  [15, 4.4, -9.5],
];
const FRAME_MARGIN_PX = 14;
/** The CameraBar floats at the bottom of the free area; keep the office's front edge above it. */
const CAMERA_BAR_PX = 56;
const probeVec = new THREE.Vector3();
/** The overview's scale at the 70 m distance limit. */
const OVERVIEW_MAX_SCALE =
  CAMERA_LIMITS.maxDistance / Math.hypot(...CAMERA_PRESETS.overview.position.map((v, i) => v - CAMERA_PRESETS.overview.target[i]!));
const probeTarget = new THREE.Vector3();

interface OverviewFrame {
  /** Distance multiplier for the preset offset. */
  scale: number;
  /** Sideways nudge of the preset (target and camera) in metres, centring the office in the free area. */
  dx: number;
  /** False when even the largest scale (the 70 m `maxDistance`) leaves part of the office outside. */
  fits: boolean;
}

/**
 * The overview must show the whole office. Its scale is the smallest one (≥ `fitScale`, in 2 % steps) at
 * which every office corner projects inside the free area, allowing a sideways nudge of up to ±3 m so the
 * office sits centred instead of being pushed out by perspective. `camera` must already carry the view offset.
 */
function overviewFrame(base: number, camera: THREE.PerspectiveCamera, width: number, height: number, free: FreeArea): OverviewFrame {
  const p = CAMERA_PRESETS.overview;
  const target = new THREE.Vector3(...p.target);
  const offset = new THREE.Vector3(...p.position).sub(target);
  const probe = camera.clone();
  const maxScale = OVERVIEW_MAX_SCALE;
  const L = free.left + FRAME_MARGIN_PX;
  const R = free.left + free.width - FRAME_MARGIN_PX;
  const T = free.top + FRAME_MARGIN_PX;
  const B = free.top + free.height - FRAME_MARGIN_PX - CAMERA_BAR_PX;
  // 2 % steps, and the last step lands exactly on the distance limit.
  for (let step = Math.min(base, maxScale); ; step += 0.02) {
    const k = Math.min(step, maxScale);
    let best: OverviewFrame | null = null;
    let bestOff = Infinity;
    for (let dx = -3; dx <= 3 + 1e-6; dx += 0.1) {
      probe.position.copy(target).addScaledVector(offset, k);
      probe.position.x += dx;
      probeTarget.copy(target);
      probeTarget.x += dx;
      probe.lookAt(probeTarget);
      probe.updateMatrixWorld(true);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [x, y, z] of OFFICE_EXTENT) {
        probeVec.set(x, y, z).project(probe);
        const px = ((probeVec.x + 1) / 2) * width;
        const py = ((1 - probeVec.y) / 2) * height;
        minX = Math.min(minX, px);
        maxX = Math.max(maxX, px);
        minY = Math.min(minY, py);
        maxY = Math.max(maxY, py);
      }
      if (minX < L || maxX > R || minY < T || maxY > B) continue;
      const off = Math.abs((minX + maxX) / 2 - (L + R) / 2);
      if (off < bestOff) {
        bestOff = off;
        best = { scale: k, dx, fits: true };
      }
    }
    if (best) return best;
    if (k >= maxScale) break;
  }
  return { scale: maxScale, dx: 0, fits: false };
}

/**
 * Narrow free areas (phones, a 520 px window) cannot show the 30 m office at fov 40 within the 70 m distance
 * limit: the floor's side corners fall off screen. Widen the vertical fov in 1° steps, up to `CAMERA_FOV_MAX`,
 * until the overview fits at the distance limit, then search the overview again at that fov. Wide layouts
 * keep fov 40. Mutates `camera.fov` (and its projection) and returns the overview frame for it.
 */
function fitFovAndOverview(base: number, camera: THREE.PerspectiveCamera, width: number, height: number, free: FreeArea): OverviewFrame {
  camera.fov = CAMERA_FOV;
  camera.updateProjectionMatrix();
  const frame = overviewFrame(base, camera, width, height, free);
  if (frame.fits) return frame;
  for (let fov = CAMERA_FOV + 1; fov <= CAMERA_FOV_MAX; fov++) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
    // Only the distance limit matters here: did this fov make the office fit at all?
    if (overviewFrame(OVERVIEW_MAX_SCALE, camera, width, height, free).fits) return overviewFrame(base, camera, width, height, free);
  }
  return overviewFrame(base, camera, width, height, free);
}

/** Last computed fit, for the `?stats` debug readout. */
export const cameraFitInfo = { fit: 1, overviewScale: 1, overviewDx: 0, overviewFits: true, fov: CAMERA_FOV, free: { left: 0, top: 0, width: 0, height: 0 } as FreeArea };

export function CameraController() {
  useRenderCount("CameraController");
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const reducedMotion = useWorldStore((s) => s.reducedMotion);

  const state = useRef({
    goal: null as Goal | null,
    nonce: -1,
    lastRequest: null as CameraRequest | null,
    /** The user moved the camera since the last preset; layout changes then no longer refit it. */
    userMoved: false,
    dragNonce: 0,
    wheelNonce: 0,
    fitKey: "",
    fit: 1,
    overview: { scale: 1, dx: 0, fits: true } as OverviewFrame,
    initialised: false,
  });

  useFrame((frame, rawDelta) => {
    const c = controls.current;
    if (!c) return;
    const dt = Math.min(rawDelta, 0.1);
    const s = state.current;
    const store = useWorldStore.getState();
    const { width, height } = frame.size;
    if (width <= 0 || height <= 0) return;

    // 1. Free-area fit: shift the projection centre and refit the last preset when the layout changes.
    const insets = store.viewInsets;
    const key = `${width}x${height}|${insets.top},${insets.right},${insets.bottom},${insets.left}`;
    if (key !== s.fitKey) {
      s.fitKey = key;
      const free = freeArea(width, height, insets);
      s.fit = fitScale(height, free);
      const cx = free.left + free.width / 2;
      const cy = free.top + free.height / 2;
      camera.setViewOffset(width, height, width / 2 - cx, height / 2 - cy, width, height);
      camera.updateProjectionMatrix();
      s.overview = fitFovAndOverview(s.fit, camera, width, height, free);
      cameraFitInfo.fit = s.fit;
      cameraFitInfo.overviewFits = s.overview.fits;
      cameraFitInfo.fov = camera.fov;
      cameraFitInfo.overviewScale = s.overview.scale;
      cameraFitInfo.overviewDx = s.overview.dx;
      cameraFitInfo.free = free;
      if (s.lastRequest && !s.userMoved) {
        s.goal = goalFor(s.lastRequest, s.fit, s.overview, camera, c.target);
      }
    }

    // 2. New request from the store.
    const request = store.camera;
    if (request.nonce !== s.nonce) {
      s.nonce = request.nonce;
      s.lastRequest = request;
      s.userMoved = false;
      s.goal = goalFor(request, s.fit, s.overview, camera, c.target);
      if (request.preset && store.followAgentId) store.setFollow(null);
    }

    // 3. The user takes over: a drag cancels the move and releases follow; the wheel only cancels the move.
    if (pointerState.dragNonce !== s.dragNonce) {
      s.dragNonce = pointerState.dragNonce;
      s.goal = null;
      s.userMoved = true;
      if (store.followAgentId) store.setFollow(null);
    }
    if (pointerState.wheelNonce !== s.wheelNonce) {
      s.wheelNonce = pointerState.wheelNonce;
      s.goal = null;
      s.userMoved = true;
    }

    const target = c.target;

    // First frame: snap to the fitted goal instead of flying in from the Canvas default.
    if (!s.initialised && s.goal) {
      s.initialised = true;
      const g = s.goal;
      target.copy(g.target);
      tmpSpherical.set(g.distance, g.phi, g.theta);
      camera.position.copy(target).add(tmpOffset.setFromSpherical(tmpSpherical));
      camera.lookAt(target);
      s.goal = null;
      return;
    }

    tmpBefore.copy(target);

    // 4. Follow: the target damps to the agent each frame and the camera keeps its offset.
    const followId = store.followAgentId;
    const agent = followId ? liveWorld.snapshot?.agents.find((a) => a.id === followId) : undefined;
    if (agent) {
      tmpWanted.set(agent.position.x, FOLLOW_HEIGHT, agent.position.z);
      clampTarget(tmpWanted);
      if (s.goal) s.goal.target.copy(tmpWanted);
      else {
        target.x = THREE.MathUtils.damp(target.x, tmpWanted.x, FOLLOW_LAMBDA, dt);
        target.y = THREE.MathUtils.damp(target.y, tmpWanted.y, FOLLOW_LAMBDA, dt);
        target.z = THREE.MathUtils.damp(target.z, tmpWanted.z, FOLLOW_LAMBDA, dt);
        camera.position.add(tmpOffset.subVectors(target, tmpBefore));
      }
    }

    // 5. Programmatic move.
    const g = s.goal;
    if (g) {
      tmpOffset.subVectors(camera.position, target);
      tmpSpherical.setFromVector3(tmpOffset);
      // Reduced motion: presets and focus cut straight to the goal instead of flying there.
      const snap = store.reducedMotion;
      target.x = snap ? g.target.x : THREE.MathUtils.damp(target.x, g.target.x, TARGET_LAMBDA, dt);
      target.y = snap ? g.target.y : THREE.MathUtils.damp(target.y, g.target.y, TARGET_LAMBDA, dt);
      target.z = snap ? g.target.z : THREE.MathUtils.damp(target.z, g.target.z, TARGET_LAMBDA, dt);
      const k = snap ? 1 : 1 - Math.exp(-ANGLE_LAMBDA * dt);
      const dTheta = angleDelta(tmpSpherical.theta, g.theta);
      tmpSpherical.theta += dTheta * k;
      tmpSpherical.phi += (g.phi - tmpSpherical.phi) * k;
      tmpSpherical.radius = snap ? g.distance : THREE.MathUtils.damp(tmpSpherical.radius, g.distance, DISTANCE_LAMBDA, dt);
      camera.position.copy(target).add(tmpOffset.setFromSpherical(tmpSpherical));
      const settled =
        target.distanceTo(g.target) < 0.01 && Math.abs(dTheta) < 0.002 && Math.abs(g.phi - tmpSpherical.phi) < 0.002 && Math.abs(g.distance - tmpSpherical.radius) < 0.02;
      if (settled && !agent) s.goal = null;
    }

    // 6. Keep the orbit target inside the office; panning past the edge drags the camera along the limit.
    tmpWanted.copy(target);
    if (clampTarget(target)) camera.position.add(tmpOffset.subVectors(target, tmpWanted));
    camera.lookAt(target);
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping={!reducedMotion}
      dampingFactor={0.08}
      minDistance={CAMERA_LIMITS.minDistance}
      maxDistance={CAMERA_LIMITS.maxDistance}
      minPolarAngle={CAMERA_LIMITS.minPolarAngle}
      maxPolarAngle={CAMERA_LIMITS.maxPolarAngle}
      zoomSpeed={0.8}
      rotateSpeed={0.6}
      panSpeed={0.8}
    />
  );
}
