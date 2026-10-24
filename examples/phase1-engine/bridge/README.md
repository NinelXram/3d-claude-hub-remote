# Cầu nối Claude Code

Cho thế giới 3D phản chiếu một phiên Claude Code thật. Không có gì được mô phỏng: mỗi robot chỉ di chuyển khi một hook báo rằng Claude vừa làm đúng loại việc mà robot đó đại diện.

```
Claude Code ──hook (async)──▶ forward-hook.sh ──POST /hook──▶ world server ──WebSocket──▶ viewer 3D
```

## Chạy thử không cần Claude Code

```bash
cd examples/phase1-engine
npm install && npm run viewer
npm run server -- --source claude-code
npm run replay
```

- `npm run server -- --source claude-code`: chạy ở cửa sổ terminal thứ nhất, rồi mở http://127.0.0.1:8787/ trong trình duyệt.
- `npm run replay`: chạy ở cửa sổ terminal thứ hai, phát lại `bridge/sample-session.jsonl`.

Phiên mẫu dài khoảng 57 giây: một prompt thêm rate limiting, có tìm kiếm, đọc file, lập todo list, gọi subagent Explore, viết code, test fail, sửa, test pass, chạy typecheck và xem `git diff`. Muốn xem nhanh hơn thì dùng `npm run replay -- --speed 2`.

## Dùng hằng ngày

```bash
cd examples/phase1-engine && npm install
npm run bridge -- install
npm run live
```

- `npm run bridge -- install`: một lần: thêm hook vào ~/.claude/settings.json (mọi project)
- `npm run live`: mỗi khi muốn xem: bật server, ghi phiên, mở trình duyệt

- **Cài và gỡ:** `npm run bridge -- install` chỉ *thêm* các hook của cầu nối. Hook của công cụ khác và mọi setting khác được giữ nguyên, và file được sao lưu (`settings.json.aaw-backup-…`) trước mỗi lần sửa. Cài hai lần cũng không sinh trùng lặp. `npm run bridge -- uninstall` gỡ ra và trả file về đúng như trước. `npm run bridge -- status` cho biết đã cài chưa.
- **Chỉ một project:** thêm `--scope project --project <thư-mục>`, khi đó script ghi vào `<thư-mục>/.claude/settings.local.json`.
- **Hook có hiệu lực từ phiên Claude Code mới.** Khi `npm run live` không chạy, forwarder thoát êm và Claude Code không hề biết.
- **Ghi phiên:** `npm run live` ghi vào `~/.aaw/sessions/<ngày>.jsonl`. Các file này chứa nguyên văn prompt, chỉ nằm trên máy bạn. Tắt ghi bằng `--no-record`.
- **Âm thanh:** bấm vào viewer một lần để bật âm thanh. Sau đó, kể cả khi tab ở nền, bạn sẽ nghe tiếng buzz khi test fail, tiếng chime khi test pass, fanfare khi hết lượt, và tiếng chuông hai nốt khi Claude chờ bạn. Các lần chuyển việc giữa robot thì không có tiếng. Phím `M` để tắt.
- **Báo khi cần bạn:** khi Claude chờ cấp quyền, cần bạn trả lời, hoặc hết lượt, tiêu đề tab đổi thành "⏳ Permission needed", "⏳ Needs you" hoặc "✓ Turn ended". Bấm **Notify me** trong viewer để nhận thêm thông báo desktop, nhưng chỉ khi tab đang ở nền.

Muốn tự dán khối hook bằng tay thì dùng `npm run -s bridge:settings` để in ra.

## Xem output và gửi prompt từ web (`--control`)

```bash
npm run server -- --source claude-code --control
```

Với `--control`, server cho phép:
- **mở transcript** của bất kỳ session nào đã gửi hook;
- **gửi prompt** từ tab Sessions của app;
- **trả lời yêu cầu cấp quyền** (Allow / Deny) cho những session chạy từ web.

Server in ra địa chỉ app có sẵn token, dạng `http://localhost:3000/#token=…` (chỉ khi chạy trong terminal; log không bao giờ chứa token). Token được lưu ở `~/.aaw/token` (quyền 600) nên địa chỉ này không đổi qua các lần khởi động lại. Với `--control`, hook gửi vào `/hook` cũng phải có token: `forward-hook.sh` tự đọc nó từ `AAW_TOKEN` hoặc `~/.aaw/token`.

Các điểm cần biết:
- Session do web chạy dùng chính lệnh `claude`, đăng nhập, settings và hook của bạn, qua Claude Agent SDK.
- Một session **vẫn đang mở** trong terminal hoặc VS Code sẽ được **tách nhánh** khi bạn gửi prompt từ web. Session đó có cùng lịch sử, nhưng terminal không bị ghi chen. Session đã đóng thì được tiếp tục tại chỗ.
- Yêu cầu cấp quyền của session chạy trong terminal vẫn hỏi ở terminal. Chỉ session do web chạy mới hỏi trên web.
- Server từ chối kết nối WebSocket và POST `/hook` đến từ trang web khác (mã 403), và chỉ đọc transcript nằm trong `~/.claude/projects`.

