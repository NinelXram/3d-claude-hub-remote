// Reads Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl) into chat items.
//
// Only the conversation is kept: your prompts, Claude's text, and each tool call merged with its result.
// Thinking, subagent side-chains, metadata and API bookkeeping lines are dropped. Sizes are capped so a
// huge tool output never floods the socket. Images you attached to a prompt travel as references; their bytes
// are kept aside (see `TranscriptTail.image`) and sent only when the web UI asks for them.
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { SessionImageRef, SessionItem } from "../../src/integrations/AgentBackend.ts";
import { slashCommand, typedText } from "../../src/live/promptText.ts";

const MAX_TEXT = 8000;
const CHUNK = 4 * 1024 * 1024;
const MAX_TOOL_INPUT = 2000;
const MAX_TOOL_RESULT = 4000;

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * A slash command ("/clear") or its captured output, as one quiet line; null for anything else.
 * Claude Code wraps both in tags: <command-name>/clear</command-name>, <local-command-stdout>…</local-command-stdout>.
 */
export function commandNotice(content: string): string | null {
  const cmd = slashCommand(content);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(content)?.[1]?.trim();
    return args ? `${cmd} ${args}` : cmd;
  }
  const out = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/.exec(content);
  if (out) return out[1]!.trim() ? cap(out[1]!.trim(), MAX_TOOL_RESULT) : null;
  return null;
}

/** The bytes of one image found in a transcript (base64, as Claude Code stored it). */
export interface TranscriptImage {
  mediaType: string;
  data: string;
}

/** Image blocks of a prompt, as references; their data goes into `store` under the same ids. */
function promptImages(uuid: string, content: unknown[], store: Map<string, TranscriptImage> | undefined): SessionImageRef[] {
  const refs: SessionImageRef[] = [];
  for (const [i, b] of content.entries()) {
    const block = b as { type?: unknown; source?: { type?: unknown; media_type?: unknown; data?: unknown } } | null;
    const src = block?.type === "image" ? block.source : undefined;
    if (src?.type !== "base64" || typeof src.media_type !== "string" || typeof src.data !== "string") continue;
    const id = `${uuid}:img${i}`;
    refs.push({ id, mediaType: src.media_type });
    store?.set(id, { mediaType: src.media_type, data: src.data });
  }
  return refs;
}

/** Short human summary of a tool call's input, e.g. the command for Bash or the path for Edit. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  const s = pick("command") || pick("file_path") || pick("notebook_path") || pick("pattern") || pick("url") || pick("query") || pick("description") || pick("prompt");
  return s.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Turn transcript lines into chat items. `pending` maps tool_use ids to their items so a result that arrives
 * in a later chunk updates the right item; pass the same map on every call for one transcript.
 * Returns the items created or updated by these lines (upsert by `id`). Images in prompts are stored in `images`
 * when given.
 */
