// Refuses to record a frame that could leak this machine's identity or show the wrong mode label.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { STAGE_TOKEN } from "../stage/server.ts";

function secrets(): [string, string][] {
  const list: [string, string][] = [
    ["home dir", homedir()],
    ["home dir", homedir().replaceAll("\\", "/")],
    ["username", userInfo().username],
    ["hostname", hostname()],
    ["stage token", STAGE_TOKEN],
  ];
  const tokenFile = join(homedir(), ".aaw", "token");
  if (existsSync(tokenFile)) list.push(["real token", readFileSync(tokenFile, "utf8").trim()]);
  return list.filter(([, v]) => v.length >= 3);
}

export async function assertClean(page: Page, mode: "sim" | "live"): Promise<void> {
  const text = await page.evaluate(() => document.body.innerText);
  const lower = text.toLowerCase();
  for (const [name, value] of secrets()) {
    if (lower.includes(value.toLowerCase())) throw new Error(`leak: the page shows the ${name}`);
  }
  if (page.url().includes("token=")) throw new Error("leak: the URL still carries token=");
  // Desktop and phone layouts word the top bar differently (backendCaps.ts: modeLine / shortModeLine).
  if (mode === "sim" && !/Simulation mode · no live inference|Simulation · no inference/.test(text)) throw new Error("sim clip without the Simulation mode label");
  if (mode === "live") {
    // The phone's top bar shows the followed session instead of the mode; the Sessions list and the prompt
    // composer exist only in live mode.
    const liveOnlyUi = (await page.locator('[aria-label="Sessions"], [aria-label="Send a prompt"]').count()) > 0;
    if (!/· mirror \+ control|· control\b/.test(text) && !liveOnlyUi) throw new Error("live clip without the control label or the Sessions UI");
    if (/simulation/i.test(text)) throw new Error("live clip mentions Simulation");
  }
}
