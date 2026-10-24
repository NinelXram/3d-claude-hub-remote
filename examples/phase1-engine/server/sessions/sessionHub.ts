// Sessions extension of the world server: list the Claude Code sessions seen through hooks, stream their
// transcripts to the web UI, and (with control enabled) run prompts and answer permission asks from it.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { MAX_PROMPT_IMAGES, MAX_PROMPT_IMAGE_BASE64, PROMPT_IMAGE_TYPES } from "../../src/integrations/AgentBackend.ts";
import type { PermissionRequestInfo, PromptImage, ServerMessage, SessionCommand, SessionInfo, SessionItem, SessionPermissionMode } from "../../src/integrations/AgentBackend.ts";
import type { Runner, RunHandle } from "./claudeRunner.ts";
import { TranscriptTail, isAllowedTranscript, projectsRoot, toolSummary } from "./transcript.ts";
import { FileTickets, resolveSessionVideo } from "./sessionFiles.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { slashCommand, typedText } from "../../src/live/promptText.ts";

/** Hook payload fields the hub reads. */
export interface SessionHookPayload {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
}

/** Whatever identifies one client connection; the hub never looks inside. */
export type Conn = object;

export interface HubIO {
  send(conn: Conn, msg: ServerMessage): void;
  broadcast(msg: ServerMessage): void;
}

export interface SessionHubOptions {
  /** Starts Claude Code sessions. Absent: read-only (no prompts, no permission answers). */
  runner?: Runner;
  /** Allow bypassPermissions from the web UI (server flag --allow-bypass). Off by default: the UI can be reached over a tunnel. */
  allowBypass?: boolean;
  /** Mode for sessions started without one. Default "default" (ask). */
  defaultPermissionMode?: SessionPermissionMode;
  /** Root that transcripts must live under. Defaults to ~/.claude/projects. */
  root?: string;
  pollMs?: number;
  /** How long to wait for Claude Code to report a new session id. */
  startTimeoutMs?: number;
  /** Drop the parsed items of a session nobody has watched for this long (re-read from disk on reopen). Default 5 min. */
  idleEvictMs?: number;
  /** Forget ended or idle sessions with no activity for this long (they are rediscovered if they change). Default 48 h. */
  forgetAfterMs?: number;
  /**
   * Also list sessions whose transcripts changed within this window, even if no hook has arrived since the
   * server started (sessions you opened earlier). 0 turns it off. Default 24 h; rescanned every minute.
   */
  discoverWithinMs?: number;
  /**
   * Where sessions removed from the list are remembered, so a restart or the next rescan does not bring them
   * back (e.g. ~/.aaw/hidden-sessions.json). Absent: remembered until the server stops.
   */
  hiddenFile?: string;
}

