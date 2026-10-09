# OpenCode Web Login 1.0.1

Module đăng nhập và bảo mật độc lập cho OpenCode v2. Có thể dùng như thư viện Node.js, chạy bằng CLI hoặc cài thành dịch vụ Linux. Module kết nối với OpenCode qua HTTP API, không cần sửa hay build lại mã nguồn OpenCode.

Yêu cầu: Node.js 24 trở lên; OpenCode v2 hỗ trợ `/api/info`, `/api/pair`, `/auth/connect/:code`; backend OpenCode phải chạy ở loopback và có mật khẩu. Bản v1 dùng API khác nên chưa được hỗ trợ. Mật khẩu vẫn do dịch vụ OpenCode quản lý.

## Các quy tắc bảo mật

- Sai tên đăng nhập hoặc mật khẩu 5 lần: hiện CAPTCHA ảnh; những lần tiếp theo phải giải đúng CAPTCHA.
- Sai tên đăng nhập hoặc mật khẩu 10 lần: khóa IP vĩnh viễn đến khi quản trị viên mở khóa.
- Đăng nhập đúng trước khi bị khóa đặt lại bộ đếm lỗi liên tiếp.
- Bộ đếm và khóa IP lưu trong SQLite, giữ qua các lần khởi động lại.
- CAPTCHA tồn tại 5 phút, dùng một lần; sai CAPTCHA không tăng bộ đếm tên đăng nhập/mật khẩu.
- Tối đa 40 yêu cầu vào trang đăng nhập, biểu mẫu và ảnh CAPTCHA mỗi IP mỗi phút; mỗi IP chỉ kiểm tra một mật khẩu tại một thời điểm.
- Phiên tối đa 8 giờ, hết hạn sau 30 phút không có yêu cầu được xác thực; đăng xuất thu hồi phiên ở máy chủ.
- Chặn việc né trang đăng nhập qua Basic Auth, token URL, cookie của OpenCode hoặc liên kết ghép nối.
- Bảo vệ CSRF, kiểm tra origin và proxy đáng tin cậy; vẫn hỗ trợ SSE và terminal WebSocket.
- Lọc header dành riêng cho từng kết nối, giới hạn thời gian chờ backend và kiểm tra WebSocket upgrade.
- Khi chạy qua domain HTTPS: cookie `__Host-`, Secure, HttpOnly, SameSite=Strict và HSTS.

IP dùng chung cũng dùng chung bộ đếm và khóa. Khóa này chỉ áp dụng tại gateway OpenCode, không chặn các website khác. Các luồng SSE/WebSocket kiểm tra lại phiên mỗi 30 giây. CAPTCHA ảnh là lớp giảm bot; khi mở Internet nên bổ sung MFA hoặc dịch vụ kiểm tra bot chuyên dụng.

## Cài gói trên máy khác

Sao chép file `opencode-web-login-1.0.1.tgz` sang máy cần sử dụng. Cài Node.js 24+, Git và một dịch vụ OpenCode v2 có mật khẩu trước.

```sh
npm install -g ./opencode-web-login-1.0.1.tgz
opencode-web-login --help
```

Gói được phân phối bằng file, chưa được đưa lên npm registry. Nếu cài global vào thư mục hệ thống, chạy lệnh npm với quyền quản trị phù hợp.

### Chạy độc lập

```sh
# OpenCode dùng tài khoản/mật khẩu đã được cấu hình của bạn.
opencode serve --hostname 127.0.0.1 --port 4097
```

Ở terminal khác, tạo cấu hình từ `environment.example`, rồi chạy:

```sh
opencode-web-login serve --config /absolute/path/login.env
```

Mặc định gateway chỉ nghe ở `127.0.0.1:4096`. Mở `http://127.0.0.1:4096/login`. Muốn truy cập LAN, đặt `LOGIN_HOST` thành IP LAN thật và cho phép cổng tương ứng trong firewall của bạn. Module không tự mở firewall.

