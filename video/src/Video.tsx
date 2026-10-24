import { AbsoluteFill, Audio, Sequence, interpolate, staticFile } from "remotion";
import { SCENES } from "./scenes/Scenes.tsx";
import { sfxCues } from "./sound.ts";
import { FPS, TOTAL_FRAMES, scenes } from "./timeline.ts";
import { C } from "./theme.ts";
import { VOICE_LINES } from "./voice.vi.ts";

/** Seconds of narration per scene (public/voice/manifest.json), or null when the voice has not been generated. */
export interface VideoProps {
  voice: Record<string, number> | null;
  [key: string]: unknown;
}

const MUSIC = 0.35;
/** Music level under the narration. */
const MUSIC_UNDER_VOICE = 0.12;
const DUCK_FRAMES = 8;

/** Frame windows where the narrator speaks. */
export function voiceWindows(voice: Record<string, number> | null): [number, number][] {
  if (!voice) return [];
  return VOICE_LINES.flatMap((l) => {
    const s = scenes.find((x) => x.id === l.scene)!;
    const seconds = voice[l.scene];
    if (typeof seconds !== "number") return [];
    const from = s.from + Math.round(l.startS * FPS);
    return [[from, from + Math.round(seconds * FPS)] as [number, number]];
  });
}

/** Music volume at a frame: fades in and out, and ducks under the narration. */
export function musicVolume(frame: number, windows: [number, number][]): number {
  const fade = interpolate(frame, [0, 30, TOTAL_FRAMES - 60, TOTAL_FRAMES], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  let duck = 0;
  for (const [a, b] of windows) {
    duck = Math.max(duck, interpolate(frame, [a - DUCK_FRAMES, a, b, b + DUCK_FRAMES * 2], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
  }
  return fade * (MUSIC - (MUSIC - MUSIC_UNDER_VOICE) * duck);
}

export const Video: React.FC<VideoProps> = ({ voice }) => {
  const windows = voiceWindows(voice);
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      {scenes.map((s) => {
        const Scene = SCENES[s.id];
        return (
          <Sequence key={s.id} from={s.from} durationInFrames={s.durationInFrames} name={s.id}>
            <Scene />
          </Sequence>
        );
      })}
      <Audio src={staticFile("music.wav")} volume={(f) => musicVolume(f, windows)} />
      {voice
        ? VOICE_LINES.map((l) => {
            const s = scenes.find((x) => x.id === l.scene)!;
            return (
              <Sequence key={`voice-${l.scene}`} from={s.from + Math.round(l.startS * FPS)} durationInFrames={s.durationInFrames} name={`voice ${l.scene}`} layout="none">
                <Audio src={staticFile(`voice/${l.scene}.wav`)} volume={1} />
              </Sequence>
            );
          })
        : null}
      {sfxCues().map((c, i) => (
        <Sequence key={`sfx-${i}`} from={c.frame} durationInFrames={FPS * 2} name={`sfx ${c.sfx}`} layout="none">
          <Audio src={staticFile(`sfx/${c.sfx}.wav`)} volume={c.volume} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
