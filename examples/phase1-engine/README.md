# World server, cầu nối Claude Code và engine mô phỏng

Phần chạy phía máy của 3D Claude Hub Remote:

- **World server** ([server/](server/)): nói giao thức WebSocket v1 với app, nhận hook của Claude Code ở `POST /hook`, và chạy tab **Sessions**: đọc hội thoại, gửi prompt qua Claude Agent SDK, trả lời xin quyền, phát video trong thư mục session.
- **Cầu nối Claude Code** ([bridge/](bridge/)): script hook và trình cài hook vào `~/.claude/settings.json`. Xem [bridge/README.md](bridge/README.md).
- **Engine mô phỏng** ([src/](src/)): domain model, state machine, hàng chờ job theo agent và engine tất định. App dùng nó cho chế độ "Run demo", và [src/live/LiveAgentBackend.ts](src/live/LiveAgentBackend.ts) biến hook thật thành sự kiện trong cùng thế giới đó.
- **Viewer 3D gọn nhẹ** ([viewer/](viewer/)): một file HTML dùng three.js thuần, server phục vụ nó ở `http://127.0.0.1:8787/`.

Thông thường bạn không chạy thư mục này trực tiếp: `npm run setup` và `npm run up` ở thư mục gốc làm việc đó. README này dành cho người muốn hiểu hoặc sửa phần server.

Cần Node ≥ 22.6. Dependency lúc chạy là `ws` và `@anthropic-ai/claude-agent-sdk`; `typescript` và `esbuild` chỉ dùng lúc dev.

## Lệnh

```bash
npm install
npm run server -- --source claude-code --control
npm run server
npm run replay
npm run bridge -- status
npm run viewer
npm run demo
```

- `npm run server -- --source claude-code --control`: server live như `npm run up` bật. In link app và lưu token ở `~/.aaw/token`.
- `npm run server`: server phục vụ engine mô phỏng qua WebSocket.
- `npm run replay`: phát lại một phiên mẫu (`bridge/sample-session.jsonl`) vào server live. Tự đọc token trong `~/.aaw/token`.
- `npm run bridge -- status`: xem hook đã cài chưa. `install` để cài, `uninstall` để gỡ.
- `npm run viewer`: build viewer vào `viewer/dist/`.
- `npm run demo`: in timeline của demo task, không cần trình duyệt. Thêm `-- --sprint` (8 task song song), `-- --live` (chạy theo thời gian thật ở 4×) hoặc `-- --all` (in cả event ẩn).

Các tuỳ chọn của server nằm ở đầu [server/main.ts](server/main.ts). Những tuỳ chọn hay dùng: `--control`, `--token`, `--permission-mode`, `--allow-bypass`, `--hide-prompts`, `--record`, `--trust-tailscale`.

## Test

```bash
npm run typecheck
npm test
npm run test:ws
npm run test:live
npm run test:sessions
npm run test:session-files
npm run test:security
npm run test:install
npm run test:sound
```

| Lệnh | Kiểm tra |
|---|---|
| `npm test` | Engine mô phỏng: thứ tự phase, tất định, hàng chờ job, sprint |
| `test:ws` | Giao thức WebSocket: bắt tay, command/ack, snapshot, kết nối lại |
| `test:live` | Hook thật → sự kiện trong thế giới, script chuyển tiếp hook |
| `test:sessions` | Sessions: đọc hội thoại, gửi prompt, xin quyền, quy tắc truy cập |
| `test:session-files` | Phát video: chỉ file video trong thư mục session, link hết hạn |
| `test:security` | Token cho `/hook`, ai bị coi là kết nối từ xa, đường dẫn mạng, log |
| `test:install` | Cài và gỡ hook trong `settings.json` mà không đụng tới hook khác |
| `test:sound` | Sự kiện nào phát âm nào trong viewer |

Trên Windows, `test:live` chạy script hook qua Git Bash, giống cách Claude Code chạy nó.

## Thứ tự nên đọc

| # | File | Đọc để hiểu |
|---|---|---|
| 1 | [src/tasks/taskTypes.ts](src/tasks/taskTypes.ts) | Task, phase, status, signal |
| 2 | [src/simulation/WorkflowStateMachine.ts](src/simulation/WorkflowStateMachine.ts) | Bảng chuyển trạng thái thuần, `applySignal` |
| 3 | [src/events/eventTypes.ts](src/events/eventTypes.ts) | Bộ từ vựng event dùng chung cho mô phỏng và live |
| 4 | [src/integrations/AgentBackend.ts](src/integrations/AgentBackend.ts) | Contract và giao thức WebSocket v1, kể cả phần Sessions |
| 5 | [src/simulation/SimulationEngine.ts](src/simulation/SimulationEngine.ts) | Tick, hàng chờ job theo agent, biên đạo từng phase |
| 6 | [src/live/LiveAgentBackend.ts](src/live/LiveAgentBackend.ts) | Hook của Claude Code → robot nào làm gì |
| 7 | [server/worldServer.ts](server/worldServer.ts) | HTTP + WebSocket, token, ai bị coi là kết nối từ xa |
| 8 | [server/sessions/sessionHub.ts](server/sessions/sessionHub.ts) | Danh sách session, hội thoại, prompt, xin quyền |

## Ba ý tưởng chính

**1. Engine là TypeScript thuần, chạy được bằng Node.** Mọi import đều có đuôi `.ts`, không dùng `@/`, không import React hay three. `tsconfig` bật `erasableSyntaxOnly` và `verbatimModuleSyntax`, nên những cú pháp Node không strip được (`enum`, `namespace`, `constructor(private x)`) bị báo lỗi ngay lúc typecheck thay vì crash lúc chạy.

**2. Mỗi agent có một hàng chờ job.**

```
transition(task, signal) ─▶ phase mới ─▶ owner = PHASE_OWNER[phase] ─▶ jobs[owner].push({task, phase})

mỗi tick, với từng agent (thứ tự cố định):
  nếu đang có job          → không làm gì (không bao giờ cắt ngang)
  nếu có job đang chờ      → bỏ hành vi đi dạo, chọn job tốt nhất theo (priority, createdAt, seq)
  nếu rảnh                 → về chỗ sau một lúc, hoặc đi dạo
```

`talk` là giao tiếp từ xa: không ai phải đi lại, và người nghe không bao giờ bị chặn. Nhờ vậy hai task chạy song song mà không deadlock, và task ưu tiên cao luôn tới tay Kai trước.

**3. Tất định đến từng event.** RNG (`mulberry32`) được seed từ config, mỗi task có RNG riêng. Test so sánh **toàn bộ chuỗi event** giữa hai lần chạy, không dùng dung sai. Demo xong ở khoảng 73 giây mô phỏng; sprint 8 task xong ở khoảng 330 giây, 7/8 task hoàn thành (task migration được kịch bản hoá để fail).
