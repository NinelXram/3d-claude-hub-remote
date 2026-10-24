// Sessions extension checks (npm run test:sessions; also part of npm test).
// Drives the real WebSocketAgentBackend + sessionClient + useSessionStore against an in-memory fake socket
// that speaks the server's side of the protocol, plus the pure helpers the chat view and the bell use.
import { attentionOf, permissionEvent } from "../src/audio/attention.ts";
import { cueFor } from "../src/audio/soundEngine.ts";
import { firstLine, localVideoPath, markdownUrl, splitFences, splitInlineCode } from "../src/components/sessions/sessionText.ts";
import { fitWithin, isPromptImageType, roomFor, sendsAsIs, splitDataUrl } from "../src/components/sessions/promptImages.ts";
import type { ClientMessage, PermissionRequestInfo, ServerMessage, SessionInfo, SessionItem } from "../src/integrations/AgentBackend.ts";
import { sessionCommands, wireSessions } from "../src/integrations/sessionClient.ts";
import { takeTokenFromUrl } from "../src/integrations/tokenUrl.ts";
import { WebSocketAgentBackend } from "../src/integrations/WebSocketAgentBackend.ts";
import { upsertById, useSessionStore } from "../src/state/useSessionStore.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── pure helpers ─────────────────────────

console.log("Prompt images");
{
  check("a data URL splits into type and base64", JSON.stringify(splitDataUrl("data:image/png;base64,iVBO")) === JSON.stringify({ mediaType: "image/png", data: "iVBO" }) && splitDataUrl("https://x/y.png") === null);
  check("only PNG, JPEG, GIF and WebP are sendable types", isPromptImageType("image/webp") && !isPromptImageType("image/bmp") && !isPromptImageType("image/svg+xml"));
  check("a small PNG goes as-is; a huge, oversized or BMP one is re-encoded",
    sendsAsIs("image/png", 1000, 800, 600) && !sendsAsIs("image/png", 6 * 1024 * 1024, 800, 600) && !sendsAsIs("image/png", 1000, 4000, 3000) && !sendsAsIs("image/bmp", 1000, 10, 10));
  const fit = fitWithin(4000, 3000);
  check("scaling keeps the aspect ratio with the long side at 2000", fit.width === 2000 && fit.height === 1500 && JSON.stringify(fitWithin(300, 200)) === JSON.stringify({ width: 300, height: 200 }), JSON.stringify(fit));
  const room = roomFor(6, 5);
  check("at most 8 images per prompt, and the rest are reported", room.take === 2 && /3 left out/.test(room.note ?? "") && roomFor(0, 3).note === null, JSON.stringify(room));
}

console.log("Chat text");
{
  const segs = splitFences("Here:\n```ts\nconst a = 1;\n```\nDone.");
  check("a fenced block becomes one code segment with its language", segs.length === 3 && segs[1]!.code && segs[1]!.lang === "ts" && segs[1]!.text === "const a = 1;", JSON.stringify(segs));
  check("prose around it keeps its whitespace", segs[0]!.text === "Here:\n" && segs[2]!.text === "\nDone.");
  const open = splitFences("Start\n```\nstill streaming");
  check("an unclosed fence runs to the end", open.length === 2 && open[1]!.code && open[1]!.text === "still streaming", JSON.stringify(open));
  check("text without fences is one prose segment", splitFences("  a\n\n  b ").length === 1);
  check("markup stays text (no parsing)", splitFences("<img src=x onerror=alert(1)>")[0]!.text === "<img src=x onerror=alert(1)>");
  const inl = splitInlineCode("No, `npm test` fails in `a.js`.");
  check("inline code spans are split out", inl.length === 5 && inl[1]!.code && inl[1]!.text === "npm test" && !inl[4]!.code, JSON.stringify(inl));
  check("firstLine skips blank lines and caps", firstLine("\n\n  hello world  \nmore") === "hello world" && firstLine("x".repeat(200), 10).length === 10);
}

console.log("Token in the page URL");
{
  const frag = takeTokenFromUrl("https://box.ts.net/?tab=sessions#token=abc%2B1");
  check("#token=… is read and removed, keeping the rest of the URL", frag.token === "abc+1" && frag.cleaned === "/?tab=sessions", JSON.stringify(frag));
  const query = takeTokenFromUrl("http://localhost:3210/?token=xyz&tab=sessions#top");
  check("?token=… (older links) still works and is removed", query.token === "xyz" && query.cleaned === "/?tab=sessions#top", JSON.stringify(query));
  const both = takeTokenFromUrl("http://h/?token=old#token=new&x=1");
  check("the fragment wins over the query, both are removed", both.token === "new" && both.cleaned === "/#x=1", JSON.stringify(both));
  const none = takeTokenFromUrl("http://h/?tab=tasks#section");
  check("a URL without a token is left alone", none.token === null && none.cleaned === "/?tab=tasks#section", JSON.stringify(none));
}

