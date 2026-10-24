// Records the four clips the video uses from the real app (simulation build and live build on the stage server).
//   npm run capture                     build both app copies, record every clip
//   npm run capture -- --reuse          reuse existing builds
//   npm run capture -- --only phone-remote
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { buildApp, startApp } from "./build-app.ts";
import { assertClean } from "./guards.ts";
import { recordClip } from "./screencast.ts";
import { SPECS } from "./specs.ts";
import { startStage } from "../stage/server.ts";

const { values } = parseArgs({ options: { reuse: { type: "boolean", default: false }, only: { type: "string" } } });
const here = dirname(fileURLToPath(import.meta.url));
const CLIPS = join(here, "..", "public", "clips");
const MAX_AVG_INTERVAL_MS = 40;
/** When things happen in each clip (seconds from its first frame); the sound effects are placed from these. */
const MARKS_FILE = join(here, "..", "src", "clipMarks.json");

async function main() {
  const specs = SPECS.filter((s) => !values.only || s.name === values.only);
  const modes = new Set(specs.map((s) => s.mode));
  console.log(`building app copies: ${[...modes].join(", ")}${values.reuse ? " (reuse)" : ""}`);
  for (const m of modes) buildApp(m, values.reuse);

  const stage = modes.has("live") ? await startStage() : null;
  const apps = {
    sim: modes.has("sim") ? await startApp("sim", 3211) : null,
    live: modes.has("live") ? await startApp("live", 3212) : null,
  };
  let browser: Browser | null = null;
  try {
    // Headed Chrome so WebGL runs on the real GPU.
    browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--window-position=0,0", "--hide-scrollbars"] });
    for (const spec of specs) {
      const app = apps[spec.mode]!;
      const context = await browser.newContext(
        spec.phone
          ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true }
          : { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
      );
      const page = await context.newPage();
      if (stage && spec.mode === "live") void stage.play();
      await page.goto(app.url + spec.path);
      await spec.prepare(page);
      await assertClean(page, spec.mode);
      const out = join(CLIPS, `${spec.name}.mp4`);
      const marks: Record<string, number> = {};
      const stats = await recordClip(page, out, () => {
        const t0 = Date.now();
        return spec.act(page, (name) => {
          marks[name] = Number(((Date.now() - t0) / 1000).toFixed(3));
        });
      });
      const all = existsSync(MARKS_FILE) ? (JSON.parse(readFileSync(MARKS_FILE, "utf8")) as Record<string, Record<string, number>>) : {};
      all[spec.name] = marks;
      writeFileSync(MARKS_FILE, JSON.stringify(all, null, 2) + "\n");
      await assertClean(page, spec.mode);
      await context.close();
      console.log(`  ${spec.name}: ${stats.seconds.toFixed(1)} s, ${stats.frames} frames, avg ${stats.avgIntervalMs.toFixed(1)} ms/frame`);
      if (stats.seconds < spec.minSeconds) throw new Error(`${spec.name} is ${stats.seconds.toFixed(1)} s, needs ${spec.minSeconds} s`);
      if (stats.avgIntervalMs > MAX_AVG_INTERVAL_MS) throw new Error(`${spec.name}: ${stats.avgIntervalMs.toFixed(1)} ms between frames (> ${MAX_AVG_INTERVAL_MS}); WebGL is not running smoothly`);
    }
  } finally {
    await browser?.close();
    apps.sim?.stop();
    apps.live?.stop();
    await stage?.close();
  }
}

await main();
process.exit(0);
