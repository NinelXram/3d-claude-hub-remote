// Pure text helpers for the Sessions chat view (Node-safe, so scripts/sessions-test.ts can check them).
import { defaultUrlTransform } from "react-markdown";
import { SESSION_VIDEO_TYPES } from "../../integrations/AgentBackend.ts";

export interface Segment {
  code: boolean;
  text: string;
  /** The fence's info string, e.g. "ts"; empty for prose. */
  lang: string;
}

/** Splits Markdown-ish text on ``` fences. An unclosed fence (text still streaming) runs to the end. */
export function splitFences(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index), lang: "" });
    out.push({ code: true, text: (m[2] ?? "").replace(/\n$/, ""), lang: (m[1] ?? "").trim() });
    last = re.lastIndex;
    if (last >= text.length) break;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last), lang: "" });
  return out;
}

/** Splits prose on `inline code` spans (single backticks, one line). */
export function splitInlineCode(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, text: text.slice(last, m.index) });
    out.push({ code: true, text: m[1] ?? "" });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** The first non-blank line, trimmed and capped, for one-line previews. */
export function firstLine(text: string, max = 120): string {
  const line = (text.split("\n").find((l) => l.trim()) ?? "").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The path of a video on the session's machine that a link or image in Claude's reply points at (relative to the
 * session's folder, absolute, or file://), or null for web URLs, other schemes and non-video files. The server
 * decides whether it may be played (only videos inside the session's folder).
 */
export function localVideoPath(url: string): string | null {
  let s = url.trim();
  if (/^file:\/\//i.test(s)) {
    s = s.slice("file://".length);
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !/^[A-Za-z]:[\\/]/.test(s)) {
    return null; // a scheme (https:, javascript:, data: …), not a drive letter
  }
  s = s.split(/[?#]/)[0] ?? "";
  try {
    s = decodeURIComponent(s);
  } catch {
    // keep it as written
  }
  const dot = s.lastIndexOf(".");
  return dot > 0 && SESSION_VIDEO_TYPES[s.slice(dot).toLowerCase()] ? s : null;
}

/** react-markdown's URL filter, except that local video paths (C:/…, file://…) survive to become players. */
export function markdownUrl(url: string): string {
  return localVideoPath(url) !== null ? url : defaultUrlTransform(url);
}
