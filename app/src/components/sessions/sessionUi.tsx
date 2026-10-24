"use client";

import { useEffect, useState } from "react";
import { GitBranch, Globe, Terminal } from "lucide-react";
import { Pill } from "@/components/ui";
import type { SessionInfo } from "@/integrations/AgentBackend";
import { useWorldStore } from "@/state/useWorldStore";

// Small pieces shared by the Sessions tab and the permission cards. Every string from the server (titles,
// prompts, tool output, paths) is rendered as a React text node, never as HTML.

export const SESSION_STATUS_LABEL: Record<SessionInfo["status"], string> = {
  running: "Running",
  waiting: "Waiting",
  idle: "Idle",
  ended: "Ended",
};

const SESSION_STATUS_TONE: Record<SessionInfo["status"], string> = {
  running: "text-signal-strong bg-signal/10 border-signal/30",
  waiting: "text-warn bg-warn/10 border-warn/35",
  idle: "text-ok bg-ok/10 border-ok/25",
  ended: "text-mist-500 bg-ink-600/50 border-mist-500/20",
};

const STATUS_HINT: Record<SessionInfo["status"], string> = {
  running: "A turn is in progress",
  waiting: "Needs permission or an answer",
  idle: "The turn ended; waiting for the next prompt",
  ended: "The session is closed",
};

export function SessionStatusChip({ status }: { status: SessionInfo["status"] }) {
  return (
    <Pill className={SESSION_STATUS_TONE[status]} title={STATUS_HINT[status]}>
      {status === "running" || status === "waiting" ? <span className={`size-1.5 rounded-full ${status === "running" ? "bg-signal-strong" : "bg-warn"} pulse-dot`} aria-hidden /> : null}
      {SESSION_STATUS_LABEL[status]}
    </Pill>
  );
}

export function OwnerTag({ owner }: { owner: SessionInfo["owner"] }) {
  return owner === "web" ? (
    <span className="inline-flex items-center gap-1 text-[11px] text-mist-300" title="Started or continued from this page">
      <Globe size={11} aria-hidden /> Web
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] text-mist-500" title="Running in a terminal; read-only here">
      <Terminal size={11} aria-hidden /> Terminal
    </span>
  );
}

const DOT_TONE: Record<SessionInfo["status"], string> = {
  running: "bg-signal-strong pulse-dot",
  waiting: "bg-warn pulse-dot",
  idle: "bg-ok",
  ended: "bg-mist-500",
};

/** A session's status as a dot (the label is given by the caller, or by `title`). */
export function SessionDot({ status }: { status: SessionInfo["status"] }) {
  return <span className={`inline-block size-2 flex-none rounded-full ${DOT_TONE[status]}`} title={SESSION_STATUS_LABEL[status]} aria-hidden />;
}

/** A stable hue per project name, so rows from the same project read as one at a glance. */
function projectHue(project: string): number {
  let h = 0;
  for (let i = 0; i < project.length; i++) h = (h * 31 + project.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** Which project (the cwd's last segment) a session, task or feed row belongs to. */
/** The git branch a session is on (the latest one Claude Code recorded). */
export function BranchChip({ branch }: { branch: string }) {
  return (
    <span className="inline-flex min-w-0 max-w-[18ch] items-center gap-0.5 font-mono text-[10.5px] text-mist-300" title={`Git branch: ${branch}`} data-testid="branch-chip">
      <GitBranch size={11} aria-hidden className="flex-none text-mist-500" />
      <span className="sr-only">Branch </span>
      <span className="truncate">{branch}</span>
    </span>
  );
}

export function ProjectChip({ project, title }: { project: string; title?: string }) {
  const hue = projectHue(project);
  return (
    <span
      className="inline-flex h-4 max-w-[12ch] flex-none items-center truncate rounded border px-1 font-mono text-[10px] leading-none"
      style={{ color: `hsl(${hue} 70% 74%)`, borderColor: `hsl(${hue} 60% 60% / 0.35)`, background: `hsl(${hue} 60% 40% / 0.12)` }}
      title={title ?? `Project: ${project}`}
      data-testid="project-chip"
    >
      <span className="truncate">{project}</span>
    </span>
  );
}

/**
 * More than one Claude Code session in view (live only): feed rows and task cards then say which project they
 * belong to. With one session the chip would only repeat itself.
 */
export function useMultiSession(): boolean {
  return useWorldStore((s) => {
    if (s.backend.simulated) return false;
    if ((s.live?.sessions.length ?? 0) > 1) return true;
    let first: string | undefined;
    for (const t of s.tasks) {
      const id = t.origin?.sessionId;
      if (!id) continue;
      if (first === undefined) first = id;
      else if (id !== first) return true;
    }
    return false;
  });
}

/** Last path segment, for a compact cwd. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Wall-clock ms → "just now", "5m ago"… */
export function ago(ms: number, now: number): string {
  const d = Math.max(0, (now - ms) / 1000);
  if (d < 10) return "just now";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** A wall clock that ticks every `ms`, for relative times (a few renders a minute of one small list). */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
