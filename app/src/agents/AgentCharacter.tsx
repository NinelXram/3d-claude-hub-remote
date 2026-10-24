"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { AgentAnimator, REDUCED_MOTION } from "@/agents/AgentAnimator";
import type { Pose } from "@/agents/AgentAnimator";
import { AGENTS } from "@/agents/AgentRegistry";
import type { AgentProfile, AgentRole } from "@/agents/agentTypes";
import { ROBOT_RIGS } from "@/agents/robotRigs";
import type { RobotRig } from "@/agents/robotRigs";
import { SIM_CONFIG } from "@/simulation/simulationConfig";
import { liveWorld, useWorldStore } from "@/state/useWorldStore";
import { agentDisplay, updateAgentMotion } from "@/world/agentMotion";
import { blobTexture } from "@/world/proceduralTextures";
import { geometries, materials, sharedGeometry, sharedMaterial } from "@/world/sharedResources";
import { useRenderCount } from "@/world/renderCounts";

/**
 * Procedural robots (§6.4). Each role has its own rig (proportions from `robotRigs.ts`) and silhouette:
 *   Orion (orchestrator)  tall, broad shoulders with pauldrons, a glowing crown over the visor
 *   Iris  (researcher)    slim, round head with a telescope lens over one eye, backpack antenna
 *   Piper (PM)            boxy head with an antenna, a glowing tablet strapped to her arm
 *   Kai   (engineer)      chunky, full-face visor, over-the-head headset with ear cups and a mic boom
 *   Quinn (QA)            short and stout, barrel body, wrap-around visor, twin sensor stalks
 *   Rex   (reviewer)      tall and narrow, tall head with a brow ledge, a big monocle, collar and bow tie
 *
 * Rendering: every robot is a small bone hierarchy (plain Object3Ds, never in the scene) driven by
 * `AgentAnimator`. The visible parts of all six robots are grouped by (geometry, material) into shared
 * InstancedMeshes, so the whole cast costs about 20 draw calls (plus the shadow pass) instead of ~150, and every
 * geometry and material comes from the shared pools. Per-agent colour is per-instance colour.
 */

type V3 = readonly [number, number, number];
type GeoKey = "soft" | "box" | "limb" | "capsule" | "sphere" | "cyl" | "cone" | "torus" | "arc";
type MatKey = "shell" | "paint" | "joint" | "visor" | "glow";
type BoneKey = "body" | "hips" | "lHip" | "lKnee" | "rHip" | "rKnee" | "spine" | "head" | "lShoulder" | "lElbow" | "rShoulder" | "rElbow";

interface Part {
  g: GeoKey;
  m: MatKey;
  b: BoneKey;
  p: V3;
  s: V3;
  r?: V3;
  /** Brightness multiplier for glow parts. */
  k?: number;
  /** Shell tone: limbs use the light tone so the agent colour reads on the torso and head. */
  light?: boolean;
}

const GEOMETRY: Record<GeoKey, () => THREE.BufferGeometry> = {
  soft: () => sharedGeometry("robot:soft", () => new RoundedBoxGeometry(1, 1, 1, 3, 0.22)),
  box: () => geometries.box(),
  /** Capsule 2.6 tall (1.6 + two 0.5 caps): scaled per limb so the caps stay round enough. */
  limb: () => sharedGeometry("robot:limb", () => new THREE.CapsuleGeometry(0.5, 1.6, 4, 12)),
  capsule: () => geometries.capsule(),
  sphere: () => sharedGeometry("robot:sphere", () => new THREE.SphereGeometry(0.5, 14, 10)),
  cyl: () => geometries.cylinder(),
  cone: () => sharedGeometry("robot:cone", () => new THREE.ConeGeometry(0.5, 1, 14)),
  torus: () => sharedGeometry("robot:torus", () => new THREE.TorusGeometry(0.5, 0.09, 8, 32)),
  /** Upper half ring in the XY plane (a headset band), radius 0.5. */
  arc: () => sharedGeometry("robot:arc", () => new THREE.TorusGeometry(0.5, 0.06, 8, 24, Math.PI)),
};

const MATERIAL: Record<MatKey, () => THREE.Material> = {
  shell: () => sharedMaterial("robot:shell", () => new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.34, metalness: 0.32, envMapIntensity: 0.9 })),
  paint: () => sharedMaterial("robot:paint", () => new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.42, metalness: 0.28 })),
  joint: () => materials.joint(),
  visor: () => sharedMaterial("robot:visor", () => new THREE.MeshStandardMaterial({ color: "#070b12", roughness: 0.1, metalness: 0.7, envMapIntensity: 1.4 })),
  glow: () => sharedMaterial("robot:glow", () => new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false })),
};

