// npm run autostart                 install (Tailscale when this machine is logged in to it, otherwise no tunnel)
// npm run autostart:status | autostart:logs | autostart:off
// Full form: npm run autostart -- [install] [--tunnel auto|tailscale|devtunnel|none] [up flags…]
//            npm run autostart -- status | logs | uninstall
//
// Starts `npm run up` (world server + production app) when you log in, restarts it if it crashes,
// and optionally keeps a tunnel to port 8787 so other devices can open the app:
//   tailscale  `tailscale serve` on https://<this-machine>.<tailnet>.ts.net (only your tailnet's devices);
//              your own Tailscale login needs no token there (--no-trust-tailscale keeps the token for everyone)
//   devtunnel  a persistent Microsoft Dev Tunnel (https://<id>-8787.<region>.devtunnels.ms), private to your account
// macOS uses launchd (~/Library/LaunchAgents); Linux uses systemd --user; Windows uses a hidden launcher in the
// Startup folder that runs scripts/winservice.mjs, which restarts the program after it exits (no admin rights needed).
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { ROOT, bold, dim, green, red, step, tailscaleSelf, tailscaleServe, which, yellow } from "./lib.mjs";

const MAC = platform() === "darwin";
const LINUX = platform() === "linux";
const WINDOWS = platform() === "win32";
const HOME = homedir();
const AAW = join(HOME, ".aaw");
const LOGS = join(AAW, "logs");
const CONFIG = join(AAW, process.env.AAW_LABEL_PREFIX ? "autostart-test.json" : "autostart.json");
const SERVER_PORT = 8787;
// Label prefix, overridable only so the service can be tested beside a real install.
const PREFIX = process.env.AAW_LABEL_PREFIX || "com.aaw";

