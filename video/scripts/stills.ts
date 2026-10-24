// Renders one still at the middle of every caption window (out/stills/NN-scene.png) for the visual pass.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { lineWindows, scenes } from "../src/timeline.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out", "stills");
mkdirSync(outDir, { recursive: true });
const serveUrl = await bundle({ entryPoint: join(root, "src", "index.ts"), publicDir: join(root, "public") });
const composition = await selectComposition({ serveUrl, id: "Intro" });
let n = 0;
for (const s of scenes) {
  for (const w of lineWindows(s.id)) {
    const frame = s.from + w.from + Math.floor(w.durationInFrames / 2);
    const output = join(outDir, `${String(++n).padStart(2, "0")}-${s.id}.png`);
    await renderStill({ serveUrl, composition, frame, output });
    console.log(`  ${output}  (frame ${frame})`);
  }
}
