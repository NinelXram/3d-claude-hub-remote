import type { AgentId, AgentState } from "../agents/agentTypes.ts";
import type { AgentEvent } from "../events/eventTypes.ts";
import type { CreateTaskInput, Task } from "../tasks/taskTypes.ts";

export type SimulationStatus = "ready" | "running" | "paused";

export interface CommLink {
  id: string;
  from: AgentId;
  to: AgentId;
  kind: "message" | "assign" | "report";
  /** Backend clock, seconds. */
  startedAt: number;
  endsAt: number;
}

export interface WorldSnapshot {
  clock: number;
  status: SimulationStatus;
  speed: number;
  agents: AgentState[];
  tasks: Task[];
  links: CommLink[];
  /** Live Claude Code sources only: which session the robots act out, and the recent sessions. */
  live?: LiveWorldState;
}

/** One recent Claude Code session as the live source sees it through hooks. */
export interface LiveSessionSummary {
  sessionId: string;
  /** The first prompt, shortened ("Session <id>" before one arrives, or with prompts hidden). */
  title: string;
  /** Last segment of the session's working directory, e.g. "shop-api". */
  project: string;
  /** running: a turn is in progress · waiting: needs permission or an answer · idle: turn ended · ended: closed. */
  status: "running" | "waiting" | "idle" | "ended";
  /** Wall-clock ms of the last hook. */
  lastActivity: number;
}

export interface LiveWorldState {
  /**
   * The session the robots act out. "auto" follows activity (with hysteresis; a session waiting for you takes
   * focus at once); "pinned" stays on the session you picked.
   */
  focus: { sessionId: string | null; mode: "auto" | "pinned" };
  /** Newest activity first; ended sessions drop out after a few minutes. */
  sessions: LiveSessionSummary[];
}

export interface AgentBackend {
  readonly kind: "mock" | "websocket" | "live";
  readonly label: string;
  readonly simulated: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  reset(): Promise<void>;
  setSpeed(multiplier: number): Promise<void>;
  submitTask(input: CreateTaskInput): Promise<Task>;
  pauseAgent(id: AgentId): Promise<void>;
  resumeAgent(id: AgentId): Promise<void>;
  getSnapshot(): WorldSnapshot | null;
  subscribe(listener: (e: AgentEvent) => void): () => void;
  subscribeSnapshot(listener: (s: WorldSnapshot) => void): () => void;
  /** Live sources with several sessions: pin the robots to one session, or `null` to follow activity again. */
  focusSession?(sessionId: string | null): Promise<void>;
}

/** WebSocket wire protocol, v1. */
export const PROTOCOL_VERSION = 1;

export type BackendCommand =
  | { name: "start" | "stop" | "pause" | "resume" | "reset" }
  | { name: "setSpeed"; multiplier: number }
  | { name: "submitTask"; input: CreateTaskInput }
  | { name: "pauseAgent" | "resumeAgent"; agentId: AgentId }
  /** Live sources: which session the robots follow. `null` means auto (follow activity). Needs no token on loopback. */
  | { name: "focusSession"; sessionId: string | null }
  | SessionCommand;

// ───────────── Sessions extension (live Claude Code servers only; see `welcome.capabilities`) ─────────────

/**
 * How a web-run session handles permission asks (Claude Code's own modes):
 * default asks you · acceptEdits allows file edits · auto lets Claude Code's classifier decide (asks when unsure) ·
 * plan plans without running tools · dontAsk denies anything not pre-approved in settings ·
 * bypassPermissions skips every check (only when the server allows it).
 */
export type SessionPermissionMode = "default" | "acceptEdits" | "auto" | "plan" | "dontAsk" | "bypassPermissions";

/** A Claude Code session the server has seen through hooks or started itself. */
export interface SessionInfo {
  sessionId: string;
  /** First line of the first prompt seen, or "Session <id>". */
  title: string;
  cwd: string;
  /** Git branch Claude Code recorded on the latest transcript lines; absent outside a repository. */
  gitBranch?: string;
  /** running: a turn is in progress · waiting: needs permission or an answer · idle: turn ended · ended: session closed. */
  status: "running" | "waiting" | "idle" | "ended";
  /** terminal: a session you run elsewhere (read-only here) · web: started or continued from this UI. */
  owner: "terminal" | "web";
  lastActivity: number;
  /** Whether its transcript can be opened (the server only reads files under ~/.claude/projects). */
  readable: boolean;
  /** Permission mode of a session run from the web UI (unknown for terminal sessions). */
  permissionMode?: SessionPermissionMode;
}

/** Image types a prompt may carry (what the Claude API accepts). */
export const PROMPT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type PromptImageType = (typeof PROMPT_IMAGE_TYPES)[number];
/** At most this many images per prompt. */
export const MAX_PROMPT_IMAGES = 8;
/** Largest base64 payload per image (the Claude API refuses images over 5 MB). */
export const MAX_PROMPT_IMAGE_BASE64 = 5 * 1024 * 1024;