// ───────────────────────── part lists ─────────────────────────

const X90: V3 = [Math.PI / 2, 0, 0];
const Z90: V3 = [0, 0, Math.PI / 2];

/** A limb hanging from its pivot: a capsule from the pivot down to the next joint, caps overlapping both. */
function limb(b: BoneKey, len: number, r: number, m: MatKey = "shell"): Part {
  return { g: "limb", m, b, p: [0, -len / 2, 0], s: [2 * r, (len + r) / 2.6, 2 * r], light: true };
}

function commonParts(rig: RobotRig): Part[] {
  const parts: Part[] = [
    { g: "cyl", m: "joint", b: "hips", p: [0, 0, 0], s: [2 * (rig.hipX + 0.09), 0.13, 0.27] },
    { g: "cyl", m: "joint", b: "spine", p: [0, rig.headY - 0.04, 0], s: [0.12, 0.1, 0.12] },
  ];
  for (const side of ["l", "r"] as const) {
    const hip = `${side}Hip` as BoneKey;
    const knee = `${side}Knee` as BoneKey;
    const sh = `${side}Shoulder` as BoneKey;
    const el = `${side}Elbow` as BoneKey;
    parts.push(
      limb(hip, rig.thigh, 0.085),
      { g: "sphere", m: "joint", b: knee, p: [0, 0, 0], s: [0.125, 0.125, 0.125] },
      limb(knee, rig.shin, 0.078),
      { g: "soft", m: "paint", b: knee, p: [0, -rig.shin - 0.035, 0.035], s: [0.17, 0.09, 0.28] },
      { g: "sphere", m: "joint", b: sh, p: [0, 0, 0], s: [0.14, 0.14, 0.14] },
      limb(sh, rig.upperArm, 0.066),
      { g: "sphere", m: "joint", b: el, p: [0, 0, 0], s: [0.1, 0.1, 0.1] },
      limb(el, rig.forearm, 0.062),
      { g: "sphere", m: "joint", b: el, p: [0, -rig.forearm - 0.02, 0], s: [0.11, 0.12, 0.11] },
    );
  }
  return parts;
}