console.log("Videos in Claude's replies");
{
  check("a relative path to a video is a local video", localVideoPath("video/out/intro.mp4") === "video/out/intro.mp4");
  check("so is a Windows absolute path", localVideoPath("C:/work/out/intro.webm") === "C:/work/out/intro.webm");
  check("…with backslashes", localVideoPath("C:\\work\\clip.mov") === "C:\\work\\clip.mov");
  check("so is a POSIX absolute path", localVideoPath("/Users/me/demo.m4v") === "/Users/me/demo.m4v");
  check("file:// URLs give their path", localVideoPath("file:///C:/work/a%20b.mp4") === "C:/work/a b.mp4" && localVideoPath("file:///home/me/x.mp4") === "/home/me/x.mp4");
  check("percent-encoded spaces are decoded", localVideoPath("out/my%20video.mp4") === "out/my video.mp4");
  check("extension case does not matter", localVideoPath("OUT/CLIP.MP4") === "OUT/CLIP.MP4");
  check("http(s) links are not local", localVideoPath("https://example.com/a.mp4") === null && localVideoPath("http://x/a.webm") === null);
  check("other schemes are not local", localVideoPath("javascript:alert(1)//.mp4") === null && localVideoPath("data:video/mp4;base64,AAAA.mp4") === null && localVideoPath("mailto:a@b.mp4") === null);
  check("non-video files are not videos", localVideoPath("out/notes.txt") === null && localVideoPath("out/image.png") === null && localVideoPath("out/") === null);
  check("a query or fragment after the name is ignored", localVideoPath("out/a.mp4#t=10") === "out/a.mp4");
  check("the Markdown URL filter keeps local videos and still blocks javascript:", markdownUrl("C:/x/a.mp4") === "C:/x/a.mp4" && markdownUrl("javascript:alert(1)") === "" && markdownUrl("https://a.b/c") === "https://a.b/c");
}

console.log("Store");
{
  const a: SessionItem = { kind: "user", id: "a", at: 1, text: "hi" };
  const b: SessionItem = { kind: "tool", id: "b", at: 2, name: "Bash", summary: "npm test", input: "{}" };
  const b2: SessionItem = { ...b, result: { text: "ok", isError: false } };
  const items = upsertById(upsertById([], [a, b]), [b2]);
  check("upsert replaces in place (a tool gains its result) and keeps order", items.length === 2 && items[1] === b2 && items[0] === a);
  check("upsert with nothing new returns the same array", upsertById(items, []) === items);
}

console.log("Attention");
{
  const ask: PermissionRequestInfo = { requestId: "r1", sessionId: "s1", toolName: "Bash", summary: "npm test", input: "{}", at: 0 };
  const e = permissionEvent(ask, 3);
  check("a web permission ask rings the attention bell in live mode", cueFor(e, "live") === "attention");
  check("…and reads “Permission needed”", attentionOf(e)?.badge === "⏳ Permission needed");
  check("…and never enters the feed", e.feed === false);
  const named = attentionOf(permissionEvent(ask, 3, 0, { project: "shop-api", title: "Add rate limiting" }));
  check("…and names its session and project, whichever session the robots follow", named?.session === "s1" && named.project === "shop-api" && named.body.startsWith("shop-api · Add rate limiting: "), named?.body);
}

// ───────────────────────── client ↔ fake server ─────────────────────────

const SESSION: SessionInfo = { sessionId: "s1", title: "Run the tests", cwd: "/tmp/p", status: "idle", owner: "terminal", lastActivity: 1, readable: true };

