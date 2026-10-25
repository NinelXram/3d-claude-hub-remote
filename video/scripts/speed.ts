// Makes a faster copy of the rendered video: picture and sound together, the voice keeps its pitch (atempo).
//   npm run speed              → out/3d-workflow-intro-vi-1.4x.mp4
//   npm run speed -- 1.25      → out/3d-workflow-intro-vi-1.25x.mp4
// The bundled ffmpeg has no setpts filter, so the picture is sped up by scaling its input timestamps (-itsscale).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ffmpegPath } from "../capture/screencast.ts";

const rate = Number(process.argv[2] ?? "1.4");
if (!(rate >= 0.5 && rate <= 2)) {
  console.error("The speed must be between 0.5 and 2 (atempo's range in one pass).");
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = join(root, "out", "3d-workflow-intro-vi.mp4");
const output = join(root, "out", `3d-workflow-intro-vi-${rate}x.mp4`);
if (!existsSync(input)) {
  console.error("Render the video first: npm run render");
  process.exit(2);
}

const ffmpeg = (args: string[]) => spawnSync(ffmpegPath(), args, { encoding: "utf8" });
const r = ffmpeg([
  "-y", "-loglevel", "error",
  "-itsscale", String(1 / rate), "-i", input,
  "-i", input,
  "-map", "0:v:0", "-map", "1:a:0",
  "-af", `atempo=${rate}`,
  "-fps_mode", "cfr", "-r", "30",
  "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "192k",
  "-shortest", "-movflags", "+faststart",
  output,
]);
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}

// Check: duration is the original's divided by the rate, 1080p, 30 fps, with sound.
const probe = (file: string) =>
  JSON.parse(spawnSync(ffmpegPath("ffprobe"), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", file], { encoding: "utf8" }).stdout) as {
    format: { duration: string };
    streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
const before = Number(probe(input).format.duration);
const after = probe(output);
const seconds = Number(after.format.duration);
const video = after.streams.find((s) => s.codec_type === "video");
const ok = Math.abs(seconds - before / rate) < 0.5 && video?.width === 1920 && video.height === 1080 && video.r_frame_rate === "30/1" && after.streams.some((s) => s.codec_type === "audio");
console.log(`${ok ? "✓" : "✗"} ${output}: ${seconds.toFixed(1)} s (from ${before.toFixed(1)} s at ${rate}×), ${video?.width}×${video?.height}, ${video?.r_frame_rate} fps`);
process.exit(ok ? 0 : 1);
