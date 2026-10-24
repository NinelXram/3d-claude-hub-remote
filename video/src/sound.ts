// Where the sound effects go. Clip events come from src/clipMarks.json (written by `npm run capture`), so a sound
// lands on the frame where its click, keystroke or reply happens on screen.
import marksJson from "./clipMarks.json" with { type: "json" };
import { FPS, TOTAL_FRAMES, clipUses, lineWindows, sceneById, scenes } from "./timeline.ts";

export const SFX_NAMES = ["whoosh", "impact", "click", "key", "chime", "alert", "pop"] as const;
export type SfxName = (typeof SFX_NAMES)[number];

export interface Cue {
  frame: number;
  sfx: SfxName;
  volume: number;
}

export type ClipMarks = Record<string, Record<string, number>>;

/** Typing on the phone: one key every this many seconds (capture/specs.ts types with the same delay). */
const KEY_EVERY_S = 0.07;
const PHONE_PROMPT_LENGTH = "Lỗi trong ảnh này là gì vậy?".length;
/** When the Tailscale diagram's five nodes appear, in frames after it starts (TailscaleDiagram.tsx). */
const DIAGRAM_NODE_FRAMES = [0, 24, 48, 80, 104];

/** The video frame showing `clip` at `seconds`, or null when that moment is not used in any scene. */
export function frameOfClipTime(clip: string, seconds: number): number | null {
  for (const s of scenes) {
    let offset = 0;
    for (const u of clipUses(s.id)) {
      if (u.clip === clip && seconds >= u.startAt && seconds < u.startAt + u.seconds) {
        return s.from + Math.round((offset + seconds - u.startAt) * FPS);
      }
      offset += u.seconds;
    }
  }
  return null;
}

export function sfxCues(marks: ClipMarks = marksJson as ClipMarks): Cue[] {
  const cues: Cue[] = [];
  const add = (frame: number | null, sfx: SfxName, volume: number) => {
    if (frame !== null && frame >= 0 && frame < TOTAL_FRAMES) cues.push({ frame, sfx, volume });
  };
  const at = (clip: string, name: string) => {
    const t = marks[clip]?.[name];
    return t === undefined ? null : frameOfClipTime(clip, t);
  };

  // Scene changes.
  for (const s of scenes.slice(1)) add(s.from - 10, "whoosh", 0.5);
  // The product name lands.
  add(sceneById("office").from, "impact", 0.7);
  add(sceneById("outro").from, "impact", 0.6);
  // The hook's watching eyes, one pop each (Scenes.tsx staggers them 6 frames apart).
  const hookSecond = lineWindows("hook")[1]!.from;
  for (let i = 0; i < 5; i++) add(sceneById("hook").from + hookSecond + i * 6, "pop", 0.35);
  // Camera moves in the office.
  for (const preset of ["Development", "Collaboration"]) add(at("office-demo", `camera:${preset}`), "click", 0.45);
  // Opening sessions on the desktop.
  for (const name of ["open:shop-api", "back", "open:web-dashboard"]) add(at("sessions-desktop", name), "click", 0.45);
  // The phone: open, attach, type, send, the ask, Allow, the reply.
  for (const name of ["open", "attach", "send", "allow"]) add(at("phone-remote", name), "click", 0.55);
  const typed = marks["phone-remote"]?.type;
  if (typed !== undefined) for (let k = 0; k < PHONE_PROMPT_LENGTH; k++) add(frameOfClipTime("phone-remote", typed + k * KEY_EVERY_S), "key", 0.3);
  add(at("phone-remote", "ask"), "alert", 0.5);
  add(at("phone-remote", "reply"), "chime", 0.5);
  // The Tailscale diagram builds node by node, starting with the remote scene's second caption.
  const diagramStart = sceneById("remote").from + lineWindows("remote")[1]!.from;
  for (const f of DIAGRAM_NODE_FRAMES) add(diagramStart + f, "pop", 0.35);
  return cues.sort((a, b) => a.frame - b.frame);
}
