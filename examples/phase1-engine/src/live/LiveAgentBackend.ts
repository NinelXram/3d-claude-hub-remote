// Live source: mirrors a real Claude Code session from its hook payloads.
//
// Nothing here is simulated. Each robot stands for one kind of real action, and moves only when a hook says
// that action happened:
//   Orion  your prompt, subagent delegation, waiting for you      Piper  todo lists and plan mode
//   Iris   reading, searching, fetching                            Kai    editing files, running commands
//   Quinn  test / lint / typecheck / build commands                Rex    git diff, log, show; PR review
// Phases and progress are inferred from the latest action, so the UI labels this source "Live · Claude Code".
// With several sessions at once, one focused session drives the robots (see LiveAgentBackend below).
import type { AgentId, AgentState } from "../agents/agentTypes.ts";
import { AGENTS, getAgent } from "../agents/AgentRegistry.ts";
import { AgentController } from "../agents/AgentController.ts";
import type { Action } from "../agents/AgentController.ts";
import type { AgentEvent, AgentEventType, EventSeverity } from "../events/eventTypes.ts";
import type { AgentBackend, CommLink, LiveSessionSummary, SimulationStatus, WorldSnapshot } from "../integrations/AgentBackend.ts";
import { EventBus } from "../simulation/EventBus.ts";
import { SIM_CONFIG } from "../simulation/simulationConfig.ts";
import { isTerminal } from "../simulation/WorkflowStateMachine.ts";
import { LOCATIONS } from "../simulation/worldLayout.ts";
import type { LocationId } from "../simulation/worldLayout.ts";
import { PHASE_STATUS } from "../tasks/taskTypes.ts";
import { slashCommand, typedText } from "./promptText.ts";
import type { CreateTaskInput, Task, WorkflowPhase } from "../tasks/taskTypes.ts";

/** The subset of Claude Code hook input this source reads. Unknown fields are ignored. */
export interface HookPayload {
  hook_event_name: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  agent_type?: string;
  source?: string;
  reason?: string;
  message?: string;
}

interface Role {
  phase: WorkflowPhase;
  location: LocationId;
}

const ROLES: Record<AgentId, Role> = {
  orion: { phase: "intake", location: "hub" },
  piper: { phase: "planning", location: "planning" },
  iris: { phase: "research", location: "research" },
  kai: { phase: "implementation", location: "dev" },
  quinn: { phase: "testing", location: "testing" },
  rex: { phase: "review", location: "review" },
};

const READ_TOOLS = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|NotebookRead|ListMcpResources|ReadMcpResource)$/;
const PLAN_TOOLS = /^(TodoWrite|TaskCreate|TaskUpdate|TaskList|EnterPlanMode|ExitPlanMode)$/;
const EDIT_TOOLS = /^(Edit|MultiEdit|Write|NotebookEdit)$/;
const DELEGATE_TOOLS = /^(Agent|Task|Skill|AskUserQuestion)$/;
/** Claude Code's own plumbing (loading tool schemas and the like): not work done for the user, so not shown. */
const IGNORED_TOOLS = /^(ToolSearch)$/;
// Matched against the start of one command (after any `VAR=value` prefixes), never against arguments,
// so `cat test/cart.test.js` is reading, not testing.
const TEST_COMMAND = new RegExp(
  "^(?:\\w+=\\S*\\s+)*(?:" + [
    "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|lint|typecheck|type-check|check|build)\\b",
    "(?:npx|pnpm(?:\\s+exec)?|yarn|bunx)\\s+(?:jest|vitest|mocha|playwright|tsc|eslint|biome)\\b",
    "node\\s+(?:--\\S+\\s+)*--test\\b",
    "(?:jest|vitest|mocha|tsc|eslint|ruff|mypy|pytest|rspec|phpunit)\\b",
    "python3?\\s+-m\\s+(?:pytest|unittest|mypy)\\b",
    "(?:cargo|go|dotnet|mvn|gradle|swift|deno|bun)\\s+(?:test|build|vet|check|clippy)\\b",
    "make\\s+(?:test|check|lint)\\b",
  ].join("|") + ")",
);
const REVIEW_COMMAND = /^\s*(git\s+(diff|log|show|blame)\b|gh\s+pr\s+(view|diff|review|checks)\b)/;
const READ_COMMAND = /^\s*(cat|head|tail|less|more|ls|tree|find|fd|grep|rg|ag|wc|file|stat|pwd|echo|printf|which|type|du|df|jq|sed\s+-n|awk|sort|uniq|cut|git\s+(status|branch|remote|ls-files))\b/;

export interface Classified {
  agent: AgentId;
  /** Short, factual description of what the session is doing, e.g. "Edit · src/app.ts". */
  label: string;
}

/** Split a shell command into the commands it runs (`a; b && c | d` → a, b, c, d). Good enough for classification. */
function segments(command: string): string[] {
  return command.split(/;|&&|\|\||\||\n/).map((s) => s.replace(/^\s*\(+|\)+\s*$/g, "").trim()).filter(Boolean);
}

export type TestOutcome = "passed" | "failed" | "unknown";

