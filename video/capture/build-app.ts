// Builds and serves copies of app/ under video/.stage, so app/.next (used by `npm run up`) is never touched.
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const APP = join(REPO, "app");
const STAGE = join(here, "..", ".stage");

export type AppMode = "sim" | "live";
const ENV: Record<AppMode, Record<string, string>> = {
  sim: { NEXT_PUBLIC_AGENT_BACKEND: "mock" },
  live: { NEXT_PUBLIC_AGENT_BACKEND: "websocket", NEXT_PUBLIC_AGENT_WS_URL: "ws://127.0.0.1:8797" },
};

export function appDir(mode: AppMode): string {
  return join(STAGE, `app-${mode}`);
}

/** Copy the app's sources, link its node_modules, and `next build` with this mode's env. `reuse` skips an existing build. */
export function buildApp(mode: AppMode, reuse = false): string {
  const dir = appDir(mode);
  if (reuse && existsSync(join(dir, ".next", "BUILD_ID"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const f of ["src", "public", "package.json", "tsconfig.json", "next.config.ts", "postcss.config.mjs", "next-env.d.ts"]) {
    if (existsSync(join(APP, f))) cpSync(join(APP, f), join(dir, f), { recursive: true });
  }
  symlinkSync(join(APP, "node_modules"), join(dir, "node_modules"), "junction");
  // Turbopack only compiles files under its root; node_modules is a junction into app/, so the root is the repo.
  const config = readFileSync(join(dir, "next.config.ts"), "utf8").replace(
    "const nextConfig: NextConfig = {",
    `const nextConfig: NextConfig = {\n  turbopack: { root: ${JSON.stringify(REPO.replaceAll("\\", "/"))} },`,
  );
  writeFileSync(join(dir, "next.config.ts"), config);
  const r = spawnSync(process.execPath, [join(dir, "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: dir,
    env: { ...process.env, ...ENV[mode] },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`next build (${mode}) failed:\n${(r.stdout + r.stderr).slice(-3000)}`);
  return dir;
}

/** `next start` on a port; resolves once the page answers. */
export async function startApp(mode: AppMode, port: number): Promise<{ url: string; stop(): void }> {
  const dir = appDir(mode);
  const child: ChildProcess = spawn(process.execPath, [join(dir, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: dir,
    stdio: "ignore",
  });
  const url = `http://localhost:${port}`;
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return { url, stop: () => child.kill() };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`next start (${mode}) did not answer on ${url}`);
}
