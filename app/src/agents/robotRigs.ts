import type { AgentRole } from "./agentTypes.ts";

/**
 * Per-role rig proportions (§6.4), in metres before `scale`. Pure data so both the meshes
 * (`AgentCharacter.tsx`) and the motion/label code can read it without importing each other.
 */
export interface RobotRig {
  /** Uniform scale of the whole robot, 0.96–1.12. */
  scale: number;
  /** Hip pivot height; the legs (thigh + shin + ankle) reach the floor from here. */
  hipY: number;
  thigh: number;
  shin: number;
  /** Half the distance between the hip pivots. */
  hipX: number;
  /** Shoulder pivot above the spine base, and half the shoulder span. */
  shoulderY: number;
  shoulderX: number;
  upperArm: number;
  forearm: number;
  /** Neck pivot above the spine base. */
  headY: number;
  /** Height of the speech-bubble anchor before `scale` (~1.85–2.05). */
  labelY: number;
  /** Height arcs attach to (chest), before `scale`. */
  chestY: number;
}

export const ROBOT_RIGS: Record<AgentRole, RobotRig> = {
  orchestrator: { scale: 1.12, hipY: 0.7, thigh: 0.31, shin: 0.31, hipX: 0.13, shoulderY: 0.5, shoulderX: 0.36, upperArm: 0.26, forearm: 0.25, headY: 0.64, labelY: 2.05, chestY: 1.12 },
  researcher: { scale: 0.98, hipY: 0.66, thigh: 0.29, shin: 0.29, hipX: 0.11, shoulderY: 0.44, shoulderX: 0.29, upperArm: 0.25, forearm: 0.24, headY: 0.58, labelY: 1.88, chestY: 1.05 },
  product_manager: { scale: 1.0, hipY: 0.66, thigh: 0.29, shin: 0.29, hipX: 0.12, shoulderY: 0.46, shoulderX: 0.31, upperArm: 0.25, forearm: 0.24, headY: 0.6, labelY: 1.9, chestY: 1.07 },
  engineer: { scale: 1.04, hipY: 0.66, thigh: 0.29, shin: 0.29, hipX: 0.13, shoulderY: 0.47, shoulderX: 0.34, upperArm: 0.26, forearm: 0.25, headY: 0.61, labelY: 1.92, chestY: 1.08 },
  qa: { scale: 0.96, hipY: 0.6, thigh: 0.26, shin: 0.26, hipX: 0.13, shoulderY: 0.42, shoulderX: 0.33, upperArm: 0.23, forearm: 0.22, headY: 0.55, labelY: 2.0, chestY: 0.98 },
  reviewer: { scale: 1.02, hipY: 0.7, thigh: 0.31, shin: 0.31, hipX: 0.11, shoulderY: 0.5, shoulderX: 0.29, upperArm: 0.27, forearm: 0.26, headY: 0.64, labelY: 1.96, chestY: 1.12 },
};