/** An image attached to a prompt: `data` is base64 without a `data:` prefix. */
export interface PromptImage {
  mediaType: PromptImageType;
  data: string;
}

/** An image in a session's conversation. Its bytes are fetched on demand with `sessionImage`. */
export interface SessionImageRef {
  id: string;
  mediaType: string;
}

/** One entry of a session's conversation. Items are upserted by `id` (a tool item gains its result later). */
export type SessionItem =
  /** Your prompt; `images` are the pictures you attached (pasted in the terminal or sent from the web UI). */
  | { kind: "user"; id: string; at: number; text: string; images?: SessionImageRef[] }
  | { kind: "assistant"; id: string; at: number; text: string }
  | { kind: "tool"; id: string; at: number; name: string; summary: string; input: string; result?: { text: string; isError: boolean } }
  /** A slash command you ran (e.g. "/clear") or its output, shown as a quiet line rather than a chat bubble. */
  | { kind: "notice"; id: string; at: number; text: string };

/** Claude asks to use a tool in a session run from the web UI. */
export interface PermissionRequestInfo {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  input: string;
  /** Claude Code's own sentence for the ask when it provides one. */
  title?: string;
  at: number;
}

export type SessionCommand =
  | { name: "listSessions" }
  /**
   * Subscribe this connection to a session. The ack carries the latest `limit` items (default 150) and
   * `earlier`, how many older items exist; later items arrive as `sessionItems`.
   */
  | { name: "openSession"; sessionId: string; limit?: number }
  /** Older items of an open session: up to `limit` items before the item `before`. Acks `{ items, earlier }`. */
  | { name: "sessionHistory"; sessionId: string; before: string; limit?: number }
  | { name: "closeSession"; sessionId: string }
  /**
   * Send a prompt. With `sessionId`, continue that session (forked if it is still open elsewhere);
   * without, start a new session in `cwd`. `images` are attached before the text (a prompt may be images
   * only). The ack carries `{ sessionId, forked }`.
   */
  | { name: "sendPrompt"; text: string; images?: PromptImage[]; sessionId?: string; cwd?: string; permissionMode?: SessionPermissionMode }
  /** The bytes of an image in a session you opened. Acks `{ mediaType, data }` (base64). */
  | { name: "sessionImage"; sessionId: string; imageId: string }
  /** Change the permission mode of a session running from the web UI, effective for its next tool call. */
  | { name: "setPermissionMode"; sessionId: string; mode: SessionPermissionMode }
  | { name: "respondPermission"; requestId: string; allow: boolean }
  | { name: "interruptSession"; sessionId: string }
  /**
   * Take a finished session (idle or ended) off the list. Its transcript stays on disk; the session comes back
   * if it gets a new prompt. Refused while a turn runs or a permission ask is pending.
   */
  | { name: "removeSession"; sessionId: string }
  /**
   * Play a video from a session's working folder (a path Claude mentioned, absolute or relative to that folder).
   * Only video files inside the folder are allowed. Acks a `SessionFileInfo`; the bytes come over HTTP at its `url`.
   */
  | { name: "sessionFile"; sessionId: string; path: string };

/** File types `sessionFile` serves, by extension. */
export const SESSION_VIDEO_TYPES: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

/** A video the server will stream: `url` is a path on the world server (an unguessable, expiring ticket). */
export interface SessionFileInfo {
  url: string;
  mediaType: string;
  size: number;
  name: string;
}

export interface ServerCapabilities {
  /** Transcripts can be opened. */
  sessions: boolean;
  /** Prompts and permission answers are accepted. */
  control: boolean;
  /** Permission modes this server lets the web UI pick (bypassPermissions only with --allow-bypass). */
  permissionModes?: SessionPermissionMode[];
  /** The server has sessions, but this connection did not present the token, so they are hidden from it. */
  locked?: boolean;
}

export type ClientMessage =
  | { type: "hello"; protocolVersion: number; token?: string }
  | { type: "command"; id: string; command: BackendCommand };

export type ServerMessage =
  | { type: "welcome"; protocolVersion: number; label: string; simulated: boolean; capabilities?: ServerCapabilities }
  | { type: "event"; event: AgentEvent }
  | { type: "snapshot"; snapshot: WorldSnapshot }
  | { type: "ack"; id: string; ok: true; result?: unknown }
  | { type: "ack"; id: string; ok: false; error: string }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "sessionItems"; sessionId: string; items: SessionItem[] }
  | { type: "permission"; request: PermissionRequestInfo }
  | { type: "permissionResolved"; requestId: string; allowed: boolean }
  /**
   * A web session continued under a new id: /clear (or /reset, /new) starts a fresh conversation with a new
   * session id. Clients showing `from` should open `to`.
   */
  | { type: "sessionMoved"; from: string; to: string; reason: "clear" | "other" };
