// Writes Claude Code-shaped transcript lines (same fields as a real transcript) for the staged sessions.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "./scenario.ts";

export interface TranscriptTarget {
  sessionId: string;
  cwd: string;
  branch: string;
  file: string;
}

let seq = 0;
const uuid = () => `5e55${(++seq).toString(16).padStart(4, "0")}-0000-4000-8000-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;

/** Claude Code's folder name for a working directory: every non-alphanumeric character becomes "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptFile(root: string, cwd: string, sessionId: string): string {
  const dir = join(root, projectDirName(cwd));
  mkdirSync(dir, { recursive: true });
  return join(dir, `${sessionId}.jsonl`);
}

function base(t: TranscriptTarget, type: "user" | "assistant") {
  return {
    parentUuid: null,
    isSidechain: false,
    type,
    uuid: uuid(),
    timestamp: new Date().toISOString(),
    userType: "external",
    entrypoint: "cli",
    cwd: t.cwd,
    sessionId: t.sessionId,
    version: "2.1.304",
    gitBranch: t.branch,
  };
}

function write(t: TranscriptTarget, line: object): void {
  appendFileSync(t.file, JSON.stringify(line) + "\n");
}

/** `content` is a string, or blocks (images first, then text) as `promptContent` builds them. */
export function writePrompt(t: TranscriptTarget, content: unknown): void {
  write(t, { ...base(t, "user"), message: { role: "user", content } });
}

export function writeToolUse(t: TranscriptTarget, step: Step, toolUseId: string): void {
  write(t, { ...base(t, "assistant"), message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: step.tool, input: step.input }] } });
}

export function writeToolResult(t: TranscriptTarget, step: Step, toolUseId: string): void {
  write(t, {
    ...base(t, "user"),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: step.result, is_error: step.failed === true }] },
  });
}

export function writeReply(t: TranscriptTarget, text: string): void {
  write(t, { ...base(t, "assistant"), message: { role: "assistant", content: [{ type: "text", text }] } });
}

export const newToolUseId = () => `toolu_5e55${(++seq).toString(36)}`;
