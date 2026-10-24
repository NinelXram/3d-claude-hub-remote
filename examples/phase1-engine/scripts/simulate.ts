// Headless engine checks (npm test). Plain Node, no framework: prints ✓/✗ and exits 1 on failure.
import { SimulationEngine } from "../src/simulation/SimulationEngine.ts";
import { canTransition, isTerminal } from "../src/simulation/WorkflowStateMachine.ts";
import { GENERIC_TEMPLATE, templateFor } from "../src/simulation/workContent.ts";
import { SIM_CONFIG } from "../src/simulation/simulationConfig.ts";
import { AGENTS } from "../src/agents/AgentRegistry.ts";
import { isCommunication } from "../src/events/eventTypes.ts";
import type { AgentEvent } from "../src/events/eventTypes.ts";
import { DEMO_TASK } from "../src/tasks/taskActions.ts";
import { HOTFIX_TITLE, MIGRATION_TITLE, SPRINT_TASKS, TASK_BACKLOG, pickRandomTask } from "../src/tasks/taskBacklog.ts";
import type { Task } from "../src/tasks/taskTypes.ts";
import { CORRIDOR_Z, route, slotFor } from "../src/simulation/worldLayout.ts";

const DT = 1 / SIM_CONFIG.tickHz;
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

function runUntil(engine: SimulationEngine, done: () => boolean, maxSim: number): void {
  while (!done() && engine.getClock() < maxSim) engine.tick(DT);
}

function phaseOrder(t: Task): string {
  return [t.history[0]?.from ?? t.phase, ...t.history.map((h) => h.to)].join(" → ");
}

/** The parts of an event that must be identical across runs (wall-clock timestamp excluded). */
const fingerprint = (e: AgentEvent) => `${e.type}|${e.agentId ?? ""}|${e.targetAgentId ?? ""}|${e.taskId ?? ""}|${e.simTime.toFixed(6)}|${e.message}`;

function runDemo(): { engine: SimulationEngine; task: Task; events: AgentEvent[]; finishedAt: number } {
  const engine = new SimulationEngine({ now: () => 0 });
  const events: AgentEvent[] = [];
  engine.events.subscribe((e) => events.push(e));
  engine.emitBootEvents();
  engine.start();
  const { id } = engine.submitTask(DEMO_TASK);
  runUntil(engine, () => isTerminal(engine.getTask(id)!.phase) && events.some((e) => e.type === "task.completed"), 300);
  return { engine, task: engine.getTask(id)!, events, finishedAt: engine.getClock() };
}

// 1 ───────────────────────────────────────────────
section("1. State machine");
check("testing --tests_failed--> allowed", canTransition("testing", "tests_failed"));
check("queued --approved--> rejected", !canTransition("queued", "approved"));
check("done is terminal", isTerminal("done") && !canTransition("done", "abort"));
{
  const dev = slotFor("dev", 0).position;
  check("route() to where you already stand is empty", route(dev, dev).length === 0);
  const r = route(slotFor("research", 0).position, dev);
  check("route() goes via the corridor", r.length === 3 && r[0]!.z === CORRIDOR_Z && r[1]!.z === CORRIDOR_Z);
}

// 2 ───────────────────────────────────────────────
section("2. Demo workflow");
const first = runDemo();
const types = new Set(first.events.map((e) => e.type));
const boot = first.events.filter((e) => e.type === "system.ready" || (e.type === "agent.arrived" && e.metadata?.["boot"]));
check("boot events ≥ 3", boot.length >= 3, `${boot.length}`);
check("demo reaches done/completed", first.task.phase === "done" && first.task.status === "completed", `${first.task.phase}/${first.task.status}`);
check("iteration === 2", first.task.iteration === 2, `${first.task.iteration}`);
check("progress === 1", first.task.progress === 1, `${first.task.progress}`);
check("all subtasks done", first.task.subtasks.length > 0 && first.task.subtasks.every((s) => s.done));
check("findings non-empty", first.task.findings.length > 0);
const required = ["task.created", "task.assigned", "plan.created", "research.completed", "implementation.started", "implementation.submitted", "qa.failed", "qa.passed", "review.approved", "task.completed"] as const;
const missing = required.filter((t) => !types.has(t));
check("all required events emitted", missing.length === 0, missing.join(", "));
const comms = first.events.filter(isCommunication).length;
check("≥ 7 agent-to-agent communications", comms >= 7, `${comms}`);
const expectedOrder = "queued → intake → planning → research → implementation → testing → implementation → testing → review → done";
check("phase order exact", phaseOrder(first.task) === expectedOrder, phaseOrder(first.task));
check("completes in < 100 sim s", first.finishedAt < 100, `${first.finishedAt.toFixed(1)} s`);
console.log(`    (demo finished at ${first.finishedAt.toFixed(1)} sim s, ${comms} communications)`);

// 3 ───────────────────────────────────────────────
section("3. Determinism");
const second = runDemo();
const a = first.events.map(fingerprint);
const b = second.events.map(fingerprint);
const firstDiff = a.findIndex((x, i) => x !== b[i]);
check("identical event sequence across runs", a.length === b.length && firstDiff === -1, firstDiff === -1 ? `length ${a.length} vs ${b.length}` : `first diff at #${firstDiff}: ${a[firstDiff]} ≠ ${b[firstDiff]}`);
check("identical finish clock", first.finishedAt === second.finishedAt);

