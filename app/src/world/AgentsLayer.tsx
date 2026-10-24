"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Robots } from "@/agents/AgentCharacter";
import { AGENTS, getAgent } from "@/agents/AgentRegistry";
import type { AgentId } from "@/agents/agentTypes";
import type { CommLink } from "@/integrations/AgentBackend";
import { SIM_CONFIG } from "@/simulation/simulationConfig";
import { liveWorld, useWorldStore } from "@/state/useWorldStore";
import { agentDisplay, liveClock, updateAgentMotion } from "@/world/agentMotion";
import { selectAgentInWorld, useHitHandlers } from "@/world/InteractionManager";
import { writeLabelAnchor, labelScale } from "@/world/labelAnchors";
import { glowTexture } from "@/world/proceduralTextures";
import { geometries, sharedMaterial } from "@/world/sharedResources";
import { useRenderCount } from "@/world/renderCounts";

/**
 * §6.4: the agents layer. Robots (instanced, `AgentCharacter.tsx`), their pick cylinders, path trails,
 * comm arcs with packets, and the screen-space anchors for the DOM speech bubbles. Everything per-frame reads
 * `liveWorld` / `agentDisplay` inside `useFrame`; nothing here re-renders React while agents move.
 */

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpC = new THREE.Color();
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);

function smooth01(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

// ───────────────────────── pick cylinders ─────────────────────────

const hitMaterial = () => sharedMaterial("hit", () => new THREE.MeshBasicMaterial({ visible: false }));

function AgentHit({ id }: { id: AgentId }) {
  const ref = useRef<THREE.Mesh>(null);
  const onSelect = useMemo(() => () => selectAgentInWorld(id), [id]);
  const handlers = useHitHandlers(`agent:${id}`, onSelect);
  useFrame(() => {
    const d = agentDisplay.get(id);
    const m = ref.current;
    if (!d || !m) return;
    m.visible = d.init;
    m.position.set(d.x, 1.05 * d.scale, d.z);
  });
  return <mesh ref={ref} geometry={geometries.cylinderLow()} material={hitMaterial()} scale={[1, 2.1, 1]} visible={false} {...handlers} />;
}

// ───────────────────────── path trails ─────────────────────────

const TRAIL_MAX = 64;
const TRAIL_SPACING = 0.32;
/** Metres per second the dots flow towards the destination. */
const TRAIL_FLOW = 0.8;
const TRAIL_START = 0.35;

const additive = (key: string, extra: THREE.MeshBasicMaterialParameters = {}) =>
  sharedMaterial(
    key,
    () => new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, ...extra }),
  );

interface TrailPoint {
  x: number;
  z: number;
  /** Cumulative length along the polyline. */
  s: number;
}

function putPoint(pool: TrailPoint[], i: number, x: number, z: number, s: number): void {
  const q = pool[i] ?? (pool[i] = { x: 0, z: 0, s: 0 });
  q.x = x;
  q.z = z;
  q.s = s;
}

