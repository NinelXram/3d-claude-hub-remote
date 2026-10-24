"use client";

import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Ellipsis, Layers, Pause, Play, Plus, RotateCcw, Sparkles, Volume2, VolumeX } from "lucide-react";
import { toggleDesktopAlerts } from "@/audio/useSoundEffects";
import { useBackendCaps } from "@/components/backendCaps";
import { Segmented } from "@/components/ui";
import { commands } from "@/integrations/backendClient";
import { SIM_CONFIG } from "@/simulation/simulationConfig";
import { useWorldStore } from "@/state/useWorldStore";
import { useRenderCount } from "@/world/renderCounts";

const SPEED_OPTIONS = SIM_CONFIG.speeds.map((s) => ({ value: s as number, label: `${s}×` }));

/** Shared by the desktop row and the phone menu, so both always show the same state. */
function useControlsState() {
  const status = useWorldStore((s) => s.simStatus);
  const speed = useWorldStore((s) => s.speed);
  const soundOn = useWorldStore((s) => s.sound.enabled);
  const setSound = useWorldStore((s) => s.setSound);
  const audioReady = useWorldStore((s) => s.audioState === "running");
  const live = useWorldStore((s) => s.soundMode === "live");
  const alertsOn = useWorldStore((s) => s.desktopAlerts);
  const openDialog = useWorldStore((s) => s.openDialog);
  const caps = useBackendCaps();
  const runLabel = status === "running" ? "Pause" : status === "paused" ? "Resume" : "Start";
  const RunIcon = status === "running" ? Pause : Play;
  return { speed, soundOn, setSound, audioReady, live, alertsOn, openDialog, caps, runLabel, RunIcon };
}

export function SimulationControls() {
  useRenderCount("SimulationControls");
  const { speed, soundOn, setSound, audioReady, live, alertsOn, openDialog, caps, runLabel, RunIcon } = useControlsState();
  const [confirmReset, setConfirmReset] = useState(false);
  // Icon-only below 1440 px; the full label stays available to screen readers and in the tooltip.
  const label = (text: string) => (
    <>
      <span className="hidden min-[1440px]:inline">{text}</span>
      <span className="sr-only min-[1440px]:hidden">{text}</span>
    </>
  );

  return (
    // Two groups that each stay on one line; on a phone the scenario group wraps under the transport group.
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <div className="flex flex-none items-center gap-1.5">
        <button type="button" className="btn" onClick={() => void commands.toggleRun()} disabled={caps.run !== null} title={caps.run ?? `${runLabel} (Space)`}>
          <RunIcon size={14} />
          {label(runLabel)}
        </button>

        {caps.simulated || !caps.identified ? (
          <Segmented
            label="Simulation speed"
            options={SPEED_OPTIONS}
            value={speed}
            onChange={(v) => void commands.setSpeed(v)}
            disabled={caps.speed !== null}
            title={caps.speed ?? "Simulation speed"}
            size="md"
          />
        ) : (
          <span className="hidden h-7 items-center rounded-[10px] border border-mist-500/15 px-2.5 text-[11.5px] text-mist-500 sm:inline-flex" title={caps.speed ?? undefined}>
            Real time
          </span>
        )}

        <button
          type="button"
          className="btn btn-quiet w-8 px-0"
          aria-pressed={soundOn}
          onClick={() => setSound({ enabled: !soundOn })}
          title={soundOn ? (audioReady ? "Mute sound effects (M)" : "Sound is on; it starts after your first click or key press (M mutes)") : "Unmute sound effects (M)"}
          data-testid="sound-toggle"
        >
          {soundOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
          <span className="sr-only">{soundOn ? "Mute" : "Unmute"}</span>
        </button>

        {live ? (
          <button
            type="button"
            className="btn btn-quiet w-8 px-0"
            aria-pressed={alertsOn}
            onClick={() => void toggleDesktopAlerts()}
            title={alertsOn ? "Desktop notifications on: Claude needing you is announced while this tab is hidden" : "Notify me when Claude needs you (desktop notification while this tab is hidden)"}
          >
            {alertsOn ? <Bell size={15} /> : <BellOff size={15} />}
            <span className="sr-only">{alertsOn ? "Turn off desktop notifications" : "Notify me"}</span>
          </button>
        ) : null}

        {confirmReset ? (
          <span className="flex items-center gap-1">
            <button
              type="button"
              className="btn border-bad/40 text-bad"
              onClick={() => {
                setConfirmReset(false);
                void commands.reset();
              }}
            >
              Confirm {caps.simulated ? "reset" : "clear"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => setConfirmReset(true)}
            disabled={caps.reset !== null}
            title={caps.reset ?? (caps.simulated ? "Reset the world to t = 0" : "Clear this view")}
          >
            <RotateCcw size={14} />
            <span className="hidden 2xl:inline">{caps.simulated ? "Reset" : "Clear"}</span>
            <span className="sr-only 2xl:hidden">{caps.simulated ? "Reset" : "Clear"}</span>
          </button>
        )}

      </div>

      <span className="mx-0.5 h-5 w-px flex-none bg-mist-500/15 max-sm:hidden" aria-hidden />

      <div className="flex flex-none items-center gap-1.5">

        <button type="button" className="btn" onClick={() => void commands.runDemo()} disabled={caps.scenario !== null} title={caps.scenario ?? "Send the scripted demo task through the whole team"}>
          <Sparkles size={14} />
          {label("Run demo")}
        </button>
        <button type="button" className="btn" onClick={() => void commands.loadSprint()} disabled={caps.scenario !== null} title={caps.scenario ?? "Queue the 8-task sprint (B)"}>
          <Layers size={14} />
          {label("Load sprint")}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => openDialog()} disabled={caps.submit !== null} title={caps.submit ?? "New task (N)"}>
          <Plus size={15} />
          {label("New task")}
        </button>
      </div>
    </div>
  );
}

