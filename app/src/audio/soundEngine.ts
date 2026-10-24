// Procedural Web Audio cues (§8). No sound files: every cue is synthesised.
// Ported from the prompt repo's tested viewer engine (examples/phase1-engine/viewer/soundEngine.ts).
// `cueFor`, `throttleKey`, `isStale` and the settings helpers are pure, so `scripts/sound-test.ts`
// runs them in Node; `SoundEngine` itself only does anything in a browser, after a user gesture.
// Node-safe: relative `.ts` type imports only, no React/three/Next.
import type { AgentId } from "../agents/agentTypes.ts";
import type { AgentEvent } from "../events/eventTypes.ts";

export type Cue =
  | "created" | "ping" | "arpeggio" | "research" | "keys" | "whoosh" | "chime" | "buzz"
  | "fanfare" | "thud" | "blipsDown" | "blipsUp" | "rise" | "fall" | "sweepDown" | "footstep" | "attention";

/**
 * `simulation`: every step of the story has a cue. `live`: a real backend (e.g. the Claude Code mirror),
 * where only what is worth interrupting you for makes a sound.
 */
export type SoundMode = "simulation" | "live";

export interface SoundSettings {
  enabled: boolean;
  volume: number;
  ambient: boolean;
}

/** Each speaker's own pitch (Hz), so you can tell who is talking without looking. */
export const AGENT_PITCH: Record<AgentId, number> = { orion: 523.25, piper: 659.25, iris: 587.33, kai: 440, quinn: 698.46, rex: 392 };

/** Events older than this (history replayed on connect) never make a sound or raise attention. */
export const STALE_EVENT_MS = 15_000;

export function isStale(e: AgentEvent, nowMs: number): boolean {
  return nowMs - e.timestamp > STALE_EVENT_MS;
}

/** Orion's warning that Claude Code is blocked on the human (permission prompt or idle input). */
export function isWaitingForYou(e: AgentEvent): boolean {
  return e.agentId === "orion" && e.severity === "warning" && /^(Needs your permission|Claude Code needs you)/.test(e.message);
}

/**
 * Which cue an event plays, or null for silence.
 * Live mode keeps only what is worth interrupting you for: test results, the end of a turn, and Claude waiting on you.
 */
export function cueFor(e: AgentEvent, mode: SoundMode): Cue | null {
  if (mode === "live") {
    if (isWaitingForYou(e)) return "attention";
    switch (e.type) {
      case "qa.passed": return "chime";
      case "qa.failed": return "buzz";
      case "task.completed": return "fanfare";
      case "task.failed": return "thud";
      default: return null;
    }
  }
  switch (e.type) {
    case "task.created": return "created";
    case "task.assigned":
    case "agent.message": return "ping";
    case "plan.created": return "arpeggio";
    case "research.completed": return "research";
    case "implementation.started": return "keys";
    case "implementation.submitted": return "whoosh";
    case "qa.passed":
    case "review.approved": return "chime";
    case "qa.failed":
    case "review.changes_requested": return "buzz";
    case "task.completed": return "fanfare";
    case "task.failed": return "thud";
    case "task.blocked":
    case "agent.paused": return "blipsDown";
    case "task.unblocked":
    case "agent.resumed": return "blipsUp";
    case "system.started":
    case "system.resumed": return "rise";
    case "system.paused": return "fall";
    case "system.reset": return "sweepDown";
    case "agent.arrived": return e.metadata?.["withTask"] === true ? "footstep" : null;
    default: return null; // agent.ambient and bookkeeping events are silent
  }
}

/** Throttle key: per type, and per speaker for messages so two agents can talk over each other. */
export function throttleKey(e: AgentEvent): { key: string; ms: number } {
  if (e.type === "agent.arrived") return { key: e.type, ms: 160 };
  if (e.type === "agent.message" || e.type === "task.assigned") return { key: `${e.type}:${e.agentId ?? ""}`, ms: 120 };
  return { key: e.type, ms: 120 };
}

// ───────────────────────── persisted settings (localStorage `aaw.sound.v1`) ─────────────────────────

export const SOUND_STORAGE_KEY = "aaw.sound.v1";

/** The live mirror is quiet by default: no hum under a real working session. */
export function defaultSoundSettings(mode: SoundMode): SoundSettings {
  return { enabled: true, volume: 0.6, ambient: mode === "simulation" };
}

function sanitize(raw: unknown, mode: SoundMode): SoundSettings {
  const d = defaultSoundSettings(mode);
  if (!raw || typeof raw !== "object") return d;
  const p = raw as Partial<Record<keyof SoundSettings, unknown>>;
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : d.enabled,
    volume: typeof p.volume === "number" && Number.isFinite(p.volume) ? Math.min(1, Math.max(0, p.volume)) : d.volume,
    ambient: typeof p.ambient === "boolean" ? p.ambient : d.ambient,
  };
}