/** A removed session is remembered this long; past it, discovery (24 h by default) would not list it anyway. */
const HIDDEN_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Read the start of a transcript for its working directory and first prompt (title). */
function peekTranscript(path: string): { cwd: string; title: string } {
  const fd = openSync(path, "r");
  try {
    // The first prompt can sit behind large attachment or metadata lines, so look further than one block.
    const buf = Buffer.alloc(1024 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    let cwd = "";
    let title = "";
    let fallback = "";
    for (const line of buf.subarray(0, n).toString("utf8").split("\n")) {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!cwd && typeof d["cwd"] === "string") cwd = d["cwd"] as string;
      const content = (d["message"] as { content?: unknown } | undefined)?.content;
      const asText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((b): b is { type: string; text: string } => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
            : "";
      if (!title && d["type"] === "user" && d["isMeta"] !== true && d["isSidechain"] !== true && asText) {
        // The first thing you actually typed; a session that only ran slash commands is titled by the command.
        const typed = typedText(asText);
        if (typed) title = firstLine(typed);
        else fallback ||= slashCommand(asText) ?? "";
      }
      if (cwd && title) break;
    }
    return { cwd, title: title || fallback };
  } finally {
    closeSync(fd);
  }
}

interface Session {
  info: SessionInfo;
  transcript?: string;
  tail?: TranscriptTail;
  items: Map<string, SessionItem>;
  subscribers: Set<Conn>;
  run?: RunHandle;
  /** Last time anyone was watching; items of sessions nobody watches are dropped after `idleEvictMs`. */
  lastWatched: number;
  /** Transcript mtime when `info.gitBranch` was last read, so an unchanged file is not read again. */
  branchMtime?: number;
}

const BRANCH_TAIL_BYTES = 256 * 1024;
const BRANCH_RE = /"gitBranch"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/**
 * The git branch Claude Code recorded on the latest transcript lines (it writes `gitBranch` on every entry, so a
 * branch switch mid-session shows up). Undefined outside a repository or when the tail holds no entry with it.
 */
function lastGitBranch(path: string): string | undefined {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const len = Math.min(size, BRANCH_TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, size - len);
    let last: string | undefined;
    for (const m of buf.subarray(0, n).toString("utf8").matchAll(BRANCH_RE)) last = m[1];
    if (last === undefined) return undefined;
    const branch = (JSON.parse(`"${last}"`) as string).trim();
    return branch || undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

interface Pending {
  info: PermissionRequestInfo;
  resolve: (allow: boolean) => void;
}

const SESSION_COMMANDS: ReadonlySet<string> = new Set([
  "listSessions",
  "openSession",
  "sessionHistory",
  "closeSession",
  "sendPrompt",
  "respondPermission",
  "interruptSession",
  "setPermissionMode",
  "removeSession",
  "sessionImage",
  "sessionFile",
]);
const SAFE_MODES: SessionPermissionMode[] = ["default", "acceptEdits", "auto", "plan", "dontAsk"];

export function isSessionCommand(c: { name: string }): c is SessionCommand {
  return SESSION_COMMANDS.has(c.name);
}

/** The first bytes each accepted image type starts with, so a mislabelled file is refused here, not by the API. */
function sniffImage(data: string): string | null {
  const head = Buffer.from(data.slice(0, 24), "base64");
  if (head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return "image/png";
  if (head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Validate the images of a prompt from the web UI (untrusted input). */
export function checkPromptImages(images: unknown): PromptImage[] {
  if (images === undefined) return [];
  if (!Array.isArray(images)) throw new Error("`images` must be a list.");
  if (images.length > MAX_PROMPT_IMAGES) throw new Error(`At most ${MAX_PROMPT_IMAGES} images per prompt.`);
  return images.map((im: unknown, i) => {
    const { mediaType, data } = (im ?? {}) as { mediaType?: unknown; data?: unknown };
    const n = `Image ${i + 1}`;
    if (typeof mediaType !== "string" || !(PROMPT_IMAGE_TYPES as readonly string[]).includes(mediaType)) throw new Error(`${n}: only PNG, JPEG, GIF and WebP images can be sent.`);
    if (typeof data !== "string" || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) throw new Error(`${n} is not valid base64 data.`);
    if (data.length > MAX_PROMPT_IMAGE_BASE64) throw new Error(`${n} is too large (over 5 MB encoded). Use a smaller image.`);
    if (sniffImage(data) !== mediaType) throw new Error(`${n} is not a ${mediaType.slice(6).toUpperCase()} file.`);
    return { mediaType: mediaType as PromptImage["mediaType"], data };
  });
}

function firstLine(text: string, max = 90): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const DEFAULT_PAGE = 150;
const MAX_PAGE = 500;
function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(MAX_PAGE, Math.floor(limit ?? DEFAULT_PAGE)));
}

export class SessionHub {
  private sessions = new Map<string, Session>();
  private permissions = new Map<string, Pending>();
  private io: HubIO | null = null;
  private timer: ReturnType<typeof setInterval>;
  private root: string;
  private runner: Runner | undefined;
  readonly permissionModes: SessionPermissionMode[];
  private defaultMode: SessionPermissionMode;
  private startTimeoutMs: number;
  private discoverWithinMs: number;
  private idleEvictMs: number;
  private forgetAfterMs: number;
  private gcTimer: ReturnType<typeof setInterval>;
  private discoverTimer: ReturnType<typeof setInterval> | null = null;
  /** Sessions removed from the list → their latest activity then. Newer activity brings a session back. */
  private hidden = new Map<string, number>();
  private hiddenFile: string | undefined;
  private files = new FileTickets();

  constructor(options: SessionHubOptions = {}) {
    this.root = options.root ?? projectsRoot();
    this.runner = options.runner;
    this.permissionModes = options.allowBypass ? [...SAFE_MODES, "bypassPermissions"] : [...SAFE_MODES];
    this.defaultMode = this.checkMode(options.defaultPermissionMode ?? "default");
    this.startTimeoutMs = options.startTimeoutMs ?? 90_000;
    this.timer = setInterval(() => this.pollAll(), options.pollMs ?? 400);
    this.discoverWithinMs = options.discoverWithinMs ?? 24 * 60 * 60 * 1000;
    this.idleEvictMs = options.idleEvictMs ?? 5 * 60 * 1000;
    this.forgetAfterMs = options.forgetAfterMs ?? 48 * 60 * 60 * 1000;
    this.hiddenFile = options.hiddenFile;
    this.loadHidden();
    this.gcTimer = setInterval(() => this.collect(), 60_000);
    if (this.discoverWithinMs > 0) {
      this.discover();
      this.discoverTimer = setInterval(() => this.discover(), 60_000);
    }
  }

  /** List recent transcripts under the root that no hook has told us about yet. */
  discover(): void {
    if (!existsSync(this.root)) return;
    const since = Date.now() - this.discoverWithinMs;
    let added = false;
    for (const dir of readdirSync(this.root)) {
      const full = join(this.root, dir);
      let names: string[];
      try {
        if (!statSync(full).isDirectory()) continue;
        names = readdirSync(full).filter((n) => n.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const name of names) {
        const id = name.slice(0, -".jsonl".length);
        if (this.sessions.has(id)) continue;
        const path = join(full, name);
        let mtime: number;
        try {
          mtime = statSync(path).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < since || !isAllowedTranscript(path, this.root)) continue;
        const hiddenAt = this.hidden.get(id);
        if (hiddenAt !== undefined) {
          if (mtime <= hiddenAt) continue;
          this.unhide(id);
        }
        const { cwd, title } = peekTranscript(path);
        // A transcript with a cwd is a real session even when its first prompt is out of reach; list it anyway.
        if (!title && !cwd) continue;
        const s = this.ensure(id, cwd);
        s.transcript = path;
        // Unknown whether it is still open somewhere, so treat it as a terminal session: prompts fork it.
        s.info = { ...s.info, title: title || s.info.title, readable: true, status: "idle", owner: "terminal", lastActivity: mtime };
        added = true;
      }
    }
    if (added) this.broadcastSessions();
  }

  get control(): boolean {
    return this.runner !== undefined;
  }

  /** GET /session-file/<ticket>: the videos handed out by `sessionFile`. False for any other request. */
  serveFile(req: IncomingMessage, res: ServerResponse): boolean {
    return this.files.serve(req, res);
  }

  attach(io: HubIO): void {
    this.io = io;
  }

  dispose(): void {
    clearInterval(this.timer);
    if (this.discoverTimer) clearInterval(this.discoverTimer);
    clearInterval(this.gcTimer);
    for (const s of this.sessions.values()) s.run?.close();
    for (const p of this.permissions.values()) p.resolve(false);
    this.permissions.clear();
  }

  // ───────────────────────── hooks ─────────────────────────

  noteHook(p: SessionHookPayload): void {
    const id = p.session_id;
    if (!id) return;
    if (this.hidden.has(id)) {
      // A removed session stays off the list until you use it again; its late Stop or SessionEnd is ignored.
      if (p.hook_event_name !== "UserPromptSubmit" && p.hook_event_name !== "SessionStart") return;
      this.unhide(id);
    }
    const s = this.ensure(id, p.cwd ?? "");
    if (p.transcript_path && !s.transcript && isAllowedTranscript(p.transcript_path, this.root)) {
      s.transcript = p.transcript_path;
      s.info.readable = true;
    }
    if (p.cwd && !s.info.cwd) s.info.cwd = p.cwd;
    const before = s.info.status;
    switch (p.hook_event_name) {
      case "UserPromptSubmit":
        if (p.prompt && (s.info.title.startsWith("Session ") || s.info.title.startsWith("/") || s.info.title === "New conversation")) {
          const typed = typedText(p.prompt);
          s.info.title = typed ? firstLine(typed) : s.info.title.startsWith("/") ? s.info.title : slashCommand(p.prompt) ?? s.info.title;
        }
        s.info.status = "running";
        break;
      case "PreToolUse":
      case "PostToolUse":
      case "PostToolUseFailure":
      case "SubagentStart":
      case "SubagentStop":
        if (s.info.status !== "ended") s.info.status = "running";
        break;
      case "PermissionRequest":
      case "Notification":
        if (s.info.owner === "terminal") s.info.status = "waiting";
        break;
      case "Stop":
      case "StopFailure":
        s.info.status = "idle";
        break;
      case "SessionEnd":
        s.info.status = "ended";
        break;
    }
    s.info.lastActivity = Date.now();
    if (before !== s.info.status || p.hook_event_name === "UserPromptSubmit" || p.hook_event_name === "SessionStart") this.broadcastSessions();
  }

  // ───────────────────────── commands ─────────────────────────

  async handle(conn: Conn, c: SessionCommand): Promise<unknown> {
    switch (c.name) {
      case "listSessions":
        return this.list();
      case "openSession": {
        const s = this.sessions.get(c.sessionId);
        if (!s) throw new Error("Unknown session. Only sessions seen by this server can be opened.");
        this.locateTranscript(s);
        if (!s.transcript) throw new Error("This session's transcript is not available yet.");
        this.pollSession(s);
        s.subscribers.add(conn);
        s.lastWatched = Date.now();
        const all = [...s.items.values()];
        const limit = clampLimit(c.limit);
        return { session: s.info, items: all.slice(-limit), earlier: Math.max(0, all.length - limit) };
      }
      case "sessionHistory": {
        const s = this.sessions.get(c.sessionId);
        if (!s || !s.subscribers.has(conn)) throw new Error("Open the session first.");
        const all = [...s.items.values()];
        const end = all.findIndex((i) => i.id === c.before);
        if (end < 0) throw new Error("That item is no longer known; reopen the session.");
        const start = Math.max(0, end - clampLimit(c.limit));
        return { items: all.slice(start, end), earlier: start };
      }
      case "closeSession": {
        const s = this.sessions.get(c.sessionId);
        if (s) {
          s.subscribers.delete(conn);
          s.lastWatched = Date.now();
        }
        return undefined;
      }
      case "sendPrompt":
        return this.sendPrompt(conn, c.text, checkPromptImages(c.images), c.sessionId, c.cwd, c.permissionMode);
      case "sessionImage": {
        const s = this.sessions.get(c.sessionId);
        if (!s || !s.subscribers.has(conn)) throw new Error("Open the session first.");
        const image = s.tail?.image(c.imageId);
        if (!image) throw new Error("That image is no longer available; reopen the session.");
        return { mediaType: image.mediaType, data: image.data };
      }
      case "sessionFile": {
        const s = this.sessions.get(c.sessionId);
        if (!s || !s.subscribers.has(conn)) throw new Error("Open the session first.");
        const video = resolveSessionVideo(s.info.cwd, String(c.path ?? ""));
        return { url: this.files.issue(video, conn), mediaType: video.mediaType, size: video.size, name: video.name };
      }
      case "setPermissionMode": {
        this.requireControl();
        const mode = this.checkMode(c.mode);
        const s = this.sessions.get(c.sessionId);
        if (!s?.run) throw new Error("Only sessions running from this web UI can change mode; a terminal session gets its mode when you continue it here.");
        await s.run.setPermissionMode(mode);
        s.info.permissionMode = mode;
        this.broadcastSessions();
        return undefined;
      }
      case "respondPermission": {
        this.requireControl();
        const p = this.permissions.get(c.requestId);
        if (!p) throw new Error("That permission request is no longer pending.");
        this.permissions.delete(c.requestId);
        p.resolve(c.allow);
        this.io?.broadcast({ type: "permissionResolved", requestId: c.requestId, allowed: c.allow });
        return undefined;
      }
      case "interruptSession": {
        this.requireControl();
        const s = this.sessions.get(c.sessionId);
        if (!s?.run) throw new Error("Only sessions running from this web UI can be interrupted here.");
        await s.run.interrupt();
        return undefined;
      }
      case "removeSession":
        this.remove(c.sessionId);
        return undefined;
    }
  }

  disconnect(conn: Conn): void {
    this.files.revoke(conn);
    for (const s of this.sessions.values()) s.subscribers.delete(conn);
  }

  /** Pending permission asks, so a client that connects late can still answer them. */
  pendingPermissions(): PermissionRequestInfo[] {
    return [...this.permissions.values()].map((p) => p.info);
  }

  list(): SessionInfo[] {
    for (const s of this.sessions.values()) {
      this.locateTranscript(s);
      this.refreshBranch(s);
    }
    return [...this.sessions.values()].map((s) => ({ ...s.info })).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  /** Take a finished session off the list (the transcript is left alone). */
  remove(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error("Unknown session.");
    if (s.info.status === "running" || s.info.status === "waiting") throw new Error("This session is still working. Stop it or wait for the turn to end, then remove it.");
    if ([...this.permissions.values()].some((p) => p.info.sessionId === sessionId)) throw new Error("This session is waiting for a permission answer.");
    s.run?.close();
    let at = s.info.lastActivity;
    if (s.transcript) {
      try {
        at = Math.max(at, statSync(s.transcript).mtimeMs);
      } catch {
        // Gone from disk: the activity time is enough.
      }
    }
    this.sessions.delete(sessionId);
    this.hidden.set(sessionId, at);
    this.saveHidden();
    this.broadcastSessions();
  }

  private unhide(id: string): void {
    if (this.hidden.delete(id)) this.saveHidden();
  }

  private loadHidden(): void {
    if (!this.hiddenFile || !existsSync(this.hiddenFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.hiddenFile, "utf8")) as unknown;
      if (!data || typeof data !== "object") return;
      const cutoff = Date.now() - HIDDEN_KEEP_MS;
      for (const [id, at] of Object.entries(data)) if (typeof at === "number" && at > cutoff) this.hidden.set(id, at);
    } catch {
      // A damaged file only means removed sessions may show up again.
    }
  }

  private saveHidden(): void {
    if (!this.hiddenFile) return;
    const cutoff = Date.now() - HIDDEN_KEEP_MS;
    for (const [id, at] of this.hidden) if (at <= cutoff) this.hidden.delete(id);
    try {
      mkdirSync(dirname(this.hiddenFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.hiddenFile, JSON.stringify(Object.fromEntries(this.hidden)) + "\n", { mode: 0o600 });
    } catch (err) {
      console.warn(`  warning    could not save removed sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ───────────────────────── prompts ─────────────────────────

  private checkMode(mode: string): SessionPermissionMode {
    if (!this.permissionModes.includes(mode as SessionPermissionMode)) {
      throw new Error(mode === "bypassPermissions" ? "Bypass is off. Start the server with --allow-bypass to allow it." : `Unknown permission mode: ${mode}`);
    }
    return mode as SessionPermissionMode;
  }

  private requireControl(): void {
    if (!this.runner) throw new Error("Control is off. Start the server with --control to send prompts from the web UI.");
  }

  private async sendPrompt(conn: Conn, text: string, images: PromptImage[], sessionId?: string, cwd?: string, permissionMode?: SessionPermissionMode): Promise<{ sessionId: string; forked: boolean }> {
    this.requireControl();
    if (typeof text !== "string") throw new Error("`text` must be a string.");
    if (!text.trim() && images.length === 0) throw new Error("The prompt is empty.");
    const mode = permissionMode ? this.checkMode(permissionMode) : undefined;

    if (sessionId) {
      const s = this.sessions.get(sessionId);
      if (!s) throw new Error("Unknown session.");
      if (s.run) {
        if (mode && mode !== s.info.permissionMode) {
          await s.run.setPermissionMode(mode);
          s.info.permissionMode = mode;
        }
        s.run.push(text, images);
        s.info.status = "running";
        this.broadcastSessions();
        return { sessionId, forked: false };
      }
      // A session still open in a terminal must not get a second writer: continue it in a fork.
      const fork = !(s.info.status === "ended" || s.info.owner === "web");
      if (!s.info.cwd || !existsSync(s.info.cwd)) throw new Error("The session's working directory no longer exists.");
      const id = await this.start(conn, { cwd: s.info.cwd, text, images, resume: sessionId, fork, title: s.info.title, mode: mode ?? s.info.permissionMode ?? this.defaultMode });
      return { sessionId: id, forked: fork };
    }

    if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error("A new session needs `cwd`: an absolute path to an existing directory.");
    }
    const id = await this.start(conn, { cwd, text, images, fork: false, title: firstLine(text) || (images.length === 1 ? "Image" : `${images.length} images`), mode: mode ?? this.defaultMode });
    return { sessionId: id, forked: false };
  }

  private start(conn: Conn, a: { cwd: string; text: string; images: PromptImage[]; resume?: string; fork: boolean; title: string; mode: SessionPermissionMode }): Promise<string> {
    return new Promise((resolve, reject) => {
      let session: Session | null = null;
      const timeout = setTimeout(() => {
        if (!session) {
          handle.close();
          reject(new Error("Claude Code did not start a session in time."));
        }
      }, this.startTimeoutMs);
      const handle: RunHandle = this.runner!({
        cwd: a.cwd,
        firstPrompt: a.text,
        ...(a.images.length > 0 ? { firstImages: a.images } : {}),
        ...(a.resume ? { resume: a.resume } : {}),
        fork: a.fork,
        permissionMode: a.mode,
        onSession: (id) => {
          clearTimeout(timeout);
          if (session && session.info.sessionId !== id) {
            // /clear (or /reset, /new): the conversation restarted under a new id. Carry the process and
            // the viewers over, and close the old one.
            const old = session;
            const next = this.ensure(id, a.cwd);
            next.run = handle;
            next.info.owner = "web";
            next.info.permissionMode = old.info.permissionMode ?? a.mode;
            next.info.status = "running";
            next.info.title = "New conversation";
            for (const c of old.subscribers) next.subscribers.add(c);
            old.subscribers.clear();
            old.run = undefined;
            old.info.status = "ended";
            this.pollSession(old);
            session = next;
            this.locateTranscript(next);
            this.io?.broadcast({ type: "sessionMoved", from: old.info.sessionId, to: id, reason: "clear" });
            this.broadcastSessions();
            return;
          }
          session = this.ensure(id, a.cwd);
          session.run = handle;
          session.info.owner = "web";
          session.info.permissionMode = a.mode;
          session.info.status = "running";
          if (session.info.title.startsWith("Session ")) session.info.title = a.title || session.info.title;
          session.subscribers.add(conn);
          this.locateTranscript(session);
          this.broadcastSessions();
          resolve(id);
        },
        onTurnEnd: () => {
          if (!session) return;
          session.info.status = "idle";
          session.info.lastActivity = Date.now();
          this.pollSession(session);
          this.broadcastSessions();
        },
        onExit: (error) => {
          clearTimeout(timeout);
          if (!session) {
            reject(new Error(error ? `Claude Code failed to start: ${error}` : "Claude Code exited before starting a session."));
            return;
          }
          session.run = undefined;
          session.info.status = "ended";
          this.pollSession(session);
          this.broadcastSessions();
        },
        canUseTool: (ask) =>
          new Promise<boolean>((allow) => {
            const requestId = randomUUID();
            const info: PermissionRequestInfo = {
              requestId,
              sessionId: session?.info.sessionId ?? a.resume ?? "",
              toolName: ask.toolName,
              summary: toolSummary(ask.toolName, ask.input),
              input: JSON.stringify(ask.input, null, 2).slice(0, 2000),
              ...(ask.title ? { title: ask.title } : {}),
              at: Date.now(),
            };
            this.permissions.set(requestId, { info, resolve: allow });
            if (session) {
              session.info.status = "waiting";
              this.broadcastSessions();
            }
            this.io?.broadcast({ type: "permission", request: info });
            ask.signal.addEventListener("abort", () => {
              if (!this.permissions.delete(requestId)) return;
              allow(false);
              this.io?.broadcast({ type: "permissionResolved", requestId, allowed: false });
            });
          }).then((allowed) => {
            if (session && session.run) {
              session.info.status = "running";
              this.broadcastSessions();
            }
            return allowed;
          }),
      });
    });
  }

  // ───────────────────────── transcripts ─────────────────────────

  private ensure(id: string, cwd: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        info: { sessionId: id, title: `Session ${id.slice(0, 8)}`, cwd, status: "running", owner: "terminal", lastActivity: Date.now(), readable: false },
        items: new Map(),
        subscribers: new Set(),
        lastWatched: Date.now(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Sessions started here learn their transcript path from hooks, or by looking for <id>.jsonl under the root. */
  private locateTranscript(s: Session): void {
    if (s.transcript || !existsSync(this.root)) return;
    for (const dir of readdirSync(this.root)) {
      const candidate = join(this.root, dir, `${s.info.sessionId}.jsonl`);
      if (isAllowedTranscript(candidate, this.root)) {
        s.transcript = candidate;
        s.info.readable = true;
        return;
      }
    }
  }

  private pollSession(s: Session): void {
    if (!s.transcript) return;
    s.tail ??= new TranscriptTail(s.transcript);
    const changed = s.tail.poll();
    if (changed.length === 0) return;
    for (const it of changed) s.items.set(it.id, it);
    s.info.lastActivity = Date.now();
    if (!this.io) return;
    for (const conn of s.subscribers) this.io.send(conn, { type: "sessionItems", sessionId: s.info.sessionId, items: changed });
  }

  /**
   * Keep memory flat on a server that runs for days: parsed transcripts of sessions nobody watches are dropped
   * (the file is re-read on reopen), and long-quiet sessions are forgotten entirely. Returns what was freed.
   */
  collect(now = Date.now()): { evicted: number; forgotten: number } {
    let evicted = 0;
    let forgotten = 0;
    for (const [id, s] of this.sessions) {
      if (s.subscribers.size > 0 || s.run) continue;
      const pending = [...this.permissions.values()].some((p) => p.info.sessionId === id);
      if (pending) continue;
      if ((s.info.status === "ended" || s.info.status === "idle") && now - s.info.lastActivity > this.forgetAfterMs) {
        this.sessions.delete(id);
        forgotten++;
        continue;
      }
      if (s.items.size > 0 && now - s.lastWatched > this.idleEvictMs) {
        s.items = new Map();
        s.tail = undefined;
        evicted++;
      }
    }
    if (forgotten > 0) this.broadcastSessions();
    return { evicted, forgotten };
  }

  private pollAll(): void {
    for (const s of this.sessions.values()) {
      if (s.subscribers.size === 0 && !s.run) continue;
      this.locateTranscript(s);
      this.pollSession(s);
      // A branch switch in a session someone is watching shows up without waiting for the next status change.
      if (this.refreshBranch(s)) this.broadcastSessions();
    }
  }

  /** Re-read the session's git branch if its transcript changed; true when the branch is different now. */
  private refreshBranch(s: Session): boolean {
    if (!s.transcript) return false;
    let mtime: number;
    try {
      mtime = statSync(s.transcript).mtimeMs;
    } catch {
      return false;
    }
    if (mtime === s.branchMtime) return false;
    s.branchMtime = mtime;
    const branch = lastGitBranch(s.transcript);
    if (branch === undefined || branch === s.info.gitBranch) return false;
    s.info.gitBranch = branch;
    return true;
  }

  private broadcastSessions(): void {
    this.io?.broadcast({ type: "sessions", sessions: this.list() });
  }
}