function roleParts(role: AgentRole, rig: RobotRig): Part[] {
  const hy = rig.headY;
  switch (role) {
    case "orchestrator":
      return [
        { g: "soft", m: "shell", b: "spine", p: [0, 0.3, 0], s: [0.6, 0.56, 0.38] },
        { g: "cyl", m: "paint", b: "spine", p: [0, 0.03, 0], s: [0.46, 0.09, 0.33] },
        { g: "sphere", m: "paint", b: "spine", p: [-rig.shoulderX - 0.01, rig.shoulderY + 0.05, 0], s: [0.25, 0.17, 0.26] },
        { g: "sphere", m: "paint", b: "spine", p: [rig.shoulderX + 0.01, rig.shoulderY + 0.05, 0], s: [0.25, 0.17, 0.26] },
        { g: "box", m: "glow", b: "spine", p: [0, 0.36, 0.19], r: [0, 0, Math.PI / 4], s: [0.12, 0.12, 0.03] },
        { g: "box", m: "glow", b: "spine", p: [0, 0.2, 0.19], s: [0.26, 0.022, 0.02], k: 0.7 },
        { g: "cyl", m: "paint", b: "spine", p: [0, hy - 0.08, 0], s: [0.32, 0.06, 0.27] },
        // short cape over the back: the silhouette the overview camera sees most
        { g: "soft", m: "paint", b: "spine", p: [0, 0.22, -0.21], r: [0.12, 0, 0], s: [0.62, 0.7, 0.045] },
        { g: "box", m: "glow", b: "spine", p: [0, 0.38, -0.238], r: [0.12, 0, 0], s: [0.04, 0.3, 0.01], k: 0.7 },
        // head + crown visor
        { g: "soft", m: "shell", b: "head", p: [0, 0.17, 0], s: [0.44, 0.34, 0.38] },
        { g: "soft", m: "visor", b: "head", p: [0, 0.17, 0.17], s: [0.38, 0.15, 0.06] },
        { g: "box", m: "glow", b: "head", p: [0, 0.175, 0.205], s: [0.3, 0.035, 0.02], k: 1.2 },
        { g: "cyl", m: "paint", b: "head", p: [0, 0.35, 0], s: [0.4, 0.06, 0.34] },
        { g: "cone", m: "glow", b: "head", p: [-0.15, 0.43, 0.06], s: [0.06, 0.12, 0.06], k: 0.9 },
        { g: "cone", m: "glow", b: "head", p: [-0.075, 0.45, 0.1], s: [0.065, 0.16, 0.065], k: 0.9 },
        { g: "cone", m: "glow", b: "head", p: [0, 0.48, 0.12], s: [0.075, 0.22, 0.075], k: 1 },
        { g: "cone", m: "glow", b: "head", p: [0.075, 0.45, 0.1], s: [0.065, 0.16, 0.065], k: 0.9 },
        { g: "cone", m: "glow", b: "head", p: [0.15, 0.43, 0.06], s: [0.06, 0.12, 0.06], k: 0.9 },
      ];
    case "researcher":
      return [
        { g: "capsule", m: "shell", b: "spine", p: [0, 0.29, 0], s: [0.4, 0.27, 0.32] },
        { g: "cyl", m: "joint", b: "spine", p: [0, 0.02, 0], s: [0.34, 0.08, 0.28] },
        { g: "soft", m: "paint", b: "spine", p: [0, 0.32, -0.2], s: [0.3, 0.34, 0.14] },
        { g: "cyl", m: "joint", b: "spine", p: [0.09, 0.58, -0.22], s: [0.022, 0.32, 0.022] },
        { g: "sphere", m: "glow", b: "spine", p: [0.09, 0.75, -0.22], s: [0.07, 0.07, 0.07], k: 1.1 },
        { g: "cyl", m: "glow", b: "spine", p: [0, 0.36, 0.158], r: X90, s: [0.12, 0.02, 0.12] },
        // round head, telescope lens over the right eye
        { g: "sphere", m: "shell", b: "head", p: [0, 0.19, 0], s: [0.4, 0.38, 0.38] },
        { g: "soft", m: "visor", b: "head", p: [0, 0.19, 0.15], s: [0.3, 0.15, 0.08] },
        { g: "sphere", m: "glow", b: "head", p: [-0.08, 0.2, 0.192], s: [0.05, 0.05, 0.03], k: 1.2 },
        { g: "cyl", m: "paint", b: "head", p: [0.085, 0.2, 0.25], r: X90, s: [0.15, 0.17, 0.15] },
        { g: "torus", m: "joint", b: "head", p: [0.085, 0.2, 0.335], s: [0.17, 0.17, 0.17] },
        { g: "cyl", m: "glow", b: "head", p: [0.085, 0.2, 0.336], r: X90, s: [0.11, 0.015, 0.11], k: 1.3 },
      ];
    case "product_manager":
      return [
        { g: "soft", m: "shell", b: "spine", p: [0, 0.29, 0], s: [0.5, 0.52, 0.32] },
        { g: "cyl", m: "paint", b: "spine", p: [0, 0.03, 0], s: [0.44, 0.1, 0.31] },
        { g: "soft", m: "glow", b: "spine", p: [0, 0.36, 0.158], s: [0.2, 0.11, 0.025], k: 0.8 },
        { g: "cyl", m: "paint", b: "spine", p: [0, hy - 0.07, 0], s: [0.26, 0.05, 0.22] },
        { g: "soft", m: "paint", b: "spine", p: [0, 0.3, -0.17], s: [0.36, 0.3, 0.07] },
        { g: "sphere", m: "glow", b: "spine", p: [-0.08, 0.36, -0.21], s: [0.05, 0.05, 0.02], k: 0.8 },
        { g: "sphere", m: "glow", b: "spine", p: [0.0, 0.36, -0.21], s: [0.05, 0.05, 0.02], k: 0.8 },
        { g: "sphere", m: "glow", b: "spine", p: [0.08, 0.36, -0.21], s: [0.05, 0.05, 0.02], k: 0.8 },
        // boxy head with an antenna
        { g: "soft", m: "shell", b: "head", p: [0, 0.16, 0], s: [0.46, 0.3, 0.34] },
        { g: "soft", m: "visor", b: "head", p: [0, 0.165, 0.15], s: [0.4, 0.14, 0.06] },
        { g: "sphere", m: "glow", b: "head", p: [-0.085, 0.17, 0.182], s: [0.07, 0.07, 0.03], k: 1.2 },
        { g: "sphere", m: "glow", b: "head", p: [0.085, 0.17, 0.182], s: [0.07, 0.07, 0.03], k: 1.2 },
        { g: "cyl", m: "joint", b: "head", p: [0, 0.39, 0], s: [0.022, 0.2, 0.022] },
        { g: "sphere", m: "glow", b: "head", p: [0, 0.5, 0], s: [0.08, 0.08, 0.08], k: 1 },
        // tablet strapped to the left forearm, screen facing out
        { g: "soft", m: "paint", b: "lElbow", p: [-0.06, -rig.forearm * 0.55, 0.02], s: [0.035, 0.36, 0.27] },
        { g: "box", m: "glow", b: "lElbow", p: [-0.079, -rig.forearm * 0.55, 0.02], s: [0.006, 0.3, 0.21], k: 0.85 },
      ];
    case "engineer":
      return [
        { g: "soft", m: "shell", b: "spine", p: [0, 0.29, 0], s: [0.56, 0.54, 0.38] },
        { g: "cyl", m: "paint", b: "spine", p: [0, 0.03, 0], s: [0.5, 0.1, 0.37] },
        { g: "soft", m: "joint", b: "spine", p: [0.19, 0.03, 0.17], s: [0.13, 0.11, 0.08] },
        { g: "box", m: "glow", b: "spine", p: [-0.02, 0.41, 0.19], s: [0.18, 0.028, 0.02] },
        { g: "box", m: "glow", b: "spine", p: [-0.05, 0.35, 0.19], s: [0.12, 0.028, 0.02], k: 0.8 },
        { g: "box", m: "glow", b: "spine", p: [0.0, 0.29, 0.19], s: [0.15, 0.028, 0.02], k: 0.6 },
        { g: "soft", m: "paint", b: "spine", p: [0, 0.31, -0.25], s: [0.44, 0.42, 0.16] },
        { g: "box", m: "joint", b: "spine", p: [-0.1, 0.33, -0.335], s: [0.08, 0.26, 0.02] },
        { g: "box", m: "joint", b: "spine", p: [0.1, 0.33, -0.335], s: [0.08, 0.26, 0.02] },
        { g: "box", m: "glow", b: "spine", p: [0, 0.48, -0.335], s: [0.3, 0.025, 0.012], k: 0.8 },
        // cube head, full-face visor, headset
        { g: "soft", m: "shell", b: "head", p: [0, 0.19, 0], s: [0.42, 0.38, 0.38] },
        { g: "soft", m: "visor", b: "head", p: [0, 0.19, 0.16], s: [0.37, 0.2, 0.08] },
        { g: "box", m: "glow", b: "head", p: [0, 0.2, 0.202], s: [0.26, 0.04, 0.02], k: 1.2 },
        { g: "arc", m: "joint", b: "head", p: [0, 0.19, 0], s: [0.5, 0.5, 0.7] },
        { g: "cyl", m: "paint", b: "head", p: [-0.235, 0.19, 0], r: Z90, s: [0.17, 0.08, 0.17] },
        { g: "cyl", m: "paint", b: "head", p: [0.235, 0.19, 0], r: Z90, s: [0.17, 0.08, 0.17] },
        { g: "cyl", m: "glow", b: "head", p: [-0.278, 0.19, 0], r: Z90, s: [0.1, 0.01, 0.1], k: 0.9 },
        { g: "cyl", m: "glow", b: "head", p: [0.278, 0.19, 0], r: Z90, s: [0.1, 0.01, 0.1], k: 0.9 },
        { g: "box", m: "joint", b: "head", p: [0.2, 0.1, 0.12], r: [0, -0.7, 0], s: [0.02, 0.02, 0.2] },
        { g: "sphere", m: "glow", b: "head", p: [0.13, 0.095, 0.195], s: [0.045, 0.045, 0.045], k: 1.1 },
      ];
    case "qa":
      return [
        { g: "cyl", m: "shell", b: "spine", p: [0, 0.27, 0], s: [0.54, 0.5, 0.44] },
        { g: "cyl", m: "paint", b: "spine", p: [0, 0.08, 0], s: [0.56, 0.06, 0.46] },
        { g: "cyl", m: "paint", b: "spine", p: [0, 0.46, 0], s: [0.56, 0.06, 0.46] },
        { g: "soft", m: "glow", b: "spine", p: [0, 0.27, 0.215], s: [0.16, 0.11, 0.025], k: 0.8 },
        { g: "cyl", m: "paint", b: "spine", p: [-0.1, 0.3, -0.24], s: [0.15, 0.4, 0.15] },
        { g: "cyl", m: "paint", b: "spine", p: [0.1, 0.3, -0.24], s: [0.15, 0.4, 0.15] },
        { g: "cyl", m: "glow", b: "spine", p: [-0.1, 0.505, -0.24], s: [0.11, 0.02, 0.11], k: 0.8 },
        { g: "cyl", m: "glow", b: "spine", p: [0.1, 0.505, -0.24], s: [0.11, 0.02, 0.11], k: 0.8 },
        // dome head, wrap-around visor, twin sensors
        { g: "sphere", m: "shell", b: "head", p: [0, 0.15, 0], s: [0.48, 0.36, 0.44] },
        { g: "cyl", m: "visor", b: "head", p: [0, 0.16, 0], s: [0.47, 0.11, 0.43] },
        { g: "box", m: "glow", b: "head", p: [0, 0.165, 0.212], s: [0.28, 0.035, 0.02], k: 1.2 },
        { g: "cyl", m: "joint", b: "head", p: [-0.13, 0.42, 0], r: [0, 0, 0.32], s: [0.026, 0.28, 0.026] },
        { g: "cyl", m: "joint", b: "head", p: [0.13, 0.42, 0], r: [0, 0, -0.32], s: [0.026, 0.28, 0.026] },
        { g: "sphere", m: "glow", b: "head", p: [-0.178, 0.56, 0], s: [0.095, 0.095, 0.095], k: 1.1 },
        { g: "sphere", m: "glow", b: "head", p: [0.178, 0.56, 0], s: [0.095, 0.095, 0.095], k: 1.1 },
      ];
    case "reviewer":
      return [
        { g: "capsule", m: "shell", b: "spine", p: [0, 0.3, 0], s: [0.42, 0.29, 0.32] },
        { g: "cyl", m: "joint", b: "spine", p: [0, 0.02, 0], s: [0.34, 0.08, 0.28] },
        { g: "cyl", m: "paint", b: "spine", p: [0, hy - 0.07, 0], s: [0.3, 0.07, 0.26] },
        { g: "cone", m: "paint", b: "spine", p: [-0.045, hy - 0.12, 0.15], r: [0, 0, -Math.PI / 2], s: [0.07, 0.08, 0.04] },
        { g: "cone", m: "paint", b: "spine", p: [0.045, hy - 0.12, 0.15], r: [0, 0, Math.PI / 2], s: [0.07, 0.08, 0.04] },
        { g: "cyl", m: "glow", b: "spine", p: [0.1, 0.38, 0.158], r: X90, s: [0.07, 0.02, 0.07], k: 0.9 },
        { g: "soft", m: "paint", b: "spine", p: [0, 0.34, -0.16], s: [0.1, 0.5, 0.12] },
        { g: "box", m: "glow", b: "spine", p: [0, 0.34, -0.222], s: [0.025, 0.4, 0.01], k: 0.9 },
        // tall head, brow ledge, monocle over the right eye with a chain
        { g: "soft", m: "shell", b: "head", p: [0, 0.22, 0], s: [0.36, 0.44, 0.36] },
        { g: "box", m: "joint", b: "head", p: [0, 0.33, 0.16], s: [0.37, 0.04, 0.09] },
        { g: "soft", m: "visor", b: "head", p: [0, 0.22, 0.15], s: [0.3, 0.13, 0.07] },
        { g: "sphere", m: "glow", b: "head", p: [-0.075, 0.22, 0.186], s: [0.05, 0.05, 0.03], k: 1.1 },
        { g: "torus", m: "paint", b: "head", p: [0.075, 0.22, 0.2], s: [0.19, 0.19, 0.19] },
        { g: "cyl", m: "glow", b: "head", p: [0.075, 0.22, 0.196], r: X90, s: [0.14, 0.01, 0.14], k: 1.4 },
        { g: "box", m: "joint", b: "head", p: [0.155, 0.1, 0.18], r: [0, 0, 0.25], s: [0.01, 0.2, 0.01] },
      ];
  }
}

