import { create } from "zustand";
import type { PermissionRequestInfo, ServerCapabilities, SessionInfo, SessionItem } from "../integrations/AgentBackend.ts";

/**
 * The sessions extension (live Claude Code servers only): the session list, the open session's transcript,
 * pending permission asks and which world task belongs to which session.
 *
 * Kept apart from useWorldStore on purpose: transcript items can stream in quickly, and nothing in the 3D layer
 * (or anything it renders) subscribes here, so none of this can cause a render in a `useFrame` path.
 * Node-safe (relative `.ts` imports) so scripts/sessions-test.ts can drive it.
 */
export interface SessionState {
  capabilities: ServerCapabilities;
  /** Newest activity first, as the server sorts it. */
  sessions: SessionInfo[];
  /** The session shown in the chat view (null: the list). */
  openId: string | null;
  /** Items of the open session, in arrival order; upserted by id. */
  items: SessionItem[];
  /** How many older items of the open session have not been loaded yet. */
  earlier: number;
  /** The open session's transcript could not be opened yet (e.g. a brand-new session). */
  openError: string | null;
  /** Pending permission asks, oldest first. */
  permissions: PermissionRequestInfo[];
  /** World task id → Claude Code session id, from `task.created` metadata.session. */
  taskSessions: Record<string, string>;

  setCapabilities: (c: ServerCapabilities) => void;
  setSessions: (s: SessionInfo[]) => void;
  setOpen: (id: string | null) => void;
  /** Upserts items into the open session (ignored for any other session). */
  upsertItems: (sessionId: string, items: SessionItem[]) => void;
  /** Older items for the open session, placed before what is shown. */
  prependItems: (sessionId: string, items: SessionItem[], earlier: number) => void;
  setEarlier: (sessionId: string, earlier: number) => void;
  setOpenError: (e: string | null) => void;
  addPermission: (p: PermissionRequestInfo) => void;
  resolvePermission: (requestId: string) => void;
  clearPermissions: () => void;
  mapTask: (taskId: string, sessionId: string) => void;
  clearTaskSessions: () => void;
}

/** Pure upsert by id: replaced in place, new ones appended. Returns the same array when nothing changed. */
export function upsertById(cur: readonly SessionItem[], incoming: readonly SessionItem[]): SessionItem[] {
  if (incoming.length === 0) return cur as SessionItem[];
  const out = [...cur];
  const index = new Map<string, number>();
  out.forEach((it, i) => index.set(it.id, i));
  for (const it of incoming) {
    const at = index.get(it.id);
    if (at === undefined) {
      index.set(it.id, out.length);
      out.push(it);
    } else out[at] = it;
  }
  return out;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  capabilities: { sessions: false, control: false },
  sessions: [],
  openId: null,
  items: [],
  earlier: 0,
  openError: null,
  permissions: [],
  taskSessions: {},

  setCapabilities: (capabilities) => {
    const cur = get().capabilities;
    if (JSON.stringify(cur) !== JSON.stringify(capabilities)) set({ capabilities });
  },
  setSessions: (sessions) => set({ sessions }),
  setOpen: (openId) => set({ openId, items: [], earlier: 0, openError: null }),
  prependItems: (sessionId, items, earlier) => {
    if (sessionId !== get().openId) return;
    set((st) => {
      const known = new Set(st.items.map((i) => i.id));
      return { items: [...items.filter((i) => !known.has(i.id)), ...st.items], earlier };
    });
  },
  setEarlier: (sessionId, earlier) => {
    if (sessionId === get().openId) set({ earlier });
  },
  upsertItems: (sessionId, items) => {
    if (sessionId !== get().openId) return;
    set((st) => ({ items: upsertById(st.items, items) }));
  },
  setOpenError: (openError) => set({ openError }),
  addPermission: (p) =>
    set((st) => ({ permissions: st.permissions.some((x) => x.requestId === p.requestId) ? st.permissions : [...st.permissions, p] })),
  resolvePermission: (requestId) =>
    set((st) => (st.permissions.some((x) => x.requestId === requestId) ? { permissions: st.permissions.filter((x) => x.requestId !== requestId) } : st)),
  clearPermissions: () => set((st) => (st.permissions.length ? { permissions: [] } : st)),
  mapTask: (taskId, sessionId) => set((st) => (st.taskSessions[taskId] === sessionId ? st : { taskSessions: { ...st.taskSessions, [taskId]: sessionId } })),
  clearTaskSessions: () => set({ taskSessions: {} }),
}));
