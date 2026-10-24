// The four clips: where each starts, what happens on camera, how long it must be.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { STAGE_TOKEN } from "../stage/server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface ClipSpec {
  name: string;
  mode: "sim" | "live";
  minSeconds: number;
  phone?: boolean;
  path: string;
  /** Before recording: wait until the scene is ready. */
  prepare(page: Page): Promise<void>;
  /** What happens on camera. `mark` notes when something happens (seconds into the clip), for the sound effects. */
  act(page: Page, mark: (name: string) => void): Promise<void>;
}

/** Typed into the phone's composer; the key sounds follow it (one key every TYPE_DELAY_MS). */
export const PHONE_PROMPT = "Lỗi trong ảnh này là gì vậy?";
export const TYPE_DELAY_MS = 70;

const camera = async (page: Page, preset: string, mark?: (name: string) => void) => {
  mark?.(`camera:${preset}`);
  await page.getByRole("toolbar", { name: "Camera presets" }).getByRole("button", { name: preset }).first().click();
};
const waitForWorld = async (page: Page) => {
  await page.locator("canvas").first().waitFor({ state: "visible", timeout: 60_000 });
  await sleep(3000);
};

export const SPECS: ClipSpec[] = [
  {
    name: "office-demo",
    mode: "sim",
    minSeconds: 32,
    path: "/?autodemo=1&quality=high",
    prepare: waitForWorld,
    act: async (page, mark) => {
      await camera(page, "Overview", mark);
      await sleep(11_000);
      await camera(page, "Development", mark);
      await sleep(11_000);
      await camera(page, "Collaboration", mark);
      await sleep(11_000);
    },
  },
  {
    name: "office-sprint",
    mode: "sim",
    minSeconds: 10,
    path: "/?autosprint&quality=high",
    prepare: async (page) => {
      await waitForWorld(page);
      await sleep(3000);
    },
    act: async () => {
      await sleep(11_000);
    },
  },
  {
    name: "sessions-desktop",
    mode: "live",
    minSeconds: 20,
    path: `/?token=${STAGE_TOKEN}&tab=sessions&quality=high`,
    prepare: async (page) => {
      await waitForWorld(page);
      await page.getByRole("list", { name: "Sessions" }).waitFor({ timeout: 30_000 });
    },
    act: async (page, mark) => {
      await sleep(5000);
      const rows = page.getByRole("list", { name: "Sessions" }).locator("li");
      mark("open:shop-api");
      await rows.filter({ hasText: "shop-api" }).first().click();
      await sleep(7000);
      mark("back");
      await page.getByRole("button", { name: "Back" }).first().click();
      await sleep(1500);
      mark("open:web-dashboard");
      await rows.filter({ hasText: "web-dashboard" }).first().click();
      await sleep(7000);
    },
  },
  {
    name: "phone-remote",
    mode: "live",
    minSeconds: 22,
    phone: true,
    path: `/?token=${STAGE_TOKEN}&tab=sessions&quality=high`,
    prepare: async (page) => {
      await waitForWorld(page);
      await page.getByRole("list", { name: "Sessions" }).waitFor({ timeout: 30_000 });
    },
    act: async (page, mark) => {
      await sleep(2500);
      mark("open");
      await page.getByRole("list", { name: "Sessions" }).locator("li").filter({ hasText: "shop-api" }).first().click();
      await sleep(3000);
      mark("attach");
      await page.locator('input[type="file"]').first().setInputFiles(join(here, "..", "stage", "assets", "screenshot.png"));
      await sleep(1200);
      mark("type");
      await page.getByRole("textbox", { name: "Prompt" }).pressSequentially(PHONE_PROMPT, { delay: TYPE_DELAY_MS });
      await sleep(800);
      mark("send");
      await page.getByRole("button", { name: /send/i }).or(page.locator('button[title="Send (Enter)"]')).first().click();
      const allow = page.getByRole("button", { name: "Allow" }).first();
      await allow.waitFor({ timeout: 30_000 });
      mark("ask");
      await sleep(2500);
      mark("allow");
      await allow.click();
      await page.getByText("6/6 pass").first().waitFor({ timeout: 30_000 });
      mark("reply");
      await sleep(6000);
    },
  },
];