const FAIL_MARKERS = [
  /ℹ fail [1-9]/, /^# fail [1-9]/m, // node:test (spec and TAP reporters)
  /\b[1-9]\d* (failed|failing)\b/i, /Tests?:\s+[1-9]\d* failed/, // jest, vitest, mocha, pytest summary
  /^\s*(FAIL|FAILED)\b/m, /^\s*[✕✖×✗]\s/m, // per-test failure lines
  /test result: FAILED/, /panicked at/, // cargo
  /error TS\d+/, /Found [1-9]\d* errors?/, // tsc
  /npm ERR!|npm error/, /Error: Cannot find module/, /AssertionError/, /Traceback \(most recent call last\)/,
];
const PASS_MARKERS = [
  /ℹ pass [1-9]\d*[\s\S]*ℹ fail 0\b/, /^# fail 0\b/m,
  /\b[1-9]\d* passed\b/i, /Tests?:\s+[1-9]\d* passed/,
  /test result: ok/, /Found 0 errors/, /\bAll (tests|specs|checks) passed\b/i,
];

/**
 * Pass/fail from a command's own output. Exit codes alone are not enough: Claude often pipes test runs
 * (`npm test 2>&1 | tail -15`), and the pipe reports tail's exit code, so a failing run arrives as PostToolUse.
 */
export function testOutcome(output: string): TestOutcome {
  if (FAIL_MARKERS.some((r) => r.test(output))) return "failed";
  if (PASS_MARKERS.some((r) => r.test(output))) return "passed";
  return "unknown";
}

