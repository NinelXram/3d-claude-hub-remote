// Stage server checks: a real world server with scripted sessions, seen through a raw protocol v1 client.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startStage, STAGE_TOKEN } from "./server.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stage = await startStage({ port: 0, stepMs: 60 });
const traffic: string[] = [];
const messages: Record<string, unknown>[] = [];
const ws = new WebSocket(stage.url);
const acks = new Map<string, (m: Record<string, unknown>) => void>();
ws.on("message", (raw) => {
  const text = String(raw);
  traffic.push(text);
  const m = JSON.parse(text) as Record<string, unknown>;
  messages.push(m);
  if (m.type === "ack") acks.get(String(m.id))?.(m);
});
await new Promise<void>((r) => ws.on("open", () => r()));
ws.send(JSON.stringify({ type: "hello", protocolVersion: 1, token: STAGE_TOKEN }));
let n = 0;
function request<T>(command: Record<string, unknown>): Promise<T> {
  const id = `c${++n}`;
  return new Promise((resolve, reject) => {
    acks.set(id, (m) => (m.ok ? resolve(m.result as T) : reject(new Error(String(m.error)))));
    ws.send(JSON.stringify({ type: "command", id, command }));
  });
}
async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(20);
  return cond();
}

console.log("\nHandshake");
await until(() => messages.some((m) => m.type === "welcome"));
const welcome = messages.find((m) => m.type === "welcome") as { simulated?: boolean; capabilities?: { sessions?: boolean; control?: boolean } } | undefined;
check("welcome says live (simulated: false)", welcome?.simulated === false, JSON.stringify(welcome));
check("the token unlocks sessions and control", welcome?.capabilities?.sessions === true && welcome.capabilities.control === true);

console.log("\nAll sessions are listed from the start (the parallel-sessions scene shows 3 at once)");
{
  await sleep(300);
  const atStart = await request<{ sessionId: string }[]>({ name: "listSessions" });
  check("3 sessions are listed before play() starts", atStart.length === 3, String(atStart.length));
}

console.log("\nScripted sessions");
await stage.play();
type Info = { sessionId: string; title: string; cwd: string; gitBranch?: string; status: string };
const list = await request<Info[]>({ name: "listSessions" });
check("at least 3 sessions are listed", list.length >= 3, String(list.length));
check("every session has a branch", list.every((s) => !!s.gitBranch), JSON.stringify(list.map((s) => s.gitBranch)));
check("every cwd is under C:/demo/", list.every((s) => s.cwd.startsWith("C:/demo/")), JSON.stringify(list.map((s) => s.cwd)));
check("titles are the Vietnamese prompts, not placeholders", list.every((s) => !s.title.startsWith("Session ")), JSON.stringify(list.map((s) => s.title)));
for (const s of list) {
  const opened = await request<{ items: { kind: string }[] }>({ name: "openSession", sessionId: s.sessionId });
  check(`${s.cwd}: transcript has a prompt, a tool row and a reply`,
    opened.items.some((i) => i.kind === "user") && opened.items.some((i) => i.kind === "tool") && opened.items.some((i) => i.kind === "assistant"),
    opened.items.map((i) => i.kind).join(","));
}
const events = messages.filter((m) => m.type === "event").map((m) => (m.event as { type: string; agentId?: string }));
const busy = new Set(events.map((e) => e.agentId).filter(Boolean));
check("the robots act (events for at least 4 different agents)", busy.size >= 4, [...busy].join(","));

console.log("\nplay() runs the scenario once (a second call must not duplicate turns)");
{
  const count = async () => (await request<{ items: unknown[] }>({ name: "openSession", sessionId: list[0]!.sessionId })).items.length;
  const before = await count();
  await stage.play();
  await sleep(300);
  const after = await count();
  check("a second play() adds nothing to the transcripts", after === before, `${before} → ${after}`);
}

console.log("\nPrompt from the web, permission ask, Allow");
const target = list[0]!;
const png = readFileSync(join(import.meta.dirname, "assets", "screenshot.png")).toString("base64");
const sent = await request<{ sessionId: string; forked: boolean }>({ name: "sendPrompt", sessionId: target.sessionId, text: "Lỗi này ở đâu vậy?", images: [{ mediaType: "image/png", data: png }] });
check("the prompt is accepted", typeof sent.sessionId === "string" && sent.sessionId.length > 0, JSON.stringify(sent));
const gotAsk = await until(() => messages.some((m) => m.type === "permission"));
const ask = messages.find((m) => m.type === "permission") as { request: { requestId: string; toolName: string } } | undefined;
check("a permission ask arrives", gotAsk && ask?.request.toolName === "Bash", JSON.stringify(ask));
if (ask) await request({ name: "respondPermission", requestId: ask.request.requestId, allow: true });
const idle = await until(() => messages.some((m) => m.type === "sessions" && (m.sessions as Info[]).some((s) => s.sessionId === sent.sessionId && s.status === "idle")));
check("after Allow the turn ends (session idle)", idle);
const reopened = await request<{ items: { kind: string; images?: unknown[] }[] }>({ name: "openSession", sessionId: sent.sessionId });
check("the web turn shows the image, the tool run and a reply",
  reopened.items.some((i) => i.kind === "user" && (i.images?.length ?? 0) === 1) && reopened.items.filter((i) => i.kind === "assistant").length >= 2,
  reopened.items.map((i) => i.kind).join(","));

console.log("\nNothing from this machine leaks");
const all = traffic.join("\n");
const secrets: [string, string][] = [
  ["home dir", homedir()],
  ["home dir (forward slashes)", homedir().replaceAll("\\", "/")],
  ["username", userInfo().username],
  ["hostname", hostname()],
];
const tokenFile = join(homedir(), ".aaw", "token");
if (existsSync(tokenFile)) secrets.push(["real ~/.aaw/token", readFileSync(tokenFile, "utf8").trim()]);
for (const [name, value] of secrets) check(`no ${name} in the traffic`, !all.toLowerCase().includes(value.toLowerCase()));

ws.close();
await stage.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
