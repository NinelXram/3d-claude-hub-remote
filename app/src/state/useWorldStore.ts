import { create } from "zustand";
import type { AgentId, AgentState } from "@/agents/agentTypes";
import type { AudioState, SoundMode, SoundSettings } from "@/audio/soundEngine";
import { SOUND_STORAGE_KEY, defaultSoundSettings, parseSoundSettings, serializeSoundSettings } from "@/audio/soundEngine";
import type { AgentEvent } from "@/events/eventTypes";
import { appendEvent } from "@/events/eventStore";
import type { CommLink, LiveWorldState, SimulationStatus, WorldSnapshot } from "@/integrations/AgentBackend";
import type { ConnectionState } from "@/integrations/WebSocketAgentBackend";
import { SIM_CONFIG } from "@/simulation/simulationConfig";
import type { Task } from "@/tasks/taskTypes";

// ───────────────────────── liveWorld: the per-frame buffer ─────────────────────────

/**
 * Mutable, written on every snapshot (30 Hz with the mock backend). The 3D layer reads it inside
 * `useFrame`; nothing in React subscribes to it, so writing it never causes a render.
 */
export const liveWorld: {
  snapshot: WorldSnapshot | null;
  /** `performance.now()` when the snapshot arrived; lets the 3D layer extrapolate between 10 Hz network snapshots. */
  receivedAt: number;
  /** Bumped on every write. */
  version: number;
} = { snapshot: null, receivedAt: 0, version: 0 };

// ───────────────────────── mirror types ─────────────────────────

export type PanelTab = "overview" | "agents" | "tasks" | "activity" | "sessions" | "settings";
export type Quality = "high" | "low";
export type QualitySource = "auto" | "user" | "url" | "fallback";
export type CameraPresetId = "overview" | "hub" | "development" | "research" | "collaboration";

export interface CameraRequest {
  nonce: number;
  preset?: CameraPresetId;
  focus?: { x: number; y: number; z: number };
  distance?: number;
}

export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type { SoundSettings } from "@/audio/soundEngine";

export interface BackendInfo {
  kind: "mock" | "websocket" | "live";
  label: string;
  simulated: boolean;
  connection: ConnectionState;
  error: string | null;
  /** True once the backend has said who it is (always for mock; after `welcome` for websocket). */
  identified: boolean;
}

export interface Notice {
  id: number;
  text: string;
  tone: "info" | "error";
}

export interface WorldState {
  // mirror of the backend (throttled)
  simStatus: SimulationStatus;
  speed: number;
  clock: number;
  agents: AgentState[];
  tasks: Task[];
  links: CommLink[];
  /**
   * Live Claude Code sources: the focused session and the recent sessions (null otherwise). The same object is
   * kept while nothing in it changes, so the session switcher does not re-render with progress.
   */
  live: LiveWorldState | null;
  /** Every event received, newest last, capped at FEED_CAP. Selectors in events/eventStore filter it. */
  events: AgentEvent[];
  backend: BackendInfo;

  // UI state
  tab: PanelTab;
  selectedAgentId: AgentId | null;
  selectedTaskId: string | null;
  hovered: string | null;
  followAgentId: AgentId | null;
  dialog: { open: boolean; preferredAgentId: AgentId | null };
  quality: Quality;
  qualitySource: QualitySource;
  /** `prefers-reduced-motion: reduce`, kept live by AppShell. The 3D layer damps decorative motion with it. */
  reducedMotion: boolean;
  overlays: { paths: boolean; speech: boolean };
  /** Settings of the current sound mode (simulation or live mirror); each mode is saved separately. */
  sound: SoundSettings;
  soundMode: SoundMode;
  /** The AudioContext's state: "none" until the first click or key press creates it. */
  audioState: AudioState;
  /** Desktop notification when Claude needs you and the tab is hidden (live mirror only). */
  desktopAlerts: boolean;
  sceneReady: boolean;
  autoStart: boolean;
  camera: CameraRequest;
  viewInsets: ViewInsets;
  notice: Notice | null;

  // actions
  applySnapshot: (s: WorldSnapshot) => void;
  pushEvents: (events: AgentEvent[]) => void;
  setBackend: (patch: Partial<BackendInfo>) => void;
  setTab: (tab: PanelTab) => void;
  selectAgent: (id: AgentId | null, options?: { tab?: boolean }) => void;
  selectTask: (id: string | null, options?: { tab?: boolean }) => void;
  clearSelection: () => void;
  setHovered: (key: string | null) => void;
  setFollow: (id: AgentId | null) => void;
  openDialog: (preferredAgentId?: AgentId | null) => void;
  closeDialog: () => void;
  setQuality: (quality: Quality, source: QualitySource) => void;
  setReducedMotion: (reduced: boolean) => void;
  setOverlays: (patch: Partial<WorldState["overlays"]>) => void;
  setSound: (patch: Partial<SoundSettings>) => void;
  setSoundMode: (mode: SoundMode) => void;
  setAudioState: (state: AudioState) => void;
  setDesktopAlerts: (on: boolean) => void;
  setSceneReady: (ready: boolean) => void;
  requestCamera: (request: Omit<CameraRequest, "nonce">) => void;
  setViewInsets: (insets: ViewInsets) => void;
  notify: (text: string, tone?: Notice["tone"]) => void;
  dismissNotice: () => void;
}

