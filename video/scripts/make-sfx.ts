// Synthesizes the sound effects (public/sfx/*.wav): our own sounds, so no licensing question.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SFX_NAMES } from "../src/sound.ts";
import type { SfxName } from "../src/sound.ts";

const RATE = 48_000;
let seed = 7;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
};
const midi = (m: number) => 440 * 2 ** ((m - 69) / 12);

function render(seconds: number, f: (t: number, i: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = f(i / RATE, i);
  return out;
}

/** One-pole low-pass with a cutoff that may move over time. */
function lowpass(x: Float32Array, cutoffAt: (t: number) => number): Float32Array {
  const y = new Float32Array(x.length);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp((-2 * Math.PI * cutoffAt(i / RATE)) / RATE);
    s += a * (x[i]! - s);
    y[i] = s;
  }
  return y;
}

const SOUNDS: Record<SfxName, () => Float32Array> = {
  // A filtered noise sweep up then down: scene changes.
  whoosh: () => {
    const len = 0.7;
    const n = render(len, () => noise());
    const swept = lowpass(n, (t) => 300 + 5000 * Math.sin((Math.PI * t) / len));
    return swept.map((v, i) => v * Math.sin((Math.PI * i) / swept.length) ** 2 * 1.6);
  },
  // A low thump with a bright tail: the product name.
  impact: () =>
    render(1.6, (t) => {
      const boom = Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-t * 12)) * t) * Math.exp(-t * 4);
      const shimmer = (Math.sin(2 * Math.PI * midi(88) * t) + Math.sin(2 * Math.PI * midi(95) * t)) * 0.08 * Math.exp(-t * 2.5);
      return boom * 0.9 + shimmer;
    }),
  // A short UI click.
  click: () => render(0.06, (t) => (noise() * 0.5 + Math.sin(2 * Math.PI * 2200 * t)) * Math.exp(-t * 90) * 0.7),
  // One key of a soft keyboard.
  key: () => {
    const n = render(0.05, (t) => noise() * Math.exp(-t * 120));
    return lowpass(n, () => 3500).map((v) => v * 1.4);
  },
  // Two rising notes: the reply arrives, a test passes.
  chime: () =>
    render(1.1, (t) => {
      const a = Math.sin(2 * Math.PI * midi(84) * t) * Math.exp(-t * 5);
      const b = t > 0.12 ? Math.sin(2 * Math.PI * midi(91) * (t - 0.12)) * Math.exp(-(t - 0.12) * 4) : 0;
      return (a + b) * 0.35;
    }),
  // The app's two-tone bell when Claude needs you.
  alert: () =>
    render(0.7, (t) => {
      const note = t < 0.18 ? midi(81) : midi(76);
      const env = t < 0.18 ? Math.exp(-t * 10) : Math.exp(-(t - 0.18) * 7);
      return Math.sin(2 * Math.PI * note * t) * env * 0.4;
    }),
  // A small bubble pop: an item appears.
  pop: () => render(0.12, (t) => Math.sin(2 * Math.PI * (500 + 900 * Math.exp(-t * 40)) * t) * Math.exp(-t * 30) * 0.5),
};

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sfx");
mkdirSync(outDir, { recursive: true });
for (const name of SFX_NAMES) writeFileSync(join(outDir, `${name}.wav`), wav(SOUNDS[name]()));
console.log(`wrote ${SFX_NAMES.length} sounds to public/sfx`);
