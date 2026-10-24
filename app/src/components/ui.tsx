"use client";

import type { ReactNode } from "react";
import { getAgent } from "@/agents/AgentRegistry";
import type { AgentId, AgentState, AgentStatus } from "@/agents/agentTypes";
import type { EventSeverity } from "@/events/eventTypes";
import { LOCATIONS } from "@/simulation/worldLayout";
import type { Task, TaskPriority, TaskStatus, WorkflowPhase } from "@/tasks/taskTypes";

// ───────────────────────── labels + formatting ─────────────────────────

export const PHASE_LABEL: Record<WorkflowPhase, string> = {
  queued: "Queued",
  intake: "Intake",
  planning: "Planning",
  research: "Research",
  implementation: "Implementation",
  testing: "Testing",
  review: "Review",
  done: "Done",
  failed: "Failed",
};

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Queued",
  assigned: "Assigned",
  in_progress: "In progress",
  testing: "Testing",
  review: "Review",
  blocked: "Blocked",
  completed: "Completed",
  failed: "Failed",
};

const STATUS_TONE: Record<TaskStatus, string> = {
  queued: "text-mist-300 bg-ink-600/60 border-mist-500/20",
  assigned: "text-signal-strong bg-signal/10 border-signal/25",
  in_progress: "text-signal-strong bg-signal/10 border-signal/25",
  testing: "text-[#c4b5fd] bg-[#a78bfa]/10 border-[#a78bfa]/25",
  review: "text-[#f9b4aa] bg-[#f08a7e]/10 border-[#f08a7e]/25",
  blocked: "text-warn bg-warn/10 border-warn/30",
  completed: "text-ok bg-ok/10 border-ok/25",
  failed: "text-bad bg-bad/10 border-bad/30",
};

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "Idle",
  walking: "Walking",
  working: "Working",
  thinking: "Thinking",
  communicating: "Talking",
  success: "Success",
  error: "Problem",
};

const AGENT_STATUS_TONE: Record<AgentStatus, string> = {
  idle: "text-mist-300 bg-ink-600/60 border-mist-500/20",
  walking: "text-signal-strong bg-signal/10 border-signal/25",
  working: "text-[#a9c4ff] bg-[#6c9eff]/12 border-[#6c9eff]/30",
  thinking: "text-[#c4b5fd] bg-[#a78bfa]/12 border-[#a78bfa]/30",
  communicating: "text-signal-strong bg-signal/15 border-signal/35",
  success: "text-ok bg-ok/10 border-ok/30",
  error: "text-warn bg-warn/10 border-warn/30",
};

const PRIORITY_TONE: Record<TaskPriority, string> = {
  critical: "text-bad border-bad/35",
  high: "text-warn border-warn/30",
  medium: "text-mist-300 border-mist-500/25",
  low: "text-mist-500 border-mist-500/20",
};

export const SEVERITY_COLOR: Record<EventSeverity, string> = {
  info: "bg-signal",
  success: "bg-ok",
  warning: "bg-warn",
  error: "bg-bad",
};

/** Simulation seconds as m:ss. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Relative time between two backend-clock values (seconds). */
export function relativeTime(at: number, clock: number): string {
  const d = Math.max(0, clock - at);
  if (d < 2) return "just now";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

export function locationLabel(a: AgentState): string {
  if (a.destination && a.status === "walking") return `Walking to ${LOCATIONS[a.destination]?.label ?? a.destination}`;
  if (a.location) return LOCATIONS[a.location]?.label ?? a.location;
  return "On the floor";
}

export function taskDone(t: Task): boolean {
  return t.phase === "done" || t.phase === "failed";
}

// ───────────────────────── atoms ─────────────────────────

export function Avatar({ id, size = 28, ring = false }: { id: AgentId; size?: number; ring?: boolean }) {
  const a = getAgent(id);
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-full font-semibold text-ink-950"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: `radial-gradient(circle at 35% 30%, ${a.color}, ${a.color}cc 60%, ${a.color}88)`,
        boxShadow: ring ? `0 0 0 2px #0a0e14, 0 0 0 3.5px ${a.color}` : `inset 0 -2px 4px rgb(0 0 0 / 0.25)`,
      }}
      title={`${a.name} · ${a.roleLabel}`}
      aria-hidden
    >
      {a.name[0]}
    </span>
  );
}