## Chạy app bản production

`npm run dev` là chế độ phát triển: có nút "N", code chưa tối ưu và chậm hơn. Để dùng hằng ngày:

```bash
cd app
npm run build:live
npm run start:live
```

- `build:live` gắn sẵn địa chỉ `ws://127.0.0.1:8787` vào bản build. Đổi địa chỉ hoặc pull code mới thì cần build lại.
- `start:live` chạy ở cổng 3210; đổi cổng bằng `PORT=4000 npm run start:live`.

## Chế độ quyền cho session chạy từ web

Khi tạo session, hoặc ngay trong khung chat, bạn chọn cách Claude xử lý các thao tác cần quyền:

| Chế độ | Hành vi |
|---|---|
| Ask me (mặc định) | Hỏi bạn trước mỗi thao tác cần quyền |
| Accept edits | Tự cho phép sửa file; lệnh và các thao tác khác vẫn hỏi |
| Auto | Bộ phân loại của Claude Code tự quyết, chỉ hỏi khi không chắc |
| Plan only | Chỉ khám phá và lập kế hoạch, không sửa hay chạy gì |
| Don't ask | Chỉ chạy những gì settings đã cho phép sẵn, còn lại tự từ chối |
| Bypass | Bỏ qua mọi kiểm tra; chỉ có khi server chạy với `--allow-bypass`, và phải xác nhận thêm một lần |

- Với session đang chạy từ web, đổi chế độ có hiệu lực ngay từ thao tác tiếp theo, không cần tạo lại session.
- Với session từ terminal, chế độ được áp dụng cho nhánh mà web tạo ra khi bạn gửi prompt.
- `--permission-mode <chế-độ>` đặt chế độ mặc định cho session mới.
- Quy tắc `allow` trong settings của bạn vẫn được áp dụng ở mọi chế độ.

## Mở từ máy khác hoặc qua tunnel (VS Code Ports, Codespaces)

Chỉ cần chuyển tiếp **một cổng là 8787**. World server phục vụ luôn trang của app, nên trang web và WebSocket dùng chung một địa chỉ (không còn lỗi `ws://127.0.0.1` hay mixed content trên `https`):

```bash
npm run server -- --source claude-code --control --app-port 3210 --proxy-app
```

1. Chạy app như bình thường ở cổng 3210.
2. Trong VS Code, mở tab **Ports**, forward cổng **8787**, và giữ chế độ hiển thị **Private**.
3. Mở `https://<tunnel>-8787.<region>.devtunnels.ms/#token=…`, với token lấy từ `cat ~/.aaw/token`.

Các điểm cần biết:
- Mọi kết nối **không đến từ chính máy này** đều phải có token, kể cả khi chỉ xem văn phòng 3D. Server nhận ra chúng nhờ Origin của trình duyệt và các header mà proxy hay tunnel thêm vào (`X-Forwarded-For`, `CF-Connecting-IP`…).
- Trang web lạ vẫn bị chặn (403).
- **Đừng đặt tunnel ở chế độ Public**: khi đó `/hook` và trang app sẽ lộ ra Internet.

## Vì sao cầu nối không làm phiền phiên làm việc

- Mọi hook đều là `"type": "command"` với `"async": true`, nên Claude Code chạy chúng ở nền và không bao giờ phải chờ.
- `forward-hook.sh` không in gì ra stdout hay stderr, và luôn thoát với mã 0. Với Claude Code, stdout của một số hook (ví dụ `UserPromptSubmit`) sẽ được đưa vào context, còn mã thoát 2 có thể chặn một thao tác. Cầu nối tránh cả hai.
- Khi server không chạy, `curl` hết thời gian chờ sau tối đa 2 giây, script vẫn thoát êm.
- Server luôn trả `204` với body rỗng, kể cả khi payload hỏng.

Cả bốn điều trên đều có test trong `npm run test:live`; các test này chạy chính file `forward-hook.sh`.

## Robot nào đại diện cho việc gì

