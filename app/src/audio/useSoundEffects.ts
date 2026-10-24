"use client";

import { useEffect } from "react";
import { attentionOf, attentionRank, attentionTitle, clearsAttention, notificationTitle, permissionEvent, sessionOf } from "@/audio/attention";
import type { Attention } from "@/audio/attention";
import { isStale, soundEngine } from "@/audio/soundEngine";
import type { SoundMode } from "@/audio/soundEngine";
import { getBackend } from "@/integrations/backendClient";
import { basename } from "@/components/sessions/sessionUi";
import { useSessionStore } from "@/state/useSessionStore";
import { hydrateSoundSettings, useWorldStore } from "@/state/useWorldStore";
import type { WorldState } from "@/state/useWorldStore";

function modeOf(backend: WorldState["backend"]): SoundMode | null {
  if (!backend.identified) return null;
  return backend.simulated ? "simulation" : "live";
}

/**
 * Wires the SoundEngine to the world (§8). Mounted once, in AppShell.
 * - loads the saved settings into the store and keeps the engine configured from the store;
 * - picks the sound mode from the backend (simulation, or the quiet live mirror);
 * - unlocks audio on the first pointer or key event (before that, nothing is created and nothing plays);
 * - plays a cue for each new backend event and runs the ambient bed while the world runs;
 * - in live mode, puts "Claude needs you" in the tab title and, if enabled, in a desktop notification;
 * - does the same for permission asks from sessions run on this page (the sessions extension), and clears the
 *   title when the last one is answered.
 *
 * `<html data-audio>` (none | suspended | running), `data-sound-played` (cue count) and `data-ambient`
 * (true | false) expose the engine's state for automated checks; they change nothing.
 */
export function useSoundEffects(): void {
  useEffect(() => {
    const root = document.documentElement;
    const store = useWorldStore;
    hydrateSoundSettings();

    // Mode follows the backend once it has identified itself; each mode has its own saved settings.
    const syncMode = () => {
      const mode = modeOf(store.getState().backend);
      if (mode && mode !== store.getState().soundMode) store.getState().setSoundMode(mode);
      soundEngine.setMode(store.getState().soundMode);
    };
    syncMode();
    soundEngine.configure(store.getState().sound);
    soundEngine.setRunning(store.getState().simStatus === "running");

    const unsubStore = store.subscribe((st, prev) => {
      if (st.backend !== prev.backend) syncMode();
      if (st.sound !== prev.sound) soundEngine.configure(st.sound);
      if (st.simStatus !== prev.simStatus) soundEngine.setRunning(st.simStatus === "running");
    });

    // Audio state, for the settings line and automated checks.
    root.dataset.audio = soundEngine.state;
    root.dataset.soundPlayed = String(soundEngine.played);
    soundEngine.onStateChange((s) => {
      root.dataset.audio = s;
      store.getState().setAudioState(s);
    });
    soundEngine.onPlayed = (n) => {
      root.dataset.soundPlayed = String(n);
    };
    root.dataset.ambient = String(soundEngine.ambientOn);
    soundEngine.onAmbient = (on) => {
      root.dataset.ambient = String(on);
    };

    // Browsers only allow audio after a gesture: unlock on the first one, wherever it lands.
    const unlock = () => soundEngine.unlock();
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });

    // ── "Claude needs you" (live only) ──
    // Several sessions can need you at once: one entry per session (key "" for events that name none). The title
    // shows the most urgent (waiting outranks a turn that ended), newest first among equals, plus how many more.
    const baseTitle = document.title;
    const pending = new Map<string, { a: Attention; at: number }>();
    const render = () => {
      let best: { a: Attention; at: number } | null = null;
      for (const p of pending.values()) if (!best || attentionRank(p.a) >= attentionRank(best.a)) best = p;
      document.title = best ? attentionTitle(best.a, baseTitle, pending.size - 1) : baseTitle;
    };
    const clear = (key: string) => {
      if (pending.delete(key)) render();
    };
    const onVisible = () => {
      if (document.hidden) return;
      for (const [k, p] of pending) if (p.a.kind === "turn-ended") pending.delete(k);
      render();
    };
    document.addEventListener("visibilitychange", onVisible);

    const raise = (a: Attention, at: number) => {
      // Within one session the newest signal wins (its turn ending also ends its wait); across sessions, render ranks.
      const key = a.session ?? "";
      pending.delete(key);
      pending.set(key, { a, at });
      render();
      if (store.getState().desktopAlerts && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(notificationTitle(a), { body: a.body, tag: `aaw-${key}` });
        } catch {
          // some browsers only allow notifications from a service worker
        }
      }
    };
    const asksPending = (key: string) => useSessionStore.getState().permissions.some((p) => !key || p.sessionId === key);

    const unsubEvents = getBackend().subscribe((e) => {
      // History replayed on connect stays silent; only news makes a sound or raises attention.
      if (isStale(e, Date.now())) return;
      soundEngine.play(e);
      if (store.getState().soundMode !== "live") return;
      const a = attentionOf(e);
      if (!a) {
        // Only the same session's activity clears its signal; a permission card on this page holds it until answered.
        const key = sessionOf(e).session ?? "";
        const cur = pending.get(key);
        if (cur && clearsAttention(e, { kind: cur.a.kind, at: cur.at, ...(cur.a.session ? { session: cur.a.session } : {}) }) && !(cur.a.kind === "permission" && asksPending(key))) clear(key);
        return;
      }
      raise(a, e.simTime);
    });

    // Permission asks from sessions run on this page: the same bell and "⏳ Permission needed" title, naming the session.
    const unsubAsks = useSessionStore.subscribe((st, prev) => {
      if (st.permissions === prev.permissions) return;
      const known = new Set(prev.permissions.map((p) => p.requestId));
      const fresh = st.permissions.filter((p) => !known.has(p.requestId));
      if (fresh.length > 0) {
        const ask = fresh[fresh.length - 1]!;
        const info = st.sessions.find((x) => x.sessionId === ask.sessionId);
        const e = permissionEvent(ask, store.getState().clock, Date.now(), info ? { project: basename(info.cwd), title: info.title } : undefined);
        soundEngine.play(e);
        const a = attentionOf(e);
        if (a) raise(a, e.simTime);
      }
      // Asks answered: a session with none left stops asking.
      for (const [key, p] of pending) if (p.a.kind === "permission" && !st.permissions.some((x) => x.sessionId === key) && prev.permissions.some((x) => x.sessionId === key)) clear(key);
    });

    return () => {
      unsubStore();
      unsubEvents();
      unsubAsks();
      soundEngine.onStateChange(null);
      soundEngine.onPlayed = null;
      soundEngine.onAmbient = null;
      soundEngine.setRunning(false);
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      document.title = baseTitle;
    };
  }, []);
}

/** "Notify me": asks the browser for permission on the first enable. */
export async function toggleDesktopAlerts(): Promise<void> {
  const st = useWorldStore.getState();
  if (st.desktopAlerts) return st.setDesktopAlerts(false);
  if (typeof Notification === "undefined") return;
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  useWorldStore.getState().setDesktopAlerts(permission === "granted");
  if (permission === "denied") useWorldStore.getState().notify("Notifications are blocked for this site in the browser settings.", "error");
}
