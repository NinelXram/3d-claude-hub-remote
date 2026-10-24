// Print what the 3D world would show, as text.
//   npm run demo                 demo task, instant (headless ticking)
//   npm run demo -- --sprint     8-task sprint, instant
//   npm run demo -- --live       demo task in real time at 4× through MockAgentBackend
//   npm run demo -- --all        include feed:false events (arrivals, ambient, status changes)
import { MockAgentBackend } from "../src/integrations/MockAgentBackend.ts";
import { SimulationEngine } from "../src/simulation/SimulationEngine.ts";
import { SIM_CONFIG } from "../src/simulation/simulationConfig.ts";
import { isTerminal } from "../src/simulation/WorkflowStateMachine.ts";
import { getAgent } from "../src/agents/AgentRegistry.ts";
import { isCommunication } from "../src/events/eventTypes.ts";
import type { AgentEvent } from "../src/events/eventTypes.ts";
import { DEMO_TASK } from "../src/tasks/taskActions.ts";
import { SPRINT_TASKS } from "../src/tasks/taskBacklog.ts";

const args = new Set(process.argv.slice(2));
const showAll = args.has("--all");

const color = (hex: string, s: string) => {
  const n = parseInt(hex.slice(1), 16);
  return process.stdout.isTTY ? `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m${s}\x1b[0m` : s;
};
const SEVERITY_MARK = { info: "·", success: "✓", warning: "!", error: "✗" } as const;

function print(e: AgentEvent): void {
  if (!e.feed && !showAll) return;
  const t = `${e.simTime.toFixed(1).padStart(6)}s`;
  const from = e.agentId ? getAgent(e.agentId) : null;
  const to = isCommunication(e) && e.targetAgentId ? getAgent(e.targetAgentId) : null;
  const plain = `${from?.name ?? ""}${to ? ` → ${to.name}` : ""}`;
  const who = `${from ? color(from.color, from.name) : ""}${to ? ` → ${color(to.color, to.name)}` : ""}${" ".repeat(Math.max(0, 14 - plain.length))}`;
  console.log(`${t} ${SEVERITY_MARK[e.severity]} ${who} ${e.type.padEnd(25)} ${e.message}`);
}

if (args.has("--live")) {
  const backend = new MockAgentBackend();
  backend.subscribe(print);
  await backend.connect();
  await backend.setSpeed(4);
  await backend.start();
  const task = await backend.submitTask(DEMO_TASK);
  const off = backend.subscribe(async (e) => {
    if (e.type === "task.completed" && e.taskId === task.id) {
      off();
      await backend.disconnect();
      console.log("\nDone. (Simulation mode — no LLM was called.)");
    }
  });
} else {
  const engine = new SimulationEngine();
  engine.events.subscribe(print);
  engine.emitBootEvents();
  engine.start();
  const inputs = args.has("--sprint") ? SPRINT_TASKS : [DEMO_TASK];
  const ids = inputs.map((t) => engine.submitTask(t).id);
  const dt = 1 / SIM_CONFIG.tickHz;
  while (!ids.every((id) => isTerminal(engine.getTask(id)!.phase)) && engine.getClock() < 3000) engine.tick(dt);
  // Let Orion finish the announce emote.
  for (let i = 0; i < SIM_CONFIG.tickHz * 8; i++) engine.tick(dt);

  console.log("\nSummary");
  for (const id of ids) {
    const t = engine.getTask(id)!;
    const path = [t.history[0]?.from, ...t.history.map((h) => h.to)].join(" → ");
    console.log(`  ${t.id} [${t.priority}] ${t.phase.padEnd(6)} it${t.iteration}  ${t.title}\n         ${path}`);
  }
}
