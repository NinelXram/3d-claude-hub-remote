import { useSessionStore } from "../state/useSessionStore.ts";
import type { PromptImage, SessionFileInfo, SessionInfo, SessionItem, SessionPermissionMode } from "./AgentBackend.ts";
import type { WebSocketAgentBackend } from "./WebSocketAgentBackend.ts";

// The sessions extension (live Claude Code servers started with --control): wiring into useSessionStore and
// the commands the Sessions tab, the permission cards and TaskDetails use. Components never call the backend.

let socket: WebSocketAgentBackend | null = null;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Subscribes the session store to a WebSocket backend. Call before `connect()` so the replay maps tasks. */
export function wireSessions(b: WebSocketAgentBackend): () => void {
  socket = b;
  const store = useSessionStore;

  const offMessages = b.subscribeMessage((m) => {
    const st = store.getState();
    switch (m.type) {
      case "sessions":
        st.setSessions(m.sessions);
        break;
      case "sessionItems":
        st.upsertItems(m.sessionId, m.items);
        break;
      case "permission":
        st.addPermission(m.request);
        break;
      case "permissionResolved":
        st.resolvePermission(m.requestId);
        break;
      case "sessionMoved":
        // /clear (or /reset, /new) restarted a web session under a new id: follow it if it is on screen.
        if (st.openId === m.from) {
          st.setOpen(m.to);
          void loadSession(m.to, true);
        }
        break;
    }
  });

  const offConnection = b.subscribeConnection(({ state }) => {
    if (state !== "open") return;
    // `welcome` was just handled: capabilities are known, and the server is about to re-send the session list
    // and every ask still pending, so whatever we held from before a drop is stale.
    store.getState().setCapabilities(b.capabilities);
    store.getState().clearPermissions();
    // The server forgets subscriptions when a socket drops: re-open the session on screen.
    const openId = store.getState().openId;
    if (openId && b.capabilities.sessions) void loadSession(openId, false);
  });

  const offEvents = b.subscribe((e) => {
    if (e.type === "system.reset") store.getState().clearTaskSessions();
    const session = e.metadata?.["session"];
    if (e.type === "task.created" && e.taskId && typeof session === "string") store.getState().mapTask(e.taskId, session);
  });

  return () => {
    offMessages();
    offConnection();
    offEvents();
  };
}

function backend(): WebSocketAgentBackend {
  if (!socket) throw new Error("Sessions need a live WebSocket backend.");
  return socket;
}

interface OpenAck {
  session: SessionInfo;
  items: SessionItem[];
  /** Older items not sent (servers before paging omit it). */
  earlier?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Subscribes to a session and loads its items. A session that was just started may not have a transcript on
 * disk yet; with `retry` it is tried again for a while (its items also stream in meanwhile, because the server
 * subscribes the connection that started it).
 */
async function loadSession(sessionId: string, retry: boolean): Promise<void> {
  const st = useSessionStore.getState;
  for (let attempt = 0; ; attempt++) {
    if (st().openId !== sessionId) return;
    try {
      const ack = await backend().request<OpenAck>({ name: "openSession", sessionId });
      if (st().openId !== sessionId) {
        void backend().request({ name: "closeSession", sessionId }).catch(() => {});
        return;
      }
      st().setOpenError(null);
      st().upsertItems(sessionId, ack.items);
      st().setEarlier(sessionId, ack.earlier ?? 0);
      return;
    } catch (err) {
      if (st().openId !== sessionId) return;
      const message = errorText(err);
      const notYet = /not available yet/i.test(message);
      if (!retry || !notYet || attempt >= 40) {
        st().setOpenError(message);
        return;
      }
      st().setOpenError(null);
      await sleep(1500);
    }
  }
}

export interface SendResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  forked?: boolean;
}

/** Images already fetched, as data URLs, keyed by session and image id; the oldest are dropped past the limit. */
const imageCache = new Map<string, Promise<string>>();
const IMAGE_CACHE_LIMIT = 80;