/**
 * Reads one mode's settings from the stored JSON. The value is `{ simulation: {...}, live: {...} }`;
 * a flat `{enabled, volume, ambient}` (written before modes existed) counts as the simulation settings.
 */
export function parseSoundSettings(json: string | null, mode: SoundMode): SoundSettings {
  if (!json) return defaultSoundSettings(mode);
  try {
    const all = JSON.parse(json) as Record<string, unknown> | null;
    if (!all || typeof all !== "object") return defaultSoundSettings(mode);
    const legacy = "enabled" in all || "volume" in all || "ambient" in all;
    if (legacy) return mode === "simulation" ? sanitize(all, mode) : defaultSoundSettings(mode);
    return sanitize(all[mode], mode);
  } catch {
    return defaultSoundSettings(mode);
  }
}

/** Returns the new stored JSON with `mode` replaced and the other mode kept. */
export function serializeSoundSettings(json: string | null, mode: SoundMode, settings: SoundSettings): string {
  const other: SoundMode = mode === "simulation" ? "live" : "simulation";
  return JSON.stringify({ [other]: parseSoundSettings(json, other), [mode]: sanitize(settings, mode) });
}

// ───────────────────────── engine ─────────────────────────

/** How long after an unlock gesture a still-resuming context accepts cues. */
const UNLOCK_GRACE_MS = 1000;

