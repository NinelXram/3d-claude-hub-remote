// A laptop and a phone drawn in CSS, with a recorded clip on the screen.
import type { ReactNode } from "react";
import { AbsoluteFill, OffthreadVideo, staticFile } from "remotion";
import { C } from "../theme.ts";

/** Clips are recorded at 30 fps, like the video. */
const FPS_FOR_CLIPS = 30;

/** A recorded clip from public/clips, starting `startAt` seconds in. */
export const Clip: React.FC<{ name: string; startAt: number; style?: React.CSSProperties }> = ({ name, startAt, style }) => (
  <OffthreadVideo src={staticFile(`clips/${name}.mp4`)} trimBefore={Math.round(startAt * FPS_FOR_CLIPS)} muted style={{ width: "100%", height: "100%", objectFit: "cover", ...style }} />
);

/** Screen 1536×864 (the 1920×1080 clip at 80%), bezel and base. */
export const LaptopFrame: React.FC<{ children: ReactNode; scale?: number }> = ({ children, scale = 1 }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", transform: `scale(${scale})` }}>
    <div style={{ padding: 18, borderRadius: 26, background: C.frame, border: `2px solid ${C.frameEdge}`, boxShadow: "0 40px 120px rgba(0,0,0,0.6), 0 0 80px rgba(103,232,249,0.08)" }}>
      <div style={{ width: 1536, height: 864, borderRadius: 10, overflow: "hidden", position: "relative", background: "#000" }}>
        <AbsoluteFill>{children}</AbsoluteFill>
      </div>
    </div>
    <div style={{ width: 1760, height: 26, marginTop: -2, borderRadius: "0 0 24px 24px", background: "linear-gradient(#2b3443, #1a202b)", border: `2px solid ${C.frameEdge}`, borderTop: "none" }} />
  </div>
);

/** Screen 390×844 (the phone clip's CSS size) shown at `scale`. */
export const PhoneFrame: React.FC<{ children: ReactNode; scale?: number }> = ({ children, scale = 1 }) => (
  <div style={{ transform: `scale(${scale})`, transformOrigin: "center" }}>
    <div style={{ padding: 14, borderRadius: 58, background: "#05070b", border: `3px solid ${C.frameEdge}`, boxShadow: "0 40px 120px rgba(0,0,0,0.7), 0 0 60px rgba(167,139,250,0.12)" }}>
      <div style={{ width: 390, height: 844, borderRadius: 44, overflow: "hidden", position: "relative", background: "#000" }}>
        <AbsoluteFill>{children}</AbsoluteFill>
        <div style={{ position: "absolute", top: 10, left: "50%", width: 110, height: 30, marginLeft: -55, borderRadius: 20, background: "#000" }} />
      </div>
    </div>
  </div>
);
