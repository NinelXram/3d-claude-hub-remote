// Checks where the sound effects land: in the video, on the right clip moments, in a sensible order, and that the
// recorded marks (src/clipMarks.json) put every phone event inside the scene that shows it.
import marksJson from "../src/clipMarks.json" with { type: "json" };
import { SFX_NAMES, frameOfClipTime, sfxCues } from "../src/sound.ts";
import type { ClipMarks } from "../src/sound.ts";
import { FPS, TOTAL_FRAMES, sceneById, scenes } from "../src/timeline.ts";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("Placement (example marks)");
const marks: ClipMarks = {
  "phone-remote": { open: 2.5, attach: 5.6, type: 6.9, send: 9.8, ask: 13.9, allow: 16.4, reply: 19.2 },
  "sessions-desktop": { "open:shop-api": 5, back: 12, "open:web-dashboard": 13.5 },
  "office-demo": { "camera:Overview": 0, "camera:Development": 11, "camera:Collaboration": 22 },
};
const cues = sfxCues(marks);
const of = (sfx: string) => cues.filter((c) => c.sfx === sfx);
check("every cue is inside the video", cues.every((c) => c.frame >= 0 && c.frame < TOTAL_FRAMES));
check("every cue uses a sound that exists", cues.every((c) => (SFX_NAMES as readonly string[]).includes(c.sfx)));
check("a whoosh before each scene change", of("whoosh").length === scenes.length - 1);
check("one key sound per typed character", of("key").length === "Lỗi trong ảnh này là gì vậy?".length, String(of("key").length));
const remote = sceneById("remote");
check("a phone moment maps into the remote scene (clip 4 s = scene start)", frameOfClipTime("phone-remote", 4) === remote.from && frameOfClipTime("phone-remote", 10) === remote.from + 6 * FPS);
check("a moment the video does not use makes no sound", frameOfClipTime("phone-remote", 1) === null && frameOfClipTime("phone-remote", 25) === null);
const alert = of("alert")[0]?.frame ?? -1;
const allowClick = remote.from + Math.round((16.4 - 4) * FPS);
const chime = of("chime")[0]?.frame ?? -1;
check("the ask rings, then Allow clicks, then the reply chimes", alert > 0 && alert < allowClick && allowClick < chime && cues.some((c) => c.sfx === "click" && c.frame === allowClick));
check("the office camera clicks land in the office scene", of("click").filter((c) => c.frame >= sceneById("office").from && c.frame < sceneById("sessions").from).length === 2);

console.log("Recorded marks (src/clipMarks.json)");
const real = marksJson as ClipMarks;
const phone = real["phone-remote"];
check("the phone clip has been captured with marks", !!phone, "run npm run capture");
// "open" happens before the 4 s the remote scene starts from, so it is not on screen.
for (const name of ["attach", "type", "send", "ask", "allow", "reply"]) {
  const t = phone?.[name];
  check(`phone "${name}" is shown in the video`, t !== undefined && frameOfClipTime("phone-remote", t) !== null, `at ${t ?? "?"} s`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
