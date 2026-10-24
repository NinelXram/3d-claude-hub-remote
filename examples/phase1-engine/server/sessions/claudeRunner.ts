// Runs Claude Code sessions for the web UI through the Claude Agent SDK.
// The SDK spawns the same `claude` you use in the terminal, so it uses your login, your settings and
// your hooks (sessions started here show up in the 3D world like any other).
import { execFileSync } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PromptImage, SessionPermissionMode } from "../../src/integrations/AgentBackend.ts";

export interface PermissionAsk {
  toolName: string;
  input: Record<string, unknown>;
  /** Claude Code's own sentence for the ask, when it provides one. */
  title?: string;
  signal: AbortSignal;
}

export interface RunOptions {
  cwd: string;
  firstPrompt: string;
  /** Images attached to the first prompt. */
  firstImages?: PromptImage[];
  /** Continue this session id. */
  resume?: string;
  /** With `resume`: continue in a new session id, leaving the original untouched. */
  fork: boolean;
  /** Starting permission mode. */
  permissionMode: SessionPermissionMode;
  canUseTool(ask: PermissionAsk): Promise<boolean>;
  /**
   * The session id Claude Code assigned (from its init message). Called again with a new id when the
   * conversation restarts (/clear, /reset, /new).
   */
  onSession(sessionId: string): void;
  /** A turn finished: Claude is waiting for the next prompt. */
  onTurnEnd(): void;
  /** The process ended (error is set when it failed). */
  onExit(error?: string): void;
}

export interface RunHandle {
  /** Queue another prompt in the same session, with any images attached to it. */
  push(text: string, images?: PromptImage[]): void;
  interrupt(): Promise<void>;
  /** Change the permission mode of the running session (applies from its next tool call). */
  setPermissionMode(mode: SessionPermissionMode): Promise<void>;
  close(): void;
}

export type Runner = (options: RunOptions) => RunHandle;

/** A prompt queue the SDK reads as a stream, so one process serves the whole conversation. */
interface Prompt {
  text: string;
  images?: PromptImage[];
}

class PromptQueue implements AsyncIterable<SDKUserMessage> {
  private items: Prompt[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(prompt: Prompt): void {
    if (this.closed) return;
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      w({ value: toMessage(prompt), done: false });
    } else this.items.push(prompt);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const prompt = this.items.shift();
        if (prompt !== undefined) return Promise.resolve({ value: toMessage(prompt), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/** A prompt as the SDK takes it: plain text, or image blocks followed by the text when images are attached. */
export function promptContent(text: string, images: readonly PromptImage[] = []): SDKUserMessage["message"]["content"] {
  if (images.length === 0) return text;
  return [
    ...images.map((im) => ({ type: "image" as const, source: { type: "base64" as const, media_type: im.mediaType, data: im.data } })),
    ...(text.trim() ? [{ type: "text" as const, text }] : []),
  ];
}

function toMessage({ text, images }: Prompt): SDKUserMessage {
  // Typed by a person in the web UI.
  return { type: "user", message: { role: "user", content: promptContent(text, images) }, parent_tool_use_id: null, origin: { kind: "human" } };
}

function findClaude(): string | undefined {
  try {
    if (process.platform === "win32") {
      // `where`, not a Git Bash `which` (its /c/... path cannot be spawned). Only a real .exe: npm installs
      // list an extensionless shell shim first. Without one the SDK uses its bundled CLI.
      return execFileSync("where", ["claude"], { encoding: "utf8" }).split(/\r?\n/).find((l) => /\.exe$/i.test(l.trim()))?.trim();
    }
    return execFileSync("which", ["claude"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function createSdkRunner(): Runner {
  const claudePath = findClaude();
  return (o) => {
    const prompts = new PromptQueue();
    prompts.push({ text: o.firstPrompt, ...(o.firstImages?.length ? { images: o.firstImages } : {}) });
    const q = query({
      prompt: prompts,
      options: {
        cwd: o.cwd,
        ...(o.resume ? { resume: o.resume, forkSession: o.fork } : {}),
        ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
        // Always explicit: left out, the CLI would take settings' defaultMode and the UI would show the wrong mode.
        permissionMode: o.permissionMode,
        // Only reachable when the server was started with --allow-bypass (the hub refuses the mode otherwise).
        ...(o.permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
        // Questions come back as plain text in the chat instead of a picker the web UI cannot render.
        disallowedTools: ["AskUserQuestion"],
        canUseTool: async (toolName, input, ctx) => {
          const title = (ctx as { title?: string }).title;
          const allowed = await o.canUseTool({ toolName, input, signal: ctx.signal, ...(title ? { title } : {}) });
          return allowed
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: "Denied by the user in the 3D Claude Hub Remote web UI." };
        },
      },
    });
    let current = "";
    void (async () => {
      try {
        for await (const m of q) {
          if (m.type === "system" && m.subtype === "init" && m.session_id !== current) {
            current = m.session_id;
            o.onSession(m.session_id);
          } else if (m.type === "result") {
            o.onTurnEnd();
          }
        }
        o.onExit();
      } catch (e) {
        o.onExit(e instanceof Error ? e.message : String(e));
      }
    })();
    return {
      push: (text, images) => prompts.push({ text, ...(images?.length ? { images } : {}) }),
      interrupt: async () => {
        await q.interrupt();
      },
      setPermissionMode: async (mode) => {
        await q.setPermissionMode(mode);
      },
      close: () => {
        prompts.close();
        q.close();
      },
    };
  };
}
