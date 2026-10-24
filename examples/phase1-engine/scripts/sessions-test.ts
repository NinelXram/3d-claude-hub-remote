// Sessions extension checks (npm run test:sessions): transcripts, prompts, permission asks and the
// security rules around them. A real server and client; Claude itself is replaced by a scripted runner.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocketNode from "ws";
import { startWorldServer } from "../server/worldServer.ts";
import { createHookRoute } from "../server/hookRoute.ts";
import { SessionHub } from "../server/sessions/sessionHub.ts";
import { TranscriptTail, isAllowedTranscript, parseTranscriptLines } from "../server/sessions/transcript.ts";
import type { TranscriptImage } from "../server/sessions/transcript.ts";
import { promptContent } from "../server/sessions/claudeRunner.ts";
import type { RunOptions, Runner } from "../server/sessions/claudeRunner.ts";
import { LiveAgentBackend } from "../src/live/LiveAgentBackend.ts";
import { WebSocketAgentBackend } from "../src/integrations/WebSocketAgentBackend.ts";
import type { ExtraMessage } from "../src/integrations/WebSocketAgentBackend.ts";
import type { PermissionRequestInfo, PromptImage, SessionInfo, SessionItem } from "../src/integrations/AgentBackend.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "..", "server", "sessions", "fixtures", "real-transcript.jsonl");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(10);
  return cond();
}

console.log("\nTranscripts");
{
  const items = parseTranscriptLines(readFileSync(fixture, "utf8").split("\n"), new Map());
  const kinds = items.map((i) => i.kind);
  const tools = items.filter((i): i is Extract<SessionItem, { kind: "tool" }> => i.kind === "tool");
  check("a real transcript becomes prompt, text and tool items", kinds[0] === "user" && kinds.includes("assistant") && tools.length >= 5, kinds.join(","));
  check("each tool call carries its result", tools.every((t) => t.result !== undefined), tools.filter((t) => !t.result).map((t) => t.name).join(","));
  check("the failing test run is marked as an error-free call whose output shows the failure", tools.some((t) => t.name === "Bash" && /fail/.test(t.result?.text ?? "")));
  check("ToolSearch plumbing and thinking are left out", !tools.some((t) => t.name === "ToolSearch") && !items.some((i) => "text" in i && i.text.includes("signature")));
  check("the edit that fixed the bug is there", tools.some((t) => t.name === "Edit" && t.summary.endsWith("src/cart.js")));
}
{
  // Incremental: a tool result that arrives in a later write updates the same item.
  const dir = mkdtempSync(join(tmpdir(), "aaw-tail-"));
  const file = join(dir, "t.jsonl");
  const lines = readFileSync(fixture, "utf8").split("\n").filter(Boolean);
  const firstTool = lines.findIndex((l) => l.includes('"tool_use"') && !l.includes("ToolSearch"));
  writeFileSync(file, lines.slice(0, firstTool + 1).join("\n") + "\n");
  const tail = new TranscriptTail(file);
  const a = tail.poll();
  const pendingTool = a.find((i) => i.kind === "tool");
  appendFileSync(file, lines.slice(firstTool + 1).join("\n").slice(0, 30));
  const mid = tail.poll();
  appendFileSync(file, lines.slice(firstTool + 1).join("\n").slice(30) + "\n");
  const b = tail.poll();
  const updated = b.find((i) => i.id === pendingTool?.id);
  check("tailing returns only new items, waits for whole lines, and upserts tool results", !!pendingTool && pendingTool.kind === "tool" && !pendingTool.result && mid.length === 0 && !!updated && updated.kind === "tool" && !!updated.result);
}

