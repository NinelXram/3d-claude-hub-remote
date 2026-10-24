// Installer checks (npm run test:install): runs the real CLI against throwaway settings files.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENTS, FORWARDER, installedEvents, withBridge, withoutBridge } from "./bridge-install.mjs";

const cli = join(dirname(fileURLToPath(import.meta.url)), "bridge-install.mjs");
let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const run = (args, home) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } }); // USERPROFILE: homedir() on Windows

console.log("\nHook installer");

// Shaped like a real settings file that already has other tools' hooks and settings.
const existing = {
  env: { FOO: "1" },
  hooks: {
    PreToolUse: [{ matcher: "Grep|Glob", hooks: [{ type: "command", command: "$HOME/.claude/hooks/other-gate" }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "$HOME/.claude/hooks/other-reminder" }] }],
  },
  model: "opus",
  permissions: { allow: ["Bash(ls:*)"] },
};
const home = mkdtempSync(join(tmpdir(), "aaw-home-"));
const file = join(home, ".claude", "settings.json");
mkdirSync(dirname(file), { recursive: true });
const original = JSON.stringify(existing, null, 2) + "\n";
writeFileSync(file, original);

let r = run(["install"], home);
const once = JSON.parse(readFileSync(file, "utf8"));
check("install exits 0 and reports the other hooks as unchanged", r.status === 0 && r.stdout.includes("2 other hook(s) are unchanged"), r.stdout + r.stderr);
check(`install covers all ${EVENTS.length} events`, installedEvents(once).length === EVENTS.length);
check("other hooks keep their place and content", JSON.stringify(once.hooks.PreToolUse[0]) === JSON.stringify(existing.hooks.PreToolUse[0]) && JSON.stringify(once.hooks.SessionStart[0]) === JSON.stringify(existing.hooks.SessionStart[0]));
check("other settings are untouched", JSON.stringify([once.env, once.model, once.permissions]) === JSON.stringify([existing.env, existing.model, existing.permissions]));
check("every added handler is async and points at forward-hook.sh", Object.values(once.hooks).flat().flatMap((g) => g.hooks).filter((h) => h.command.endsWith("forward-hook.sh")).every((h) => h.async === true && h.type === "command"));
check("a backup of the previous file is written", readdirSync(dirname(file)).some((f) => f.startsWith("settings.json.aaw-backup-")));

r = run(["install"], home);
const twice = JSON.parse(readFileSync(file, "utf8"));
check("installing twice changes nothing", r.stdout.includes("already up to date") && JSON.stringify(twice) === JSON.stringify(once), r.stdout);

r = run(["uninstall"], home);
check("uninstall restores the original file byte for byte", r.status === 0 && readFileSync(file, "utf8") === original);

// Fresh machine: no settings file yet.
const empty = mkdtempSync(join(tmpdir(), "aaw-home-"));
r = run(["install"], empty);
const created = JSON.parse(readFileSync(join(empty, ".claude", "settings.json"), "utf8"));
check("install creates the settings file when there is none", r.status === 0 && installedEvents(created).length === EVENTS.length);
run(["uninstall"], empty);
check("…and uninstall leaves it empty again", readFileSync(join(empty, ".claude", "settings.json"), "utf8") === "{}\n");

// Project scope and a broken file.
const project = mkdtempSync(join(tmpdir(), "aaw-proj-"));
r = run(["install", "--scope", "project", "--project", project], home);
check("project scope writes .claude/settings.local.json", r.status === 0 && installedEvents(JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"))).length === EVENTS.length);
check("the hook command uses forward slashes (Git Bash runs it on Windows)", !FORWARDER.includes("\\"));
const spaced = withBridge({}, "/Users/a b/it's here/bridge/forward-hook.sh").hooks.Stop[0].hooks[0].command;
check("the command is quoted, so a repo path with spaces or quotes still runs", spaced === "'/Users/a b/it'\\''s here/bridge/forward-hook.sh'", spaced);
check("a quoted install is recognised as ours", installedEvents(withBridge({}, "/Users/a b/bridge/forward-hook.sh")).length === EVENTS.length);
const winInstall = { hooks: { Stop: [{ hooks: [{ type: "command", command: "C:\\aaw\\bridge\\forward-hook.sh" }] }] } };
check("a backslash install from before is recognised and replaced", installedEvents(winInstall).length === 1 && withBridge(winInstall).hooks.Stop.length === 1 && !withoutBridge(winInstall).hooks);
writeFileSync(file, "{ not json");
r = run(["install"], home);
check("an unreadable settings file is reported and left alone", r.status === 1 && readFileSync(file, "utf8") === "{ not json");

console.log(failures === 0 ? "\nAll installer checks passed." : `\n${failures} installer check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
