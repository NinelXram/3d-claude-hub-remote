// Black-box evaluation of an engine implementation (examples/phase1-engine or app): checks the behaviour the spec
// requires without trusting the implementation's own tests.
//
//   node --experimental-strip-types --no-warnings eval/phase1/evaluate.ts <project-dir> [--json]
//
// Uses only the API the prompt specifies (§3.5, §4.2, §4.5, §5): SimulationEngine with submitTask / tick /
// getTask / snapshot / start / stop / pause / pauseAgent / resumeAgent and an `events` bus; DEMO_TASK in
// src/tasks/taskActions.ts; SPRINT_TASKS in src/tasks/taskBacklog.ts; route() in src/simulation/worldLayout.ts.
// The project's own tests are not trusted here: these checks are independent and mostly stricter.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* eslint-disable @typescript-eslint/no-explicit-any -- the target is an unknown implementation */
type Any = any;

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const asJson = args.includes("--json");
const DT = 1 / 30;

/** Timings of the reference implementation (examples/phase1-engine), for comparison only. */
const REFERENCE = { demoSeconds: 72.9, sprintSeconds: 328.7, sprintDone: 7, demoComms: 8 };

interface Result { id: string; name: string; status: "pass" | "fail" | "error"; detail: string }
const results: Result[] = [];
const metrics: Record<string, number | string> = {};

async function load(rel: string): Promise<Any> {
  const file = resolve(dir, rel);
  if (!existsSync(file)) throw new Error(`missing ${rel}`);
  return import(pathToFileURL(file).href);
}

async function check(id: string, name: string, fn: () => Promise<[boolean, string?]> | [boolean, string?]): Promise<void> {
  try {
    const [ok, detail = ""] = await fn();
    results.push({ id, name, status: ok ? "pass" : "fail", detail });
  } catch (e) {
    results.push({ id, name, status: "error", detail: e instanceof Error ? e.message.split("\n")[0]! : String(e) });
  }
}

// ───────────────────────── adapters for details the prompt leaves open ─────────────────────────

function subscribe(engine: Any, fn: (e: Any) => void): void {
  const bus = engine.events;
  if (!bus) throw new Error("engine.events is missing (§4.2)");
  for (const m of ["subscribe", "on", "addListener", "listen"]) {
    if (typeof bus[m] === "function") {
      bus[m].length >= 2 ? bus[m]("*", fn) : bus[m](fn);
      return;
    }
  }
  throw new Error("engine.events has no subscribe/on/addListener method");
}

const snap = (engine: Any) => engine.snapshot();
const clockOf = (engine: Any): number => snap(engine).clock;
const isTerminal = (phase: string) => phase === "done" || phase === "failed";

function runUntil(engine: Any, done: () => boolean, maxSim: number): void {
  let guard = 0;
  while (!done() && clockOf(engine) < maxSim && guard++ < maxSim * 40) engine.tick(DT);
}

function phaseOrder(task: Any): string {
  const h = task.history ?? [];
  return [h[0]?.from ?? task.phase, ...h.map((x: Any) => x.to)].join(" → ");
}

const isComm = (e: Any) => e.targetAgentId != null && (e.type === "agent.message" || e.type === "task.assigned");
const fingerprint = (e: Any) => `${e.type}|${e.agentId ?? ""}|${e.targetAgentId ?? ""}|${e.taskId ?? ""}|${Number(e.simTime).toFixed(6)}|${e.message}`;

// ───────────────────────── checks ─────────────────────────

const { SimulationEngine } = await load("src/simulation/SimulationEngine.ts");
const { DEMO_TASK } = await load("src/tasks/taskActions.ts");
const backlog = await load("src/tasks/taskBacklog.ts");
const layout = await load("src/simulation/worldLayout.ts");

function demoRun(): { engine: Any; task: Any; events: Any[]; at: number } {
  const engine = new SimulationEngine();
  const events: Any[] = [];
  subscribe(engine, (e) => events.push(e));
  engine.start();
  const { id } = engine.submitTask(DEMO_TASK);
  runUntil(engine, () => isTerminal(engine.getTask(id).phase) && events.some((e) => e.type === "task.completed"), 400);
  return { engine, task: engine.getTask(id), events, at: clockOf(engine) };
}

const first = demoRun();
metrics.demoSeconds = Number(first.at.toFixed(1));

