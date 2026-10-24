// Generates the voiceover with Azure Speech (key and region from video/.env.local, see `npm run azure:setup`),
// or, without a key, with edge-tts (the same NamMinh voice through Edge's read-aloud service; installed in
// .stage/tts-venv: `python -m venv .stage/tts-venv && .stage/tts-venv/Scripts/pip install edge-tts`). Writes public/voice/<scene>.wav and public/voice/manifest.json (seconds per line). A line that would run past
// its scene is spoken a little faster, up to +20%.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FPS, scenes } from "../src/timeline.ts";
import { VOICE, VOICE_LINES, plainFor, ssmlFor } from "../src/voice.vi.ts";
import { ffmpegPath } from "../capture/screencast.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env: Record<string, string> = {};
const envFile = join(root, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
}
const key = process.env.AZURE_SPEECH_KEY ?? env.AZURE_SPEECH_KEY;
const region = process.env.AZURE_SPEECH_REGION ?? env.AZURE_SPEECH_REGION;
const edgeBin = [join(root, ".stage", "tts-venv", "Scripts", "edge-tts.exe"), join(root, ".stage", "tts-venv", "bin", "edge-tts")].find(existsSync) ?? "edge-tts";
const provider = key && region ? "azure" : "edge-tts";
if (provider === "edge-tts") console.log("No Azure key in video/.env.local: using edge-tts. Run `npm run azure:setup`, then this again, for the licensed Azure voice.");

/** Seconds of audio in a PCM WAV (reads the fmt and data chunks). */
export function wavSeconds(buf: Buffer): number {
  let byteRate = 0;
  for (let o = 12; o + 8 <= buf.length; ) {
    const id = buf.toString("ascii", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(o + 16);
    if (id === "data") return byteRate ? size / byteRate : 0;
    o += 8 + size + (size % 2);
  }
  return 0;
}

/** edge-tts takes plain text and writes MP3; convert to the same 48 kHz mono WAV Azure gives. */
function speakEdge(text: string, rate: string): Buffer {
  const tmp = join(root, ".stage", "voice-tmp");
  mkdirSync(tmp, { recursive: true });
  const mp3 = join(tmp, "line.mp3");
  const wavFile = join(tmp, "line.wav");
  const r = spawnSync(edgeBin, ["--voice", VOICE, `--rate=${rate}`, "--text", text, "--write-media", mp3], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`edge-tts failed (${r.error?.message ?? r.stderr.slice(0, 300)}). Install it: python -m venv .stage/tts-venv, then .stage/tts-venv/Scripts/pip install edge-tts`);
  const c = spawnSync(ffmpegPath(), ["-y", "-loglevel", "error", "-i", mp3, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wavFile], { encoding: "utf8" });
  if (c.status !== 0) throw new Error(`converting edge-tts audio failed: ${c.stderr}`);
  const out = readFileSync(wavFile);
  rmSync(tmp, { recursive: true, force: true });
  return out;
}

async function speak(ssml: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key!,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "riff-48khz-16bit-mono-pcm",
        "User-Agent": "3d-claude-hub-video",
      },
      body: ssml,
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    // The free tier allows few requests per second; wait and retry.
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`Azure TTS ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

const outDir = join(root, "public", "voice");
mkdirSync(outDir, { recursive: true });
const manifest: Record<string, number> = {};
for (const line of VOICE_LINES) {
  const scene = scenes.find((s) => s.id === line.scene)!;
  const room = scene.durationInFrames / FPS - 0.3 - line.startS;
  let audio: Buffer = Buffer.alloc(0);
  let seconds = 0;
  let rate = 0;
  for (; rate <= 20; rate += 5) {
    const pct = `+${rate}%`;
    audio = provider === "azure" ? await speak(ssmlFor(line.text, pct)) : speakEdge(plainFor(line.text), pct);
    seconds = wavSeconds(audio);
    if (seconds <= room) break;
  }
  writeFileSync(join(outDir, `${line.scene}.wav`), audio);
  manifest[line.scene] = Number(seconds.toFixed(3));
  console.log(`  ${line.scene}: ${seconds.toFixed(2)} s (room ${room.toFixed(1)} s${rate > 0 ? `, rate +${Math.min(rate, 20)}%` : ""})`);
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote public/voice/*.wav and manifest.json (${provider})`);
