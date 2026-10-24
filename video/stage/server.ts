// The stage: the repo's real world server (live mirror + sessions) fed by scripted sessions instead of Claude Code.
// No API calls, no real transcripts: everything lives in video/.stage and is invented in scenario.ts.
//   npm run stage            serve on :8797 and play the scenario once (restart to play it again)
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveAgentBackend } from "../../examples/phase1-engine/src/live/LiveAgentBackend.ts";
import { SessionHub } from "../../examples/phase1-engine/server/sessions/sessionHub.ts";
import { promptContent } from "../../examples/phase1-engine/server/sessions/claudeRunner.ts";
import type { RunOptions, Runner } from "../../examples/phase1-engine/server/sessions/claudeRunner.ts";
import { createHookRoute } from "../../examples/phase1-engine/server/hookRoute.ts";
import { startWorldServer } from "../../examples/phase1-engine/server/worldServer.ts";
import type { PromptImage } from "../../examples/phase1-engine/src/integrations/AgentBackend.ts";
import { SCENARIO, WEB_TURN } from "./scenario.ts";
import type { StagedSession, Step, Turn } from "./scenario.ts";
import { newToolUseId, transcriptFile, writePrompt, writeReply, writeToolResult, writeToolUse } from "./transcripts.ts";
import type { TranscriptTarget } from "./transcripts.ts";

export const STAGE_TOKEN = "video-demo-token";
export const STAGE_PORT = 8797;
const here = dirname(fileURLToPath(import.meta.url));
const STAGE_HOME = join(here, "..", ".stage", "home");

