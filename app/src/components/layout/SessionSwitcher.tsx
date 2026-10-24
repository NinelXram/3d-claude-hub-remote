"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Pin, Radar } from "lucide-react";
import { ProjectChip, SESSION_STATUS_LABEL, SessionDot, ago, useNow } from "@/components/sessions/sessionUi";
import type { LiveSessionSummary, LiveWorldState } from "@/integrations/AgentBackend";
import { commands } from "@/integrations/backendClient";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

// "Following: <title> · <project>": which Claude Code session the robots act out (live servers with sessions only),
// and a list to pin another one or go back to Auto. Several sessions can run at once; the robots stand for kinds of
// action, so only one session drives them. Feed, sounds and "needs you" alerts still come from every session.

/** The live state when there is at least one session to follow, else null (simulation, or no hooks yet). */
export function useLiveSessions(): LiveWorldState | null {
  return useWorldStore((s) => (!s.backend.simulated && s.backend.identified && s.live && s.live.sessions.length > 0 ? s.live : null));
}

function othersBusy(live: LiveWorldState): { count: number; waiting: number } {
  const others = live.sessions.filter((x) => x.sessionId !== live.focus.sessionId && (x.status === "running" || x.status === "waiting"));
  return { count: others.length, waiting: others.filter((x) => x.status === "waiting").length };
}

export function SessionSwitcher({ variant }: { variant: "bar" | "compact" }) {
  useRenderCount("SessionSwitcher");
  const live = useLiveSessions();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!live) return null;
  const focused = live.sessions.find((x) => x.sessionId === live.focus.sessionId) ?? null;
  const busy = othersBusy(live);
  const pinned = live.focus.mode === "pinned";
  const label = focused ? `${focused.title} · ${focused.project || "no folder"}` : "No session";
  const hint = `The robots act out ${focused ? `“${focused.title}”` : "no session"}${pinned ? " (pinned)" : " (auto: follows activity)"}. ${busy.count ? `${busy.count} other session${busy.count === 1 ? " is" : "s are"} running or waiting.` : ""}`;

  const badge =
    busy.count > 0 ? (
      <span
        className={`inline-flex h-4 min-w-4 flex-none items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums ${busy.waiting ? "bg-warn text-ink-950" : "bg-signal/25 text-signal-strong"}`}
        aria-label={`${busy.count} other session${busy.count === 1 ? "" : "s"} active${busy.waiting ? `, ${busy.waiting} waiting for you` : ""}`}
        data-testid="session-switcher-badge"
      >
        +{busy.count}
      </span>
    ) : null;

  return (
    <div ref={wrap} className={variant === "bar" ? "relative min-w-0" : "relative min-w-0 max-w-full"}>
      {variant === "bar" ? (
        <button
          type="button"
          className="flex h-9 max-w-[min(420px,34vw)] items-center gap-2 rounded-full border border-mist-500/15 bg-ink-950/40 py-1 pl-2.5 pr-2 text-left transition-colors hover:border-mist-500/30 hover:bg-ink-800/60 aria-expanded:border-signal/45"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="aaw-session-switcher"
          title={hint}
          onClick={() => setOpen((o) => !o)}
          data-testid="session-switcher"
        >
          {focused ? <SessionDot status={focused.status} /> : null}
          <span className="min-w-0 truncate text-[12px] text-mist-300">
            <span className="text-mist-500">{pinned ? "Pinned: " : "Following: "}</span>
            <span className="font-medium text-mist-100">{focused?.title ?? "No session"}</span>
            {focused?.project ? <span className="text-mist-500"> · {focused.project}</span> : null}
          </span>
          {badge}
          <ChevronDown size={14} className={`flex-none text-mist-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          className="-mx-1 flex max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left [@media(pointer:coarse)]:min-h-7"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="aaw-session-switcher"
          aria-label={`${pinned ? "Pinned" : "Following"}: ${label}. Change session`}
          title={hint}
          onClick={() => setOpen((o) => !o)}
          data-testid="session-switcher-compact"
        >
          {focused ? <SessionDot status={focused.status} /> : null}
          <span className="min-w-0 truncate text-[11.5px] text-signal-strong">
            {pinned ? <Pin size={10} className="mr-0.5 inline align-[-1px]" aria-hidden /> : null}
            {label}
          </span>
          {badge}
          <ChevronDown size={12} className={`flex-none text-mist-500 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </button>
      )}
      {open ? <SwitcherMenu live={live} onDone={() => setOpen(false)} /> : null}
    </div>
  );
}

