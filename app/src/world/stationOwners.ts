import { STATION_OWNERS } from "@/agents/AgentRegistry";
import type { AgentId } from "@/agents/agentTypes";
import { LOCATIONS } from "@/simulation/worldLayout";
import type { Vec2 } from "@/simulation/worldLayout";

/**
 * Desks (§5): each sits 1.2 m behind its stand slot, rotation 0 (monitors face +z, towards the agent).
 * The owner only decides whose status lights the desk's screens; it says nothing about where agents live.
 */
export type StationId = "ops" | "research" | "product" | "dev" | "testing" | "review";

export interface StationDef {
  id: StationId;
  label: string;
  owner: AgentId;
  /** Desk centre on the floor. */
  position: Vec2;
  rotation: number;
  monitors: number;
}

export const STATION_IDS: StationId[] = ["ops", "research", "product", "dev", "testing", "review"];

const MONITORS: Record<StationId, number> = { ops: 3, research: 2, product: 2, dev: 3, testing: 2, review: 2 };

export const STATIONS: StationDef[] = STATION_IDS.map((id) => {
  const slot = LOCATIONS[id].slots[0]!;
  return {
    id,
    label: LOCATIONS[id].label,
    owner: STATION_OWNERS[id]!,
    position: { x: slot.x, z: slot.z - 1.2 },
    rotation: 0,
    monitors: MONITORS[id],
  };
});

const BY_ID = new Map(STATIONS.map((s) => [s.id, s]));

export function getStation(id: StationId): StationDef {
  return BY_ID.get(id)!;
}

