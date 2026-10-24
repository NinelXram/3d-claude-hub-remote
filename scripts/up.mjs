// npm run up [-- options]
// Starts the live world server and the production app together; Ctrl+C stops both.
//
//   --app-port 3210      port of the app (default 3210)
//   --port 8787          port of the world server (default 8787; the app build expects 8787)
//   --no-control         read-only mirror: no prompts or permission answers from the web
//   --no-open            do not open the browser
//   --no-build           do not rebuild even if the app changed
//   --record             record hook payloads to ~/.aaw/sessions/<date>.jsonl
//   --tailscale          open it on your tailnet: --trust-tailscale, plus runs the `tailscale serve` it needs
//                        (npm run up:tailscale)
//   --trust-tailscale [login]  no token for your Tailscale login (detected when omitted) through
//                        `tailscale serve --http=80 http://127.0.0.1:<port + 1>`; other logins and tunnels still need it
//   anything else (e.g. --allow-bypass, --permission-mode acceptEdits, --hide-prompts) goes to the server
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { APP, ENGINE, NPM, bold, buildStale, cyan, dim, green, openBrowser, portFree, red, run, step, supervise, tailscaleSelf, tailscaleServe, yellow } from "./lib.mjs";

console.log(dim(`[${new Date().toISOString()}] npm run up starting (pid ${process.pid})`));
const argv = process.argv.slice(2);
const take = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const has = (flag) => {
  const i = argv.indexOf(flag);
  if (i >= 0) argv.splice(i, 1);
  return i >= 0;
};
const appPort = Number(take("--app-port", "3210"));
const port = Number(take("--port", "8787"));
const control = !has("--no-control");
const open = !has("--no-open");
const noBuild = has("--no-build");
const record = has("--record");
const serveTailnet = has("--tailscale");
if (serveTailnet && !argv.includes("--trust-tailscale")) argv.push("--trust-tailscale");
// --trust-tailscale takes an optional login: the next argument, unless it is another flag.
let trustLogin = null;
let tailnet = null;
{
  const i = argv.indexOf("--trust-tailscale");
  if (i >= 0) {
    const next = argv[i + 1];
    const given = next && !next.startsWith("--") ? next : null;
    argv.splice(i, given ? 2 : 1);
    tailnet = tailscaleSelf();
    trustLogin = given ?? tailnet?.login ?? null;
    if (!trustLogin) {
      console.error(red(`--trust-tailscale: Tailscale is not running here, so your login is unknown. Pass it: ${bold("--trust-tailscale you@github")}`));
      process.exit(1);
    }
  }
}
const tailnetPort = port + 1;
const passThrough = argv;

if (!existsSync(join(APP, "node_modules")) || !existsSync(join(ENGINE, "node_modules"))) {
  console.error(red(`Dependencies are missing. Run ${bold("npm run setup")} first.`));
  process.exit(1);
}
if (port !== 8787) console.log(yellow(`! The app build connects to ws://127.0.0.1:8787; with --port ${port} open the app through the server's proxy link instead.`));

for (const [p, what] of [[port, "world server"], [appPort, "app"], ...(trustLogin ? [[tailnetPort, "tailscale serve listener"]] : [])]) {
  if (!(await portFree(p))) {
    console.error(red(`Port ${p} (${what}) is already in use. Stop whatever runs there, or pick another with ${p === port ? "--port" : "--app-port"}.`));
    process.exit(1);
  }
}

const stale = noBuild ? null : buildStale();
if (stale) {
  step(`Building the app (${stale})`);
  run(NPM, ["run", "-s", "build:live"], APP);
}

const serverArgs = ["run", "-s", "server", "--", "--source", "claude-code", "--port", String(port), "--app-port", String(appPort), "--proxy-app"];
if (control) serverArgs.push("--control");
if (record) {
  const dir = join(homedir(), ".aaw", "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  serverArgs.push("--record", join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`));
}
if (trustLogin) serverArgs.push("--trust-tailscale", trustLogin, "--tailscale-port", String(tailnetPort));
serverArgs.push(...passThrough);

step("Starting");
const server = supervise("server", cyan, NPM, serverArgs, ENGINE);
const app = supervise("app", green, NPM, ["run", "-s", "start:live"], APP, { PORT: String(appPort) });
const children = [server, app];

let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGINT");
  setTimeout(() => process.exit(code), 1500).unref();
};
for (const c of children) {
  c.on("exit", (code) => {
    if (stopping) return;
    console.error(red(`\n${c === server ? "The world server" : "The app"} stopped (exit ${code}). Stopping the other one.`));
    stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

// Wait until both answer, then print the one link to use.
const until = async (url) => {
  for (let i = 0; i < 120; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
};
const ready = (await until(`http://127.0.0.1:${port}/`)) && (await until(`http://127.0.0.1:${appPort}/`));
if (!ready || stopping) {
  if (!stopping) console.error(red("The server or the app did not come up within a minute; see the output above."));
} else {
  let token = "";
  try {
    if (control) token = readFileSync(join(homedir(), ".aaw", "token"), "utf8").trim();
  } catch {
    // no token file: control is off
  }
  // After #, the token never reaches a server or a tunnel's logs. It is printed only to a terminal: under
  // autostart this output goes to ~/.aaw/logs/up.log.
  const q = token ? `#token=${encodeURIComponent(token)}` : "";
  const local = `http://localhost:${appPort}/${q}`;
  const shown = token && !process.stdout.isTTY ? `http://localhost:${appPort}/#token=<see ~/.aaw/token>` : local;
  console.log(`\n${green("✓ Running.")} Open ${bold(shown)}`);
  console.log(dim(`  Through a tunnel or from another device, forward port ${port} and open it with the same ${token ? "#token=…" : "link"}.`));
  if (trustLogin) {
    let where = tailnet?.dnsName ? `http://${tailnet.dnsName}/` : "http://<this-machine>.<tailnet>.ts.net/";
    let served = false;
    if (serveTailnet) {
      try {
        where = tailscaleServe(tailnetPort);
        served = true;
      } catch (e) {
        console.log(yellow(`  ! ${e instanceof Error ? e.message : String(e)}`));
      }
    }
    console.log(`  On your tailnet, as ${bold(trustLogin)} (no token): ${bold(where)}`);
    if (!served) console.log(dim(`  It needs: tailscale serve --bg --http=80 http://127.0.0.1:${tailnetPort}  (or run ${bold("npm run up:tailscale")})`));
  }
  console.log(dim("  Ctrl+C stops both."));
  if (open) openBrowser(local);
}