{
  const ts = new Date().toISOString();
  const lines = [
    { type: "user", uuid: "u1", timestamp: ts, message: { content: "<ide_selection>The user selected lines 1 to 2 from /x.ts:\nfoo\n</ide_selection>\nfix this" } },
    { type: "user", uuid: "u2", timestamp: ts, message: { content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>" } },
    { type: "system", subtype: "local_command", uuid: "s1", timestamp: ts, content: "<command-name>/model</command-name>\n<command-args>opus</command-args>" },
    { type: "system", subtype: "local_command", uuid: "s2", timestamp: ts, content: "<local-command-stdout>Set model to Opus</local-command-stdout>" },
    { type: "system", subtype: "local_command", uuid: "s3", timestamp: ts, content: "<local-command-stdout></local-command-stdout>" },
  ].map((l) => JSON.stringify(l));
  const items = parseTranscriptLines(lines, new Map());
  const view = items.map((i) => `${i.kind}:${"text" in i ? i.text : ""}`);
  check("slash commands and their output become quiet notices; IDE selections are stripped from prompts",
    JSON.stringify(view) === JSON.stringify(["user:fix this", "notice:/clear", "notice:/model opus", "notice:Set model to Opus"]), JSON.stringify(view));
}

// Image payloads: only the leading bytes matter to the checks, the rest is padding.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]).toString("base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 3)]).toString("base64");

console.log("\nImages in transcripts");
{
  const ts = new Date().toISOString();
  const lines = [
    { type: "user", uuid: "p1", timestamp: ts, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }, { type: "text", text: "[Image #1] what is wrong here?" }] } },
    { type: "user", uuid: "p2", timestamp: ts, message: { content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: JPEG } }] } },
    { type: "user", uuid: "p3", timestamp: ts, isMeta: true, message: { content: [{ type: "text", text: "[Image: source: /tmp/1.png]" }] } },
  ].map((l) => JSON.stringify(l));
  const store = new Map<string, TranscriptImage>();
  const items = parseTranscriptLines(lines, new Map(), store);
  const first = items[0] as Extract<SessionItem, { kind: "user" }> | undefined;
  const second = items[1] as Extract<SessionItem, { kind: "user" }> | undefined;
  check("a prompt with an image carries a reference, not the bytes", first?.text === "[Image #1] what is wrong here?" && first.images?.length === 1 && first.images[0]!.mediaType === "image/png" && !JSON.stringify(items).includes(PNG), JSON.stringify(first));
  check("…and the bytes are kept aside under the same id", store.get(first?.images?.[0]?.id ?? "")?.data === PNG);
  check("a prompt that is only an image is still shown", items.length === 2 && second?.images?.[0]?.mediaType === "image/jpeg" && second.text === "", JSON.stringify(items));
  const plain = promptContent("hi");
  const mixed = promptContent("look", [{ mediaType: "image/png", data: PNG }]);
  const onlyImage = promptContent("  ", [{ mediaType: "image/png", data: PNG }]);
  check("prompts go to Claude as text, or as image blocks followed by the text",
    plain === "hi" && Array.isArray(mixed) && mixed.length === 2 && (mixed[0] as { type: string }).type === "image" && (mixed[1] as { type: string }).type === "text" && Array.isArray(onlyImage) && onlyImage.length === 1);
}

console.log("\nWhere transcripts may be read from");
const root = mkdtempSync(join(tmpdir(), "aaw-projects-"));
const project = join(root, "-tmp-demo");
mkdirSync(project);
const sessionId = "11111111-2222-3333-4444-555555555555";
const transcript = join(project, `${sessionId}.jsonl`);
// The recorded transcript ran in /private/tmp/aaw-live-target, which does not exist here. Point it at a folder that
// does, so the session is the same whether the hub learns its cwd from a hook or by discovering a fresh transcript.
writeFileSync(transcript, readFileSync(fixture, "utf8").replaceAll('"cwd": "/private/tmp/aaw-live-target"', `"cwd": ${JSON.stringify(project)}`));
{
  const outside = join(mkdtempSync(join(tmpdir(), "aaw-outside-")), "x.jsonl");
  writeFileSync(outside, "{}\n");
  let link = join(project, "escape.jsonl");
  try {
    symlinkSync(outside, link);
  } catch {
    // Windows without Developer Mode cannot make file symlinks; a directory junction escapes the same way.
    symlinkSync(dirname(outside), join(project, "escape-dir"), "junction");
    link = join(project, "escape-dir", "x.jsonl");
  }
  check("a transcript under the projects root is allowed", isAllowedTranscript(transcript, root));
  check("a file outside the root is refused", !isAllowedTranscript(outside, root));
  check("a symlink inside the root that points outside is refused", !isAllowedTranscript(link, root));
  check("non-.jsonl files are refused", !isAllowedTranscript(join(project), root));
}

// ── a scripted stand-in for Claude Code ──
interface FakeRun { options: RunOptions; prompts: string[]; images: PromptImage[][]; interrupted: boolean; closed: boolean; modes: string[] }
const runs: FakeRun[] = [];
const fakeRunner: Runner = (options) => {
  const run: FakeRun = { options, prompts: [options.firstPrompt], images: [options.firstImages ?? []], interrupted: false, closed: false, modes: [options.permissionMode] };
  runs.push(run);
  const id = options.resume && !options.fork ? options.resume : `web-${runs.length}`;
  setTimeout(() => options.onSession(id), 20);
  return {
    push: (t, im) => {
      run.prompts.push(t);
      run.images.push(im ?? []);
    },
    interrupt: async () => { run.interrupted = true; },
    setPermissionMode: async (m) => { run.modes.push(m); },
    close: () => { run.closed = true; },
  };
};

