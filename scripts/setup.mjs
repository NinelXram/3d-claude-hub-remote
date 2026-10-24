// npm run setup [-- --no-hooks] [-- --skip-build]
// One-time setup on a machine: checks, dependencies for the server and the app, Claude Code hooks, production build.
// Safe to run again after `git pull`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { APP, ENGINE, NPM, bold, green, nodeVersionOk, red, run, step, which, yellow } from "./lib.mjs";

const args = new Set(process.argv.slice(2));

step("Checking this machine");
if (!nodeVersionOk()) {
  console.error(red(`  ✗ Node ${process.versions.node} is too old. Install Node 22.6 or newer (https://nodejs.org) and run this again.`));
  process.exit(1);
}
console.log(green(`  ✓ Node ${process.versions.node}`));
const claude = which("claude");
if (claude) console.log(green(`  ✓ Claude Code at ${claude}`));
else console.log(yellow("  ! Claude Code (`claude`) is not on PATH. The 3D world still runs, but there will be no live sessions until you install it and log in."));

step("Installing dependencies");
const install = (dir) => run(NPM, [existsSync(join(dir, "package-lock.json")) ? "ci" : "install", "--no-audit", "--no-fund"], dir);
install(ENGINE);
install(APP);

if (args.has("--no-hooks")) {
  step("Skipping Claude Code hooks (--no-hooks)");
} else {
  step("Installing Claude Code hooks (~/.claude/settings.json; other hooks are kept, the file is backed up)");
  run(NPM, ["run", "-s", "bridge", "--", "install"], ENGINE);
}

if (args.has("--skip-build")) {
  step("Skipping the production build (--skip-build)");
} else {
  step("Building the app for production");
  run(NPM, ["run", "-s", "build:live"], APP);
}

console.log(`\n${green("✓ Setup done.")} Start everything with ${bold("npm run up")}.`);
console.log("  New Claude Code sessions on this machine will show up in the 3D office.");
console.log(`  On your other devices through Tailscale: ${bold("npm run up:tailscale")}. Start it at every login instead: ${bold("npm run autostart")}`);
console.log(`  Remove the hooks any time with: ${bold("npm run hooks:remove")}`);
