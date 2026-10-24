import type { LocationId, Vec2 } from "../simulation/worldLayout.ts";

export type AgentId = "orion" | "iris" | "piper" | "kai" | "quinn" | "rex";
export type AgentRole = "orchestrator" | "researcher" | "product_manager" | "engineer" | "qa" | "reviewer";
export type AgentStatus = "idle" | "walking" | "working" | "thinking" | "communicating" | "success" | "error";

export interface AgentProfile {
  id: AgentId;
  name: string;
  role: AgentRole;
  roleLabel: string;
  tagline: string;
  color: string;
  home: LocationId;
  seat: number;
}

/** Serialisable; a real backend sends the same shape. */
export interface AgentState {
  id: AgentId;
  status: AgentStatus;
  activity: string;
  currentTaskId: string | null;
  progress: number;
  location: LocationId | null;
  destination: LocationId | null;
  position: Vec2;
  heading: number;
  path: Vec2[];
  facingAgentId: AgentId | null;
  paused: boolean;
}
