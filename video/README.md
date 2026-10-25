# Video giới thiệu 3D Claude Hub Remote

Video dài 1:30, chữ và giọng đọc tiếng Việt, dựng hoàn toàn bằng code từ app thật đang chạy. Kết quả nằm ở `out/3d-workflow-intro-vi.mp4`.

> **Giấy phép Remotion:** thư mục này dùng [Remotion](https://remotion.dev) để ghép video. Remotion miễn phí cho cá nhân và công ty tối đa 3 người; tổ chức lớn hơn cần mua giấy phép ([remotion.dev/license](https://remotion.dev/license)). Phần còn lại của repo không phụ thuộc vào Remotion.

## Cần có

- Node.js 22.6 trở lên.
- Google Chrome. Lúc quay, một cửa sổ Chrome sẽ tự mở vài phút để 3D chạy bằng GPU thật. Đừng thu nhỏ cửa sổ đó.
- Đã chạy `npm install` trong `app/` và `examples/phase1-engine/` (hoặc `npm run setup` ở thư mục gốc).
- Cho giọng đọc, chọn một trong hai:
  - **Azure Speech** (khuyên dùng khi đăng video công khai): `npm run azure:setup` đăng nhập bằng mã thiết bị, tự tạo tài nguyên miễn phí và lưu key vào `.env.local` (không vào git). Cần một tài khoản Azure có subscription.
  - **edge-tts** (không cần tài khoản, hợp để nghe thử): cần Python 3. Cài một lần: `python -m venv .stage/tts-venv`, rồi `.stage/tts-venv/Scripts/pip install edge-tts` (Windows) hoặc `.stage/tts-venv/bin/pip install edge-tts` (macOS, Linux).

## Làm lại video từ đầu

```bash
cd video
npm install
npm run make
```

`npm run make` chạy lần lượt:

1. `check`: kiểm tra chữ và mốc thời gian (độ dài 85–95 giây, mỗi câu đủ lâu để đọc, có ghi công Mr Luc ở cảnh 0:08).
2. `music`: tạo nhạc nền `public/music.wav`.
3. `sfx`, `voice`: tạo hiệu ứng âm thanh và giọng đọc.
4. `capture`: build hai bản sao của app trong `.stage/` (không đụng tới `app/.next`), bật server dàn dựng rồi quay 4 clip vào `public/clips/`.
5. `render`: ghép video bằng Remotion.
6. `check:render` (cùng `check:voice`, `check:sound`): kiểm tra file MP4 (độ dài, 1080p, 30 fps, có tiếng), giọng đọc và vị trí hiệu ứng.

Các lệnh lẻ:

- `npm run capture -- --reuse`: dùng lại bản build cũ của app.
- `npm run capture -- --only phone-remote`: chỉ quay lại một clip.
- `npm run studio`: mở Remotion Studio để xem và chỉnh từng cảnh.
- `npm run stills`: xuất ảnh giữa mỗi câu chữ vào `out/stills/` để soát nhanh.
- `npm run speed -- 1.4`: tạo bản nhanh hơn `out/3d-workflow-intro-vi-1.4x.mp4` (hình và tiếng cùng tăng tốc, giọng không bị cao lên). Tốc độ từ 0.5 đến 2.
- `npm run stage`: chỉ bật server dàn dựng (cổng 8797) để tự xem app với dữ liệu mẫu.
- `npm run test:stage`, `npm run test:guards`, `npm run typecheck`: các bài kiểm tra.

## Sửa nội dung

- **Chữ trên video:** chỉ nằm trong `src/copy.vi.ts`. Bản tiếng Anh sau này là một file cùng cấu trúc.
- **Thời lượng từng cảnh:** `src/timeline.ts` (`SECONDS`). Đoạn clip mỗi cảnh dùng nằm ở `CLIP_USES`.
- **Nhạc:** thay `public/music.wav` bằng file khác cùng tên, hoặc sửa `scripts/make-music.ts`.
- **Giọng đọc:** lời đọc và cách phát âm từ tiếng Anh nằm trong `src/voice.vi.ts` (`VOICE_LINES`, `SAY_AS`). Chạy `npm run voice` để đọc lại, rồi `npm run render`.
  - Có key Azure trong `.env.local` (`npm run azure:setup` đăng nhập bằng mã thiết bị và tự tạo key miễn phí) thì dùng Azure Speech, giọng `vi-VN-NamMinhNeural`.
  - Không có key thì dùng edge-tts (cùng giọng, qua dịch vụ đọc của Edge, không phải API chính thức, nên quyền dùng cho video công khai không rõ ràng). Cách cài ở mục "Cần có".
  - Câu nào dài hơn cảnh của nó sẽ được đọc nhanh hơn, tối đa +20%. `npm run check:voice -- --require-audio` kiểm tra mỗi câu đọc xong trước khi hết cảnh.
- **Hiệu ứng âm thanh:** `npm run sfx` tổng hợp 7 tiếng trong `public/sfx/`. Vị trí từng tiếng nằm trong `src/sound.ts`, tính theo các mốc ghi lại lúc quay (`src/clipMarks.json`).
- **Session mẫu:** `stage/scenario.ts`. Mọi đường dẫn, prompt và kết quả trong đó đều là dữ liệu bịa, nằm dưới `C:/demo/`.

## Dữ liệu thật không lọt vào video

- Server dàn dựng dùng lại server thật của repo, nhưng thay Claude bằng kịch bản và đọc transcript từ `.stage/home`. Không gọi API, không đọc `~/.claude` của bạn.
- Trong lúc chạy, server tạo các thư mục rỗng `C:/demo/...` (vì app chỉ gửi prompt vào thư mục có thật) và xóa chúng khi tắt nếu vẫn còn rỗng.
- Trước và sau mỗi clip, `capture/guards.ts` dừng lại nếu màn hình hiện thư mục home, username, tên máy hoặc token. Nó cũng dừng nếu clip live có chữ "Simulation".