export function Pill({ className = "", children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-[10.5px] font-semibold tracking-wide ${className}`}>
      {children}
    </span>
  );
}

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return <Pill className={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Pill>;
}

export function PriorityTag({ priority }: { priority: TaskPriority }) {
  return <Pill className={`bg-transparent uppercase ${PRIORITY_TONE[priority]}`}>{priority}</Pill>;
}

export function DemoTag() {
  return (
    <Pill className="border-signal/40 bg-signal/10 text-signal-strong" title="The scripted demo task: QA fails the first build on purpose">
      DEMO
    </Pill>
  );
}

export function AgentStatusPill({ agent }: { agent: AgentState | undefined }) {
  if (!agent) return <Pill className={AGENT_STATUS_TONE.idle}>Offline</Pill>;
  if (agent.paused) return <Pill className="border-warn/35 bg-warn/10 text-warn">Paused</Pill>;
  return <Pill className={AGENT_STATUS_TONE[agent.status]}>{AGENT_STATUS_LABEL[agent.status]}</Pill>;
}

export function ProgressBar({ value, color, className = "" }: { value: number; color: string; className?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className={`h-1.5 w-full overflow-hidden rounded-full bg-ink-600/70 ${className}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export interface SegmentOption<T extends string | number> {
  value: T;
  label: ReactNode;
  title?: string;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  title,
  label,
  size = "md",
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  title?: string;
  label: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <div
      role="group"
      aria-label={label}
      title={title}
      className={`${size === "lg" ? "flex w-full" : "inline-flex flex-none"} items-center rounded-[10px] border border-mist-500/15 bg-ink-950/50 p-0.5 ${disabled ? "opacity-45" : ""}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            disabled={disabled}
            title={o.title}
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`${size === "sm" ? "h-6 px-2 text-[11px]" : size === "lg" ? "h-11 min-w-11 flex-1 px-3 text-[13px]" : "h-7 px-2.5 text-[12px] pointer-coarse:h-11 pointer-coarse:min-w-11"} whitespace-nowrap rounded-[8px] font-semibold transition-colors disabled:cursor-not-allowed ${
              active ? "bg-ink-600 text-mist-100 shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]" : "text-mist-500 hover:text-mist-100"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Section({ title, right, children, className = "" }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-mist-500/20 px-3 py-4 text-center text-[12.5px] leading-relaxed text-mist-500">{children}</p>;
}

export function Toggle({ checked, onChange, label, hint, disabled, title }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean; title?: string }) {
  return (
    <label className={`flex items-start justify-between gap-3 py-1 pointer-coarse:min-h-11 pointer-coarse:items-center ${disabled ? "opacity-50" : "cursor-pointer"}`} title={title}>
      <span className="flex flex-col">
        <span className="text-[13px] text-mist-100">{label}</span>
        {hint ? <span className="text-[11.5px] leading-snug text-mist-500">{hint}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden
        className={`relative mt-0.5 h-5 w-9 flex-none rounded-full border transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-signal ${
          checked ? "border-signal/60 bg-signal/70" : "border-mist-500/25 bg-ink-600"
        }`}
      >
        <span className={`absolute top-0.5 size-3.5 rounded-full bg-mist-100 shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
      </span>
    </label>
  );
}

export function StatusDot({ tone, pulse = false, className = "" }: { tone: "ok" | "warn" | "idle" | "bad"; pulse?: boolean; className?: string }) {
  const color = { ok: "bg-ok text-ok", warn: "bg-warn text-warn", idle: "bg-mist-500 text-mist-500", bad: "bg-bad text-bad" }[tone];
  return <span className={`inline-block size-2 flex-none rounded-full ${color} ${pulse ? "pulse-dot" : ""} ${className}`} aria-hidden />;
}
