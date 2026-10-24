// Prints the Claude Code settings block that forwards hooks to the 3D Claude Hub Remote server.
// Paste it into the "hooks" key of ~/.claude/settings.json (all projects) or <project>/.claude/settings.local.json.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "forward-hook.sh"));
const handler = { type: "command", command: script, async: true, timeout: 5 };
const events = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "Notification", "PreCompact", "PermissionRequest", "PermissionDenied"];
const hooks = Object.fromEntries(events.map((e) => [e, [{ hooks: [handler] }]]));
console.log(JSON.stringify({ hooks }, null, 2));
