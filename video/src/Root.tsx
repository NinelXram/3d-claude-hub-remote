import { Composition, staticFile } from "remotion";
import { Video } from "./Video.tsx";
import type { VideoProps } from "./Video.tsx";
import { FPS, TOTAL_FRAMES } from "./timeline.ts";

export const Root: React.FC = () => (
  <Composition
    id="Intro"
    component={Video}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={1920}
    height={1080}
    defaultProps={{ voice: null } satisfies VideoProps}
    // The narration lengths decide where the music ducks; without generated voice the video renders without it.
    calculateMetadata={async ({ props }) => {
      try {
        const res = await fetch(staticFile("voice/manifest.json"));
        return { props: { ...props, voice: res.ok ? ((await res.json()) as Record<string, number>) : null } };
      } catch {
        return { props: { ...props, voice: null } };
      }
    }}
  />
);
