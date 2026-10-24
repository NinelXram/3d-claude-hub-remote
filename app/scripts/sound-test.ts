// Sound and attention mapping checks (npm run test:sound; also part of npm test).
// The synthesis needs a browser; which event makes which sound does not.
// Ported from the prompt repo's examples/phase1-engine/scripts/sound-test.ts. The live sessions are the
// events its LiveAgentBackend produces from three recorded Claude Code sessions (scripts/fixtures).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attentionOf, attentionRank, attentionTitle, clearsAttention, notificationTitle } from "../src/audio/attention.ts";
import type { Attention } from "../src/audio/attention.ts";
import {
  STALE_EVENT_MS,
  SoundEngine,
  cueFor,
  defaultSoundSettings,
  isStale,
  parseSoundSettings,
  serializeSoundSettings,
  throttleKey,
} from "../src/audio/soundEngine.ts";
import type { Cue } from "../src/audio/soundEngine.ts";
import { SimulationEngine } from "../src/simulation/SimulationEngine.ts";
import type { AgentEvent } from "../src/events/eventTypes.ts";
import { DEMO_TASK } from "../src/tasks/taskActions.ts";

const here = dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

type FixtureEvent = Pick<AgentEvent, "type" | "severity" | "message" | "feed" | "agentId" | "targetAgentId" | "metadata">;
const fixtures = JSON.parse(readFileSync(join(here, "fixtures/live-sessions.json"), "utf8")) as Record<string, FixtureEvent[] | string>;
function session(name: string): AgentEvent[] {
  const list = fixtures[name];
  if (!Array.isArray(list)) throw new Error(`fixture ${name} missing`);
  return list.map((e, i) => ({ id: `E-${i}`, timestamp: 0, simTime: i, ...e }));
}
const liveCues = (events: AgentEvent[]) => events.map((e) => cueFor(e, "live")).filter((c): c is Cue => c !== null);

console.log("\nSound cues · simulation");
{
  const engine = new SimulationEngine({ now: () => 0 });
  const events: AgentEvent[] = [];
  engine.events.subscribe((e) => events.push(e));
  engine.start();
  engine.submitTask(DEMO_TASK);
  while (!events.some((e) => e.type === "task.completed") && engine.getClock() < 300) engine.tick(1 / 30);
  const cues = new Set(events.map((e) => cueFor(e, "simulation")).filter((c): c is Cue => c !== null));
  const expected: Cue[] = ["rise", "created", "ping", "arpeggio", "research", "keys", "whoosh", "buzz", "chime", "fanfare", "footstep"];
  const missing = expected.filter((c) => !cues.has(c));
  check("the demo plays every cue its story needs", missing.length === 0, missing.join(", "));
  check(
    "ambient wandering and bookkeeping stay silent",
    events.filter((e) => e.type === "agent.ambient" || e.type === "task.status_changed").every((e) => cueFor(e, "simulation") === null),
  );
  check("arrivals without a task stay silent", cueFor({ ...events[0]!, type: "agent.arrived", metadata: { withTask: false } }, "simulation") === null);
  const order = events.map((e) => cueFor(e, "simulation")).filter((c) => c === "buzz" || c === "chime" || c === "fanfare");
  check("the failure is heard before the passes, and the fanfare last", order[0] === "buzz" && order.at(-1) === "fanfare" && order.includes("chime"), order.join(","));
  const sim = new SimulationEngine({ now: () => 0 });
  const sys: AgentEvent[] = [];
  sim.events.subscribe((e) => sys.push(e));
  sim.start();
  sim.pause();
  sim.resume();
  sim.reset();
  const sysCues = sys.map((e) => cueFor(e, "simulation")).filter(Boolean).join(",");
  check("start, pause, resume and reset each have their cue", sysCues === "rise,fall,rise,sweepDown", sysCues);
}

console.log("\nSound cues · live mirror");
{
  const fail = liveCues(session("real-session-fail-fix-pass"));
  check("real session 3 in live mode sounds exactly: test fails, test passes, turn ends", fail.join(",") === "buzz,chime,fanfare", fail.join(","));
  const perm = liveCues(session("real-session-permission"));
  check("a permission request rings the attention bell", perm.join(",") === "attention,attention,fanfare", perm.join(","));
  const sample = liveCues(session("sample-session"));
  check("handoffs between robots never ping in live mode", !sample.includes("ping") && sample.length <= 6, sample.join(","));
  const all = Object.keys(fixtures).filter((k) => !k.startsWith("_")).flatMap((k) => session(k));
  check(
    "live mode only ever plays chime, buzz, fanfare, thud or attention",
    all.every((e) => [null, "chime", "buzz", "fanfare", "thud", "attention"].includes(cueFor(e, "live"))),
  );
  const thud = cueFor({ id: "x", type: "task.failed", timestamp: 0, simTime: 0, message: "Stopped", severity: "error", feed: true }, "live");
  check("a stopped turn thuds", thud === "thud");
  const notOrion = cueFor({ id: "x", type: "agent.message", agentId: "kai", timestamp: 0, simTime: 0, message: "Needs your permission to run rm", severity: "warning", feed: true }, "live");
  check("only Orion's warning rings the bell", notOrion === null);
}

console.log("\nThrottling and history");
{
  const msg = (agentId: "kai" | "iris") => ({ type: "agent.message", agentId }) as AgentEvent;
  check("two agents talking at once are throttled separately", throttleKey(msg("kai")).key !== throttleKey(msg("iris")).key);
  check("footsteps throttle at 160 ms, everything else at 120 ms", throttleKey({ type: "agent.arrived" } as AgentEvent).ms === 160 && throttleKey({ type: "qa.passed" } as AgentEvent).ms === 120);
  const at = (ms: number) => ({ timestamp: ms }) as AgentEvent;
  check("events older than 15 s are history and stay silent", isStale(at(0), STALE_EVENT_MS + 1) && !isStale(at(0), 2000) && STALE_EVENT_MS === 15_000);
}

