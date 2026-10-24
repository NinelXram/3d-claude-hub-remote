// npm run live: everything for daily personal use in one command.
//   builds the viewer if needed, starts the live server, records to ~/.aaw/sessions/<date>.jsonl,
//   and opens the viewer in your browser. Ctrl+C stops it.
//
//   npm run live -- --no-record      do not record
//   npm run live -- --no-open        do not open a browser
//   npm run live -- --port 8788      any other flag is passed to the server
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const record = !args.includes("--no-record");
const open = !args.includes("--no-open");
const pass = args.filter((a) => a !== "--no-record" && a !== "--no-open");

if (!existsSync(join(root, "viewer", "dist", "fragment.html"))) {
  console.log("Building the viewer…");
  const b = spawnSync(process.execPath, [join(root, "scripts", "build-viewer.mjs")], { stdio: "inherit" });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

const serverArgs = ["--experimental-strip-types", "--no-warnings", join(root, "server", "main.ts"), "--source", "claude-code", ...pass];
if (record) {
  const dir = join(homedir(), ".aaw", "sessions");
  mkdirSync(dir, { recursive: true });
  serverArgs.push("--record", join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`));
}

const server = spawn(process.execPath, serverArgs, { stdio: ["inherit", "pipe", "inherit"] });
let opened = false;
server.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  const url = /viewer\s+(http:\/\/\S+)/.exec(String(chunk))?.[1];
  if (url && open && !opened) {
    opened = true;
    const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: platform() === "win32" }).unref();
  }
});
server.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
