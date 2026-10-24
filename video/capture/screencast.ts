// Records a page through Chrome's screencast (sharper than Playwright's recordVideo) into a constant 30 fps MP4.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Page } from "@playwright/test";

/** Remotion ships ffmpeg for this platform; use it directly (no shell, so filter arguments arrive intact). */
export function ffmpegPath(tool: "ffmpeg" | "ffprobe" = "ffmpeg"): string {
  const require = createRequire(import.meta.url);
  const pkg = `@remotion/compositor-${process.platform}-${process.arch}${process.platform === "win32" ? "-msvc" : process.platform === "linux" ? "-gnu" : ""}`;
  return join(dirname(require.resolve(`${pkg}/package.json`)), process.platform === "win32" ? `${tool}.exe` : tool);
}

export interface ClipStats {
  frames: number;
  seconds: number;
  avgIntervalMs: number;
}

export async function recordClip(page: Page, outFile: string, run: () => Promise<void>): Promise<ClipStats> {
  const framesDir = `${outFile}.frames`;
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
  const viewport = page.viewportSize() ?? { width: 1920, height: 1080 };
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const cdp = await page.context().newCDPSession(page);
  const frames: { file: string; t: number }[] = [];
  cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    const file = join(framesDir, `${String(frames.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(f.data, "base64"));
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 });
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 92,
    maxWidth: Math.round(viewport.width * scale),
    maxHeight: Math.round(viewport.height * scale),
    everyNthFrame: 1,
  });
  const started = Date.now() / 1000;
  await run();
  const stopped = Date.now() / 1000;
  await cdp.send("Page.stopScreencast");
  await cdp.detach();
  if (frames.length < 2) throw new Error(`${outFile}: only ${frames.length} frames captured`);

  // Each frame lasts until the next one arrives; the last one until the recording stopped.
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? Math.max(stopped, f.t + 1 / 30);
    lines.push(`file '${f.file.replaceAll("\\", "/")}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1)!.file.replaceAll("\\", "/")}'`);
  const list = join(framesDir, "list.ffconcat");
  writeFileSync(list, lines.join("\n") + "\n");
  mkdirSync(dirname(outFile), { recursive: true });
  const r = spawnSync(ffmpegPath(), ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-fps_mode", "cfr", "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "16", "-preset", "medium", outFile], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${outFile}:\n${r.stderr}`);
  rmSync(framesDir, { recursive: true, force: true });
  const seconds = stopped - started;
  const span = frames.at(-1)!.t - frames[0]!.t;
  return { frames: frames.length, seconds, avgIntervalMs: (span / (frames.length - 1)) * 1000 };
}