export const FEED_CAP = 500;
/** Minimum gap between mirror updates when nothing significant changed (§2, pitfall 7). */
export const MIRROR_THROTTLE_MS = 160;
const NOTIFY_KEY = "aaw.notify";

// ───────────────────────── snapshot throttling ─────────────────────────

/** Changes here push the mirror immediately: status, speed, and the discrete parts of agents/tasks. */
function significantSignature(s: WorldSnapshot): string {
  let sig = `${s.status}|${s.speed}|`;
  for (const a of s.agents) sig += `${a.id}:${a.status}:${a.paused ? 1 : 0}:${a.currentTaskId ?? ""}:${a.location ?? ""}:${a.destination ?? ""}:${a.activity};`;
  sig += "|";
  for (const t of s.tasks) {
    const done = t.subtasks.reduce((n, st) => n + (st.done ? 1 : 0), 0);
    sig += `${t.id}:${t.phase}:${t.status}:${t.assignedAgentId ?? ""}:${t.iteration}:${t.subtasks.length}/${done}:${t.findings.length};`;
  }
  sig += "|";
  for (const l of s.links) sig += `${l.id};`;
  return `${sig}|${liveSignature(s.live)}`;
}

function liveSignature(live: LiveWorldState | undefined): string {
  if (!live) return "";
  let sig = `${live.focus.mode}:${live.focus.sessionId ?? ""}|`;
  for (const x of live.sessions) sig += `${x.sessionId}:${x.status}:${x.title}:${x.project}:${x.lastActivity};`;
  return sig;
}

let lastLive: { sig: string; value: LiveWorldState | null } = { sig: "", value: null };

function liveOf(s: WorldSnapshot): LiveWorldState | null {
  const sig = liveSignature(s.live);
  if (sig !== lastLive.sig) lastLive = { sig, value: s.live ?? null };
  return lastLive.value;
}

/**
 * Continuous values the HTML UI shows (progress bars, relative times). Throttled to MIRROR_THROTTLE_MS.
 * Positions, headings and paths are deliberately absent: walking alone never re-renders React.
 */
function minorSignature(s: WorldSnapshot): string {
  let sig = `${Math.floor(s.clock)}|`;
  for (const a of s.agents) sig += `${Math.round(a.progress * 100)};`;
  for (const t of s.tasks) sig += `${Math.round(t.progress * 200)};`;
  return sig;
}

let lastSignificant = "";
let lastMinor = "";
let lastMirrorAt = -Infinity;
let trailing: ReturnType<typeof setTimeout> | null = null;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function mirrorOf(s: WorldSnapshot): Pick<WorldState, "simStatus" | "speed" | "clock" | "agents" | "tasks" | "links" | "live"> {
  return { simStatus: s.status, speed: s.speed, clock: s.clock, agents: s.agents, tasks: s.tasks, links: s.links, live: liveOf(s) };
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode or blocked storage: settings just do not persist
  }
}

// Mirrors backendClient's choice so the very first render already tells the truth about the mode.
const INITIAL_BACKEND: BackendInfo =
  process.env.NEXT_PUBLIC_AGENT_BACKEND === "websocket"
    ? { kind: "websocket", label: "WebSocket backend", simulated: false, connection: "connecting", error: null, identified: false }
    : { kind: "mock", label: "Local simulation", simulated: true, connection: "open", error: null, identified: true };

let noticeSeq = 0;
let noticeTimer: ReturnType<typeof setTimeout> | null = null;

