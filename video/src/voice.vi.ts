// The voiceover: what the narrator says in each scene, and how to say the English words in it.
// Voice: Azure vi-VN-NamMinhNeural (male). scripts/make-voice.ts turns this into public/voice/<scene>.wav.
import type { SceneId } from "./copy.vi.ts";

export const VOICE = "vi-VN-NamMinhNeural";

export interface VoiceLine {
  scene: SceneId;
  /** Seconds after the scene starts. */
  startS: number;
  text: string;
}

export const VOICE_LINES: VoiceLine[] = [
  { scene: "hook", startS: 0.4, text: "Cả team dùng chung một account Claude? Bật remote control lên, là cả nhóm đều thấy session của bạn." },
  { scene: "credit", startS: 0.5, text: "Dự án lấy cảm hứng từ anh Lực, người đã đưa không gian làm việc của AI Agent lên 3D." },
  {
    scene: "office",
    startS: 0.8,
    text: "Đây là 3D Claude Hub Remote. Mỗi robot là một vai trò: lên kế hoạch, nghiên cứu, viết code, test và review. Mỗi bước đi, mỗi màn hình sáng lên, đều là việc Claude đang làm thật.",
  },
  {
    scene: "sessions",
    startS: 0.5,
    text: "Nhiều session Claude Code chạy song song, mỗi session một dự án, cùng hiện trong một văn phòng. Gửi prompt, duyệt quyền, xem branch, ngay trên trình duyệt.",
  },
  {
    scene: "remote",
    startS: 0.5,
    text: "Và bạn xử lý tất cả ngay trên điện thoại. Session nằm trên máy cá nhân, không public lên account chung của cả nhóm. Truy cập qua Tailscale: tài khoản của bạn vào thẳng, người khác phải có token.",
  },
  { scene: "outro", startS: 0.8, text: "3D Claude Hub Remote, mã nguồn mở trên GitHub." },
];

/**
 * How the Vietnamese voice should say English words (SSML <sub alias>). Matched as whole words, longest first.
 * Tune by ear: change an alias, run `npm run voice`, listen.
 */
export const SAY_AS: Record<string, string> = {
  "3D Claude Hub Remote": "ba đê Clốt Háp Ri-mốt",
  "Claude Code": "Clốt Cốt",
  Claude: "Clốt",
  "3D": "ba đê",
  "AI Agent": "ây ai ây-giần",
  "remote control": "ri-mốt con-trôn",
  account: "ơ-cao",
  session: "xét-sần",
  team: "tim",
  robot: "rô-bốt",
  code: "cốt",
  test: "tét",
  review: "ri-viu",
  prompt: "prom",
  branch: "bờ-ranh",
  public: "pắp-lích",
  Tailscale: "Teo-xkêu",
  token: "tô-cần",
  GitHub: "Gít-háp",
};

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rewrites every SAY_AS word in `text` (whole words, longest first); `plain` and `said` build the output. */
function sayAs(text: string, plain: (s: string) => string, said: (word: string, alias: string) => string): string {
  const keys = Object.keys(SAY_AS).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "gu");
  let out = "";
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    out += plain(text.slice(last, m.index));
    out += said(m[1]!, SAY_AS[m[1]!]!);
    last = m.index! + m[1]!.length;
  }
  return out + plain(text.slice(last));
}

/** One line as plain text with the spoken forms written in (for engines without SSML, e.g. edge-tts). */
export function plainFor(text: string): string {
  return sayAs(text, (s) => s, (_word, alias) => alias);
}

/** The SSML for one line, with SAY_AS applied. */
export function ssmlFor(text: string, rate = "0%"): string {
  const out = sayAs(text, escapeXml, (word, alias) => `<sub alias="${escapeXml(alias)}">${escapeXml(word)}</sub>`);
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="vi-VN"><voice name="${VOICE}"><prosody rate="${rate}">${out}</prosody></voice></speak>`;
}
