// Security checks for the world server as people run it (npm run test:security): the hook endpoint, who counts as
// remote, transcript paths, and what reaches the logs. No Claude involved.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { startWorldServer } from "../server/worldServer.ts";
import { SessionHub } from "../server/sessions/sessionHub.ts";
import { createHookRoute } from "../server/hookRoute.ts";
import { isAllowedTranscript } from "../server/sessions/transcript.ts";
import { LiveAgentBackend } from "../src/live/LiveAgentBackend.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a WebSocket with the given headers, says hello, and reports the welcome or the close code. */
function hello(url: string, headers: Record<string, string>, token?: string): Promise<{ code: number; sessions?: boolean }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, ...(token ? { token } : {}) })));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw)) as { type: string; capabilities?: { sessions?: boolean } };
      if (m.type === "welcome") {
        ws.close();
        resolve({ code: 0, sessions: m.capabilities?.sessions });
      }
    });
    ws.on("unexpected-response", (_req, res) => resolve({ code: -(res.statusCode ?? 1) }));
    ws.on("close", (code) => resolve({ code }));
    ws.on("error", () => {});
  });
}

console.log("\nTranscript paths are checked before the file system is touched");
{
  const root = mkdtempSync(join(tmpdir(), "aaw-sec-root-"));
  const started = Date.now();
  const unc = isAllowedTranscript("\\\\aaw-test-host.invalid\\share\\x.jsonl", root);
  const forward = isAllowedTranscript("//aaw-test-host.invalid/share/x.jsonl", root);
  const elapsed = Date.now() - started;
  // On Windows, touching a UNC path makes the machine contact that host (and offer its credentials); that takes seconds.
  check("a UNC path is refused at once, without contacting the host", !unc && !forward && elapsed < 300, `${elapsed} ms`);
  check("a path outside the root is refused", !isAllowedTranscript(join(tmpdir(), "elsewhere.jsonl"), root));
}

console.log("\nWho counts as remote (and needs the token)");
{
  const live = new LiveAgentBackend({ autoTick: false });
  await live.connect();
  const root = mkdtempSync(join(tmpdir(), "aaw-sec-hub-"));
  const server = await startWorldServer({
    backend: live, port: 0, token: "sec-token", tokenScope: "sessions",
    sessions: new SessionHub({ root, discoverWithinMs: 0 }), tailnet: { port: 0, logins: ["me@github"] }, http: createHookRoute({ live }),
  });
  const local = await hello(server.url, {});
  check("a local script with no Origin still watches the world without the token", local.code === 0 && local.sessions === false, JSON.stringify(local));
  const proxied = await hello(server.url, { "x-forwarded-for": "203.0.113.9" });
  check("a client that came through a proxy or tunnel (X-Forwarded-For) needs the token", proxied.code === 4401, JSON.stringify(proxied));
  const proxiedHost = await hello(server.url, { "x-forwarded-host": "box.devtunnels.ms" });
  check("…also with only X-Forwarded-Host", proxiedHost.code === 4401, JSON.stringify(proxiedHost));
  const cf = await hello(server.url, { "cf-connecting-ip": "203.0.113.9" });
  check("…and through Cloudflare (CF-Connecting-IP)", cf.code === 4401, JSON.stringify(cf));
  const tailnetPeer = await hello(`ws://127.0.0.1:${server.tailnetPort}`, {});
  check("a tailnet peer without your login and without an Origin needs the token", tailnetPeer.code === 4401, JSON.stringify(tailnetPeer));
  const mine = await hello(`ws://127.0.0.1:${server.tailnetPort}`, { "tailscale-user-login": "me@github" });
  check("your own tailnet login still needs no token", mine.code === 0 && mine.sessions === true, JSON.stringify(mine));
  const withToken = await hello(server.url, { "x-forwarded-for": "203.0.113.9" }, "sec-token");
  check("a proxied client with the token gets in", withToken.code === 0 && withToken.sessions === true, JSON.stringify(withToken));
  const hookish = await fetch(`${server.url.replace(/^ws/, "http")}/hookX`, { method: "POST", body: "{}" });
  check("only /hook itself is the hook endpoint (/hookX is not)", hookish.status === 404, String(hookish.status));
  const broken = await fetch(`${server.url.replace(/^ws/, "http")}/nothing`);
  check("unknown paths answer 404 without internals", broken.status === 404);
  await server.close();
  await live.disconnect();
}

console.log("\nnpm run server -- --source claude-code --control (as `npm run up` starts it)");
{
  // A throwaway home, so the server makes its own token there and never touches the real ~/.aaw.
  const home = mkdtempSync(join(tmpdir(), "aaw-sec-home-"));
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(here, "..", "server", "main.ts"), "--source", "claude-code", "--control", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (out += String(d)));
  const end = Date.now() + 20_000;
  while (!/websocket\s+ws:\/\/\S+/.test(out) && Date.now() < end) await sleep(50);
  const wsUrl = /websocket\s+(ws:\/\/\S+)/.exec(out)?.[1];
  check("the server starts", !!wsUrl, out.slice(-400));
  if (wsUrl) {
    await sleep(200);
    const token = readFileSync(join(home, ".aaw", "token"), "utf8").trim();
    check("the token is not printed when the output is not a terminal (logs)", !out.includes(token), "token found in the output");
    const hook = `${wsUrl.replace(/^ws/, "http")}/hook`;
    const planted = { hook_event_name: "SessionStart", session_id: "planted-0000-4000-8000-000000000001", cwd: "C:/attacker-picked", transcript_path: join(home, "x.jsonl") };
    await fetch(hook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(planted) });
    const signed = { ...planted, session_id: "signed-0000-4000-8000-000000000002" };
    await fetch(hook, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(signed) });
    await sleep(200);
    const listed = await new Promise<string[]>((resolve) => {
      const ws = new WebSocket(wsUrl);
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, token })));
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw)) as { type: string; sessions?: { sessionId: string }[] };
        if (m.type === "sessions") {
          ws.close();
          resolve((m.sessions ?? []).map((s) => s.sessionId));
        }
      });
      setTimeout(() => resolve(["(timeout)"]), 5000);
    });
    check("a hook without the token is ignored (no planted session)", !listed.includes(planted.session_id), JSON.stringify(listed));
    check("a hook with the token is accepted", listed.includes(signed.session_id), JSON.stringify(listed));
  }
  child.kill();
}

console.log("\nThe hook forwarder sends the token");
{
  const script = readFileSync(join(here, "..", "bridge", "forward-hook.sh"), "utf8");
  check("forward-hook.sh falls back to ~/.aaw/token when AAW_TOKEN is unset", /\.aaw\/token/.test(script));
}

console.log(failures === 0 ? "\nAll security checks passed." : `\n${failures} security check(s) failed.`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode ?? 0), 100);
