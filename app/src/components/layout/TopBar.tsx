"use client";

import { forwardRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useBackendCaps } from "@/components/backendCaps";
import { CompactSimControls, SimulationControls } from "@/components/controls/SimulationControls";
import { SessionSwitcher, useLiveSessions } from "@/components/layout/SessionSwitcher";
import { StatusDot } from "@/components/ui";
import { isTerminal } from "@/simulation/WorkflowStateMachine";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

const BUSY = new Set(["working", "thinking", "communicating"]);

function Metric({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="flex flex-col items-start leading-none" data-testid={`metric-${label.toLowerCase()}`}>
      <span className={`font-mono text-[15px] font-semibold tabular-nums ${tone ?? "text-mist-100"}`} data-testid="metric-value">
        {value}
      </span>
      <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-mist-500">{label}</span>
    </div>
  );
}

export const TopBar = forwardRef<HTMLElement>(function TopBar(_props, ref) {
  useRenderCount("TopBar");
  // Only the four counts: the mirror republishes agents/tasks every ~160 ms while work progresses, and the
  // bar (with SimulationControls under it) should not re-render for progress it does not show.
  const metrics = useWorldStore(
    useShallow((s) => ({
      agents: s.agents.length,
      active: s.agents.filter((a) => !a.paused && (a.currentTaskId !== null || BUSY.has(a.status))).length,
      pending: s.tasks.filter((t) => !isTerminal(t.phase)).length,
      completed: s.tasks.filter((t) => t.phase === "done").length,
    })),
  );
  const status = useWorldStore((s) => s.simStatus);
  const connection = useWorldStore((s) => s.backend.connection);
  const caps = useBackendCaps();
  // Live, with sessions: which one the robots follow. On phones it takes the mode line's place (the mode line
  // stays in its tooltip and in Settings → Backend).
  const following = useLiveSessions() !== null;

  const down = connection !== "open";
  const statusLabel = down
    ? connection === "closed"
      ? "Disconnected"
      : connection === "reconnecting"
        ? "Reconnecting…"
        : "Connecting…"
    : { running: "Running", paused: "Paused", ready: "Ready" }[status];
  const modeTone = caps.simulated ? "text-warn" : down ? "text-mist-500" : "text-signal-strong";
  const dotTone = down ? (connection === "closed" ? "bad" : "warn") : status === "running" ? "ok" : status === "paused" ? "warn" : "idle";

  // Phones (portrait below 768 px, and landscape phones) get one row: title, short mode line, status, the run
  // toggle, New task and a menu. Tablets and desktop keep the full row (it wraps between 768 and ~900 px).
  return (
    <header
      ref={ref}
      className="surface pointer-events-auto flex items-center gap-2 py-1.5 pl-3 pr-1.5 md:flex-row md:flex-wrap md:gap-x-4 md:gap-y-1.5 md:px-4 md:py-2 phl:flex-nowrap phl:gap-2 phl:py-1 phl:pl-3 phl:pr-1"
      aria-label="Top bar"
    >
      <div className="min-w-0 flex-1 md:flex-none phl:flex-1">
        <h1 className="truncate text-[15px] font-semibold tracking-tight text-mist-100 phl:text-[14px]">3D Claude Hub Remote</h1>
        <p className={`hidden truncate text-[11.5px] md:block phl:hidden ${modeTone}`} data-testid="mode-line">
          {caps.modeLine}
        </p>
        {following ? (
          <div className="md:hidden phl:block">
            <SessionSwitcher variant="compact" />
          </div>
        ) : (
          <p className={`truncate text-[11.5px] md:hidden phl:block ${modeTone}`} title={caps.modeLine}>
            {caps.shortModeLine}
          </p>
        )}
      </div>

      {following ? (
        <div className="hidden min-w-0 md:block md:flex-initial phl:hidden">
          <SessionSwitcher variant="bar" />
        </div>
      ) : null}

      <div className="hidden items-center gap-4 border-l border-mist-500/12 pl-4 xl:flex" aria-label="Metrics">
        <Metric label="Agents" value={metrics.agents} />
        <Metric label="Active" value={metrics.active} tone="text-signal-strong" />
        <Metric label="Pending" value={metrics.pending} />
        <Metric label="Completed" value={metrics.completed} tone="text-ok" />
      </div>

      <div
        className="flex flex-none items-center gap-2 rounded-full border border-mist-500/15 bg-ink-950/40 px-2.5 py-1 max-[419px]:px-2 phl:px-2"
        role="status"
        aria-live="polite"
        data-testid="sim-status"
        title={statusLabel}
      >
        <StatusDot tone={dotTone} pulse={!down && status === "running"} />
        {/* The narrowest phones show the dot only; the label stays for screen readers. */}
        <span className="text-[12px] font-medium text-mist-300 max-[419px]:sr-only phl:sr-only">{statusLabel}</span>
      </div>

      {/* Wraps onto a second row when the bar is too narrow (768–900 px); it never scrolls sideways. */}
      <div className="hidden min-w-0 py-0.5 md:ml-auto md:block md:flex-none phl:hidden">
        <SimulationControls />
      </div>
      <div className="flex-none md:hidden phl:block">
        <CompactSimControls />
      </div>
    </header>
  );
});