await check("demo.order", "Demo phase order is exact (§4.5)", () => {
  const expected = "queued → intake → planning → research → implementation → testing → implementation → testing → review → done";
  return [phaseOrder(first.task) === expected, phaseOrder(first.task)];
});
await check("demo.result", "Demo ends done, iteration 2, progress 1, all subtasks done", () => {
  const t = first.task;
  return [t.phase === "done" && t.iteration === 2 && t.progress === 1 && t.subtasks.length > 0 && t.subtasks.every((s: Any) => s.done), `${t.phase} it${t.iteration} p${t.progress}`];
});
await check("demo.time", "Demo finishes in the stated 60–80 sim s (§4.3/§4.5)", () => [first.at >= 60 && first.at <= 80, `${first.at.toFixed(1)} s (reference ${REFERENCE.demoSeconds} s)`]);
await check("demo.comms", "Exactly one communication event per talk: 8 in the demo (§3.4)", () => {
  const n = first.events.filter(isComm).length;
  metrics.demoComms = n;
  return [n === REFERENCE.demoComms, `${n}`];
});
await check("demo.messages", "agent.message text does not repeat sender/receiver (§3.4)", () => {
  const bad = first.events.filter((e) => e.type === "agent.message" && /\b\w+ → \w+:/.test(e.message));
  return [bad.length === 0, bad[0]?.message ?? ""];
});
await check("demo.links", "CommLink lives max(talk, linkDuration ≥ 2.4 s) and has a valid kind (§4.2)", () => {
  const engine = new SimulationEngine();
  engine.start();
  engine.submitTask(DEMO_TASK);
  const seen = new Map<string, Any>();
  runUntil(engine, () => clockOf(engine) > 30, 31);
  // Collect links from snapshots while running a bit more.
  for (let i = 0; i < 30 * 40; i++) {
    engine.tick(DT);
    for (const l of snap(engine).links ?? []) seen.set(l.id, l);
  }
  const links = [...seen.values()];
  const short = links.filter((l) => l.endsAt - l.startedAt < 2.4 - 1e-9);
  const kinds = links.filter((l) => !["message", "assign", "report"].includes(l.kind));
  return [links.length > 0 && short.length === 0 && kinds.length === 0, `${links.length} links, ${short.length} too short, ${kinds.length} bad kind`];
});

await check("determinism", "Two fresh runs produce the identical event sequence (§9.3)", () => {
  const second = demoRun();
  const a = first.events.map(fingerprint), b = second.events.map(fingerprint);
  const i = a.findIndex((x, k) => x !== b[k]);
  return [a.length === b.length && i === -1, i === -1 ? `${a.length} vs ${b.length} events` : `first diff #${i}`];
});

await check("route.same", "route(p, p) is empty (§5, pitfall 11)", () => {
  const p = { x: 6.5, z: -3.75 };
  const r = layout.route(p, p);
  return [Array.isArray(r) && r.length === 0, JSON.stringify(r)];
});

await check("stop", "stop() → ready, keeps clock and tasks; start() continues (§4.2)", () => {
  const engine = new SimulationEngine();
  engine.start();
  const { id } = engine.submitTask(DEMO_TASK);
  runUntil(engine, () => clockOf(engine) > 5, 6);
  engine.stop();
  const s1 = snap(engine);
  for (let i = 0; i < 30; i++) engine.tick(DT);
  const s2 = snap(engine);
  engine.start();
  for (let i = 0; i < 30; i++) engine.tick(DT);
  const s3 = snap(engine);
  const ok = s1.status === "ready" && s2.clock === s1.clock && s2.tasks.length === 1 && engine.getTask(id) && s3.status === "running" && s3.clock > s2.clock;
  return [Boolean(ok), `status ${s1.status}, clock ${s1.clock.toFixed(2)}→${s2.clock.toFixed(2)}→${s3.clock.toFixed(2)}`];
});

await check("block.handoff", "A task handed to a paused agent is blocked, then resumes (§4.3)", () => {
  const engine = new SimulationEngine();
  engine.start();
  engine.pauseAgent("kai");
  const { id } = engine.submitTask(DEMO_TASK);
  runUntil(engine, () => engine.getTask(id).phase === "implementation", 120);
  for (let i = 0; i < 60; i++) engine.tick(DT);
  const blocked = engine.getTask(id);
  engine.resumeAgent("kai");
  runUntil(engine, () => isTerminal(engine.getTask(id).phase), 400);
  const end = engine.getTask(id);
  return [blocked.phase === "implementation" && blocked.status === "blocked" && end.phase === "done", `${blocked.phase}/${blocked.status} → ${end.phase}`];
});

