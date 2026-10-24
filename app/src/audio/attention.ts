// "Claude needs you": which live events deserve the tab title (and an optional desktop notification).
// Ported from the prompt repo's viewer (examples/phase1-engine/viewer/index.template.html, `attentionOf`).
// Pure and Node-safe so scripts/sound-test.ts can check it against recorded sessions.
import type { AgentEvent } from "../events/eventTypes.ts";
import type { PermissionRequestInfo } from "../integrations/AgentBackend.ts";

export interface Attention {
  /** Shown in front of the tab title, e.g. "⏳ Permission needed". */
  badge: string;
  /** Notification body. */
  body: string;
  /** "Turn ended" clears itself when the tab regains focus; the others wait for Claude to work again. */
  kind: "permission" | "input" | "turn-ended" | "stopped";
  /** The session it is about (several can run at once), when the event says so. */
  session?: string;
  /** Its project (the cwd's last segment), shown in the tab title and the notification. */
  project?: string;
}

/** Session id, project and title from a live event's metadata (set by the live source for every hook). */
export function sessionOf(e: AgentEvent): { session?: string; project?: string; title?: string } {
  const m = e.metadata ?? {};
  const pick = (k: string) => (typeof m[k] === "string" && m[k] ? (m[k] as string) : undefined);
  return { session: pick("session"), project: pick("project"), title: pick("sessionTitle") };
}

export function attentionOf(e: AgentEvent): Attention | null {
  let base: Omit<Attention, "session" | "project"> | null = null;
  if (e.agentId === "orion" && e.severity === "warning" && e.message.startsWith("Needs your permission")) {
    base = { badge: "⏳ Permission needed", body: e.message, kind: "permission" };
  } else if (e.agentId === "orion" && e.severity === "warning" && e.message.startsWith("Claude Code needs you")) {
    base = { badge: "⏳ Needs you", body: e.message, kind: "input" };
  } else if (e.type === "task.completed") base = { badge: "✓ Turn ended", body: e.message, kind: "turn-ended" };
  else if (e.type === "task.failed") base = { badge: "✗ Stopped", body: e.message, kind: "stopped" };
  if (!base) return null;
  const who = sessionOf(e);
  const name = [who.project, who.title].filter(Boolean).join(" · ");
  return { ...base, ...(name ? { body: `${name}: ${base.body}` } : {}), ...(who.session ? { session: who.session } : {}), ...(who.project ? { project: who.project } : {}) };
}

/** The tab title: the badge, then the project it is about, then the page title. */
export function attentionTitle(a: Attention, baseTitle: string, more = 0): string {
  return `${a.badge}${a.project ? ` · ${a.project}` : ""}${more > 0 ? ` (+${more})` : ""} · ${baseTitle}`;
}

/** Waiting for you outranks a turn that ended: another session finishing never hides an ask. */
export function attentionRank(a: Attention): number {
  return a.kind === "permission" || a.kind === "input" ? 2 : 1;
}

/** How long a "waiting for you" title holds against activity that arrives right behind it (seconds). */
export const WAITING_GRACE_S = 2;

/**
 * Whether an event that is not itself an attention event means Claude is working again, so whatever it
 * was waiting for is over. Any feed event counts except the server stopping, with one exception: while
 * Claude waits for permission or an answer, events within WAITING_GRACE_S of the request do not clear it.
 * Those are parallel tool calls issued in the same breath, not a sign that you have answered.
 */
export function clearsAttention(e: AgentEvent, shown?: { kind: Attention["kind"]; at: number; session?: string }): boolean {
  if (!e.feed || e.type === "system.stopped") return false;
  // Another session's activity says nothing about this one.
  const session = sessionOf(e).session;
  if (shown?.session && session && session !== shown.session) return false;
  if (shown && (shown.kind === "permission" || shown.kind === "input") && e.simTime - shown.at < WAITING_GRACE_S) return false;
  return true;
}

/** The notification title: the badge without its leading symbol. */
export function notificationTitle(a: Attention): string {
  return a.badge.replace(/^\S+\s/, "");
}

/**
 * A permission ask from a session run on this page (the sessions extension), dressed as the live source's own
 * "Needs your permission" warning from Orion, so it plays the same bell (cueFor) and raises the same badge
 * (attentionOf) as a terminal session's ask. It is never pushed into the feed.
 */
export function permissionEvent(
  ask: PermissionRequestInfo,
  simTime: number,
  nowMs: number = Date.now(),
  session?: { project?: string; title?: string },
): AgentEvent {
  const what = ask.summary ? `${ask.toolName}: ${ask.summary}` : ask.toolName;
  const metadata: Record<string, unknown> = { session: ask.sessionId };
  if (session?.project) metadata["project"] = session.project;
  if (session?.title) metadata["sessionTitle"] = session.title;
  return {
    metadata,
    id: `permission-${ask.requestId}`,
    type: "agent.message",
    timestamp: nowMs,
    simTime,
    agentId: "orion",
    message: `Needs your permission for ${what}`,
    severity: "warning",
    feed: false,
  };
}
