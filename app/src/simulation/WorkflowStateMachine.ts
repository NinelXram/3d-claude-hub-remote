import { PHASE_STATUS } from "../tasks/taskTypes.ts";
import type { Task, WorkflowPhase, WorkflowSignal } from "../tasks/taskTypes.ts";
import { SIM_CONFIG } from "./simulationConfig.ts";

const TRANSITIONS: Record<WorkflowPhase, Partial<Record<WorkflowSignal, WorkflowPhase>>> = {
  queued: { picked_up: "intake" },
  intake: { delegated: "planning" },
  planning: { plan_ready: "research" },
  research: { findings_published: "implementation" },
  implementation: { submitted: "testing" },
  testing: { tests_passed: "review", tests_failed: "implementation" },
  review: { approved: "done", changes_requested: "implementation" },
  done: {},
  failed: {},
};

const REWORK: ReadonlySet<WorkflowSignal> = new Set(["tests_failed", "changes_requested"]);

export function isTerminal(phase: WorkflowPhase): boolean {
  return phase === "done" || phase === "failed";
}

export function nextPhase(phase: WorkflowPhase, signal: WorkflowSignal): WorkflowPhase | null {
  if (signal === "abort") return isTerminal(phase) ? null : "failed";
  if (signal === "observed") return null; // live-only; never a workflow transition
  return TRANSITIONS[phase][signal] ?? null;
}

export function canTransition(phase: WorkflowPhase, signal: WorkflowSignal): boolean {
  return nextPhase(phase, signal) !== null;
}

/** Pure: returns a new task. Throws on an illegal transition so bugs surface in tests. */
export function applySignal(task: Task, signal: WorkflowSignal, at: number): Task {
  const to = nextPhase(task.phase, signal);
  if (!to) throw new Error(`Illegal transition ${task.phase} --${signal}--> (task ${task.id})`);
  const [phaseStart] = SIM_CONFIG.phaseProgress[to];
  const progress = to === "failed" ? task.progress : REWORK.has(signal) ? phaseStart : Math.max(task.progress, phaseStart);
  return {
    ...task,
    phase: to,
    status: PHASE_STATUS[to],
    blockedReason: null,
    iteration: to === "implementation" ? task.iteration + 1 : task.iteration,
    progress,
    updatedAt: at,
    completedAt: isTerminal(to) ? at : task.completedAt,
    history: [...task.history, { from: task.phase, to, signal, at }],
  };
}