function SwitcherMenu({ live, onDone }: { live: LiveWorldState; onDone: () => void }) {
  const now = useNow();
  const pick = (id: string | null) => {
    onDone();
    void commands.focusSession(id);
  };
  const auto = live.focus.mode === "auto";
  return (
    <div
      id="aaw-session-switcher"
      role="menu"
      aria-label="Session the robots follow"
      className="surface scroll-thin absolute left-0 top-[calc(100%+10px)] z-30 flex max-h-[min(70dvh,calc(100dvh-96px))] w-[min(380px,calc(100vw-24px))] flex-col gap-1 overflow-y-auto bg-ink-900/95 p-2 [animation:aaw-rise-in_140ms_ease-out]"
      data-testid="session-switcher-menu"
    >
      <span className="eyebrow px-2 pt-1">The robots follow</span>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={auto}
        className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-ink-700/60 [@media(pointer:coarse)]:min-h-11"
        onClick={() => pick(null)}
      >
        <Radar size={15} className="mt-0.5 flex-none text-signal" aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[13px] font-medium text-mist-100">Auto (follow activity)</span>
          <span className="text-[11.5px] leading-snug text-mist-500">Moves on once the followed session has been idle for 8 s. A session waiting for you takes over at once.</span>
        </span>
        {auto ? <Check size={15} className="mt-0.5 flex-none text-signal-strong" aria-hidden /> : null}
      </button>
      <span className="mx-1 my-0.5 h-px flex-none bg-mist-500/12" aria-hidden />
      {live.sessions.map((s) => (
        <SessionOption key={s.sessionId} s={s} focused={s.sessionId === live.focus.sessionId} pinned={!auto && s.sessionId === live.focus.sessionId} now={now} onPick={() => pick(s.sessionId)} />
      ))}
      <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-mist-500">
        Other sessions still count: their tasks, feed rows, sounds and alerts keep coming.
      </p>
    </div>
  );
}

function SessionOption({ s, focused, pinned, now, onPick }: { s: LiveSessionSummary; focused: boolean; pinned: boolean; now: number; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={pinned}
      className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-ink-700/60 [@media(pointer:coarse)]:min-h-11 ${focused ? "bg-ink-800/70" : ""} ${s.status === "ended" ? "opacity-60" : ""}`}
      onClick={onPick}
      data-testid="session-switcher-option"
      title={`Follow “${s.title}” in the 3D world`}
    >
      <span className="mt-1.5 flex-none">
        <SessionDot status={s.status} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium text-mist-100">{s.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-[11px] text-mist-500">
          {s.project ? <ProjectChip project={s.project} /> : null}
          <span className={s.status === "waiting" ? "text-warn" : s.status === "running" ? "text-signal-strong" : ""}>{SESSION_STATUS_LABEL[s.status]}</span>
          <span className="ml-auto flex-none tabular-nums">{ago(s.lastActivity, now)}</span>
        </span>
      </span>
      {focused ? (
        <span className="mt-0.5 flex flex-none items-center gap-1 text-[10.5px] font-semibold uppercase tracking-wide text-signal-strong">
          {pinned ? <Pin size={11} aria-hidden /> : null}
          {pinned ? "Pinned" : "Now"}
        </span>
      ) : null}
    </button>
  );
}