await check("concurrency", "Critical reaches Kai before medium; low waits (§4.3, §9.5)", () => {
  const engine = new SimulationEngine();
  const starts: string[] = [];
  subscribe(engine, (e) => { if (e.type === "implementation.started") starts.push(e.taskId); });
  engine.start();
  const low = engine.submitTask({ title: "Export audit log to CSV and Parquet", priority: "low" });
  const med = engine.submitTask({ title: "Full-text search for project documents", priority: "medium" });
  const crit = engine.submitTask({ title: "Fix memory leak in the image-processing worker", priority: "critical" });
  engine.tick(DT);
  const after1 = [crit, med, low].map((t) => engine.getTask(t.id).phase);
  runUntil(engine, () => [low, med, crit].every((t) => isTerminal(engine.getTask(t.id).phase)), 1500);
  const order = starts.indexOf(crit.id) < starts.indexOf(med.id) && starts.indexOf(crit.id) !== -1;
  const ok = after1[0] !== "queued" && after1[1] !== "queued" && after1[2] === "queued" && order && [low, med, crit].every((t) => isTerminal(engine.getTask(t.id).phase));
  return [ok, `after 1 tick ${after1.join("/")}, impl order ${starts.join(",")}`];
});

await check("one.job", "No agent ever works on two tasks at once (§4.3)", () => {
  const engine = new SimulationEngine();
  engine.start();
  for (const t of backlog.SPRINT_TASKS) engine.submitTask(t);
  let violations = 0, sample = "";
  const working = new Map<string, string>();
  for (let i = 0; i < 30 * 600; i++) {
    engine.tick(DT);
    const s = snap(engine);
    for (const a of s.agents) {
      if (!["working", "thinking"].includes(a.status) || !a.currentTaskId) { working.delete(a.id); continue; }
      const prev = working.get(a.id);
      // Switching task mid-work without passing through a non-working status is a preemption.
      if (prev && prev !== a.currentTaskId) { violations++; sample ||= `${a.id}: ${prev} → ${a.currentTaskId} at ${s.clock.toFixed(1)}s`; }
      working.set(a.id, a.currentTaskId);
    }
    if (s.tasks.every((t: Any) => isTerminal(t.phase))) break;
  }
  return [violations === 0, violations ? sample : "no preemption seen"];
});

await check("sprint", "Sprint terminates; hot-fix done at it3; migration failed; ≥5/8 done (§9.6)", () => {
  const engine = new SimulationEngine();
  engine.start();
  const ids = backlog.SPRINT_TASKS.map((t: Any) => engine.submitTask(t).id);
  runUntil(engine, () => ids.every((id: string) => isTerminal(engine.getTask(id).phase)), 3000);
  const tasks = ids.map((id: string) => engine.getTask(id));
  const hot = tasks.find((t: Any) => /session token leak/i.test(t.title));
  const mig = tasks.find((t: Any) => /billing cron/i.test(t.title));
  const done = tasks.filter((t: Any) => t.phase === "done").length;
  metrics.sprintSeconds = Number(clockOf(engine).toFixed(1));
  metrics.sprintDone = done;
  const ok = tasks.every((t: Any) => isTerminal(t.phase)) && hot?.phase === "done" && hot?.iteration === 3 && mig?.phase === "failed" && done >= 5;
  return [ok, `${done}/8 done at ${clockOf(engine).toFixed(1)} s (reference ${REFERENCE.sprintDone}/8 at ${REFERENCE.sprintSeconds} s)`];
});

await check("random.never.fails", "Unscripted tasks always ship (random outcomes spare the last iteration) (§4.2)", () => {
  const unscripted = backlog.TASK_BACKLOG.filter((t: Any) => !t.script).slice(0, 6);
  const engine = new SimulationEngine();
  engine.start();
  const ids = unscripted.map((t: Any) => engine.submitTask(t).id);
  runUntil(engine, () => ids.every((id: string) => isTerminal(engine.getTask(id).phase)), 3000);
  const failed = ids.filter((id: string) => engine.getTask(id).phase !== "done");
  return [failed.length === 0, failed.length ? `${failed.length} did not ship` : `${ids.length} shipped`];
});

// ───────────────────────── report ─────────────────────────

const passed = results.filter((r) => r.status === "pass").length;
if (asJson) {
  console.log(JSON.stringify({ dir, passed, total: results.length, metrics, results }, null, 2));
} else {
  console.log(`\nPhase 1 evaluation: ${dir}\n`);
  for (const r of results) console.log(`  ${r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "!"} ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
  console.log(`\n${passed}/${results.length} passed · demo ${metrics.demoSeconds} s · sprint ${metrics.sprintSeconds ?? "?"} s, ${metrics.sprintDone ?? "?"}/8 done`);
}
process.exit(passed === results.length ? 0 : 1);