console.log("\nServer: access rules");
const live = new LiveAgentBackend({ autoTick: false });
await live.connect();
const hub = new SessionHub({ runner: fakeRunner, root, pollMs: 50 });
let threw = "";
try {
  await startWorldServer({ backend: live, port: 0, sessions: new SessionHub({ root }) });
} catch (e) {
  threw = (e as Error).message;
}
check("the sessions extension refuses to start without a token", threw.includes("needs a token"), threw);
const token = "test-token-123";
const server = await startWorldServer({ backend: live, port: 0, token, sessions: hub, http: createHookRoute({ live, onPayload: (p) => hub.noteHook(p) }) });
const httpUrl = server.url.replace(/^ws/, "http");
{
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocketNode(server.url, { origin: "https://evil.example" });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => { ws.close(); resolve(101); });
    ws.on("error", () => resolve(-1));
  });
  check("a WebSocket from another website's origin is refused (403)", status === 403, String(status));
  const okStatus = await new Promise<number>((resolve) => {
    const ws = new WebSocketNode(server.url, { origin: "http://localhost:3000" });
    ws.on("open", () => { ws.close(); resolve(101); });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
  });
  check("the app's own origin (http://localhost:3000) is accepted", okStatus === 101, String(okStatus));
  const evilHook = await fetch(`${httpUrl}/hook`, { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ hook_event_name: "Notification", session_id: "x", message: "fake" }) });
  check("a web page cannot post fake hook events (403)", evilHook.status === 403, String(evilHook.status));
  const noToken = new WebSocketAgentBackend({ url: server.url });
  const err = await noToken.connect().then(() => "connected", (e: Error) => e.message);
  check("with tokenScope \"all\", connecting without the token is refused", err.includes("token"), err);
}

console.log("\nServer: sessions");
const client = new WebSocketAgentBackend({ url: server.url, token });
const extras: ExtraMessage[] = [];
client.subscribeMessage((m) => extras.push(m));
await client.connect();
check("welcome advertises sessions and control", client.capabilities.sessions && client.capabilities.control);
{
  const hook = (p: object) => fetch(`${httpUrl}/hook`, { method: "POST", body: JSON.stringify(p) });
  await hook({ hook_event_name: "SessionStart", session_id: sessionId, transcript_path: transcript, cwd: project, source: "startup" });
  await hook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, transcript_path: transcript, cwd: project, prompt: "One test fails in this project.\nFix it." });
  await hook({ hook_event_name: "SessionStart", session_id: "evil", transcript_path: "/etc/hosts.jsonl", cwd: "/", source: "startup" });
  const list = await client.request<SessionInfo[]>({ name: "listSessions" });
  const s = list.find((x) => x.sessionId === sessionId);
  check("sessions are listed with their first prompt as title", !!s && s.title.startsWith("One test fails in this project.") && s.readable && s.owner === "terminal", JSON.stringify(s));
  check("a session whose transcript path is outside the root is not readable", list.find((x) => x.sessionId === "evil")?.readable === false);
  const evilOpen = await client.request({ name: "openSession", sessionId: "evil" }).then(() => "opened", (e: Error) => e.message);
  check("…and cannot be opened", evilOpen.includes("not available"), evilOpen);
  const unknown = await client.request({ name: "openSession", sessionId: "never-seen" }).then(() => "opened", (e: Error) => e.message);
  check("sessions the server never saw cannot be opened", unknown.includes("Unknown session"), unknown);

  const opened = await client.request<{ items: SessionItem[] }>({ name: "openSession", sessionId });
  check("opening a session returns its conversation so far", opened.items.length >= 10 && opened.items[0]?.kind === "user");
  appendFileSync(transcript, JSON.stringify({ type: "assistant", uuid: "appended-1", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "Appended while you watch." }] } }) + "\n");
  const got = await until(() => extras.some((m) => m.type === "sessionItems" && m.items.some((i) => i.kind === "assistant" && i.text === "Appended while you watch.")));
  check("new transcript lines stream to the open session", got);

  // An image you pasted in the terminal: the item streams with a reference, the bytes come on request.
  appendFileSync(transcript, JSON.stringify({ type: "user", uuid: "pasted-1", timestamp: new Date().toISOString(), message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }, { type: "text", text: "see this" }] } }) + "\n");
  await until(() => extras.some((m) => m.type === "sessionItems" && m.items.some((i) => i.id === "pasted-1")));
  const pasted = extras.flatMap((m) => (m.type === "sessionItems" ? m.items : [])).find((i) => i.id === "pasted-1") as Extract<SessionItem, { kind: "user" }> | undefined;
  const imageId = pasted?.images?.[0]?.id ?? "";
  const img = await client.request<{ mediaType: string; data: string }>({ name: "sessionImage", sessionId, imageId }).catch((e: Error) => ({ mediaType: "", data: e.message }));
  check("an image in the transcript streams as a reference and its bytes can be fetched", !!imageId && img.mediaType === "image/png" && img.data === PNG, img.data.slice(0, 80));
  const stranger = new WebSocketAgentBackend({ url: server.url, token });
  await stranger.connect();
  const notOpen = await stranger.request({ name: "sessionImage", sessionId, imageId }).then(() => "sent", (e: Error) => e.message);
  check("…but only by a connection that opened the session", notOpen.includes("Open the session first"), notOpen);
  await stranger.disconnect();
  const unknownImage = await client.request({ name: "sessionImage", sessionId, imageId: "nope" }).then(() => "sent", (e: Error) => e.message);
  check("an unknown image id is refused", unknownImage.includes("no longer available"), unknownImage);
}