export interface Stage {
  url: string;
  port: number;
  token: string;
  root: string;
  /** Run every staged session's live turn once (resolves when all have ended their turn). */
  play(): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startStage(opts: { port?: number; stepMs?: number } = {}): Promise<Stage> {
  const stepMs = opts.stepMs ?? 1800;
  const root = join(STAGE_HOME, ".claude", "projects");
  rmSync(STAGE_HOME, { recursive: true, force: true });
  // The hub only sends prompts to sessions whose folder exists. Create the empty demo folders; remove on close
  // only the ones created here, and only while still empty.
  const created: string[] = [];
  for (const dir of ["C:/demo", ...SCENARIO.map((s) => s.cwd)]) {
    if (existsSync(dir)) continue;
    mkdirSync(dir);
    created.push(dir);
  }

  let hookUrl = "";
  const hook = async (t: TranscriptTarget, event: string, extra: Record<string, unknown> = {}) => {
    await fetch(hookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: t.sessionId, transcript_path: t.file, cwd: t.cwd, permission_mode: "default", hook_event_name: event, ...extra }),
    });
  };

  /** One tool call: transcript lines and the Pre/Post hooks the robots react to. */
  const runStep = async (t: TranscriptTarget, step: Step) => {
    const id = newToolUseId();
    writeToolUse(t, step, id);
    await hook(t, "PreToolUse", { tool_name: step.tool, tool_input: step.input, tool_use_id: id });
    await sleep(stepMs);
    writeToolResult(t, step, id);
    if (step.failed) await hook(t, "PostToolUseFailure", { tool_name: step.tool, tool_input: step.input, tool_use_id: id, error: step.result });
    else await hook(t, "PostToolUse", { tool_name: step.tool, tool_input: step.input, tool_use_id: id, tool_response: step.tool === "Bash" ? { stdout: step.result, stderr: "", interrupted: false } : step.result });
    await sleep(stepMs / 3);
  };

  const writeTurnQuietly = (t: TranscriptTarget, turn: Turn) => {
    writePrompt(t, turn.prompt);
    for (const step of turn.steps) {
      const id = newToolUseId();
      writeToolUse(t, step, id);
      writeToolResult(t, step, id);
    }
    writeReply(t, turn.reply);
  };

  const targets = new Map<string, TranscriptTarget>();
  const targetOf = (s: StagedSession): TranscriptTarget => {
    let t = targets.get(s.id);
    if (!t) {
      t = { sessionId: s.id, cwd: s.cwd, branch: s.branch, file: transcriptFile(root, s.cwd, s.id) };
      targets.set(s.id, t);
      writeTurnQuietly(t, s.earlier);
    }
    return t;
  };

  const playSession = async (s: StagedSession) => {
    await sleep((s.startAfterS * 1000 * stepMs) / 1800);
    const t = targetOf(s);
    writePrompt(t, s.live.prompt);
    await hook(t, "UserPromptSubmit", { prompt: s.live.prompt });
    await sleep(stepMs);
    for (const step of s.live.steps) await runStep(t, step);
    writeReply(t, s.live.reply);
    await hook(t, "Stop", { stop_hook_active: false, last_assistant_message: s.live.reply });
  };

  let forks = 0;
  const runner: Runner = (o: RunOptions) => {
    const staged = SCENARIO.find((s) => s.id === o.resume || s.cwd === o.cwd);
    const id = o.resume && !o.fork ? o.resume : `5e55f0${(++forks).toString().padStart(2, "0")}-0000-4000-8000-00000000c0de`;
    const t: TranscriptTarget = { sessionId: id, cwd: o.cwd, branch: staged?.branch ?? "main", file: transcriptFile(root, o.cwd, id) };
    const source = o.resume ? targets.get(o.resume) : undefined;
    if (o.fork && source && existsSync(source.file)) copyFileSync(source.file, t.file);
    targets.set(id, t);

    /** One web turn: read a file, ask to run the tests, then answer. `written`: the prompt line is already on disk. */
    const runTurn = async (text: string, images: PromptImage[], written: boolean) => {
      if (!written) writePrompt(t, promptContent(text, images));
      await hook(t, "UserPromptSubmit", { prompt: text });
      await sleep(stepMs);
      await runStep(t, WEB_TURN.readStep);
      const step = WEB_TURN.askedStep;
      const toolUseId = newToolUseId();
      writeToolUse(t, step, toolUseId);
      await hook(t, "PermissionRequest", { tool_name: step.tool, tool_input: step.input });
      const allowed = await o.canUseTool({ toolName: step.tool, input: step.input, title: WEB_TURN.askTitle, signal: new AbortController().signal });
      if (allowed) {
        await hook(t, "PreToolUse", { tool_name: step.tool, tool_input: step.input, tool_use_id: toolUseId });
        await sleep(stepMs);
        writeToolResult(t, step, toolUseId);
        await hook(t, "PostToolUse", { tool_name: step.tool, tool_input: step.input, tool_use_id: toolUseId, tool_response: { stdout: step.result, stderr: "", interrupted: false } });
        await sleep(stepMs / 3);
        writeReply(t, WEB_TURN.reply);
      } else {
        writeToolResult(t, { ...step, result: "Permission denied", failed: true }, toolUseId);
        writeReply(t, "Đã dừng theo yêu cầu của bạn.");
      }
      await hook(t, "Stop", { stop_hook_active: false });
      o.onTurnEnd();
    };
    // The transcript exists before the hub is told the id, so it finds the file at once.
    writePrompt(t, promptContent(o.firstPrompt, o.firstImages ?? []));
    setTimeout(() => o.onSession(id), 10);
    let queue = runTurn(o.firstPrompt, o.firstImages ?? [], true);
    return {
      push: (text, images) => {
        queue = queue.then(() => runTurn(text, images ?? [], false));
      },
      interrupt: async () => {},
      setPermissionMode: async () => {},
      close: () => {},
    };
  };

  const live = new LiveAgentBackend({ showPrompts: true });
  await live.connect();
  const sessions = new SessionHub({ runner, root, pollMs: 100, discoverWithinMs: 0 });
  const server = await startWorldServer({
    backend: live,
    port: opts.port ?? STAGE_PORT,
    host: "127.0.0.1",
    token: STAGE_TOKEN,
    tokenScope: "sessions",
    sessions,
    http: createHookRoute({ live, onPayload: (p) => sessions.noteHook(p) }),
  });
  hookUrl = `${server.url.replace(/^ws/, "http")}/hook`;
  // Every session is listed from the start (with its earlier turn), so the list shows all of them at once.
  for (const s of SCENARIO) await hook(targetOf(s), "SessionStart", { source: "startup" });

  // The scenario plays once per stage: a second run would append the same turn again.
  let played: Promise<void> | null = null;
  return {
    url: server.url,
    port: server.port,
    token: STAGE_TOKEN,
    root,
    play: () => (played ??= Promise.all(SCENARIO.map(playSession)).then(() => {})),
    close: async () => {
      sessions.dispose();
      await server.close();
      await live.disconnect();
      for (const dir of created.reverse()) if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stage = await startStage();
  console.log(`stage server  ${stage.url}  (token ${stage.token})`);
  console.log(`app (live build) http://localhost:3212/?token=${stage.token}`);
  void stage.play();
  const stop = async () => {
    await stage.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
