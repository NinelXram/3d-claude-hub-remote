// World server: exposes any AgentBackend over the v1 WebSocket protocol (§3.5).
// The source can be the local simulation or a live feed; clients cannot tell the difference
// except through `welcome.simulated` and `welcome.label`.
import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../src/integrations/AgentBackend.ts";
import type { AgentBackend, ClientMessage, ServerMessage, WorldSnapshot } from "../src/integrations/AgentBackend.ts";
import { isSessionCommand } from "./sessions/sessionHub.ts";
import type { SessionHub } from "./sessions/sessionHub.ts";

export interface WorldServerOptions {
  backend: AgentBackend;
  port?: number;
  /** Loopback by default: the server may carry prompts and file names from a live session. */
  host?: string;
  token?: string;
  /**
   * What the token guards. "all" (default): no connection without it. "sessions": anyone on this machine may
   * watch the world as before, but transcripts, prompts and permission answers need the token.
   */
  tokenScope?: "all" | "sessions";
  /** Minimum gap between unsolicited snapshots. 100 ms = 10 Hz (§3.5). */
  snapshotIntervalMs?: number;
  /** Extra HTTP routes (e.g. the hook endpoint). Return true when handled. */
  http?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
  /** Served at GET / when set (the viewer page). */
  page?: () => string | null;
  helloTimeoutMs?: number;
  /** Recent events replayed to a client right after its first snapshot, so a late viewer's feed is not empty. */
  backlog?: number;
  /** Sessions extension (transcripts, prompts, permission answers). Requires `token`. */
  sessions?: SessionHub;
  /**
   * Which browser origins may open a WebSocket. Browsers do not apply CORS to WebSockets, so without this
   * any website you visit could connect to a server on 127.0.0.1. Default: no Origin header (non-browser
   * clients) or a loopback origin (localhost, 127.0.0.1, [::1]) on any port.
   */
  allowOrigin?: (origin: string | undefined) => boolean;
  /**
   * Serve the web app through this server (e.g. "http://127.0.0.1:3210"), so one forwarded port carries both
   * the page and its WebSocket from the same origin. Paths under /_next/ (including the dev server's hot-reload
   * socket) and every request this server does not handle itself go to the app.
   */
  proxyApp?: string;
  /**
   * A second loopback listener for `tailscale serve` to forward to, and nothing else. tailscale serve sets
   * Tailscale-User-Login on every request (overwriting whatever the client sent), so a connection on this port
   * whose login is in `logins` counts as holding the token. Other tunnels (Cloudflare, Dev Tunnels) keep using
   * `port`, where that header means nothing, because they would pass a forged one through.
   */
  tailnet?: { port: number; logins: string[] };
}

/** Whether a browser Origin names this very server (the page came through `proxyApp`, e.g. over a tunnel). */
function isSameOrigin(origin: string | undefined, ...hosts: (string | string[] | undefined)[]): boolean {
  if (!origin) return false;
  try {
    const o = new URL(origin).host;
    // Behind a reverse proxy (tailscale serve, a tunnel) the browser's host may only survive as X-Forwarded-Host.
    // Browsers cannot set that header, and remote pages still need the token.
    return hosts.flat().some((h) => !!h && h.split(",")[0]!.trim() === o);
  } catch {
    return false;
  }
}

/** Equal strings, compared in constant time (no timing hint about how much of a token matched). */
export function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Headers a reverse proxy or tunnel adds (tailscale serve, Dev Tunnels, Cloudflare, ngrok, nginx). The server only
 * listens on loopback, so these are how a request from another device shows itself; a local script sends none.
 */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip", "tailscale-user-login"];
export function cameThroughProxy(req: IncomingMessage): boolean {
  return PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
}

export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return (u.protocol === "http:" || u.protocol === "https:") && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export interface WorldServer {
  url: string;
  port: number;
  http: Server;
  /** The `tailnet` listener's port, when there is one. */
  tailnetPort?: number;
  /** Drop every client connection (tests: exercise reconnect). */
  dropClients(): void;
  close(): Promise<void>;
}

const CLOSE_PROTOCOL_MISMATCH = 4400;
const CLOSE_UNAUTHORISED = 4401;
const CLOSE_HELLO_TIMEOUT = 4408;