function PathTrail({ id }: { id: AgentId }) {
  useRenderCount("PathTrail");
  const color = useMemo(() => new THREE.Color(getAgent(id).color), [id]);
  const discs = useRef<THREE.InstancedMesh>(null);
  const dest = useRef<THREE.Group>(null);
  const destRing = useRef<THREE.Mesh>(null);
  const destGlow = useRef<THREE.Mesh>(null);
  const flow = useRef(0);
  const pts = useRef<TrailPoint[]>([]);

  useLayoutEffect(() => {
    const m = discs.current;
    if (!m) return;
    for (let i = 0; i < TRAIL_MAX; i++) {
      m.setMatrixAt(i, hidden);
      m.setColorAt(i, color);
    }
    m.count = 0;
  }, [color]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    updateAgentMotion(state.clock.elapsedTime, dt);
    const m = discs.current;
    const g = dest.current;
    if (!m || !g) return;
    const d = agentDisplay.get(id);
    const a = d?.state;
    const show = !!d && !!a && d.init && a.path.length > 0 && useWorldStore.getState().overlays.paths;
    m.visible = show;
    g.visible = show;
    if (!show || !d || !a) return;

    const running = liveWorld.snapshot?.status === "running";
    const reduced = useWorldStore.getState().reducedMotion;
    // The flow shows direction, so it stays with reduced motion, at a calmer pace.
    const flowRate = (running && !a.paused ? 1 : 0.15) * (reduced ? 0.35 : 1);
    flow.current = (flow.current + dt * TRAIL_FLOW * flowRate) % TRAIL_SPACING;

    // Polyline: the displayed robot, then the remaining waypoints, with cumulative length. The point
    // objects are pooled across frames.
    const pool = pts.current;
    let count = 0;
    putPoint(pool, count++, d.x, d.z, 0);
    for (const p of a.path) {
      const last = pool[count - 1]!;
      const seg = Math.hypot(p.x - last.x, p.z - last.z);
      if (seg < 1e-4) continue;
      putPoint(pool, count++, p.x, p.z, last.s + seg);
    }
    const list = pool;
    const total = list[count - 1]!.s;

    let n = 0;
    let seg = 1;
    for (let s = TRAIL_START + flow.current; s < total - 0.3 && n < TRAIL_MAX; s += TRAIL_SPACING) {
      while (seg < count - 1 && list[seg]!.s < s) seg++;
      const p0 = list[seg - 1]!;
      const p1 = list[seg]!;
      const u = (s - p0.s) / Math.max(1e-4, p1.s - p0.s);
      const fade = smooth01((s - TRAIL_START) / 0.7) * smooth01((total - 0.3 - s) / 0.9);
      tmpV.set(p0.x + (p1.x - p0.x) * u, 0.028, p0.z + (p1.z - p0.z) * u);
      const size = 0.055 + 0.02 * fade;
      m.setMatrixAt(n, tmpM.compose(tmpV, tmpQ.identity(), tmpS.set(size, 1, size)));
      m.setColorAt(n, tmpC.copy(color).multiplyScalar(0.25 + 0.75 * fade));
      n++;
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;

    // Destination marker: a ring that breathes, over a soft glow.
    const end = list[count - 1]!;
    const t = state.clock.elapsedTime;
    const breathe = 1 + Math.sin(t * 3.6) * (reduced ? 0 : 0.12);
    g.position.set(end.x, 0, end.z);
    destRing.current?.scale.set(0.36 * breathe, 1, 0.36 * breathe);
    const glow = destGlow.current;
    if (glow) {
      glow.scale.set(1.1 * breathe, 1, 1.1 * breathe);
      ((glow.material as THREE.MeshBasicMaterial).color as THREE.Color).copy(color).multiplyScalar(0.35 + (reduced ? 0 : 0.15 * Math.sin(t * 3.6)));
    }
  });

  return (
    <group name={`trail-${id}`}>
      <instancedMesh ref={discs} args={[geometries.disc(), additive("trail:dots"), TRAIL_MAX]} frustumCulled={false} visible={false} renderOrder={3} />
      <group ref={dest} visible={false}>
        <mesh ref={destRing} geometry={geometries.ring()} material={additive(`trail:dest:${id}`, { color })} position={[0, 0.03, 0]} renderOrder={3} />
        <mesh
          ref={destGlow}
          geometry={geometries.floorPlane()}
          material={additive(`trail:destGlow:${id}`, { map: glowTexture(), color })}
          position={[0, 0.026, 0]}
          renderOrder={3}
        />
      </group>
    </group>
  );
}

// ───────────────────────── comm links ─────────────────────────

const LINK_SLOTS = 6;
const SEGMENTS = 40;
const RADIAL = 6;
const PACKETS_PER_LINK = 3;
const PACKET_COUNT = LINK_SLOTS * PACKETS_PER_LINK;
/** Seconds one packet takes from sender to receiver. */
const PACKET_TRAVEL = SIM_CONFIG.linkDuration * 0.55;
const REVEAL_SECONDS = 0.35;

interface TubeBuffers {
  geometry: THREE.BufferGeometry;
  position: THREE.BufferAttribute;
  color: THREE.BufferAttribute;
}

function makeTube(): TubeBuffers {
  const geometry = new THREE.BufferGeometry();
  const vertices = (SEGMENTS + 1) * RADIAL;
  const position = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const color = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const index: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < RADIAL; j++) {
      const a = i * RADIAL + j;
      const b = i * RADIAL + ((j + 1) % RADIAL);
      const c = a + RADIAL;
      const d = b + RADIAL;
      index.push(a, c, b, b, c, d);
    }
  }
  geometry.setIndex(index);
  geometry.setAttribute("position", position);
  geometry.setAttribute("color", color);
  return { geometry, position, color };
}

interface Slot {
  core: TubeBuffers;
  halo: TubeBuffers;
  coreMat: THREE.MeshBasicMaterial;
  haloMat: THREE.MeshBasicMaterial;
}

