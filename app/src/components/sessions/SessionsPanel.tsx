"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, CircleStop, Crosshair, FolderOpen, KeyRound, Plus, Search, Send, ShieldAlert, Trash2, Wrench } from "lucide-react";
import { useLayoutMode } from "@/components/layout/layoutMode";
import { firstLine } from "@/components/sessions/sessionText";
import { Markdown } from "@/components/sessions/Markdown";
import { AttachButton, AttachmentStrip, SessionImages, useAttachments } from "@/components/sessions/imageAttach";
import { PermissionModePicker, rememberedMode } from "@/components/sessions/PermissionModePicker";
import { BranchChip, OwnerTag, ProjectChip, SessionStatusChip, ago, basename, useNow } from "@/components/sessions/sessionUi";
import { Empty } from "@/components/ui";
import type { SessionInfo, SessionItem, SessionPermissionMode } from "@/integrations/AgentBackend";
import { sessionCommands } from "@/integrations/sessionClient";
import { commands, rememberTokenAndReload } from "@/integrations/backendClient";
import { useSessionStore } from "@/state/useSessionStore";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

// The Sessions tab (live Claude Code servers): the session list, a chat view of one session, the composer and
// the "New session" form. All server text is rendered as React text nodes; nothing here is parsed as HTML.

/** Enter sends, Shift+Enter is a new line; an IME composition's Enter only confirms the composition. */
function isSendKey(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
  return e.key === "Enter" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing;
}

export function SessionsPanel() {
  useRenderCount("SessionsPanel");
  const live = useWorldStore((s) => s.backend.identified && !s.backend.simulated);
  const online = useWorldStore((s) => s.backend.connection === "open");
  const caps = useSessionStore((s) => s.capabilities);
  const openId = useSessionStore((s) => s.openId);

  if (!live) {
    return (
      <div className="px-4 py-4">
        <Empty>Sessions mirror real Claude Code sessions, so they need a live backend. The local simulation has none.</Empty>
      </div>
    );
  }
  if (caps.locked) return <UnlockSessions />;
  if (!caps.sessions) {
    return (
      <div className="px-4 py-4">
        <p className="rounded-xl border border-mist-500/15 bg-ink-850/60 px-3 py-2.5 text-[12.5px] leading-relaxed text-mist-300" data-testid="sessions-readonly">
          {online ? "Read-only mirror. " : "Not connected. "}Restart the server with <code className="whitespace-nowrap font-mono text-[11.5px] text-mist-100">--control</code> and open the link it prints to read and reply to sessions here.
        </p>
      </div>
    );
  }
  return openId ? <SessionChat key={openId} sessionId={openId} /> : <SessionList />;
}

/** The server has sessions but this tab has no token: paste it here instead of hunting for the printed link. */
function UnlockSessions() {
  const [token, setToken] = useState("");
  return (
    <form
      className="flex flex-col gap-3 px-4 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (token.trim()) rememberTokenAndReload(token);
      }}
    >
      <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-mist-300" data-testid="sessions-locked">
        <KeyRound size={15} className="mt-0.5 shrink-0 text-warn" />
        <span>
          This server can show and continue your Claude Code sessions, but it needs its token first. Open the link the server
          printed, or paste the token from <code className="font-mono text-[11.5px] text-mist-100">cat ~/.aaw/token</code>.
        </span>
      </p>
      <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-mist-500" htmlFor="sessions-token">
        Server token
        <input
          id="sessions-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="rounded-lg border border-mist-500/20 bg-ink-900/70 px-3 py-2 font-mono text-[12.5px] normal-case tracking-normal text-mist-100 outline-none focus-visible:border-signal/60"
          placeholder="Paste the token"
        />
      </label>
      <button
        type="submit"
        disabled={!token.trim()}
        className="self-start rounded-lg bg-signal px-3.5 py-2 text-[12.5px] font-semibold text-ink-950 transition-colors hover:bg-signal-strong disabled:cursor-not-allowed disabled:opacity-50"
      >
        Unlock sessions
      </button>
      <p className="text-[11.5px] text-mist-500">The token is kept for this browser tab only.</p>
    </form>
  );
}

// ───────────────────────── list ─────────────────────────

