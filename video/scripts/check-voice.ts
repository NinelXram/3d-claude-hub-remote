// Checks the voiceover: one line per scene, pronunciation substitutions, and (once generated) that every line
// finishes inside its scene. `--require-audio` also fails when the audio has not been generated yet.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FPS, scenes } from "../src/timeline.ts";
import { VOICE_LINES, plainFor, ssmlFor } from "../src/voice.vi.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requireAudio = process.argv.includes("--require-audio");
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

console.log("Script");
check("one voice line per scene, in scene order", VOICE_LINES.map((l) => l.scene).join() === scenes.map((s) => s.id).join(), VOICE_LINES.map((l) => l.scene).join());
check("the credit names anh Lực in speech", VOICE_LINES.some((l) => l.scene === "credit" && l.text.includes("anh Lực")));
check("the outro does not thank anyone", VOICE_LINES.every((l) => l.scene !== "outro" || !/anh Lực|cảm ơn/i.test(l.text)));
check("no absolute 'only you' claim is spoken", VOICE_LINES.every((l) => !/chỉ (mình|tài khoản của) bạn/i.test(l.text)));
check("the Tailscale line says others need a token", VOICE_LINES.some((l) => l.scene === "remote" && /token/.test(l.text)));

console.log("Pronunciation");
const s1 = ssmlFor("Nhiều session Claude Code chạy");
check("a phrase wins over its words (Claude Code, not Claude + code)", s1.includes('<sub alias="Clốt Cốt">Claude Code</sub>') && !s1.includes(">Claude</sub>"), s1);
check("words inside other words are left alone (codex)", !ssmlFor("codex").includes("<sub"));
check("text is XML-escaped", ssmlFor("a & b <c>").includes("a &amp; b &lt;c&gt;"));
check("the voice is the male NamMinh", ssmlFor("x").includes('name="vi-VN-NamMinhNeural"'));
check("plain text (edge-tts) gets the same spoken forms", plainFor("Nhiều session Claude Code chạy") === "Nhiều xét-sần Clốt Cốt chạy", plainFor("Nhiều session Claude Code chạy"));
check("plain text leaves other words alone", plainFor("codex & team") === "codex & tim", plainFor("codex & team"));

console.log("Audio");
const manifestFile = join(root, "public", "voice", "manifest.json");
if (!existsSync(manifestFile)) {
  check("voice audio has been generated (npm run voice)", !requireAudio, "public/voice/manifest.json is missing");
} else {
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Record<string, number>;
  for (const line of VOICE_LINES) {
    const scene = scenes.find((s) => s.id === line.scene)!;
    const seconds = manifest[line.scene];
    const room = scene.durationInFrames / FPS - 0.3;
    check(`${line.scene}: the line ends inside the scene`, typeof seconds === "number" && line.startS + seconds <= room, `${line.startS} + ${seconds?.toFixed(2)} s > ${room.toFixed(1)} s`);
    check(`${line.scene}: the audio file exists`, existsSync(join(root, "public", "voice", `${line.scene}.wav`)));
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