const UP = new THREE.Vector3(0, 1, 0);
const p0 = new THREE.Vector3();
const p1 = new THREE.Vector3();
const p2 = new THREE.Vector3();
const pt = new THREE.Vector3();
const tan = new THREE.Vector3();
const nrm = new THREE.Vector3();
const bin = new THREE.Vector3();

function bezier(u: number, out: THREE.Vector3): THREE.Vector3 {
  const a = (1 - u) * (1 - u);
  const b = 2 * (1 - u) * u;
  const c = u * u;
  return out.set(a * p0.x + b * p1.x + c * p2.x, a * p0.y + b * p1.y + c * p2.y, a * p0.z + b * p1.z + c * p2.z);
}

function bezierTangent(u: number, out: THREE.Vector3): THREE.Vector3 {
  return out
    .set(2 * (1 - u) * (p1.x - p0.x) + 2 * u * (p2.x - p1.x), 2 * (1 - u) * (p1.y - p0.y) + 2 * u * (p2.y - p1.y), 2 * (1 - u) * (p1.z - p0.z) + 2 * u * (p2.z - p1.z))
    .normalize();
}

/** Writes the tube around the current curve; `packets` are the packet positions (u) that brighten it. */
function writeTube(t: TubeBuffers, radius: number, packets: readonly number[], base: number, peak: number): void {
  const pos = t.position.array as Float32Array;
  const col = t.color.array as Float32Array;
  for (let i = 0; i <= SEGMENTS; i++) {
    const u = i / SEGMENTS;
    bezier(u, pt);
    bezierTangent(u, tan);
    nrm.crossVectors(tan, UP);
    if (nrm.lengthSq() < 1e-6) nrm.set(1, 0, 0);
    nrm.normalize();
    bin.crossVectors(nrm, tan).normalize();
    const r = radius * (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * u), 0.4));
    let glow = base;
    for (const pu of packets) {
      const k = (u - pu) / 0.07;
      glow += peak * Math.exp(-k * k);
    }
    glow = Math.min(1.6, glow);
    for (let j = 0; j < RADIAL; j++) {
      const ang = (j / RADIAL) * Math.PI * 2;
      const c = Math.cos(ang) * r;
      const s = Math.sin(ang) * r;
      const o = (i * RADIAL + j) * 3;
      pos[o] = pt.x + nrm.x * c + bin.x * s;
      pos[o + 1] = pt.y + nrm.y * c + bin.y * s;
      pos[o + 2] = pt.z + nrm.z * c + bin.z * s;
      col[o] = glow;
      col[o + 1] = glow;
      col[o + 2] = glow;
    }
  }
  t.position.needsUpdate = true;
  t.color.needsUpdate = true;
  // No computeBoundingSphere(): the tubes are never frustum-culled, and it walked every vertex twice a frame.
}

function findLink(links: readonly CommLink[], id: string): CommLink | undefined {
  for (const l of links) if (l.id === id) return l;
  return undefined;
}

function isLive(l: CommLink, now: number): boolean {
  return l.from !== l.to && now < l.endsAt;
}

const packetGlowMaterial = () => additive("link:packetGlow", { map: glowTexture() });
const packetCoreMaterial = () => sharedMaterial("link:packetCore", () => new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }));

