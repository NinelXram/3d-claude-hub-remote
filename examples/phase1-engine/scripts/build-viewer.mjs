// Bundles the engine for the browser and inlines it into a single self-contained HTML file.
//   npm run viewer  →  viewer/dist/ai-agent-world.html  (open it in a browser; three.js loads from jsDelivr)
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..", "viewer");
const result = await build({
  entryPoints: [join(here, "entry.ts")],
  bundle: true,
  format: "iife",
  globalName: "AAW",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
});
const engine = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const template = readFileSync(join(here, "index.template.html"), "utf8");
if (!template.includes("/*__ENGINE__*/")) throw new Error("template is missing the /*__ENGINE__*/ marker");
const html = template.replace("/*__ENGINE__*/", () => engine);
mkdirSync(join(here, "dist"), { recursive: true });
// fragment.html: page body only (for hosts that add their own document skeleton).
// ai-agent-world.html: a complete document to open straight from disk.
writeFileSync(join(here, "dist", "fragment.html"), html);
const out = join(here, "dist", "ai-agent-world.html");
const full = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${html}\n</body>\n</html>\n`;
writeFileSync(out, full);
console.log(`wrote ${out} (${(Buffer.byteLength(full) / 1024).toFixed(1)} KB, engine ${(engine.length / 1024).toFixed(1)} KB)`);
