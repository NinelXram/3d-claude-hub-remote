// Sound mapping checks (npm run test:sound). The synthesis needs a browser; which event makes which sound does not.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cueFor, throttleKey } from "../viewer/soundEngine.ts";
import type { Cue } from "../viewer/soundEngine.ts";
import { SimulationEngine } from "../src/simulation/SimulationEngine.ts";
import { LiveAgentBackend } from "../src/live/LiveAgentBackend.ts";
import type { HookPayload } from "../src/live/LiveAgentBackend.ts";
import { DEMO_TASK } from "../src/tasks/taskActions.ts";
import type { AgentEvent } from "../src/events/eventTypes.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("\nSound cues");

// Simulation: the demo should be audible end to end.
{
  const engine = new SimulationEngine({ now: () => 0 });
  const events: AgentEvent[] = [];
  engine.events.subscribe((e) => events.push(e));
  engine.start();
  engine.submitTask(DEMO_TASK);
  while (!events.some((e) => e.type === "task.completed")) engine.tick(1 / 30);
  const cues = new Set(events.map((e) => cueFor(e, "simulation")).filter((c): c is Cue => c !== null));
  const expected: Cue[] = ["rise", "created", "ping", "arpeggio", "research", "keys", "whoosh", "buzz", "chime", "fanfare", "footstep"];
  const missing = expected.filter((c) => !cues.has(c));
  check("the demo plays every cue its story needs", missing.length === 0, missing.join(", "));
  check("ambient wandering and bookkeeping stay silent", events.filter((e) => e.type === "agent.ambient" || e.type === "task.status_changed").every((e) => cueFor(e, "simulation") === null));
}

function replay(file: string): AgentEvent[] {
  const live = new LiveAgentBackend({ autoTick: false, now: () => 0 });
  const events: AgentEvent[] = [];
  live.subscribe((e) => events.push(e));
  let now = 0;
  for (const l of readFileSync(join(root, "bridge", file), "utf8").split("\n").filter(Boolean)) {
    const { t, payload } = JSON.parse(l) as { t: number; payload: HookPayload };
    while (now < t / 1000) { live.tick(1 / 30); now += 1 / 30; }
    live.ingest(payload);
  }
  return events;
}

// Live: only what is worth interrupting you for.
{
  const cues = replay("real-session-fail-fix-pass.jsonl").map((e) => cueFor(e, "live")).filter(Boolean);
  check("real session 3 in live mode sounds exactly: test fails, test passes, turn ends", cues.join(",") === "buzz,chime,fanfare", cues.join(","));
  const perm = replay("real-session-permission.jsonl").map((e) => cueFor(e, "live")).filter(Boolean);
  check("a permission request rings the attention bell", perm.join(",") === "attention,attention,fanfare", perm.join(","));
  const sample = replay("sample-session.jsonl").map((e) => cueFor(e, "live")).filter(Boolean);
  check("handoffs between robots never ping in live mode", !sample.includes("ping") && sample.length <= 6, sample.join(","));
}

// Throttling keys
{
  const msg = (agentId: "kai" | "iris") => ({ type: "agent.message", agentId } as AgentEvent);
  check("two agents talking at once are throttled separately", throttleKey(msg("kai")).key !== throttleKey(msg("iris")).key);
  check("footsteps throttle at 160 ms, everything else at 120 ms", throttleKey({ type: "agent.arrived" } as AgentEvent).ms === 160 && throttleKey({ type: "qa.passed" } as AgentEvent).ms === 120);
}

console.log(failures === 0 ? "\nAll sound checks passed." : `\n${failures} sound check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