console.log("\nServer: prompts and permission asks");
{
  const created = await client.request<{ sessionId: string; forked: boolean }>({ name: "sendPrompt", text: "Run the tests", cwd: project });
  const run = runs.at(-1)!;
  check("a prompt with a cwd starts a new web session there", created.sessionId === "web-1" && !created.forked && run.options.cwd === project && run.options.firstPrompt === "Run the tests");
  await client.request({ name: "sendPrompt", text: "And then the linter", sessionId: created.sessionId });
  check("a follow-up goes into the same running session", runs.length === 1 && run.prompts.at(-1) === "And then the linter");

  // Claude asks to run a command: the ask reaches the web UI, the answer reaches Claude.
  const controller = new AbortController();
  const answer = run.options.canUseTool({ toolName: "Bash", input: { command: "npm test" }, signal: controller.signal, title: "Claude wants to run npm test" });
  await until(() => extras.some((m) => m.type === "permission"));
  const ask = (extras.find((m) => m.type === "permission") as { request: PermissionRequestInfo }).request;
  check("the permission ask reaches the web UI with Claude's own wording", ask.toolName === "Bash" && ask.summary === "npm test" && ask.title === "Claude wants to run npm test");
  const statusWaiting = (await client.request<SessionInfo[]>({ name: "listSessions" })).find((x) => x.sessionId === "web-1")?.status;
  await client.request({ name: "respondPermission", requestId: ask.requestId, allow: true });
  check("answering Allow lets Claude proceed, and the session shows waiting meanwhile", (await answer) === true && statusWaiting === "waiting", String(statusWaiting));
  const again = await client.request({ name: "respondPermission", requestId: ask.requestId, allow: true }).then(() => "ok", (e: Error) => e.message);
  check("an ask can be answered only once", again.includes("no longer pending"));
  const deny = run.options.canUseTool({ toolName: "Bash", input: { command: "rm -rf build" }, signal: new AbortController().signal });
  await until(() => extras.filter((m) => m.type === "permission").length === 2);
  const ask2 = (extras.filter((m) => m.type === "permission")[1] as { request: PermissionRequestInfo }).request;
  await client.request({ name: "respondPermission", requestId: ask2.requestId, allow: false });
  check("answering Deny refuses the tool", (await deny) === false);
  const aborted = run.options.canUseTool({ toolName: "Edit", input: { file_path: "a" }, signal: controller.signal });
  controller.abort();
  check("an ask Claude abandons resolves as denied and is withdrawn from the UI", (await aborted) === false && (await until(() => extras.filter((m) => m.type === "permissionResolved").length === 3)));
  await client.request({ name: "interruptSession", sessionId: created.sessionId });
  check("Stop interrupts a web session", run.interrupted);

  // /clear in a web session: Claude Code restarts the conversation under a new id.
  // (The client that started web-1 is already subscribed to it.)
  run.options.onSession("web-1-after-clear");
  const moved = await until(() => extras.some((m) => m.type === "sessionMoved"));
  const mv = extras.find((m) => m.type === "sessionMoved") as { from: string; to: string } | undefined;
  const afterClear = await client.request<SessionInfo[]>({ name: "listSessions" });
  check("/clear moves the web session to its new id and tells the viewers",
    moved && mv?.from === "web-1" && mv.to === "web-1-after-clear" &&
    afterClear.find((x) => x.sessionId === "web-1")?.status === "ended" &&
    afterClear.find((x) => x.sessionId === "web-1-after-clear")?.owner === "web", JSON.stringify(mv));
  await client.request({ name: "sendPrompt", text: "after the clear", sessionId: "web-1-after-clear" });
  check("…and prompts keep going to the same process under the new id", runs.length === 1 && run.prompts.at(-1) === "after the clear");

  // Images from the web UI.
  const shot: PromptImage = { mediaType: "image/png", data: PNG };
  await client.request({ name: "sendPrompt", text: "what is this?", images: [shot], sessionId: "web-1-after-clear" });
  check("a follow-up can carry images", run.prompts.at(-1) === "what is this?" && run.images.at(-1)?.[0]?.data === PNG);
  await client.request({ name: "sendPrompt", text: "", images: [shot], sessionId: "web-1-after-clear" });
  check("a prompt may be only an image", run.images.at(-1)?.length === 1 && run.prompts.at(-1) === "");
  const refuse = (images: unknown) =>
    client.request({ name: "sendPrompt", text: "x", images: images as PromptImage[], sessionId: "web-1-after-clear" }).then(() => "sent", (e: Error) => e.message);
  const badType = await refuse([{ mediaType: "image/svg+xml", data: PNG }]);
  const lying = await refuse([{ mediaType: "image/jpeg", data: PNG }]);
  const notBase64 = await refuse([{ mediaType: "image/png", data: "not base64!" }]);
  const tooMany = await refuse(Array.from({ length: 9 }, () => shot));
  const tooBig = await refuse([{ mediaType: "image/png", data: PNG + "A".repeat(5 * 1024 * 1024) }]);
  check("images that are not PNG/JPEG/GIF/WebP, mislabelled, not base64, too many or too big are refused",
    badType.includes("only PNG") && lying.includes("not a JPEG") && notBase64.includes("base64") && tooMany.includes("At most 8") && tooBig.includes("too large"),
    [badType, lying, notBase64, tooMany, tooBig].join(" | "));
  check("…and a refused prompt never reaches Claude", run.prompts.at(-1) === "");

  const forked = await client.request<{ sessionId: string; forked: boolean }>({ name: "sendPrompt", text: "Continue from the web", sessionId });
  check("continuing a session still open in a terminal forks it instead of writing beside it", forked.forked && runs.at(-1)!.options.resume === sessionId && runs.at(-1)!.options.fork && forked.sessionId !== sessionId);
  await fetch(`${httpUrl}/hook`, { method: "POST", body: JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, reason: "prompt_input_exit" }) });
  const resumed = await client.request<{ sessionId: string; forked: boolean }>({ name: "sendPrompt", text: "Pick it back up", sessionId });
  check("once the terminal session has ended, it is continued in place", !resumed.forked && resumed.sessionId === sessionId && runs.at(-1)!.options.fork === false);

  const late = new WebSocketAgentBackend({ url: server.url, token });
  const lateExtras: ExtraMessage[] = [];
  late.subscribeMessage((m) => lateExtras.push(m));
  const pendingAsk = runs.at(-1)!.options.canUseTool({ toolName: "Write", input: { file_path: "x" }, signal: new AbortController().signal });
  await until(() => extras.filter((m) => m.type === "permission").length === 4);
  await late.connect();
  check("a client that connects later still sees the pending ask", await until(() => lateExtras.some((m) => m.type === "permission" && m.request.toolName === "Write")));
  const writeAsk = (lateExtras.find((m) => m.type === "permission" && m.request.toolName === "Write") as { request: PermissionRequestInfo }).request;
  await late.request({ name: "respondPermission", requestId: writeAsk.requestId, allow: false });
  await pendingAsk;
  await late.disconnect();
}

