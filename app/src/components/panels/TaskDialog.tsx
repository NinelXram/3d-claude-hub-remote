"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dices, Info, Sparkles, X } from "lucide-react";
import { getAgent } from "@/agents/AgentRegistry";
import type { AgentId } from "@/agents/agentTypes";
import { Segmented } from "@/components/ui";
import { commands } from "@/integrations/backendClient";
import { useWorldStore } from "@/state/useWorldStore";
import { DEMO_TASK } from "@/tasks/taskActions";
import { TASK_BACKLOG, TASK_SUGGESTIONS, pickRandomTask } from "@/tasks/taskBacklog";
import type { CreateTaskInput, TaskPriority } from "@/tasks/taskTypes";

const PRIORITIES: { value: TaskPriority; label: string }[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const CHIPS: CreateTaskInput[] = [DEMO_TASK, ...TASK_SUGGESTIONS.map((title) => TASK_BACKLOG.find((t) => t.title === title)!).filter(Boolean)];

export function TaskDialog() {
  const open = useWorldStore((s) => s.dialog.open);
  const preferred = useWorldStore((s) => s.dialog.preferredAgentId);
  if (!open) return null;
  return <DialogBody preferredAgentId={preferred} />;
}

function DialogBody({ preferredAgentId }: { preferredAgentId: AgentId | null }) {
  const close = useWorldStore((s) => s.closeDialog);
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  /** The backlog/demo entry the fields came from, so its script (scripted outcomes) survives submission. */
  const [template, setTemplate] = useState<CreateTaskInput | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const fill = (t: CreateTaskInput) => {
    setTitle(t.title);
    setDescription(t.description ?? "");
    setPriority(t.priority ?? "medium");
    setTemplate(t);
  };

  const surprise = () => {
    const taken = new Set(useWorldStore.getState().tasks.map((t) => t.title));
    if (title) taken.add(title);
    fill(pickRandomTask(taken));
  };

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const fromTemplate = template && template.title === trimmed ? template : null;
    const input: CreateTaskInput = {
      title: trimmed,
      description: description.trim(),
      priority,
      ...(preferredAgentId ? { preferredAgentId } : {}),
      ...(fromTemplate?.isDemo ? { isDemo: true } : {}),
      ...(fromTemplate?.script ? { script: fromTemplate.script } : {}),
    };
    const task = await commands.submitTask(input);
    setBusy(false);
    if (!task) return; // the error is already shown as a notice; keep the form so nothing is lost
    close();
    const st = useWorldStore.getState();
    st.selectTask(task.id);
    st.requestCamera({ preset: "collaboration" });
  };

  const agent = preferredAgentId ? getAgent(preferredAgentId) : null;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink-950/65 p-3 backdrop-blur-[2px] [animation:aaw-fade-in_140ms_ease-out] sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="surface flex max-h-[calc(100dvh-24px)] w-full max-w-[560px] flex-col overflow-hidden [animation:aaw-rise-in_180ms_ease-out]"
        data-testid="task-dialog"
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-center justify-between border-b border-mist-500/10 px-5 py-3.5">
            <h2 id={titleId} className="text-[15px] font-semibold text-mist-100">
              {agent ? `Assign a task to ${agent.name}` : "New task"}
            </h2>
            <button type="button" className="btn btn-quiet w-8 px-0" onClick={close} aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <div className="scroll-thin flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4">
            {agent ? (
              <p className="flex items-start gap-2 rounded-xl border border-signal/25 bg-signal/10 px-3 py-2 text-[12.5px] text-signal-strong">
                <Info size={14} className="mt-0.5 flex-none" />
                Requested from {agent.name} — routed via the Orchestrator so the full workflow still applies.
              </p>
            ) : null}

            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">Suggestions</span>
              <div className="flex flex-wrap gap-1.5">
                {CHIPS.map((c) => (
                  <button
                    key={c.title}
                    type="button"
                    onClick={() => fill(c)}
                    className={`max-w-full truncate rounded-full border px-2.5 py-1 text-[11.5px] transition-colors ${
                      title === c.title ? "border-signal/50 bg-signal/15 text-signal-strong" : "border-mist-500/15 text-mist-300 hover:border-mist-500/30 hover:text-mist-100"
                    }`}
                  >
                    {c.isDemo ? "★ " : ""}
                    {c.title}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Title</span>
              <input ref={titleRef} className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What should the team ship?" maxLength={140} required />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="eyebrow">Description</span>
              <textarea className="field min-h-[84px] resize-y" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional: context, constraints, acceptance criteria" rows={3} maxLength={600} />
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="eyebrow">Priority</span>
              <Segmented label="Priority" value={priority} onChange={setPriority} options={PRIORITIES} />
            </div>

            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="btn btn-ghost" onClick={() => fill(DEMO_TASK)}>
                <Sparkles size={14} /> Use demo task
              </button>
              <button type="button" className="btn btn-ghost" onClick={surprise}>
                <Dices size={14} /> Surprise me
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-3 border-t border-mist-500/10 px-5 py-3.5">
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-quiet" onClick={close}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={!title.trim() || busy}>
                Submit task
              </button>
            </div>
            <p className="text-[11.5px] leading-snug text-warn/90">Simulation mode — agents act out the workflow; no AI inference or code execution happens.</p>
          </div>
        </form>
      </div>
    </div>
  );
}
