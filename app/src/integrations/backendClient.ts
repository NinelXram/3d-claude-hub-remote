import type { AgentId } from "@/agents/agentTypes";
import type { AgentEvent } from "@/events/eventTypes";
import { useWorldStore } from "@/state/useWorldStore";
import { DEMO_TASK } from "@/tasks/taskActions";
import { SPRINT_TASKS } from "@/tasks/taskBacklog";
import type { CreateTaskInput, Task } from "@/tasks/taskTypes";
import type { AgentBackend } from "./AgentBackend";
import { MockAgentBackend } from "./MockAgentBackend";
import { wireSessions } from "./sessionClient";
import { takeTokenFromUrl } from "./tokenUrl";
import { WebSocketAgentBackend } from "./WebSocketAgentBackend";

// Selection by env (§3.5). Literal `process.env.NEXT_PUBLIC_*` reads so Next inlines them at build time.
export const BACKEND_ENV = {
  backend: process.env.NEXT_PUBLIC_AGENT_BACKEND ?? "",
  wsUrl: process.env.NEXT_PUBLIC_AGENT_WS_URL ?? "",
  hasToken: Boolean(process.env.NEXT_PUBLIC_AGENT_WS_TOKEN),
} as const;

const TOKEN_KEY = "aaw.token";

let tokenSource: "url" | "session" | "env" | null = null;

/** Keep a token pasted in the UI for this tab and reconnect with it (a reload builds a fresh client). */
export function rememberTokenAndReload(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token.trim());
  } catch {
    // Storage blocked: fall back to carrying it in the URL once; resolveToken() removes it again.
    const url = new URL(window.location.href);
    url.hash = `token=${encodeURIComponent(token.trim())}`;
    window.location.replace(url.toString());
    window.location.reload();
    return;
  }
  window.location.reload();
}

/** Where the WebSocket token came from (known once the backend exists), for Settings → Backend. */
export function getTokenSource(): typeof tokenSource {
  return tokenSource;
}

/**
 * The WebSocket token: `#token=…` (or `?token=…` from older links) in the page URL (then kept in sessionStorage so reloads work, and removed from
 * the address bar so it does not linger in history or screenshots), else one kept from earlier in this tab,
 * else NEXT_PUBLIC_AGENT_WS_TOKEN.
 */
