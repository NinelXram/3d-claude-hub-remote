"use client";

import { useState } from "react";
import { ChevronRight, ShieldAlert } from "lucide-react";
import type { PermissionRequestInfo } from "@/integrations/AgentBackend";
import { sessionCommands } from "@/integrations/sessionClient";
import { ProjectChip, basename } from "@/components/sessions/sessionUi";
import { useSessionStore } from "@/state/useSessionStore";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

/** Cards beyond this are summarised as "+N more"; answering one brings the next up. */
const MAX_CARDS = 3;

/**
 * Claude's permission asks for sessions run from this page. Floats over the world on every tab (and on phones),
 * so an ask never hides inside the Sessions tab. Deliberately no keyboard shortcut and no autofocus on Allow:
 * approving a tool call should take an aimed click, never a stray Enter.
 */
export function PermissionStack() {
  useRenderCount("PermissionStack");
  const live = useWorldStore((s) => s.backend.identified && !s.backend.simulated);
  const permissions = useSessionStore((s) => s.permissions);
  if (!live || permissions.length === 0) return null;
  const shown = permissions.slice(0, MAX_CARDS);
  const more = permissions.length - shown.length;
  return (
    <section aria-label="Permission asks" className="pointer-events-none flex max-h-full w-full max-w-[440px] flex-col gap-2 overflow-y-auto" data-testid="permission-stack">
      {shown.map((p) => (
        <PermissionCard key={p.requestId} ask={p} />
      ))}
      {more > 0 ? <p className="surface pointer-events-auto self-center px-3 py-1 text-[11.5px] text-mist-300">+{more} more waiting</p> : null}
    </section>
  );
}

function PermissionCard({ ask }: { ask: PermissionRequestInfo }) {
  const sessionTitle = useSessionStore((s) => s.sessions.find((x) => x.sessionId === ask.sessionId)?.title);
  // Several sessions can ask at once: name the project too.
  const project = useSessionStore((s) => basename(s.sessions.find((x) => x.sessionId === ask.sessionId)?.cwd ?? ""));
  const openId = useSessionStore((s) => s.openId);
  const tab = useWorldStore((s) => s.tab);
  const [showInput, setShowInput] = useState(false);
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const answer = async (allow: boolean) => {
    setBusy(allow ? "allow" : "deny");
    setError(null);
    const e = await sessionCommands.respondPermission(ask.requestId, allow);
    // On success the card unmounts (permissionResolved); on failure it stays with the reason.
    if (e) {
      setBusy(null);
      setError(e);
    }
  };

  const viewing = tab === "sessions" && openId === ask.sessionId;
  const openSession = () => {
    useWorldStore.getState().setTab("sessions");
    void sessionCommands.open(ask.sessionId);
  };

  return (
    <article
      role="group"
      aria-label={`Permission ask: ${ask.toolName}`}
      className="surface pointer-events-auto flex flex-col gap-2 border-warn/35 px-3 py-2.5 [animation:aaw-rise-in_160ms_ease-out]"
      data-testid="permission-card"
    >
      <header className="flex items-start gap-2">
        <ShieldAlert size={16} className="mt-0.5 flex-none text-warn" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-mist-100">
            Claude wants to use <span className="font-mono">{ask.toolName}</span>
          </p>
          {sessionTitle || project ? (
            <div className="flex min-w-0 items-center gap-1.5">
              {project ? <ProjectChip project={project} /> : null}
              {!sessionTitle ? null : viewing ? (
                <p className="min-w-0 truncate text-[11px] text-mist-500">{sessionTitle}</p>
              ) : (
                <button type="button" className="block min-w-0 max-w-full truncate text-left text-[11px] text-mist-500 underline-offset-2 hover:text-mist-300 hover:underline pointer-coarse:min-h-8" onClick={openSession} title="Open this session">
                  {sessionTitle}
                </button>
              )}
            </div>
          ) : null}
        </div>
      </header>
      {ask.title ? <p className="text-[12.5px] leading-snug text-mist-300">{ask.title}</p> : null}
      {ask.summary ? <p className="break-words rounded-md bg-ink-950/60 px-2 py-1 font-mono text-[11.5px] leading-snug text-mist-100">{ask.summary}</p> : null}
      <div>
        <button type="button" className="inline-flex items-center gap-1 text-[11px] text-mist-500 hover:text-mist-300 pointer-coarse:min-h-11 pointer-coarse:pr-3" aria-expanded={showInput} onClick={() => setShowInput((v) => !v)}>
          <ChevronRight size={12} className={`transition-transform ${showInput ? "rotate-90" : ""}`} aria-hidden /> {showInput ? "Hide input" : "Show input"}
        </button>
        {showInput ? (
          <pre className="scroll-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink-950/70 px-2 py-1.5 font-mono text-[11px] leading-snug text-mist-300">{ask.input}</pre>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="rounded-lg border border-bad/30 bg-bad/10 px-2 py-1 text-[12px] text-bad">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn btn-ghost" onClick={() => void answer(false)} disabled={busy !== null}>
          {busy === "deny" ? "Denying…" : "Deny"}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void answer(true)} disabled={busy !== null}>
          {busy === "allow" ? "Allowing…" : "Allow"}
        </button>
      </div>
    </article>
  );
}
