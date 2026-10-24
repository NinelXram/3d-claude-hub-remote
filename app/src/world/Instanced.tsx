"use client";

import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";

/** One placed copy: position, optional Euler rotation, optional scale (number = uniform), optional colour. */
export interface InstanceSpec {
  p: readonly [number, number, number];
  r?: readonly [number, number, number];
  s?: number | readonly [number, number, number];
  c?: string;
}

const m4 = new THREE.Matrix4();
const pos = new THREE.Vector3();
const quat = new THREE.Quaternion();
const euler = new THREE.Euler();
const scl = new THREE.Vector3();
const col = new THREE.Color();

export function composeInstance(spec: InstanceSpec, out: THREE.Matrix4): THREE.Matrix4 {
  pos.set(spec.p[0], spec.p[1], spec.p[2]);
  if (spec.r) quat.setFromEuler(euler.set(spec.r[0], spec.r[1], spec.r[2]));
  else quat.identity();
  if (spec.s === undefined) scl.set(1, 1, 1);
  else if (typeof spec.s === "number") scl.setScalar(spec.s);
  else scl.set(spec.s[0], spec.s[1], spec.s[2]);
  return out.compose(pos, quat, scl);
}

/**
 * Static repeated furniture in one draw call (§0.4). Geometry and material come from the shared pools and
 * are not disposed here; the instance buffers are, by fiber, when the InstancedMesh unmounts.
 */
export function Instanced({
  geometry,
  material,
  items,
  castShadow = false,
  receiveShadow = true,
  name,
  meshRef,
}: {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  items: readonly InstanceSpec[];
  castShadow?: boolean;
  receiveShadow?: boolean;
  name?: string;
  /** Lets a parent reach the mesh (and its material) from `useFrame`. */
  meshRef?: React.RefObject<THREE.InstancedMesh | null>;
}) {
  const own = useRef<THREE.InstancedMesh>(null);
  const ref = meshRef ?? own;
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((it, i) => {
      mesh.setMatrixAt(i, composeInstance(it, m4));
      if (it.c) mesh.setColorAt(i, col.set(it.c));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items, ref]);
  return <instancedMesh ref={ref} name={name} args={[geometry, material, items.length]} castShadow={castShadow} receiveShadow={receiveShadow} />;
}
