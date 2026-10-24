import type { AgentStatus } from "./agentTypes.ts";

/**
 * Procedural pose blending (§6.4). Pure TypeScript, no three/React: every `AnimationState` is a pure function
 * of (animation time, walk phase, speed, seed) that returns a full `Pose`. The animator keeps one weight per
 * state, damps the weights towards the state the backend reports (frame-rate independent), and returns the
 * weighted sum. Time runs at 0.15× while the agent is paused or the simulation is not running, so a paused
 * world visibly holds still without snapping to a T-pose.
 *
 * Conventions (robot faces +z, joints rotate about their local axes):
 *   pitch < 0 swings a limb forward (+z); knees bend with pitch > 0; spine lean > 0 bends forward;
 *   headPitch > 0 looks down; yaw > 0 turns left (towards +x); roll > 0 tilts towards +x.
 */

export type AnimationState = "idle" | "walk" | "work" | "think" | "talk" | "success" | "error";

export const ANIMATION_STATES: readonly AnimationState[] = ["idle", "walk", "work", "think", "talk", "success", "error"];

export const POSE_KEYS = [
  "bob",
  "lean",
  "twist",
  "sway",
  "headPitch",
  "headYaw",
  "headRoll",
  "lShoulderPitch",
  "lShoulderRoll",
  "lElbow",
  "rShoulderPitch",
  "rShoulderRoll",
  "rElbow",
  "lHip",
  "lKnee",
  "rHip",
  "rKnee",
  /** Chest / eye glow multiplier, 1 = neutral. */
  "glow",
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];
export type Pose = Record<PoseKey, number>;

export interface PoseContext {
  /** Animation time in seconds (already scaled by the freeze factor). */
  t: number;
  /** Walk-cycle phase in radians, advanced by actual ground speed. */
  walkPhase: number;
  /** Ground speed normalised to the configured walk speed (0 standing, ~1 walking). */
  speed: number;
  /** Per-agent constant in [0, 1) so six robots never move in lockstep. */
  seed: number;
  /** Seconds since the current status began (animation time); drives one-shot emotes. */
  sinceStatus: number;
  /**
   * Amplitude of decorative motion: 1 normally, `REDUCED_MOTION` with `prefers-reduced-motion`. It damps sway,
   * breathing, typing, gestures, hops and shakes. Poses themselves (arms up on success, the slump on error, the
   * leg cycle while walking) keep their full size, because they carry information.
   */
  motion: number;
}

/** Decorative-motion amplitude under `prefers-reduced-motion: reduce`. */
export const REDUCED_MOTION = 0.2;

export function neutralPose(): Pose {
  const p = {} as Pose;
  resetPose(p);
  return p;
}

function resetPose(p: Pose): void {
  for (const k of POSE_KEYS) p[k] = 0;
  p.glow = 1;
}

const TAU = Math.PI * 2;

/** Slow, non-repeating wander in about [-1, 1]: a sum of incommensurate sines. */
function wander(t: number, seed: number, rate = 1): number {
  const s = seed * 17.3;
  return 0.55 * Math.sin(t * 0.31 * rate + s) + 0.3 * Math.sin(t * 0.73 * rate + s * 2.1) + 0.15 * Math.sin(t * 1.37 * rate + s * 3.7);
}

/** Smooth 0..1 window that is 1 for `on` seconds out of every `period`, with soft edges. */
function every(t: number, period: number, on: number, offset: number): number {
  const u = (((t + offset * period) % period) + period) % period;
  const edge = Math.min(0.6, on / 3);
  if (u < edge) return smooth(u / edge);
  if (u < on - edge) return 1;
  if (u < on) return smooth((on - u) / edge);
  return 0;
}

