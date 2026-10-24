// Replay a recorded Claude Code session into a running live server, with its original timing.
//   npm run replay -- [file.jsonl] [--url http://127.0.0.1:8787/hook] [--speed 2]
// Record your own with: npm run server -- --source claude-code --record my-session.jsonl
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { url: { type: "string", default: "http://127.0.0.1:8787/hook" }, speed: { type: "string", default: "1" }, token: { type: "string" } },
});
const file = positionals[0] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "sample-session.jsonl");
// A server started with --control wants its token on /hook: --token, AAW_TOKEN, or the one kept in ~/.aaw/token.
const tokenFile = join(homedir(), ".aaw", "token");
const token = values.token ?? process.env.AAW_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : undefined);
const speed = Math.max(0.1, Number(values.speed));
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: number; payload: { hook_event_name: string; tool_name?: string } });

console.log(`Replaying ${lines.length} hook events from ${file} at ${speed}× → ${values.url}`);
const t0 = Date.now();
for (const { t, payload } of lines) {
  const wait = t / speed - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  try {
    await fetch(values.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
    });
    console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${payload.hook_event_name}${payload.tool_name ? ` · ${payload.tool_name}` : ""}`);
  } catch {
    console.error(`Cannot reach ${values.url}. Start the server first: npm run server -- --source claude-code`);
    process.exit(1);
  }
}
console.log("Done.");
