"use client";

import { useSessionStore } from "@/state/useSessionStore";
import { useWorldStore } from "@/state/useWorldStore";

/**
 * What the current backend lets this page do, plus the tooltip to show when it does not.
 * A `null` reason means the control is enabled.
 */
export interface BackendCaps {
  simulated: boolean;
  /** The backend has said who it is (mock: always; websocket: after `welcome`). */
  identified: boolean;
  online: boolean;
  /** Top-bar subtitle. */
  modeLine: string;
  /** The same, short enough for a phone's one-row top bar (the full line is its tooltip). */
  shortModeLine: string;
  run: string | null;
  speed: string | null;
  submit: string | null;
  scenario: string | null;
  pauseAgent: string | null;
  reset: string | null;
}

/** `control`: the server accepts prompts from the Sessions tab (the world itself stays a read-only mirror). */
export function capsFor(backend: ReturnType<typeof useWorldStore.getState>["backend"], control = false): BackendCaps {
  const online = backend.connection === "open";
  const offline =
    backend.connection === "closed"
      ? `Disconnected from ${backend.label}${backend.error ? `: ${backend.error}` : ""}`
      : backend.connection === "open"
        ? null
        : "Reconnecting to the backend…";
  const simulated = backend.simulated && backend.identified;
  const live = !backend.simulated && backend.identified;
  const modeLine = !backend.identified
    ? "Connecting to backend…"
    : simulated
      ? "Simulation mode · no live inference"
      : control
        ? `${backend.label} · mirror + control`
        : `${backend.label} · read-only mirror`;
  const shortModeLine = !backend.identified
    ? "Connecting…"
    : simulated
      ? "Simulation · no inference"
      : `${backend.label} · ${control ? "control" : "read-only"}`;
  return {
    simulated,
    identified: backend.identified,
    online,
    modeLine,
    shortModeLine,
    run: offline,
    reset: offline,
    speed: offline ?? (live ? `${backend.label} runs in real time; speed cannot change.` : null),
    submit: offline ?? (live ? `${backend.label} is read-only: tasks come from the live session, not from this page.` : null),
    scenario: offline ?? (live ? "Run demo and Load sprint drive the local simulation only." : null),
    pauseAgent: offline ?? (live ? `${backend.label} cannot pause a real agent from this page.` : null),
  };
}

export function useBackendCaps(): BackendCaps {
  const backend = useWorldStore((s) => s.backend);
  const control = useSessionStore((s) => s.capabilities.control);
  return capsFor(backend, control);
}