/**
 * Phones (portrait below 768 px, and landscape phones): the run toggle and New task stay in the one-row top bar;
 * speed, sound, notifications, reset and the scenarios move into a menu with 44 px rows.
 */
export function CompactSimControls() {
  useRenderCount("CompactSimControls");
  const { speed, soundOn, setSound, live, alertsOn, openDialog, caps, runLabel, RunIcon } = useControlsState();
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setConfirmReset(false);
  };
  const row = "btn btn-ghost h-11 w-full justify-start gap-2.5 px-3 text-[13px]";
  const showScenarios = caps.simulated || !caps.identified;

  return (
    <div ref={wrap} className="relative flex flex-none items-center gap-1.5">
      <button type="button" className="btn size-11 px-0" onClick={() => void commands.toggleRun()} disabled={caps.run !== null} title={caps.run ?? `${runLabel} (Space)`} aria-label={runLabel}>
        <RunIcon size={17} />
      </button>
      {caps.submit === null ? (
        <button type="button" className="btn btn-primary size-11 px-0" onClick={() => openDialog()} title="New task (N)" aria-label="New task">
          <Plus size={18} />
        </button>
      ) : null}
      <button
        type="button"
        className="btn btn-quiet size-11 px-0"
        aria-expanded={open}
        aria-controls="aaw-controls-menu"
        aria-label="More controls"
        title="Speed, sound, reset and scenarios"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Ellipsis size={18} />
      </button>

      {open ? (
        <div
          id="aaw-controls-menu"
          role="dialog"
          aria-label="Controls"
          className="surface scroll-thin absolute right-0 top-[calc(100%+10px)] z-30 flex max-h-[calc(100dvh-96px)] w-[min(300px,calc(100vw-24px))] flex-col gap-1.5 overflow-y-auto bg-ink-900/95 p-2 [animation:aaw-rise-in_140ms_ease-out]"
          data-testid="controls-menu"
        >
          {showScenarios ? (
            <div className="flex flex-col gap-1 px-1 pb-1">
              <span className="eyebrow">Speed</span>
              <Segmented label="Simulation speed" options={SPEED_OPTIONS} value={speed} onChange={(v) => void commands.setSpeed(v)} disabled={caps.speed !== null} title={caps.speed ?? "Simulation speed"} size="lg" />
            </div>
          ) : (
            <p className="px-2 py-1 text-[12px] leading-snug text-mist-500">{caps.speed ?? "Real time"}</p>
          )}

          <button type="button" className={row} aria-pressed={soundOn} onClick={() => setSound({ enabled: !soundOn })} data-testid="sound-toggle-menu">
            {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
            {soundOn ? "Sound on" : "Sound off"}
            <span className="ml-auto text-[11.5px] font-normal text-mist-500">{soundOn ? "Tap to mute" : "Tap to unmute"}</span>
          </button>

          {live ? (
            <button type="button" className={row} aria-pressed={alertsOn} onClick={() => void toggleDesktopAlerts()}>
              {alertsOn ? <Bell size={16} /> : <BellOff size={16} />}
              {alertsOn ? "Notifications on" : "Notify me"}
            </button>
          ) : null}

          {confirmReset ? (
            <div className="flex gap-1.5">
              <button
                type="button"
                className="btn h-11 flex-1 border-bad/40 text-[13px] text-bad"
                onClick={() => {
                  close();
                  void commands.reset();
                }}
              >
                Confirm {caps.simulated ? "reset" : "clear"}
              </button>
              <button type="button" className="btn btn-quiet h-11 flex-1 text-[13px]" onClick={() => setConfirmReset(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className={row} onClick={() => setConfirmReset(true)} disabled={caps.reset !== null} title={caps.reset ?? undefined}>
              <RotateCcw size={16} />
              {caps.simulated ? "Reset world" : "Clear view"}
            </button>
          )}

          {showScenarios ? (
            <>
              <span className="mx-1 my-0.5 h-px bg-mist-500/12" aria-hidden />
              <button
                type="button"
                className={row}
                onClick={() => {
                  close();
                  void commands.runDemo();
                }}
                disabled={caps.scenario !== null}
                title={caps.scenario ?? undefined}
              >
                <Sparkles size={16} />
                Run demo
              </button>
              <button
                type="button"
                className={row}
                onClick={() => {
                  close();
                  void commands.loadSprint();
                }}
                disabled={caps.scenario !== null}
                title={caps.scenario ?? undefined}
              >
                <Layers size={16} />
                Load sprint
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