| Robot | Hook kích hoạt | Ví dụ |
|---|---|---|
| Orion | `UserPromptSubmit`, `Agent`/`Task`, `SubagentStart`, `Notification`, `PermissionRequest`, `Stop` | nhận prompt, giao cho subagent, chờ bạn trả lời hoặc cấp quyền, báo hết lượt |
| Piper | `TodoWrite` lần đầu hoặc khi có việc mới, `EnterPlanMode`/`ExitPlanMode`, `PreCompact` | lập todo list (hiện thành thẻ trên bảng planning) |
| Iris | `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, công cụ MCP, và lệnh `Bash` chỉ đọc (`cat`, `ls`, `grep`, `git status`…) | đọc và tìm kiếm |
| Kai | `Edit`, `Write`, `NotebookEdit`, các lệnh `Bash` khác | sửa file, chạy lệnh |
| Quinn | `Bash` chạy test, lint, typecheck, build | `npm test`, `node --test`, `npx vitest`, `tsc`, `pytest`, `cargo test` |
| Rex | `git diff/log/show/blame`, `gh pr view/diff/review` | xem lại thay đổi |

Một lệnh `Bash` ghép (`a; b && c | d`) được xét từng đoạn: có chạy test thì là Quinn, có xem diff/log thì là Rex, toàn lệnh chỉ đọc thì là Iris, còn lại là Kai. Tên chương trình chỉ được so ở đầu mỗi đoạn, nên `cat test/cart.test.js` là đọc chứ không phải chạy test.

### Test pass hay fail được xác định thế nào

Đây là điều dữ liệu thật dạy: **mã thoát không đủ tin cậy**. Claude rất hay chạy `npm test 2>&1 | tail -15`, và khi đó mã thoát là của `tail` (bằng 0), nên một lần test fail vẫn đến dưới dạng `PostToolUse` "thành công". Vì vậy cầu nối đọc chính output của lệnh, nhận diện dấu hiệu của node:test, Jest, Vitest, pytest, cargo, tsc và npm (hàm `testOutcome`):

- output có dấu hiệu fail, hoặc hook là `PostToolUseFailure`: Quinn báo **Failed**;
- output có dấu hiệu pass: Quinn báo **Passed**;
- output không cho biết rõ: nếu lệnh không có pipe thì tin mã thoát; nếu có pipe thì feed ghi "Ran · … (result not visible in the output)" thay vì đoán.

Một số quy ước:
- Mỗi prompt là một task.
- Phase của task được suy ra từ robot vừa làm việc, và lịch sử ghi tín hiệu `observed`.
- Test fail (`PostToolUseFailure`) sinh ra `qa.failed`; nếu sau đó Claude sửa code tiếp thì task được tính thêm một vòng (`reworked`).
- Hook `Stop` chỉ có nghĩa là **hết lượt**: Claude có thể đã xong, nhưng cũng có thể đang hỏi lại bạn. Vì vậy feed ghi "Turn ended · your move", không ghi "finished". Nếu một prompt mới tới trước khi có `Stop`, task cũ bị ghi là bị ngắt (interrupted).
- Những lần `TodoWrite` chỉ đánh dấu việc xong sẽ đổi màu thẻ trên bảng, chứ không kéo Piper vào giữa câu chuyện.
- `ToolSearch` (Claude Code tự nạp công cụ) không được hiển thị.
- Bảng phân loại nằm trong hàm `classifyTool` ở [src/live/LiveAgentBackend.ts](../src/live/LiveAgentBackend.ts). Đó là hàm thuần, chỉnh sửa và test rất dễ.

## Dữ liệu test lấy từ phiên thật

Ba phiên `claude -p` thật (Claude Code 2.1.304) trên một project nháp có bug giảm giá, đã thay tên người dùng trong đường dẫn:

| File | Nội dung |
|---|---|
| `real-session-discount-bug.jsonl` | test fail cả hai lần nhưng đều qua pipe, không có `PostToolUseFailure` nào |
| `real-session-permission.jsonl` | lệnh `node --test` cần quyền: có `PermissionRequest`, còn `PermissionDenied` không xuất hiện ở chế độ `-p` |
| `real-session-fail-fix-pass.jsonl` | trọn vòng: đọc, lập todo, test fail, sửa, test pass, `git diff` |

`npm run test:live` phát lại cả ba và kiểm tra câu chuyện mà thế giới kể lại. Phát lại để xem: `npm run replay -- bridge/real-session-fail-fix-pass.jsonl`.

## Quyền riêng tư

- Server chỉ lắng nghe trên `127.0.0.1`.
- Payload hook chứa prompt và tham số của công cụ. Server chỉ giữ tiêu đề prompt đã cắt ngắn, tên công cụ, đường dẫn tương đối và lệnh đã cắt ngắn; nó không lưu nội dung file.
- `--hide-prompts` thay tiêu đề prompt bằng "Prompt 1", "Prompt 2"…
- `--token <bí-mật>` bắt buộc header `Authorization: Bearer <bí-mật>`. Đặt biến môi trường `AAW_TOKEN` cho `forward-hook.sh`, và thêm `#token=<bí-mật>` vào URL của viewer.
- `--record phien.jsonl` ghi lại toàn bộ payload thô để phát lại bằng `npm run replay -- phien.jsonl`. File này chứa nguyên văn prompt, nên đừng commit nó.
