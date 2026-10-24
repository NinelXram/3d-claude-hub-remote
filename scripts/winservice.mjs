// Windows stand-in for launchd/systemd, used by `npm run autostart` (not meant to be run by hand):
//   node scripts/winservice.mjs <pidfile> <log> -- <program> [args…]
// Runs the program with its output appended to <log> and starts it again 20 s after it exits.
// Its pid goes to <pidfile>, so `autostart uninstall` can end it together with everything it started.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ROOT } from "./lib.mjs";

const [pidFile, log, sep, cmd, ...args] = process.argv.slice(2);
if (!pidFile || !log || sep !== "--" || !cmd) {
  console.error("usage: node scripts/winservice.mjs <pidfile> <log> -- <program> [args…]");
  process.exit(2);
}
const RESTART_MS = 20_000;

writeFileSync(pidFile, String(process.pid));
// Remove the pid file only while it is still ours (a reinstall may already have written a new one).
const cleanup = () => {
  try {
    if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) rmSync(pidFile);
  } catch {}
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => process.exit(0));

const note = (msg) => appendFileSync(log, `[autostart ${new Date().toISOString()}] ${msg}\n`);

function start() {
  const fd = openSync(log, "a", 0o600);
  const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", fd, fd], windowsHide: true });
  closeSync(fd);
  let ended = false;
  const again = (why) => {
    if (ended) return;
    ended = true;
    note(`${why}; starting it again in ${RESTART_MS / 1000} s`);
    setTimeout(start, RESTART_MS);
  };
  child.on("error", (e) => again(`could not start ${cmd}: ${e.message}`));
  child.on("close", (code, signal) => again(`${cmd} exited (${code ?? signal})`));
}

note(`starting ${[cmd, ...args].join(" ")}`);
start();
