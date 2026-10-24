// Videos from a session's working folder, for the web UI's player. The UI asks over the authenticated WebSocket
// (`sessionFile`); the server answers with an unguessable, expiring ticket, and the <video> element fetches the
// bytes from GET /session-file/<ticket>. A <video> cannot send the token, and the token never goes in a URL.
import { randomBytes } from "node:crypto";
import { createReadStream, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { SESSION_VIDEO_TYPES } from "../../src/integrations/AgentBackend.ts";

export interface SessionVideo {
  file: string;
  mediaType: string;
  size: number;
  name: string;
}

/**
 * The video `path` names (absolute, or relative to `cwd`), if it is a video file that really lives inside `cwd`
 * (symlinks and junctions resolved). Throws a message for the UI otherwise.
 */
export function resolveSessionVideo(cwd: string, path: string): SessionVideo {
  if (!cwd) throw new Error("This session has no working folder, so it has no files to play.");
  const wanted = path.trim();
  if (!wanted) throw new Error("No file given.");
  const mediaType = SESSION_VIDEO_TYPES[extname(wanted).toLowerCase()];
  if (!mediaType) throw new Error(`Only videos can be played here (${Object.keys(SESSION_VIDEO_TYPES).join(", ")}).`);
  let base: string;
  let real: string;
  try {
    base = realpathSync(cwd);
    real = realpathSync(isAbsolute(wanted) ? wanted : resolve(cwd, wanted));
  } catch {
    throw new Error(`${basename(wanted)} was not found in this session's folder.`);
  }
  const inside = process.platform === "win32" ? real.toLowerCase().startsWith(base.toLowerCase() + sep) : real.startsWith(base + sep);
  if (!inside) throw new Error("Only files inside this session's folder can be played.");
  // The link may point at another type than its name says; check the real file too.
  if (SESSION_VIDEO_TYPES[extname(real).toLowerCase()] !== mediaType) throw new Error("Only videos can be played here.");
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`${basename(wanted)} is not a file.`);
  return { file: real, mediaType, size: st.size, name: basename(real) };
}

const TICKET_MS = 30 * 60 * 1000;
const MAX_TICKETS = 200;
export const SESSION_FILE_PREFIX = "/session-file/";

/** Tickets for videos the UI asked for, and the HTTP route that streams them (with Range, so players can seek). */
export class FileTickets {
  private tickets = new Map<string, { video: SessionVideo; expires: number; owner: object }>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A URL path for this video, valid for 30 minutes or until `owner` (the connection that asked) goes away. */
  issue(video: SessionVideo, owner: object): string {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.expires <= t) this.tickets.delete(k);
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { video, expires: t + TICKET_MS, owner });
    return SESSION_FILE_PREFIX + ticket;
  }

  /** Drop every ticket handed to this connection. */
  revoke(owner: object): void {
    for (const [k, v] of this.tickets) if (v.owner === owner) this.tickets.delete(k);
  }

  /** Handles GET/HEAD /session-file/<ticket>; false for any other URL. */
  serve(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? "";
    if (!url.startsWith(SESSION_FILE_PREFIX)) return false;
    const ticket = url.slice(SESSION_FILE_PREFIX.length).split("?")[0]!;
    const entry = this.tickets.get(ticket);
    if (!entry || entry.expires <= this.now()) {
      this.tickets.delete(ticket);
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("This link has expired. Open the video again from the session.\n");
      return true;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" });
      res.end();
      return true;
    }
    let size: number;
    try {
      size = statSync(entry.video.file).size;
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("The file is gone.\n");
      return true;
    }
    const headers: Record<string, string | number> = {
      "content-type": entry.video.mediaType,
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        if (m[1]) {
          start = Number(m[1]);
          end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        } else {
          start = Math.max(0, size - Number(m[2]));
        }
      }
      if (!m || start >= size || start > end) {
        res.writeHead(416, { "content-range": `bytes */${size}` });
        res.end();
        return true;
      }
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
    }
    headers["content-length"] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return true;
    }
    const stream = createReadStream(entry.video.file, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
    return true;
  }
}
