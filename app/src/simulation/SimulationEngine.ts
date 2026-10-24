import type { AgentId, AgentState } from "../agents/agentTypes.ts";
import { AGENTS, PHASE_OWNER, getAgent } from "../agents/AgentRegistry.ts";
import { AgentController } from "../agents/AgentController.ts";
import type { Action } from "../agents/AgentController.ts";
import type { AgentEvent, AgentEventType, EventSeverity } from "../events/eventTypes.ts";
import type { CommLink, SimulationStatus, WorldSnapshot } from "../integrations/AgentBackend.ts";
import { PHASE_STATUS } from "../tasks/taskTypes.ts";
import type { CreateTaskInput, Task, WorkflowPhase, WorkflowSignal } from "../tasks/taskTypes.ts";
import { EventBus, createRng, hashString, rngRange } from "./EventBus.ts";
import { SIM_CONFIG } from "./simulationConfig.ts";
import { compareWork, pickNextTask } from "./TaskScheduler.ts";
import { applySignal, isTerminal } from "./WorkflowStateMachine.ts";
import { shortTitle, templateFor } from "./workContent.ts";
import { LOCATIONS } from "./worldLayout.ts";
import type { LocationId } from "./worldLayout.ts";

/** One unit of work an agent owes a task: "do the <phase> step of <task>". */
interface Job {
  taskId: string;
  phase: WorkflowPhase;
}

type EmitInput = Omit<AgentEvent, "id" | "timestamp" | "simTime" | "severity" | "feed"> & {
  severity?: EventSeverity;
  feed?: boolean;
};

const AMBIENT_SPOTS: LocationId[] = ["collab", "lounge", "planning"];

export class SimulationEngine {
  readonly events = new EventBus<AgentEvent>();
  readonly snapshots = new EventBus<WorldSnapshot>();