function SessionList() {
  const sessions = useSessionStore((s) => s.sessions);
  const control = useSessionStore((s) => s.capabilities.control);
  const permissions = useSessionStore((s) => s.permissions);
  const [creating, setCreating] = useState(false);
  const now = useNow();
  const asking = useMemo(() => new Set(permissions.map((p) => p.sessionId)), [permissions]);
  const [project, setProject] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Projects (the cwd's last segment) in the order of their latest session, with how many sessions each has.
  const projects = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of sessions) {
      const p = basename(s.cwd) || "(no folder)";
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return [...counts];
  }, [sessions]);
  // Folders sessions ran in, most recent first, with the one last used to start a session from here on top.
  const folders = useMemo(() => recentFolders(sessions), [sessions]);
  // The filtered project's folder if one is picked below, else the most recent.
  const defaultCwd = (project !== null && folders.find((f) => (basename(f.cwd) || "(no folder)") === project)?.cwd) || folders[0]?.cwd || "";
  const q = query.trim().toLowerCase();
  const shown = sessions.filter(
    (s) => (project === null || (basename(s.cwd) || "(no folder)") === project) && (!q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q)),
  );

  return (
    <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-4" data-testid="session-list">
      {control ? (
        creating ? (
          <NewSessionForm folders={folders} defaultCwd={defaultCwd} onCancel={() => setCreating(false)} />
        ) : (
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
              <Plus size={14} /> New session
            </button>
            <span className="text-[11.5px] text-mist-500">Runs on the server&apos;s machine</span>
          </div>
        )
      ) : (
        <p className="text-[12px] leading-snug text-mist-500">Read-only: this server does not accept prompts.</p>
      )}

      {sessions.length > 1 ? (
        <div className="flex flex-col gap-2" data-testid="session-filter">
          <label className="relative flex items-center">
            <Search size={13} className="pointer-events-none absolute left-2.5 text-mist-500" aria-hidden />
            <input
              type="search"
              className="field w-full py-1.5 pl-8 text-[12.5px]"
              placeholder="Search sessions by title or folder"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search sessions"
              name="session-search"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          {projects.length > 1 ? (
            <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="group" aria-label="Filter by project">
              <FilterChip active={project === null} onClick={() => setProject(null)} label="All" count={sessions.length} />
              {projects.map(([p, n]) => (
                <FilterChip key={p} active={project === p} onClick={() => setProject(project === p ? null : p)} label={p} count={n} mono />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {sessions.length === 0 ? (
        <Empty>No sessions yet. Start Claude Code in a terminal (with the hooks bridge installed), or start one here.</Empty>
      ) : shown.length === 0 ? (
        <Empty>No session matches{q ? ` “${query.trim()}”` : ""}{project ? ` in ${project}` : ""}.</Empty>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label="Sessions">
          {shown.map((s) => (
            <li key={s.sessionId} className="flex items-stretch overflow-hidden rounded-xl border border-mist-500/10 bg-ink-850/60 transition-colors hover:border-mist-500/25">
              <button
                type="button"
                onClick={() => void sessionCommands.open(s.sessionId)}
                data-testid="session-row"
                className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-left transition-colors hover:bg-ink-700/60"
              >
                <span className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-mist-100">{s.title}</span>
                  <SessionStatusChip status={s.status} />
                </span>
                <span className="flex items-center gap-2.5 text-[11px] text-mist-500">
                  <OwnerTag owner={s.owner} />
                  {s.cwd ? <ProjectChip project={basename(s.cwd)} title={s.cwd} /> : null}
                  {s.gitBranch ? <BranchChip branch={s.gitBranch} /> : null}
                  {asking.has(s.sessionId) ? (
                    <span className="inline-flex items-center gap-1 text-warn">
                      <ShieldAlert size={11} aria-hidden /> Permission
                    </span>
                  ) : null}
                  <span className="ml-auto flex-none tabular-nums">{ago(s.lastActivity, now)}</span>
                </span>
                {!s.readable ? <span className="text-[11px] text-mist-500">Transcript not found yet</span> : null}
              </button>
              <FollowButton sessionId={s.sessionId} title={s.title} variant="row" />
              {(s.status === "idle" || s.status === "ended") && !asking.has(s.sessionId) ? <RemoveButton sessionId={s.sessionId} title={s.title} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({ active, onClick, label, count, mono = false }: { active: boolean; onClick: () => void; label: string; count: number; mono?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-7 flex-none items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors pointer-coarse:h-9 ${
        active ? "border-signal/50 bg-signal/15 text-signal-strong" : "border-mist-500/15 bg-ink-900/50 text-mist-300 hover:border-mist-500/30"
      } ${mono ? "font-mono" : "font-medium"}`}
      data-testid="project-filter-chip"
    >
      {label}
      <span className="tabular-nums text-mist-500">{count}</span>
    </button>
  );
}

/**
 * "Follow in 3D": pin the robots to this session (they act out only one session at a time). Pressed again while
 * pinned here, it goes back to Auto. Disabled until the world has seen a hook from the session.
 */
function FollowButton({ sessionId, title, variant }: { sessionId: string; title: string; variant: "row" | "header" }) {
  const known = useWorldStore((s) => s.live?.sessions.some((x) => x.sessionId === sessionId) ?? false);
  const state = useWorldStore((s) => (s.live?.focus.sessionId === sessionId ? s.live.focus.mode : null));
  const pinned = state === "pinned";
  const follow = async () => {
    const ok = await commands.focusSession(pinned ? null : sessionId);
    if (ok) useWorldStore.getState().notify(pinned ? "The robots follow activity again (Auto)." : `The robots now follow “${title || "this session"}”.`);
  };
  const hint = !known
    ? "No hooks from this session have reached the world yet, so the robots cannot act it out."
    : pinned
      ? "Pinned: the robots act out this session. Press to follow activity again (Auto)."
      : state === "auto"
        ? "The robots are following this session now (Auto). Press to pin it."
        : "Pin the robots to this session in the 3D world";
  const label = pinned ? "Following" : "Follow in 3D";
  if (variant === "row") {
    return (
      <button
        type="button"
        onClick={() => void follow()}
        disabled={!known}
        aria-pressed={pinned}
        title={hint}
        aria-label={`${label}: ${title}`}
        className={`flex w-14 flex-none flex-col items-center justify-center gap-0.5 border-l border-mist-500/10 px-1 text-[10px] font-medium leading-tight transition-colors hover:bg-ink-700/60 disabled:cursor-not-allowed disabled:opacity-35 ${
          pinned ? "bg-signal/10 text-signal-strong" : state === "auto" ? "text-signal" : "text-mist-500"
        }`}
        data-testid="follow-session"
      >
        <Crosshair size={14} aria-hidden />
        {pinned ? "Following" : state === "auto" ? "In 3D" : "Follow"}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void follow()}
      disabled={!known}
      aria-pressed={pinned}
      title={hint}
      className={`btn h-7 flex-none px-2 text-[11.5px] pointer-coarse:h-9 ${pinned ? "border-signal/45 bg-signal/12 text-signal-strong" : "btn-quiet"}`}
      data-testid="follow-session-header"
    >
      <Crosshair size={13} aria-hidden /> <span className="phl:hidden">{label}</span>
    </button>
  );
}

/**
 * Take a finished session off the list. The first press arms it (it turns red and asks), a second press within
 * a few seconds removes it. The transcript stays on disk; the session comes back if it gets a new prompt.
 */
function RemoveButton({ sessionId, title }: { sessionId: string; title: string }) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const press = async () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setBusy(true);
    const error = await sessionCommands.remove(sessionId);
    setBusy(false);
    setArmed(false);
    useWorldStore.getState().notify(error ?? `Removed “${title || "session"}” from the list.`, error ? "error" : "info");
  };
  return (
    <button
      type="button"
      onClick={() => void press()}
      onBlur={() => setArmed(false)}
      disabled={busy}
      title={armed ? "Press again to remove it from the list (the transcript stays on disk)" : "Remove this finished session from the list"}
      aria-label={armed ? `Confirm removing ${title}` : `Remove ${title}`}
      className={`flex w-12 flex-none flex-col items-center justify-center gap-0.5 border-l border-mist-500/10 px-1 text-[10px] font-medium leading-tight transition-colors disabled:opacity-50 ${
        armed ? "bg-bad/15 text-bad" : "text-mist-500 hover:bg-ink-700/60 hover:text-bad"
      }`}
      data-testid="remove-session"
    >
      <Trash2 size={14} aria-hidden />
      {armed ? "Sure?" : "Remove"}
    </button>
  );
}

const LAST_CWD_KEY = "aaw.lastCwd";
/** Servers before permission modes did not advertise them; they always asked. */
const DEFAULT_MODES: SessionPermissionMode[] = ["default"];

interface Folder {
  cwd: string;
  lastActivity: number;
}

function recentFolders(sessions: readonly SessionInfo[]): Folder[] {
  const latest = new Map<string, number>();
  for (const s of sessions) if (s.cwd) latest.set(s.cwd, Math.max(latest.get(s.cwd) ?? 0, s.lastActivity));
  let last: string | null = null;
  try {
    last = localStorage.getItem(LAST_CWD_KEY);
  } catch {
    last = null;
  }
  const list = [...latest].map(([cwd, lastActivity]) => ({ cwd, lastActivity })).sort((a, b) => b.lastActivity - a.lastActivity);
  if (last) {
    const i = list.findIndex((f) => f.cwd === last);
    const [hit] = i >= 0 ? list.splice(i, 1) : [{ cwd: last, lastActivity: 0 }];
    list.unshift(hit!);
  }
  return list.slice(0, 15);
}

function NewSessionForm({ folders, defaultCwd, onCancel }: { folders: Folder[]; defaultCwd: string; onCancel: () => void }) {
  // Follows the project filter below until the folder is chosen or typed by hand.
  const [chosen, setChosen] = useState<string | null>(null);
  const cwd = chosen ?? defaultCwd;
  const [picking, setPicking] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();
  const prompt = useRef<HTMLTextAreaElement>(null);
  const allowedModes = useSessionStore((s) => s.capabilities.permissionModes) ?? DEFAULT_MODES;
  const [mode, setMode] = useState<SessionPermissionMode>(() => rememberedMode(allowedModes));
  const att = useAttachments(busy);
  const choose = (dir: string) => {
    setChosen(dir);
    setPicking(false);
    prompt.current?.focus();
  };

  const submit = async () => {
    if (busy) return;
    const dir = cwd.trim();
    if (!dir.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(dir)) return setError("The working directory must be an absolute path, e.g. /Users/you/project.");
    if (att.reading) return;
    if (!text.trim() && att.items.length === 0) return setError("Write the first prompt.");
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(LAST_CWD_KEY, dir);
    } catch {
      // storage blocked: the list still offers recent folders from the sessions
    }
    const r = await sessionCommands.start(dir, text, mode, att.payload());
    // On success the chat view replaces this form (sessionCommands.start opens the new session).
    if (!r.ok) {
      setBusy(false);
      setError(r.error ?? "Could not start the session.");
    }
  };

  return (
    <form
      className={`flex flex-col gap-2 rounded-xl border bg-ink-850/70 p-3 ${att.dragging ? "border-signal ring-2 ring-signal/40" : "border-signal/25"}`}
      {...att.dropProps}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      aria-label="New session"
    >
      <h3 className="text-[13px] font-semibold text-mist-100">New session</h3>
      <div className="flex flex-col gap-1 text-[11.5px] text-mist-500">
        <label htmlFor="new-session-cwd">Working directory (absolute path on the server&apos;s machine)</label>
        <div className="flex gap-1.5">
          <input
            id="new-session-cwd"
            className="field min-w-0 flex-1 font-mono text-[12px]"
            value={cwd}
            onChange={(e) => setChosen(e.target.value)}
            placeholder="/Users/you/project"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            name="cwd"
          />
          {folders.length > 0 ? (
            <button
              type="button"
              className="btn btn-quiet flex-none px-2.5"
              onClick={() => setPicking((p) => !p)}
              aria-expanded={picking}
              aria-controls="recent-folders"
              disabled={busy}
              title="Pick a recent project"
              data-testid="pick-folder"
            >
              <FolderOpen size={14} /> <ChevronDown size={13} className={`transition-transform ${picking ? "rotate-180" : ""}`} />
            </button>
          ) : null}
        </div>
        {picking ? (
          <ul id="recent-folders" role="listbox" aria-label="Recent projects" className="scroll-thin flex max-h-56 flex-col overflow-y-auto rounded-lg border border-mist-500/15 bg-ink-900/95 p-1" data-testid="recent-folders">
            {folders.map((f) => (
              <li key={f.cwd} role="option" aria-selected={f.cwd === cwd}>
                <button
                  type="button"
                  onClick={() => choose(f.cwd)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setPicking(false);
                  }}
                  className={`flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left hover:bg-ink-700/70 focus-visible:bg-ink-700/70 ${f.cwd === cwd ? "bg-ink-700/50" : ""}`}
                >
                  <span className="flex w-full items-baseline justify-between gap-2">
                    <span className="truncate font-mono text-[12.5px] text-mist-100">{basename(f.cwd) || f.cwd}</span>
                    {f.lastActivity ? <span className="flex-none text-[10.5px] text-mist-500">{ago(f.lastActivity, now)}</span> : <span className="flex-none text-[10.5px] text-mist-500">last used</span>}
                  </span>
                  <span className="w-full truncate font-mono text-[10.5px] text-mist-500" title={f.cwd}>{f.cwd}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <PermissionModePicker id="new-session-mode" value={mode} allowed={allowedModes} onChange={setMode} disabled={busy} />
      <label className="flex flex-col gap-1 text-[11.5px] text-mist-500">
        First prompt
        <textarea
          ref={prompt}
          className="field min-h-[72px] resize-y leading-snug"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if (isSendKey(e)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="What should Claude do? (Enter starts, Shift+Enter for a new line; paste or drop images)"
          disabled={busy}
          name="prompt"
        />
      </label>
      <AttachmentStrip a={att} disabled={busy} />
      {error ? (
        <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-2 py-1.5 text-[12px] text-bad">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy || att.reading}>
          <Send size={13} /> {busy ? "Starting…" : "Start session"}
        </button>
        <AttachButton onFiles={(f) => void att.add(f)} disabled={busy} className="px-2.5" />
        <button type="button" className="btn btn-quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        {busy ? <span className="text-[11.5px] text-mist-500">Waiting for Claude Code to start…</span> : null}
      </div>
    </form>
  );
}

// ───────────────────────── chat ─────────────────────────

// React StrictMode mounts, unmounts and remounts in development: a close is deferred and the remount cancels it.
let pendingClose: ReturnType<typeof setTimeout> | null = null;

function SessionChat({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.sessionId === sessionId));
  const items = useSessionStore((s) => s.items);
  const openError = useSessionStore((s) => s.openError);
  const control = useSessionStore((s) => s.capabilities.control);
  const earlier = useSessionStore((s) => s.earlier);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastPinned = useRef(0);
  const content = useRef<HTMLDivElement>(null);
  // Height before older items were prepended, so the view stays on what the reader was looking at.
  const keepFrom = useRef<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  const loadEarlier = async () => {
    const el = scroller.current;
    keepFrom.current = el ? el.scrollHeight - el.scrollTop : null;
    setLoadingEarlier(true);
    setEarlierError(await sessionCommands.loadEarlier(sessionId));
    setLoadingEarlier(false);
  };

  // Leaving the tab leaves the session too (the server stops streaming it to us).
  useEffect(() => {
    if (pendingClose) clearTimeout(pendingClose);
    pendingClose = null;
    return () => {
      pendingClose = setTimeout(() => {
        pendingClose = null;
        if (useSessionStore.getState().openId === sessionId) sessionCommands.close();
      }, 100);
    };
  }, [sessionId]);

  // Follow new output while the reader is at the bottom; leave them alone when they scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepFrom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFrom.current;
      keepFrom.current = null;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
      lastPinned.current = el.scrollTop;
    }
  }, [items]);

  // Off-screen items start at an estimated height and grow once laid out, pushing the end down. While the reader
  // is meant to be at the bottom, follow every growth of the content.
  useEffect(() => {
    const el = scroller.current;
    const body = content.current;
    if (!el || !body) return;
    const ro = new ResizeObserver(() => {
      if (!atBottom.current || keepFrom.current !== null) return;
      el.scrollTop = el.scrollHeight;
      lastPinned.current = el.scrollTop;
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const nearEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    // Only a move up by the reader leaves the bottom; content growing under a pinned view does not.
    if (nearEnd) atBottom.current = true;
    else if (el.scrollTop < lastPinned.current - 4) atBottom.current = false;
    lastPinned.current = Math.max(lastPinned.current, el.scrollTop);
    if (!atBottom.current) lastPinned.current = el.scrollTop;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="session-chat">
      <div className="flex flex-none flex-col gap-1 border-b border-mist-500/10 px-4 py-2 phl:py-1">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => sessionCommands.close()} className="btn btn-quiet -ml-2 h-7 flex-none px-2 text-[12px]">
            <ArrowLeft size={13} /> Back
          </button>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-mist-100" title={session?.title}>
            {session?.title ?? "Starting session…"}
          </span>
          {session ? <SessionStatusChip status={session.status} /> : null}
          <FollowButton sessionId={sessionId} title={session?.title ?? ""} variant="header" />
        </div>
        {session ? (
          <div className="flex items-center gap-2.5 text-[11px] text-mist-500 phl:hidden">
            <OwnerTag owner={session.owner} />
            {session.cwd ? (
              <span className="min-w-0 truncate font-mono" title={session.cwd}>
                {session.cwd}
              </span>
            ) : null}
            {session.gitBranch ? <BranchChip branch={session.gitBranch} /> : null}
          </div>
        ) : null}
      </div>

      <div ref={scroller} onScroll={onScroll} className="scroll-thin flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden overscroll-contain px-4 py-3" data-testid="session-items">
        {openError ? (
          <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-2 py-1.5 text-[12px] text-bad">
            {openError}
          </p>
        ) : null}
        {items.length === 0 && !openError ? <p className="py-6 text-center text-[12px] text-mist-500">Waiting for the transcript…</p> : null}
        <div ref={content} className="flex flex-col gap-2.5">
        {earlier > 0 ? (
          <div className="flex flex-col items-center gap-1 py-1">
            <button type="button" onClick={() => void loadEarlier()} disabled={loadingEarlier} className="btn btn-quiet h-8 px-3 text-[12px]" data-testid="load-earlier">
              {loadingEarlier ? "Loading…" : `Load ${Math.min(150, earlier)} earlier (${earlier} more)`}
            </button>
            {earlierError ? <p className="text-[11.5px] text-bad">{earlierError}</p> : null}
          </div>
        ) : null}
        {items.map((it) => (
          // Off-screen items skip layout and paint until scrolled near.
          <div key={it.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_48px]">
            <ChatItem item={it} sessionId={sessionId} />
          </div>
        ))}
        </div>
      </div>

      {control ? <Composer sessionId={sessionId} session={session} /> : null}
    </div>
  );
}

function ChatItem({ item, sessionId }: { item: SessionItem; sessionId: string }) {
  if (item.kind === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5" data-kind="user">
        {item.images?.length ? <SessionImages sessionId={sessionId} images={item.images} /> : null}
        {item.text.trim() ? (
          <p className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-signal/25 bg-signal/12 px-3 py-2 text-[12.5px] leading-relaxed text-mist-100">{item.text}</p>
        ) : null}
      </div>
    );
  }
  if (item.kind === "assistant") return <AssistantText text={item.text} sessionId={sessionId} />;
  if (item.kind === "notice") {
    // A slash command you ran, or its output: a quiet centred line, not a chat bubble.
    return (
      <p className="mx-auto max-w-[92%] whitespace-pre-wrap break-words text-center font-mono text-[11.5px] leading-relaxed text-mist-500" data-kind="notice">
        {item.text}
      </p>
    );
  }
  return <ToolRow item={item} />;
}

function AssistantText({ text, sessionId }: { text: string; sessionId: string }) {
  return <Markdown text={text} sessionId={sessionId} />;
}

function ToolRow({ item }: { item: Extract<SessionItem, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const bad = item.result?.isError === true;
  const preview = item.result ? firstLine(item.result.text) || "(no output)" : "running…";
  return (
    <div className={`rounded-lg border text-[12px] ${bad ? "border-bad/35 bg-bad/8" : "border-mist-500/12 bg-ink-850/60"}`} data-kind="tool" data-error={bad || undefined}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left">
        <ChevronRight size={13} className={`mt-0.5 flex-none text-mist-500 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        <Wrench size={12} className={`mt-0.5 flex-none ${bad ? "text-bad" : "text-mist-500"}`} aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className={`flex-none font-mono text-[11.5px] font-semibold ${bad ? "text-bad" : "text-mist-100"}`}>{item.name}</span>
            {item.summary ? <span className="truncate font-mono text-[11px] text-mist-300">{item.summary}</span> : null}
          </span>
          <span className={`truncate font-mono text-[10.5px] ${bad ? "text-bad" : item.result ? "text-mist-500" : "text-signal"}`}>{preview}</span>
        </span>
      </button>
      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-mist-500/10 px-2 py-2">
          <span className="eyebrow">Input</span>
          <pre className="scroll-thin max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink-950/70 px-2 py-1.5 font-mono text-[11px] leading-snug text-mist-300">{item.input}</pre>
          {item.result ? (
            <>
              <span className={`eyebrow ${bad ? "!text-bad" : ""}`}>{bad ? "Error" : "Result"}</span>
              <pre className={`scroll-thin max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink-950/70 px-2 py-1.5 font-mono text-[11px] leading-snug ${bad ? "text-bad" : "text-mist-300"}`}>{item.result.text || "(no output)"}</pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ───────────────────────── composer ─────────────────────────

function Composer({ sessionId, session }: { sessionId: string; session: SessionInfo | undefined }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const att = useAttachments(busy);
  const forks = session?.owner === "terminal" && session.status !== "ended";
  // Phones and tablets below 1024 px: one row that grows with the text (up to max-h-36), a short placeholder, and
  // focusing it on the bottom sheet raises the sheet to full so the keyboard leaves the conversation readable.
  const mode = useLayoutMode();
  const compact = mode !== "desktop";
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "";
    if (compact) el.style.height = `${Math.min(el.scrollHeight + 2, 144)}px`;
  }, [text, compact]);
  const canStop = session?.owner === "web" && (session.status === "running" || session.status === "waiting");
  const allowedModes = useSessionStore((s) => s.capabilities.permissionModes) ?? DEFAULT_MODES;
  // A live web session has a mode on the server; for any other the pick is applied when the next prompt starts it.
  const liveMode = session?.owner === "web" && session.status !== "ended" ? session.permissionMode : undefined;
  const [pending, setPending] = useState<SessionPermissionMode | null>(null);
  const modeShown = liveMode ?? pending ?? rememberedMode(allowedModes);
  const changeMode = async (m: SessionPermissionMode) => {
    setError(null);
    if (liveMode) {
      const e = await sessionCommands.setMode(sessionId, m);
      if (e) setError(e);
    } else setPending(m);
  };

  const empty = !text.trim() && att.items.length === 0;
  const send = async () => {
    if (busy || empty || att.reading) return;
    setBusy(true);
    setError(null);
    const r = await sessionCommands.send(sessionId, text, liveMode ? undefined : modeShown, att.payload());
    setBusy(false);
    if (r.ok) {
      setText("");
      att.clear();
    } else setError(r.error ?? "Could not send.");
  };

  const stop = async () => {
    setStopping(true);
    const e = await sessionCommands.interrupt(sessionId);
    setStopping(false);
    if (e) setError(e);
  };

  return (
    <form
      className={`flex flex-none flex-col gap-1.5 border-t px-3 py-2.5 ${att.dragging ? "border-signal bg-signal/5" : "border-mist-500/10"}`}
      {...att.dropProps}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      aria-label="Send a prompt"
      data-testid="composer"
    >
      {forks ? <p className="text-[11px] leading-snug text-mist-500">Sends to a fork; the terminal session is left untouched.</p> : null}
      <PermissionModePicker id={`mode-${sessionId}`} value={modeShown} allowed={allowedModes} onChange={(m) => void changeMode(m)} compact />
      {error ? (
        <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-2 py-1 text-[12px] text-bad">
          {error}
        </p>
      ) : null}
      <AttachmentStrip a={att} disabled={busy} />
      <div className="flex items-end gap-2">
        <AttachButton onFiles={(f) => void att.add(f)} disabled={busy} className="h-10 w-10 flex-none p-0 max-lg:h-11 max-lg:w-11" />
        <textarea
          ref={field}
          className="field scroll-thin max-h-36 min-h-[40px] flex-1 resize-none py-2 leading-snug max-lg:min-h-11"
          rows={compact ? 1 : 2}
          onFocus={() => {
            if (mode === "sheet") window.dispatchEvent(new Event("aaw:sheet-full"));
          }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={att.onPaste}
          onKeyDown={(e) => {
            if (isSendKey(e)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={busy ? "Sending…" : compact ? "Reply to Claude…" : "Reply to Claude (Enter sends, Shift+Enter for a new line)"}
          disabled={busy}
          aria-label="Prompt"
          name="prompt"
        />
        <div className="flex flex-none flex-col gap-1.5">
          {canStop ? (
            <button type="button" className="btn btn-ghost h-8 px-2.5 text-bad" onClick={() => void stop()} disabled={stopping} title="Interrupt the current turn">
              <CircleStop size={14} /> Stop
            </button>
          ) : null}
          <button type="submit" className="btn btn-primary h-8 px-2.5" disabled={busy || empty || att.reading} title="Send (Enter)">
            <Send size={13} /> {busy ? "Sending" : "Send"}
          </button>
        </div>
      </div>
    </form>
  );
}
