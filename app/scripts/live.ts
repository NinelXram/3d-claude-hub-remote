// npm run build:live / npm run start:live: the production app wired to the world server.
// A script rather than `VAR=x next build` so it also runs where npm uses cmd.exe (Windows).
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const mode = process.argv[2];
const env: NodeJS.ProcessEnv = { ...process.env };
let args: string[];
if (mode === "build") {
  // NEXT_PUBLIC_* are baked in at build time.
  env.NEXT_PUBLIC_AGENT_BACKEND = "websocket";
  env.NEXT_PUBLIC_AGENT_WS_URL = "ws://127.0.0.1:8787";
  args = ["build"];
} else if (mode === "start") {
  args = ["start", "-p", process.env.PORT || "3210"];
} else {
  console.error("usage: node scripts/live.ts build|start");
  process.exit(2);
}

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const child = spawn(process.execPath, [next, ...args], { stdio: "inherit", env });
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