export type AudioState = "none" | "suspended" | "running" | "closed";

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last = new Map<string, number>();
  private ambient: { gain: GainNode; stop: () => void } | null = null;
  private running = false;
  private stateListener: ((s: AudioState) => void) | null = null;
  /** `performance.now()` of the last unlock gesture. */
  private unlockedAt = -Infinity;
  mode: SoundMode = "simulation";
  settings: SoundSettings = defaultSoundSettings("simulation");
  /** Cues actually sounded (for automated checks; no effect on playback). */
  played = 0;
  onPlayed: ((count: number, cue: Cue) => void) | null = null;
  /** Called when the ambient bed starts or stops (for automated checks). */
  onAmbient: ((on: boolean) => void) | null = null;

  get state(): AudioState {
    return this.ctx ? (this.ctx.state as AudioState) : "none";
  }

  get unlocked(): boolean {
    return this.ctx?.state === "running";
  }

  onStateChange(listener: ((s: AudioState) => void) | null): void {
    this.stateListener = listener;
  }

  /** Must run inside a user gesture (pointerdown/keydown). Before this, play() is a silent no-op. */
  unlock(): void {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      this.master = ctx.createGain();
      this.master.gain.value = this.settings.enabled ? this.settings.volume : 0;
      this.master.connect(comp).connect(ctx.destination);
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      ctx.addEventListener("statechange", () => {
        this.stateListener?.(this.state);
        this.syncAmbient();
      });
      this.stateListener?.(this.state);
    }
    this.unlockedAt = performance.now();
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
    this.syncAmbient();
  }

  setMode(mode: SoundMode): void {
    this.mode = mode;
  }

  configure(settings: SoundSettings): void {
    this.settings = settings;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(settings.enabled ? settings.volume : 0, this.ctx.currentTime, 0.02);
    this.syncAmbient();
  }

  setRunning(running: boolean): void {
    if (running === this.running) return;
    this.running = running;
    this.syncAmbient();
  }

  /**
   * Ready for cues: running, or still resuming from the gesture that just unlocked it. A context created in a
   * click handler reports "suspended" for a moment; without the grace window the cue that click caused
   * (Run demo → task.created) would be lost. Nodes scheduled meanwhile play the instant it resumes.
   */
  private get audible(): boolean {
    const state = this.ctx?.state;
    return state === "running" || (state === "suspended" && performance.now() - this.unlockedAt < UNLOCK_GRACE_MS);
  }

  play(e: AgentEvent): void {
    if (!this.settings.enabled || !this.audible) return;
    const cue = cueFor(e, this.mode);
    if (!cue) return;
    const { key, ms } = throttleKey(e);
    const now = performance.now();
    if (now - (this.last.get(key) ?? -Infinity) < ms) return;
    this.last.set(key, now);
    this.sound(cue, e.agentId ? AGENT_PITCH[e.agentId] : 523.25);
    this.played++;
    this.onPlayed?.(this.played, cue);
  }

  // ───────────────────────── synthesis ─────────────────────────

  private sound(cue: Cue, pitch: number): void {
    const t = this.ctx!.currentTime + 0.01;
    switch (cue) {
      case "created": this.tone("sine", 880, 880, t, 0.09, 0.18); this.tone("sine", 1174.66, 1174.66, t + 0.1, 0.11, 0.18); break;
      case "ping": this.tone("triangle", pitch, pitch, t, 0.12, 0.2); this.tone("triangle", pitch * 1.5, pitch * 1.5, t + 0.1, 0.16, 0.16); break;
      case "arpeggio": [1, 1.25, 1.5].forEach((r, i) => this.tone("triangle", pitch * r, pitch * r, t + i * 0.07, 0.12, 0.18)); break;
      case "research": this.noiseSweep("bandpass", 600, 3200, t, 0.35, 0.12); this.tone("sine", pitch, pitch * 1.5, t, 0.3, 0.1); break;
      case "keys": for (let i = 0; i < 6; i++) this.noiseSweep("highpass", 2400, 2400, t + i * 0.055 + (i % 2) * 0.012, 0.025, 0.22); break;
      case "whoosh": this.noiseSweep("bandpass", 300, 4000, t, 0.4, 0.16); break;
      case "chime": [659.25, 830.61, 987.77].forEach((f, i) => this.tone("sine", f, f, t + i * 0.08, 0.5 - i * 0.08, 0.2)); break;
      case "buzz": this.tone("sawtooth", 220, 150, t, 0.28, 0.12); this.tone("square", 165, 110, t, 0.28, 0.07); break;
      case "fanfare":
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone("triangle", f, f, t + i * 0.11, 0.18, 0.2));
        this.tone("triangle", 1046.5, 1046.5, t + 0.44, 0.7, 0.16);
        break;
      case "thud":
        this.tone("sine", 110, 55, t, 0.35, 0.35);
        this.noiseSweep("lowpass", 300, 120, t, 0.25, 0.12);
        [440, 392, 349.23].forEach((f, i) => this.tone("triangle", f, f, t + 0.3 + i * 0.14, 0.16, 0.14));
        break;
      case "blipsDown": this.tone("square", 660, 660, t, 0.06, 0.08); this.tone("square", 440, 440, t + 0.09, 0.08, 0.08); break;
      case "blipsUp": this.tone("square", 440, 440, t, 0.06, 0.08); this.tone("square", 660, 660, t + 0.09, 0.08, 0.08); break;
      case "rise": this.tone("sine", 220, 440, t, 0.25, 0.14); break;
      case "fall": this.tone("sine", 440, 220, t, 0.25, 0.14); break;
      case "sweepDown": this.noiseSweep("bandpass", 3000, 120, t, 0.5, 0.14); break;
      case "footstep": this.tone("sine", 90, 60, t, 0.09, 0.22); break;
      case "attention":
        // A two-tone doorbell, twice: distinct from every other cue so you know it is about you.
        for (const k of [0, 0.5]) {
          this.tone("triangle", 783.99, 783.99, t + k, 0.22, 0.26);
          this.tone("triangle", 659.25, 659.25, t + k + 0.2, 0.3, 0.26);
        }
        break;
    }
  }

  private tone(type: OscillatorType, from: number, to: number, at: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(this.master!);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  private noiseSweep(type: BiquadFilterType, from: number, to: number, at: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = type === "bandpass" ? 1.4 : 0.7;
    f.frequency.setValueAtTime(from, at);
    if (to !== from) f.frequency.exponentialRampToValueAtTime(to, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(at, Math.random());
    src.stop(at + dur + 0.05);
  }

  /** Low office hum while the world runs: brown-ish noise under 260 Hz plus a 58 Hz sine, very quiet. */
  private syncAmbient(): void {
    const want = this.unlocked && this.running && this.settings.enabled && this.settings.ambient;
    const ctx = this.ctx;
    if (want && !this.ambient && ctx) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 1.5);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 260;
      const hum = ctx.createOscillator();
      hum.frequency.value = 58;
      const humGain = ctx.createGain();
      humGain.gain.value = 0.35;
      src.connect(lp).connect(gain);
      hum.connect(humGain).connect(gain);
      gain.connect(this.master!);
      src.start();
      hum.start();
      this.onAmbient?.(true);
      this.ambient = {
        gain,
        stop: () => {
          src.stop();
          hum.stop();
          gain.disconnect();
        },
      };
    } else if (!want && this.ambient && ctx) {
      const a = this.ambient;
      this.ambient = null;
      this.onAmbient?.(false);
      a.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      setTimeout(a.stop, 300);
    }
  }

  /** Whether the ambient bed is currently playing (for automated checks). */
  get ambientOn(): boolean {
    return this.ambient !== null;
  }
}

/** The one engine for the page. Creating it is free: no AudioContext exists until `unlock()`. */
export const soundEngine = new SoundEngine();
