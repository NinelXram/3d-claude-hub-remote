import type { AgentId } from "../agents/agentTypes.ts";

export type WorkflowPhase =
  | "queued"
  | "intake"
  | "planning"
  | "research"
  | "implementation"
  | "testing"
  | "review"
  | "done"
  | "failed";

export type TaskStatus =
  | "queued"
  | "assigned"
  | "in_progress"
  | "testing"
  | "review"
  | "blocked"
  | "completed"
  | "failed";

export type TaskPriority = "low" | "medium" | "high" | "critical";

export const PRIORITY_ORDER: Record<TaskPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export type WorkflowSignal =
  | "picked_up"
  | "delegated"
  | "plan_ready"
  | "findings_published"
  | "submitted"
  | "tests_passed"
  | "tests_failed"
  | "approved"
  | "changes_requested"
  | "abort"
  /** Live sources only: the phase was inferred from what a real session did, not driven by the workflow. */
  | "observed";

export const PHASE_STATUS: Record<WorkflowPhase, TaskStatus> = {
  queued: "queued",
  intake: "assigned",
  planning: "in_progress",
  research: "in_progress",
  implementation: "in_progress",
  testing: "testing",
  review: "review",
  done: "completed",
  failed: "failed",
};

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

export interface TaskTransition {
  from: WorkflowPhase;
  to: WorkflowPhase;
  signal: WorkflowSignal;
  at: number;
}

export interface TaskScript {
  qaFailsOn?: number[];
  reviewChangesOn?: number[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  phase: WorkflowPhase;
  assignedAgentId: AgentId | null;
  progress: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  iteration: number;
  subtasks: Subtask[];
  findings: string[];
  history: TaskTransition[];
  isDemo: boolean;
  preferredAgentId: AgentId | null;
  blockedReason: string | null;
  script?: TaskScript;
  /** Live sources: the Claude Code session (and its project, the cwd's last segment) this prompt came from. */
  origin?: { sessionId: string; project: string };
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  preferredAgentId?: AgentId;
  isDemo?: boolean;
  script?: TaskScript;
}
