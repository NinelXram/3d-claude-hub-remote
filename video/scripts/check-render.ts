// Checks the rendered MP4 (duration, size, frame rate, audio) and that every clip covers the footage a scene takes from it.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../capture/screencast.ts";
import { CLIP_USES } from "../src/timeline.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

interface Probe {
  format?: { duration?: string };
  streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
}
function probe(file: string): Probe {
  const r = spawnSync(ffmpegPath("ffprobe"), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", file], { encoding: "utf8" });
  return r.status === 0 ? (JSON.parse(r.stdout) as Probe) : {};
}

const out = join(root, "out", "3d-workflow-intro-vi.mp4");
check("the video was rendered", existsSync(out), out);
if (existsSync(out)) {
  const p = probe(out);
  const duration = Number(p.format?.duration ?? 0);
  const video = p.streams?.find((s) => s.codec_type === "video");
  check("duration is 85–95 s", duration >= 85 && duration <= 95, `${duration.toFixed(2)} s`);
  check("1920×1080", video?.width === 1920 && video.height === 1080, `${video?.width}×${video?.height}`);
  check("30 fps", video?.r_frame_rate === "30/1", video?.r_frame_rate);
  check("has an audio track", !!p.streams?.some((s) => s.codec_type === "audio"));
}

for (const use of CLIP_USES) {
  const file = join(root, "public", "clips", `${use.clip}.mp4`);
  const duration = Number(probe(file).format?.duration ?? 0);
  check(`${use.clip} covers ${use.startAt}+${use.seconds} s (${use.scene})`, duration >= use.startAt + use.seconds, `${duration.toFixed(1)} s`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
