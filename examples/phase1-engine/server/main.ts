// npm run server -- [--source sim|claude-code] [--control] [--app-port 3000] [--proxy-app] [--allow-bypass] [--permission-mode default|acceptEdits|auto|plan|dontAsk] [--port 8787] [--token T] [--record file.jsonl] [--hide-prompts]
//                    [--trust-tailscale login[,login]] [--tailscale-port 8788]
//
//   sim          the deterministic simulation, now behind the WebSocket protocol
//   claude-code  live: POST Claude Code hook payloads to /hook (see bridge/README.md)
//   --control    with claude-code: open session transcripts, send prompts and answer permission asks
//                from the web UI. Requires a token (kept in ~/.aaw/token unless --token is given).
//   --trust-tailscale  also listen on 127.0.0.1:<--tailscale-port> (default --port + 1) for `tailscale serve`;
//                there, these Tailscale logins (e.g. you@github) need no token. Point tailscale serve at that port.
//
// Open http://127.0.0.1:8787/ for the viewer (run `npm run viewer` once first).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MockAgentBackend } from "../src/integrations/MockAgentBackend.ts";
import { LiveAgentBackend } from "../src/live/LiveAgentBackend.ts";
import type { AgentBackend } from "../src/integrations/AgentBackend.ts";
import { startWorldServer } from "./worldServer.ts";
import { createHookRoute } from "./hookRoute.ts";
import { SessionHub } from "./sessions/sessionHub.ts";
import { createSdkRunner } from "./sessions/claudeRunner.ts";
import type { SessionPermissionMode } from "../src/integrations/AgentBackend.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string", default: "sim" },
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    token: { type: "string" },
    record: { type: "string" },
    "hide-prompts": { type: "boolean", default: false },
    control: { type: "boolean", default: false },
    "app-port": { type: "string", default: "3000" },
    "proxy-app": { type: "boolean", default: false },
    "allow-bypass": { type: "boolean", default: false },
    "permission-mode": { type: "string" },
    "trust-tailscale": { type: "string" },
    "tailscale-port": { type: "string" },
  },
});

const here = dirname(fileURLToPath(import.meta.url));
const viewerFile = join(here, "..", "viewer", "dist", "fragment.html");

let backend: AgentBackend;
let live: LiveAgentBackend | null = null;
if (values.source === "claude-code") {
  live = new LiveAgentBackend({ showPrompts: !values["hide-prompts"] });
  backend = live;
} else if (values.source === "sim") {
  backend = new MockAgentBackend();
} else {
  console.error(`Unknown --source ${values.source}; use sim or claude-code`);
  process.exit(2);
}
await backend.connect();
if (values.source === "sim") await backend.start();

/** A stable token for --control, so the app URL keeps working across restarts. Readable only by you. */
function controlToken(): string {
  const dir = join(homedir(), ".aaw");
  const file = join(dir, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

if (values.control && !live) {
  console.error("--control only works with --source claude-code.");
  process.exit(2);
}
const token = values.token ?? (values.control ? controlToken() : undefined);
const sessions = values.control
  ? new SessionHub({
      runner: createSdkRunner(),
      allowBypass: values["allow-bypass"],
      hiddenFile: join(homedir(), ".aaw", "hidden-sessions.json"),
      ...(values["permission-mode"] ? { defaultPermissionMode: values["permission-mode"] as SessionPermissionMode } : {}),
    })
  : undefined;
if (values["allow-bypass"]) console.log("  warning    --allow-bypass: anyone with the token can run tools on this machine without asking. Keep tunnels private.");

function page(): string | null {
  if (!existsSync(viewerFile)) return null;
  const html = readFileSync(viewerFile, "utf8");
  // Tell the viewer to connect back to this server instead of running its own engine.
  const body = html.replace('<meta name="aaw-ws" content="">', '<meta name="aaw-ws" content="same-origin">');
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}

const trustLogins = (values["trust-tailscale"] ?? "").split(",").map((l) => l.trim()).filter(Boolean);
const tailnetPort = values["tailscale-port"] ? Number(values["tailscale-port"]) : Number(values.port) + 1;
if (values["trust-tailscale"] !== undefined && trustLogins.length === 0) {
  console.error("--trust-tailscale needs a login, e.g. --trust-tailscale you@github (see `tailscale status --json`, User → LoginName).");
  process.exit(2);
}

const server = await startWorldServer({
  backend,
  port: Number(values.port),
  host: values.host,
  ...(token ? { token } : {}),
  // The --control token guards sessions only; the world mirror stays open to this machine as before.
  // A token you pass with --token guards everything.
  ...(token && !values.token ? { tokenScope: "sessions" as const } : {}),
  ...(live ? {
    http: createHookRoute({
      live,
      // With --control a hook can create sessions you might prompt into, so hooks need the token too.
      // bridge/forward-hook.sh sends AAW_TOKEN, or the token kept in ~/.aaw/token.
      ...(token ? { token } : {}),
      ...(values.record ? { record: values.record } : {}),
      ...(sessions ? { onPayload: (p) => sessions.noteHook(p) } : {}),
    }),
  } : {}),
  ...(sessions ? { sessions } : {}),
  // One forwarded port for everything: the app's pages come through this server, so page and WebSocket share an origin.
  ...(values["proxy-app"] ? { proxyApp: `http://127.0.0.1:${values["app-port"]}` } : {}),
  page,
  ...(trustLogins.length ? { tailnet: { port: tailnetPort, logins: trustLogins } } : {}),
});

const httpUrl = server.url.replace(/^ws/, "http");
console.log(`3D Claude Hub Remote server · ${backend.label}${backend.simulated ? " (simulated)" : ""}`);
// The token goes after # so it never reaches a server or a tunnel's logs, and it is printed only to a terminal:
// under autostart this output lands in a log file.
const q = token ? (process.stdout.isTTY ? `#token=${encodeURIComponent(token)}` : "#token=<see ~/.aaw/token>") : "";
console.log(`  viewer     ${httpUrl}/${q}${existsSync(viewerFile) ? "" : "   (run `npm run viewer` first)"}`);
console.log(`  websocket  ${server.url}`);
if (live) console.log(`  hooks      POST ${httpUrl}/hook${values.record ? `   (recording to ${values.record})` : ""}`);
if (values["proxy-app"]) console.log(`  proxy      the app on :${values["app-port"]} is also served here: ${httpUrl}/${q}   (forward this one port for a tunnel)`);
if (sessions) {
  console.log(`  control    on: transcripts, prompts and permission answers from the web UI`);
  console.log(`  app        http://localhost:${values["app-port"]}/${q}   (run the app with NEXT_PUBLIC_AGENT_BACKEND=websocket NEXT_PUBLIC_AGENT_WS_URL=${server.url})`);
}
if (server.tailnetPort) {
  console.log(`  tailscale  http://127.0.0.1:${server.tailnetPort} for tailscale serve; no token needed for ${trustLogins.join(", ")}`);
  console.log(`             (tailscale serve --bg --http=80 http://127.0.0.1:${server.tailnetPort})`);
}
if (values.host !== "127.0.0.1" && values.host !== "localhost") console.log("  warning    listening beyond loopback: prompts and file names from your session are visible to that network");

const shutdown = async () => {
  sessions?.dispose();
  await server.close();
  await backend.disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
