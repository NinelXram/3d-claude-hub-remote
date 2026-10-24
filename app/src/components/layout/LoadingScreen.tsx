"use client";

import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Logo } from "@/components/layout/NavRail";
import { useBackendCaps } from "@/components/backendCaps";
import { useWorldStore } from "@/state/useWorldStore";

const STEPS = ["Booting simulation engine", "Building the office", "Waking up agents"];
/** Per step; three steps ⇒ at least 1.11 s before the overlay can fade (§7.6). */
const STEP_MS = 370;
const FADE_MS = 450;

export function LoadingScreen() {
  const sceneReady = useWorldStore((s) => s.sceneReady);
  const kind = useWorldStore((s) => s.backend.kind);
  const caps = useBackendCaps();
  const [step, setStep] = useState(0);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const timers = STEPS.map((_, i) => setTimeout(() => setStep(i + 1), STEP_MS * (i + 1)));
    return () => timers.forEach(clearTimeout);
  }, []);

  const finished = step >= STEPS.length && sceneReady;
  useEffect(() => {
    if (!finished) return;
    const t = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(t);
  }, [finished]);

  if (gone) return null;
  const labels = kind === "mock" ? STEPS : ["Connecting to the backend", STEPS[1]!, STEPS[2]!];

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-ink-950 transition-opacity ease-out ${finished ? "pointer-events-none opacity-0" : "opacity-100"}`}
      style={{ transitionDuration: `${FADE_MS}ms` }}
      aria-hidden={finished}
      role="status"
      aria-label="Loading 3D Claude Hub Remote"
      data-testid="loading-screen"
    >
      <div className="flex flex-col items-center gap-5">
        <Logo size={56} />
        <div className="text-center">
          <p className="text-[17px] font-semibold tracking-tight text-mist-100">3D Claude Hub Remote</p>
          <p className={`mt-1 text-[12px] ${caps.simulated ? "text-warn" : "text-mist-300"}`}>{caps.modeLine}</p>
        </div>
        <ol className="flex w-64 flex-col gap-2">
          {labels.map((label, i) => {
            const done = step > i;
            const active = step === i;
            return (
              <li key={label} className={`flex items-center gap-2.5 text-[12.5px] transition-colors ${done ? "text-mist-300" : active ? "text-mist-100" : "text-mist-500/60"}`}>
                <span className="inline-flex size-4 items-center justify-center">
                  {done ? <Check size={14} className="text-ok" /> : active ? <Loader2 size={14} className="animate-spin text-signal" /> : <span className="size-1.5 rounded-full bg-mist-500/50" />}
                </span>
                {label}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
