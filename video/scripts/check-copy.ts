// Checks the on-screen copy and the timeline against the spec. Plain Node, exits 1 on any ✗.
import { copy } from "../src/copy.vi.ts";
import { FPS, TOTAL_FRAMES, scenes, lineWindows } from "../src/timeline.ts";
import type { SceneId } from "../src/copy.vi.ts";

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `  (${detail})` : ""}`);
  }
}

const ORDER: SceneId[] = ["hook", "credit", "office", "sessions", "remote", "outro"];
const SPEC_START_S = [0, 8, 16, 40, 58, 78];

const total = TOTAL_FRAMES / FPS;
check("total duration is 85–95 s", total >= 85 && total <= 95, `${total.toFixed(1)} s`);
check("FPS is 30", FPS === 30);

check("scenes are in spec order", scenes.map((s) => s.id).join() === ORDER.join(), scenes.map((s) => s.id).join());
let cursor = 0;
let contiguous = true;
for (const s of scenes) {
  if (s.from !== cursor) contiguous = false;
  cursor = s.from + s.durationInFrames;
}
check("scenes are contiguous from frame 0 and end at TOTAL_FRAMES", contiguous && cursor === TOTAL_FRAMES, `end ${cursor}`);
scenes.forEach((s, i) => {
  const start = s.from / FPS;
  const want = SPEC_START_S[i] ?? 0;
  check(`${s.id} starts within ±2 s of ${want} s`, Math.abs(start - want) <= 2, `${start.toFixed(1)} s`);
});

for (const s of scenes) {
  const windows = lineWindows(s.id);
  check(`${s.id}: every line has a window`, windows.length === copy[s.id].lines.length);
  for (const w of windows) {
    const need = Math.max(1.5, w.text.length / 14);
    const have = w.durationInFrames / FPS;
    check(`${s.id}: readable "${w.text.slice(0, 40)}"`, have >= need, `${have.toFixed(1)} s < ${need.toFixed(1)} s`);
    check(`${s.id}: window inside scene "${w.text.slice(0, 30)}"`, w.from >= 0 && w.from + w.durationInFrames <= s.durationInFrames);
  }
}

const allLines = ORDER.flatMap((id) => copy[id].lines);
const joined = allLines.join("\n");
check("display name present", joined.includes("3D Claude Hub Remote"));
check("repo link present", joined.includes("github.com/NinelXram/3d-claude-hub-remote"));
check("credit scene names Mr Luc and his repo", copy.credit.lines.join(" ").includes("Mr Luc") && copy.credit.lines.join(" ").includes("lucwj/ai-agent-3d-prompts"));
check("the outro has no thanks (credit stays at 0:08 only)", !/Mr Luc|lucwj|Cảm ơn/i.test(copy.outro.lines.join(" ")), copy.outro.lines.join(" | "));
for (const line of allLines) {
  if (/claude desktop|remote control/i.test(line)) check(`shared-account condition: "${line}"`, /chung account|account chung/i.test(line));
  check(`no absolute "only you" claim: "${line.slice(0, 40)}"`, !/chỉ (mình|tài khoản của) bạn/i.test(line));
}
check("remote scene mentions the token for others", copy.remote.lines.some((l) => /token/i.test(l)));
check("meta matches the spec", copy.meta.name === "3D Claude Hub Remote" && copy.meta.repo === "github.com/NinelXram/3d-claude-hub-remote" && copy.meta.credit === "Mr Luc" && copy.meta.creditRepo === "github.com/lucwj/ai-agent-3d-prompts");

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
