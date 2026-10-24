"use client";

import { useEffect, useRef } from "react";
import type * as THREE from "three";
import { useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

/**
 * §6.5. Blue-hour exterior, warm interior. One shadow-casting directional light whose orthographic frustum
 * just covers the floor (2048 map in high, no shadows in low), a hemisphere fill, a few warm point lights
 * over the work areas (no shadows), and a procedural Lightformer environment for PBR
 * reflections. three r186 has no PCFSoftShadowMap: the Canvas uses "percentage" (PCFShadowMap) and the
 * softness comes from `shadow.radius`.
 */

const WARM_LIGHTS: [number, number, number][] = [
  [-8.25, 3.2, -3],
  [8.25, 3.2, -3],
  [0, 3.4, -0.4],
  [-5.5, 3.1, 5.4],
  [7.5, 3.1, 6.1],
];

export function Lighting() {
  useRenderCount("Lighting");
  const high = useWorldStore((s) => s.quality === "high");
  const sun = useRef<THREE.DirectionalLight>(null);
  const get = useThree((s) => s.get);

  // The Environment stays mounted in both qualities (it renders once, `frames={1}`); low quality only
  // detaches it from the scene. Unmounting it leaked one GPU texture per high → low → high cycle (drei
  // disposes its cube target but three's PMREM cache is keyed on the cube texture's "dispose" event; measured
  // 15 → 16 → 17 textures), and remounting re-rendered the cube and re-ran PMREM on every switch.
  const envTexture = useRef<THREE.Texture | null>(null);
  useEffect(() => {
    const scene = get().scene;
    if (scene.environment) envTexture.current = scene.environment;
    scene.environment = high ? envTexture.current : null;
  }, [high, get]);

  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    const cam = light.shadow.camera;
    cam.left = -17;
    cam.right = 17;
    cam.top = 13;
    cam.bottom = -13;
    cam.near = 2;
    cam.far = 48;
    cam.updateProjectionMatrix();
    light.shadow.radius = 4;
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.025;
    light.target.position.set(0, 0, 1);
    light.target.updateMatrixWorld();
  }, []);

  return (
    <>
      <hemisphereLight args={["#a8bdf0", "#3a2c20", high ? 1.5 : 1.9]} />
      <ambientLight color="#4a5a80" intensity={0.12} />
      <directionalLight
        ref={sun}
        color="#ffdcbc"
        intensity={high ? 2.2 : 2.4}
        position={[-8, 18, 11]}
        castShadow={high}
        shadow-mapSize={[2048, 2048]}
      />
      {/* Cool rim from the window wall. */}
      <directionalLight color="#7d97d8" intensity={0.45} position={[4, 6, -20]} />
      {WARM_LIGHTS.map(([x, y, z], i) => (
        <pointLight key={i} color="#ffbf82" intensity={high ? 26 : 30} distance={12} decay={1.6} position={[x, y, z]} />
      ))}
      <Environment resolution={128} frames={1} background={false} environmentIntensity={0.55}>
        {/* Dusk sky through the back windows, warm ceiling strips, a cool fill from the open front. */}
        <Lightformer form="rect" intensity={1.6} color="#e89a6a" position={[0, 2, -14]} scale={[34, 3, 1]} />
        <Lightformer form="rect" intensity={0.9} color="#3a4f8f" position={[0, 7, -14]} scale={[34, 6, 1]} />
        <Lightformer form="rect" intensity={2.2} color="#ffd2a1" position={[0, 6, -2]} rotation-x={Math.PI / 2} scale={[10, 1, 1]} />
        <Lightformer form="rect" intensity={2.2} color="#ffd2a1" position={[0, 6, 5]} rotation-x={Math.PI / 2} scale={[10, 1, 1]} />
        <Lightformer form="rect" intensity={0.7} color="#8fb0ff" position={[0, 3, 20]} rotation-y={Math.PI} scale={[30, 6, 1]} />
        <Lightformer form="circle" intensity={1.2} color="#ffb070" position={[-18, 4, 2]} rotation-y={Math.PI / 2} scale={4} />
      </Environment>
    </>
  );
}
