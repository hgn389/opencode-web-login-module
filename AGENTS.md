# Phạm vi

Repository module đăng nhập độc lập cho OpenCode, không chỉnh sửa mã nguồn OpenCode hoặc WordPress.

# GitHub và lưu thay đổi

- Repository chính: https://github.com/hgn389/opencode-web-login-module
- Nhánh làm việc và push: `main`; remote: `origin`.
- Trước khi sửa tệp, bảo đảm bản hiện tại đã được lưu trong Git. Giữ nguyên các thay đổi của người dùng.
- Sau khi hoàn tất mỗi lần sửa code, chạy kiểm tra phù hợp và `git diff --check`, commit rồi push lên `origin/main`. Cập nhật tài liệu và cấu hình cũng phải được commit và push khi hoàn tất.
- Khi thay đổi code, chạy `npm test`; kiểm tra thêm luồng bị ảnh hưởng nếu cần. Không ghi mật khẩu, token hoặc đáp án CAPTCHA vào kết quả kiểm tra.
- Tích hợp các thay đổi trên remote trước khi push nếu cần. Không force push hoặc xóa lịch sử của người dùng.
- Không commit file env chứa bí mật, database/WAL/SHM, khóa riêng, log, bản sao lưu cấu hình máy chủ hoặc `node_modules`.

# Phát hành

- Commit và push không phải phát hành phiên bản.
- Chỉ phát hành khi chủ repository xác nhận rõ ràng.
- Khi chưa có xác nhận, không tăng version trong `package.json`/`npm-shrinkwrap.json`, không tạo hoặc push tag phiên bản, không tạo GitHub Release, không chạy `npm publish`, không tải lên hoặc tạo gói phát hành mới.
- Không thêm workflow tự phát hành khi push hoặc merge.

# Thực hiện thay đổi

- Chỉ đọc các tệp liên quan trực tiếp đến task; không quét `node_modules`, `vendor`, `uploads`, `cache`, `backup` hoặc log lớn.
- Giữ bảo vệ CSRF, cookie, khóa IP, CAPTCHA và session khi sửa luồng đăng nhập.
- Giao diện thích ứng Mobile, iPad, Laptop và màn hình 4K.
- Hướng dẫn cài đặt/cấu hình đặt ở đầu `README.md`; phân biệt rõ cài OpenCode trước và cài module sau.
