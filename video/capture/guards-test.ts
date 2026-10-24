// assertClean must refuse every kind of leak and every wrong mode label, and pass a clean page.
import { homedir, hostname, userInfo } from "node:os";
import { chromium } from "@playwright/test";
import { assertClean } from "./guards.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
const SIM = "Simulation mode · no live inference";
const LIVE = "Live · Claude Code · mirror + control";
const load = async (body: string, hash = "") => page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(`<body>${body}</body>`)}${hash}`);
async function throws(mode: "sim" | "live"): Promise<string> {
  try {
    await assertClean(page, mode);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
}

await load(`<p>${SIM}</p><p>Kai is building</p>`);
check("a clean sim page passes", (await throws("sim")) === "");
await load(`<p>${LIVE}</p><p>C:/demo/shop-api</p>`);
check("a clean live page passes", (await throws("live")) === "");

await load(`<p>Simulation · no inference</p>`);
check("the phone's short sim label passes", (await throws("sim")) === "");
await load(`<p>Live · Claude Code · control</p>`);
{ const e = await throws("live"); check("the phone's short live label passes", e === "", e); }
await load(`<p>AI Agent World</p><ul aria-label="Sessions"><li>shop-api</li></ul>`);
check("a phone page with the Sessions list (live only) passes as live", (await throws("live")) === "");
await load(`<p>AI Agent World</p><form aria-label="Send a prompt"><textarea></textarea></form>`);
check("a phone chat view (prompt composer, live only) passes as live", (await throws("live")) === "");
await load(`<p>Live · Claude Code · read-only</p>`);
check("a read-only live page is refused (control must be on)", (await throws("live")) !== "");

const leaks: [string, string][] = [
  ["home dir", homedir()],
  ["home dir with forward slashes", homedir().replaceAll("\\", "/")],
  ["username", `/Users/${userInfo().username}/x`],
  ["hostname", hostname()],
  ["stage token", "video-demo-token"],
];
for (const [name, value] of leaks) {
  await load(`<p>${LIVE}</p><p>${value}</p>`);
  const err = await throws("live");
  check(`refuses a page showing the ${name}`, err !== "", err);
}

await load(`<p>${LIVE}</p>`);
check("refuses a live page when sim is expected", (await throws("sim")) !== "");
await load(`<p>${SIM}</p>`);
check("refuses a sim page when live is expected", (await throws("live")) !== "");
await load(`<p>${LIVE}</p><p>Simulation</p>`);
check("refuses a live page that mentions Simulation anywhere", (await throws("live")) !== "");
await load(`<p>${LIVE}</p>`, "#?token=abc");
check("refuses a page whose URL still carries token=", (await throws("live")) !== "");

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