Trang đăng xuất: `/logout`. API/CLI của OpenCode trên máy chủ kết nối trực tiếp với backend loopback; gateway bên ngoài chỉ nhận phiên tạo qua trang đăng nhập.

### Cài dịch vụ Linux

Thay đường dẫn binary OpenCode, tên dịch vụ và địa chỉ bên dưới theo máy đích. Không dùng backend công khai.

```sh
sudo opencode-web-login install \
  --opencode-bin /usr/local/bin/opencode \
  --opencode-service opencode.service \
  --host 127.0.0.1 \
  --port 4096 \
  --backend-port 4097 \
  --dry-run
```

`--dry-run` in ra cấu hình đầy đủ để kiểm tra, không thay đổi hệ thống. Bỏ `--dry-run` để cài. Các tùy chọn thêm:

```sh
opencode-web-login install --help
```

Bộ cài sẽ:

1. Kiểm tra cấu hình, dịch vụ OpenCode, tệp thực thi, quyền thư mục và cổng đang sử dụng.
2. Sao lưu những file sẽ thay đổi bằng Git tại `/var/lib/NAME-install-backup`, quyền `0700`.
3. Chuẩn bị mã nguồn và thư viện trong thư mục tạm theo `npm-shrinkwrap.json` trước khi dừng dịch vụ.
4. Tạo user riêng không có shell; dữ liệu nằm ở `/var/lib/NAME/security.sqlite`.
5. Sinh file `/etc/NAME.env`, unit `NAME.service` và override backend để chỉ nghe loopback.
6. Khởi động lại backend, bật gateway; kiểm tra cả trang đăng nhập và backend có yêu cầu mật khẩu.

Mặc định `NAME=opencode-login`, thư mục mã nguồn `/opt/opencode-login`. Dùng `--name` và `--install-dir` để đổi. Mỗi instance cần cổng, service backend và nơi lưu dữ liệu riêng. Khi cài lại, truyền đúng các tùy chọn cũ; bộ cài giữ cơ sở dữ liệu, nhưng ghi lại cấu hình từ các tùy chọn bạn truyền.

Bộ cài không đổi DNS, TLS hoặc firewall, và không cài/cập nhật OpenCode. Nếu cập nhật thất bại sau khi thay đổi dịch vụ, bộ cài khôi phục tệp, thư viện và trạng thái dịch vụ trước đó. Vị trí sao lưu Git luôn được báo trong lỗi; nếu khôi phục tự động thất bại, thư viện cũ được giữ trong thư mục tạm để quản trị viên khôi phục thủ công. Không dùng thư mục home cho mã nguồn dịch vụ vì unit chặn quyền truy cập home.

## Dùng như thư viện

```js
import { createLoginServer } from 'opencode-web-login';

const login = createLoginServer({
  host: '127.0.0.1',
  port: 4096,
  backendHost: '127.0.0.1',
  backendPort: 4097,
  statePath: '/absolute/path/security.sqlite',
  publicOrigins: ['https://coding.example.com'],
  trustedProxies: ['127.0.0.1', '::1'],
});

await login.listen();
// Khi ứng dụng chủ cần dừng:
await login.close();
```

Import module không mở cổng, tạo database hoặc đăng ký signal handler. Mỗi instance có store, phiên và bộ đếm riêng. Hàm `close()` không thoát tiến trình của ứng dụng chủ; nó hủy yêu cầu backend đang chờ và xử lý an toàn khi được gọi trong lúc `listen()` chưa hoàn tất. `login.server` là HTTP server nếu cần gắn thêm event; `login.config` là cấu hình đã kiểm tra.

Có thể lấy cấu hình từ biến môi trường bằng `configFromEnv()` hoặc kiểm tra cấu hình bằng `normalizeConfig()`. Gateway và backend phải có endpoint khác nhau; backend chỉ được dùng địa chỉ loopback. Font CAPTCHA được đóng gói cùng module, không phụ thuộc đường dẫn font trên máy đích.

