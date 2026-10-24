import type { AgentId } from "../agents/agentTypes.ts";

export const EVENT_TYPES = [
  "system.ready", "system.started", "system.paused", "system.resumed", "system.stopped", "system.reset", "system.speed_changed",
  "task.created", "task.assigned", "task.status_changed", "task.completed", "task.failed", "task.blocked", "task.unblocked",
  "plan.created", "research.completed", "implementation.started", "implementation.submitted",
  "qa.started", "qa.passed", "qa.failed", "review.started", "review.approved", "review.changes_requested",
  "agent.message", "agent.arrived", "agent.paused", "agent.resumed", "agent.ambient",
] as const;

export type AgentEventType = (typeof EVENT_TYPES)[number];
export type EventSeverity = "info" | "success" | "warning" | "error";

export interface AgentEvent {
  id: string;
  type: AgentEventType;
  /** Wall-clock ms. Not part of determinism. */
  timestamp: number;
  /** Backend clock, seconds. */
  simTime: number;
  agentId?: AgentId;
  targetAgentId?: AgentId;
  taskId?: string;
  message: string;
  severity: EventSeverity;
  /** Belongs in the human-facing activity feed? */
  feed: boolean;
  metadata?: Record<string, unknown>;
}

const COMMUNICATION_TYPES: ReadonlySet<AgentEventType> = new Set(["agent.message", "task.assigned"]);

export function isCommunication(e: AgentEvent): boolean {
  return e.targetAgentId !== undefined && COMMUNICATION_TYPES.has(e.type);
}