function smooth(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

// Pose functions write into `p`, which arrives reset to the neutral pose (no allocation per frame).

function idle(c: PoseContext, p: Pose): void {
  const m = c.motion;
  const breathe = Math.sin(c.t * 1.6 + c.seed * TAU) * m;
  p.bob = breathe * 0.012;
  p.lean = -0.02 + breathe * 0.012;
  p.headYaw = wander(c.t, c.seed, 0.8) * 0.35 * m;
  p.headPitch = -0.04 + wander(c.t + 40, c.seed, 0.6) * 0.06 * m;
  p.headRoll = wander(c.t + 11, c.seed, 0.5) * 0.05 * m;
  p.lShoulderPitch = 0.04 + breathe * 0.03;
  p.rShoulderPitch = 0.04 - breathe * 0.03;
  p.lShoulderRoll = -0.1;
  p.rShoulderRoll = 0.1;
  p.lElbow = -0.18;
  p.rElbow = -0.18;
  // Shift weight from foot to foot now and then.
  const shift = wander(c.t + 7, c.seed, 0.4) * m;
  p.sway = shift * 0.035;
  p.lKnee = Math.max(0, shift) * 0.12;
  p.rKnee = Math.max(0, -shift) * 0.12;
}

function walk(c: PoseContext, p: Pose): void {
  const m = c.motion;
  const amp = Math.min(1.15, c.speed);
  const s = Math.sin(c.walkPhase);
  const s2 = Math.sin(c.walkPhase * 2);
  // The stride stays (it says "walking"); the bounce, twist and sway on top of it are decoration.
  p.bob = (Math.abs(Math.cos(c.walkPhase)) * 0.045 * amp - 0.02 * amp) * m;
  p.lean = 0.07 * amp;
  p.twist = s * 0.09 * amp * m;
  p.sway = s * 0.025 * amp * m;
  p.headPitch = -0.02;
  p.headYaw = -s * 0.06 * amp * m;
  p.lHip = -s * 0.55 * amp;
  p.rHip = s * 0.55 * amp;
  // Knees bend in the swing phase of each leg.
  p.lKnee = Math.max(0, -Math.cos(c.walkPhase + 0.4)) * 0.75 * amp + 0.05;
  p.rKnee = Math.max(0, Math.cos(c.walkPhase + 0.4)) * 0.75 * amp + 0.05;
  const arm = 0.5 * amp * (0.4 + 0.6 * m);
  p.lShoulderPitch = s * arm;
  p.rShoulderPitch = -s * arm;
  p.lShoulderRoll = -0.08;
  p.rShoulderRoll = 0.08;
  p.lElbow = -0.35 - Math.max(0, s) * 0.3 * amp * m;
  p.rElbow = -0.35 - Math.max(0, -s) * 0.3 * amp * m;
  p.glow = 1 + s2 * 0.02 * m;
}

function work(c: PoseContext, p: Pose): void {
  const m = c.motion;
  // Every ~9 s sit back for a moment and glance up at the screens; otherwise type.
  const glance = every(c.t, 9.5, 2.2, c.seed) * m;
  const type = 1 - glance;
  const tapL = Math.sin(c.t * 15 + c.seed * 9) * 0.08 * type * m;
  const tapR = Math.sin(c.t * 15 + c.seed * 9 + 1.9) * 0.08 * type * m;
  p.lean = 0.2 - glance * 0.12;
  p.bob = -0.015 + Math.sin(c.t * 2.2) * 0.004 * m;
  p.headPitch = 0.22 * type - 0.12 * glance;
  p.headYaw = wander(c.t, c.seed, 0.5) * 0.12 * m + glance * 0.18 * Math.sin(c.seed * 20);
  p.lShoulderPitch = -0.95 + tapL + glance * 0.45;
  p.rShoulderPitch = -0.95 + tapR + glance * 0.25;
  p.lShoulderRoll = -0.05;
  p.rShoulderRoll = 0.05;
  p.lElbow = -0.7 + tapL * 1.4 - glance * 0.2;
  p.rElbow = -0.7 + tapR * 1.4 - glance * 0.9;
  p.lKnee = 0.06;
  p.rKnee = 0.06;
  p.glow = 1.25 + Math.sin(c.t * 4.5) * 0.18 * m;
}

function think(c: PoseContext, p: Pose): void {
  const m = c.motion;
  // Hand to chin, other arm across the body; now and then look up and tap the temple instead.
  const look = every(c.t, 11, 3, c.seed + 0.3) * m;
  const tap = Math.max(0, Math.sin(c.t * 7)) * look;
  p.lean = -0.04;
  p.bob = Math.sin(c.t * 1.2 + c.seed * TAU) * 0.01 * m;
  p.headPitch = -0.12 - look * 0.16;
  p.headYaw = wander(c.t, c.seed, 0.45) * 0.3 * m;
  p.headRoll = 0.14 - look * 0.05;
  p.rShoulderPitch = -1.25 - look * 0.75;
  p.rShoulderRoll = -0.32 + look * 0.1;
  p.rElbow = -1.95 + look * 0.4 - tap * 0.15;
  p.lShoulderPitch = -0.45;
  p.lShoulderRoll = 0.4;
  p.lElbow = -1.3;
  p.sway = 0.02;
  p.rKnee = 0.12;
  p.glow = 0.95 + (0.5 + 0.5 * Math.sin(c.t * 2.2) * m) * 0.35;
}

function talk(c: PoseContext, p: Pose): void {
  const m = c.motion;
  const g = Math.sin(c.t * 4.2 + c.seed * 5) * m;
  const g2 = Math.sin(c.t * 2.3 + c.seed * 3) * m;
  p.lean = 0.03;
  p.bob = Math.abs(Math.sin(c.t * 3.4)) * 0.012 * m;
  p.twist = g2 * 0.08;
  p.headPitch = Math.sin(c.t * 3.1) * 0.07 * m;
  p.headYaw = g2 * 0.12;
  // The raised, open hand stays: it is what "talking" looks like from across the room.
  p.rShoulderPitch = -0.95 + g * 0.3;
  p.rShoulderRoll = 0.25 + g2 * 0.15;
  p.rElbow = -0.85 + g * 0.35;
  p.lShoulderPitch = -0.5 - g2 * 0.25;
  p.lShoulderRoll = -0.3;
  p.lElbow = -0.9;
  p.glow = 1.2 + Math.max(0, g) * 0.3;
}

function success(c: PoseContext, p: Pose): void {
  const m = c.motion;
  const k = c.sinceStatus;
  // Two little hops with both arms up in a V, waving. Reduced motion keeps the V, drops most of the hop.
  const hop = Math.max(0, Math.sin(k * 8.5)) * (k < 1.6 ? 1 : 0.4) * m;
  const wave = Math.sin(c.t * 10) * m;
  p.bob = hop * 0.16;
  p.lean = -0.12;
  p.headPitch = -0.28;
  p.lShoulderPitch = -2.75 + wave * 0.12;
  p.rShoulderPitch = -2.75 - wave * 0.12;
  p.lShoulderRoll = -0.45;
  p.rShoulderRoll = 0.45;
  p.lElbow = -0.25;
  p.rElbow = -0.25;
  p.lKnee = (1 - hop) * 0.3;
  p.rKnee = (1 - hop) * 0.3;
  p.lHip = -(1 - hop) * 0.12;
  p.rHip = -(1 - hop) * 0.12;
  p.glow = 1.7;
}

function error(c: PoseContext, p: Pose): void {
  const m = c.motion;
  const k = c.sinceStatus;
  // A short head shake, then a slump: shoulders drop, head down, arms hang. Reduced motion keeps the slump.
  const shake = k < 0.9 ? Math.sin(k * 22) * (0.9 - k) * 0.5 * m : 0;
  p.lean = 0.32;
  p.bob = -0.06;
  p.headPitch = 0.5;
  p.headYaw = shake;
  p.headRoll = -0.1;
  p.sway = -0.03;
  p.lShoulderPitch = 0.12;
  p.rShoulderPitch = 0.12;
  p.lShoulderRoll = 0.08;
  p.rShoulderRoll = -0.08;
  p.lElbow = -0.08;
  p.rElbow = -0.08;
  p.lKnee = 0.22;
  p.rKnee = 0.22;
  p.lHip = -0.12;
  p.rHip = -0.12;
  p.glow = 0.55 + Math.max(0, Math.sin(c.t * 9)) * 0.25 * m;
}

export const POSE_FUNCTIONS: Record<AnimationState, (c: PoseContext, out: Pose) => void> = { idle, walk, work, think, talk, success, error };

export function animationStateFor(status: AgentStatus): AnimationState {
  switch (status) {
    case "walking":
      return "walk";
    case "working":
      return "work";
    case "thinking":
      return "think";
    case "communicating":
      return "talk";
    case "success":
      return "success";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/** Animation speed multiplier: 0.15 when the agent is paused or the simulation is not running. */
export const FROZEN_TIME_SCALE = 0.15;
const WEIGHT_LAMBDA = 7;
/** Full stride (2π) per this many metres at speed 1. */
const STRIDE_M = 1.45;

export class AgentAnimator {
  readonly weights: Record<AnimationState, number> = { idle: 1, walk: 0, work: 0, think: 0, talk: 0, success: 0, error: 0 };
  readonly pose: Pose = neutralPose();
  private time = 0;
  private walkPhase = 0;
  private statusTime = 0;
  private lastState: AnimationState = "idle";
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    this.time = seed * 50;
  }

  /** Reused every frame: the context passed to the pose functions and the scratch pose they write. */
  private readonly ctx: PoseContext = { t: 0, walkPhase: 0, speed: 0, seed: 0, sinceStatus: 0, motion: 1 };
  private readonly scratch: Pose = neutralPose();

  /**
   * Advance by `dt` real seconds and return the blended pose (the same object every call; nothing is
   * allocated). `groundSpeed` is the displayed root's speed in m/s; `walkSpeed` normalises it. `motion` is
   * the decorative-motion amplitude (1, or `REDUCED_MOTION`).
   */
  update(dt: number, status: AgentStatus, frozen: boolean, groundSpeed: number, walkSpeed: number, motion = 1): Pose {
    const k = frozen ? FROZEN_TIME_SCALE : 1;
    const adt = dt * k;
    this.time += adt;
    const state = animationStateFor(status);
    if (state !== this.lastState) {
      this.lastState = state;
      this.statusTime = 0;
    } else this.statusTime += adt;

    const speed = Math.min(1.3, groundSpeed / Math.max(0.01, walkSpeed));
    this.walkPhase += (groundSpeed * adt * TAU) / STRIDE_M;

    const decay = 1 - Math.exp(-WEIGHT_LAMBDA * dt * k);
    let total = 0;
    for (const s of ANIMATION_STATES) {
      const target = s === state ? 1 : 0;
      this.weights[s] += (target - this.weights[s]) * decay;
      total += this.weights[s];
    }

    const ctx = this.ctx;
    ctx.t = this.time;
    ctx.walkPhase = this.walkPhase;
    ctx.speed = state === "walk" ? speed : Math.min(speed, 0.6);
    ctx.seed = this.seed;
    ctx.sinceStatus = this.statusTime;
    ctx.motion = motion;
    const out = this.pose;
    const p = this.scratch;
    for (const key of POSE_KEYS) out[key] = 0;
    for (const s of ANIMATION_STATES) {
      const w = this.weights[s] / (total || 1);
      if (w < 1e-4) continue;
      resetPose(p);
      POSE_FUNCTIONS[s](ctx, p);
      for (const key of POSE_KEYS) out[key] += p[key] * w;
    }
    // Still sliding after the walk ended (the root damps into place): keep the legs honest.
    if (state !== "walk" && speed > 0.2) {
      const s = Math.sin(this.walkPhase) * Math.min(1, speed) * 0.4;
      out.lHip += -s;
      out.rHip += s;
    }
    return out;
  }
}