export async function startWorldServer(options: WorldServerOptions): Promise<WorldServer> {
  const { backend } = options;
  const interval = options.snapshotIntervalMs ?? 100;
  const clients = new Set<WebSocket>();

  const app = options.proxyApp ? new URL(options.proxyApp) : null;
  const proxyHttp = (req: IncomingMessage, res: ServerResponse) => {
    const upstream = httpRequest(
      { hostname: app!.hostname, port: app!.port, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end(`The app is not reachable at ${options.proxyApp}. Start it (npm run dev -- -p ${app!.port}) and reload.\n`);
    });
    req.pipe(upstream);
  };
  const proxyUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const upstream = netConnect(Number(app!.port), app!.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  };

  const http = createServer(async (req, res) => {
    try {
      if (options.http && (await options.http(req, res))) return;
      // Videos for the Sessions player: the ticket in the URL is the permission (see sessions/sessionFiles.ts).
      if (options.sessions?.serveFile(req, res)) return;
      if (app) {
        proxyHttp(req, res);
        return;
      }
      if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
        const page = options.page?.();
        if (page) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(page);
          return;
        }
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("3D Claude Hub Remote server. Connect over WebSocket (protocol v1).\n");
    } catch (e) {
      console.error("request failed:", e);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal error.\n");
    }
  });
  if (options.sessions && !options.token) throw new Error("The sessions extension needs a token: transcripts and prompts are private.");
  const allowOrigin = options.allowOrigin ?? isLoopbackOrigin;
  const tailnet = options.tailnet;
  if (tailnet && tailnet.port !== 0 && tailnet.port === (options.port ?? 8787)) throw new Error("The tailnet port must differ from the main port.");
  const trustedLogins = new Set((tailnet?.logins ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean));
  const isTrustedTailnet = (req: IncomingMessage): boolean => {
    if (!tailnet || !tsHttp || req.socket.localPort !== (tsHttp.address() as AddressInfo | null)?.port) return false;
    const login = req.headers["tailscale-user-login"];
    return typeof login === "string" && trustedLogins.has(login.trim().toLowerCase());
  };
  const wss = new WebSocketServer({
    noServer: true,
    verifyClient: (info: { origin?: string; req: IncomingMessage }, done: (ok: boolean, code?: number, message?: string) => void) => {
      const origin = info.origin || undefined;
      const same = isSameOrigin(origin, info.req.headers.host, info.req.headers["x-forwarded-host"]);
      if (!allowOrigin(origin) && !same) return done(false, 403, "Forbidden origin");
      // A browser page that is not on this machine (a tunnel, another device) must present the token.
      const onTailnetPort = !!tsHttp && info.req.socket.localPort === (tsHttp.address() as AddressInfo | null)?.port;
      // Remote: a page from elsewhere, anything that came through a proxy or tunnel, or anyone on the tailnet port.
      // A non-browser client sends no Origin, so the Origin alone cannot tell a local script from a tunnelled one.
      (info.req as IncomingMessage & { aawRemote?: boolean }).aawRemote = !isLoopbackOrigin(origin) || cameThroughProxy(info.req) || onTailnetPort;
      (info.req as IncomingMessage & { aawTrusted?: boolean }).aawTrusted = isTrustedTailnet(info.req);
      done(true);
    },
  });
  http.on("upgrade", (req, socket: Duplex, head: Buffer) => {
    if (app && req.url?.startsWith("/_next/")) proxyUpgrade(req, socket, head);
    else wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
  };
  // Only connections that presented the token ever see session data.
  const authed = new Set<WebSocket>();
  options.sessions?.attach({
    send: (conn, msg) => {
      if (authed.has(conn as WebSocket)) send(conn as WebSocket, msg);
    },
    broadcast: (msg) => {
      const data = JSON.stringify(msg);
      for (const ws of authed) if (ws.readyState === ws.OPEN) ws.send(data);
    },
  });

  // Snapshots: immediately after a command, otherwise at most one per `interval`.
  let latest: WorldSnapshot | null = backend.getSnapshot();
  let lastSent = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!latest) return;
    lastSent = Date.now();
    broadcast({ type: "snapshot", snapshot: latest });
  };
  const queueSnapshot = (now = false) => {
    if (now) {
      if (timer) clearTimeout(timer);
      flush();
      return;
    }
    if (timer) return;
    const wait = Math.max(0, lastSent + interval - Date.now());
    timer = setTimeout(flush, wait);
  };
  const offSnapshot = backend.subscribeSnapshot((s) => {
    latest = s;
    queueSnapshot();
  });
  const backlogSize = options.backlog ?? 200;
  const recent: ServerMessage[] = [];
  const offEvent = backend.subscribe((event) => {
    const msg: ServerMessage = { type: "event", event };
    if (event.type === "system.reset") recent.length = 0;
    recent.push(msg);
    if (recent.length > backlogSize) recent.shift();
    broadcast(msg);
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage & { aawRemote?: boolean; aawTrusted?: boolean }) => {
    const remote = req.aawRemote === true;
    const trusted = req.aawTrusted === true;
    let ready = false;
    const helloTimer = setTimeout(() => {
      if (!ready) ws.close(CLOSE_HELLO_TIMEOUT, "expected hello");
    }, options.helloTimeoutMs ?? 5000);

    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (!ready) {
        if (msg.type !== "hello") return;
        clearTimeout(helloTimer);
        if (msg.protocolVersion !== PROTOCOL_VERSION) {
          ws.close(CLOSE_PROTOCOL_MISMATCH, `protocol version ${msg.protocolVersion} not supported; this server speaks ${PROTOCOL_VERSION}`);
          return;
        }
        // Your own tailnet login (see `tailnet`) stands in for the token.
        const hasToken = !options.token || sameSecret(msg.token, options.token) || trusted;
        // A wrong token is always refused, so a typo is noticed; a missing one is fine when it only guards sessions.
        if (!hasToken && (options.tokenScope !== "sessions" || msg.token || remote)) {
          ws.close(CLOSE_UNAUTHORISED, "missing or wrong token");
          return;
        }
        if (hasToken) authed.add(ws);
        ready = true;
        clients.add(ws);
        const hub = options.sessions;
        send(ws, {
          type: "welcome", protocolVersion: PROTOCOL_VERSION, label: backend.label, simulated: backend.simulated,
          capabilities: {
            sessions: !!hub && hasToken,
            control: !!hub?.control && hasToken,
            locked: !!hub && !hasToken,
            ...(hub?.control && hasToken ? { permissionModes: hub.permissionModes } : {}),
          },
        });
        const snap = latest ?? backend.getSnapshot();
        if (snap) send(ws, { type: "snapshot", snapshot: snap });
        for (const m of recent) send(ws, m);
        if (hub && hasToken) {
          send(ws, { type: "sessions", sessions: hub.list() });
          for (const request of hub.pendingPermissions()) send(ws, { type: "permission", request });
        }
        return;
      }
      if (msg.type !== "command") return;
      try {
        const c = msg.command;
        if (isSessionCommand(c)) {
          if (!options.sessions) throw new Error("This server has no sessions extension (start it with --source claude-code --control).");
          if (!authed.has(ws)) throw new Error("Sessions need the server token: open the link the server printed, or paste the token from ~/.aaw/token.");
          const result = await options.sessions.handle(ws, c);
          send(ws, result === undefined ? { type: "ack", id: msg.id, ok: true } : { type: "ack", id: msg.id, ok: true, result });
          return;
        }
        let result: unknown;
        switch (c.name) {
          case "start": await backend.start(); break;
          case "stop": await backend.stop(); break;
          case "pause": await backend.pause(); break;
          case "resume": await backend.resume(); break;
          case "reset": await backend.reset(); break;
          case "setSpeed": await backend.setSpeed(c.multiplier); break;
          case "submitTask": result = await backend.submitTask(c.input); break;
          case "pauseAgent": await backend.pauseAgent(c.agentId); break;
          case "resumeAgent": await backend.resumeAgent(c.agentId); break;
          case "focusSession":
            if (!backend.focusSession) throw new Error("This backend has a single story to tell; there is no session to follow.");
            await backend.focusSession(c.sessionId);
            break;
          default: throw new Error(`unknown command ${(c as { name: string }).name}`);
        }
        send(ws, result === undefined ? { type: "ack", id: msg.id, ok: true } : { type: "ack", id: msg.id, ok: true, result });
        latest = backend.getSnapshot() ?? latest;
        queueSnapshot(true);
      } catch (e) {
        send(ws, { type: "ack", id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clients.delete(ws);
      authed.delete(ws);
      options.sessions?.disconnect(ws);
    });
  });

  await new Promise<void>((resolve) => http.listen(options.port ?? 8787, options.host ?? "127.0.0.1", resolve));
  const { port, address } = http.address() as AddressInfo;
  const host = address.includes(":") ? `[${address}]` : address;
  // Same handlers, separate port: only the port tells a tailscale serve request apart from any other.
  const tsHttp = tailnet ? createServer() : null;
  if (tsHttp) {
    tsHttp.on("request", (req, res) => http.emit("request", req, res));
    tsHttp.on("upgrade", (req, socket, head) => http.emit("upgrade", req, socket, head));
    await new Promise<void>((resolve, reject) => {
      tsHttp.once("error", reject);
      tsHttp.listen(tailnet!.port, "127.0.0.1", () => resolve());
    });
  }

  return {
    url: `ws://${host}:${port}`,
    port,
    http,
    ...(tsHttp ? { tailnetPort: (tsHttp.address() as AddressInfo).port } : {}),
    dropClients() {
      for (const ws of clients) ws.terminate();
      clients.clear();
    },
    async close() {
      offSnapshot();
      offEvent();
      if (timer) clearTimeout(timer);
      for (const ws of clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      if (tsHttp) await new Promise<void>((resolve) => tsHttp.close(() => resolve()));
    },
  };
}