/** The server half: answers hello and commands like sessionHub + worldServer would. */
class FakeSocket extends EventTarget {
  static last: FakeSocket | null = null;
  static all: FakeSocket[] = [];
  sent: ClientMessage[] = [];
  capabilities = { sessions: true, control: true };
  /** Asks still pending on the "server", re-sent to every connection (like worldServer on welcome). */
  static pending: PermissionRequestInfo[] = [];
  static imageRequests = 0;
  url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.last = this;
    FakeSocket.all.push(this);
    setTimeout(() => this.dispatchEvent(new Event("open")), 0);
  }
  push(msg: ServerMessage): void {
    const ev = new MessageEvent("message", { data: JSON.stringify(msg) });
    this.dispatchEvent(ev);
  }
  send(raw: string): void {
    const msg = JSON.parse(raw) as ClientMessage;
    this.sent.push(msg);
    if (msg.type === "hello") {
      setTimeout(() => {
        this.push({ type: "welcome", protocolVersion: 1, label: "Claude Code", simulated: false, capabilities: this.capabilities });
        this.push({ type: "event", event: { id: "E1", type: "task.created", taskId: "T-001", timestamp: 0, simTime: 0, message: "T-001", severity: "info", feed: true, metadata: { session: "s1" } } });
        this.push({ type: "sessions", sessions: [SESSION] });
        for (const request of FakeSocket.pending) this.push({ type: "permission", request });
      }, 0);
      return;
    }
    const { id, command } = msg;
    const ack = (result?: unknown) => setTimeout(() => this.push({ type: "ack", id, ok: true, result }), 0);
    const nack = (error: string) => setTimeout(() => this.push({ type: "ack", id, ok: false, error }), 0);
    switch (command.name) {
      case "openSession":
        if (command.sessionId === "s1") ack({ session: SESSION, items: [{ kind: "user", id: "u1", at: 1, text: "Run the tests" }] });
        else if (command.sessionId === "fork1") nack("This session's transcript is not available yet.");
        else nack("Unknown session.");
        break;
      case "sendPrompt":
        if (command.sessionId === "s1") ack({ sessionId: "fork1", forked: true });
        else if (!command.cwd?.startsWith("/")) nack("A new session needs `cwd`: an absolute path to an existing directory.");
        else ack({ sessionId: "new1", forked: false });
        break;
      case "sessionImage":
        FakeSocket.imageRequests++;
        if (command.imageId === "img-1") ack({ mediaType: "image/png", data: "iVBORw0K" });
        else if (command.imageId === "evil") ack({ mediaType: "image/svg+xml", data: "PHN2Zz4=" });
        else nack("That image is no longer available; reopen the session.");
        break;
      case "sessionFile":
        if (command.path === "video/out/a.mp4") ack({ url: "/session-file/T1", mediaType: "video/mp4", size: 10, name: "a.mp4" });
        else if (command.path === "old-server.mp4") nack("unknown command sessionFile");
        else nack("Only files inside this session's folder can be played.");
        break;
      case "respondPermission":
        ack();
        setTimeout(() => this.push({ type: "permissionResolved", requestId: command.requestId, allowed: command.allow }), 0);
        break;
      default:
        ack();
    }
  }
  close(code = 1000, reason = ""): void {
    setTimeout(() => this.dispatchEvent(Object.assign(new Event("close"), { code, reason })), 0);
  }
}

