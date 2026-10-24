/// <reference lib="dom" />
// Procedural Web Audio cues (§8 of the prompt). No sound files: every cue is synthesised.
// cueFor() is pure so the event → sound mapping can be tested in Node; SoundEngine only runs in a browser.
import type { AgentId } from "../src/agents/agentTypes.ts";
import type { AgentEvent } from "../src/events/eventTypes.ts";

export type Cue =
  | "created" | "ping" | "arpeggio" | "research" | "keys" | "whoosh" | "chime" | "buzz"
  | "fanfare" | "thud" | "blipsDown" | "blipsUp" | "rise" | "fall" | "sweepDown" | "footstep" | "attention";

export type SoundMode = "simulation" | "live";

/** Each speaker's own pitch (Hz), so you can tell who is talking without looking. */
export const AGENT_PITCH: Record<AgentId, number> = { orion: 523.25, piper: 659.25, iris: 587.33, kai: 440, quinn: 698.46, rex: 392 };

/**
 * Which cue an event plays, or null for silence.
 * Live mode keeps only what is worth interrupting you for: test results, the end of a turn, and Claude waiting on you.
 */
export function cueFor(e: AgentEvent, mode: SoundMode): Cue | null {
  const waitingForYou = e.agentId === "orion" && e.severity === "warning" && /^(Needs your permission|Claude Code needs you)/.test(e.message);
  if (mode === "live") {
    if (waitingForYou) return "attention";
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

export interface SoundSettings {
  enabled: boolean;
  volume: number;
  ambient: boolean;
}

const STORAGE_KEY = "aaw.sound.v1";

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last = new Map<string, number>();
  private ambient: { gain: GainNode; stop: () => void } | null = null;
  private running = false;
  readonly mode: SoundMode;
  settings: SoundSettings;
  /** Cues actually sounded (for automated checks; no effect on playback). */
  played = 0;

  constructor(mode: SoundMode) {
    this.mode = mode;
    const defaults: SoundSettings = { enabled: true, volume: 0.6, ambient: mode === "simulation" };
    let saved: Partial<SoundSettings> = {};
    try {
      saved = JSON.parse(localStorage.getItem(`${STORAGE_KEY}.${mode}`) ?? "{}") as Partial<SoundSettings>;
    } catch {
      // storage blocked: defaults
    }
    this.settings = { ...defaults, ...saved };
  }

  get unlocked(): boolean {
    return this.ctx?.state === "running";
  }

  /** Must run inside a user gesture (pointerdown/keydown). Before this, play() is a silent no-op. */
  unlock(): void {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 6;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.settings.enabled ? this.settings.volume : 0;
      this.master.connect(comp).connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().then(() => this.syncAmbient());
    this.syncAmbient();
  }

  configure(patch: Partial<SoundSettings>): void {
    this.settings = { ...this.settings, ...patch };
    try {
      localStorage.setItem(`${STORAGE_KEY}.${this.mode}`, JSON.stringify(this.settings));
    } catch {
      // ignore
    }
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.settings.enabled ? this.settings.volume : 0, this.ctx.currentTime, 0.02);
    this.syncAmbient();
  }

  setRunning(running: boolean): void {
    this.running = running;
    this.syncAmbient();
  }

  play(e: AgentEvent): void {
    if (!this.settings.enabled || !this.unlocked) return;
    const cue = cueFor(e, this.mode);
    if (!cue) return;
    const { key, ms } = throttleKey(e);
    const now = performance.now();
    if (now - (this.last.get(key) ?? -Infinity) < ms) return;
    this.last.set(key, now);
    this.sound(cue, e.agentId ? AGENT_PITCH[e.agentId] : 523.25);
    this.played++;
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
        for (const k of [0, 0.5]) { this.tone("triangle", 783.99, 783.99, t + k, 0.22, 0.26); this.tone("triangle", 659.25, 659.25, t + k + 0.2, 0.3, 0.26); }
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
      this.ambient = { gain, stop: () => { src.stop(); hum.stop(); } };
    } else if (!want && this.ambient && ctx) {
      const a = this.ambient;
      this.ambient = null;
      a.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08);
      setTimeout(a.stop, 300);
    }
  }
}
