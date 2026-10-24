import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// npm run e2e: loads the app, runs the demo at 4×, waits for the Completed metric to increment, exercises
// pause / resume / reset, checks sound unlocks on the first gesture, and fails on any console error.
// Screenshots land in test-results/.

/** R3F 9.8 constructs a THREE.Clock, which three r186 deprecates; it is an upstream warning, not ours. */
const KNOWN_NOISE = [/THREE\.Clock: This module has been deprecated/];

const metric = (page: Page, name: string) => page.getByTestId(`metric-${name}`).getByTestId("metric-value");
const status = (page: Page) => page.getByTestId("sim-status");
const topBar = (page: Page) => page.getByRole("banner", { name: "Top bar" });
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/smoke-${name}.png` });

test("demo at 4×: completes, pauses, resumes, resets, with sound and no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!KNOWN_NOISE.some((re) => re.test(text))) errors.push(`console.error: ${text}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  // 1. Load. The loading screen leaves once the scene has rendered; the world auto-starts.
  await page.goto("/");
  await expect(page.getByTestId("loading-screen")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId("mode-line")).toHaveText("Simulation mode · no live inference");
  await expect(status(page)).toHaveText("Running");
  // No AudioContext exists before a gesture (pitfall 5).
  await expect(page.locator("html")).toHaveAttribute("data-audio", "none");
  await expect(metric(page, "completed")).toHaveText("0");
  await shot(page, "1-loaded");

  // 2. Run the demo at 4×. The first click is also the gesture that unlocks audio.
  await topBar(page).getByRole("group", { name: "Simulation speed" }).getByRole("button", { name: "4×" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-audio", "running");
  await expect(page.locator("html")).toHaveAttribute("data-ambient", "true"); // the office hum while running
  await topBar(page).getByRole("button", { name: "Run demo" }).click();
  await expect(page.getByTestId("task-card").first()).toBeVisible();
  await expect(metric(page, "pending")).toHaveText("1");

  // 3. Pause and resume mid-run: the task's progress holds still while paused and moves again after.
  const progress = async () => Number(await page.getByTestId("task-card").first().getByRole("progressbar").getAttribute("aria-valuenow"));
  await expect.poll(progress, { timeout: 30_000 }).toBeGreaterThan(5);
  await topBar(page).getByRole("button", { name: "Pause", exact: true }).click();
  await expect(status(page)).toHaveText("Paused");
  await expect(page.locator("html")).toHaveAttribute("data-ambient", "false");
  await page.waitForTimeout(500); // let the throttled mirror flush
  const paused = await progress();
  await shot(page, "2-paused");
  await page.waitForTimeout(2_000);
  expect(await progress()).toBe(paused);
  await topBar(page).getByRole("button", { name: "Resume", exact: true }).click();
  await expect(status(page)).toHaveText("Running");
  await expect.poll(progress, { timeout: 30_000 }).toBeGreaterThan(paused);

  // 4. The Completed metric increments when T-001 ships (~73 sim s ≈ 18 s at 4×; slower under SwiftShader).
  await page.waitForTimeout(4_000);
  await shot(page, "3-running");
  await expect(metric(page, "completed")).toHaveText("1", { timeout: 120_000 });
  await expect(metric(page, "pending")).toHaveText("0");
  await shot(page, "4-completed");
  // Cues fired after the unlock (count kept on <html data-sound-played>).
  const played = Number(await page.locator("html").getAttribute("data-sound-played"));
  expect(played).toBeGreaterThan(10);

  // 5. Reset (two-step confirm): no tasks, Ready, Completed back to 0.
  await topBar(page).getByRole("button", { name: "Reset", exact: true }).click();
  await topBar(page).getByRole("button", { name: "Confirm reset" }).click();
  await expect(status(page)).toHaveText("Ready");
  await expect(metric(page, "completed")).toHaveText("0");
  await expect(page.getByTestId("task-card")).toHaveCount(0);
  await shot(page, "5-reset");

  expect(errors, errors.join("\n")).toEqual([]);
});
