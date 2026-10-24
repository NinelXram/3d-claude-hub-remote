"use client";

import { useMemo } from "react";
import { AlertTriangle, ArrowLeft, Check, CircleSlash, MessagesSquare, PauseCircle, RefreshCw } from "lucide-react";
import { getAgent } from "@/agents/AgentRegistry";
import { Avatar, DemoTag, Empty, PHASE_LABEL, PriorityTag, ProgressBar, Section, TaskStatusBadge, formatClock } from "@/components/ui";
import { taskBarColor } from "@/components/panels/TaskCard";
import { eventsForTask } from "@/events/eventStore";
import { sessionCommands } from "@/integrations/sessionClient";
import { useSessionStore } from "@/state/useSessionStore";
import { useWorldStore } from "@/state/useWorldStore";
import type { Task, WorkflowPhase } from "@/tasks/taskTypes";

const STEPS: WorkflowPhase[] = ["intake", "planning", "research", "implementation", "testing", "review", "done"];

function PhaseSteps({ task }: { task: Task }) {
  const reached = new Set<WorkflowPhase>(task.history.map((h) => h.to));
  return (
    <ol className="flex items-center gap-1" aria-label="Workflow phases">
      {STEPS.map((p) => {
        const current = task.phase === p;
        const past = reached.has(p) && !current;
        return (
          <li
            key={p}
            title={PHASE_LABEL[p]}
            className={`h-1.5 flex-1 rounded-full ${current ? (task.status === "blocked" ? "bg-warn" : "bg-signal-strong") : past ? "bg-signal/45" : "bg-ink-600/80"}`}
          />
        );
      })}
    </ol>
  );
}

/** Live mode: the Claude Code session behind this task, when the server can open it. */
function OpenSessionButton({ taskId }: { taskId: string }) {
  const live = useWorldStore((s) => s.backend.identified && !s.backend.simulated);
  const sessionId = useSessionStore((s) => s.taskSessions[taskId]);
  const known = useSessionStore((s) => (sessionId ? s.sessions.some((x) => x.sessionId === sessionId) : false));
  const enabled = useSessionStore((s) => s.capabilities.sessions);
  if (!live || !enabled || !sessionId || !known) return null;
  return (
    <button
      type="button"
      className="btn self-start"
      onClick={() => {
        void sessionCommands.open(sessionId);
        useWorldStore.getState().setTab("sessions");
      }}
      title="Read this task's Claude Code session"
    >
      <MessagesSquare size={14} /> Open session
    </button>
  );
}