  private clock = 0;
  private status: SimulationStatus = "ready";
  private speed: number = SIM_CONFIG.defaultSpeed;
  private rng = createRng(SIM_CONFIG.seed);
  private tasks = new Map<string, Task>();
  private taskSeq = new Map<string, number>();
  private taskRng = new Map<string, () => number>();
  private nextTaskSeq = 0;
  private links: CommLink[] = [];
  private linkSeq = 0;
  private eventSeq = 0;
  private log: AgentEvent[] = [];
  private controllers = new Map<AgentId, AgentController>();
  private jobs = new Map<AgentId, Job[]>();
  private currentJob = new Map<AgentId, Job | null>();
  private idleSince = new Map<AgentId, number>();
  private nextAmbientAt = new Map<AgentId, number>();
  private now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    for (const profile of AGENTS) {
      this.controllers.set(
        profile.id,
        new AgentController(profile, {
          walkSpeed: SIM_CONFIG.walkSpeed,
          onArrived: (id, location) => this.onArrived(id, location),
          positionOf: (id) => this.ctrl(id).state.position,
          faceIfIdle: (listener, speaker) => {
            const c = this.ctrl(listener);
            if (!c.isIdleStill || c.state.paused) return;
            const p = c.state.position;
            const s = this.ctrl(speaker).state.position;
            c.state.heading = Math.atan2(s.x - p.x, s.z - p.z);
          },
        }),
      );
    }
    this.resetAgents();
  }

  // ───────────────────────── commands ─────────────────────────

  start(): void {
    if (this.status === "paused") return this.resume();
    if (this.status === "running") return;
    this.status = "running";
    this.emit({ type: "system.started", message: "Simulation started" });
    this.publish();
  }

  /** Halt ticking and return to `ready` without clearing anything; `start()` continues from the same clock. */
  stop(): void {
    if (this.status === "ready") return;
    this.status = "ready";
    this.emit({ type: "system.stopped", message: "Simulation stopped", feed: false });
    this.publish();
  }

  pause(): void {
    if (this.status !== "running") return;
    this.status = "paused";
    this.emit({ type: "system.paused", message: "Simulation paused", severity: "warning" });
    this.publish();
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.status = "running";
    this.emit({ type: "system.resumed", message: "Simulation resumed" });
    this.publish();
  }

  reset(): void {
    this.clock = 0;
    this.status = "ready";
    this.speed = SIM_CONFIG.defaultSpeed;
    this.rng = createRng(SIM_CONFIG.seed);
    this.tasks.clear();
    this.taskSeq.clear();
    this.taskRng.clear();
    this.nextTaskSeq = 0;
    this.links = [];
    this.linkSeq = 0;
    this.eventSeq = 0;
    this.log = [];
    this.resetAgents();
    this.emit({ type: "system.reset", message: "World reset" });
    this.publish();
  }

  setSpeed(multiplier: number): void {
    if (!(SIM_CONFIG.speeds as readonly number[]).includes(multiplier)) {
      throw new Error(`Unsupported speed ${multiplier}; use one of ${SIM_CONFIG.speeds.join(", ")}`);
    }
    if (multiplier === this.speed) return;
    this.speed = multiplier;
    this.emit({ type: "system.speed_changed", message: `Speed set to ${multiplier}×`, metadata: { speed: multiplier }, feed: false });
    this.publish();
  }

  submitTask(input: CreateTaskInput): Task {
    const seq = ++this.nextTaskSeq;
    const id = `T-${String(seq).padStart(3, "0")}`;
    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? "",
      priority: input.priority ?? "medium",
      status: "queued",
      phase: "queued",
      assignedAgentId: null,
      progress: 0,
      createdAt: this.clock,
      updatedAt: this.clock,
      completedAt: null,
      iteration: 0,
      subtasks: [],
      findings: [],
      history: [],
      isDemo: input.isDemo ?? false,
      preferredAgentId: input.preferredAgentId ?? null,
      blockedReason: null,
      ...(input.script ? { script: structuredClone(input.script) } : {}),
    };
    this.tasks.set(id, task);
    this.taskSeq.set(id, seq);
    this.taskRng.set(id, createRng(hashString(task.title) ^ SIM_CONFIG.seed ^ seq));
    const via = task.preferredAgentId ? ` (requested from ${getAgent(task.preferredAgentId).name}, routed via Orion)` : "";
    this.emit({ type: "task.created", taskId: id, message: `${id} created: ${shortTitle(task.title)}${via}`, metadata: { priority: task.priority } });
    this.publish();
    return structuredClone(task);
  }

  pauseAgent(id: AgentId): void {
    const c = this.ctrl(id);
    if (c.state.paused) return;
    c.state.paused = true;
    const name = getAgent(id).name;
    this.emit({ type: "agent.paused", agentId: id, message: `${name} paused`, severity: "warning" });
    for (const t of this.tasks.values()) {
      if (t.assignedAgentId === id && !isTerminal(t.phase)) this.block(t, `${name} is paused`);
    }
    this.publish();
  }

  resumeAgent(id: AgentId): void {
    const c = this.ctrl(id);
    if (!c.state.paused) return;
    c.state.paused = false;
    const name = getAgent(id).name;
    for (const t of this.tasks.values()) {
      if (t.assignedAgentId === id && t.status === "blocked") {
        this.put({ ...t, status: PHASE_STATUS[t.phase], blockedReason: null, updatedAt: this.clock });
        this.emit({ type: "task.unblocked", agentId: id, taskId: t.id, message: `${t.id} unblocked: ${name} is back` });
      }
    }
    this.emit({ type: "agent.resumed", agentId: id, message: `${name} resumed` });
    this.publish();
  }

  // ───────────────────────── reads ─────────────────────────

  getTask(id: string): Task | undefined {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : undefined;
  }

  getStatus(): SimulationStatus {
    return this.status;
  }

  getClock(): number {
    return this.clock;
  }

  eventLog(): readonly AgentEvent[] {
    return this.log;
  }

  snapshot(): WorldSnapshot {
    return structuredClone({
      clock: this.clock,
      status: this.status,
      speed: this.speed,
      agents: AGENTS.map((a) => this.ctrl(a.id).state),
      tasks: [...this.tasks.values()],
      links: this.links,
    });
  }

  emitBootEvents(): void {
    this.emit({ type: "system.ready", message: "3D Claude Hub Remote ready · simulation mode, no live inference" });
    for (const a of AGENTS) {
      this.emit({ type: "agent.arrived", agentId: a.id, message: `${a.name} is at the ${LOCATIONS[a.home].label}`, metadata: { location: a.home, boot: true } });
    }
  }

  // ───────────────────────── tick ─────────────────────────

  tick(realDtSeconds: number): void {
    if (this.status !== "running") return;
    const dt = realDtSeconds * this.speed;
    this.clock += dt;

    for (let t = pickNextTask([...this.tasks.values()], (x) => this.seqOf(x), SIM_CONFIG.maxConcurrentTasks); t; t = pickNextTask([...this.tasks.values()], (x) => this.seqOf(x), SIM_CONFIG.maxConcurrentTasks)) {
      this.transition(t.id, "picked_up");
    }

    for (const a of AGENTS) {
      this.dispatch(a.id);
      this.ctrl(a.id).step(dt);
    }

    this.links = this.links.filter((l) => l.endsAt > this.clock);
    this.publish();
  }

  // ───────────────────────── scheduling ─────────────────────────

  /**
   * Per-agent job queue: an agent does one job at a time, picks the best by (priority, createdAt, seq),
   * never preempts a running job, and drops ambient behaviour the moment a job is waiting.
   */
  private dispatch(id: AgentId): void {
    const c = this.ctrl(id);
    if (c.state.paused) return;
    if (this.currentJob.get(id)) return;
    const queue = this.jobs.get(id)!;
    if (queue.length > 0 && c.onlyAmbient) {
      queue.sort((a, b) => this.compareJobs(a, b));
      const job = queue.shift()!;
      c.interruptAmbient();
      this.currentJob.set(id, job);
      c.state.currentTaskId = job.taskId;
      c.enqueue(...this.buildJob(id, job), { kind: "call", fn: () => this.finishJob(id) });
      return;
    }
    if (!c.busy) this.idleBehaviour(id);
  }

  private compareJobs(a: Job, b: Job): number {
    const ta = this.tasks.get(a.taskId)!;
    const tb = this.tasks.get(b.taskId)!;
    return compareWork({ ...ta, seq: this.seqOf(ta) }, { ...tb, seq: this.seqOf(tb) });
  }

  private finishJob(id: AgentId): void {
    this.currentJob.set(id, null);
    this.ctrl(id).state.currentTaskId = null;
    this.idleSince.set(id, this.clock);
    this.nextAmbientAt.set(id, Math.max(this.nextAmbientAt.get(id)!, this.clock + SIM_CONFIG.ambient.minGap));
  }

  private idleBehaviour(id: AgentId): void {
    const c = this.ctrl(id);
    const profile = getAgent(id);
    const home = profile.home;
    if (c.state.location !== home) {
      if (this.clock - this.idleSince.get(id)! >= SIM_CONFIG.returnHomeDelay) {
        c.enqueue({ kind: "move", to: home, activity: "Heading back to desk", ambient: true });
      }
      return;
    }
    if (this.clock < this.nextAmbientAt.get(id)!) return;
    const { minGap, maxGap, minStay, maxStay } = SIM_CONFIG.ambient;
    const spot = AMBIENT_SPOTS[Math.floor(this.rng() * AMBIENT_SPOTS.length)]!;
    const stay = rngRange(this.rng, minStay, maxStay);
    this.nextAmbientAt.set(id, this.clock + rngRange(this.rng, minGap, maxGap));
    const label = LOCATIONS[spot].label;
    c.enqueue(
      { kind: "move", to: spot, slot: profile.seat, activity: `Stretching legs at the ${label}`, ambient: true },
      { kind: "call", fn: () => this.emit({ type: "agent.ambient", agentId: id, message: `${profile.name} is at the ${label}`, feed: false, metadata: { location: spot } }), ambient: true },
      { kind: "wait", until: () => false, timeout: stay, activity: "Taking a break", ambient: true },
      { kind: "move", to: home, activity: "Heading back to desk", ambient: true },
    );
  }

  // ───────────────────────── choreography ─────────────────────────

  private buildJob(id: AgentId, job: Job): Action[] {
    const t = () => this.tasks.get(job.taskId)!;
    const task = t();
    const d = SIM_CONFIG.durations;
    const tpl = templateFor(task.title, task.description);
    const short = shortTitle(task.title);
    const at = (loc: LocationId, slot?: number): Action => ({ kind: "move", to: loc, ...(slot === undefined ? {} : { slot }), activity: `Heading to the ${LOCATIONS[loc].label}` });
    const call = (fn: () => void): Action => ({ kind: "call", fn });
    const progress = (f: number) => {
      const [a, b] = SIM_CONFIG.phaseProgress[t().phase];
      const cur = t();
      this.put({ ...cur, progress: Math.max(cur.progress, a + (b - a) * f), updatedAt: this.clock });
    };

    switch (job.phase) {
      case "intake":
        return [
          at("hub"),
          { kind: "work", duration: d.intakeThink, status: "thinking", activity: `Reading ${task.id}: ${short}`, onProgress: progress },
          this.talk(id, "piper", d.assign, "assign", `Delegating ${task.id} to Piper`),
          call(() => {
            this.emit({ type: "task.assigned", agentId: id, targetAgentId: "piper", taskId: task.id, message: `Orion assigned ${task.id} to Piper: ${short}` });
            this.transition(task.id, "delegated");
          }),
        ];

      case "planning":
        return [
          at("planning", 0),
          { kind: "work", duration: d.breakdown, status: "working", activity: `Breaking down ${task.id}`, onProgress: progress },
          call(() => {
            const subtasks = tpl.subtasks.map((title, i) => ({ id: `${task.id}.${i + 1}`, title, done: false }));
            this.put({ ...t(), subtasks, updatedAt: this.clock });
            this.emit({ type: "plan.created", agentId: id, taskId: task.id, message: `Piper split ${task.id} into ${subtasks.length} task cards`, metadata: { subtasks: subtasks.map((s) => s.title) } });
          }),
          this.talk(id, "iris", d.coordinate, "message", "Briefing Iris on the plan"),
          call(() => {
            this.message(id, "iris", task.id, `${tpl.subtasks.length} cards ready, need research on "${short}"`);
            this.transition(task.id, "plan_ready");
          }),
        ];

      case "research":
        return [
          at("research"),
          { kind: "work", duration: d.research, status: "working", activity: `Researching ${short}`, onProgress: progress },
          call(() => this.put({ ...t(), findings: [...tpl.findings], updatedAt: this.clock })),
          this.talk(id, "kai", d.publish, "message", "Sharing findings with Kai"),
          call(() => {
            this.message(id, "kai", task.id, `${tpl.findings[0]}`);
            this.emit({ type: "research.completed", agentId: id, targetAgentId: "kai", taskId: task.id, message: `Iris published ${tpl.findings.length} findings for ${task.id}`, metadata: { findings: tpl.findings } });
            this.transition(task.id, "findings_published");
          }),
        ];

      case "implementation": {
        const iteration = task.iteration;
        const first = iteration <= 1;
        return [
          at("dev"),
          call(() => this.emit({ type: "implementation.started", agentId: id, taskId: task.id, message: first ? `Kai started building ${task.id}` : `Kai is reworking ${task.id} (attempt ${iteration})`, metadata: { iteration } })),
          {
            kind: "work",
            duration: first ? d.implement : d.fix,
            status: "working",
            activity: first ? `Implementing ${short}` : `Fixing feedback on ${task.id}`,
            onProgress: (f) => {
              progress(f);
              const cur = t();
              const n = Math.ceil(f * cur.subtasks.length);
              if (cur.subtasks.some((s, i) => i < n && !s.done)) {
                this.put({ ...cur, subtasks: cur.subtasks.map((s, i) => (i < n ? { ...s, done: true } : s)) });
              }
            },
          },
          this.talk(id, "quinn", d.submit, "message", `Handing build #${iteration} to Quinn`),
          call(() => {
            this.message(id, "quinn", task.id, `Build #${iteration} of ${task.id} is ready for QA`);
            this.emit({ type: "implementation.submitted", agentId: id, targetAgentId: "quinn", taskId: task.id, message: `Kai submitted build #${iteration} for ${task.id}`, metadata: { iteration } });
            this.transition(task.id, "submitted");
          }),
        ];
      }

      case "testing": {
        const fails = this.outcome(task, "qa");
        const test = tpl.tests[(task.iteration - 1) % tpl.tests.length]!;
        const head: Action[] = [
          at("testing"),
          call(() => this.emit({ type: "qa.started", agentId: id, taskId: task.id, message: `Quinn is testing build #${task.iteration}`, feed: false })),
          { kind: "work", duration: d.test, status: "working", activity: `Testing build #${task.iteration}`, onProgress: progress },
        ];
        if (fails) {
          return [
            ...head,
            { kind: "emote", status: "error", duration: d.errorEmote, activity: `✗ ${test}` },
            this.talk(id, "kai", d.report, "report", "Reporting a failing test to Kai"),
            call(() => {
              this.message(id, "kai", task.id, `"${test}" fails on build #${task.iteration}`);
              this.emit({ type: "qa.failed", agentId: id, targetAgentId: "kai", taskId: task.id, severity: "warning", message: `Quinn failed build #${task.iteration}: ${test}`, metadata: { test, iteration: task.iteration } });
              this.rework(task.id, "tests_failed");
            }),
          ];
        }
        return [
          ...head,
          { kind: "emote", status: "success", duration: d.celebrate, activity: "All tests green" },
          this.talk(id, "rex", d.report, "message", "Passing the build to Rex"),
          call(() => {
            this.message(id, "rex", task.id, `Build #${task.iteration} passes ${tpl.tests.length} checks, ready for review`);
            this.emit({ type: "qa.passed", agentId: id, targetAgentId: "rex", taskId: task.id, severity: "success", message: `Quinn passed build #${task.iteration} of ${task.id}`, metadata: { iteration: task.iteration } });
            this.transition(task.id, "tests_passed");
          }),
        ];
      }

      case "review": {
        const changes = this.outcome(task, "review");
        const note = tpl.reviewNotes[(task.iteration - 1) % tpl.reviewNotes.length]!;
        const head: Action[] = [
          at("review"),
          call(() => this.emit({ type: "review.started", agentId: id, taskId: task.id, message: `Rex is reviewing ${task.id}`, feed: false })),
          { kind: "work", duration: d.review, status: "working", activity: `Reviewing ${task.id}`, onProgress: progress },
        ];
        if (changes) {
          return [
            ...head,
            { kind: "emote", status: "error", duration: d.errorEmote, activity: "Changes requested" },
            this.talk(id, "kai", d.report, "report", "Sending review notes to Kai"),
            call(() => {
              this.message(id, "kai", task.id, `${note}`);
              this.emit({ type: "review.changes_requested", agentId: id, targetAgentId: "kai", taskId: task.id, severity: "warning", message: `Rex requested changes on ${task.id}: ${note}`, metadata: { note } });
              this.rework(task.id, "changes_requested");
            }),
          ];
        }
        return [
          ...head,
          { kind: "emote", status: "success", duration: d.celebrate, activity: "Approved" },
          this.talk(id, "orion", d.report, "report", "Reporting approval to Orion"),
          call(() => {
            this.message(id, "orion", task.id, `${task.id} approved`);
            this.emit({ type: "review.approved", agentId: id, targetAgentId: "orion", taskId: task.id, severity: "success", message: `Rex approved ${task.id}` });
            this.transition(task.id, "approved");
          }),
        ];
      }

      case "done":
        return [
          at("hub"),
          { kind: "emote", status: "success", duration: d.announce, activity: `${task.id} shipped` },
          call(() => {
            const cur = t();
            this.put({ ...cur, progress: 1, assignedAgentId: null });
            this.emit({ type: "task.completed", agentId: id, taskId: task.id, severity: "success", message: `${task.id} shipped: ${short}`, metadata: { iteration: cur.iteration } });
          }),
        ];

      default:
        throw new Error(`No job for phase ${job.phase}`);
    }
  }

  /** Remote talk: nobody walks. The link lives max(duration, linkDuration) so short talks still read on screen. */
  private talk(from: AgentId, to: AgentId, duration: number, kind: CommLink["kind"], activity: string): Action {
    return {
      kind: "talk",
      target: to,
      duration,
      activity,
      onStart: () => {
        this.links.push({ id: `L-${++this.linkSeq}`, from, to, kind, startedAt: this.clock, endsAt: this.clock + Math.max(duration, SIM_CONFIG.linkDuration) });
      },
    };
  }

  private message(from: AgentId, to: AgentId, taskId: string, message: string): void {
    this.emit({ type: "agent.message", agentId: from, targetAgentId: to, taskId, message });
  }

  /** Scripted outcome if the task has a script, else seeded random. Random never fails the last iteration. */
  private outcome(task: Task, gate: "qa" | "review"): boolean {
    const scripted = gate === "qa" ? task.script?.qaFailsOn : task.script?.reviewChangesOn;
    if (task.script) return (scripted ?? []).includes(task.iteration);
    const rate = gate === "qa" ? SIM_CONFIG.qaFailRate : SIM_CONFIG.reviewChangeRate;
    return this.taskRng.get(task.id)!() < rate && task.iteration < SIM_CONFIG.maxIterations;
  }

  private rework(taskId: string, signal: "tests_failed" | "changes_requested"): void {
    const task = this.tasks.get(taskId)!;
    if (task.iteration >= SIM_CONFIG.maxIterations) {
      this.transition(taskId, "abort");
      this.emit({ type: "task.failed", taskId, severity: "error", message: `${taskId} failed after ${task.iteration} iterations` });
      return;
    }
    this.transition(taskId, signal);
  }

  /** Apply a workflow signal, hand the task to the next phase owner and queue their job. */
  private transition(taskId: string, signal: WorkflowSignal): void {
    const before = this.tasks.get(taskId)!;
    const next = applySignal(before, signal, this.clock);
    const owner = PHASE_OWNER[next.phase]?.agent ?? null;
    this.put({ ...next, assignedAgentId: owner });
    this.emit({ type: "task.status_changed", taskId, agentId: owner ?? undefined, message: `${taskId}: ${before.phase} → ${next.phase}`, feed: false, metadata: { from: before.phase, to: next.phase, signal } });
    if (!owner) return;
    this.jobs.get(owner)!.push({ taskId, phase: next.phase });
    if (this.ctrl(owner).state.paused) this.block(this.tasks.get(taskId)!, `${getAgent(owner).name} is paused`);
  }

  private block(t: Task, reason: string): void {
    this.put({ ...t, status: "blocked", blockedReason: reason, updatedAt: this.clock });
    this.emit({ type: "task.blocked", agentId: t.assignedAgentId ?? undefined, taskId: t.id, severity: "warning", message: `${t.id} blocked: ${reason}` });
  }

  private onArrived(id: AgentId, location: LocationId): void {
    const c = this.ctrl(id);
    this.emit({ type: "agent.arrived", agentId: id, message: `${getAgent(id).name} arrived at the ${LOCATIONS[location].label}`, feed: false, metadata: { location, withTask: c.state.currentTaskId !== null } });
  }

  // ───────────────────────── plumbing ─────────────────────────

  private resetAgents(): void {
    for (const a of AGENTS) {
      this.ctrl(a.id).resetToHome();
      this.jobs.set(a.id, []);
      this.currentJob.set(a.id, null);
      this.idleSince.set(a.id, 0);
      this.nextAmbientAt.set(a.id, rngRange(this.rng, SIM_CONFIG.ambient.minGap, SIM_CONFIG.ambient.maxGap));
    }
  }

  private ctrl(id: AgentId): AgentController {
    return this.controllers.get(id)!;
  }

  private seqOf(t: Task): number {
    return this.taskSeq.get(t.id) ?? 0;
  }

  private put(task: Task): void {
    this.tasks.set(task.id, task);
  }

  private emit(input: EmitInput): void {
    const type: AgentEventType = input.type;
    const event: AgentEvent = {
      ...input,
      id: `E-${++this.eventSeq}`,
      type,
      timestamp: this.now(),
      simTime: this.clock,
      severity: input.severity ?? "info",
      feed: input.feed ?? true,
    };
    if (event.agentId === undefined) delete event.agentId;
    this.log.push(event);
    if (this.log.length > SIM_CONFIG.maxEvents) this.log.splice(0, this.log.length - SIM_CONFIG.maxEvents);
    this.events.emit(event);
  }

  private publish(): void {
    if (this.snapshots.size > 0) this.snapshots.emit(this.snapshot());
  }

  /** Test/debug helper: agent state without cloning. */
  peekAgent(id: AgentId): Readonly<AgentState> {
    return this.ctrl(id).state;
  }
}
