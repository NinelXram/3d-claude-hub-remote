import { PRIORITY_ORDER } from "../tasks/taskTypes.ts";
import type { Task, TaskPriority } from "../tasks/taskTypes.ts";
import { isTerminal } from "./WorkflowStateMachine.ts";

/** Total order used everywhere work competes: priority, then oldest, then submission order. */
export function compareWork(
  a: { priority: TaskPriority; createdAt: number; seq: number },
  b: { priority: TaskPriority; createdAt: number; seq: number },
): number {
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt || a.seq - b.seq;
}

export function activeCount(tasks: Iterable<Task>): number {
  let n = 0;
  for (const t of tasks) if (t.phase !== "queued" && !isTerminal(t.phase)) n++;
  return n;
}

/** Orchestrator intake: the next queued task to pick up, or null if at capacity / nothing waiting. */
export function pickNextTask(tasks: Task[], seqOf: (t: Task) => number, maxConcurrent: number): Task | null {
  if (activeCount(tasks) >= maxConcurrent) return null;
  let best: Task | null = null;
  for (const t of tasks) {
    if (t.phase !== "queued") continue;
    if (!best || compareWork({ ...t, seq: seqOf(t) }, { ...best, seq: seqOf(best) }) < 0) best = t;
  }
  return best;
}
