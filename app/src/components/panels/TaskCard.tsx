"use client";

import { memo } from "react";
import { RefreshCw } from "lucide-react";
import { getAgent } from "@/agents/AgentRegistry";
import { ProjectChip, useMultiSession } from "@/components/sessions/sessionUi";
import { Avatar, DemoTag, PHASE_LABEL, PriorityTag, ProgressBar, TaskStatusBadge, relativeTime } from "@/components/ui";
import type { Task } from "@/tasks/taskTypes";

export function taskBarColor(t: Task): string {
  if (t.phase === "done") return "var(--color-ok)";
  if (t.phase === "failed") return "var(--color-bad)";
  if (t.status === "blocked") return "var(--color-warn)";
  return t.assignedAgentId ? getAgent(t.assignedAgentId).color : "var(--color-mist-500)";
}

function OwnerLine({ task }: { task: Task }) {
  if (task.assignedAgentId) {
    const a = getAgent(task.assignedAgentId);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        <Avatar id={a.id} size={18} />
        <span className="truncate text-[12px] text-mist-300">
          <span className="font-medium text-mist-100">{a.name}</span> · {PHASE_LABEL[task.phase]}
        </span>
      </span>
    );
  }
  const text = task.phase === "queued" ? "Waiting for orchestrator" : task.phase === "done" ? "Shipped" : task.phase === "failed" ? "Failed" : PHASE_LABEL[task.phase];
  return <span className="truncate text-[12px] text-mist-500">{text}</span>;
}

export const TaskCard = memo(function TaskCard({
  task,
  clock,
  selected,
  compact = false,
  onSelect,
}: {
  task: Task;
  clock: number;
  selected?: boolean;
  compact?: boolean;
  onSelect: (id: string) => void;
}) {
  const multi = useMultiSession();
  return (
    <button
      type="button"
      onClick={() => onSelect(task.id)}
      aria-pressed={selected}
      data-testid="task-card"
      className={`group flex w-full flex-col gap-2 rounded-xl border p-3 text-left transition-colors ${
        selected ? "border-signal/45 bg-ink-700/80" : "border-mist-500/10 bg-ink-850/60 hover:border-mist-500/25 hover:bg-ink-800/80"
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-[11px] font-semibold text-mist-500">{task.id}</span>
        <TaskStatusBadge status={task.status} />
        {task.isDemo ? <DemoTag /> : null}
        {multi && task.origin?.project ? <ProjectChip project={task.origin.project} /> : <PriorityTag priority={task.priority} />}
        {task.iteration > 1 ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-warn" title={`Implementation attempt ${task.iteration}`}>
            <RefreshCw size={11} />×{task.iteration - 1}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="line-clamp-2 text-[13px] font-medium leading-snug text-mist-100">{task.title}</span>
        {!compact && task.description ? <span className="line-clamp-2 text-[12px] leading-snug text-mist-500">{task.description}</span> : null}
      </div>
      <ProgressBar value={task.progress} color={taskBarColor(task)} />
      <div className="flex items-center justify-between gap-2">
        <OwnerLine task={task} />
        <span className="flex-none font-mono text-[10.5px] text-mist-500">{relativeTime(task.updatedAt, clock)}</span>
      </div>
    </button>
  );
});