console.log("\nToken guards sessions only (--control without --token)");
{
  const scopedHub = new SessionHub({ runner: fakeRunner, root, pollMs: 50 });
  const scoped = await startWorldServer({ backend: live, port: 0, token, tokenScope: "sessions", sessions: scopedHub });
  const watcher = new WebSocketAgentBackend({ url: scoped.url });
  const seen: ExtraMessage[] = [];
  watcher.subscribeMessage((m) => seen.push(m));
  await watcher.connect();
  check("a tokenless connection still gets the world mirror", watcher.connection.state === "open" && watcher.getSnapshot() !== null);
  check("…marked locked, without sessions or control", watcher.capabilities.locked === true && !watcher.capabilities.sessions && !watcher.capabilities.control);
  const refused = await watcher.request({ name: "listSessions" }).then(() => "listed", (e: Error) => e.message);
  check("…and session commands are refused with how to unlock", refused.includes("token"), refused);
  const owner = new WebSocketAgentBackend({ url: scoped.url, token });
  const ownerSeen: ExtraMessage[] = [];
  owner.subscribeMessage((m) => ownerSeen.push(m));
  await owner.connect();
  await owner.request({ name: "sendPrompt", text: "hello", cwd: project });
  const ask = runs.at(-1)!.options.canUseTool({ toolName: "Bash", input: { command: "ls" }, signal: new AbortController().signal });
  await until(() => ownerSeen.some((m) => m.type === "permission"));
  await sleep(100);
  check("…and never receives session data such as permission asks, while the token holder does", seen.length === 0 && ownerSeen.some((m) => m.type === "permission"), seen.map((m) => m.type).join(","));
  const theAsk = (ownerSeen.find((m) => m.type === "permission") as { request: PermissionRequestInfo }).request;
  await owner.request({ name: "respondPermission", requestId: theAsk.requestId, allow: false });
  await ask;
  await owner.disconnect();
  const wrong = new WebSocketAgentBackend({ url: scoped.url, token: "typo" });
  const wrongErr = await wrong.connect().then(() => "connected", (e: Error) => e.message);
  check("a wrong token is still refused, so a typo is noticed", wrongErr.includes("token"), wrongErr);
  await watcher.disconnect();
  await scoped.close();
  scopedHub.dispose();
}

console.log("\nSessions opened before the server started");
{
  const earlier = new SessionHub({ root, pollMs: 50 });
  const listed = earlier.list();
  const s = listed.find((x) => x.sessionId === sessionId);
  check("recent transcripts are listed without waiting for a hook", !!s && s.readable && s.owner === "terminal" && s.title.startsWith("One test fails"), JSON.stringify(s));
  check("…as terminal sessions, so a prompt from the web forks them rather than writing beside them", s?.status === "idle");
  const old = new SessionHub({ root, pollMs: 50, discoverWithinMs: 1 });
  await sleep(5);
  old.discover();
  check("transcripts older than the window are left out", !old.list().some((x) => x.sessionId === sessionId) || old.list().length === 0);
  earlier.dispose();
  old.dispose();
}

