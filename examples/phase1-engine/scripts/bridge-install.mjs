// Install, remove or inspect the 3D Claude Hub Remote hooks in a Claude Code settings file.
//
//   npm run bridge -- status    [--scope user|project] [--project DIR]
//   npm run bridge -- install   [--scope user|project] [--project DIR] [--dry-run]
//   npm run bridge -- uninstall [--scope user|project] [--project DIR] [--dry-run]
//
// user     ~/.claude/settings.json            (every project)
// project  DIR/.claude/settings.local.json    (one project; not committed)
//
// Only handlers whose command ends in bridge/forward-hook.sh are ever added or removed. Every other hook,
// and every other setting, is left exactly as it was. The file is backed up before each change.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const EVENTS = [
  "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "Stop", "StopFailure", "SubagentStart", "SubagentStop", "Notification", "PreCompact",
  "PermissionRequest", "PermissionDenied",
];
// Forward slashes: on Windows Claude Code runs hook commands in Git Bash, where `\` is an escape character.
export const FORWARDER = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "bridge", "forward-hook.sh")).replaceAll("\\", "/");
const isOurs = (h) => typeof h?.command === "string" && h.command.replaceAll("\\", "/").replace(/'$/, "").endsWith("bridge/forward-hook.sh");

/** The forwarder path as one shell word: Claude Code runs hook commands through a shell (Git Bash on Windows). */
export function shellQuote(path) {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function settingsPath(scope, project, home = homedir()) {
  if (scope === "user") return join(home, ".claude", "settings.json");
  if (scope === "project") return join(resolve(project ?? process.cwd()), ".claude", "settings.local.json");
  throw new Error(`--scope must be user or project, not ${scope}`);
}

/** Remove our handlers; drop groups and events that become empty because of it (and only those). */
export function withoutBridge(settings) {
  const next = structuredClone(settings);
  if (!next.hooks || typeof next.hooks !== "object") return next;
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) { kept.push(g); continue; }
      const hooks = g.hooks.filter((h) => !isOurs(h));
      if (hooks.length === g.hooks.length) kept.push(g);
      else if (hooks.length > 0) kept.push({ ...g, hooks });
    }
    if (kept.length > 0) next.hooks[event] = kept;
    else if (groups.length > 0) delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0 && settings.hooks && Object.keys(settings.hooks).length > 0) delete next.hooks;
  return next;
}

/** Idempotent: removes any previous copy of our handlers, then appends one group per event. */
export function withBridge(settings, forwarder = FORWARDER) {
  const next = withoutBridge(settings);
  next.hooks ??= {};
  for (const event of EVENTS) {
    next.hooks[event] = [...(next.hooks[event] ?? []), { hooks: [{ type: "command", command: shellQuote(forwarder), async: true, timeout: 5 }] }];
  }
  return next;
}

export function installedEvents(settings) {
  return Object.entries(settings.hooks ?? {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some((g) => g?.hooks?.some(isOurs)))
    .map(([event]) => event);
}

function indentOf(text) {
  const m = /\n([ \t]+)"/.exec(text);
  return m ? m[1] : 2;
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { scope: { type: "string", default: "user" }, project: { type: "string" }, "dry-run": { type: "boolean", default: false } },
  });
  const action = positionals[0] ?? "status";
  const file = settingsPath(values.scope, values.project);
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  let settings;
  try {
    settings = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    console.error(`${file} is not valid JSON (${e.message}). Nothing changed.`);
    process.exit(1);
  }

  if (action === "status") {
    const events = installedEvents(settings);
    console.log(events.length ? `Installed in ${file} for ${events.length} events.` : `Not installed in ${file}.`);
    if (events.length && events.length < EVENTS.length) console.log(`Missing: ${EVENTS.filter((e) => !events.includes(e)).join(", ")}. Run install again to update.`);
    return;
  }
  if (action !== "install" && action !== "uninstall") {
    console.error(`Unknown action ${action}; use status, install or uninstall.`);
    process.exit(2);
  }
  const next = action === "install" ? withBridge(settings) : withoutBridge(settings);
  const out = JSON.stringify(next, null, indentOf(text)) + "\n";
  if (out === text) {
    console.log(`${file} already up to date.`);
    return;
  }
  if (values["dry-run"]) {
    console.log(out);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  if (text) {
    const backup = `${file}.aaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(file, backup);
    console.log(`Backup: ${backup}`);
  }
  writeFileSync(file, out);
  const others = Object.values(next.hooks ?? {}).flat().flatMap((g) => g?.hooks ?? []).filter((h) => !isOurs(h)).length;
  console.log(action === "install"
    ? `Installed for ${EVENTS.length} events in ${file}. Your ${others} other hook(s) are unchanged.`
    : `Removed from ${file}. Your ${others} other hook(s) are unchanged.`);
  if (action === "install") console.log("New Claude Code sessions pick this up. Start the viewer with: npm run live");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
