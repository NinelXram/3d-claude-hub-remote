import type { AgentId, AgentProfile, AgentState, AgentStatus } from "./agentTypes.ts";
import { route, slotFor } from "../simulation/worldLayout.ts";
import type { LocationId, Vec2 } from "../simulation/worldLayout.ts";

/**
 * Actions are the only way an agent changes over time. `ambient` actions belong to idle behaviour
 * and are dropped the moment real work arrives; task actions are never interrupted.
 */
export type Action = (
  | { kind: "move"; to: LocationId; slot?: number; activity?: string }
  | { kind: "work"; duration: number; status: "working" | "thinking"; activity: string; onProgress?: (f: number) => void }
  | { kind: "talk"; target: AgentId; duration: number; activity: string; onStart?: () => void }
  | { kind: "emote"; status: "success" | "error"; duration: number; activity: string }
  | { kind: "wait"; until: () => boolean; timeout: number; activity: string; face?: number; status?: "idle" | "working" | "thinking" }
  | { kind: "call"; fn: () => void }
) & { ambient?: boolean };

export interface ControllerHooks {
  walkSpeed: number;
  onArrived(agent: AgentId, location: LocationId): void;
  /** Lets the speaker turn towards a listener without the controller knowing about other agents. */
  positionOf(agent: AgentId): Vec2;
  /** The listener turns to face the speaker only if it is idle, never mid-walk or mid-work. */
  faceIfIdle(listener: AgentId, speaker: AgentId): void;
}

const headingTo = (from: Vec2, to: Vec2) => Math.atan2(to.x - from.x, to.z - from.z);

export class AgentController {
  readonly profile: AgentProfile;
  state: AgentState;
  private queue: Action[] = [];
  private current: Action | null = null;
  private elapsed = 0;
  private hooks: ControllerHooks;

  constructor(profile: AgentProfile, hooks: ControllerHooks) {
    this.profile = profile;
    this.hooks = hooks;
    this.state = AgentController.homeState(profile);
  }

  static homeState(profile: AgentProfile): AgentState {
    const home = slotFor(profile.home, 0);
    return {
      id: profile.id,
      status: "idle",
      activity: "Idle",
      currentTaskId: null,
      progress: 0,
      location: profile.home,
      destination: null,
      position: { ...home.position },
      heading: home.facing,
      path: [],
      facingAgentId: null,
      paused: false,
    };
  }

  resetToHome(): void {
    this.queue = [];
    this.current = null;
    this.elapsed = 0;
    this.state = AgentController.homeState(this.profile);
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  /** True when everything pending is ambient and can be dropped for real work. */
  get onlyAmbient(): boolean {
    return (!this.current || this.current.ambient === true) && this.queue.every((a) => a.ambient === true);
  }

  get isIdleStill(): boolean {
    return !this.busy || (this.current?.kind === "wait" && (this.current.status ?? "idle") === "idle" && this.queue.length === 0);
  }

  /** Drop everything pending, ambient or not. Live sources use this when the real session moves on. */
  clear(): void {
    this.queue = [];
    this.current = null;
    this.elapsed = 0;
    this.state.path = [];
    this.state.destination = null;
    this.state.facingAgentId = null;
    this.state.progress = 0;
    this.setStatus("idle", "Idle");
  }

  enqueue(...actions: Action[]): void {
    this.queue.push(...actions);
  }

  /** Drop ambient actions; the agent stops where it is (next move routes from the current position). */
  interruptAmbient(): void {
    if (!this.onlyAmbient) return;
    this.queue = [];
    this.current = null;
    this.elapsed = 0;
    this.state.path = [];
    this.state.destination = null;
    this.state.facingAgentId = null;
    this.setStatus("idle", "Idle");
  }

  step(dt: number): void {
    if (this.state.paused) return;
    let budget = dt;
    // Instant actions (call, zero-length) chain within one tick; timed ones consume the budget.
    for (let guard = 0; guard < 64; guard++) {
      if (!this.current) {
        const next = this.queue.shift();
        if (!next) {
          if (this.state.status !== "idle") this.setStatus("idle", "Idle");
          this.state.progress = 0;
          return;
        }
        this.begin(next);
      }
      const left = this.advance(this.current!, budget);
      if (left === null) return;
      this.current = null;
      budget = left;
    }
  }

  private setStatus(status: AgentStatus, activity: string): void {
    this.state.status = status;
    this.state.activity = activity;
  }

  private begin(a: Action): void {
    this.current = a;
    this.elapsed = 0;
    switch (a.kind) {
      case "move": {
        const target = slotFor(a.to, a.slot ?? 0).position;
        this.state.path = route(this.state.position, target);
        this.state.destination = a.to;
        this.state.location = null;
        this.state.facingAgentId = null;
        this.setStatus("walking", a.activity ?? `Walking to ${a.to}`);
        break;
      }
      case "work":
        this.setStatus(a.status, a.activity);
        break;
      case "talk":
        this.state.facingAgentId = a.target;
        this.state.heading = headingTo(this.state.position, this.hooks.positionOf(a.target));
        this.setStatus("communicating", a.activity);
        this.hooks.faceIfIdle(a.target, this.profile.id);
        a.onStart?.();
        break;
      case "emote":
        this.setStatus(a.status, a.activity);
        break;
      case "wait":
        if (a.face !== undefined) this.state.heading = a.face;
        this.setStatus(a.status ?? "idle", a.activity);
        break;
      case "call":
        break;
    }
  }

  /** Returns leftover dt when the action finished, or null while still running. */
  private advance(a: Action, dt: number): number | null {
    switch (a.kind) {
      case "call":
        a.fn();
        return dt;
      case "move": {
        let remaining = this.hooks.walkSpeed * dt;
        while (this.state.path.length > 0) {
          const p = this.state.path[0]!;
          const dx = p.x - this.state.position.x;
          const dz = p.z - this.state.position.z;
          const d = Math.hypot(dx, dz);
          if (d > 1e-9) this.state.heading = Math.atan2(dx, dz);
          if (d > remaining) {
            this.state.position = { x: this.state.position.x + (dx / d) * remaining, z: this.state.position.z + (dz / d) * remaining };
            return null;
          }
          this.state.position = { x: p.x, z: p.z };
          remaining -= d;
          this.state.path.shift();
        }
        const slot = slotFor(a.to, a.slot ?? 0);
        this.state.heading = slot.facing;
        this.state.location = a.to;
        this.state.destination = null;
        this.hooks.onArrived(this.profile.id, a.to);
        return remaining / this.hooks.walkSpeed;
      }
      case "work":
      case "talk":
      case "emote":
      case "wait": {
        if (a.kind === "wait" && a.until()) return dt;
        const duration = a.kind === "wait" ? a.timeout : a.duration;
        this.elapsed += dt;
        const f = duration > 0 ? Math.min(1, this.elapsed / duration) : 1;
        if (a.kind === "work") {
          this.state.progress = f;
          a.onProgress?.(f);
        }
        if (f < 1) return null;
        const left = this.elapsed - duration;
        if (a.kind === "talk") this.state.facingAgentId = null;
        if (a.kind === "work") this.state.progress = 0;
        return Math.max(0, left);
      }
    }
  }
}