console.log("\nOne port for a tunnel (--proxy-app)");
{
  const { createServer } = await import("node:http");
  const appStub = createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end(`app page ${req.url}`); });
  await new Promise<void>((r) => appStub.listen(0, "127.0.0.1", r));
  const appPort = (appStub.address() as { port: number }).port;
  const proxied = await startWorldServer({ backend: live, port: 0, token, tokenScope: "sessions", sessions: new SessionHub({ root, pollMs: 50, discoverWithinMs: 0 }), proxyApp: `http://127.0.0.1:${appPort}` });
  const base = proxied.url.replace(/^ws/, "http");
  const page = await (await fetch(`${base}/sessions?x=1`)).text();
  check("pages are served from the app through the world server", page === "app page /sessions?x=1", page);
  const tunnelHost = "abc-8787.example-tunnels.test";
  const open = (origin: string, hello: object) => new Promise<{ code: number; status?: number }>((resolve) => {
    const ws = new WebSocketNode(proxied.url, { origin, headers: { host: tunnelHost } });
    ws.on("unexpected-response", (_req, res) => resolve({ code: -1, status: res.statusCode }));
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("message", (raw) => { if (JSON.parse(String(raw)).type === "welcome") { ws.close(); resolve({ code: 0 }); } });
    ws.on("close", (code) => resolve({ code }));
  });
  const sameNoToken = await open(`https://${tunnelHost}`, { type: "hello", protocolVersion: 1 });
  check("a page from the tunnel (same origin as the server) without the token is refused, even for the 3D mirror", sameNoToken.code === 4401, JSON.stringify(sameNoToken));
  const sameToken = await open(`https://${tunnelHost}`, { type: "hello", protocolVersion: 1, token });
  check("…and with the token it connects", sameToken.code === 0, JSON.stringify(sameToken));
  const other = await open("https://evil.example", { type: "hello", protocolVersion: 1, token });
  check("another website is still refused (403)", other.status === 403, JSON.stringify(other));
  await proxied.close();
  appStub.close();
}

console.log("\nYour tailnet login instead of the token (--trust-tailscale)");
{
  const ts = await startWorldServer({ backend: live, port: 0, token, tokenScope: "sessions", sessions: new SessionHub({ runner: fakeRunner, root, pollMs: 50, discoverWithinMs: 0 }), tailnet: { port: 0, logins: ["Me@github"] } });
  check("a second loopback listener is opened for tailscale serve", typeof ts.tailnetPort === "number" && ts.tailnetPort !== ts.port, String(ts.tailnetPort));
  const host = "mac.example.ts.net";
  const open = (port: number, login: string | null, hello: object) => new Promise<{ code: number; status?: number; caps?: Record<string, unknown> }>((resolve) => {
    const headers: Record<string, string> = { host, "x-forwarded-host": host };
    if (login) headers["tailscale-user-login"] = login;
    const ws = new WebSocketNode(`ws://127.0.0.1:${port}`, { origin: `http://${host}`, headers });
    ws.on("unexpected-response", (_req, res) => resolve({ code: -1, status: res.statusCode }));
    ws.on("open", () => ws.send(JSON.stringify(hello)));
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "welcome") { ws.close(); resolve({ code: 0, caps: m.capabilities }); } });
    ws.on("close", (code) => resolve({ code }));
  });
  const hello = { type: "hello", protocolVersion: 1 };
  const mine = await open(ts.tailnetPort!, "me@github", hello);
  check("your login on the tailscale port connects without a token, with sessions and control", mine.code === 0 && mine.caps?.sessions === true && mine.caps?.control === true, JSON.stringify(mine));
  const stale = await open(ts.tailnetPort!, "me@github", { ...hello, token: "old-token" });
  check("…even when the page still carries an old token", stale.code === 0 && stale.caps?.sessions === true, JSON.stringify(stale));
  const someoneElse = await open(ts.tailnetPort!, "friend@github", hello);
  check("another tailnet login still needs the token", someoneElse.code === 4401, JSON.stringify(someoneElse));
  const noLogin = await open(ts.tailnetPort!, null, hello);
  check("no login (e.g. a tagged device) still needs the token", noLogin.code === 4401, JSON.stringify(noLogin));
  const forged = await open(ts.port, "me@github", hello);
  check("the same header on the main port (another tunnel could forge it) means nothing", forged.code === 4401, JSON.stringify(forged));
  await ts.close();
  const plain = await startWorldServer({ backend: live, port: 0, token, tokenScope: "sessions", sessions: new SessionHub({ root, pollMs: 50, discoverWithinMs: 0 }) });
  check("without --trust-tailscale there is no second listener", plain.tailnetPort === undefined);
  await plain.close();
}

