"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, Crosshair, Eye, EyeOff, Pause, Play, Plus } from "lucide-react";
import { getAgent } from "@/agents/AgentRegistry";
import type { AgentId } from "@/agents/agentTypes";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { useBackendCaps } from "@/components/backendCaps";
import { AgentStatusPill, Avatar, ProgressBar, Segmented, locationLabel } from "@/components/ui";
import { communicationsForAgent, eventsForAgent } from "@/events/eventStore";
import { commands } from "@/integrations/backendClient";
import { liveWorld, useWorldStore } from "@/state/useWorldStore";

export function AgentDetails({ id, onBack }: { id: AgentId; onBack: () => void }) {
  const profile = getAgent(id);
  const agent = useWorldStore((s) => s.agents.find((a) => a.id === id));
  const tasks = useWorldStore((s) => s.tasks);
  const events = useWorldStore((s) => s.events);
  const followAgentId = useWorldStore((s) => s.followAgentId);
  const setFollow = useWorldStore((s) => s.setFollow);
  const openDialog = useWorldStore((s) => s.openDialog);
  const selectTask = useWorldStore((s) => s.selectTask);
  const requestCamera = useWorldStore((s) => s.requestCamera);
  const caps = useBackendCaps();
  const [tab, setTab] = useState<"activity" | "comms">("activity");

  const activity = useMemo(() => eventsForAgent(events, id), [events, id]);
  const comms = useMemo(() => communicationsForAgent(events, id), [events, id]);
  const task = agent?.currentTaskId ? tasks.find((t) => t.id === agent.currentTaskId) : undefined;
  const queued = tasks.filter((t) => t.assignedAgentId === id && t.id !== agent?.currentTaskId && t.phase !== "done" && t.phase !== "failed");
  const following = followAgentId === id;

  const focus = () => {
    const a = liveWorld.snapshot?.agents.find((x) => x.id === id) ?? agent;
    if (a) requestCamera({ focus: { x: a.position.x, y: 1, z: a.position.z }, distance: 7.5 });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="agent-details">
      <button type="button" onClick={onBack} className="btn btn-quiet -ml-2 h-7 self-start px-2 text-[12px]">
        <ArrowLeft size={13} /> All agents
      </button>

      <div className="flex items-center gap-3">
        <Avatar id={id} size={44} ring />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-semibold text-mist-100">{profile.name}</h2>
            <AgentStatusPill agent={agent} />
          </div>
          <p className="text-[12.5px] font-medium" style={{ color: profile.color }}>
            {profile.roleLabel}
          </p>
          <p className="text-[12px] leading-snug text-mist-500">{profile.tagline}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-mist-500/10 bg-ink-850/60 p-3">
        <span className="eyebrow">Now</span>
        <p className="text-[13px] leading-snug text-mist-100">{agent?.paused ? "Paused" : agent?.activity || "Idle"}</p>
        {agent && (agent.status === "working" || agent.status === "thinking") && agent.progress > 0 ? <ProgressBar value={agent.progress} color={profile.color} /> : null}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-mist-500">Location</dt>
          <dd className="text-mist-300">{agent ? locationLabel(agent) : "—"}</dd>
          <dt className="text-mist-500">Task</dt>
          <dd className="min-w-0">
            {task ? (
              <button type="button" className="block w-full truncate text-left text-signal-strong hover:underline" onClick={() => selectTask(task.id)} title={task.title}>
                {task.id} · {task.title}
              </button>
            ) : (
              <span className="text-mist-500">None</span>
            )}
          </dd>
          {queued.length > 0 ? (
            <>
              <dt className="text-mist-500">Queue</dt>
              <dd className="text-mist-300">{queued.map((t) => t.id).join(", ")}</dd>
            </>
          ) : null}
        </dl>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <button type="button" className="btn" onClick={() => openDialog(id)} disabled={caps.submit !== null} title={caps.submit ?? `Assign a task to ${profile.name} (routed via the Orchestrator)`}>
          <Plus size={14} /> Assign task
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void (agent?.paused ? commands.resumeAgent(id) : commands.pauseAgent(id))}
          disabled={caps.pauseAgent !== null || !agent}
          title={caps.pauseAgent ?? (agent?.paused ? `Resume ${profile.name}` : `Pause ${profile.name}; their tasks become blocked`)}
        >
          {agent?.paused ? <Play size={14} /> : <Pause size={14} />}
          {agent?.paused ? "Resume agent" : "Pause agent"}
        </button>
        <button type="button" className="btn" onClick={() => setFollow(following ? null : id)} aria-pressed={following} title="Camera follows this agent (Esc to stop)">
          {following ? <EyeOff size={14} /> : <Eye size={14} />}
          {following ? "Stop following" : "Follow"}
        </button>
        <button type="button" className="btn" onClick={focus} title="Point the camera at this agent">
          <Crosshair size={14} /> Focus camera
        </button>
      </div>

      <div className="flex flex-col gap-2">
        <Segmented
          label="Agent history"
          value={tab}
          onChange={setTab}
          options={[
            { value: "activity", label: `Activity · ${activity.length}` },
            { value: "comms", label: `Communication · ${comms.length}` },
          ]}
        />
        <ActivityFeed
          events={tab === "activity" ? activity : comms}
          empty={tab === "activity" ? `Nothing from ${profile.name} yet.` : `${profile.name} has not talked to anyone yet.`}
        />
      </div>
    </div>
  );
}