export const sessionCommands = {
  /** Load the page of items before the oldest one shown. */
  loadEarlier: async (sessionId: string): Promise<string | null> => {
    const st = useSessionStore.getState();
    const first = st.items[0];
    if (st.openId !== sessionId || !first) return null;
    try {
      const r = await backend().request<{ items: SessionItem[]; earlier: number }>({ name: "sessionHistory", sessionId, before: first.id, limit: 150 });
      useSessionStore.getState().prependItems(sessionId, r.items, r.earlier);
      return null;
    } catch (err) {
      return errorText(err);
    }
  },

  /** Show a session in the chat view and stream its items. */
  open: async (sessionId: string, options: { retry?: boolean } = {}): Promise<void> => {
    const prev = useSessionStore.getState().openId;
    if (prev === sessionId) return;
    if (prev) void backend().request({ name: "closeSession", sessionId: prev }).catch(() => {});
    useSessionStore.getState().setOpen(sessionId);
    await loadSession(sessionId, options.retry ?? false);
  },

  /** Back to the list; the server stops streaming this session to us. */
  close: (): void => {
    const prev = useSessionStore.getState().openId;
    if (!prev) return;
    useSessionStore.getState().setOpen(null);
    if (socket) void socket.request({ name: "closeSession", sessionId: prev }).catch(() => {});
  },

  /**
   * Continue a session. A session still open in a terminal is continued in a fork (a new session id), which
   * is then opened in place of the original.
   */
  send: async (sessionId: string, text: string, permissionMode?: SessionPermissionMode, images: PromptImage[] = []): Promise<SendResult> => {
    try {
      const ack = await backend().request<{ sessionId: string; forked: boolean }>({
        name: "sendPrompt", sessionId, text, ...(images.length > 0 ? { images } : {}), ...(permissionMode ? { permissionMode } : {}),
      });
      if (ack.sessionId !== sessionId) void sessionCommands.open(ack.sessionId, { retry: true });
      return { ok: true, sessionId: ack.sessionId, forked: ack.forked };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  },

  /** Start a new session in `cwd` (an absolute path on the server's machine) and open it. */
  /** Change how a running web session handles permission asks; returns an error message or null. */
  setMode: async (sessionId: string, mode: SessionPermissionMode): Promise<string | null> => {
    try {
      await backend().request({ name: "setPermissionMode", sessionId, mode });
      return null;
    } catch (err) {
      return errorText(err);
    }
  },

  start: async (cwd: string, text: string, permissionMode?: SessionPermissionMode, images: PromptImage[] = []): Promise<SendResult> => {
    try {
      const ack = await backend().request<{ sessionId: string; forked: boolean }>({
        name: "sendPrompt", cwd, text, ...(images.length > 0 ? { images } : {}), ...(permissionMode ? { permissionMode } : {}),
      });
      void sessionCommands.open(ack.sessionId, { retry: true });
      return { ok: true, sessionId: ack.sessionId, forked: ack.forked };
    } catch (err) {
      return { ok: false, error: errorText(err) };
    }
  },

  respondPermission: async (requestId: string, allow: boolean): Promise<string | null> => {
    try {
      await backend().request({ name: "respondPermission", requestId, allow });
      // The broadcast `permissionResolved` removes it too; this keeps the card from lingering if it is missed.
      useSessionStore.getState().resolvePermission(requestId);
      return null;
    } catch (err) {
      const message = errorText(err);
      // Already answered elsewhere, or Claude gave up on it: nothing left to answer.
      if (/no longer pending/i.test(message)) useSessionStore.getState().resolvePermission(requestId);
      return message;
    }
  },

  /** Take a finished session off the list (the server keeps its transcript); returns an error message or null. */
  remove: async (sessionId: string): Promise<string | null> => {
    try {
      await backend().request({ name: "removeSession", sessionId });
      // The server broadcasts the new list too; this keeps the row from lingering if that is missed.
      const st = useSessionStore.getState();
      st.setSessions(st.sessions.filter((s) => s.sessionId !== sessionId));
      return null;
    } catch (err) {
      const message = errorText(err);
      // Servers from before this command do not know it.
      return /unknown command/i.test(message) ? "This server cannot remove sessions yet. Restart it to update." : message;
    }
  },

  /**
   * An image of the open session as a data URL (fetched once, then cached). Rejects with the server's message
   * when it cannot be had, e.g. a server from before images.
   */
  image: (sessionId: string, imageId: string): Promise<string> => {
    const key = `${sessionId}|${imageId}`;
    const hit = imageCache.get(key);
    if (hit) {
      imageCache.delete(key);
      imageCache.set(key, hit);
      return hit;
    }
    const p = backend()
      .request<{ mediaType: string; data: string }>({ name: "sessionImage", sessionId, imageId })
      .then((r) => {
        if (!/^image\/(png|jpeg|gif|webp)$/.test(r.mediaType)) throw new Error(`Unsupported image type ${r.mediaType}`);
        return `data:${r.mediaType};base64,${r.data}`;
      })
      .catch((err: unknown) => {
        imageCache.delete(key);
        const message = errorText(err);
        throw new Error(/unknown command/i.test(message) ? "This server cannot show images yet. Restart it to update." : message);
      });
    imageCache.set(key, p);
    while (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value!);
    return p;
  },

  /**
   * A video from the session's folder that Claude mentioned: the server checks the path and hands back a short-lived
   * URL the <video> element can stream from. Rejects with the server's reason (e.g. outside the folder).
   */
  video: async (sessionId: string, path: string): Promise<{ src: string; name: string; mediaType: string; size: number }> => {
    try {
      const r = await backend().request<SessionFileInfo>({ name: "sessionFile", sessionId, path });
      return { src: backend().httpOrigin + r.url, name: r.name, mediaType: r.mediaType, size: r.size };
    } catch (err) {
      const message = errorText(err);
      throw new Error(/unknown command/i.test(message) ? "This server cannot play videos yet. Restart it to update." : message);
    }
  },

  interrupt: async (sessionId: string): Promise<string | null> => {
    try {
      await backend().request({ name: "interruptSession", sessionId });
      return null;
    } catch (err) {
      return errorText(err);
    }
  },
};