// 4 ───────────────────────────────────────────────
section("4. Pause / resume / stop / reset");
{
  const engine = new SimulationEngine({ now: () => 0 });
  engine.start();
  const { id } = engine.submitTask(DEMO_TASK);
  runUntil(engine, () => engine.getClock() > 10, 20);
  engine.pause();
  const frozen = JSON.stringify(engine.snapshot());
  for (let i = 0; i < 60; i++) engine.tick(DT);
  check("paused snapshot does not change", JSON.stringify(engine.snapshot()) === frozen);
  engine.resume();
  const before = engine.getClock();
  for (let i = 0; i < 30; i++) engine.tick(DT);
  check("resumed simulation progresses", engine.getClock() > before);

  const owner = engine.getTask(id)!.assignedAgentId!;
  engine.pauseAgent(owner);
  check("pauseAgent(owner) blocks the task", engine.getTask(id)!.status === "blocked", engine.getTask(id)!.status);
  const progressWhilePaused = engine.getTask(id)!.progress;
  for (let i = 0; i < 90; i++) engine.tick(DT);
  check("blocked task does not progress", engine.getTask(id)!.progress === progressWhilePaused);
  engine.resumeAgent(owner);
  check("resumeAgent unblocks", engine.getTask(id)!.status !== "blocked" && engine.getTask(id)!.blockedReason === null);

  engine.stop();
  const stoppedAt = engine.getClock();
  for (let i = 0; i < 30; i++) engine.tick(DT);
  check("stop() halts and keeps state", engine.getStatus() === "ready" && engine.getClock() === stoppedAt && engine.getTask(id) !== undefined);
  engine.start();
  check("start() after stop() continues", engine.getStatus() === "running");

  const random = engine.submitTask(pickRandomTask(new Set([DEMO_TASK.title]), () => 0.5));
  runUntil(engine, () => isTerminal(engine.getTask(random.id)!.phase), 600);
  check("a random backlog task terminates", isTerminal(engine.getTask(random.id)!.phase), engine.getTask(random.id)!.phase);

  engine.reset();
  const s = engine.snapshot();
  const atHome = s.agents.every((ag) => {
    const home = slotFor(AGENTS.find((p) => p.id === ag.id)!.home, 0).position;
    return ag.status === "idle" && ag.position.x === home.x && ag.position.z === home.z;
  });
  check("reset() → 0 tasks, ready, clock 0, agents idle at stations", s.tasks.length === 0 && s.status === "ready" && s.clock === 0 && atHome);
}

// 5 ───────────────────────────────────────────────
section("5. Concurrency + priority + per-agent queues");
{
  const engine = new SimulationEngine({ now: () => 0 });
  engine.start();
  const low = engine.submitTask({ title: "Export audit log to CSV and Parquet", priority: "low" });
  const medium = engine.submitTask({ title: "Full-text search for project documents", priority: "medium" });
  const critical = engine.submitTask({ title: "Fix memory leak in the image-processing worker", priority: "critical" });
  engine.tick(DT);
  const ph = (id: string) => engine.getTask(id)!.phase;
  check("critical and medium start, low stays queued", ph(critical.id) !== "queued" && ph(medium.id) !== "queued" && ph(low.id) === "queued");

  // Both tasks need Kai: the critical one must reach implementation first and never be preempted.
  const implStarts: string[] = [];
  engine.events.subscribe((e) => {
    if (e.type === "implementation.started" && e.taskId) implStarts.push(e.taskId);
  });
  runUntil(engine, () => [low, medium, critical].every((t) => isTerminal(ph(t.id))), 1500);
  check("critical task reaches Kai before medium", implStarts.indexOf(critical.id) < implStarts.indexOf(medium.id), implStarts.join(","));
  check("all three eventually finish", [low, medium, critical].every((t) => isTerminal(ph(t.id))));
}

// 6 ───────────────────────────────────────────────
section("6. Backlog + sprint");
{
  const titles = new Set(TASK_BACKLOG.map((t) => t.title));
  check("≥ 15 backlog tasks with unique titles", TASK_BACKLOG.length >= 15 && titles.size === TASK_BACKLOG.length, `${TASK_BACKLOG.length}`);
  const generic = TASK_BACKLOG.filter((t) => templateFor(t.title, t.description) === GENERIC_TEMPLATE);
  check("≤ 2 fall through to the generic template", generic.length <= 2, generic.map((t) => t.title).join("; "));

  const engine = new SimulationEngine({ now: () => 0 });
  engine.start();
  const ids = SPRINT_TASKS.map((t) => engine.submitTask(t).id);
  runUntil(engine, () => ids.every((id) => isTerminal(engine.getTask(id)!.phase)), 3000);
  const tasks = ids.map((id) => engine.getTask(id)!);
  check("8-task sprint terminates", tasks.length === 8 && tasks.every((t) => isTerminal(t.phase)), `at ${engine.getClock().toFixed(0)} s`);
  const hotfix = tasks.find((t) => t.title === HOTFIX_TITLE)!;
  check("scripted hot-fix ends done at iteration 3", hotfix.phase === "done" && hotfix.iteration === 3, `${hotfix.phase} it${hotfix.iteration}`);
  const migration = tasks.find((t) => t.title === MIGRATION_TITLE)!;
  check("scripted migration ends failed", migration.phase === "failed", migration.phase);
  const completed = tasks.filter((t) => t.phase === "done").length;
  check("≥ 5 of 8 complete", completed >= 5, `${completed}`);
  check("every task has subtasks and findings", tasks.every((t) => t.subtasks.length > 0 && t.findings.length > 0));
  console.log(`    (sprint finished at ${engine.getClock().toFixed(1)} sim s, ${completed}/8 done)`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