export function TaskDetails({ task, onBack }: { task: Task; onBack: () => void }) {
  const events = useWorldStore((s) => s.events);
  const selectAgent = useWorldStore((s) => s.selectAgent);
  const failure = useMemo(() => {
    if (task.phase !== "failed") return null;
    const e = [...eventsForTask(events, task.id)].reverse().find((x) => x.type === "task.failed");
    return e?.message ?? `${task.id} failed`;
  }, [events, task.id, task.phase]);

  const owner = task.assignedAgentId ? getAgent(task.assignedAgentId) : null;
  const doneCount = task.subtasks.filter((s) => s.done).length;
  const reworks = Math.max(0, task.iteration - 1);

  return (
    <div className="flex flex-col gap-4" data-testid="task-details">
      <div className="flex flex-col gap-2">
        <button type="button" onClick={onBack} className="btn btn-quiet -ml-2 h-7 self-start px-2 text-[12px]">
          <ArrowLeft size={13} /> All tasks
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11.5px] font-semibold text-mist-500">{task.id}</span>
          <TaskStatusBadge status={task.status} />
          {task.isDemo ? <DemoTag /> : null}
          <PriorityTag priority={task.priority} />
        </div>
        <h2 className="text-[15px] font-semibold leading-snug text-mist-100">{task.title}</h2>
        {task.description ? <p className="text-[12.5px] leading-relaxed text-mist-300">{task.description}</p> : null}
        <OpenSessionButton taskId={task.id} />
        {task.preferredAgentId ? (
          <p className="text-[11.5px] text-mist-500">
            Requested from {getAgent(task.preferredAgentId).name}, routed via Orion.
          </p>
        ) : null}
      </div>

      {task.status === "blocked" ? (
        <div className="flex items-start gap-2 rounded-xl border border-warn/35 bg-warn/10 px-3 py-2 text-[12.5px] text-warn" role="status">
          <PauseCircle size={15} className="mt-0.5 flex-none" />
          <span>Blocked: {task.blockedReason ?? "waiting on a paused agent"}. Resume the agent to continue.</span>
        </div>
      ) : null}
      {failure ? (
        <div className="flex items-start gap-2 rounded-xl border border-bad/35 bg-bad/10 px-3 py-2 text-[12.5px] text-bad" role="alert">
          <CircleSlash size={15} className="mt-0.5 flex-none" />
          <span>{failure}</span>
        </div>
      ) : null}

      <Section title="Workflow">
        <div className="flex flex-col gap-2.5 rounded-xl border border-mist-500/10 bg-ink-850/60 p-3">
          <div className="flex items-center justify-between text-[12.5px]">
            <span className="font-medium text-mist-100">{PHASE_LABEL[task.phase]}</span>
            <span className="font-mono text-mist-300 tabular-nums">{Math.round(task.progress * 100)}%</span>
          </div>
          <ProgressBar value={task.progress} color={taskBarColor(task)} />
          <PhaseSteps task={task} />
          <div className="flex items-center justify-between gap-2 text-[12px] text-mist-300">
            {owner ? (
              <button type="button" className="flex items-center gap-1.5 hover:text-mist-100" onClick={() => selectAgent(owner.id)}>
                <Avatar id={owner.id} size={18} />
                <span>
                  {owner.name} · {owner.roleLabel}
                </span>
              </button>
            ) : (
              <span className="text-mist-500">{task.phase === "queued" ? "Waiting for orchestrator" : "Unassigned"}</span>
            )}
            {task.iteration > 0 ? <span className="text-mist-500">Build #{task.iteration}</span> : null}
          </div>
          {reworks > 0 ? (
            <p className="flex items-center gap-1.5 text-[12px] text-warn">
              <RefreshCw size={12} /> Reworked {reworks}× after QA/review feedback
            </p>
          ) : null}
        </div>
      </Section>

      <Section title={`Task cards · ${task.subtasks.length}`} right={task.subtasks.length ? <span className="font-mono text-[11px] text-mist-500">{doneCount}/{task.subtasks.length}</span> : null}>
        {task.subtasks.length === 0 ? (
          <Empty>No task cards yet; they appear when planning finishes.</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {task.subtasks.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-[12.5px] leading-snug">
                <span className={`mt-0.5 inline-flex size-4 flex-none items-center justify-center rounded-[5px] border ${s.done ? "border-ok/50 bg-ok/15 text-ok" : "border-mist-500/30 text-transparent"}`}>
                  <Check size={11} strokeWidth={3} />
                </span>
                <span className={s.done ? "text-mist-300" : "text-mist-100"}>{s.title}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Research findings">
        {task.findings.length === 0 ? (
          <Empty>No findings yet; they appear when research finishes.</Empty>
        ) : (
          <ul className="flex list-disc flex-col gap-1 pl-4 text-[12.5px] leading-snug text-mist-300 marker:text-signal">
            {task.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Timeline">
        {task.history.length === 0 ? (
          <Empty>Created at {formatClock(task.createdAt)}; no transitions yet.</Empty>
        ) : (
          <ol className="flex flex-col gap-1">
            <li className="flex items-center gap-2 text-[12px] text-mist-500">
              <span className="w-9 font-mono text-[10.5px] tabular-nums">{formatClock(task.createdAt)}</span>
              <span>Created</span>
            </li>
            {task.history.map((h, i) => {
              const bad = h.signal === "tests_failed" || h.signal === "changes_requested" || h.to === "failed";
              return (
                <li key={i} className="flex items-center gap-2 text-[12px]">
                  <span className="w-9 font-mono text-[10.5px] tabular-nums text-mist-500">{formatClock(h.at)}</span>
                  <span className="text-mist-300">
                    {PHASE_LABEL[h.from]} → <span className="text-mist-100">{PHASE_LABEL[h.to]}</span>
                  </span>
                  <span className={`ml-auto inline-flex items-center gap-1 font-mono text-[10.5px] ${bad ? "text-warn" : "text-mist-500"}`}>
                    {bad ? <AlertTriangle size={10} /> : null}
                    {h.signal}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Section>
    </div>
  );
}