// ───────────────────────── colours ─────────────────────────

const LIMB_SHELL = new THREE.Color("#d3d8e1");
const hsl = { h: 0, s: 0, l: 0 };

/**
 * Body tones from the agent colour, derived in HSL (a linear-space lerp towards white washes every robot out
 * to the same pastel under the warm lights): the main shell is a lighter, softer agent colour so each robot
 * reads by colour at overview distance; limbs stay a light neutral; paint parts are a deeper shade.
 */
function shellColor(p: AgentProfile, light: boolean): THREE.Color {
  if (light) return LIMB_SHELL.clone().lerp(new THREE.Color(p.color), 0.08);
  new THREE.Color(p.color).getHSL(hsl, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(hsl.h, hsl.s * 0.62, Math.min(0.8, hsl.l + 0.14), THREE.SRGBColorSpace);
}

function paintColor(p: AgentProfile): THREE.Color {
  new THREE.Color(p.color).getHSL(hsl, THREE.SRGBColorSpace);
  return new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 0.9), hsl.l * 0.72, THREE.SRGBColorSpace);
}

/** Glow level for a status, before the pose's own `glow` multiplier. */
function statusGlow(status: string, paused: boolean): number {
  if (paused) return 0.28;
  switch (status) {
    case "idle":
      return 0.72;
    case "walking":
      return 0.85;
    case "error":
      return 0.9;
    default:
      return 1;
  }
}

