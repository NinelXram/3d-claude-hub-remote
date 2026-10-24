// Live Claude Code source checks (npm run test:live).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveAgentBackend, classifyTool, testOutcome } from "../src/live/LiveAgentBackend.ts";
import type { HookPayload } from "../src/live/LiveAgentBackend.ts";
import { WebSocketAgentBackend } from "../src/integrations/WebSocketAgentBackend.ts";
import { startWorldServer } from "../server/worldServer.ts";
import { createHookRoute } from "../server/hookRoute.ts";
import { AGENTS } from "../src/agents/AgentRegistry.ts";
import { slotFor } from "../src/simulation/worldLayout.ts";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(5);
  return cond();
}

console.log("\nLive Claude Code source");

// ── classification ──
{
  const cwd = "/p";
  const cases: [string, Record<string, unknown>, string][] = [
    ["Read", { file_path: "/p/src/a.ts" }, "iris"],
    ["Grep", { pattern: "login" }, "iris"],
    ["WebSearch", { query: "jwt rotation" }, "iris"],
    ["Edit", { file_path: "/p/src/a.ts" }, "kai"],
    ["Write", { file_path: "/p/test/a.test.ts" }, "kai"],
    ["Bash", { command: "npm test -- auth" }, "quinn"],
    ["Bash", { command: "npx tsc --noEmit" }, "quinn"],
    ["Bash", { command: "cargo test" }, "quinn"],
    ["Bash", { command: "git diff --stat" }, "rex"],
    ["Bash", { command: "gh pr view 12" }, "rex"],
    ["Bash", { command: "ls -la" }, "iris"],
    ["Bash", { command: "CI=1 pnpm vitest run" }, "quinn"],
    ["Bash", { command: "CI=1 npx vitest run" }, "quinn"],
    ["Bash", { command: "python -m pytest -q" }, "quinn"],
    ["Bash", { command: "node --test" }, "quinn"],
    ["Bash", { command: "git commit -m 'x'" }, "kai"],
    ["TodoWrite", {}, "piper"],
    ["ExitPlanMode", {}, "piper"],
    ["Agent", { subagent_type: "Explore" }, "orion"],
    ["mcp__github__get_issue", {}, "iris"],
    // seen in a real session:
    ["Bash", { command: "cat src/cart.js; echo ----; cat test/cart.test.js" }, "iris"],
    ["Bash", { command: "ls -R src test* 2>/dev/null; cat package.json; npm test 2>&1 | head -40" }, "quinn"],
    ["Bash", { command: "npm test 2>&1 | tail -15" }, "quinn"],
    ["Bash", { command: "git status && git diff" }, "rex"],
    ["Bash", { command: "npm install left-pad && npm test" }, "quinn"],
    ["Bash", { command: "mkdir -p out && cp a b" }, "kai"],
  ];
  const wrong = cases.filter(([tool, input, agent]) => classifyTool(tool, input, cwd)?.agent !== agent);
  check(`tools map to the right robot (${cases.length} cases)`, wrong.length === 0, wrong.map(([t, i]) => `${t} ${JSON.stringify(i)} → ${classifyTool(t, i, cwd)?.agent}`).join("; "));
  check("Claude Code plumbing (ToolSearch) is not shown", classifyTool("ToolSearch", { query: "select:TodoWrite" }) === null);
  const outcomes: [string, string][] = [
    ["✖ test (21.7ms)\nℹ tests 1\nℹ pass 0\nℹ fail 1", "failed"], // node:test, from the real session
    ["ℹ tests 2\nℹ pass 2\nℹ fail 0", "passed"],
    ["Error: Cannot find module '/x/test'", "failed"],
    ["Tests:       1 failed, 4 passed, 5 total", "failed"], // jest
    ["Test Files  3 passed (3)\n     Tests  12 passed (12)", "passed"], // vitest
    ["===== 2 failed, 10 passed in 0.31s =====", "failed"], // pytest
    ["===== 10 passed in 0.31s =====", "passed"],
    ["test result: ok. 8 passed; 0 failed", "passed"], // cargo
    ["src/a.ts(3,1): error TS2304: Cannot find name 'x'.", "failed"], // tsc
    ["", "unknown"],
    ["compiled successfully", "unknown"],
  ];
  const badOutcomes = outcomes.filter(([o, want]) => testOutcome(o) !== want);
  check(`test outcomes are read from the output (${outcomes.length} runners)`, badOutcomes.length === 0, badOutcomes.map(([o]) => JSON.stringify(o.slice(0, 40))).join("; "));
  {
    const wrapped = "<ide_selection>The user selected the lines 116 to 116 from /x/app.ts:\nfoo()\n</ide_selection>\nsửa đi em";
    const live2 = new LiveAgentBackend({ autoTick: false });
    live2.ingest({ hook_event_name: "UserPromptSubmit", session_id: "w", prompt: wrapped });
    live2.ingest({ hook_event_name: "UserPromptSubmit", session_id: "c", prompt: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" });
    const titles = live2.snapshot().tasks.map((t) => t.title);
    check("task titles show what you typed, not IDE selections or slash-command wrappers", titles.includes("sửa đi em") && titles.includes("/clear"), titles.join(" | "));
  }
  check("labels show paths relative to the project", classifyTool("Edit", { file_path: "/p/src/a.ts" }, cwd)?.label === "Edit · src/a.ts");
}

// ── the recorded sample session, replayed in simulated time ──
const sample = readFileSync(join(root, "bridge", "sample-session.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: number; payload: HookPayload });
{
  const live = new LiveAgentBackend({ autoTick: false, now: () => 0 });
  const events: AgentEvent[] = [];
  live.subscribe((e) => events.push(e));
  await live.connect();
  const DT = 1 / 30;
  let kaiAtDevWhileEditing = false;
  let now = 0;
  for (const { t, payload } of sample) {
    while (now < t / 1000) { live.tick(DT); now += DT; }
    live.ingest(payload);
    if (payload.hook_event_name === "PostToolUse" && payload.tool_name === "Edit") {
      const kai = live.snapshot().agents.find((a) => a.id === "kai")!;
      kaiAtDevWhileEditing = kai.location === "dev" && kai.status === "working";
    }
  }
  for (let i = 0; i < 30 * 20; i++) live.tick(DT);
  const s = live.snapshot();
  const task = s.tasks[0]!;
  const phases = [task.history[0]!.from, ...task.history.map((h) => h.to)].join(" → ");
  check("one prompt becomes one task, finished when Claude stops", s.tasks.length === 1 && task.phase === "done" && task.progress === 1, `${task.phase}`);
  check("prompt text becomes the task title", task.title.startsWith("Add rate limiting to the /login endpoint"));
  check("phases follow what the session actually did", phases === "queued → intake → research → planning → research → implementation → testing → research → implementation → testing → review → done", phases);
  check("a second round of edits after a failing test counts as iteration 2", task.iteration === 2, `${task.iteration}`);
  const types = events.map((e) => e.type);
  check("failing npm test → qa.failed; passing test and typecheck → qa.passed ×2", types.filter((x) => x === "qa.failed").length === 1 && types.filter((x) => x === "qa.passed").length === 2);
  check("the subagent shows up as Orion assigning Iris and Iris reporting back", events.some((e) => e.type === "task.assigned" && e.targetAgentId === "iris") && events.some((e) => e.agentId === "iris" && e.targetAgentId === "orion"));
  check("Kai is at the Engineering Station, working, while Claude edits", kaiAtDevWhileEditing);
  check("task.completed is emitted", types.includes("task.completed"));
  check("Claude's TodoWrite list becomes the task cards", task.subtasks.length === 3 && task.subtasks[0]!.title === "Add rate limiter middleware" && types.includes("plan.created"));
  const home = s.agents.every((a) => {
    const p = slotFor(AGENTS.find((x) => x.id === a.id)!.home, 0).position;
    return Math.hypot(a.position.x - p.x, a.position.z - p.z) < 1e-6 && a.status === "idle";
  });
  check("after the session everyone walks home and idles", home, s.agents.map((a) => `${a.id}:${a.status}@${a.location}`).join(" "));

  const refusals = await Promise.all([
    live.submitTask({ title: "x" }).then(() => "ok", (e: Error) => e.message),
    live.setSpeed(2).then(() => "ok", (e: Error) => e.message),
    live.pauseAgent("kai").then(() => "ok", (e: Error) => e.message),
  ]);
  check("the live view is read-only: submit, speed and pause are refused with a reason", refusals.every((r) => r.includes("real time") || r.includes("read-only")), refusals.join(" | "));

  const hidden = new LiveAgentBackend({ autoTick: false, showPrompts: false });
  hidden.ingest(sample[1]!.payload);
  check("--hide-prompts keeps prompt text out of the world", hidden.snapshot().tasks[0]?.title === "Prompt 1" && hidden.snapshot().tasks[0]?.description === "");
}

// ── a recorded real session (Claude Code 2.1.304, claude -p): the tests never passed ──
{
  const real = readFileSync(join(root, "bridge", "real-session-discount-bug.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: number; payload: HookPayload });
  const live = new LiveAgentBackend({ autoTick: false, now: () => 0 });
  const events: AgentEvent[] = [];
  live.subscribe((e) => events.push(e));
  let now = 0;
  for (const { t, payload } of real) {
    while (now < t / 1000) { live.tick(1 / 30); now += 1 / 30; }
    live.ingest(payload);
  }
  const passed = events.filter((e) => e.type === "qa.passed").length;
  const failed = events.filter((e) => e.type === "qa.failed").length;
  check("real session: piped test runs that failed are reported as failed, never as passed", passed === 0 && failed === 2, `${passed} passed, ${failed} failed`);
  check("real session: `cat …; node --test …` is a test run (Quinn), `cat a; cat b` alone is reading (Iris)",
    events.some((e) => e.targetAgentId === "quinn" && e.message.startsWith("Bash · cat src/cart.js")) &&
    classifyTool("Bash", { command: "cat src/cart.js; echo ----; cat test/cart.test.js" })?.agent === "iris");
  check("real session: ToolSearch does not appear in the world", !events.some((e) => e.message.includes("ToolSearch")));
  const task = live.snapshot().tasks[0]!;
  check("real session: Claude's todo list and the final Stop come through", task.subtasks.length >= 3 && task.phase === "done", `${task.subtasks.length} cards, ${task.phase}`);
}

function replay(file: string): { live: LiveAgentBackend; events: AgentEvent[] } {
  const lines = readFileSync(join(root, "bridge", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: number; payload: HookPayload });
  const live = new LiveAgentBackend({ autoTick: false, now: () => 0 });
  const events: AgentEvent[] = [];
  live.subscribe((e) => events.push(e));
  let now = 0;
  for (const { t, payload } of lines) {
    while (now < t / 1000) { live.tick(1 / 30); now += 1 / 30; }
    live.ingest(payload);
  }
  return { live, events };
}

// ── real session: fail, fix, pass (Claude Code 2.1.304) ──
{
  const { live, events } = replay("real-session-fail-fix-pass.jsonl");
  const task = live.snapshot().tasks[0]!;
  const phases = [task.history[0]!.from, ...task.history.map((h) => h.to)].join(" → ");
  check("real session 3: the story reads look → plan → test fails → edit → test passes → diff → done",
    phases === "queued → intake → research → planning → testing → implementation → testing → review → done", phases);
  const outcomes = events.filter((e) => e.type === "qa.failed" || e.type === "qa.passed").map((e) => e.type).join(",");
  check("real session 3: `node --test …; cat …` exits 0 but its output shows a failure → qa.failed, then qa.passed", outcomes === "qa.failed,qa.passed", outcomes);
  check("real session 3: ticking todos off does not pull Piper back into the story", events.filter((e) => e.targetAgentId === "piper").length === 1);
  check("real session 3: all four todo cards end up done", task.subtasks.length === 4 && task.subtasks.every((x) => x.done));
}

// ── real session: a command that needs permission (claude -p denies it) ──
{
  const { events } = replay("real-session-permission.jsonl");
  check("real session 2: PermissionRequest shows Orion asking for permission", events.filter((e) => e.agentId === "orion" && e.message.startsWith("Needs your permission · Bash · node --test")).length === 2);
  check("real session 2: Stop is worded as the end of a turn, not as finished work", events.some((e) => e.type === "task.completed" && e.message.includes("Turn ended")));
}

// ── several sessions at once: one focused session drives the robots ──
// Interleaved sessions are built from the recordings: each copy gets its own session_id, cwd and time offset.
type Line = { t: number; payload: HookPayload };
function recording(file: string, opts: { id?: string; offsetMs?: number; cwd?: string; drop?: string[] } = {}): Line[] {
  return readFileSync(join(root, "bridge", file), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line)
    .filter((l) => !opts.drop?.includes(l.payload.hook_event_name))
    .map((l) => ({ t: l.t + (opts.offsetMs ?? 0), payload: { ...l.payload, ...(opts.id ? { session_id: opts.id } : {}), ...(opts.cwd ? { cwd: opts.cwd } : {}) } }));
}
const merge = (...lists: Line[][]): Line[] => lists.flat().sort((a, b) => a.t - b.t);
const STATION: Record<string, string> = { orion: "hub", piper: "planning", iris: "research", kai: "dev", quinn: "testing", rex: "review" };
const HOME = Object.fromEntries(AGENTS.map((a) => [a.id, a.home])) as Record<string, string>;

/** Replays lines on a simulated clock (30 Hz ticks; the backend's wall clock is the same simulated time). */
function multi(lines: Line[], hooks: { after?: (live: LiveAgentBackend, l: Line, ms: number) => void; tick?: (live: LiveAgentBackend, ms: number) => void; at?: [number, (live: LiveAgentBackend) => void][] } = {}) {
  let ms = 0;
  const live = new LiveAgentBackend({ autoTick: false, now: () => ms });
  const events: AgentEvent[] = [];
  live.subscribe((e) => events.push(e));
  const pending = [...(hooks.at ?? [])].sort((a, b) => a[0] - b[0]);
  const step = (toMs: number) => {
    while (ms < toMs) {
      while (pending.length && pending[0]![0] <= ms) pending.shift()![1](live);
      live.tick(1 / 30);
      ms += 1000 / 30;
      hooks.tick?.(live, ms);
    }
  };
  for (const l of lines) {
    step(l.t);
    live.ingest(l.payload);
    hooks.after?.(live, l, ms);
  }
  return { live, events, run: step, now: () => ms };
}
const agentSig = (live: LiveAgentBackend) => live.snapshot().agents.map((a) => `${a.id}:${a.position.x.toFixed(4)},${a.position.z.toFixed(4)}:${a.status}:${a.activity}`).join("|");

{
  // A: the sample session (shop-api). B: the fail-fix-pass recording as another project, starting 3 s later.
  // A never goes 8 s without a hook while B runs, so auto focus must stay on A the whole time.
  const A = recording("sample-session.jsonl");
  const B = recording("real-session-fail-fix-pass.jsonl", { id: "B-billing", cwd: "/Users/you/projects/billing", offsetMs: 3000 });
  const soloAt = new Map<number, string>();
  multi(A, { after: (live, l) => soloAt.set(l.t, agentSig(live)) });
  const focusSeen = new Set<string | null>();
  const mismatches: number[] = [];
  const { live, events } = multi(merge(A, B), {
    after: (lv, l) => {
      if (l.payload.session_id === "sample-0001" && soloAt.get(l.t) !== agentSig(lv)) mismatches.push(l.t);
    },
    tick: (lv) => focusSeen.add(lv.focus.sessionId),
  });
  check("two interleaved sessions: auto focus stays on the session that started first while it keeps working (no flicker)",
    focusSeen.size === 1 && focusSeen.has("sample-0001"), [...focusSeen].join(","));
  check("…and the robots move exactly as they do with that session alone (the other session never moves a robot)",
    mismatches.length === 0, `differs at ${mismatches.slice(0, 5).join(", ")} ms`);
  const bEvents = events.filter((e) => e.metadata?.["session"] === "B-billing");
  check("…while the other session's events still reach the feed, tagged with its session and project",
    bEvents.some((e) => e.type === "task.created") && bEvents.some((e) => e.type === "qa.failed") && bEvents.some((e) => e.type === "qa.passed") &&
    bEvents.every((e) => e.metadata?.["project"] === "billing"), `${bEvents.length} events`);
  const s = live.snapshot();
  const bTask = s.tasks.find((t) => t.origin?.sessionId === "B-billing");
  check("…and its task keeps its own phases and its origin (session, project)",
    bTask?.phase === "done" && bTask.origin?.project === "billing" && bTask.history.some((h) => h.to === "testing") && s.tasks.find((t) => t.origin?.sessionId === "sample-0001")?.phase === "done",
    `${bTask?.phase} ${bTask?.origin?.project}`);
  const listed = s.live?.sessions.map((x) => `${x.project}:${x.status}`).join(",");
  check("the snapshot lists both sessions, newest first, with title, project and status",
    listed === "shop-api:idle,billing:ended" && s.live?.sessions[0]?.title.startsWith("Add rate limiting") === true && s.live?.focus.mode === "auto", listed);
}

{
  // A: fail-fix-pass without its SessionEnd (the turn ends at 40.4 s and the session stays open).
  // B: the discount-bug session as another project, 5 s later; its hooks continue to 52.2 s.
  const A = recording("real-session-fail-fix-pass.jsonl", { id: "A", drop: ["SessionEnd"] });
  const B = recording("real-session-discount-bug.jsonl", { id: "B", cwd: "/Users/you/projects/cart", offsetMs: 5000 });
  const aStop = A.find((l) => l.payload.hook_event_name === "Stop")!.t;
  const switches: { ms: number; to: string | null }[] = [];
  let last: string | null = null;
  const watch = (lv: LiveAgentBackend, ms: number) => {
    if (lv.focus.sessionId !== last) {
      switches.push({ ms, to: lv.focus.sessionId });
      last = lv.focus.sessionId;
    }
  };
  let restaged = "";
  const { live } = multi(merge(A, B), {
    after: (lv, _l, ms) => watch(lv, ms),
    tick: (lv, ms) => {
      const before = last;
      watch(lv, ms);
      if (before === "A" && last === "B") {
        // Re-staging: B's holder is the robot of B's latest tool call; everyone else heads home.
        const lastTool = [...B].reverse().find((l) => l.t <= ms && l.payload.hook_event_name === "PreToolUse")!;
        const holder = classifyTool(lastTool.payload.tool_name!, lastTool.payload.tool_input, lastTool.payload.cwd)!.agent;
        lv.tick(1 / 30);
        const agents = lv.snapshot().agents;
        const h = agents.find((a) => a.id === holder)!;
        const atStation = h.location === STATION[holder] || h.destination === STATION[holder];
        const othersHome = agents.filter((a) => a.id !== holder).every((a) => a.location === HOME[a.id] || a.destination === HOME[a.id]);
        restaged = `${holder}:${atStation}:${othersHome}`;
      }
    },
  });
  const toB = switches.filter((x) => x.to === "B");
  check("auto hysteresis: B's hooks 4 s after A's turn ended do not take focus; it moves once A has been idle 8 s",
    switches.length === 3 && switches[0]!.to === "A" && toB.length === 1 && toB[0]!.ms >= aStop + 8000 && toB[0]!.ms < aStop + 8100,
    switches.map((x) => `${x.to}@${Math.round(x.ms)}`).join(" "));
  check("re-staging on a focus change: the new session's robot goes to its station, every other robot heads home",
    /^\w+:true:true$/.test(restaged), restaged);
  const bEnd = B.find((l) => l.payload.hook_event_name === "SessionEnd")!.t;
  check("when the focused session ends, focus returns at once to the session still open", switches[2]?.to === "A" && switches[2].ms >= bEnd && switches[2].ms < bEnd + 50 && live.focus.sessionId === "A",
    switches.map((x) => `${x.to}@${Math.round(x.ms)}`).join(" "));
}

{
  // A: the sample session. B: the permission recording as another project; B asks for permission at 18.7 s
  // while A is busy, and its session ends at 31.7 s.
  const A = recording("sample-session.jsonl");
  const B = recording("real-session-permission.jsonl", { id: "B-perm", cwd: "/Users/you/projects/infra" });
  const ask = B.find((l) => l.payload.hook_event_name === "PermissionRequest")!.t;
  const end = B.find((l) => l.payload.hook_event_name === "SessionEnd")!.t;
  let focusAtAsk: string | null = null;
  let orionAtAsk = "";
  let focusAtEnd: string | null = null;
  let stayedOnB = true;
  const { events } = multi(merge(A, B), {
    after: (lv, l) => {
      if (l.t === ask && l.payload.hook_event_name === "PermissionRequest") {
        focusAtAsk = lv.focus.sessionId;
        const o = lv.snapshot().agents.find((a) => a.id === "orion")!;
        orionAtAsk = `${o.destination ?? o.location}`;
      }
      if (l.t > ask && l.t < end && l.payload.session_id === "sample-0001" && lv.focus.sessionId !== "B-perm") stayedOnB = false;
      if (l.t === end && l.payload.hook_event_name === "SessionEnd") focusAtEnd = lv.focus.sessionId;
    },
  });
  check("a session that starts waiting for you takes focus at once, and Orion heads to the hub", focusAtAsk === "B-perm" && orionAtAsk === "hub", `${focusAtAsk} ${orionAtAsk}`);
  check("…it keeps focus while it waits, however busy the other session is", stayedOnB);
  check("…and when it ends, focus goes straight back to the session still working", focusAtEnd === "sample-0001", `${focusAtEnd}`);
  const asks = events.filter((e) => e.agentId === "orion" && e.message.startsWith("Needs your permission"));
  check("the permission warning carries the waiting session's id, title and project", asks.length === 2 && asks.every((e) => e.metadata?.["session"] === "B-perm" && e.metadata?.["project"] === "infra" && typeof e.metadata?.["sessionTitle"] === "string"));
}

{
  // Pinned: the same pair, with A pinned at 3 s. B's permission ask must not take focus.
  const A = recording("sample-session.jsonl");
  const B = recording("real-session-permission.jsonl", { id: "B-perm", cwd: "/Users/you/projects/infra" });
  const seen = new Set<string>();
  let pinError = "";
  const { live, run, now } = multi(merge(A, B), {
    at: [[3000, (lv) => {
      void lv.focusSession("sample-0001");
      void lv.focusSession("nope").catch((e: Error) => { pinError = e.message; });
    }]],
    tick: (lv, ms) => { if (ms > 3100) seen.add(`${lv.focus.sessionId}/${lv.focus.mode}`); },
  });
  check("a pinned focus holds: another session's permission ask and activity do not move it", seen.size === 1 && seen.has("sample-0001/pinned"), [...seen].join(","));
  // Pin B (ended) and back to auto.
  await live.focusSession("B-perm");
  const pinnedB = live.focus;
  await live.focusSession(null);
  check("pinning a session the server has not seen is refused with a reason", /No hooks from that session/.test(pinError), pinError);
  check("choosing auto again follows the most active session at once", pinnedB.sessionId === "B-perm" && pinnedB.mode === "pinned" && live.focus.mode === "auto" && live.focus.sessionId === "sample-0001", JSON.stringify(live.focus));
  run(now() + 181_000);
  const left = live.snapshot().live?.sessions.map((x) => x.sessionId).join(",");
  check("ended sessions drop out of the snapshot after a few minutes; the idle one stays", left === "sample-0001", left);
}

{
  // Re-staging on a pin: B is mid-work when you pin it; its robot goes to its station, A's robot goes home.
  const A = recording("sample-session.jsonl");
  const B = recording("real-session-fail-fix-pass.jsonl", { id: "B-billing", cwd: "/Users/you/projects/billing", offsetMs: 3000 });
  const lines = merge(A, B);
  const { live, run } = multi(lines.filter((l) => l.t <= 25_000));
  const bTool = [...lines].reverse().find((l) => l.t <= 25_000 && l.payload.session_id === "B-billing" && l.payload.hook_event_name === "PreToolUse")!;
  const aTool = [...lines].reverse().find((l) => l.t <= 25_000 && l.payload.session_id === "sample-0001" && l.payload.hook_event_name === "PreToolUse")!;
  const bHolder = classifyTool(bTool.payload.tool_name!, bTool.payload.tool_input, bTool.payload.cwd)!.agent;
  const aHolder = classifyTool(aTool.payload.tool_name!, aTool.payload.tool_input, aTool.payload.cwd)!.agent;
  run(25_200);
  await live.focusSession("B-billing");
  run(25_200 + 8000);
  const agents = live.snapshot().agents;
  const b = agents.find((a) => a.id === bHolder)!;
  const a = agents.find((x) => x.id === aHolder)!;
  check(`re-staging on a pin: B's robot (${bHolder}) is at its station holding B's activity; A's robot (${aHolder}) went home`,
    b.location === STATION[bHolder] && b.status !== "idle" && b.activity === classifyTool(bTool.payload.tool_name!, bTool.payload.tool_input, bTool.payload.cwd)!.label &&
    (aHolder === bHolder || a.location === HOME[aHolder]),
    `${b.id}@${b.location}/${b.status}/${b.activity} · ${a.id}@${a.location}`);
}

// ── focusSession over the wire: a world command, so no token is needed on loopback when the token guards sessions ──
{
  const live = new LiveAgentBackend();
  await live.connect();
  const server = await startWorldServer({ backend: live, port: 0, token: "secret", tokenScope: "sessions" });
  const client = new WebSocketAgentBackend({ url: server.url });
  await client.connect();
  live.ingest({ hook_event_name: "UserPromptSubmit", session_id: "one", cwd: "/p/alpha", prompt: "first" });
  live.ingest({ hook_event_name: "UserPromptSubmit", session_id: "two", cwd: "/p/beta", prompt: "second" });
  await until(() => client.getSnapshot()?.live?.sessions.length === 2);
  const auto = client.getSnapshot()?.live?.focus;
  await client.focusSession("two");
  const pinned = await until(() => client.getSnapshot()?.live?.focus.sessionId === "two" && client.getSnapshot()?.live?.focus.mode === "pinned");
  const refused = await client.focusSession("three").then(() => "", (e: Error) => e.message);
  await client.focusSession(null);
  const back = await until(() => client.getSnapshot()?.live?.focus.mode === "auto");
  check("focusSession works over WebSocket without the sessions token (loopback), and the snapshot carries the focus",
    auto?.sessionId === "one" && auto.mode === "auto" && pinned && back && /No hooks/.test(refused), `${JSON.stringify(auto)} ${pinned} ${back} ${refused}`);
  check("the snapshot's session list says which project each session is in", client.getSnapshot()?.live?.sessions.map((s) => s.project).sort().join(",") === "alpha,beta");
  await client.disconnect();
  await server.close();
  await live.disconnect();
}

// ── over HTTP and WebSocket, plus the real forwarder script ──
{
  const live = new LiveAgentBackend();
  await live.connect();
  const server = await startWorldServer({ backend: live, port: 0, http: createHookRoute({ live }) });
  const httpUrl = server.url.replace(/^ws/, "http");
  const client = new WebSocketAgentBackend({ url: server.url });
  await client.connect();
  check("WebSocket clients see the live source as not simulated", client.simulated === false && client.label === "Live · Claude Code");
  const seen: AgentEvent[] = [];
  client.subscribe((e) => seen.push(e));

  const res = await fetch(`${httpUrl}/hook`, { method: "POST", body: JSON.stringify(sample[1]!.payload) });
  check("POST /hook answers 204 with an empty body", res.status === 204 && (await res.text()) === "");
  check("…and the prompt reaches WebSocket clients", await until(() => seen.some((e) => e.type === "task.created")));
  const created = () => seen.filter((e) => e.type === "task.created").length;
  const before = created();
  await fetch(`${httpUrl}/hook`, { method: "POST", body: JSON.stringify({ ...sample[1]!.payload, prompt: "dup check" }) });
  await fetch(`${httpUrl}/hook`, { method: "POST", body: JSON.stringify({ ...sample[1]!.payload, prompt: "dup check" }) });
  await until(() => created() > before);
  await sleep(150);
  check("a payload delivered twice (hooks at user and project level) counts once", created() === before + 1, `${created() - before}`);
  const bad = await fetch(`${httpUrl}/hook`, { method: "POST", body: "{not json" });
  check("malformed payloads are still answered 204 (never a hook error in Claude Code)", bad.status === 204);

  const forwarder = join(root, "bridge", "forward-hook.sh");
  // Claude Code runs hook commands through a shell; on Windows that is Git Bash, so run it the same way here.
  const gitBash = [process.env.CLAUDE_CODE_GIT_BASH_PATH, "C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((p) => p && existsSync(p));
  const runForwarder = (env: Record<string, string>) =>
    process.platform === "win32"
      ? spawnSync(gitBash ?? "bash", [forwarder.replaceAll("\\", "/")], { input: payload, env: { ...process.env, ...env }, encoding: "utf8" })
      : spawnSync(forwarder, { input: payload, env: { ...process.env, ...env }, encoding: "utf8" });
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", session_id: sample[1]!.payload.session_id, tool_name: "Edit", tool_input: { file_path: "/x/y.ts" } });
  const run = runForwarder({ AAW_HOOK_URL: `${httpUrl}/hook` });
  check("forward-hook.sh exits 0 and prints nothing", run.status === 0 && run.stdout === "" && run.stderr === "", `${run.status} ${JSON.stringify(run.stdout)} ${JSON.stringify(run.stderr)}`);
  check("…and its payload moves Kai", await until(() => client.getSnapshot()?.agents.find((a) => a.id === "kai")?.destination === "dev" || client.getSnapshot()?.agents.find((a) => a.id === "kai")?.location === "dev"));

  await client.disconnect();
  await server.close();
  await live.disconnect();

  const t0 = Date.now();
  const down = runForwarder({ AAW_HOOK_URL: "http://127.0.0.1:9/hook" });
  check("with no server running it still exits 0, silently, within 2 s", down.status === 0 && down.stdout === "" && Date.now() - t0 < 2500, `${down.status} in ${Date.now() - t0} ms`);
}

console.log(failures === 0 ? "\nAll live checks passed." : `\n${failures} live check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
