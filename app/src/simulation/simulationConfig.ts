import type { WorkflowPhase } from "../tasks/taskTypes.ts";

// Every timing and limit lives here. Durations are simulation seconds.
export const SIM_CONFIG = {
  seed: 20261018,
  tickHz: 30,
  maxStepSeconds: 0.1,
  walkSpeed: 2.4,
  speeds: [0.5, 1, 2, 4],
  defaultSpeed: 1,
  autoStart: true,
  maxConcurrentTasks: 2,
  maxIterations: 3,
  qaFailRate: 0.3,
  reviewChangeRate: 0.25,
  returnHomeDelay: 2.5,
  ambient: { minGap: 18, maxGap: 40, minStay: 6, maxStay: 10 },
  /** Minimum on-screen lifetime of a comm arc; a link lives max(talk duration, linkDuration). */
  linkDuration: 2.4,
  durations: {
    intakeThink: 1.8,
    assign: 1.5,
    breakdown: 4.2,
    coordinate: 2,
    research: 5.5,
    publish: 1.4,
    implement: 6.5,
    fix: 4,
    submit: 1.4,
    test: 4.5,
    review: 4,
    report: 1.5,
    celebrate: 1.4,
    errorEmote: 1.6,
    announce: 2,
  },
  phaseProgress: {
    queued: [0, 0],
    intake: [0, 0.08],
    planning: [0.08, 0.2],
    research: [0.2, 0.36],
    implementation: [0.36, 0.62],
    testing: [0.62, 0.78],
    review: [0.78, 0.94],
    done: [1, 1],
    failed: [0, 0],
  } satisfies Record<WorkflowPhase, readonly [number, number]>,
  maxEvents: 400,
} as const;

export type SimConfig = typeof SIM_CONFIG;