// ───────────────────────── bones ─────────────────────────

interface RobotBones {
  profile: AgentProfile;
  rig: RobotRig;
  root: THREE.Object3D;
  bones: Record<BoneKey, THREE.Object3D>;
  animator: AgentAnimator;
}

function buildBones(profile: AgentProfile, index: number): RobotBones {
  const rig = ROBOT_RIGS[profile.role];
  const o = () => new THREE.Object3D();
  const root = o();
  const b = {
    body: o(),
    hips: o(),
    lHip: o(),
    lKnee: o(),
    rHip: o(),
    rKnee: o(),
    spine: o(),
    head: o(),
    lShoulder: o(),
    lElbow: o(),
    rShoulder: o(),
    rElbow: o(),
  } satisfies Record<BoneKey, THREE.Object3D>;
  root.add(b.body);
  b.body.scale.setScalar(rig.scale);
  b.body.add(b.hips, b.spine);
  b.hips.position.y = rig.hipY;
  b.hips.add(b.lHip, b.rHip);
  b.lHip.position.x = -rig.hipX;
  b.rHip.position.x = rig.hipX;
  b.lHip.add(b.lKnee);
  b.rHip.add(b.rKnee);
  b.lKnee.position.y = -rig.thigh;
  b.rKnee.position.y = -rig.thigh;
  b.spine.position.y = rig.hipY + 0.02;
  b.spine.add(b.head, b.lShoulder, b.rShoulder);
  b.head.position.y = rig.headY;
  b.head.rotation.order = "YXZ";
  b.lShoulder.position.set(-rig.shoulderX, rig.shoulderY, 0);
  b.rShoulder.position.set(rig.shoulderX, rig.shoulderY, 0);
  b.lShoulder.add(b.lElbow);
  b.rShoulder.add(b.rElbow);
  b.lElbow.position.y = -rig.upperArm;
  b.rElbow.position.y = -rig.upperArm;
  // Seeds spread over [0, 1) so no two robots breathe or glance in sync.
  return { profile, rig, root, bones: b, animator: new AgentAnimator(((index * 0.618034) % 1) + 0.05) };
}

