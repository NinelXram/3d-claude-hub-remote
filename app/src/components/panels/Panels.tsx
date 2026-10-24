"use client";

import { useMemo, useState } from "react";
import { Layers, Plus, Sparkles } from "lucide-react";
import { AGENTS } from "@/agents/AgentRegistry";
import { toggleDesktopAlerts } from "@/audio/useSoundEffects";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { useBackendCaps } from "@/components/backendCaps";
import { AgentDetails } from "@/components/panels/AgentDetails";
import { TaskCard } from "@/components/panels/TaskCard";
import { TaskDetails } from "@/components/panels/TaskDetails";
import { AgentStatusPill, Avatar, Empty, Section, Segmented, StatusDot, Toggle, taskDone } from "@/components/ui";
import { feedEvents } from "@/events/eventStore";
import { BACKEND_ENV, commands, getTokenSource } from "@/integrations/backendClient";
import { SIM_CONFIG } from "@/simulation/simulationConfig";
import { useWorldStore } from "@/state/useWorldStore";
import { activeTasks } from "@/tasks/taskActions";
import { SPRINT_TASKS } from "@/tasks/taskBacklog";
import type { Task } from "@/tasks/taskTypes";
import { useRenderCount } from "@/world/renderCounts";

// ───────────────────────── shared pieces ─────────────────────────

