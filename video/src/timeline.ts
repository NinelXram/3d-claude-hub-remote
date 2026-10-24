// Scene timing in frames. Durations follow the spec's script table (0, 8, 16, 40, 58, 78 s; 90 s total).
import { copy } from "./copy.vi.ts";
import type { SceneId } from "./copy.vi.ts";

export const FPS = 30;
/** Frames between two captions of the same scene. */
export const LINE_GAP = 10;

const SECONDS: [SceneId, number][] = [
  ["hook", 8],
  ["credit", 8],
  ["office", 24],
  ["sessions", 18],
  ["remote", 20],
  ["outro", 12],
];

export interface Scene {
  id: SceneId;
  from: number;
  durationInFrames: number;
}

export const scenes: Scene[] = (() => {
  let from = 0;
  return SECONDS.map(([id, s]) => {
    const scene: Scene = { id, from, durationInFrames: s * FPS };
    from += scene.durationInFrames;
    return scene;
  });
})();

export const TOTAL_FRAMES = scenes.reduce((n, s) => n + s.durationInFrames, 0);

export function sceneById(id: SceneId): Scene {
  const s = scenes.find((x) => x.id === id);
  if (!s) throw new Error(`no scene ${id}`);
  return s;
}

/** Each caption's on-screen window, scene-relative: the scene split in proportion to line length. */
export function lineWindows(id: SceneId): { text: string; from: number; durationInFrames: number }[] {
  const lines = copy[id].lines;
  const scene = sceneById(id);
  const usable = scene.durationInFrames - LINE_GAP * (lines.length - 1);
  const totalChars = lines.reduce((n, l) => n + l.length, 0);
  let from = 0;
  return lines.map((text, i) => {
    const last = i === lines.length - 1;
    const durationInFrames = last ? scene.durationInFrames - from : Math.floor((usable * text.length) / totalChars);
    const w = { text, from, durationInFrames };
    from += durationInFrames + LINE_GAP;
    return w;
  });
}

/** Which footage each scene takes: `startAt` seconds into the clip, for `seconds`. */
export interface ClipUse {
  scene: SceneId;
  clip: string;
  startAt: number;
  seconds: number;
}

export const CLIP_USES: ClipUse[] = [
  { scene: "credit", clip: "office-demo", startAt: 0, seconds: 8 },
  // Overview → Development → Collaboration presets, then the 8-task sprint for the last 6 s.
  { scene: "office", clip: "office-demo", startAt: 8, seconds: 18 },
  { scene: "office", clip: "office-sprint", startAt: 4, seconds: 6 },
  { scene: "sessions", clip: "sessions-desktop", startAt: 1, seconds: 18 },
  // Opens shop-api, attaches the image, types, the Allow card, the reply.
  { scene: "remote", clip: "phone-remote", startAt: 4, seconds: 20 },
];

export function clipUses(scene: SceneId): ClipUse[] {
  return CLIP_USES.filter((u) => u.scene === scene);
}
