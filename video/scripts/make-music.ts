// Synthesizes the music bed (public/music.wav): a soft pad on Am–F–C–G, 4 s per chord, with a pulse that
// rises in the middle. Our own sound, so no licensing question. Replace the file to use other music.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RATE = 44_100;
const SECONDS = 96;
const CHORD_S = 4;
const FADE_S = 2;
const n = RATE * SECONDS;
const left = new Float32Array(n);
const right = new Float32Array(n);

const midi = (m: number) => 440 * 2 ** ((m - 69) / 12);
// A minor, F major, C major, G major (voicings around middle C) with a bass note an octave down.
const CHORDS = [
  { bass: 45, notes: [57, 60, 64, 69] },
  { bass: 41, notes: [57, 60, 65, 69] },
  { bass: 48, notes: [55, 60, 64, 67] },
  { bass: 43, notes: [55, 59, 62, 67] },
];

for (let i = 0; i < n; i++) {
  const t = i / RATE;
  const idx = Math.floor(t / CHORD_S);
  const local = t - idx * CHORD_S;
  let l = 0;
  let r = 0;
  // Each chord swells in and overlaps the next by 1 s.
  for (const k of [idx - 1, idx]) {
    if (k < 0) continue;
    const c = CHORDS[k % CHORDS.length]!;
    const tt = k === idx ? local : local + CHORD_S;
    const env = Math.min(1, tt / 1.2) * (tt > CHORD_S ? Math.max(0, 1 - (tt - CHORD_S) / 1) : 1);
    if (env <= 0) continue;
    c.notes.forEach((m, j) => {
      const f = midi(m);
      const a = Math.sin(2 * Math.PI * f * 0.997 * t + j);
      const b = Math.sin(2 * Math.PI * f * 1.003 * t + j * 2);
      const pan = (j / (c.notes.length - 1)) * 0.6 + 0.2;
      l += ((a + 0.6 * b) * (1 - pan) * env) / 6;
      r += ((0.6 * a + b) * pan * env) / 6;
    });
    const bass = Math.sin(2 * Math.PI * midi(c.bass) * t) * 0.35 * env;
    l += bass;
    r += bass;
  }
  // A gentle eighth-note pulse on the root, louder in the middle of the video (the feature scenes).
  const pulseGain = Math.max(0, Math.sin((Math.PI * t) / SECONDS)) * 0.18;
  const beat = (t * 2) % 1;
  const root = midi(CHORDS[idx % CHORDS.length]!.notes[0]! + 12);
  const pulse = Math.sin(2 * Math.PI * root * t) * Math.exp(-beat * 9) * pulseGain;
  l += pulse;
  r += pulse;
  const fade = Math.min(1, t / FADE_S, (SECONDS - t) / FADE_S);
  left[i] = l * fade;
  right[i] = r * fade;
}

// Soften the highs (one-pole low-pass), then normalize to -6 dBFS.
for (const ch of [left, right]) {
  let y = 0;
  for (let i = 0; i < n; i++) {
    y += 0.25 * (ch[i]! - y);
    ch[i] = y;
  }
}
let peak = 0;
for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
const gain = 0.5 / (peak || 1);

const data = Buffer.alloc(n * 4);
for (let i = 0; i < n; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i]! * gain)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i]! * gain)) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "music.wav");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([header, data]));
console.log(`wrote ${out} (${SECONDS} s)`);
