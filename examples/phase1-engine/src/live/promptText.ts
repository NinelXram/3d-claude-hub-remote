// Prompts as Claude Code records them carry wrapper blocks that are not what you typed: the IDE's selection or
// open file, system reminders, and slash-command envelopes. Titles should show what you actually asked.

const WRAPPER_BLOCKS = /<(ide_selection|ide_opened_file|ide_diagnostics|system-reminder|local-command-stdout|local-command-stderr|local-command-caveat|command-message|command-args|command-name)>[\s\S]*?<\/\1>/g;

/** What you typed, without wrapper blocks; "" when nothing is left (e.g. a bare `/clear`). */
export function typedText(prompt: string): string {
  return prompt.replace(WRAPPER_BLOCKS, " ").replace(/\s+/g, " ").trim();
}

/** The slash command a prompt runs (e.g. "/clear"), if it is one. */
export function slashCommand(prompt: string): string | null {
  return /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(prompt)?.[1] ?? null;
}
