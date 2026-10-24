import type { AgentId } from "../agents/agentTypes.ts";
import type { AgentEvent } from "../events/eventTypes.ts";
import { SimulationEngine } from "../simulation/SimulationEngine.ts";
import { SIM_CONFIG } from "../simulation/simulationConfig.ts";
import type { CreateTaskInput, Task } from "../tasks/taskTypes.ts";
import type { AgentBackend, WorldSnapshot } from "./AgentBackend.ts";

/** Wraps the SimulationEngine behind the same contract a real WebSocket backend implements. */
export class MockAgentBackend implements AgentBackend {
  readonly kind = "mock" as const;
  readonly label = "Local simulation";
  readonly simulated = true;
  readonly engine: SimulationEngine;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = 0;
  private latest: WorldSnapshot | null = null;
  private unsubscribeLatest: (() => void) | null = null;
  private autoTick: boolean;
  private connected = false;

  /** `autoTick: false` leaves ticking to the caller (tests drive `engine.tick` directly). */
  constructor(engine = new SimulationEngine(), options: { autoTick?: boolean } = {}) {
    this.engine = engine;
    this.autoTick = options.autoTick ?? true;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.connected = true;
    this.unsubscribeLatest = this.engine.snapshots.subscribe((s) => {
      this.latest = s;
    });
    this.engine.emitBootEvents();
    this.latest = this.engine.snapshot();
    this.last = performance.now();
    if (!this.autoTick) return;
    this.timer = setInterval(() => {
      const now = performance.now();
      // Clamp so a throttled or sleeping tab does not teleport everyone on wake.
      const dt = Math.min((now - this.last) / 1000, SIM_CONFIG.maxStepSeconds);
      this.last = now;
      this.engine.tick(dt);
    }, 1000 / SIM_CONFIG.tickHz);
  }

  async disconnect(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
    this.unsubscribeLatest?.();
    this.unsubscribeLatest = null;
    this.engine.stop();
  }

  async start(): Promise<void> { this.engine.start(); }
  async stop(): Promise<void> { this.engine.stop(); }
  async pause(): Promise<void> { this.engine.pause(); }
  async resume(): Promise<void> { this.engine.resume(); }
  async reset(): Promise<void> { this.engine.reset(); }
  async setSpeed(multiplier: number): Promise<void> { this.engine.setSpeed(multiplier); }
  async submitTask(input: CreateTaskInput): Promise<Task> { return this.engine.submitTask(input); }
  async pauseAgent(id: AgentId): Promise<void> { this.engine.pauseAgent(id); }
  async resumeAgent(id: AgentId): Promise<void> { this.engine.resumeAgent(id); }

  getSnapshot(): WorldSnapshot | null {
    return this.latest;
  }

  subscribe(listener: (e: AgentEvent) => void): () => void {
    return this.engine.events.subscribe(listener);
  }

  subscribeSnapshot(listener: (s: WorldSnapshot) => void): () => void {
    return this.engine.snapshots.subscribe(listener);
  }
}