function AgentRoster({ compact = false }: { compact?: boolean }) {
  const agents = useWorldStore((s) => s.agents);
  const selected = useWorldStore((s) => s.selectedAgentId);
  const selectAgent = useWorldStore((s) => s.selectAgent);
  const tasks = useWorldStore((s) => s.tasks);
  return (
    <ul className="flex flex-col gap-1" aria-label="Agents">
      {AGENTS.map((p) => {
        const a = agents.find((x) => x.id === p.id);
        const task = a?.currentTaskId ? tasks.find((t) => t.id === a.currentTaskId) : undefined;
        return (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => selectAgent(p.id)}
              data-testid={`agent-row-${p.id}`}
              className={`flex w-full items-center gap-2.5 rounded-xl border px-2.5 text-left transition-colors ${compact ? "py-1.5" : "py-2"} ${
                selected === p.id ? "border-signal/40 bg-ink-700/80" : "border-transparent hover:bg-ink-700/60"
              }`}
            >
              <Avatar id={p.id} size={compact ? 26 : 30} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[13px] font-semibold text-mist-100">{p.name}</span>
                  <span className="truncate text-[11.5px] text-mist-500">{p.roleLabel}</span>
                </span>
                {!compact || a?.activity ? (
                  <span className="block truncate text-[11.5px] text-mist-300">
                    {a?.paused ? "Paused" : a?.activity || "Idle"}
                    {task && !compact ? <span className="text-mist-500"> · {task.id}</span> : null}
                  </span>
                ) : null}
              </span>
              <AgentStatusPill agent={a} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const GROUP = (t: Task) => (t.phase === "queued" ? 1 : taskDone(t) ? 2 : 0);

/** Active first, then queued, then done; newest first within a group. */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => GROUP(a) - GROUP(b) || b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

function ScenarioButtons() {
  const caps = useBackendCaps();
  const openDialog = useWorldStore((s) => s.openDialog);
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className="btn btn-primary" onClick={() => void commands.runDemo()} disabled={caps.scenario !== null} title={caps.scenario ?? undefined}>
        <Sparkles size={14} /> Run demo
      </button>
      <button type="button" className="btn" onClick={() => void commands.loadSprint()} disabled={caps.scenario !== null} title={caps.scenario ?? undefined}>
        <Layers size={14} /> Load sprint
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => openDialog()} disabled={caps.submit !== null} title={caps.submit ?? undefined}>
        <Plus size={14} /> New task
      </button>
    </div>
  );
}

// ───────────────────────── Overview ─────────────────────────

export function OverviewPanel() {
  useRenderCount("OverviewPanel");
  const tasks = useWorldStore((s) => s.tasks);
  const events = useWorldStore((s) => s.events);
  const clock = useWorldStore((s) => s.clock);
  const selectTask = useWorldStore((s) => s.selectTask);
  const caps = useBackendCaps();
  const inFlight = useMemo(() => sortTasks(activeTasks(tasks)), [tasks]);
  const feed = useMemo(() => feedEvents(events), [events]);

  return (
    <div className="flex flex-col gap-5">
      {tasks.length === 0 ? (
        caps.simulated ? (
          <div className="flex flex-col gap-3 rounded-2xl border border-signal/20 bg-[linear-gradient(160deg,rgb(124_196_214/0.12),rgb(14_19_27/0.2))] p-4" data-testid="demo-callout">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold text-mist-100">Watch the team ship a feature</h2>
              <span className="rounded-full border border-warn/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warn">Simulated</span>
            </div>
            <p className="text-[12.5px] leading-relaxed text-mist-300">
              <b className="text-mist-100">Run demo</b> sends one task through the whole team: Orion delegates, Piper plans, Iris researches, Kai builds, Quinn fails the first build, Kai fixes it, and Rex
              approves.
            </p>
            <ScenarioButtons />
            <p className="text-[11.5px] leading-snug text-mist-500">
              <b className="text-mist-300">Load sprint</b> queues {SPRINT_TASKS.length} backlog tasks; {SIM_CONFIG.maxConcurrentTasks} run at a time and the rest wait their turn. Everything is a
              scripted simulation: no AI inference, no code is written.
            </p>
          </div>
        ) : (
          <Empty>{caps.online ? "Waiting for the live backend to report work. Tasks appear here as they start." : "Waiting for the backend connection…"}</Empty>
        )
      ) : null}

      <Section title="Team">
        <AgentRoster compact />
      </Section>

      <Section title="In flight" right={<span className="font-mono text-[11px] text-mist-500">{inFlight.length} active</span>}>
        {inFlight.length === 0 ? (
          <Empty>{tasks.length ? "Nothing in flight right now." : "No tasks yet."}</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {inFlight.map((t) => (
              <TaskCard key={t.id} task={t} clock={clock} compact onSelect={(id) => selectTask(id)} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Latest activity">
        <ActivityFeed events={feed} limit={8} compact />
      </Section>
    </div>
  );
}

// ───────────────────────── Agents ─────────────────────────

export function AgentsPanel() {
  useRenderCount("AgentsPanel");
  const selected = useWorldStore((s) => s.selectedAgentId);
  const selectAgent = useWorldStore((s) => s.selectAgent);
  if (selected) return <AgentDetails id={selected} onBack={() => selectAgent(null)} />;
  return (
    <Section title={`Agents · ${AGENTS.length}`}>
      <AgentRoster />
    </Section>
  );
}

// ───────────────────────── Tasks ─────────────────────────

type TaskFilter = "all" | "active" | "queued" | "done";

export function TasksPanel() {
  const tasks = useWorldStore((s) => s.tasks);
  const clock = useWorldStore((s) => s.clock);
  const selectedId = useWorldStore((s) => s.selectedTaskId);
  const selectTask = useWorldStore((s) => s.selectTask);
  const openDialog = useWorldStore((s) => s.openDialog);
  const caps = useBackendCaps();
  const [filter, setFilter] = useState<TaskFilter>("all");

  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const counts = useMemo(
    () => ({
      all: tasks.length,
      active: tasks.filter((t) => GROUP(t) === 0).length,
      queued: tasks.filter((t) => GROUP(t) === 1).length,
      done: tasks.filter((t) => GROUP(t) === 2).length,
    }),
    [tasks],
  );
  const selected = selectedId ? tasks.find((t) => t.id === selectedId) : undefined;
  if (selected) return <TaskDetails task={selected} onBack={() => selectTask(null)} />;

  const visible = sorted.filter((t) => filter === "all" || (filter === "active" ? GROUP(t) === 0 : filter === "queued" ? GROUP(t) === 1 : GROUP(t) === 2));

  return (
    <div className="flex flex-col gap-3">
      {/* Only actions the backend accepts are shown; a read-only live mirror gets none. */}
      {caps.submit === null || caps.scenario === null ? (
        <div className="flex flex-wrap gap-1.5">
          {caps.submit === null ? (
            <button type="button" className="btn btn-primary" onClick={() => openDialog()} title="New task (N)">
              <Plus size={14} /> New task
            </button>
          ) : null}
          {caps.scenario === null ? (
            <>
              <button type="button" className="btn" onClick={() => void commands.runDemo()} title="Run the scripted demo task">
                <Sparkles size={14} /> Demo
              </button>
              <button type="button" className="btn" onClick={() => void commands.loadSprint()} title="Queue the 8-task sprint (B)">
                <Layers size={14} /> Sprint
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <Segmented
        label="Filter tasks"
        value={filter}
        onChange={setFilter}
        size="sm"
        options={[
          { value: "all", label: `All ${counts.all}` },
          { value: "active", label: `Active ${counts.active}` },
          { value: "queued", label: `Queued ${counts.queued}` },
          { value: "done", label: `Done ${counts.done}` },
        ]}
      />
      {visible.length === 0 ? (
        <Empty>{tasks.length === 0 ? (caps.simulated ? "No tasks yet. Run the demo or create one." : "No tasks from the backend yet.") : "No tasks match this filter."}</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((t) => (
            <TaskCard key={t.id} task={t} clock={clock} onSelect={(id) => selectTask(id)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Activity ─────────────────────────

export function ActivityPanel() {
  useRenderCount("ActivityPanel");
  const events = useWorldStore((s) => s.events);
  const [messagesOnly, setMessagesOnly] = useState(false);
  const feed = useMemo(() => feedEvents(events, messagesOnly), [events, messagesOnly]);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Activity · {feed.length}</span>
        <label className="flex cursor-pointer items-center gap-2 text-[12px] text-mist-300">
          <input type="checkbox" checked={messagesOnly} onChange={(e) => setMessagesOnly(e.target.checked)} className="size-3.5 accent-[#7cc4d6]" />
          Messages only
        </label>
      </div>
      <ActivityFeed events={feed} empty={messagesOnly ? "No agent-to-agent messages yet." : "No activity yet."} />
    </div>
  );
}

// ───────────────────────── Settings ─────────────────────────

function NotifyToggle() {
  const on = useWorldStore((s) => s.desktopAlerts);
  const supported = typeof Notification !== "undefined";
  const denied = supported && Notification.permission === "denied";
  return (
    <Toggle
      checked={on}
      onChange={() => void toggleDesktopAlerts()}
      disabled={!supported || denied}
      label="Notify me when Claude needs you"
      hint={
        !supported
          ? "This browser has no desktop notifications."
          : denied
            ? "Notifications are blocked for this site in the browser settings."
            : "A desktop notification when Claude asks for permission, waits for input or ends its turn while this tab is hidden. The tab title always shows it."
      }
    />
  );
}

export function SettingsPanel() {
  const quality = useWorldStore((s) => s.quality);
  const qualitySource = useWorldStore((s) => s.qualitySource);
  const setQuality = useWorldStore((s) => s.setQuality);
  const overlays = useWorldStore((s) => s.overlays);
  const setOverlays = useWorldStore((s) => s.setOverlays);
  const sound = useWorldStore((s) => s.sound);
  const setSound = useWorldStore((s) => s.setSound);
  const soundMode = useWorldStore((s) => s.soundMode);
  const audioState = useWorldStore((s) => s.audioState);
  const backend = useWorldStore((s) => s.backend);
  const caps = useBackendCaps();

  const connTone = backend.connection === "open" ? "ok" : backend.connection === "closed" ? "bad" : "warn";
  const connLabel = { idle: "Idle", connecting: "Connecting…", open: "Connected", reconnecting: "Reconnecting…", closed: "Disconnected" }[backend.connection];

  return (
    <div className="flex flex-col gap-5">
      <Section title="Rendering">
        <Segmented
          label="Rendering quality"
          value={quality}
          onChange={(q) => setQuality(q, "user")}
          options={[
            { value: "high", label: "High quality" },
            { value: "low", label: "Performance" },
          ]}
        />
        <p className="text-[12px] leading-snug text-mist-500">
          High quality adds soft shadows, reflections and a denser skyline. Performance drops them and caps the pixel ratio. If the frame rate stays low, the world switches to Performance on its
          own.
          {qualitySource === "fallback" ? " It did so this session." : qualitySource === "url" ? " Set by the ?quality= URL flag." : qualitySource === "auto" && quality === "low" ? " Picked for this device." : ""}
        </p>
      </Section>

      <Section title="Overlays">
        <Toggle checked={overlays.paths} onChange={(v) => setOverlays({ paths: v })} label="Walking paths & destinations" hint="Trails from each walking agent to where it is going." />
        <Toggle checked={overlays.speech} onChange={(v) => setOverlays({ speech: v })} label="Agent speech indicators" hint="Bubbles while agents talk, celebrate or hit a problem." />
      </Section>

      <Section title="Sound">
        <Toggle checked={sound.enabled} onChange={(v) => setSound({ enabled: v })} label="Sound effects (M)" />
        <Toggle checked={sound.ambient} onChange={(v) => setSound({ ambient: v })} label="Ambient office hum" disabled={!sound.enabled} />
        <label className={`flex items-center gap-3 text-[13px] ${sound.enabled ? "" : "opacity-50"}`}>
          <span className="w-14 text-mist-100">Volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={sound.volume}
            disabled={!sound.enabled}
            onChange={(e) => setSound({ volume: Number(e.target.value) })}
            className="flex-1 accent-[#7cc4d6]"
            aria-label="Volume"
          />
          <span className="w-9 text-right font-mono text-[11px] text-mist-500">{Math.round(sound.volume * 100)}%</span>
        </label>
        <p className="text-[12px] leading-snug text-mist-500" data-testid="sound-explainer">
          {soundMode === "live"
            ? "Live mirror: only test results, the end of a turn and Claude waiting for you make a sound; these settings are saved apart from the simulation's."
            : "Every cue is synthesised in the browser from a backend event, so what you hear is what the system did."}{" "}
          {sound.enabled && audioState !== "running" ? "Audio starts after your first click or key press." : ""}
        </p>
        {soundMode === "live" ? <NotifyToggle /> : null}
      </Section>

      <Section title="Backend">
        <div className="flex flex-col gap-2 rounded-xl border border-mist-500/10 bg-ink-850/60 p-3 text-[12.5px]">
          <div className="flex items-center gap-2">
            <StatusDot tone={connTone} pulse={backend.connection === "open"} />
            <span className="font-medium text-mist-100">{backend.label}</span>
            <span className="ml-auto text-mist-500">{connLabel}</span>
          </div>
          <p className="text-mist-500">
            Kind: <span className="font-mono text-mist-300">{backend.kind}</span>
            {BACKEND_ENV.wsUrl && backend.kind === "websocket" ? (
              <>
                {" "}
                · <span className="break-all font-mono text-mist-300">{BACKEND_ENV.wsUrl}</span>
              </>
            ) : null}
          </p>
          {backend.error ? <p className="rounded-lg border border-bad/30 bg-bad/10 px-2 py-1.5 text-bad">{backend.error}</p> : null}
          <p className={`leading-snug ${caps.simulated ? "text-warn" : "text-mist-300"}`}>
            {caps.simulated
              ? "Simulation mode: a deterministic local script plays the agents. No LLM is called, no code is written, and every output is a canned template."
              : backend.identified
                ? `${backend.label} mirrors real activity. This page is read-only for it: simulation controls are disabled.`
                : "Waiting for the backend to identify itself."}
          </p>
          <div className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-mist-500">
            <span>
              NEXT_PUBLIC_AGENT_BACKEND=<span className="text-mist-300">{BACKEND_ENV.backend || "(unset → mock)"}</span>
            </span>
            <span>
              NEXT_PUBLIC_AGENT_WS_URL=<span className="text-mist-300">{BACKEND_ENV.wsUrl || "(unset)"}</span>
            </span>
            <span>
              NEXT_PUBLIC_AGENT_WS_TOKEN=<span className="text-mist-300">{BACKEND_ENV.hasToken ? "(set)" : "(unset)"}</span>
            </span>
            {backend.kind === "websocket" && (getTokenSource() === "url" || getTokenSource() === "session") ? (
              <span>
                token=<span className="text-mist-300">(from the page URL, kept for this tab)</span>
              </span>
            ) : null}
          </div>
        </div>
      </Section>

      <Section title="Simulation">
        {!caps.simulated && backend.identified ? <p className="text-[12px] text-mist-500">These values drive the local simulation only; the live backend ignores them.</p> : null}
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-[12.5px]">
          {(
            [
              ["Max concurrent tasks", SIM_CONFIG.maxConcurrentTasks],
              ["Max iterations", SIM_CONFIG.maxIterations],
              ["QA fail rate", `${Math.round(SIM_CONFIG.qaFailRate * 100)}%`],
              ["Review change rate", `${Math.round(SIM_CONFIG.reviewChangeRate * 100)}%`],
              ["Tick rate", `${SIM_CONFIG.tickHz} Hz`],
              ["Walk speed", `${SIM_CONFIG.walkSpeed} m/s`],
              ["Speeds", SIM_CONFIG.speeds.map((s) => `${s}×`).join(" ")],
              ["Seed", SIM_CONFIG.seed],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-mist-500">{k}</dt>
              <dd className="text-right font-mono text-mist-300">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}