const argv = process.argv.slice(2);
const ACTIONS = ["install", "uninstall", "off", "status", "logs"];
if (argv[0] && !argv[0].startsWith("-") && !ACTIONS.includes(argv[0])) {
  console.error(red(`✗ Unknown action ${argv[0]}; use install, status, logs or uninstall.`));
  process.exit(1);
}
const action = ACTIONS.includes(argv[0]) ? argv.shift().replace(/^off$/, "uninstall") : "install";
const tunnelIdx = argv.indexOf("--tunnel");
const tunnelArg = tunnelIdx >= 0 ? argv.splice(tunnelIdx, 2)[1] : undefined;
// auto: Tailscale when this machine is logged in to it, otherwise no tunnel.
const tunnel = action === "install" && (tunnelArg ?? "auto") === "auto" ? (tailscaleSelf() ? "tailscale" : "none") : tunnelArg;
const noTrust = argv.includes("--no-trust-tailscale");
const upFlags = argv.filter((a) => a !== "--no-open" && a !== "--no-trust-tailscale");
// Through tailscale serve, your own login stands in for the token (npm run up --trust-tailscale, port 8788).
const trustTailnet = tunnel === "tailscale" && !noTrust;
if (trustTailnet && !upFlags.includes("--trust-tailscale")) upFlags.push("--trust-tailscale");
const TAILNET_PORT = SERVER_PORT + 1;

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
const ok = (r) => r.status === 0;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** launchd and systemd start with a bare PATH: give the services one that finds node, npm and claude. */
function servicePath() {
  const dirs = [dirname(process.execPath), join(HOME, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  for (const bin of ["claude", "tailscale", "devtunnel"]) {
    const p = which(bin);
    if (p) dirs.push(dirname(p));
  }
  return [...new Set(dirs)].join(":");
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The macOS-protected home folder (TCC) a path lives in, if any. */
function macProtectedFolder(path) {
  for (const d of ["Documents", "Desktop", "Downloads", "Library/Mobile Documents"]) {
    if (path === join(HOME, d) || path.startsWith(join(HOME, d) + "/")) return d === "Library/Mobile Documents" ? "iCloud Drive" : d;
  }
  return null;
}

// ───────────────────────── service managers ─────────────────────────

const UID = userInfo().uid;
const agentPath = (label) => join(HOME, "Library", "LaunchAgents", `${label}.plist`);
const unitPath = (name) => join(HOME, ".config", "systemd", "user", `${name}.service`);
const STARTUP = join(process.env.APPDATA || join(HOME, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
const launcherPath = (label) => join(STARTUP, `${label}.vbs`);
const pidPath = (label) => join(AAW, `${label}.pid`);
const winArg = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const vbs = (s) => `"${s.replace(/"/g, '""')}"`;

/** The pid of the running winservice.mjs for a label, or null (checks that the pid is still a node process). */
function winPid(label) {
  let pid;
  try {
    pid = Number(readFileSync(pidPath(label), "utf8").trim());
  } catch {
    return null;
  }
  if (!pid) return null;
  const r = sh("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"]);
  return /^"node(\.exe)?"/i.test(r.stdout?.trim() ?? "") ? pid : null;
}

/** End winservice.mjs and everything it started. */
function winStop(label) {
  const pid = winPid(label);
  if (pid) sh("taskkill", ["/pid", String(pid), "/t", "/f"]);
  rmSync(pidPath(label), { force: true });
}

function installService(name, label, program, log) {
  // Logs hold prompt titles and file names: readable by you only (no effect on Windows, which uses ACLs).
  mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  try {
    chmodSync(LOGS, 0o700);
    if (!existsSync(log)) writeFileSync(log, "", { mode: 0o600 });
    chmodSync(log, 0o600);
  } catch {
    // best effort
  }
  if (MAC) {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${program.map((a) => `\n    <string>${xml(a)}</string>`).join("")}
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(servicePath())}</string>
    <key>HOME</key><string>${xml(HOME)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart after a crash, not after a clean stop. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    mkdirSync(dirname(agentPath(label)), { recursive: true });
    sh("launchctl", ["bootout", `gui/${UID}/${label}`]);
    writeFileSync(agentPath(label), plist);
    const r = sh("launchctl", ["bootstrap", `gui/${UID}`, agentPath(label)]);
    if (!ok(r)) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
  } else if (LINUX) {
    const unit = `[Unit]
Description=3D Claude Hub Remote: ${name}
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
Environment=PATH=${servicePath()}
ExecStart=${program.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ")}
Restart=on-failure
RestartSec=20
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
    mkdirSync(dirname(unitPath(label)), { recursive: true });
    writeFileSync(unitPath(label), unit);
    sh("systemctl", ["--user", "daemon-reload"]);
    const r = sh("systemctl", ["--user", "enable", "--now", `${label}.service`]);
    if (!ok(r)) throw new Error(`systemctl enable failed: ${r.stderr.trim()}`);
    console.log(dim("  To keep it running while you are logged out: loginctl enable-linger"));
  } else if (WINDOWS) {
    // A .vbs in the Startup folder runs at every login without a console window; winservice.mjs does the restarting.
    const cmdline = [process.execPath, join(ROOT, "scripts", "winservice.mjs"), pidPath(label), log, "--", ...program].map(winArg).join(" ");
    const script = [
      `' 3D Claude Hub Remote: ${name}. Written by \`npm run autostart\`; remove it with \`npm run autostart:off\`.`,
      `Set sh = CreateObject("WScript.Shell")`,
      `sh.CurrentDirectory = ${vbs(ROOT)}`,
      `sh.Run ${vbs(cmdline)}, 0, False`,
      "",
    ].join("\r\n");
    winStop(label);
    mkdirSync(STARTUP, { recursive: true });
    // UTF-16 with a BOM, so wscript reads non-ASCII paths correctly.
    writeFileSync(launcherPath(label), "\ufeff" + script, "utf16le");
    const r = sh("wscript.exe", ["//B", "//Nologo", launcherPath(label)]);
    if (!ok(r)) throw new Error(`could not start ${launcherPath(label)}: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
    for (let i = 0; i < 20 && !winPid(label); i++) sleep(250);
    if (!winPid(label)) throw new Error(`${name} did not start; see ${log}`);
  } else {
    throw new Error("Autostart supports macOS (launchd), Linux (systemd --user) and Windows.");
  }
}

function removeService(label) {
  if (MAC) {
    sh("launchctl", ["bootout", `gui/${UID}/${label}`]);
    if (existsSync(agentPath(label))) rmSync(agentPath(label));
  } else if (LINUX) {
    sh("systemctl", ["--user", "disable", "--now", `${label}.service`]);
    if (existsSync(unitPath(label))) rmSync(unitPath(label));
    sh("systemctl", ["--user", "daemon-reload"]);
  } else if (WINDOWS) {
    rmSync(launcherPath(label), { force: true });
    winStop(label);
  }
}

function serviceState(label) {
  if (MAC) {
    const r = sh("launchctl", ["print", `gui/${UID}/${label}`]);
    if (!ok(r)) return "not installed";
    const state = /\n\s*state = (\S+)/.exec(r.stdout)?.[1] ?? "unknown";
    const pid = /\n\s*pid = (\d+)/.exec(r.stdout)?.[1];
    return pid ? `${state} (pid ${pid})` : state;
  }
  if (LINUX) return sh("systemctl", ["--user", "is-active", `${label}.service`]).stdout.trim() || "not installed";
  if (WINDOWS) {
    const pid = winPid(label);
    if (!existsSync(launcherPath(label))) return pid ? `not installed, but running (pid ${pid})` : "not installed";
    return pid ? `running (pid ${pid})` : "installed, not running (starts at next login)";
  }
  return "unsupported";
}

// ───────────────────────── tunnels ─────────────────────────

function removeTailscale() {
  if (!which("tailscale")) return;
  sh("tailscale", ["serve", "--https=443", "off"], { timeout: 15_000 });
  sh("tailscale", ["serve", "--http=80", "off"], { timeout: 15_000 });
}

const TUNNEL_ID = `aaw-${hostname().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}`;

function installDevtunnel() {
  const bin = which("devtunnel");
  if (!bin) throw new Error(`devtunnel is not installed. Install it with ${bold(WINDOWS ? "winget install Microsoft.devtunnel" : "brew install --cask devtunnel")}, log in with ${bold("devtunnel user login")}, then run this again.`);
  if (!ok(sh(bin, ["user", "show"]))) throw new Error(`devtunnel is not logged in. Run ${bold("devtunnel user login")} once, then run this again.`);
  // A persistent tunnel keeps the same URL across restarts. No --allow-anonymous: only your account can open it.
  if (!ok(sh(bin, ["show", TUNNEL_ID]))) {
    const c = sh(bin, ["create", TUNNEL_ID]);
    if (!ok(c)) throw new Error(`devtunnel create failed: ${(c.stderr || c.stdout).trim()}`);
  }
  sh(bin, ["port", "create", TUNNEL_ID, "-p", String(SERVER_PORT)]);
  installService("tunnel", `${PREFIX}.tunnel`, [bin, "host", TUNNEL_ID], join(LOGS, "tunnel.log"));
  const show = sh(bin, ["show", TUNNEL_ID]).stdout;
  return /https:\/\/\S+devtunnels\.ms\S*/.exec(show)?.[0] ?? `(run: devtunnel show ${TUNNEL_ID})`;
}

function removeDevtunnel() {
  removeService(`${PREFIX}.tunnel`);
}

// ───────────────────────── actions ─────────────────────────

const readConfig = () => (existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : null);

function token() {
  try {
    return readFileSync(join(AAW, "token"), "utf8").trim();
  } catch {
    return null;
  }
}

try {
  if (action === "install") {
    const kind = tunnel;
    if (!["tailscale", "devtunnel", "none"].includes(kind)) throw new Error("--tunnel must be auto, tailscale, devtunnel or none");
    if (!tunnelArg) console.log(dim(kind === "tailscale" ? "Tailscale is logged in here: other devices on your tailnet will reach it." : "Tailscale is not logged in here: no tunnel (this machine only)."));
    if (!existsSync(join(ROOT, "app", "node_modules"))) throw new Error(`Run ${bold("npm run setup")} first.`);

    const protectedDir = MAC ? macProtectedFolder(ROOT) : null;
    if (protectedDir) {
      console.log(yellow(`\n! This repo is inside ~/${protectedDir}, which macOS keeps from background services until you allow it.`));
      console.log(`  When macOS asks whether ${bold("node")} may access your ${protectedDir} folder, choose ${bold("Allow")}. If you missed it:`);
      console.log(`  System Settings → Privacy & Security → Files and Folders → node → turn on ${protectedDir}`);
      console.log(dim(`  (node is ${process.execPath}). Or move the repo to a folder such as ~/Code and run setup there.`));
    }

    step("Starting npm run up at login");
    const log = join(LOGS, "up.log");
    const before = existsSync(log) ? statSync(log).size : 0;
    installService("up", `${PREFIX}.up`, [process.execPath, join(ROOT, "scripts", "up.mjs"), "--no-open", ...upFlags], log);
    console.log(green(`  ✓ installed; log: ${log}`));
    // up writes a line as soon as it starts; silence means it is stuck before running any code.
    let started = false;
    for (let i = 0; i < 30 && !started; i++) {
      sleep(500);
      started = existsSync(log) && statSync(log).size > before;
    }
    if (!started) {
      console.log(yellow("  ! The service has not written anything yet."));
      if (protectedDir) console.log(yellow(`    It is most likely waiting for the macOS permission above (${protectedDir} folder). Allow it and it carries on.`));
      else console.log(yellow(`    Check ${bold("npm run autostart:logs")} in a minute.`));
    }

    let url = null;
    if (kind === "tailscale") {
      step(`Serving port ${trustTailnet ? TAILNET_PORT : SERVER_PORT} on your tailnet (tailscale serve)`);
      url = tailscaleServe(trustTailnet ? TAILNET_PORT : SERVER_PORT);
    } else if (kind === "devtunnel") {
      step(`Keeping Dev Tunnel ${TUNNEL_ID} up`);
      url = installDevtunnel();
    }
    writeFileSync(CONFIG, JSON.stringify({ tunnel: kind, upFlags, installedAt: new Date().toISOString() }, null, 2) + "\n");

    const t = token();
    console.log(`\n${green("✓ Autostart is on.")} It runs now and at every login.`);
    console.log(`  On this machine: ${bold(`http://localhost:3210/${t ? `#token=${t}` : ""}`)}`);
    if (url) console.log(`  Other devices:   ${bold(`${url.replace(/\/?$/, "/")}${t && !trustTailnet ? `#token=${t}` : ""}`)}`);
    if (kind === "tailscale") {
      console.log(dim("  Only devices signed in to your tailnet can reach it."));
      console.log(dim(trustTailnet ? "  Signed in as you, no token is needed there; other logins still need it." : "  The token is still required."));
    }
    console.log(dim("  If ports 8787/3210 are busy (a manual `npm run up`), the service waits and retries every 20 s."));
  } else if (action === "uninstall") {
    const cfg = readConfig();
    removeService(`${PREFIX}.up`);
    if (cfg?.tunnel === "tailscale" || tunnel === "tailscale") removeTailscale();
    if (cfg?.tunnel === "devtunnel" || tunnel === "devtunnel") removeDevtunnel();
    if (existsSync(CONFIG)) rmSync(CONFIG);
    console.log(green("✓ Autostart is off."), dim("Hooks and the token are left as they are."));
  } else if (action === "status") {
    const cfg = readConfig();
    console.log(`${bold("app + server")}  ${serviceState(`${PREFIX}.up`)}`);
    console.log(`${bold("tunnel")}        ${cfg?.tunnel ?? "none"}${cfg?.tunnel === "devtunnel" ? `  ${serviceState(`${PREFIX}.tunnel`)}` : ""}`);
    if (cfg?.tunnel === "tailscale") console.log(dim(`              ${sh("tailscale", ["serve", "status"]).stdout.trim().split("\n")[0] || "no serve config"}`));
    console.log(dim(`logs          ${LOGS}`));
  } else if (action === "logs") {
    const file = join(LOGS, "up.log");
    if (!existsSync(file)) throw new Error(`No log yet at ${file}.`);
    // The last 64 KB is plenty for 60 lines.
    const size = statSync(file).size;
    const buf = Buffer.alloc(Math.min(size, 65536));
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, buf.length, size - buf.length);
    closeSync(fd);
    console.log(buf.toString("utf8").split(/\r?\n/).slice(-61).join("\n"));
  } else {
    throw new Error(`Unknown action ${action}; use install, uninstall, status or logs.`);
  }
} catch (e) {
  console.error(red(`✗ ${e instanceof Error ? e.message : String(e)}`));
  if (action === "install") console.error(yellow("  Fix the above and run install again (it replaces what was installed), or run uninstall."));
  process.exit(1);
}
