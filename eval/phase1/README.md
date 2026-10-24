# Engine evaluation

Kiểm tra từ bên ngoài xem một bản engine mô phỏng (`examples/phase1-engine` hoặc `app`) có làm đúng hành vi cần có hay không, mà không tin vào test do chính bản đó viết. CI chạy bộ chấm này cho cả hai.

```bash
node --experimental-strip-types --no-warnings eval/phase1/evaluate.ts examples/phase1-engine
node --experimental-strip-types --no-warnings eval/phase1/evaluate.ts app --json
```

- Không có `--json`: in bảng ✓/✗.
- Có `--json`: in kết quả dạng JSON, dùng cho script hoặc CI.

Bộ chấm chỉ dùng API công khai của engine: `SimulationEngine`, `submitTask`, `tick`, `getTask`, `snapshot`, `events`, `DEMO_TASK`, `SPRINT_TASKS`, `route`.

| Check | Bắt lỗi gì |
|---|---|
| demo.order, demo.result | Workflow và kết quả của demo task |
| demo.time | Demo nằm ngoài khoảng 60–80 s, thường do đi bộ thừa hoặc thời lượng sai |
| demo.comms, demo.messages | Mỗi lần nói chuyện đúng một event giao tiếp, không lặp tên trong nội dung |
| demo.links | Thời gian sống và loại của arc giao tiếp |
| determinism | Hai lần chạy cho ra cùng chuỗi event |
| route.same | Đi vòng ra hành lang khi đã đứng đúng chỗ |
| stop | `stop()` giữ nguyên trạng thái |
| block.handoff | Task được giao cho agent đang tạm dừng phải bị `blocked` |
| concurrency, one.job | Hàng chờ job theo agent: ưu tiên đúng, không cắt ngang |
| sprint, random.never.fails | Kịch bản sprint và quy tắc task ngẫu nhiên luôn ship |

`examples/phase1-engine` đạt 14/14 (demo 72.9 s, sprint 328.7 s, 7/8 task xong).
