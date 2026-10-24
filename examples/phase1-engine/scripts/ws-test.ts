// WebSocket protocol checks (npm run test:ws): a real server on a random port, the real client.
import { startWorldServer } from "../server/worldServer.ts";
import { MockAgentBackend } from "../src/integrations/MockAgentBackend.ts";
import { WebSocketAgentBackend } from "../src/integrations/WebSocketAgentBackend.ts";
import { SimulationEngine } from "../src/simulation/SimulationEngine.ts";
import { SIM_CONFIG } from "../src/simulation/simulationConfig.ts";
import { DEMO_TASK } from "../src/tasks/taskActions.ts";
import type { AgentEvent } from "../src/events/eventTypes.ts";

const DT = 1 / SIM_CONFIG.tickHz;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(5);
  }
  return true;
}
const fingerprint = (e: AgentEvent) => `${e.type}|${e.agentId ?? ""}|${e.targetAgentId ?? ""}|${e.taskId ?? ""}|${e.simTime.toFixed(6)}|${e.message}`;

/** Raw socket helper for protocol-level cases the real client would never produce. */
function rawClose(url: string, hello: object): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => ws.send(JSON.stringify(hello)));
    ws.addEventListener("close", (ev) => resolve({ code: ev.code, reason: ev.reason }));
  });
}

console.log("\nWebSocket protocol v1");

// ── handshake, commands, parity with the in-process engine ──
{
  const backend = new MockAgentBackend(new SimulationEngine({ now: () => 0 }), { autoTick: false });
  await backend.connect();
  const server = await startWorldServer({ backend, port: 0 });
  const client = new WebSocketAgentBackend({ url: server.url });
  await client.connect();
  check("hello → welcome: label and simulated flag come from the server", client.label === "Local simulation" && client.simulated === true);
  check("welcome is followed by a full snapshot", (await until(() => client.getSnapshot() !== null)) && client.getSnapshot()!.agents.length === 6);

  const rejected = await client.setSpeed(3).then(() => "resolved", (e: Error) => e.message);
  check("a failing command comes back as ack ok:false with the error", rejected.includes("Unsupported speed"), rejected);

  const received: AgentEvent[] = [];
  client.subscribe((e) => received.push(e));
  await client.start();
  const task = await client.submitTask(DEMO_TASK);
  check("submitTask acks with the created task", task.id === "T-001" && task.phase === "queued");

  // Drive the server's engine as fast as possible; the client just listens.
  const engine = backend.engine;
  while (!engine.eventLog().some((e) => e.type === "task.completed")) engine.tick(DT);
  await until(() => received.some((e) => e.type === "task.completed"));

  const direct = new SimulationEngine({ now: () => 0 });
  const expected: AgentEvent[] = [];
  direct.events.subscribe((e) => expected.push(e));
  direct.start();
  direct.submitTask(DEMO_TASK);
  while (!expected.some((e) => e.type === "task.completed")) direct.tick(DT);
  const a = received.map(fingerprint), b = expected.map(fingerprint);
  const diff = a.findIndex((x, i) => x !== b[i]);
  check("event stream over the wire equals the in-process run", a.length === b.length && diff === -1, diff === -1 ? `${a.length} vs ${b.length}` : `first diff #${diff}`);
  await until(() => client.getSnapshot()?.tasks[0]?.phase === "done");
  check("the latest snapshot reaches the client after a burst", client.getSnapshot()?.tasks[0]?.phase === "done");

  const late = new WebSocketAgentBackend({ url: server.url });
  const lateEvents: AgentEvent[] = [];
  late.subscribe((e) => lateEvents.push(e));
  await late.connect();
  await until(() => lateEvents.some((e) => e.type === "task.completed"));
  check("a late client gets recent events replayed after its snapshot", lateEvents.some((e) => e.type === "task.created") && lateEvents.some((e) => e.type === "task.completed"));
  const count = lateEvents.length;
  server.dropClients();
  await until(() => late.connection.state === "reconnecting", 2000);
  await until(() => late.connection.state === "open", 3000);
  await sleep(200);
  check("…and a reconnect does not deliver the same events twice", lateEvents.length === count, `${count} → ${lateEvents.length}`);
  await late.disconnect();

  await client.disconnect();
  await server.close();
}

// ── refusals ──
{
  const backend = new MockAgentBackend(new SimulationEngine(), { autoTick: false });
  await backend.connect();
  const server = await startWorldServer({ backend, port: 0, token: "s3cret" });
  const wrongVersion = await rawClose(server.url, { type: "hello", protocolVersion: 99, token: "s3cret" });
  check("wrong protocol version closes with 4400 and a reason", wrongVersion.code === 4400 && wrongVersion.reason.includes("speaks 1"), `${wrongVersion.code} ${wrongVersion.reason}`);
  const noToken = await rawClose(server.url, { type: "hello", protocolVersion: 1 });
  check("missing token closes with 4401", noToken.code === 4401, `${noToken.code}`);
  const client = new WebSocketAgentBackend({ url: server.url, token: "nope" });
  const err = await client.connect().then(() => "connected", (e: Error) => e.message);
  check("client.connect() rejects instead of retrying when refused", err.includes("token") && client.connection.state === "closed", `${err} / ${client.connection.state}`);
  const good = new WebSocketAgentBackend({ url: server.url, token: "s3cret" });
  await good.connect();
  check("the right token is accepted", good.connection.state === "open");
  await good.disconnect();
  await server.close();
}

// ── snapshot rate and reconnect ──
{
  const backend = new MockAgentBackend(new SimulationEngine());
  await backend.connect();
  await backend.start();
  await backend.submitTask(DEMO_TASK);
  const server = await startWorldServer({ backend, port: 0 });
  const client = new WebSocketAgentBackend({ url: server.url, backoff: { initialMs: 50, maxMs: 400, jitter: 0.2 } });
  await client.connect();
  let snaps = 0;
  const off = client.subscribeSnapshot(() => snaps++);
  await sleep(1000);
  off();
  check("unsolicited snapshots are capped at 10 Hz while the engine ticks at 30 Hz", snaps >= 6 && snaps <= 11, `${snaps} in 1 s`);

  const states: string[] = [];
  client.subscribeConnection((s) => states.push(s.state));
  server.dropClients();
  await until(() => client.connection.state === "reconnecting", 2000);
  const pending = await client.setSpeed(2).then(() => "resolved", (e: Error) => e.message);
  check("commands reject with 'disconnected' while reconnecting", pending === "disconnected", pending);
  const back = await until(() => client.connection.state === "open", 3000);
  const before = client.getSnapshot()!.clock;
  await sleep(300);
  check("the client reconnects by itself and snapshots resume", back && client.getSnapshot()!.clock > before, states.join(" → "));

  await client.disconnect();
  await server.close();
  await backend.disconnect();
}

console.log(failures === 0 ? "\nAll WebSocket checks passed." : `\n${failures} WebSocket check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
