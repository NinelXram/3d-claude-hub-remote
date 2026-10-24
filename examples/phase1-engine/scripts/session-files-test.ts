// Videos from a session's folder (npm run test:session-files): which files the web UI may play, and the HTTP
// route that streams them. A real server and client; no Claude involved.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWorldServer } from "../server/worldServer.ts";
import { SessionHub } from "../server/sessions/sessionHub.ts";
import { LiveAgentBackend } from "../src/live/LiveAgentBackend.ts";
import { WebSocketAgentBackend } from "../src/integrations/WebSocketAgentBackend.ts";
import type { SessionFileInfo } from "../src/integrations/AgentBackend.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
// A refusal for the right reason: an unknown command (an older server) does not count.
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => (/unknown command/i.test(e.message) ? "" : e.message || "refused"));

// A session whose working folder holds a video, a text file and a junction that leads outside it.
const root = mkdtempSync(join(tmpdir(), "aaw-files-projects-"));
const cwd = mkdtempSync(join(tmpdir(), "aaw-files-cwd-"));
const outside = mkdtempSync(join(tmpdir(), "aaw-files-outside-"));
const VIDEO = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
mkdirSync(join(cwd, "out"));
writeFileSync(join(cwd, "out", "demo.mp4"), VIDEO);
writeFileSync(join(cwd, "notes.txt"), "secret");
writeFileSync(join(outside, "other.mp4"), VIDEO);
symlinkSync(outside, join(cwd, "link"), "junction");
const sessionId = "f11e5000-0000-4000-8000-000000000001";
const projectDir = join(root, "-files");
mkdirSync(projectDir);
const transcript = join(projectDir, `${sessionId}.jsonl`);
writeFileSync(transcript, JSON.stringify({ type: "user", uuid: "u1", timestamp: new Date().toISOString(), cwd, sessionId, message: { content: "make a video" } }) + "\n");

const token = "files-token";
const live = new LiveAgentBackend({ autoTick: false });
await live.connect();
const hub = new SessionHub({ root, pollMs: 50, discoverWithinMs: 0 });
hub.noteHook({ hook_event_name: "SessionStart", session_id: sessionId, transcript_path: transcript, cwd });
const server = await startWorldServer({ backend: live, port: 0, token, tokenScope: "sessions", sessions: hub });
const httpBase = server.url.replace(/^ws/, "http");
const client = new WebSocketAgentBackend({ url: server.url, token });
await client.connect();
const file = (path: string) => client.request<SessionFileInfo>({ name: "sessionFile", sessionId, path });

console.log("\nWhich files may be played");
check("a session that is not open is refused", (await refused(file("out/demo.mp4"))) !== "");
await client.request({ name: "openSession", sessionId });
const ok = await file("out/demo.mp4").catch((e: Error) => e);
check("a video inside the session's folder (relative path) is allowed", !(ok instanceof Error) && ok.mediaType === "video/mp4" && ok.size === VIDEO.length && ok.name === "demo.mp4", String(ok instanceof Error ? ok.message : JSON.stringify(ok)));
const abs = await file(join(cwd, "out", "demo.mp4").replaceAll("\\", "/")).catch((e: Error) => e);
check("…and by absolute path", !(abs instanceof Error) && abs.size === VIDEO.length, abs instanceof Error ? abs.message : "");
check("a file outside the folder is refused", (await refused(file(join(outside, "other.mp4")))) !== "");
check("../ out of the folder is refused", (await refused(file(`../${outside.split(/[\\/]/).pop()}/other.mp4`))) !== "");
check("a link inside the folder that leads outside is refused", (await refused(file("link/other.mp4"))) !== "");
check("a file that is not a video is refused", (await refused(file("notes.txt"))) !== "");
check("a missing video is refused", (await refused(file("out/missing.mp4"))) !== "");
check("a folder is refused", (await refused(file("out"))) !== "");
const noToken = new WebSocketAgentBackend({ url: server.url });
await noToken.connect();
check("a connection without the token is refused", (await refused(noToken.request({ name: "sessionFile", sessionId, path: "out/demo.mp4" }))) !== "");
await noToken.disconnect();

console.log("\nStreaming it over HTTP");
if (!(ok instanceof Error)) {
  const url = `${httpBase}${ok.url}`;
  check("the URL carries a ticket, not the token or the path", ok.url.startsWith("/session-file/") && !ok.url.includes(token) && !ok.url.includes("demo"), ok.url);
  const full = await fetch(url);
  const body = Buffer.from(await full.arrayBuffer());
  check("GET returns the whole file with its type", full.status === 200 && full.headers.get("content-type") === "video/mp4" && body.equals(VIDEO), `${full.status} ${full.headers.get("content-type")}`);
  check("…and says ranges are accepted", full.headers.get("accept-ranges") === "bytes");
  const part = await fetch(url, { headers: { range: "bytes=100-199" } });
  const partBody = Buffer.from(await part.arrayBuffer());
  check("a Range request returns 206 with exactly those bytes", part.status === 206 && part.headers.get("content-range") === `bytes 100-199/${VIDEO.length}` && partBody.equals(VIDEO.subarray(100, 200)), `${part.status} ${part.headers.get("content-range")}`);
  const open = await fetch(url, { headers: { range: "bytes=900-" } });
  check("an open-ended range runs to the end", open.status === 206 && Buffer.from(await open.arrayBuffer()).equals(VIDEO.subarray(900)));
  const bad = await fetch(url, { headers: { range: "bytes=5000-6000" } });
  check("a range past the end is 416", bad.status === 416);
  const wrong = await fetch(`${httpBase}/session-file/not-a-ticket`);
  check("an unknown ticket is 404", wrong.status === 404);
  const post = await fetch(url, { method: "POST" });
  check("only GET and HEAD are served", post.status === 405);
  await client.disconnect();
  await new Promise((r) => setTimeout(r, 150));
  const afterClose = await fetch(url);
  check("the link stops working once the page that asked for it disconnects", afterClose.status === 404, String(afterClose.status));
}

await client.disconnect();
await server.close();
hub.dispose();
await live.disconnect();
console.log(failures === 0 ? "\nAll session file checks passed." : `\n${failures} session file check(s) failed.`);
// Let the HTTP sockets close on their own: process.exit() while they close trips a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
