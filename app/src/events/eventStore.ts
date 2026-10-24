import type { AgentId } from "../agents/agentTypes.ts";
import { isCommunication } from "./eventTypes.ts";
import type { AgentEvent } from "./eventTypes.ts";

// Pure selectors over an event log. The UI store keeps the log; these never mutate it.

export function feedEvents(log: readonly AgentEvent[], messagesOnly = false): AgentEvent[] {
  return log.filter((e) => e.feed && (!messagesOnly || isCommunication(e)));
}

export function eventsForAgent(log: readonly AgentEvent[], id: AgentId): AgentEvent[] {
  return log.filter((e) => e.feed && (e.agentId === id || e.targetAgentId === id));
}

export function communicationsForAgent(log: readonly AgentEvent[], id: AgentId): AgentEvent[] {
  return log.filter((e) => isCommunication(e) && (e.agentId === id || e.targetAgentId === id));
}

export function eventsForTask(log: readonly AgentEvent[], taskId: string): AgentEvent[] {
  return log.filter((e) => e.taskId === taskId);
}

/** Append and cap, newest last. */
export function appendEvent(log: readonly AgentEvent[], e: AgentEvent, max: number): AgentEvent[] {
  const next = [...log, e];
  return next.length > max ? next.slice(next.length - max) : next;
}