console.log("Client");
{
  const b = new WebSocketAgentBackend({ url: "ws://fake", WebSocketImpl: FakeSocket as unknown as typeof WebSocket, backoff: { initialMs: 5, maxMs: 5, jitter: 0 } });
  const off = wireSessions(b);
  const st = useSessionStore.getState;
  await b.connect();
  await tick(5);
  check("capabilities are known after welcome", st().capabilities.sessions && st().capabilities.control);
  check("the session list arrives on connect", st().sessions.length === 1 && st().sessions[0]!.title === "Run the tests");
  check("task.created metadata.session maps the task to its session", st().taskSessions["T-001"] === "s1");

  await sessionCommands.open("s1");
  check("openSession loads the items from the ack", st().openId === "s1" && st().items.length === 1 && st().items[0]!.id === "u1");
  FakeSocket.last!.push({ type: "sessionItems", sessionId: "s1", items: [{ kind: "tool", id: "t1", at: 2, name: "Bash", summary: "npm test", input: "{}" }] });
  FakeSocket.last!.push({ type: "sessionItems", sessionId: "s1", items: [{ kind: "tool", id: "t1", at: 2, name: "Bash", summary: "npm test", input: "{}", result: { text: "1 failing", isError: true } }] });
  FakeSocket.last!.push({ type: "sessionItems", sessionId: "other", items: [{ kind: "user", id: "x", at: 3, text: "not mine" }] });
  await tick(1);
  const tool = st().items.find((i) => i.id === "t1");
  check("streamed items are upserted by id", st().items.length === 2 && tool?.kind === "tool" && tool.result?.isError === true);
  check("items of another session are ignored", !st().items.some((i) => i.id === "x"));

  const r = await sessionCommands.send("s1", "And now?");
  await tick(1);
  check("a prompt to a terminal session acks as forked and opens the fork", r.ok && r.forked === true && st().openId === "fork1");
  check("…whose transcript is retried, not shown as an error", st().openError === null);
  check("…and the original is closed", FakeSocket.last!.sent.some((m) => m.type === "command" && m.command.name === "closeSession" && m.command.sessionId === "s1"));

  const shot = { mediaType: "image/png" as const, data: "iVBORw0K" };
  await sessionCommands.send("fork1", "look", undefined, [shot]);
  const sentImg = FakeSocket.last!.sent.filter((m) => m.type === "command" && m.command.name === "sendPrompt").at(-1);
  check("a prompt sends its images with it", sentImg?.type === "command" && sentImg.command.name === "sendPrompt" && sentImg.command.images?.[0]?.data === "iVBORw0K", JSON.stringify(sentImg));
  await sessionCommands.send("fork1", "plain");
  const sentPlain = FakeSocket.last!.sent.filter((m) => m.type === "command" && m.command.name === "sendPrompt").at(-1);
  check("…and a prompt without images sends no images field (older servers keep working)", sentPlain?.type === "command" && sentPlain.command.name === "sendPrompt" && !("images" in sentPlain.command));
  const url1 = await sessionCommands.image("fork1", "img-1");
  const url2 = await sessionCommands.image("fork1", "img-1");
  check("an image of the session comes back as a data URL, fetched once", url1 === "data:image/png;base64,iVBORw0K" && url2 === url1 && FakeSocket.imageRequests === 1, `${url1} ${FakeSocket.imageRequests}`);
  const evil = await sessionCommands.image("fork1", "evil").then(() => "shown", (e: Error) => e.message);
  check("an image of a type the app does not show is refused (no SVG)", /Unsupported/.test(evil), evil);
  const gone = await sessionCommands.image("fork1", "gone").then(() => "shown", (e: Error) => e.message);
  const goneAgain = await sessionCommands.image("fork1", "gone").then(() => "shown", (e: Error) => e.message);
  check("a failed image is not cached, so it can be tried again", /no longer available/.test(gone) && /no longer available/.test(goneAgain) && FakeSocket.imageRequests === 4, String(FakeSocket.imageRequests));
  const video = await sessionCommands.video("fork1", "video/out/a.mp4").catch((e: Error) => e);
  check("a video of the session comes back as a URL on the world server", !(video instanceof Error) && video.src === "http://fake/session-file/T1" && video.name === "a.mp4" && video.mediaType === "video/mp4", video instanceof Error ? video.message : JSON.stringify(video));
  const sentFile = FakeSocket.last!.sent.filter((m) => m.type === "command" && m.command.name === "sessionFile").at(-1);
  check("…asked for with the session and the path as written", sentFile?.type === "command" && sentFile.command.name === "sessionFile" && sentFile.command.sessionId === "fork1" && sentFile.command.path === "video/out/a.mp4");
  const outside = await sessionCommands.video("fork1", "C:/elsewhere/b.mp4").then(() => "played", (e: Error) => e.message);
  check("a refused video passes on the server's reason", /inside this session's folder/.test(outside), outside);
  const old = await sessionCommands.video("fork1", "old-server.mp4").then(() => "played", (e: Error) => e.message);
  check("an older server gets a restart hint", /Restart it to update/.test(old), old);

  const bad = await sessionCommands.start("relative/dir", "hi");
  check("a refused new session returns the ack's error", !bad.ok && /absolute path/.test(bad.error ?? ""));
  const good = await sessionCommands.start("/tmp/p", "hi");
  check("a new session acks with its id and is opened", good.ok && good.sessionId === "new1" && st().openId === "new1");
  sessionCommands.close();
  check("Back closes the session", st().openId === null);

  const ask: PermissionRequestInfo = { requestId: "r1", sessionId: "s1", toolName: "Bash", summary: "npm test", input: "{}", at: 0 };
  FakeSocket.last!.push({ type: "permission", request: ask });
  FakeSocket.last!.push({ type: "permission", request: ask });
  await tick(1);
  check("a permission ask is added once", st().permissions.length === 1);
  const answer = await sessionCommands.respondPermission("r1", true);
  await tick(2);
  const sentAllow = FakeSocket.last!.sent.some((m) => m.type === "command" && m.command.name === "respondPermission" && m.command.allow === true && m.command.requestId === "r1");
  check("Allow sends respondPermission and the card goes", answer === null && sentAllow && st().permissions.length === 0);

  // A drop: asks held from before are stale; the server re-sends whatever is still pending.
  FakeSocket.last!.push({ type: "permission", request: { ...ask, requestId: "gone" } });
  await tick(1);
  const before = FakeSocket.all.length;
  FakeSocket.pending = [{ ...ask, requestId: "r2" }];
  FakeSocket.last!.close(1006, "drop");
  for (let i = 0; i < 50 && FakeSocket.all.length === before; i++) await tick(5);
  for (let i = 0; i < 50 && b.connection.state !== "open"; i++) await tick(5);
  await tick(5);
  check("after a reconnect only the re-sent asks remain", st().permissions.length === 1 && st().permissions[0]!.requestId === "r2", JSON.stringify(st().permissions.map((p) => p.requestId)));

  off();
  await b.disconnect();
}

console.log(failures === 0 ? "\nAll sessions checks passed." : `\n${failures} sessions check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