export const useWorldStore = create<WorldState>()((set, get) => ({
  simStatus: "ready",
  speed: SIM_CONFIG.defaultSpeed,
  clock: 0,
  agents: [],
  tasks: [],
  links: [],
  live: null,
  events: [],
  backend: INITIAL_BACKEND,

  tab: "overview",
  selectedAgentId: null,
  selectedTaskId: null,
  hovered: null,
  followAgentId: null,
  dialog: { open: false, preferredAgentId: null },
  quality: "high",
  qualitySource: "auto",
  reducedMotion: false,
  overlays: { paths: true, speech: true },
  sound: defaultSoundSettings("simulation"),
  soundMode: "simulation",
  audioState: "none",
  desktopAlerts: false,
  sceneReady: false,
  autoStart: SIM_CONFIG.autoStart,
  camera: { nonce: 0, preset: "overview" },
  viewInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  notice: null,

  applySnapshot: (s) => {
    liveWorld.snapshot = s;
    liveWorld.receivedAt = now();
    liveWorld.version++;

    const significant = significantSignature(s);
    const minor = minorSignature(s);
    if (significant !== lastSignificant) {
      lastSignificant = significant;
      lastMinor = minor;
      lastMirrorAt = now();
      if (trailing) clearTimeout(trailing);
      trailing = null;
      set(mirrorOf(s));
      return;
    }
    if (minor === lastMinor) return; // only positions moved
    const wait = MIRROR_THROTTLE_MS - (now() - lastMirrorAt);
    if (wait <= 0) {
      lastMinor = minor;
      lastMirrorAt = now();
      set(mirrorOf(s));
      return;
    }
    // Trailing flush so the last value before a quiet spell (e.g. a pause) is never lost.
    if (!trailing) {
      trailing = setTimeout(() => {
        trailing = null;
        const latest = liveWorld.snapshot;
        if (!latest) return;
        lastMinor = minorSignature(latest);
        lastSignificant = significantSignature(latest);
        lastMirrorAt = now();
        set(mirrorOf(latest));
      }, wait);
    }
  },

  pushEvents: (incoming) => {
    if (incoming.length === 0) return;
    let events = get().events;
    let cleared = false;
    for (const e of incoming) {
      if (e.type === "system.reset") {
        // Ids restart after a reset; the old log no longer describes this world.
        events = [];
        cleared = true;
      }
      events = appendEvent(events, e, FEED_CAP);
    }
    if (cleared) set({ events, selectedTaskId: null, selectedAgentId: null, followAgentId: null });
    else set({ events });
  },

  setBackend: (patch) => set((st) => ({ backend: { ...st.backend, ...patch } })),

  setTab: (tab) => set({ tab }),

  selectAgent: (id, options) => {
    set((st) => ({ selectedAgentId: id, tab: options?.tab === false ? st.tab : id ? "agents" : st.tab }));
    if (id) {
      const a = liveWorld.snapshot?.agents.find((x) => x.id === id);
      if (a) get().requestCamera({ focus: { x: a.position.x, y: 1, z: a.position.z }, distance: 7.5 });
    }
  },

  selectTask: (id, options) => set((st) => ({ selectedTaskId: id, tab: options?.tab === false ? st.tab : id ? "tasks" : st.tab })),

  clearSelection: () => set({ selectedAgentId: null, selectedTaskId: null, followAgentId: null }),

  setHovered: (hovered) => set({ hovered }),

  setFollow: (followAgentId) => set({ followAgentId }),

  openDialog: (preferredAgentId = null) => set({ dialog: { open: true, preferredAgentId } }),

  closeDialog: () => set({ dialog: { open: false, preferredAgentId: null } }),

  setQuality: (quality, qualitySource) => set({ quality, qualitySource }),

  setReducedMotion: (reducedMotion) => set({ reducedMotion }),

  setOverlays: (patch) => set((st) => ({ overlays: { ...st.overlays, ...patch } })),

  setSound: (patch) => {
    const { sound: cur, soundMode } = get();
    const sound = { ...cur, ...patch };
    writeStorage(SOUND_STORAGE_KEY, serializeSoundSettings(readStorage(SOUND_STORAGE_KEY), soundMode, sound));
    set({ sound });
  },

  setSoundMode: (soundMode) => set({ soundMode, sound: parseSoundSettings(readStorage(SOUND_STORAGE_KEY), soundMode) }),

  setAudioState: (audioState) => set({ audioState }),

  setDesktopAlerts: (desktopAlerts) => {
    writeStorage(NOTIFY_KEY, desktopAlerts ? "1" : "0");
    set({ desktopAlerts });
  },

  setSceneReady: (sceneReady) => set({ sceneReady }),

  requestCamera: (request) => set((st) => ({ camera: { ...request, nonce: st.camera.nonce + 1 } })),

  setViewInsets: (insets) => {
    const cur = get().viewInsets;
    if (cur.top === insets.top && cur.right === insets.right && cur.bottom === insets.bottom && cur.left === insets.left) return;
    set({ viewInsets: insets });
  },

  notify: (text, tone = "info") => {
    if (noticeTimer) clearTimeout(noticeTimer);
    set({ notice: { id: ++noticeSeq, text, tone } });
    noticeTimer = setTimeout(() => set({ notice: null }), tone === "error" ? 6000 : 3500);
  },

  dismissNotice: () => set({ notice: null }),
}));

/** Reads persisted sound and notification settings into the store. Called once on mount (localStorage is client-only). */
export function hydrateSoundSettings(): void {
  const { soundMode } = useWorldStore.getState();
  const granted = typeof Notification !== "undefined" && Notification.permission === "granted";
  useWorldStore.setState({
    sound: parseSoundSettings(readStorage(SOUND_STORAGE_KEY), soundMode),
    desktopAlerts: granted && readStorage(NOTIFY_KEY) === "1",
  });
}