function CommLinks() {
  useRenderCount("CommLinks");
  const [slots] = useState<Slot[]>(
    () =>
      Array.from({ length: LINK_SLOTS }, () => ({
        core: makeTube(),
        halo: makeTube(),
        coreMat: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
        haloMat: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      })),
  );
  // useFrame mutates the slots (link ids, tube buffers, materials); reach them through a ref.
  const slotsRef = useRef<Slot[]>([]);
  /** Which link id each slot is drawing. */
  const assigned = useRef<(string | null)[]>(Array.from({ length: LINK_SLOTS }, () => null));
  useLayoutEffect(() => {
    slotsRef.current = slots;
  }, [slots]);
  useEffect(
    () => () => {
      for (const s of slots) {
        s.core.geometry.dispose();
        s.halo.geometry.dispose();
        s.coreMat.dispose();
        s.haloMat.dispose();
      }
    },
    [slots],
  );
  const coreMeshes = useRef<(THREE.Mesh | null)[]>([]);
  const haloMeshes = useRef<(THREE.Mesh | null)[]>([]);
  const packetGlow = useRef<THREE.InstancedMesh>(null);
  const packetCore = useRef<THREE.InstancedMesh>(null);
  const packetU = useRef<number[]>([]);

  useLayoutEffect(() => {
    for (const m of [packetGlow.current, packetCore.current]) {
      if (!m) continue;
      for (let i = 0; i < PACKET_COUNT; i++) {
        m.setMatrixAt(i, hidden);
        m.setColorAt(i, tmpC.set("#ffffff"));
      }
    }
  }, []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    updateAgentMotion(state.clock.elapsedTime, dt);
    const snap = liveWorld.snapshot;
    const links: readonly CommLink[] = snap?.links ?? [];
    const now = liveClock();
    const glowMesh = packetGlow.current;
    const coreMesh = packetCore.current;
    const slots = slotsRef.current;
    if (!glowMesh || !coreMesh || slots.length === 0) return;

    // Keep slots stable per link id; free slots of links that ended, then place new ones.
    // (A handful of links at most: linear scans, no per-frame Set.)
    const ids = assigned.current;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id) {
        const l = findLink(links, id);
        if (!l || !isLive(l, now)) ids[i] = null;
      }
    }
    for (const l of links) {
      if (!isLive(l, now) || ids.includes(l.id)) continue;
      const fi = ids.indexOf(null);
      if (fi < 0) break;
      ids[fi] = l.id;
      const free = slots[fi]!;
      tmpC.set(getAgent(l.from).color);
      free.coreMat.color.copy(tmpC);
      free.haloMat.color.copy(tmpC);
    }

    let packet = 0;
    const camQ = state.camera.quaternion;
    for (let si = 0; si < slots.length; si++) {
      const s = slots[si]!;
      const core = coreMeshes.current[si];
      const halo = haloMeshes.current[si];
      const linkId = ids[si];
      const link = linkId ? findLink(links, linkId) : undefined;
      const a = link ? agentDisplay.get(link.from) : undefined;
      const b = link ? agentDisplay.get(link.to) : undefined;
      if (!core || !halo) continue;
      if (!link || !a || !b || !a.init || !b.init) {
        core.visible = false;
        halo.visible = false;
        continue;
      }
      const elapsed = Math.max(0, now - link.startedAt);
      const life = Math.max(0.1, link.endsAt - link.startedAt);
      const fade = smooth01(elapsed / 0.25) * smooth01((life - elapsed) / 0.45);
      const reveal = smooth01(elapsed / REVEAL_SECONDS);

      // Endpoints at chest height, pulled a little out of each body towards the other robot.
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.05) {
        core.visible = false;
        halo.visible = false;
        continue;
      }
      const ux = dx / dist;
      const uz = dz / dist;
      const inset = Math.min(0.3, dist * 0.2);
      p0.set(a.x + ux * inset, a.chestY, a.z + uz * inset);
      p2.set(b.x - ux * inset, b.chestY, b.z - uz * inset);
      p1.set((p0.x + p2.x) / 2, Math.max(p0.y, p2.y) + Math.min(4, dist * 0.28) + 0.4, (p0.z + p2.z) / 2);

      const n = link.kind === "assign" ? 3 : 2;
      const us = packetU.current;
      us.length = 0;
      for (let j = 0; j < n; j++) {
        const start = (j * PACKET_TRAVEL) / n;
        if (elapsed < start) continue;
        const u = ((elapsed - start) / PACKET_TRAVEL) % 1;
        if (u > reveal) continue;
        us.push(u);
      }

      const thick = link.kind === "assign" ? 1.45 : 1;
      writeTube(s.core, 0.03 * thick, us, 0.75, 0.9);
      writeTube(s.halo, 0.1 * thick, us, 0.2, 0.35);
      const drawn = Math.ceil(SEGMENTS * reveal) * RADIAL * 6;
      s.core.geometry.setDrawRange(0, drawn);
      s.halo.geometry.setDrawRange(0, drawn);
      s.coreMat.opacity = fade;
      s.haloMat.opacity = fade * 0.9;
      core.visible = drawn > 0;
      halo.visible = drawn > 0;

      // Packets: a glow sprite facing the camera around a bright core.
      const senderColor = s.haloMat.color;
      for (const u of us) {
        if (packet >= PACKET_COUNT) break;
        bezier(u, pt);
        const size = (link.kind === "assign" ? 0.68 : 0.55) * (0.6 + 0.4 * fade);
        glowMesh.setMatrixAt(packet, tmpM.compose(pt, camQ, tmpS.set(size, size, size)));
        glowMesh.setColorAt(packet, tmpC.copy(senderColor).multiplyScalar(fade));
        const cs = link.kind === "assign" ? 0.095 : 0.075;
        coreMesh.setMatrixAt(packet, tmpM.compose(pt, tmpQ.identity(), tmpS.set(cs, cs, cs)));
        coreMesh.setColorAt(packet, tmpC.copy(senderColor).lerp(WHITE_C, 0.55).multiplyScalar(fade));
        packet++;
      }
    }
    glowMesh.count = packet;
    coreMesh.count = packet;
    glowMesh.visible = packet > 0;
    coreMesh.visible = packet > 0;
    glowMesh.instanceMatrix.needsUpdate = true;
    coreMesh.instanceMatrix.needsUpdate = true;
    if (glowMesh.instanceColor) glowMesh.instanceColor.needsUpdate = true;
    if (coreMesh.instanceColor) coreMesh.instanceColor.needsUpdate = true;
  });

  return (
    <group name="comm-links">
      {slots.map((s, i) => (
        <group key={i}>
          <mesh
            ref={(m) => {
              haloMeshes.current[i] = m;
            }}
            geometry={s.halo.geometry}
            material={s.haloMat}
            visible={false}
            frustumCulled={false}
            renderOrder={4}
          />
          <mesh
            ref={(m) => {
              coreMeshes.current[i] = m;
            }}
            geometry={s.core.geometry}
            material={s.coreMat}
            visible={false}
            frustumCulled={false}
            renderOrder={5}
          />
        </group>
      ))}
      <instancedMesh ref={packetGlow} args={[geometries.plane(), packetGlowMaterial(), PACKET_COUNT]} frustumCulled={false} visible={false} renderOrder={6} />
      <instancedMesh ref={packetCore} args={[geometries.sphere(), packetCoreMaterial(), PACKET_COUNT]} frustumCulled={false} visible={false} renderOrder={6} />
    </group>
  );
}

