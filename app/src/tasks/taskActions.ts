import type { AgentId } from "../agents/agentTypes.ts";
import { isTerminal } from "../simulation/WorkflowStateMachine.ts";
import type { CreateTaskInput, Task } from "./taskTypes.ts";

export const DEMO_TASK: CreateTaskInput = {
  title: "Build a user authentication API with JWT support",
  description: "Register and login endpoints, short-lived access tokens with refresh rotation, and middleware that protects private routes.",
  priority: "high",
  isDemo: true,
  script: { qaFailsOn: [1], reviewChangesOn: [] },
};

export const activeTasks = (tasks: readonly Task[]) => tasks.filter((t) => t.phase !== "queued" && !isTerminal(t.phase));
export const queuedTasks = (tasks: readonly Task[]) => tasks.filter((t) => t.phase === "queued");
export const doneTasks = (tasks: readonly Task[]) => tasks.filter((t) => isTerminal(t.phase));
export const tasksForAgent = (tasks: readonly Task[], id: AgentId) => tasks.filter((t) => t.assignedAgentId === id);