console.log("\nLong transcripts and memory");
{
  const bigDir = join(root, "-tmp-big");
  mkdirSync(bigDir, { recursive: true });
  const bigId = "99999999-0000-0000-0000-000000000000";
  const big = join(bigDir, `${bigId}.jsonl`);
  const ts = new Date().toISOString();
  const lines = [JSON.stringify({ type: "user", uuid: "first", timestamp: ts, cwd: bigDir, message: { content: "Long session" } })];
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify({ type: "assistant", uuid: `a${i}`, timestamp: ts, message: { content: [{ type: "text", text: `reply ${i}` }] } }));
  writeFileSync(big, lines.join("\n") + "\n");
  const bigHub = new SessionHub({ root, pollMs: 50, idleEvictMs: 1, forgetAfterMs: 60_000 });
  const bigServer = await startWorldServer({ backend: live, port: 0, token, sessions: bigHub });
  const c = new WebSocketAgentBackend({ url: bigServer.url, token });
  await c.connect();
  const first = await c.request<{ items: SessionItem[]; earlier: number }>({ name: "openSession", sessionId: bigId });
  check("opening a long session sends only the latest 150 items and says how many are older",
    first.items.length === 150 && first.earlier === 251 && first.items.at(-1)?.kind === "assistant" && (first.items.at(-1) as { text: string }).text === "reply 399", `${first.items.length} / ${first.earlier}`);
  const older = await c.request<{ items: SessionItem[]; earlier: number }>({ name: "sessionHistory", sessionId: bigId, before: first.items[0]!.id, limit: 200 });
  check("older items page in before the first one shown", older.items.length === 200 && older.earlier === 51 && older.items.at(-1)!.id === "a249:0", `${older.items.length} / ${older.earlier}`);
  const kept = bigHub.collect(Date.now() + 10_000);
  check("a session someone is watching is never evicted", kept.evicted === 0);
  await c.request({ name: "closeSession", sessionId: bigId });
  await sleep(5);
  const freed = bigHub.collect(Date.now() + 10_000);
  check("once nobody watches, its parsed items are dropped", freed.evicted >= 1);
  const again = await c.request<{ items: SessionItem[]; earlier: number }>({ name: "openSession", sessionId: bigId });
  check("…and re-read from disk on the next open", again.items.length === 150 && again.earlier === 251);
  await c.request({ name: "closeSession", sessionId: bigId });
  const forgot = bigHub.collect(Date.now() + 120_000);
  const listed = (await c.request<SessionInfo[]>({ name: "listSessions" })).some((x) => x.sessionId === bigId);
  check("long-quiet sessions are forgotten entirely", forgot.forgotten >= 1 && !listed);
  await c.disconnect();
  await bigServer.close();
  bigHub.dispose();
}

console.log("\nPermission modes");
{
  const modeHub = new SessionHub({ runner: fakeRunner, root, pollMs: 50, discoverWithinMs: 0 });
  const ms = await startWorldServer({ backend: live, port: 0, token, sessions: modeHub });
  const c = new WebSocketAgentBackend({ url: ms.url, token });
  await c.connect();
  check("the server offers the five safe modes, not bypass", JSON.stringify(c.capabilities.permissionModes) === JSON.stringify(["default", "acceptEdits", "auto", "plan", "dontAsk"]), JSON.stringify(c.capabilities.permissionModes));
  const started = await c.request<{ sessionId: string }>({ name: "sendPrompt", text: "go", cwd: project, permissionMode: "acceptEdits" });
  const run = runs.at(-1)!;
  check("a new session starts in the chosen mode", run.options.permissionMode === "acceptEdits");
  const listed = (await c.request<SessionInfo[]>({ name: "listSessions" })).find((x) => x.sessionId === started.sessionId);
  check("…and the list shows it", listed?.permissionMode === "acceptEdits");
  await c.request({ name: "setPermissionMode", sessionId: started.sessionId, mode: "auto" });
  check("the mode changes mid-session without a restart", run.modes.at(-1) === "auto" && runs.at(-1) === run);
  await c.request({ name: "sendPrompt", text: "next", sessionId: started.sessionId, permissionMode: "plan" });
  check("a prompt can carry a new mode", run.modes.at(-1) === "plan" && run.prompts.at(-1) === "next");
  const noBypass = await c.request({ name: "setPermissionMode", sessionId: started.sessionId, mode: "bypassPermissions" }).then(() => "ok", (e: Error) => e.message);
  check("bypass is refused unless the server allows it", noBypass.includes("--allow-bypass"), noBypass);
  const defaultStart = await c.request<{ sessionId: string }>({ name: "sendPrompt", text: "plain", cwd: project });
  check("without a choice a session asks (default mode)", runs.at(-1)!.options.permissionMode === "default" && !!defaultStart.sessionId);
  await c.disconnect();
  await ms.close();
  modeHub.dispose();

  const bypassHub = new SessionHub({ runner: fakeRunner, root, pollMs: 50, discoverWithinMs: 0, allowBypass: true });
  const bs = await startWorldServer({ backend: live, port: 0, token, sessions: bypassHub });
  const b = new WebSocketAgentBackend({ url: bs.url, token });
  await b.connect();
  await b.request({ name: "sendPrompt", text: "go", cwd: project, permissionMode: "bypassPermissions" });
  check("with --allow-bypass, bypass is offered and used", !!b.capabilities.permissionModes?.includes("bypassPermissions") && runs.at(-1)!.options.permissionMode === "bypassPermissions");
  await b.disconnect();
  await bs.close();
  bypassHub.dispose();
}

