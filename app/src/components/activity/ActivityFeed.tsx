"use client";

import { memo } from "react";
import { ArrowRight } from "lucide-react";
import { sessionOf } from "@/audio/attention";
import { ProjectChip, useMultiSession } from "@/components/sessions/sessionUi";
import { Avatar, Empty, SEVERITY_COLOR, formatClock } from "@/components/ui";
import type { AgentEvent } from "@/events/eventTypes";
import { useWorldStore } from "@/state/useWorldStore";

const Row = memo(function Row({ e, compact, showProject }: { e: AgentEvent; compact: boolean; showProject: boolean }) {
  const who = showProject ? sessionOf(e) : null;
  const selectAgent = useWorldStore((s) => s.selectAgent);
  const selectTask = useWorldStore((s) => s.selectTask);
  const clickable = Boolean(e.agentId || e.taskId);
  const onClick = () => {
    if (e.agentId) selectAgent(e.agentId);
    else if (e.taskId) selectTask(e.taskId);
  };
  const body = (
    <>
      <span className={`mt-[7px] size-1.5 flex-none rounded-full ${SEVERITY_COLOR[e.severity]}`} aria-label={e.severity} />
      <span className="w-9 flex-none pt-px font-mono text-[10.5px] tabular-nums leading-5 text-mist-500">{formatClock(e.simTime)}</span>
      {e.agentId ? (
        <span className="flex flex-none items-center gap-0.5 pt-0.5">
          <Avatar id={e.agentId} size={16} />
          {e.targetAgentId ? (
            <>
              <ArrowRight size={10} className="text-mist-500" aria-label="to" />
              <Avatar id={e.targetAgentId} size={16} />
            </>
          ) : null}
        </span>
      ) : null}
      {who?.project ? (
        <span className="flex-none pt-0.5">
          <ProjectChip project={who.project} title={`${who.title ? `${who.title} · ` : ""}${who.project}`} />
        </span>
      ) : null}
      <span className={`min-w-0 flex-1 text-[12.5px] leading-5 ${e.severity === "error" ? "text-bad" : e.severity === "warning" ? "text-warn" : e.severity === "success" ? "text-ok" : "text-mist-300"} ${compact ? "truncate" : ""}`}>
        {e.message}
      </span>
    </>
  );
  return (
    <li>
      {clickable ? (
        <button type="button" onClick={onClick} className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-ink-700/60" title={e.agentId ? "Show this agent" : "Show this task"}>
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-1.5 py-1">{body}</div>
      )}
    </li>
  );
});

/** Newest first. `events` should already be filtered to the feed the caller wants. */
export function ActivityFeed({ events, limit, compact = false, empty = "No activity yet." }: { events: readonly AgentEvent[]; limit?: number; compact?: boolean; empty?: string }) {
  const showProject = useMultiSession();
  const rows = [...events].reverse().slice(0, limit ?? events.length);
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ol className="flex flex-col" aria-label="Activity feed">
      {rows.map((e) => (
        <Row key={e.id} e={e} compact={compact} showProject={showProject} />
      ))}
    </ol>
  );
}