console.log("\nEngine before a gesture");
{
  const engine = new SoundEngine();
  engine.configure(defaultSoundSettings("simulation"));
  engine.play({ id: "x", type: "task.completed", timestamp: 0, simTime: 0, message: "", severity: "success", feed: true });
  engine.setRunning(true);
  check("play() is a silent no-op until unlock(): no AudioContext, nothing counted", engine.state === "none" && engine.played === 0 && !engine.ambientOn);
}

console.log("\nSettings");
{
  check("defaults: simulation hums, the live mirror does not", defaultSoundSettings("simulation").ambient && !defaultSoundSettings("live").ambient);
  check("defaults: on, volume 0.6", defaultSoundSettings("live").enabled && defaultSoundSettings("simulation").volume === 0.6);
  const legacy = JSON.stringify({ enabled: false, volume: 0.3, ambient: false });
  const fromLegacy = parseSoundSettings(legacy, "simulation");
  check("a flat value saved before modes existed is read as the simulation settings", !fromLegacy.enabled && fromLegacy.volume === 0.3 && parseSoundSettings(legacy, "live").enabled);
  let stored = serializeSoundSettings(null, "live", { enabled: false, volume: 0.9, ambient: true });
  stored = serializeSoundSettings(stored, "simulation", { enabled: true, volume: 0.2, ambient: false });
  const live = parseSoundSettings(stored, "live");
  const sim = parseSoundSettings(stored, "simulation");
  check("each mode keeps its own saved settings", !live.enabled && live.volume === 0.9 && sim.enabled && sim.volume === 0.2 && !sim.ambient);
  check("bad values fall back to defaults", parseSoundSettings("{nope", "live").volume === 0.6 && parseSoundSettings(JSON.stringify({ live: { volume: 7 } }), "live").volume === 1);
}

console.log("\nClaude needs you (tab title)");
{
  const titles = (events: AgentEvent[]) => {
    let title: string | null = null;
    let shown: { kind: Attention["kind"]; at: number } | undefined;
    const seen: string[] = [];
    for (const e of events) {
      const a = attentionOf(e);
      if (a) { title = a.badge; shown = { kind: a.kind, at: e.simTime }; }
      else if (title && clearsAttention(e, shown)) title = null;
      if (seen.at(-1) !== (title ?? "-")) seen.push(title ?? "-");
    }
    return seen;
  };
  const perm = titles(session("real-session-permission"));
  check("a permission request puts “Permission needed” in the title, then work clears it", perm.includes("⏳ Permission needed") && perm.indexOf("-", perm.indexOf("⏳ Permission needed")) > 0, perm.join(" | "));
  check("the turn ends with “Turn ended” in the title", perm.at(-1) === "✓ Turn ended", perm.join(" | "));
  const idle = attentionOf({ id: "x", type: "agent.message", agentId: "orion", timestamp: 0, simTime: 0, message: "Claude Code needs you: waiting for input", severity: "warning", feed: true });
  check("“Claude Code needs you” reads “Needs you”", idle?.badge === "⏳ Needs you" && notificationTitle(idle) === "Needs you");
  const stopped = attentionOf({ id: "x", type: "task.failed", timestamp: 0, simTime: 0, message: "Stopped", severity: "error", feed: true });
  check("a failed turn reads “Stopped”", stopped?.badge === "✗ Stopped");
  const ev = (simTime: number) => ({ id: "x", type: "agent.message" as const, agentId: "kai" as const, timestamp: 0, simTime, message: "Bash · npm test", severity: "info" as const, feed: true });
  check("parallel tool calls right behind a permission request do not clear it", !clearsAttention(ev(10.1), { kind: "permission", at: 10 }));
  check("…but work after the grace window does", clearsAttention(ev(12.5), { kind: "permission", at: 10 }));
  check("the server stopping does not clear it", !clearsAttention({ id: "x", type: "system.stopped", timestamp: 0, simTime: 0, message: "", severity: "info", feed: true }));

  // Several sessions: the signal names its session's project, and only that session's work clears it.
  const meta = (session: string, project: string) => ({ session, project, sessionTitle: `Fix ${project}` });
  const ask = attentionOf({ id: "x", type: "agent.message", agentId: "orion", timestamp: 0, simTime: 10, message: "Needs your permission · Bash · npm test", severity: "warning", feed: true, metadata: meta("A", "shop-api") })!;
  check("an ask from any session names its project in the title and the notification",
    attentionTitle(ask, "AI Agent World") === "⏳ Permission needed · shop-api · AI Agent World" && ask.body.startsWith("shop-api · Fix shop-api: Needs your permission") && ask.session === "A",
    `${attentionTitle(ask, "AI Agent World")} / ${ask.body}`);
  const shownA = { kind: ask.kind, at: 10, session: "A" };
  check("another session's work does not clear it", !clearsAttention({ ...ev(20), metadata: meta("B", "billing") }, shownA));
  check("…its own session's work does", clearsAttention({ ...ev(20), metadata: meta("A", "shop-api") }, shownA));
  const ended = attentionOf({ id: "y", type: "task.completed", timestamp: 0, simTime: 0, message: "T-002 · Turn ended", severity: "success", feed: true, metadata: meta("B", "billing") })!;
  check("waiting for you outranks another session's turn ending", attentionRank(ask) > attentionRank(ended) && attentionTitle(ask, "W", 1) === "⏳ Permission needed · shop-api (+1) · W");
}

console.log(failures === 0 ? "\nAll sound checks passed." : `\n${failures} sound check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