export function parseTranscriptLines(
  lines: string[],
  pending: Map<string, SessionItem & { kind: "tool" }>,
  images?: Map<string, TranscriptImage>,
): SessionItem[] {
  const out = new Map<string, SessionItem>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (d["isSidechain"] === true || d["isMeta"] === true) continue;
    const type = d["type"];
    const at0 = typeof d["timestamp"] === "string" ? Date.parse(d["timestamp"] as string) || 0 : 0;
    const uuid0 = typeof d["uuid"] === "string" ? (d["uuid"] as string) : `line-${at0}-${out.size}`;
    // Slash commands and their output (/clear, /cost, /model …) are recorded as system lines.
    if (type === "system" && d["subtype"] === "local_command" && typeof d["content"] === "string") {
      const text = commandNotice(d["content"] as string);
      if (text) out.set(uuid0, { kind: "notice", id: uuid0, at: at0, text });
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    const message = d["message"] as { content?: unknown } | undefined;
    const at = typeof d["timestamp"] === "string" ? Date.parse(d["timestamp"] as string) || 0 : 0;
    const uuid = typeof d["uuid"] === "string" ? (d["uuid"] as string) : `${type}-${at}-${out.size}`;
    const content = message?.content;

    if (type === "user") {
      if (typeof content === "string") {
        const notice = commandNotice(content);
        if (notice) out.set(uuid, { kind: "notice", id: uuid, at, text: notice });
        else if (content.trim()) out.set(uuid, { kind: "user", id: uuid, at, text: cap(typedText(content) || content, MAX_TEXT) });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const text = blockText(content);
      const refs = promptImages(uuid, content, images);
      if (text.trim() || refs.length > 0) {
        out.set(uuid, { kind: "user", id: uuid, at, text: cap(text, MAX_TEXT), ...(refs.length > 0 ? { images: refs } : {}) });
      }
      for (const b of content as Array<Record<string, unknown>>) {
        if (b?.["type"] !== "tool_result") continue;
        const tool = pending.get(String(b["tool_use_id"]));
        if (!tool) continue;
        // A new object: items already handed out stay as they were.
        const updated = { ...tool, result: { text: cap(blockText(b["content"]), MAX_TOOL_RESULT), isError: b["is_error"] === true } };
        pending.set(tool.id, updated);
        out.set(tool.id, updated);
      }
      continue;
    }

    // assistant
    if (!Array.isArray(content)) continue;
    for (const [i, b] of (content as Array<Record<string, unknown>>).entries()) {
      if (b?.["type"] === "text" && String(b["text"] ?? "").trim()) {
        const id = `${uuid}:${i}`;
        out.set(id, { kind: "assistant", id, at, text: cap(String(b["text"]), MAX_TEXT) });
      } else if (b?.["type"] === "tool_use") {
        const id = String(b["id"]);
        const input = (b["input"] && typeof b["input"] === "object" ? b["input"] : {}) as Record<string, unknown>;
        const name = String(b["name"] ?? "tool");
        if (name === "ToolSearch") continue; // Claude Code plumbing, not work done for you
        const item: SessionItem & { kind: "tool" } = {
          kind: "tool", id, at, name,
          summary: toolSummary(name, input),
          input: cap(JSON.stringify(input, null, 2), MAX_TOOL_INPUT),
        };
        pending.set(id, item);
        out.set(id, item);
      }
    }
  }
  return [...out.values()];
}

/** The only directory transcripts may be read from. Paths come from hook payloads and are checked against it. */
export function projectsRoot(): string {
  return join(homedir(), ".claude", "projects");
}

/** True when `path` is a .jsonl file that really lives under `root` (symlinks resolved). */
export function isAllowedTranscript(path: string, root = projectsRoot()): boolean {
  if (typeof path !== "string" || !path.endsWith(".jsonl")) return false;
  // Decide on the text first: the path comes from a hook payload, and touching a UNC path (two leading slashes) makes
  // Windows contact that host and offer the user's credentials. Only absolute paths under the root go further.
  if (/^[/\\]{2}/.test(path) || !isAbsolute(path)) return false;
  const lexical = resolve(path);
  const base = resolve(root) + sep;
  const under = process.platform === "win32" ? lexical.toLowerCase().startsWith(base.toLowerCase()) : lexical.startsWith(base);
  if (!under || !existsSync(path) || !existsSync(root)) return false;
  try {
    const real = realpathSync(path);
    const base = realpathSync(root) + sep;
    return real.startsWith(base) && statSync(real).isFile();
  } catch {
    return false;
  }
}

/** Reads a transcript incrementally: each poll returns only the items created or changed since the last one. */
export class TranscriptTail {
  readonly path: string;
  private offset = 0;
  private partial = "";
  // Keeps multi-byte characters intact across chunk boundaries.
  private decoder = new StringDecoder("utf8");
  private pending = new Map<string, SessionItem & { kind: "tool" }>();
  private images = new Map<string, TranscriptImage>();

  constructor(path: string) {
    this.path = path;
  }

  poll(): SessionItem[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Rewritten or truncated: start over.
      this.offset = 0;
      this.partial = "";
      this.decoder = new StringDecoder("utf8");
      this.pending.clear();
      this.images.clear();
    }
    if (size === this.offset) return [];
    // Read in chunks: a 50 MB transcript must not become one 50 MB buffer plus a 50 MB string.
    const fd = openSync(this.path, "r");
    const changed = new Map<string, SessionItem>();
    const buf = Buffer.alloc(Math.min(CHUNK, size - this.offset));
    try {
      while (this.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - this.offset), this.offset);
        if (n <= 0) break;
        this.offset += n;
        const lines = (this.partial + this.decoder.write(buf.subarray(0, n))).split("\n");
        this.partial = lines.pop() ?? "";
        for (const it of parseTranscriptLines(lines, this.pending, this.images)) changed.set(it.id, it);
      }
      return [...changed.values()];
    } finally {
      closeSync(fd);
    }
  }

  /** An image of a prompt read so far, by the id in its item's `images`. */
  image(id: string): TranscriptImage | undefined {
    return this.images.get(id);
  }
}
