# Bảo mật

3D Claude Hub Remote cho phép điều khiển Claude Code trên máy bạn từ trình duyệt. Tài liệu này nói rõ ai vào được, bằng cách nào, và những giới hạn đã biết.

## Báo lỗ hổng

Đừng mở issue công khai cho lỗ hổng bảo mật. Hãy dùng **Security → Report a vulnerability** (GitHub private vulnerability reporting) trên trang repo. Mô tả cách tái hiện và mức ảnh hưởng.

## Mô hình bảo vệ

- **Server chỉ nghe trên `127.0.0.1`** (cổng 8787, và 8788 khi bật Tailscale). Thiết bị khác chỉ vào được qua một tunnel bạn tự mở.
- **Token**: 192 bit ngẫu nhiên, lưu ở `~/.aaw/token` với quyền chỉ chủ máy đọc được.
  - Token bắt buộc để đọc hội thoại, gửi prompt, trả lời xin quyền, và gửi hook vào `/hook`.
  - Token được so sánh trong thời gian không đổi.
  - Link chứa token đặt nó sau dấu `#`, nên trình duyệt không gửi token tới server, proxy hay tunnel. App xoá token khỏi thanh địa chỉ ngay khi đọc.
  - Token chỉ được in ra terminal, không bao giờ ghi vào log của autostart.
- **Kết nối từ xa luôn cần token**: trang web từ origin khác, mọi kết nối đi qua proxy hoặc tunnel (có header `X-Forwarded-*`, `Forwarded`, `CF-Connecting-IP`…), và mọi kết nối vào cổng Tailscale mà không phải tài khoản của bạn.
- **Tailscale**: trên cổng 8788, header `Tailscale-User-Login` do `tailscale serve` ghi được dùng thay token, nhưng chỉ cho đúng tài khoản bạn chỉ định. Trên cổng 8787 header này không có tác dụng.
- **Trang web lạ** không mở được WebSocket tới server (kiểm tra Origin), và không gửi được hook: `/hook` từ chối request mang Origin không phải `localhost`, và luôn cần token khi bật điều khiển.
- **File**:
  - Hội thoại chỉ được đọc từ `~/.claude/projects`. Đường dẫn được kiểm tra dạng chữ trước khi chạm vào hệ thống file, nên đường dẫn mạng (`\\máy\share`) không bao giờ được mở.
  - Video chỉ phát được nếu là file video thật sự nằm trong thư mục của session, đã giải symlink và junction. Link video hết hạn sau 30 phút hoặc khi trang đã yêu cầu nó đóng kết nối.
- **Quyền của Claude**: session mở từ web mặc định hỏi quyền trước mỗi công cụ. Chế độ bỏ qua hỏi quyền chỉ có khi server chạy với `--allow-bypass`.
- **Hook** chạy bất đồng bộ, không in gì và luôn thoát mã 0, nên không thể chặn hay chèn nội dung vào session Claude Code.

## Giới hạn đã biết

- **Người dùng khác trên cùng máy.** Cổng 8788 tin header Tailscale từ bất kỳ tiến trình nào trên máy, vì `tailscale serve` cũng kết nối từ `127.0.0.1`. Một tiến trình chạy dưới tài khoản của chính bạn vốn đã đọc được `~/.aaw/token`, nên điều này chỉ đáng lo khi **người dùng hệ điều hành khác** có thể chạy chương trình trên máy. Trên máy dùng chung, đừng bật chế độ tin tài khoản Tailscale: dùng `npm run up` thay cho `npm run up:tailscale`, hoặc `npm run autostart -- --no-trust-tailscale`. Khi đó mọi kết nối đều cần token.
- **Mở thẳng ra mạng.** Đừng chạy server với `--host 0.0.0.0` hay mở cổng 8787 qua tunnel ẩn danh. Server nhận ra kết nối từ xa nhờ Origin của trình duyệt và header mà proxy hay tunnel thêm vào. Một kết nối tới thẳng, không qua proxy và không gửi Origin, trông giống một script trên chính máy bạn, nên vẫn xem được thế giới 3D (gồm 280 ký tự đầu của prompt nếu không dùng `--hide-prompts`). Phần điều khiển và hội thoại vẫn luôn cần token.
- **File ghi phiên** (`--record`) và log chứa nguyên văn prompt và tên file. Chúng chỉ nằm trên máy bạn, được tạo với quyền chỉ chủ máy đọc (trên macOS và Linux). Đừng commit chúng.
- **Hành động của Claude.** Khi bạn bấm Allow, Claude chạy công cụ với đầy đủ quyền của tài khoản bạn. Project này không sandbox Claude Code.