## Cấu hình

| Biến | Giá trị mặc định |
| --- | --- |
| `LOGIN_HOST` | `127.0.0.1` |
| `LOGIN_PORT` | `4096` |
| `OPENCODE_BACKEND_HOST` | `127.0.0.1` |
| `OPENCODE_BACKEND_PORT` | `4097` |
| `LOGIN_STATE_DB` | `~/.local/state/opencode-web-login/security.sqlite` khi chạy độc lập |
| `LOGIN_PUBLIC_ORIGINS` | Rỗng; danh sách domain HTTPS phân cách bằng dấu phẩy |
| `LOGIN_TRUSTED_PROXIES` | `127.0.0.1,::1`; chỉ IP/CIDR của proxy do bạn kiểm soát |

CLI `--config` đọc file env. Biến môi trường đã có sẵn được ưu tiên hơn file. Linux installer đặt `LOGIN_STATE_DB` rõ ràng tại `/var/lib/NAME/security.sqlite`.

## Quản trị

```sh
opencode-web-login doctor --config /etc/opencode-login.env

# Đọc/mở khóa database dưới đúng user sở hữu.
sudo -u opencode-login opencode-web-login blocked --config /etc/opencode-login.env
sudo -u opencode-login opencode-web-login unblock 192.0.2.10 --config /etc/opencode-login.env
sudo -u opencode-login opencode-web-login revoke-sessions --config /etc/opencode-login.env

systemctl status opencode-login
journalctl -u opencode-login --since today
```

`doctor` kiểm tra cấu hình và backend có phản hồi JSON yêu cầu xác thực. Nó không thử mật khẩu và không chứng minh mọi API của các phiên bản OpenCode tương lai đều tương thích.

Trên Linux, thư mục cơ sở dữ liệu phải thuộc người chạy dịch vụ và có quyền `0700`; tệp cơ sở dữ liệu/WAL/SHM phải là tệp thường thuộc cùng người dùng, quyền `0600`. Module từ chối tệp liên kết hoặc quyền quá rộng. Không đưa database, WAL hoặc các file env chứa bí mật vào Git hay gói cài đặt. Nhật ký không ghi mật khẩu, đáp án CAPTCHA hoặc session token. Đổi mật khẩu OpenCode khiến native token cũ bị từ chối; gateway thu hồi phiên bị backend từ chối.

## Domain HTTPS

Cấu hình chứng chỉ TLS trên reverse proxy, rồi thêm domain bằng `LOGIN_PUBLIC_ORIGINS=https://coding.example.com` hoặc tùy chọn installer `--public-origins`.

Proxy phải giữ public Host, gửi `X-Forwarded-Proto: https` và chuỗi `X-Forwarded-For` chứa IP thật. Proxy đầu tiên phải xử lý header giả do client gửi. Chỉ thêm địa chỉ proxy đã kiểm tra vào `LOGIN_TRUSTED_PROXIES`. Nếu có Cloudflare/proxy nhiều tầng, kiểm tra dải IP và cách chuyển tiếp trước khi thêm trust.

Cấu hình WebSocket upgrade, chuyển HTTP sang HTTPS và chỉ công khai cổng proxy HTTPS. Domain HTTP sẽ được chuyển sang HTTPS; gửi form qua HTTP bị từ chối. Kiểm tra IP thật và khóa IP từ bên ngoài LAN trước khi đưa vào sử dụng.

## Phát triển và đóng gói

Tại thư mục source có test:

```sh
npm ci
npm test
mkdir -p dist
npm pack --pack-destination dist
```

Test dùng database tạm và đáp án CAPTCHA cố định chỉ trong tiến trình test riêng. Bản chạy thực tế không có endpoint hoặc tùy chọn bỏ qua CAPTCHA. Gói cài chỉ chứa source, giao diện, font, license font và dependency lock; không chứa cấu hình máy đang chạy, database hay lịch sử Git.
