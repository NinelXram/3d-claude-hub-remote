// Every word that appears on screen. An English version replaces this file 1:1.
export type SceneId = "hook" | "credit" | "office" | "sessions" | "remote" | "outro";

export interface Copy extends Record<SceneId, { lines: string[] }> {
  meta: { name: string; repo: string; credit: string; creditRepo: string; install: string[] };
}

const meta = {
  name: "3D Claude Hub Remote",
  repo: "github.com/NinelXram/3d-claude-hub-remote",
  credit: "Mr Luc",
  creditRepo: "github.com/lucwj/ai-agent-3d-prompts",
  install: ["npm run setup", "npm run up:tailscale"],
};

export const copy: Copy = {
  meta,
  hook: {
    lines: [
      "Cả team dùng chung một account Claude?",
      "Remote control trên account chung: cả nhóm thấy session của bạn.",
    ],
  },
  credit: {
    lines: [
      `Cảm hứng từ ${meta.credit}, người 3D hóa không gian làm việc của AI Agent`,
      meta.creditRepo,
    ],
  },
  office: {
    lines: [
      meta.name,
      "Không gian làm việc với AI, giờ là 3D",
      "Mỗi robot một vai trò: lên kế hoạch, nghiên cứu, viết code, test, review",
      "Mỗi bước đi, mỗi màn hình sáng lên là việc Claude đang làm thật",
    ],
  },
  sessions: {
    lines: [
      "Nhiều session Claude Code chạy song song",
      "Gửi prompt, duyệt quyền, xem branch, ngay trên trình duyệt",
      "Mỗi session một dự án, cùng hiện trong một văn phòng",
    ],
  },
  remote: {
    lines: [
      "Xử lý session ngay trên điện thoại",
      "Session nằm trên máy cá nhân, không public lên account chung của cả nhóm",
      "Truy cập qua Tailscale: tài khoản của bạn vào thẳng, người khác phải có token",
    ],
  },
  outro: {
    lines: [
      meta.name,
      meta.install.join("  ·  "),
      meta.repo,
    ],
  },
};
