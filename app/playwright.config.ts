import { defineConfig } from "@playwright/test";

// Smoke test against a production build (`next build` + `next start`), not `next dev`: it is what users run,
// and dev mode's StrictMode double-mount and on-demand compilation make timings noisy.
// The port defaults to 3150 so it never collides with `npm run dev` (3000) or the example server (8787).
const PORT = Number(process.env.E2E_PORT ?? 3150);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results/artifacts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    // System Google Chrome: no Playwright browser download needed. Set PW_CHROMIUM=1 to use the bundled
    // Chromium instead (after `npx playwright install chromium`).
    ...(process.env.PW_CHROMIUM ? {} : { channel: "chrome" }),
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=user-gesture-required"] },
  },
  webServer: {
    // E2E_SKIP_BUILD=1 reuses an existing .next build.
    command: `${process.env.E2E_SKIP_BUILD ? "" : "npm run build && "}npx next start -p ${PORT} -H 127.0.0.1`,
    url: BASE_URL,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "ignore",
    stderr: "pipe",
    // The smoke test drives the local simulation; never inherit a websocket backend from the shell.
    env: { NEXT_PUBLIC_AGENT_BACKEND: "mock" },
  },
});
