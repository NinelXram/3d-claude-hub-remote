import * as THREE from "three";
import { AGENTS } from "@/agents/AgentRegistry";
import type { AgentId, AgentState, AgentStatus } from "@/agents/agentTypes";
import { ROBOT_RIGS } from "@/agents/robotRigs";
import { liveWorld } from "@/state/useWorldStore";

/**
 * The displayed (smoothed) root of every robot, shared by the meshes, path trails, comm arcs, hit cylinders
 * and bubble anchors so they all agree within a frame (§6.4): position damps towards `liveWorld` with λ 12,
 * heading with λ 9, and a jump of more than 4 m (reset, teleport, late join) snaps. Updated at most once per
 * rendered frame, whichever `useFrame` asks first; plain mutable data, never React state.
 */
export interface AgentDisplay {
  id: AgentId;
  x: number;
  z: number;
  heading: number;
  /** Displayed ground speed, m/s (drives the walk cycle). */
  speed: number;
  status: AgentStatus;
  paused: boolean;
  /** False until the first snapshot placed the robot. */
  init: boolean;
  scale: number;
  /** World heights of the chest (arc anchor) and the bubble anchor. */
  chestY: number;
  labelY: number;
  state: AgentState | null;
}

export const POSITION_LAMBDA = 12;
export const HEADING_LAMBDA = 9;
export const SNAP_DISTANCE = 4;

export const agentDisplay = new Map<AgentId, AgentDisplay>(
  AGENTS.map((a) => {
    const rig = ROBOT_RIGS[a.role];
    return [
      a.id,
      { id: a.id, x: 0, z: 0, heading: 0, speed: 0, status: "idle", paused: false, init: false, scale: rig.scale, chestY: rig.chestY * rig.scale, labelY: rig.labelY * rig.scale, state: null },
    ];
  }),
);

export function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}

let lastKey = -1;
let lastVersion = -1;

/** Advance the displayed roots once per frame. `key` must be unique per frame (the fiber clock's elapsed time). */
export function updateAgentMotion(key: number, dt: number): void {
  if (key === lastKey) return;
  lastKey = key;
  const snap = liveWorld.snapshot;
  if (!snap) return;
  const fresh = liveWorld.version !== lastVersion;
  lastVersion = liveWorld.version;
  for (const a of snap.agents) {
    const d = agentDisplay.get(a.id);
    if (!d) continue;
    d.state = a;
    d.status = a.status;
    d.paused = a.paused;
    const dx = a.position.x - d.x;
    const dz = a.position.z - d.z;
    if (!d.init || (fresh && dx * dx + dz * dz > SNAP_DISTANCE * SNAP_DISTANCE)) {
      d.x = a.position.x;
      d.z = a.position.z;
      d.heading = a.heading;
      d.speed = 0;
      d.init = true;
      continue;
    }
    const px = d.x;
    const pz = d.z;
    d.x = THREE.MathUtils.damp(d.x, a.position.x, POSITION_LAMBDA, dt);
    d.z = THREE.MathUtils.damp(d.z, a.position.z, POSITION_LAMBDA, dt);
    d.heading = dampAngle(d.heading, a.heading, HEADING_LAMBDA, dt);
    const v = Math.hypot(d.x - px, d.z - pz) / Math.max(dt, 1e-3);
    // Light smoothing: 10 Hz network snapshots otherwise make the stride stutter.
    d.speed = THREE.MathUtils.damp(d.speed, v, 10, dt);
  }
}

/**
 * The backend clock now, extrapolated from the last snapshot while running (10 Hz over the network), so comm
 * packets glide instead of stepping. Never extrapolates more than 0.25 s.
 */
export function liveClock(): number {
  const snap = liveWorld.snapshot;
  if (!snap) return 0;
  if (snap.status !== "running") return snap.clock;
  const ahead = Math.min(0.25, Math.max(0, (performance.now() - liveWorld.receivedAt) / 1000));
  return snap.clock + ahead * snap.speed;
}
