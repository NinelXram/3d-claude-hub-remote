// POST /hook: receives Claude Code hook payloads (forwarded by bridge/forward-hook.sh) for a live source.
import { appendFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HookPayload, LiveAgentBackend } from "../src/live/LiveAgentBackend.ts";
import { isLoopbackOrigin, sameSecret } from "./worldServer.ts";

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface HookRouteOptions {
  live: LiveAgentBackend;
  token?: string;
  /** Append every accepted payload as {t, payload} JSON lines, for scripts/replay-hooks.ts. */
  record?: string;
  /** Also receives every accepted payload (the sessions extension). */
  onPayload?: (payload: HookPayload) => void;
}

export function createHookRoute(options: HookRouteOptions) {
  const started = Date.now();
  // The same hooks configured at two levels (user and project) deliver every payload twice.
  const recent = new Map<string, number>();
  const DEDUPE_MS = 5000;
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "POST" || path !== "/hook") return false;
    // Hooks come from curl, which sends no Origin. A browser always does on a cross-site POST, so a web page
    // trying to inject fake events into the world is refused here.
    if (!isLoopbackOrigin(req.headers.origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    // Always 204 with an empty body: Claude Code must never read anything back from this server,
    // and a broken visualiser must never turn into hook errors inside a session.
    try {
      if (options.token && !sameSecret(req.headers["authorization"], `Bearer ${options.token}`)) throw new Error("unauthorised");
      const body = await readBody(req);
      const now = Date.now();
      for (const [k, at] of recent) if (now - at > DEDUPE_MS) recent.delete(k);
      if (recent.has(body)) throw new Error("duplicate");
      recent.set(body, now);
      const payload = JSON.parse(body) as HookPayload;
      if (typeof payload?.hook_event_name !== "string") throw new Error("not a hook payload");
      // Recordings hold prompts verbatim: readable by you only.
      if (options.record) appendFileSync(options.record, JSON.stringify({ t: Date.now() - started, payload }) + "\n", { mode: 0o600 });
      options.live.ingest(payload);
      options.onPayload?.(payload);
    } catch {
      // ignored on purpose
    }
    res.writeHead(204);
    res.end();
    return true;
  };
}