const WHITE_C = new THREE.Color("#ffffff");

// ───────────────────────── bubble anchors ─────────────────────────

/**
 * Projects each robot's label point and writes it to `labelAnchors` for the DOM overlay (§6.4).
 *
 * Mounted by WorldCanvas *after* the CameraController, so it projects with this frame's camera: the camera
 * is moved and re-aimed in the controller's `useFrame`, but three only refreshes `matrixWorldInverse` inside
 * `render()`, so the matrices are updated here first. Projecting with last frame's matrices made bubbles
 * trail their robots by a frame while following.
 *
 * `onScreen` is strict: the anchor itself must be in front of the camera and inside the canvas. The overlay
 * then also requires it to be inside the free area and only nudges the bubble's box, never its anchor.
 */
export function LabelAnchorWriter() {
  const [disabled] = useState(agentsDisabled);
  useFrame((state, rawDt) => {
    if (disabled) return;
    updateAgentMotion(state.clock.elapsedTime, Math.min(rawDt, 0.1));
    const camera = state.camera as THREE.PerspectiveCamera;
    camera.updateMatrixWorld();
    const { width, height } = state.size;
    const fov = THREE.MathUtils.degToRad(camera.fov);
    for (const d of agentDisplay.values()) {
      if (!d.init) {
        writeLabelAnchor(d.id, 0, 0, 1, false);
        continue;
      }
      tmpV.set(d.x, d.labelY, d.z);
      const dist = camera.position.distanceTo(tmpV);
      tmpV.project(camera);
      const x = ((tmpV.x + 1) / 2) * width;
      const y = ((1 - tmpV.y) / 2) * height;
      // Behind the camera, project() returns z > 1 (and mirrored x/y), so the z test must come first.
      const onScreen = tmpV.z > -1 && tmpV.z < 1 && x >= 0 && x <= width && y >= 0 && y <= height;
      writeLabelAnchor(d.id, x, y, labelScale(fov, dist), onScreen);
    }
  });
  return null;
}

/** Dev-only `?noagents` hides the robots and their bubbles, to compare draw calls with and without them. */
function agentsDisabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("noagents");
}

// ───────────────────────── layer ─────────────────────────

/** The robots, trails and arcs. The bubble anchors are a separate component that must run after the camera. */
export function AgentsLayer() {
  useRenderCount("AgentsLayer");
  const [disabled] = useState(agentsDisabled);
  if (disabled) return null;
  return (
    <group name="agents">
      <Robots />
      {AGENTS.map((a) => (
        <AgentHit key={a.id} id={a.id} />
      ))}
      {AGENTS.map((a) => (
        <PathTrail key={a.id} id={a.id} />
      ))}
      <CommLinks />
    </group>
  );
}
