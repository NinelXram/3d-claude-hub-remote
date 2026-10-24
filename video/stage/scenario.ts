// The made-up sessions the video shows. Every path, prompt and output here is invented and neutral.

export interface Step {
  tool: "Read" | "Grep" | "Edit" | "Bash";
  input: Record<string, unknown>;
  /** What the tool printed. */
  result: string;
  /** A failing test run (red tool row, Quinn's buzz). */
  failed?: boolean;
}

export interface Turn {
  prompt: string;
  steps: Step[];
  reply: string;
}

export interface StagedSession {
  id: string;
  cwd: string;
  branch: string;
  /** Already finished before the video starts, so the chat has history. */
  earlier: Turn;
  /** Played live by `play()`. */
  live: Turn;
  /** Seconds after `play()` starts. */
  startAfterS: number;
}

const read = (file_path: string, result: string): Step => ({ tool: "Read", input: { file_path }, result });
const grep = (pattern: string, path: string, result: string): Step => ({ tool: "Grep", input: { pattern, path }, result });
const edit = (file_path: string, old_string: string, new_string: string): Step => ({ tool: "Edit", input: { file_path, old_string, new_string }, result: `The file ${file_path} has been updated.` });
const bash = (command: string, result: string, failed = false): Step => ({ tool: "Bash", input: { command }, result, ...(failed ? { failed } : {}) });

export const SCENARIO: StagedSession[] = [
  {
    id: "5e55a001-0000-4000-8000-00000000c0de",
    cwd: "C:/demo/shop-api",
    branch: "feat/checkout",
    startAfterS: 0,
    earlier: {
      prompt: "Chạy toàn bộ test của project giúp mình",
      steps: [bash("npm test", "> shop-api@1.4.0 test\n> node --test\n\n# tests 23\n# pass 23\n# fail 0")],
      reply: "Toàn bộ **23 test** đều pass. Project đang ổn định để làm tiếp phần thanh toán.",
    },
    live: {
      prompt: "Thêm kiểm tra mã giảm giá hết hạn khi thanh toán, kèm test",
      steps: [
        grep("applyDiscount", "src", "src/checkout/discount.ts:12: export function applyDiscount(cart, coupon) {\nsrc/checkout/index.ts:4: import { applyDiscount } from \"./discount.ts\";"),
        read("C:/demo/shop-api/src/checkout/discount.ts", "export function applyDiscount(cart, coupon) {\n  if (!coupon) return cart.total;\n  return Math.max(0, cart.total - coupon.amount);\n}"),
        edit("C:/demo/shop-api/test/discount.test.ts", "", "test(\"rejects an expired coupon\", () => { … });"),
        bash("npm test", "# tests 24\n# pass 23\n# fail 1\n\nnot ok 24 - rejects an expired coupon\n  expected: \"COUPON_EXPIRED\"\n  actual: 80", true),
        edit("C:/demo/shop-api/src/checkout/discount.ts", "if (!coupon) return cart.total;", "if (!coupon) return cart.total;\n  if (coupon.expiresAt < Date.now()) throw new CheckoutError(\"COUPON_EXPIRED\");"),
        bash("npm test", "# tests 24\n# pass 24\n# fail 0"),
        bash("git diff --stat", " src/checkout/discount.ts | 2 ++\n test/discount.test.ts    | 9 +++++++++\n 2 files changed, 11 insertions(+)"),
      ],
      reply: "Đã thêm kiểm tra hạn dùng trong `applyDiscount`:\n\n- Mã hết hạn trả lỗi `COUPON_EXPIRED`\n- Thêm test `rejects an expired coupon`\n\nCả **24 test** đều pass.",
    },
  },
  {
    id: "5e55a002-0000-4000-8000-00000000c0de",
    cwd: "C:/demo/web-dashboard",
    branch: "fix/chart-tooltip",
    startAfterS: 4,
    earlier: {
      prompt: "Biểu đồ doanh thu đang dùng component nào?",
      steps: [grep("RevenueChart", "src", "src/components/RevenueChart.tsx\nsrc/pages/Overview.tsx")],
      reply: "Biểu đồ nằm ở `src/components/RevenueChart.tsx`, được dùng trong trang **Overview**.",
    },
    live: {
      prompt: "Tooltip biểu đồ doanh thu bị lệch khi thu nhỏ màn hình, sửa giúp mình",
      steps: [
        read("C:/demo/web-dashboard/src/components/RevenueChart.tsx", "const left = point.x + 12;\nconst top = point.y - 40;"),
        grep("getBoundingClientRect", "src/components", "src/components/Tooltip.tsx:18: const box = el.getBoundingClientRect();"),
        edit("C:/demo/web-dashboard/src/components/RevenueChart.tsx", "const left = point.x + 12;", "const left = Math.min(point.x + 12, width - tooltipWidth - 8);"),
        bash("npm test -- RevenueChart", "✓ keeps the tooltip inside a 360px chart\n✓ follows the hovered point\n\nTests: 2 passed"),
        bash("git diff --stat", " src/components/RevenueChart.tsx | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)"),
      ],
      reply: "Tooltip giờ luôn nằm gọn trong khung biểu đồ, kể cả khi màn hình hẹp tới 360px.",
    },
  },
  {
    id: "5e55a003-0000-4000-8000-00000000c0de",
    cwd: "C:/demo/mobile-app",
    branch: "main",
    startAfterS: 8,
    earlier: {
      prompt: "Liệt kê các màn hình đăng nhập hiện có",
      steps: [grep("Screen", "src/screens/auth", "LoginScreen.tsx\nOtpScreen.tsx")],
      reply: "Có 2 màn hình: `LoginScreen` và `OtpScreen` (mới thêm trong PR gần nhất).",
    },
    live: {
      prompt: "Review PR thêm màn hình đăng nhập bằng mã OTP",
      steps: [
        bash("git diff main...feat/otp-login --stat", " src/screens/auth/OtpScreen.tsx | 84 +++++++\n src/api/auth.ts                |  21 ++\n 2 files changed, 105 insertions(+)"),
        read("C:/demo/mobile-app/src/screens/auth/OtpScreen.tsx", "const [seconds, setSeconds] = useState(60);\n…\n<Button onPress={resendOtp} disabled={seconds > 0} />"),
        grep("resendOtp", "src/api", "src/api/auth.ts:33: export async function resendOtp(phone) {"),
        bash("npm test", "Test Suites: 12 passed, 12 total\nTests:       58 passed, 58 total"),
      ],
      reply: "PR ổn, test đều pass. Hai góp ý nhỏ:\n\n1. Đếm ngược nên dừng khi màn hình bị ẩn\n2. `resendOtp` nên giới hạn số lần gửi lại",
    },
  },
];

/** What a prompt sent from the phone does (the scene with the image and the Allow card). */
export const WEB_TURN = {
  readStep: read("C:/demo/shop-api/src/checkout/discount.ts", "if (coupon.expiresAt < Date.now()) throw new CheckoutError(\"COUPON_EXPIRED\");"),
  askedStep: bash("npm test -- discount", "# tests 6\n# pass 6\n# fail 0"),
  askTitle: "Claude muốn chạy: npm test -- discount",
  reply: "Trong ảnh là lỗi `COUPON_EXPIRED` từ bước thanh toán: mã đã hết hạn nên bị từ chối, đúng như mong muốn. Mình đã chạy lại test và **6/6 pass**.",
};