export function resolveToken(): string | undefined {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_AGENT_WS_TOKEN || undefined;
  const { token: fromUrl, cleaned } = takeTokenFromUrl(window.location.href);
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // blocked storage: the token works for this page load only
    }
    window.history.replaceState(window.history.state, "", cleaned);
    tokenSource = "url";
    return fromUrl;
  }
  let kept: string | null = null;
  try {
    kept = sessionStorage.getItem(TOKEN_KEY);
  } catch {
    kept = null;
  }
  if (kept) {
    tokenSource = "session";
    return kept;
  }
  const env = process.env.NEXT_PUBLIC_AGENT_WS_TOKEN;
  if (env) {
    tokenSource = "env";
    return env;
  }
  return undefined;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * The configured URL points at this machine (ws://127.0.0.1:8787). When the page itself is opened from elsewhere,
 * through a tunnel or from another device, that address means the visitor's own device, and an https page cannot
 * open ws:// anyway. The world server can serve this app (`--proxy-app`), so connect back to the page's own
 * origin instead.
 */
export function resolveWsUrl(configured: string): string {
  if (typeof window === "undefined") return configured;
  let target: URL;
  try {
    target = new URL(configured);
  } catch {
    return configured;
  }
  if (!LOOPBACK.has(target.hostname) || LOOPBACK.has(window.location.hostname)) return configured;
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/`;
}

let backend: AgentBackend | null = null;

/** The one backend instance for this page. Created lazily on the client. */
export function getBackend(): AgentBackend {
  if (backend) return backend;
  if (BACKEND_ENV.backend === "websocket") {
    const url = resolveWsUrl(BACKEND_ENV.wsUrl || "ws://127.0.0.1:8787/");
    const token = resolveToken();
    // Starting a session acks once Claude Code reports its id, which can take a while (the server allows 90 s).
    backend = new WebSocketAgentBackend({ url, commandTimeoutMs: 95_000, ...(token ? { token } : {}) });
  } else {
    backend = new MockAgentBackend();
  }
  return backend;
}

function describe(b: AgentBackend): { kind: AgentBackend["kind"]; label: string; simulated: boolean } {
  return { kind: b.kind, label: b.label, simulated: b.simulated };
}

// ───────────────────────── connection ─────────────────────────

let connectPromise: Promise<void> | null = null;
let pendingDisconnect: ReturnType<typeof setTimeout> | null = null;

/**
 * Wires backend events and snapshots into the store and connects. Returns a disposer.
 *
 * The connection itself outlives a quick dispose/re-connect pair (React StrictMode runs mount effects
 * twice): disconnecting is deferred and cancelled by the next call, so the mock engine does not stop and
 * re-emit its boot events, and the socket does not flap.
 */
export function connectBackend(): () => void {
  const b = getBackend();
  const store = useWorldStore.getState();
  if (pendingDisconnect) {
    clearTimeout(pendingDisconnect);
    pendingDisconnect = null;
  }

  // Events can arrive in bursts (boot events, the late-joiner replay); batch them into one store write.
  let queue: AgentEvent[] = [];
  let flushScheduled = false;
  const flush = () => {
    flushScheduled = false;
    const batch = queue;
    queue = [];
    useWorldStore.getState().pushEvents(batch);
  };
  const offEvents = b.subscribe((e) => {
    queue.push(e);
    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  });
  const offSnapshots = b.subscribeSnapshot((s) => useWorldStore.getState().applySnapshot(s));

  let offConnection: () => void = () => {};
  let offSessions: () => void = () => {};
  if (b instanceof WebSocketAgentBackend) {
    offSessions = wireSessions(b);
    store.setBackend({ ...describe(b), connection: b.connection.state, error: b.connection.error });
    offConnection = b.subscribeConnection(({ state, error }) => {
      useWorldStore.getState().setBackend({ ...describe(b), connection: state, error, ...(state === "open" ? { identified: true } : {}) });
    });
  } else {
    store.setBackend({ ...describe(b), connection: "open", error: null, identified: true });
  }

  if (!connectPromise) {
    connectPromise = b.connect().catch((err: unknown) => {
      connectPromise = null;
      const message = err instanceof Error ? err.message : String(err);
      useWorldStore.getState().setBackend({ connection: "closed", error: message });
    });
  }
  void connectPromise.then(() => {
    const snap = b.getSnapshot();
    if (snap) useWorldStore.getState().applySnapshot(snap);
    useWorldStore.getState().setBackend(describe(b));
  });

  return () => {
    offEvents();
    offSnapshots();
    offConnection();
    offSessions();
    if (queue.length) flush();
    pendingDisconnect = setTimeout(() => {
      pendingDisconnect = null;
      connectPromise = null;
      void b.disconnect();
    }, 250);
  };
}

// ───────────────────────── commands ─────────────────────────

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  useWorldStore.getState().notify(message, "error");
}

async function run(fn: (b: AgentBackend) => Promise<void>): Promise<boolean> {
  try {
    await fn(getBackend());
    return true;
  } catch (err) {
    reportError(err);
    return false;
  }
}

/** Starts from `ready`, resumes from `paused`, does nothing while running. */
async function ensureRunning(): Promise<void> {
  const status = useWorldStore.getState().simStatus;
  if (status === "ready") await commands.start();
  else if (status === "paused") await commands.resume();
}

let autoStarted = false;

/** Everything the UI does to the world goes through here; components never touch a backend directly. */
export const commands = {
  start: () => run((b) => b.start()),
  pause: () => run((b) => b.pause()),
  resume: () => run((b) => b.resume()),
  reset: () => run((b) => b.reset()),
  setSpeed: (multiplier: number) => run((b) => b.setSpeed(multiplier)),
  pauseAgent: (id: AgentId) => run((b) => b.pauseAgent(id)),
  resumeAgent: (id: AgentId) => run((b) => b.resumeAgent(id)),
  /** Live sources: the robots follow this session (pinned), or activity again with `null` (auto). */
  focusSession: (sessionId: string | null) =>
    run(async (b) => {
      if (!b.focusSession) throw new Error("This backend has no sessions to follow.");
      await b.focusSession(sessionId);
    }),

  /** Space: start / pause / resume depending on the current status. */
  toggleRun: async (): Promise<boolean> => {
    const status = useWorldStore.getState().simStatus;
    if (status === "running") return commands.pause();
    if (status === "paused") return commands.resume();
    return commands.start();
  },

  submitTask: async (input: CreateTaskInput): Promise<Task | null> => {
    try {
      const task = await getBackend().submitTask(input);
      // A submitted task should move; from `ready` start the clock (a paused world stays paused).
      if (useWorldStore.getState().simStatus === "ready") await commands.start();
      return task;
    } catch (err) {
      reportError(err);
      return null;
    }
  },

  /** Staggered so the feed and the cards read as a sequence rather than one blob. */
  submitTasks: async (inputs: readonly CreateTaskInput[], gapMs = 220): Promise<Task[]> => {
    const out: Task[] = [];
    for (let i = 0; i < inputs.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
      const t = await commands.submitTask(inputs[i]!);
      if (!t) break;
      out.push(t);
    }
    return out;
  },

  /** Run demo: the scripted JWT task, running (resumes if paused). */
  runDemo: async (): Promise<Task | null> => {
    await ensureRunning();
    const task = await commands.submitTask(DEMO_TASK);
    if (task) {
      useWorldStore.getState().selectTask(task.id, { tab: false });
      useWorldStore.getState().requestCamera({ preset: "overview" });
    }
    return task;
  },

  /** Load sprint (B): the 8 sprint tasks, resuming if paused. */
  loadSprint: async (): Promise<Task[]> => {
    await ensureRunning();
    return commands.submitTasks(SPRINT_TASKS);
  },

  /** Called whenever sceneReady/autoStart/status change; starts the world once per page load. */
  autoStartIfReady: async (): Promise<void> => {
    const st = useWorldStore.getState();
    if (autoStarted || !st.sceneReady || !st.autoStart || !st.backend.identified || st.backend.connection !== "open") return;
    autoStarted = true;
    if (st.simStatus === "ready") await commands.start();
  },
};
