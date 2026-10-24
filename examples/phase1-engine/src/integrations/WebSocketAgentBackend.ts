import type { AgentId } from "../agents/agentTypes.ts";
import type { AgentEvent } from "../events/eventTypes.ts";
import { EventBus } from "../simulation/EventBus.ts";
import type { CreateTaskInput, Task } from "../tasks/taskTypes.ts";
import { PROTOCOL_VERSION } from "./AgentBackend.ts";
import type { AgentBackend, BackendCommand, ClientMessage, ServerCapabilities, ServerMessage, SessionCommand, WorldSnapshot } from "./AgentBackend.ts";

/** Server messages beyond the core world stream (the sessions extension). */
export type ExtraMessage = Extract<ServerMessage, { type: "sessions" | "sessionItems" | "permission" | "permissionResolved" | "sessionMoved" }>;

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface WebSocketBackendOptions {
  url: string;
  token?: string;
  /** Command acks slower than this reject. */
  commandTimeoutMs?: number;
  backoff?: { initialMs: number; maxMs: number; jitter: number };
  /** Injectable for tests; defaults to the global WebSocket (browsers, Node ≥ 22). */
  WebSocketImpl?: typeof WebSocket;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CLOSE_PROTOCOL_MISMATCH = 4400;
const CLOSE_UNAUTHORISED = 4401;

/** Client side of the v1 wire protocol (§3.5). The UI cannot tell it from MockAgentBackend. */
export class WebSocketAgentBackend implements AgentBackend {
  readonly kind = "websocket" as const;
  private serverLabel = "WebSocket backend";
  private serverSimulated = false;
  private serverCapabilities: ServerCapabilities = { sessions: false, control: false };
  private extras = new EventBus<ExtraMessage>();
  private options: Required<Omit<WebSocketBackendOptions, "token">> & { token?: string };
  private socket: WebSocket | null = null;
  private latest: WorldSnapshot | null = null;
  private pending = new Map<string, Pending>();
  private events = new EventBus<AgentEvent>();
  private snapshots = new EventBus<WorldSnapshot>();
  private states = new EventBus<{ state: ConnectionState; error: string | null }>();
  private state: ConnectionState = "idle";
  private error: string | null = null;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private firstWelcome: { resolve: () => void; reject: (e: Error) => void } | null = null;
  /** Event ids already delivered; the server replays recent events on every (re)connect. */
  private seen = new Set<string>();

  constructor(options: WebSocketBackendOptions) {
    this.options = {
      commandTimeoutMs: 10_000,
      backoff: { initialMs: 500, maxMs: 10_000, jitter: 0.2 },
      WebSocketImpl: globalThis.WebSocket,
      ...options,
    };
  }

  get label(): string {
    return this.serverLabel;
  }

  /** The server's HTTP origin (ws: → http:, wss: → https:), for files it serves next to the WebSocket. */
  get httpOrigin(): string {
    try {
      const u = new URL(this.options.url);
      return `${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}`;
    } catch {
      return "";
    }
  }

  /** What the server allows beyond the world stream; known after `welcome`. */
  get capabilities(): ServerCapabilities {
    return this.serverCapabilities;
  }

  /** Send a sessions-extension command; resolves with the ack's result. */
  request<T = unknown>(command: SessionCommand): Promise<T> {
    return this.command(command) as Promise<T>;
  }

  /** Sessions-extension messages: session list, transcript items, permission asks and their resolution. */
  subscribeMessage(listener: (m: ExtraMessage) => void): () => void {
    return this.extras.subscribe(listener);
  }

  get simulated(): boolean {
    return this.serverSimulated;
  }

  get connection(): { state: ConnectionState; error: string | null } {
    return { state: this.state, error: this.error };
  }

  subscribeConnection(listener: (s: { state: ConnectionState; error: string | null }) => void): () => void {
    return this.states.subscribe(listener);
  }

  /** Resolves on the first `welcome`; rejects if the server refuses us before that. Later drops reconnect. */
  connect(): Promise<void> {
    if (this.state === "open") return Promise.resolve();
    this.manualClose = false;
    return new Promise<void>((resolve, reject) => {
      this.firstWelcome = { resolve, reject };
      this.open();
    });
  }

  async disconnect(): Promise<void> {
    this.manualClose = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.rejectPending("disconnected");
    this.socket?.close(1000, "client disconnect");
    this.socket = null;
    this.setState("closed", null);
  }

  start(): Promise<void> { return this.command({ name: "start" }).then(() => undefined); }
  stop(): Promise<void> { return this.command({ name: "stop" }).then(() => undefined); }
  pause(): Promise<void> { return this.command({ name: "pause" }).then(() => undefined); }
  resume(): Promise<void> { return this.command({ name: "resume" }).then(() => undefined); }
  reset(): Promise<void> { return this.command({ name: "reset" }).then(() => undefined); }
  setSpeed(multiplier: number): Promise<void> { return this.command({ name: "setSpeed", multiplier }).then(() => undefined); }
  submitTask(input: CreateTaskInput): Promise<Task> { return this.command({ name: "submitTask", input }) as Promise<Task>; }
  pauseAgent(agentId: AgentId): Promise<void> { return this.command({ name: "pauseAgent", agentId }).then(() => undefined); }
  resumeAgent(agentId: AgentId): Promise<void> { return this.command({ name: "resumeAgent", agentId }).then(() => undefined); }
  focusSession(sessionId: string | null): Promise<void> { return this.command({ name: "focusSession", sessionId }).then(() => undefined); }

  getSnapshot(): WorldSnapshot | null {
    return this.latest;
  }

  subscribe(listener: (e: AgentEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  subscribeSnapshot(listener: (s: WorldSnapshot) => void): () => void {
    return this.snapshots.subscribe(listener);
  }

  // ───────────────────────── internals ─────────────────────────

  private command(command: BackendCommand): Promise<unknown> {
    const socket = this.socket;
    if (this.state !== "open" || !socket) return Promise.reject(new Error(this.state === "reconnecting" ? "disconnected" : "not connected"));
    const id = commandId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`command ${command.name} timed out`));
      }, this.options.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ type: "command", id, command });
    });
  }

  private open(): void {
    this.setState(this.attempts === 0 ? "connecting" : "reconnecting", this.error);
    const socket = new this.options.WebSocketImpl(this.options.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, ...(this.options.token ? { token: this.options.token } : {}) });
    });
    socket.addEventListener("message", (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    socket.addEventListener("close", (ev: CloseEvent) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.rejectPending("disconnected");
      if (this.manualClose) return;
      if (ev.code === CLOSE_PROTOCOL_MISMATCH || ev.code === CLOSE_UNAUTHORISED) {
        const error = ev.reason || (ev.code === CLOSE_UNAUTHORISED ? "unauthorised" : "protocol version not supported");
        this.setState("closed", error);
        this.firstWelcome?.reject(new Error(error));
        this.firstWelcome = null;
        return;
      }
      this.scheduleReconnect(ev.reason || `connection closed (${ev.code})`);
    });
    socket.addEventListener("error", () => {
      // A close event always follows; reconnect is handled there.
    });
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        this.serverLabel = msg.label;
        this.serverSimulated = msg.simulated;
        this.serverCapabilities = msg.capabilities ?? { sessions: false, control: false };
        this.attempts = 0;
        this.setState("open", null);
        this.firstWelcome?.resolve();
        this.firstWelcome = null;
        break;
      case "snapshot":
        // Authoritative: replace, never merge.
        this.latest = msg.snapshot;
        this.snapshots.emit(msg.snapshot);
        break;
      case "event":
        if (this.seen.has(msg.event.id)) return;
        // Ids restart after a reset, so forget the old ones.
        if (msg.event.type === "system.reset") this.seen.clear();
        this.seen.add(msg.event.id);
        this.events.emit(msg.event);
        break;
      case "sessions":
      case "sessionItems":
      case "permission":
      case "permissionResolved":
      case "sessionMoved":
        this.extras.emit(msg);
        break;
      case "ack": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error));
        break;
      }
    }
  }

  private scheduleReconnect(reason: string): void {
    const { initialMs, maxMs, jitter } = this.options.backoff;
    const base = Math.min(maxMs, initialMs * 2 ** this.attempts);
    const delay = base * (1 + (Math.random() * 2 - 1) * jitter);
    this.attempts++;
    this.setState("reconnecting", reason);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private rejectPending(reason: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private send(msg: ClientMessage): void {
    this.socket?.send(JSON.stringify(msg));
  }

  private setState(state: ConnectionState, error: string | null): void {
    this.state = state;
    this.error = error;
    this.states.emit({ state, error });
  }
}

/** A request id. crypto.randomUUID exists only on HTTPS and localhost; getRandomValues also works over plain HTTP (e.g. a tailnet link). */
function commandId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