function bashOutput(response: unknown): string {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    return `${str(r["stdout"])}\n${str(r["stderr"])}`;
  }
  return "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function oneLine(s: string, max: number): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function relPath(path: string, cwd: string | undefined): string {
  if (!path) return "";
  if (cwd && path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  const parts = path.split("/");
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/**
 * Which robot a tool call belongs to, and what to say about it; null for plumbing that is not shown.
 * Pure, so it is easy to test and tune.
 */
export function classifyTool(tool: string, input: Record<string, unknown> = {}, cwd?: string): Classified | null {
  if (IGNORED_TOOLS.test(tool)) return null;
  const target = relPath(str(input["file_path"]) || str(input["notebook_path"]) || str(input["path"]), cwd);
  if (tool === "Bash") {
    const full = str(input["command"]);
    const label = `Bash · ${oneLine(full, 60)}`;
    const parts = segments(full);
    // A compound command belongs to its most telling part: tests, then review, then pure reading.
    if (parts.some((p) => TEST_COMMAND.test(p))) return { agent: "quinn", label };
    if (parts.some((p) => REVIEW_COMMAND.test(p))) return { agent: "rex", label };
    if (parts.length > 0 && parts.every((p) => READ_COMMAND.test(p))) return { agent: "iris", label };
    return { agent: "kai", label };
  }
  if (EDIT_TOOLS.test(tool)) return { agent: "kai", label: `${tool} · ${target || "file"}` };
  if (READ_TOOLS.test(tool)) {
    const what = target || oneLine(str(input["pattern"]) || str(input["query"]) || str(input["url"]), 48);
    return { agent: "iris", label: what ? `${tool} · ${what}` : tool };
  }
  if (PLAN_TOOLS.test(tool)) return { agent: "piper", label: tool === "TodoWrite" ? "Updating the todo list" : tool };
  if (DELEGATE_TOOLS.test(tool)) {
    const who = str(input["subagent_type"]) || str(input["skill"]) || "";
    return { agent: "orion", label: tool === "AskUserQuestion" ? "Asking you a question" : `${tool}${who ? ` · ${who}` : ""}` };
  }
  if (tool.startsWith("mcp__")) return { agent: "iris", label: tool.replace(/^mcp__/, "").replace(/__/g, " · ") };
  return { agent: "kai", label: tool };
}

function subagentRole(agentType: string): AgentId {
  if (/explore|research|search/i.test(agentType)) return "iris";
  if (/plan/i.test(agentType)) return "piper";
  if (/review|audit|security/i.test(agentType)) return "rex";
  if (/test|qa/i.test(agentType)) return "quinn";
  return "kai";
}

export interface LiveOptions {
  /** Show prompt text in task titles. Off: tasks are titled "Prompt 3". Default true (the server is loopback-only). */
  showPrompts?: boolean;
  /** Wall clock (ms). Session activity, focus hysteresis and expiry use it. */
  now?: () => number;
  /** Tick on a timer. Tests turn this off and call tick() themselves. */
  autoTick?: boolean;
}

/** Auto focus leaves a session only after it has been idle (turn ended, or no hook) this long (ms). */
export const FOCUS_IDLE_MS = 8000;
/** Tool calls issued in the same breath as a permission ask do not end the wait (ms). */
const WAIT_GRACE_MS = 2000;
/** Ended sessions leave the session list after this (ms). */
export const ENDED_TTL_MS = 3 * 60_000;
/** Any session with no hook for this long leaves the list (ms): it most likely died without a SessionEnd. */
const QUIET_TTL_MS = 60 * 60_000;
/** The snapshot lists at most this many sessions. */
const MAX_SESSIONS = 12;

type SessionStatus = LiveSessionSummary["status"];

/** Where one robot stands for a session, and what it says it is doing. */
interface Stage {
  location: LocationId;
  status: "working" | "thinking";
  activity: string;
}

/** Everything the live source knows about one Claude Code session, focused or not. */
interface LiveSession {
  id: string;
  cwd: string;
  project: string;
  title: string;
  /** The title came from a typed prompt; later prompts do not rename the session. */
  titled: boolean;
  status: SessionStatus;
  /** Wall-clock ms of the last hook. */
  lastActivity: number;
  waitingSince: number | null;
  taskId: string | null;
  /** The robot that holds the session's attention (the kind of action it is doing now). */
  holder: AgentId | null;
  /** Every robot this session holds and where: the scene to restore when the session gets focus. */
  stage: Map<AgentId, Stage>;
}

function projectOf(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/**
 * Several Claude Code sessions can run at once (different projects, terminal and web). The robots stand for kinds of
 * action, not for sessions, so only one session drives them: the focused one. Every session keeps its own state
 * (task, phase, which robot holds its attention, waiting or not); when focus moves, the robots re-stage to the new
 * session's state. Events from every session still reach the feed, the sounds and the "needs you" signals.
 */
export class LiveAgentBackend implements AgentBackend {
  readonly kind = "live" as const;
  readonly label = "Live · Claude Code";
  readonly simulated = false;

  private events = new EventBus<AgentEvent>();
  private snapshots = new EventBus<WorldSnapshot>();
  private controllers = new Map<AgentId, AgentController>();
  private holds = new Map<AgentId, number>();
  private releasedAt = new Map<AgentId, number>();
  private holdSeq = 0;
  private tasks = new Map<string, Task>();
  private taskSeq = 0;
  private sessions = new Map<string, LiveSession>();
  private focusId: string | null = null;
  private focusMode: "auto" | "pinned" = "auto";
  /** The session whose hook is being handled: its id and project go into every event's metadata. */
  private ctx: LiveSession | null = null;
  private links: CommLink[] = [];
  private linkSeq = 0;
  private eventSeq = 0;
  private clock = 0;
  private status: SimulationStatus = "running";
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private opts: Required<LiveOptions>;

  constructor(options: LiveOptions = {}) {
    this.opts = { showPrompts: true, now: Date.now, autoTick: true, ...options };
    for (const profile of AGENTS) {
      this.controllers.set(profile.id, new AgentController(profile, {
        walkSpeed: SIM_CONFIG.walkSpeed,
        onArrived: (id, location) => this.emit({ type: "agent.arrived", agentId: id, message: `${getAgent(id).name} arrived at the ${LOCATIONS[location].label}`, feed: false, metadata: { location } }),
        positionOf: (id) => this.ctrl(id).state.position,
        faceIfIdle: () => {},
      }));
      this.releasedAt.set(profile.id, 0);
    }
  }

  // ───────────────────────── AgentBackend ─────────────────────────

  async connect(): Promise<void> {
    if (this.timer || !this.opts.autoTick) {
      this.emitReady();
      return;
    }
    this.emitReady();
    this.last = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - this.last) / 1000, SIM_CONFIG.maxStepSeconds);
      this.last = now;
      this.tick(dt);
    }, 1000 / SIM_CONFIG.tickHz);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async start(): Promise<void> { this.setStatus("running", "system.started", "Live view running"); }
  async resume(): Promise<void> { this.setStatus("running", "system.resumed", "Live view resumed"); }
  async pause(): Promise<void> { this.setStatus("paused", "system.paused", "Live view paused (Claude Code keeps working; events are still recorded)"); }
  async stop(): Promise<void> { this.setStatus("ready", "system.stopped", "Live view stopped"); }

  async reset(): Promise<void> {
    this.tasks.clear();
    this.sessions.clear();
    this.focusId = null;
    this.focusMode = "auto";
    this.links = [];
    this.taskSeq = this.linkSeq = this.eventSeq = 0;
    this.clock = 0;
    for (const c of this.controllers.values()) c.resetToHome();
    this.emit({ type: "system.reset", message: "Live view cleared" });
    this.publish();
  }

  async setSpeed(multiplier: number): Promise<void> {
    if (multiplier !== 1) throw new Error("The live view runs in real time; speed cannot change.");
  }

  async submitTask(_input: CreateTaskInput): Promise<Task> {
    throw new Error("Live view is read-only: tasks come from prompts you type in Claude Code.");
  }

  async pauseAgent(_id: AgentId): Promise<void> {
    throw new Error("Live view is read-only: it cannot pause a real Claude Code session.");
  }

  async resumeAgent(_id: AgentId): Promise<void> {
    throw new Error("Live view is read-only: it cannot pause a real Claude Code session.");
  }

  /** Pin the robots to one session, or `null` to follow activity again (auto). */
  async focusSession(sessionId: string | null): Promise<void> {
    if (sessionId === null) {
      this.focusMode = "auto";
      // Choosing auto means "show me what is happening now": jump to the most active session without hysteresis.
      const best = this.mostActive();
      if (best) this.setFocus(best);
    } else {
      const s = this.sessions.get(sessionId);
      if (!s) throw new Error("No hooks from that session have reached this server yet, so the robots cannot follow it.");
      this.focusMode = "pinned";
      this.setFocus(s);
    }
    this.publish();
  }

  getSnapshot(): WorldSnapshot {
    return this.snapshot();
  }

  subscribe(listener: (e: AgentEvent) => void): () => void {
    return this.events.subscribe(listener);
  }

  subscribeSnapshot(listener: (s: WorldSnapshot) => void): () => void {
    return this.snapshots.subscribe(listener);
  }

  // ───────────────────────── hook ingestion ─────────────────────────

  ingest(p: HookPayload): void {
    const s = this.touch(p);
    this.ctx = s;
    try {
      // Focus is settled before the hook acts, so a session that just took focus plays this hook out in full.
      const asks = p.hook_event_name === "PermissionRequest" || p.hook_event_name === "Notification";
      this.autoFocus(asks ? s : null);
      if (this.handle(s, p)) this.publish();
    } finally {
      this.ctx = null;
    }
  }

  /** Creates or updates the session a hook belongs to: cwd, activity time and status. */
  private touch(p: HookPayload): LiveSession {
    const id = p.session_id ?? "default";
    const now = this.opts.now();
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, cwd: "", project: "", title: `Session ${id.slice(0, 8)}`, titled: false, status: "idle", lastActivity: now, waitingSince: null, taskId: null, holder: null, stage: new Map() };
      this.sessions.set(id, s);
    }
    if (p.cwd && p.cwd !== s.cwd) {
      s.cwd = p.cwd;
      s.project = projectOf(p.cwd);
    }
    s.lastActivity = now;
    const before = s.status;
    s.status = this.nextStatus(s, p.hook_event_name, now);
    if (s.status === "waiting" && before !== "waiting") s.waitingSince = now;
    if (before === "waiting" && s.status !== "waiting") {
      s.waitingSince = null;
      // Claude is working again: Orion stops waiting at the hub unless Orion is what the session is doing.
      if (s.holder !== "orion") this.unhold(s, "orion");
    }
    return s;
  }

  private nextStatus(s: LiveSession, hook: string, now: number): SessionStatus {
    switch (hook) {
      case "UserPromptSubmit":
        return "running";
      case "PermissionRequest":
      case "Notification":
        return "waiting";
      case "Stop":
      case "StopFailure":
        return "idle";
      case "SessionEnd":
        return "ended";
      case "SessionStart":
        return s.status === "ended" ? "idle" : s.status;
      case "PreToolUse":
      case "PostToolUse":
      case "PostToolUseFailure":
      case "SubagentStart":
      case "SubagentStop":
      case "PreCompact":
        // Parallel tool calls issued with the ask are not an answer to it.
        if (s.status === "waiting" && s.waitingSince !== null && now - s.waitingSince < WAIT_GRACE_MS) return "waiting";
        return "running";
      case "PermissionDenied":
        return "running";
      default:
        return s.status;
    }
  }

  /** Acts out one hook for its session. Returns false for hooks that change nothing. */
  private handle(s: LiveSession, p: HookPayload): boolean {
    switch (p.hook_event_name) {
      case "SessionStart":
        this.emit({ type: "system.started", message: `Claude Code session ${p.source ?? "started"}${p.cwd ? ` in ${p.cwd.split("/").pop()}` : ""}` });
        break;
      case "SessionEnd":
        this.finish(s, "failed", `Session ended (${p.reason ?? "exit"}) before Claude finished`);
        this.emit({ type: "system.stopped", message: `Claude Code session ended (${p.reason ?? "exit"})` });
        for (const id of [...s.stage.keys()]) this.unhold(s, id);
        break;
      case "UserPromptSubmit":
        this.onPrompt(s, p);
        break;
      case "PreToolUse": {
        const c = p.tool_name ? classifyTool(p.tool_name, p.tool_input, p.cwd) : null;
        if (!c) return false;
        // Ticking items off an existing todo list is bookkeeping: update the cards, keep the current robot working.
        // Only a new list, or one that grew, counts as Piper planning.
        if (p.tool_name === "TodoWrite" && !this.onTodos(s, p.tool_input?.["todos"])) break;
        this.onTool(s, c);
        break;
      }
      case "PostToolUse": {
        const c = p.tool_name ? classifyTool(p.tool_name, p.tool_input, p.cwd) : null;
        if (!c) return false;
        // Exit 0 is not proof for a test run: a pipe (`| tail`) reports the last command's status.
        const piped = segments(str(p.tool_input?.["command"])).length > 1;
        const seen = c.agent === "quinn" ? testOutcome(bashOutput(p.tool_response)) : "passed";
        this.onToolResult(s, c, seen === "unknown" && !piped ? "passed" : seen, "");
        break;
      }
      case "PostToolUseFailure": {
        const c = p.tool_name ? classifyTool(p.tool_name, p.tool_input, p.cwd) : null;
        if (!c || p.is_interrupt) return false;
        this.onToolResult(s, c, "failed", str(p.error).split("\n")[0] ?? "");
        break;
      }
      case "PermissionRequest": {
        const c = p.tool_name ? classifyTool(p.tool_name, p.tool_input, p.cwd) : null;
        this.hold(s, "orion", "hub", "thinking", `Waiting for your permission${c ? `: ${c.label}` : ""}`);
        this.emit({ type: "agent.message", agentId: "orion", taskId: this.task(s)?.id, severity: "warning", message: `Needs your permission${c ? ` · ${c.label}` : ""}` });
        break;
      }
      case "PermissionDenied": {
        const c = p.tool_name ? classifyTool(p.tool_name, p.tool_input, p.cwd) : null;
        if (c) this.emoteFor(s, c.agent, "error", `Not allowed · ${c.label}`);
        this.emit({ type: "agent.message", agentId: c?.agent ?? "orion", taskId: this.task(s)?.id, severity: "warning", message: `Not allowed${c ? ` · ${c.label}` : ""}` });
        break;
      }
      case "SubagentStart": {
        const role = subagentRole(p.agent_type ?? "");
        const task = this.task(s);
        this.linkFor(s, "orion", role, "assign");
        this.emit({ type: "task.assigned", agentId: "orion", targetAgentId: role, taskId: task?.id, message: `Subagent started: ${p.agent_type ?? "general-purpose"}` });
        this.hold(s, role, ROLES[role].location, "working", `Subagent · ${p.agent_type ?? "general-purpose"}`);
        break;
      }
      case "SubagentStop": {
        const role = subagentRole(p.agent_type ?? "");
        this.linkFor(s, role, "orion", "report");
        this.emit({ type: "agent.message", agentId: role, targetAgentId: "orion", taskId: this.task(s)?.id, message: `Subagent finished: ${p.agent_type ?? "general-purpose"}` });
        if (s.holder !== role) this.unhold(s, role);
        break;
      }
      case "Notification":
        this.hold(s, "orion", "hub", "thinking", `Waiting for you${p.message ? `: ${oneLine(p.message, 60)}` : ""}`);
        this.emit({ type: "agent.message", agentId: "orion", taskId: this.task(s)?.id, severity: "warning", message: `Claude Code needs you${p.message ? `: ${oneLine(p.message, 80)}` : ""}` });
        break;
      case "PreCompact":
        this.hold(s, "piper", "planning", "thinking", "Compacting the conversation");
        break;
      case "Stop":
        // Stop means the turn ended, not that the work is finished: Claude may be asking a question.
        this.finish(s, "done", "Turn ended · your move");
        break;
      case "StopFailure":
        this.finish(s, "failed", `Claude stopped with an error: ${oneLine(str(p.error), 80)}`);
        break;
      default:
        return false; // unknown or uninteresting event: ignore
    }
    return true;
  }

  private onPrompt(s: LiveSession, p: HookPayload): void {
    const prev = this.task(s);
    if (prev && !isTerminal(prev.phase)) this.finish(s, "failed", "Interrupted: a new prompt arrived before Claude finished");
    const n = ++this.taskSeq;
    const id = `T-${String(n).padStart(3, "0")}`;
    // What you typed, without the IDE selection or slash-command wrappers Claude Code adds.
    const raw = p.prompt ?? "";
    const text = typedText(raw) || slashCommand(raw) || "";
    const title = this.opts.showPrompts && text ? oneLine(text, 90) : `Prompt ${n}`;
    // The session is named after its first typed prompt (a slash command only until a real prompt arrives).
    if (this.opts.showPrompts && text && (!s.titled || s.title.startsWith("/"))) {
      s.title = oneLine(text, 60);
      s.titled = true;
    }
    const task: Task = {
      id, title,
      description: this.opts.showPrompts ? oneLine(text, 280) : "",
      priority: "medium", status: "assigned", phase: "intake", assignedAgentId: "orion",
      progress: SIM_CONFIG.phaseProgress.intake[0], createdAt: this.clock, updatedAt: this.clock, completedAt: null,
      iteration: 0, subtasks: [], findings: [],
      history: [{ from: "queued", to: "intake", signal: "observed", at: this.clock }],
      isDemo: false, preferredAgentId: null, blockedReason: null,
      origin: { sessionId: s.id, project: s.project },
    };
    this.tasks.set(id, task);
    s.taskId = id;
    this.emit({ type: "task.created", taskId: id, message: `${id}: ${title}` });
    this.switchTo(s, "orion", "Reading your prompt", "thinking");
  }

  private onTool(s: LiveSession, c: Classified): void {
    this.ensureTask(s);
    this.switchTo(s, c.agent, c.label, "working");
    const task = this.task(s)!;
    if (c.agent === "quinn") this.emit({ type: "qa.started", agentId: "quinn", taskId: task.id, message: c.label, feed: false });
    if (c.agent === "rex") this.emit({ type: "review.started", agentId: "rex", taskId: task.id, message: c.label, feed: false });
  }

  /**
   * Claude's own todo list becomes the task cards on the planning board.
   * Returns true when this is planning (a first list, or new items), false for a status update.
   */
  private onTodos(s: LiveSession, todos: unknown): boolean {
    this.ensureTask(s);
    const task = this.task(s);
    if (!task || !Array.isArray(todos)) return true;
    const subtasks = todos
      .filter((t): t is { content?: unknown; status?: unknown } => typeof t === "object" && t !== null)
      .slice(0, 24)
      .map((t, i) => ({ id: `${task.id}.${i + 1}`, title: oneLine(str(t.content), 80), done: t.status === "completed" }));
    const cur = this.tasks.get(task.id)!;
    this.tasks.set(task.id, { ...cur, subtasks, updatedAt: this.clock });
    const known = new Set(cur.subtasks.map((x) => x.title));
    const added = subtasks.filter((x) => !known.has(x.title)).length;
    if (cur.subtasks.length === 0 && subtasks.length > 0) {
      this.emit({ type: "plan.created", agentId: "piper", taskId: task.id, message: `Todo list with ${subtasks.length} items`, metadata: { subtasks: subtasks.map((x) => x.title) } });
      return true;
    }
    return added > 0;
  }

  private onToolResult(s: LiveSession, c: Classified, outcome: TestOutcome, error: string): void {
    const task = this.task(s);
    const what = c.label.replace(/^Bash · /, "");
    if (c.agent === "quinn") {
      if (outcome === "unknown") {
        // Honest middle ground: the run happened, but its output does not say how it went.
        this.emit({ type: "agent.message", agentId: "quinn", taskId: task?.id, message: `Ran · ${what} (result not visible in the output)` });
        return;
      }
      const ok = outcome === "passed";
      this.emoteFor(s, "quinn", ok ? "success" : "error", ok ? `✓ ${what}` : `✗ ${what}`);
      this.emit(ok
        ? { type: "qa.passed", agentId: "quinn", taskId: task?.id, severity: "success", message: `Passed · ${what}` }
        : { type: "qa.failed", agentId: "quinn", taskId: task?.id, severity: "warning", message: `Failed · ${what}${error ? ` (${error})` : ""}`, metadata: { error } });
      if (!ok && task) this.bump(task);
      return;
    }
    if (outcome === "failed") {
      this.emoteFor(s, c.agent, "error", `✗ ${c.label}`);
      this.emit({ type: "agent.message", agentId: c.agent, taskId: task?.id, severity: "warning", message: `Failed · ${c.label}${error ? ` (${error})` : ""}` });
    }
  }

  /** Hand the session's attention to `agent`: the previous holder is released, a link shows the handoff. */
  private switchTo(s: LiveSession, agent: AgentId, activity: string, status: "working" | "thinking"): void {
    const prev = s.holder;
    const task = this.task(s);
    if (prev && prev !== agent) {
      this.unhold(s, prev);
      this.linkFor(s, prev, agent, prev === "orion" ? "assign" : "message");
      this.emit({ type: "agent.message", agentId: prev, targetAgentId: agent, taskId: task?.id, message: activity });
    }
    s.holder = agent;
    this.hold(s, agent, ROLES[agent].location, status, activity);
    if (task && agent !== "orion") this.observePhase(task, ROLES[agent].phase, agent);
  }

  private observePhase(task: Task, phase: WorkflowPhase, agent: AgentId): void {
    const cur = this.tasks.get(task.id)!;
    if (isTerminal(cur.phase)) return;
    const next: Task = { ...cur, assignedAgentId: agent, updatedAt: this.clock };
    if (cur.phase !== phase) {
      next.phase = phase;
      next.status = PHASE_STATUS[phase];
      next.progress = Math.max(cur.progress, SIM_CONFIG.phaseProgress[phase][0]);
      next.history = [...cur.history, { from: cur.phase, to: phase, signal: "observed", at: this.clock }];
      if (phase === "implementation") {
        next.iteration = cur.iteration + 1;
        this.emit({ type: "implementation.started", agentId: "kai", taskId: task.id, message: `Implementation round ${next.iteration}`, feed: false, metadata: { iteration: next.iteration } });
      }
      this.emit({ type: "task.status_changed", taskId: task.id, agentId: agent, message: `${task.id}: ${cur.phase} → ${phase}`, feed: false, metadata: { from: cur.phase, to: phase, signal: "observed" } });
    }
    this.tasks.set(task.id, next);
  }

  private bump(task: Task): void {
    const cur = this.tasks.get(task.id)!;
    this.tasks.set(task.id, { ...cur, updatedAt: this.clock });
  }

  private finish(s: LiveSession, outcome: "done" | "failed", message: string): void {
    const task = this.task(s);
    const holder = s.holder;
    if (holder) this.unhold(s, holder);
    s.holder = null;
    // Orion's announcement below replaces any wait at the hub.
    s.stage.delete("orion");
    if (!task || isTerminal(task.phase)) return;
    const done: Task = {
      ...task,
      phase: outcome,
      status: PHASE_STATUS[outcome],
      progress: outcome === "done" ? 1 : task.progress,
      assignedAgentId: null,
      completedAt: this.clock,
      updatedAt: this.clock,
      history: [...task.history, { from: task.phase, to: outcome, signal: "observed", at: this.clock }],
    };
    this.tasks.set(task.id, done);
    if (holder && holder !== "orion") this.linkFor(s, holder, "orion", "report");
    if (outcome === "done") {
      this.actFor(s, "orion", [
        { kind: "move", to: "hub", activity: "Heading to the hub" },
        { kind: "emote", status: "success", duration: SIM_CONFIG.durations.announce, activity: `${task.id} done` },
      ]);
      this.emit({ type: "task.completed", agentId: "orion", taskId: task.id, severity: "success", message: `${task.id} · ${message}` });
    } else {
      this.emoteFor(s, "orion", "error", `${task.id} stopped`);
      this.emit({ type: "task.failed", agentId: "orion", taskId: task.id, severity: "error", message: `${task.id} · ${message}` });
    }
  }

  /** A tool call can arrive with no prompt first (hooks enabled mid-session). Open a task so it has a home. */
  private ensureTask(s: LiveSession): void {
    const t = this.task(s);
    if (t && !isTerminal(t.phase)) return;
    this.onPrompt(s, { hook_event_name: "UserPromptSubmit", prompt: "" });
  }

  private task(s: LiveSession): Task | undefined {
    return s.taskId ? this.tasks.get(s.taskId) : undefined;
  }

  // ───────────────────────── focus ─────────────────────────

  /**
   * Auto focus: follow the most recently active session, with hysteresis. Focus moves only when the focused session
   * has been idle (turn ended, or no hook) for FOCUS_IDLE_MS, or has ended, and then only to a session that is
   * running or waiting. A session that starts waiting for you (`stealer`) takes focus at once. Pinned focus stays
   * until you pick another session or auto, or until the pinned session drops out of the list.
   */
  private autoFocus(stealer: LiveSession | null = null): void {
    if (this.focusMode === "pinned") {
      if (this.focusId && this.sessions.has(this.focusId)) return;
      this.focusMode = "auto";
    }
    if (stealer) return this.setFocus(stealer);
    const cur = this.focusId ? this.sessions.get(this.focusId) : undefined;
    if (!cur) return this.setFocus(this.mostActive());
    if (cur.status === "waiting") return;
    const ended = cur.status === "ended";
    if (!ended && this.opts.now() - cur.lastActivity < FOCUS_IDLE_MS) return;
    const next = this.mostActive(cur, ended ? ["waiting", "running", "idle"] : ["waiting", "running"]);
    if (next) this.setFocus(next);
  }

  /** The session to follow: waiting first, then running, then idle; newest activity within each. */
  private mostActive(except?: LiveSession, statuses: SessionStatus[] = ["waiting", "running", "idle"]): LiveSession | null {
    let best: LiveSession | null = null;
    for (const s of this.sessions.values()) {
      if (s === except || !statuses.includes(s.status)) continue;
      if (!best) best = s;
      else {
        const rank = statuses.indexOf(s.status) - statuses.indexOf(best.status);
        if (rank < 0 || (rank === 0 && s.lastActivity > best.lastActivity)) best = s;
      }
    }
    return best;
  }

  /** Move focus and re-stage the robots: the new session's holders go to their stations, everyone else goes home. */
  private setFocus(next: LiveSession | null): void {
    const id = next?.id ?? null;
    if (id === this.focusId) return;
    this.focusId = id;
    for (const profile of AGENTS) {
      const stage = next?.stage.get(profile.id);
      if (stage) {
        this.holdAt(profile.id, stage.location, stage.status, stage.activity);
        continue;
      }
      const c = this.ctrl(profile.id);
      this.release(profile.id);
      if (c.busy) c.clear();
      // Head home on the next tick instead of after the usual pause: this robot belonged to another story.
      this.releasedAt.set(profile.id, this.clock - SIM_CONFIG.returnHomeDelay);
    }
    // Arcs in flight belong to the previous session's story.
    this.links = [];
  }

  /** Ended sessions leave after ENDED_TTL_MS, silent ones after QUIET_TTL_MS; at most MAX_SESSIONS are kept. */
  private prune(): void {
    const now = this.opts.now();
    for (const [id, s] of this.sessions) {
      const age = now - s.lastActivity;
      if ((s.status === "ended" && age > ENDED_TTL_MS) || age > QUIET_TTL_MS) this.sessions.delete(id);
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const old = [...this.sessions.values()].filter((s) => s.id !== this.focusId).sort((a, b) => a.lastActivity - b.lastActivity);
      for (const s of old.slice(0, this.sessions.size - MAX_SESSIONS)) this.sessions.delete(s.id);
    }
  }

  // ───────────────────────── motion (only the focused session moves robots) ─────────────────────────

  private focused(s: LiveSession): boolean {
    return this.focusId === s.id;
  }

  private hold(s: LiveSession, agent: AgentId, location: LocationId, status: "working" | "thinking", activity: string): void {
    s.stage.set(agent, { location, status, activity });
    if (this.focused(s)) this.holdAt(agent, location, status, activity);
  }

  private unhold(s: LiveSession, agent: AgentId): void {
    const had = s.stage.delete(agent);
    if (had && this.focused(s)) this.release(agent);
  }

  private emoteFor(s: LiveSession, agent: AgentId, status: "success" | "error", activity: string): void {
    if (this.focused(s)) this.emote(agent, status, activity);
  }

  private actFor(s: LiveSession, agent: AgentId, actions: Action[]): void {
    if (this.focused(s)) this.act(agent, actions);
  }

  private linkFor(s: LiveSession, from: AgentId, to: AgentId, kind: CommLink["kind"]): void {
    if (this.focused(s)) this.link(from, to, kind);
  }

  private holdAt(agent: AgentId, location: LocationId, status: "working" | "thinking", activity: string): void {
    const token = ++this.holdSeq;
    this.holds.set(agent, token);
    const c = this.ctrl(agent);
    // Already holding at the right place: just update what it says it is doing.
    if (c.state.location === location && c.state.path.length === 0 && c.busy) {
      c.clear();
    } else {
      c.clear();
      c.enqueue({ kind: "move", to: location, activity: `Heading to the ${LOCATIONS[location].label}` });
    }
    c.enqueue({ kind: "wait", until: () => this.holds.get(agent) !== token, timeout: Number.MAX_SAFE_INTEGER, status, activity });
  }

  private act(agent: AgentId, actions: Action[]): void {
    this.holds.set(agent, ++this.holdSeq);
    const c = this.ctrl(agent);
    c.clear();
    c.enqueue(...actions);
    this.releasedAt.set(agent, this.clock);
  }

  private emote(agent: AgentId, status: "success" | "error", activity: string): void {
    const c = this.ctrl(agent);
    const token = this.holds.get(agent);
    const holding = c.busy;
    const duration = status === "error" ? SIM_CONFIG.durations.errorEmote : SIM_CONFIG.durations.celebrate;
    const keep = c.state.activity;
    const keepStatus = c.state.status === "thinking" ? "thinking" : "working";
    c.clear();
    c.enqueue({ kind: "emote", status, duration, activity });
    // Go back to holding if this agent still has the session's attention.
    if (holding && token !== undefined) c.enqueue({ kind: "wait", until: () => this.holds.get(agent) !== token, timeout: Number.MAX_SAFE_INTEGER, status: keepStatus, activity: keep });
  }

  private release(agent: AgentId): void {
    this.holds.set(agent, ++this.holdSeq);
    this.releasedAt.set(agent, this.clock);
  }

  private link(from: AgentId, to: AgentId, kind: CommLink["kind"]): void {
    if (from === to) return;
    this.links.push({ id: `L-${++this.linkSeq}`, from, to, kind, startedAt: this.clock, endsAt: this.clock + SIM_CONFIG.linkDuration });
  }

  tick(dt: number): void {
    if (this.status !== "running") return;
    this.clock += dt;
    this.prune();
    this.autoFocus();
    for (const profile of AGENTS) {
      const c = this.ctrl(profile.id);
      c.step(dt);
      // Idle and away from home: walk back after a short pause.
      if (!c.busy && c.state.location !== profile.home && this.clock - this.releasedAt.get(profile.id)! >= SIM_CONFIG.returnHomeDelay) {
        c.enqueue({ kind: "move", to: profile.home, activity: "Heading back to desk" });
      }
    }
    this.links = this.links.filter((l) => l.endsAt > this.clock);
    this.publish();
  }

  // ───────────────────────── plumbing ─────────────────────────

  /** Which session the robots follow (tests and the server log). */
  get focus(): { sessionId: string | null; mode: "auto" | "pinned" } {
    return { sessionId: this.focusId, mode: this.focusMode };
  }

  snapshot(): WorldSnapshot {
    const sessions: LiveSessionSummary[] = [...this.sessions.values()]
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .map((s) => ({ sessionId: s.id, title: s.title, project: s.project, status: s.status, lastActivity: s.lastActivity }));
    return structuredClone({
      clock: this.clock,
      status: this.status,
      speed: 1,
      agents: AGENTS.map((a) => this.ctrl(a.id).state) as AgentState[],
      tasks: [...this.tasks.values()],
      links: this.links,
      live: { focus: { sessionId: this.focusId, mode: this.focusMode }, sessions },
    });
  }

  private emitReady(): void {
    this.emit({ type: "system.ready", message: "Live view ready · waiting for Claude Code hooks" });
    this.publish();
  }

  private setStatus(status: SimulationStatus, type: AgentEventType, message: string): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ type, message });
    this.publish();
  }

  private ctrl(id: AgentId): AgentController {
    return this.controllers.get(id)!;
  }

  private emit(e: { type: AgentEventType; message: string; agentId?: AgentId; targetAgentId?: AgentId; taskId?: string; severity?: EventSeverity; feed?: boolean; metadata?: Record<string, unknown> }): void {
    // Every event a hook causes says which session (and project) it belongs to, so the feed, the task cards and
    // the "needs you" signals can name it whether or not that session is the one the robots follow.
    const s = this.ctx;
    const metadata = s ? { session: s.id, project: s.project, sessionTitle: s.title, ...e.metadata } : e.metadata;
    const event: AgentEvent = { ...e, ...(metadata ? { metadata } : {}), id: `E-${++this.eventSeq}`, timestamp: this.opts.now(), simTime: this.clock, severity: e.severity ?? "info", feed: e.feed ?? true };
    for (const k of ["agentId", "targetAgentId", "taskId"] as const) if (event[k] === undefined) delete event[k];
    this.events.emit(event);
  }

  private publish(): void {
    if (this.snapshots.size > 0) this.snapshots.emit(this.snapshot());
  }
}