console.log("\nRemoving finished sessions");
{
  const hiddenFile = join(mkdtempSync(join(tmpdir(), "aaw-hidden-")), "hidden-sessions.json");
  const rmHub = new SessionHub({ runner: fakeRunner, root, pollMs: 50, hiddenFile });
  const rs = await startWorldServer({ backend: live, port: 0, token, sessions: rmHub });
  const c = new WebSocketAgentBackend({ url: rs.url, token });
  const seen: ExtraMessage[] = [];
  c.subscribeMessage((m) => seen.push(m));
  await c.connect();
  const ids = async () => (await c.request<SessionInfo[]>({ name: "listSessions" })).map((x) => x.sessionId);
  const fail = (p: Promise<unknown>) => p.then(() => "ok", (e: Error) => e.message);
  check("a recent transcript is listed before removal", (await ids()).includes(sessionId));
  const branchOf = async () => (await c.request<SessionInfo[]>({ name: "listSessions" })).find((x) => x.sessionId === sessionId)?.gitBranch;
  const firstBranch = await branchOf();
  check("the list carries the session's git branch", firstBranch === "main", String(firstBranch));
  appendFileSync(transcript, JSON.stringify({ type: "system", subtype: "note", gitBranch: "feature/remove-sessions", timestamp: new Date().toISOString() }) + "\n");
  const later0 = (Date.now() + 2_000) / 1000;
  utimesSync(transcript, later0, later0);
  const switched = await branchOf();
  check("…and the latest one after a branch switch", switched === "feature/remove-sessions", String(switched));

  rmHub.noteHook({ hook_event_name: "UserPromptSubmit", session_id: "busy-1", cwd: project, prompt: "working" });
  const busy = await fail(c.request({ name: "removeSession", sessionId: "busy-1" }));
  check("a session in the middle of a turn cannot be removed", busy.includes("still working") && (await ids()).includes("busy-1"), busy);
  const unknown = await fail(c.request({ name: "removeSession", sessionId: "nope" }));
  check("removing an unknown session is refused", unknown.includes("Unknown session"), unknown);

  const before = seen.length;
  await c.request({ name: "removeSession", sessionId });
  check("a finished session is taken off the list", !(await ids()).includes(sessionId));
  check("…and every viewer gets the new list", seen.slice(before).some((m) => m.type === "sessions" && !m.sessions.some((x) => x.sessionId === sessionId)));
  check("…while its transcript stays on disk", readFileSync(transcript, "utf8").length > 0);
  rmHub.discover();
  rmHub.noteHook({ hook_event_name: "Stop", session_id: sessionId, cwd: project });
  rmHub.noteHook({ hook_event_name: "SessionEnd", session_id: sessionId, cwd: project });
  check("the minute rescan and its late Stop/SessionEnd do not bring it back", !(await ids()).includes(sessionId));
  check("the removal is saved to the hidden-sessions file", sessionId in (JSON.parse(readFileSync(hiddenFile, "utf8")) as Record<string, number>));

  const started = await c.request<{ sessionId: string }>({ name: "sendPrompt", text: "go", cwd: project });
  const run = runs.at(-1)!;
  rmHub.noteHook({ hook_event_name: "Stop", session_id: started.sessionId, cwd: project });
  await c.request({ name: "removeSession", sessionId: started.sessionId });
  check("removing an idle web session closes its Claude process", run.closed && !(await ids()).includes(started.sessionId));
  await c.disconnect();
  await rs.close();
  rmHub.dispose();

  const restarted = new SessionHub({ root, pollMs: 50, hiddenFile });
  check("after a server restart the removed session stays hidden", !restarted.list().some((x) => x.sessionId === sessionId));
  const later = (Date.now() + 5_000) / 1000;
  utimesSync(transcript, later, later);
  restarted.discover();
  check("new lines in its transcript bring it back", restarted.list().some((x) => x.sessionId === sessionId));
  restarted.remove(sessionId);
  restarted.noteHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: project, prompt: "again" });
  check("so does a new prompt in it", restarted.list().some((x) => x.sessionId === sessionId && x.status === "running"));
  restarted.dispose();
}

console.log("\nControl off");
{
  const readOnlyHub = new SessionHub({ root });
  const ro = await startWorldServer({ backend: live, port: 0, token, sessions: readOnlyHub });
  const c = new WebSocketAgentBackend({ url: ro.url, token });
  await c.connect();
  const err = await c.request({ name: "sendPrompt", text: "hi", cwd: project }).then(() => "sent", (e: Error) => e.message);
  check("without a runner the server reads transcripts but refuses prompts", c.capabilities.sessions && !c.capabilities.control && err.includes("--control"), err);
  await c.disconnect();
  await ro.close();
  readOnlyHub.dispose();
}

await client.disconnect();
await server.close();
hub.dispose();
await live.disconnect();
console.log(failures === 0 ? "\nAll sessions checks passed." : `\n${failures} sessions check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
