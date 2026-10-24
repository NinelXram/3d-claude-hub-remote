import type { CSSProperties } from "react";
import { interpolate, useCurrentFrame } from "remotion";
import type { SceneId } from "../copy.vi.ts";
import { lineWindows } from "../timeline.ts";
import { C, FADE, sans } from "../theme.ts";

/**
 * A scene's captions. "sequence": one line at a time, each in its own window. "stack": lines appear in turn
 * and stay. `styleFor(i)` styles line i.
 */
export const Caption: React.FC<{
  scene: SceneId;
  variant: "sequence" | "stack";
  style?: CSSProperties;
  styleFor?: (i: number) => CSSProperties;
}> = ({ scene, variant, style, styleFor }) => {
  const frame = useCurrentFrame();
  const windows = lineWindows(scene);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, fontFamily: sans, color: C.ink, ...style }}>
      {windows.map((w, i) => {
        const end = variant === "stack" ? Number.POSITIVE_INFINITY : w.from + w.durationInFrames;
        if (variant === "sequence" && (frame < w.from || frame >= end)) return null;
        const fadeIn = interpolate(frame, [w.from, w.from + FADE], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
        const fadeOut = variant === "sequence" ? interpolate(frame, [end - FADE, end], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 1;
        const rise = interpolate(fadeIn, [0, 1], [14, 0]);
        return (
          <div key={i} style={{ opacity: Math.min(fadeIn, fadeOut), transform: `translateY(${rise}px)`, ...styleFor?.(i) }}>
            {w.text}
          </div>
        );
      })}
    </div>
  );
};