function applyPose(r: RobotBones, p: Pose): void {
  const b = r.bones;
  b.body.position.y = p.bob * r.rig.scale;
  b.spine.rotation.set(p.lean, p.twist, p.sway);
  b.hips.rotation.set(0, -p.twist * 0.4, p.sway * 0.5);
  b.head.rotation.set(p.headPitch, p.headYaw, p.headRoll);
  b.lShoulder.rotation.set(p.lShoulderPitch, 0, p.lShoulderRoll);
  b.rShoulder.rotation.set(p.rShoulderPitch, 0, p.rShoulderRoll);
  b.lElbow.rotation.x = p.lElbow;
  b.rElbow.rotation.x = p.rElbow;
  b.lHip.rotation.x = p.lHip;
  b.rHip.rotation.x = p.rHip;
  b.lKnee.rotation.x = p.lKnee;
  b.rKnee.rotation.x = p.rKnee;
}

// ───────────────────────── instanced groups ─────────────────────────

interface InstanceRef {
  robot: number;
  bone: BoneKey;
  local: THREE.Matrix4;
  k: number;
  light: boolean;
}

interface PartGroup {
  key: string;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  mat: MatKey;
  items: InstanceRef[];
}

const tmpEuler = new THREE.Euler();
const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

function buildGroups(): PartGroup[] {
  const groups = new Map<string, PartGroup>();
  AGENTS.forEach((profile, robot) => {
    const rig = ROBOT_RIGS[profile.role];
    for (const part of [...commonParts(rig), ...roleParts(profile.role, rig)]) {
      const key = `${part.g}|${part.m}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, geometry: GEOMETRY[part.g](), material: MATERIAL[part.m](), mat: part.m, items: [] };
        groups.set(key, g);
      }
      const r = part.r ?? [0, 0, 0];
      const local = new THREE.Matrix4().compose(
        tmpPos.set(part.p[0], part.p[1], part.p[2]),
        tmpQuat.setFromEuler(tmpEuler.set(r[0], r[1], r[2])),
        tmpScale.set(part.s[0], part.s[1], part.s[2]),
      );
      g.items.push({ robot, bone: part.b, local, k: part.k ?? 1, light: part.light ?? false });
    }
  });
  return [...groups.values()];
}

/** Static per-instance colour for a group; glow groups are recoloured every frame. */
function baseColor(mat: MatKey, profile: AgentProfile, light: boolean): THREE.Color | null {
  if (mat === "shell") return shellColor(profile, light);
  if (mat === "paint") return paintColor(profile);
  if (mat === "glow") return new THREE.Color(profile.color);
  return null;
}

// ───────────────────────── floor marks: blob + status / selection / pulse rings ─────────────────────────

const RING_COUNT = AGENTS.length * 3;
const PULSE_SECONDS = 1.1;
const PULSE_SUCCESS = new THREE.Color("#6fe3a4");
const PULSE_ERROR = new THREE.Color("#f2b46a");
const WHITE = new THREE.Color("#ffffff");

const ringMaterial = () =>
  sharedMaterial(
    "robot:rings",
    () => new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
const blobMaterial = () =>
  sharedMaterial("robot:blob", () => new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.85, depthWrite: false, color: "#000000" }));

interface MarkState {
  ring: number;
  sel: number;
  pulseT: number;
  pulseColor: THREE.Color;
  lastStatus: string;
}

const tmpMatrix = new THREE.Matrix4();
const tmpColor = new THREE.Color();
const flatQuat = new THREE.Quaternion();
const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
const glowLevels = new Float32Array(AGENTS.length);
/** Agent colours, parsed once (setting a Color from a hex string every frame re-parses it). */
const AGENT_COLORS = AGENTS.map((a) => new THREE.Color(a.color));
const HOVER_KEYS = AGENTS.map((a) => `agent:${a.id}`);

/** All six robots: shared InstancedMeshes for the parts, the contact blobs and the floor rings. */
export function Robots() {
  useRenderCount("Robots");
  const groups = useMemo(() => buildGroups(), []);
  // Bones and animators are mutated every frame, so they live behind a ref, created on first use.
  const robotsRef = useRef<RobotBones[] | null>(null);
  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  const blobs = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null);
  const marks = useRef<MarkState[]>(AGENTS.map(() => ({ ring: 0.2, sel: 0, pulseT: 9, pulseColor: PULSE_SUCCESS.clone(), lastStatus: "idle" })));

  // Per-instance colours must exist before the first render so the programs compile with instancing colour.
  useLayoutEffect(() => {
    groups.forEach((g, gi) => {
      const mesh = meshes.current[gi];
      if (!mesh) return;
      g.items.forEach((it, i) => {
        const c = baseColor(g.mat, AGENTS[it.robot]!, it.light);
        if (c) mesh.setColorAt(i, c);
        mesh.setMatrixAt(i, hiddenMatrix);
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.instanceMatrix.needsUpdate = true;
    });
    const r = rings.current;
    if (r) {
      for (let i = 0; i < RING_COUNT; i++) {
        r.setColorAt(i, WHITE);
        r.setMatrixAt(i, hiddenMatrix);
      }
      if (r.instanceColor) r.instanceColor.needsUpdate = true;
    }
    const bl = blobs.current;
    if (bl) for (let i = 0; i < AGENTS.length; i++) bl.setMatrixAt(i, hiddenMatrix);
  }, [groups]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    updateAgentMotion(state.clock.elapsedTime, dt);
    const snap = liveWorld.snapshot;
    if (!snap) return;
    const running = snap.status === "running";
    const st = useWorldStore.getState();
    const t = state.clock.elapsedTime;
    robotsRef.current ??= AGENTS.map((p, i) => buildBones(p, i));
    const robots = robotsRef.current;

    // 1. Pose every robot's bones. Plain loops: nothing in this callback allocates.
    const motion = st.reducedMotion ? REDUCED_MOTION : 1;
    const glow = glowLevels;
    for (let i = 0; i < robots.length; i++) {
      const r = robots[i]!;
      const d = agentDisplay.get(r.profile.id)!;
      if (!d.init) {
        glow[i] = 0;
        continue;
      }
      const frozen = d.paused || !running;
      const pose = r.animator.update(dt, d.status, frozen, d.speed, SIM_CONFIG.walkSpeed, motion);
      applyPose(r, pose);
      r.root.position.set(d.x, 0, d.z);
      r.root.rotation.y = d.heading;
      r.root.updateMatrixWorld(true);
      glow[i] = statusGlow(d.status, d.paused) * pose.glow;
    }

    // 2. Write the parts.
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi]!;
      const mesh = meshes.current[gi];
      if (!mesh) continue;
      const isGlow = g.mat === "glow";
      for (let i = 0; i < g.items.length; i++) {
        const it = g.items[i]!;
        const r = robots[it.robot]!;
        if (!agentDisplay.get(r.profile.id)!.init) {
          mesh.setMatrixAt(i, hiddenMatrix);
          continue;
        }
        mesh.setMatrixAt(i, tmpMatrix.multiplyMatrices(r.bones[it.bone].matrixWorld, it.local));
        if (isGlow) mesh.setColorAt(i, tmpColor.copy(AGENT_COLORS[it.robot]!).multiplyScalar(Math.min(1.6, glow[it.robot]! * it.k)));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (isGlow && mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    // 3. Floor marks.
    const bl = blobs.current;
    const rg = rings.current;
    if (!bl || !rg) return;
    for (let i = 0; i < robots.length; i++) {
      const r = robots[i]!;
      const d = agentDisplay.get(r.profile.id)!;
      const m = marks.current[i]!;
      if (!d.init) continue;
      const s = r.rig.scale;
      const w = r.animator.weights;
      tmpPos.set(d.x, 0.011, d.z);
      bl.setMatrixAt(i, tmpMatrix.compose(tmpPos, flatQuat, tmpScale.set(1.35 * s, 1, 1.35 * s)));

      // Status ring: agent colour, brighter while working / talking / thinking (the flicker is decoration).
      const busy = w.work * 0.62 + w.talk * (0.5 + 0.12 * motion * Math.sin(t * 9)) + w.think * (0.36 + 0.1 * motion * Math.sin(t * 2.4));
      const ringGoal = d.paused ? 0.06 : 0.2 + busy;
      m.ring = THREE.MathUtils.damp(m.ring, ringGoal, 6, dt);
      tmpPos.set(d.x, 0.02, d.z);
      rg.setMatrixAt(i * 3, tmpMatrix.compose(tmpPos, flatQuat, tmpScale.set(0.56 * s, 1, 0.56 * s)));
      rg.setColorAt(i * 3, tmpColor.copy(AGENT_COLORS[i]!).multiplyScalar(m.ring));

      // Selection ring: white, full when selected, half when hovered.
      const id = r.profile.id;
      const selGoal = st.selectedAgentId === id ? 0.75 : st.hovered === HOVER_KEYS[i] ? 0.5 : 0;
      m.sel = THREE.MathUtils.damp(m.sel, selGoal, 10, dt);
      tmpPos.set(d.x, 0.022, d.z);
      const breathe = 1 + Math.sin(t * 3) * 0.02 * motion * (st.selectedAgentId === id ? 1 : 0);
      rg.setMatrixAt(i * 3 + 1, m.sel > 0.005 ? tmpMatrix.compose(tmpPos, flatQuat, tmpScale.set(0.72 * s * breathe, 1, 0.72 * s * breathe)) : hiddenMatrix);
      rg.setColorAt(i * 3 + 1, tmpColor.copy(WHITE).multiplyScalar(m.sel * 0.85));

      // Pulse ring: expands once when success / error begins. It is the emote's signal, so reduced motion
      // keeps it, but as one shorter, smaller ring without the echo.
      if ((d.status === "success" || d.status === "error") && m.lastStatus !== d.status) {
        m.pulseT = 0;
        m.pulseColor.copy(d.status === "success" ? PULSE_SUCCESS : PULSE_ERROR);
      }
      m.lastStatus = d.status;
      m.pulseT += dt * (d.paused || !running ? 0.15 : 1);
      // A second, softer pulse follows the first so the emote reads from across the office.
      const pulses = motion < 1 ? 1 : 2;
      const cycle = m.pulseT < PULSE_SECONDS * pulses ? (m.pulseT % PULSE_SECONDS) / PULSE_SECONDS : 1;
      const strength = m.pulseT < PULSE_SECONDS ? 1 : 0.55;
      tmpPos.set(d.x, 0.024, d.z);
      const ps = (0.5 + cycle * (motion < 1 ? 0.6 : 1.25)) * s;
      rg.setMatrixAt(i * 3 + 2, cycle < 1 ? tmpMatrix.compose(tmpPos, flatQuat, tmpScale.set(ps, 1, ps)) : hiddenMatrix);
      rg.setColorAt(i * 3 + 2, tmpColor.copy(m.pulseColor).multiplyScalar((1 - cycle) * strength));
    }
    bl.instanceMatrix.needsUpdate = true;
    rg.instanceMatrix.needsUpdate = true;
    if (rg.instanceColor) rg.instanceColor.needsUpdate = true;
  });

  return (
    <group name="robots">
      {groups.map((g, gi) => (
        <instancedMesh
          key={g.key}
          name={`robot-${g.key}`}
          ref={(m) => {
            meshes.current[gi] = m;
          }}
          args={[g.geometry, g.material, g.items.length]}
          castShadow
          receiveShadow={g.mat !== "glow"}
          frustumCulled={false}
        />
      ))}
      <instancedMesh ref={blobs} args={[geometries.floorPlane(), blobMaterial(), AGENTS.length]} frustumCulled={false} renderOrder={1} />
      <instancedMesh ref={rings} args={[geometries.ring(), ringMaterial(), RING_COUNT]} frustumCulled={false} renderOrder={2} />
    </group>
  );
}

