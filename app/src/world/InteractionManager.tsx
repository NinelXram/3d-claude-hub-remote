"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import type { AgentId } from "@/agents/agentTypes";
import { useWorldStore } from "@/state/useWorldStore";
import { FOCUS_DISTANCE_STATION } from "@/world/cameraPresets";
import { geometries, sharedMaterial } from "@/world/sharedResources";
import { STATIONS, getStation } from "@/world/stationOwners";
import type { StationId } from "@/world/stationOwners";

/**
 * Picking (§6.7). R3F's pointer system raycasts against invisible, simple hit meshes (boxes on desks here,
 * cylinders on robots in Phase 4). A press counts as a click only if the pointer moved ≤ 5 px; anything
 * longer is an orbit drag, which also cancels camera moves and releases follow mode (CameraController reads
 * `pointerState.dragNonce`).
 */

export type HitKey = `agent:${AgentId}` | `station:${StationId}`;

export const CLICK_TOLERANCE_PX = 5;

/** Module-level so hit handlers (inside the scene) and the DOM listeners (on the canvas wrapper) share it. */
export const pointerState = {
  downX: 0,
  downY: 0,
  down: false,
  dragging: false,
  /** Bumped once per drag that exceeded the click tolerance. */
  dragNonce: 0,
  /** Bumped on every wheel zoom. */
  wheelNonce: 0,
  /** A hit mesh handled the current click, so the empty-space handler must not clear the selection. */
  hitThisClick: false,
  element: null as HTMLElement | null,
};

export function isClick(e: { clientX: number; clientY: number }): boolean {
  return Math.hypot(e.clientX - pointerState.downX, e.clientY - pointerState.downY) <= CLICK_TOLERANCE_PX;
}

function setCursor(cursor: string): void {
  if (pointerState.element) pointerState.element.style.cursor = cursor;
}

/** Selecting a desk opens its owner's panel and focuses the camera on the desk. */
export function selectStation(id: StationId): void {
  const station = getStation(id);
  const st = useWorldStore.getState();
  st.setFollow(null);
  st.selectAgent(station.owner);
  // Issued after selectAgent's own focus request, so this newer nonce wins.
  st.requestCamera({ focus: { x: station.position.x, y: 0.8, z: station.position.z + 0.4 }, distance: FOCUS_DISTANCE_STATION });
}

export function selectAgentInWorld(id: AgentId): void {
  useWorldStore.getState().selectAgent(id);
}

/** Pointer handlers for one hit mesh: hover sets `hovered` + the pointer cursor, a real click selects. */
export function useHitHandlers(key: HitKey, onSelect: () => void) {
  return useMemo(
    () => ({
      onPointerOver: (e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        useWorldStore.getState().setHovered(key);
        setCursor("pointer");
      },
      onPointerOut: () => {
        if (useWorldStore.getState().hovered === key) useWorldStore.getState().setHovered(null);
        setCursor("");
      },
      onClick: (e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (!isClick(e.nativeEvent)) return;
        pointerState.hitThisClick = true;
        onSelect();
      },
    }),
    [key, onSelect],
  );
}

const hitMaterial = () => sharedMaterial("hit", () => new THREE.MeshBasicMaterial({ visible: false }));

function StationHit({ id }: { id: StationId }) {
  const station = getStation(id);
  const onSelect = useMemo(() => () => selectStation(id), [id]);
  const handlers = useHitHandlers(`station:${id}`, onSelect);
  // Covers desk, monitors and chair; not the stand slot in front, where the robot will be picked instead.
  return (
    <mesh
      geometry={geometries.box()}
      material={hitMaterial()}
      position={[station.position.x, 0.75, station.position.z + 0.1]}
      scale={[2.5, 1.5, 1.5]}
      {...handlers}
    />
  );
}

/** Owns the DOM-side pointer bookkeeping and the station hit meshes. Mount once inside the Canvas. */
export function InteractionManager() {
  const target = useThree((s) => s.events.connected) as HTMLElement | null | undefined;
  const canvas = useThree((s) => s.gl.domElement);

  useEffect(() => {
    const el = target ?? canvas;
    pointerState.element = canvas;
    const onDown = (e: PointerEvent) => {
      pointerState.down = true;
      pointerState.dragging = false;
      pointerState.hitThisClick = false;
      pointerState.downX = e.clientX;
      pointerState.downY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!pointerState.down || pointerState.dragging || e.buttons === 0) return;
      if (!isClick(e)) {
        pointerState.dragging = true;
        pointerState.dragNonce++;
      }
    };
    const onUp = () => {
      pointerState.down = false;
    };
    const onLeave = () => {
      if (useWorldStore.getState().hovered) useWorldStore.getState().setHovered(null);
      setCursor("");
    };
    const onClickDom = (e: MouseEvent) => {
      if (!isClick(e)) return;
      // R3F dispatches object clicks from its own listener; check once it has run.
      setTimeout(() => {
        if (pointerState.hitThisClick) return;
        const st = useWorldStore.getState();
        if (st.selectedAgentId || st.selectedTaskId || st.followAgentId) st.clearSelection();
      }, 0);
    };
    const onWheel = () => {
      pointerState.wheelNonce++;
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("click", onClickDom);
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("pointerleave", onLeave);
      el.removeEventListener("click", onClickDom);
      el.removeEventListener("wheel", onWheel);
      if (pointerState.element === canvas) pointerState.element = null;
    };
  }, [target, canvas]);

  return (
    <group name="hit-meshes">
      {STATIONS.map((s) => (
        <StationHit key={s.id} id={s.id} />
      ))}
    </group>
  );
}
