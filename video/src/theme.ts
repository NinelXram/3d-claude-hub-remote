// Look of the video: the app's dark palette, Be Vietnam Pro (OFL, full Vietnamese) and JetBrains Mono (OFL).
import { loadFont as loadSans } from "@remotion/google-fonts/BeVietnamPro";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

export const sans = loadSans("normal", { weights: ["400", "600", "800"], subsets: ["latin", "vietnamese"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "600"], subsets: ["latin", "vietnamese"] }).fontFamily;

export const C = {
  bg: "#0b0f17",
  bg2: "#111827",
  ink: "#e5e7eb",
  dim: "#94a3b8",
  accent: "#67e8f9",
  accent2: "#a78bfa",
  warn: "#fbbf24",
  bad: "#f87171",
  good: "#4ade80",
  frame: "#1f2937",
  frameEdge: "#374151",
};

/** Frames for a caption to fade in or out. */
export const FADE = 8;
