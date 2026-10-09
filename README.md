# OpenCode Web Login Module

Module độc lập cung cấp trang đăng nhập và bảo mật cho OpenCode. Module chạy thành dịch vụ riêng phía trước OpenCode, kết nối qua HTTP API và không cần sửa mã nguồn OpenCode.

**Thứ tự cài đặt: cài OpenCode trước → cấu hình mật khẩu và dịch vụ OpenCode → cài module này → cấu hình domain/HTTPS nếu cần truy cập Internet.**

**Bản thử nghiệm:** [v1.1.0-beta](https://github.com/hgn389/opencode-web-login-module/releases/tag/v1.1.0-beta). Phiên bản gói: `1.1.0-beta`.

**Bản này bao gồm menu đổi mật khẩu OpenCode và cập nhật Web Login Module qua web. Tự động cập nhật mặc định tắt.**

## Cài đặt và cấu hình

### 1. Chuẩn bị OpenCode và công cụ cần thiết

Máy đích cần có:

- OpenCode v2 đã cài, có tài khoản/mật khẩu và dịch vụ Linux đang chạy, ví dụ `opencode.service`.
- OpenCode hỗ trợ các API `/api/info`, `/api/pair` và `/auth/connect/:code`. Bản v1 dùng API khác, chưa được module hỗ trợ.
- Node.js **24 trở lên**, npm và Git. Node.js dùng để chạy dịch vụ phải được cài ngoài `/root` và `/home`, ví dụ trong `/usr` hoặc `/usr/local`.
- Linux có systemd và quyền quản trị nếu chọn cài thành dịch vụ.

Kiểm tra trước khi cài module:

```sh
node --version
npm --version
git --version
command -v opencode
sudo systemctl status opencode.service
```

Ghi lại đường dẫn binary từ `command -v opencode` và tên dịch vụ OpenCode thực tế. Các ví dụ bên dưới dùng `/usr/local/bin/opencode` và `opencode.service`; thay chúng theo máy của bạn. Tài khoản/mật khẩu vẫn do OpenCode quản lý, module không tạo một tài khoản khác.

### 2. Tải mã nguồn module từ GitHub

```sh
sudo git clone --branch v1.1.0-beta https://github.com/hgn389/opencode-web-login-module.git /opt/opencode-web-login-src
cd /opt/opencode-web-login-src
sudo npm ci --omit=dev --ignore-scripts
node bin/opencode-web-login.mjs --help
```

Lệnh clone trên lấy đúng bản beta đã phát hành, có menu quản trị mới. Nếu muốn mã đang phát triển, thay `--branch v1.1.0-beta` bằng `--branch main`; nhánh `main` có thể có thay đổi chưa phát hành. `/opt/opencode-web-login-src` là thư mục mã nguồn. Bộ cài sẽ tạo thư mục dịch vụ riêng tại `/opt/opencode-login`, nên không cần cài global bằng npm để dùng những lệnh dưới đây.

#### Cài từ gói `.tgz` trên GitHub Release

Nếu muốn cài CLI global, tải hai tệp `opencode-web-login-1.1.0-beta.tgz` và `opencode-web-login-1.1.0-beta.tgz.sha256` từ [trang phát hành](https://github.com/hgn389/opencode-web-login-module/releases/tag/v1.1.0-beta). Trong thư mục đã tải, chạy:

```sh
sha256sum --check opencode-web-login-1.1.0-beta.tgz.sha256
sudo npm install -g ./opencode-web-login-1.1.0-beta.tgz
opencode-web-login --help
```

Sau khi cài gói, dùng `sudo opencode-web-login install` thay cho `sudo node /opt/opencode-web-login-src/bin/opencode-web-login.mjs install` trong các lệnh ở bước 3, giữ nguyên các tùy chọn phù hợp với máy của bạn. Gói phát hành cần tải thư viện từ npm khi cài đặt; không có mật khẩu hoặc cấu hình của máy chủ trong gói.

### 3. Cài module thành dịch vụ

Chạy thử để xem cấu hình trước; lệnh có `--dry-run` không thay đổi hệ thống:

```sh
sudo node /opt/opencode-web-login-src/bin/opencode-web-login.mjs install \
  --opencode-bin /usr/local/bin/opencode \
  --opencode-service opencode.service \
  --host 127.0.0.1 \
  --port 4096 \
  --backend-port 4097 \
  --dry-run
```

Sau khi kiểm tra đúng đường dẫn, tên dịch vụ và cổng, chạy lệnh cài thật:

```sh
sudo node /opt/opencode-web-login-src/bin/opencode-web-login.mjs install \
  --opencode-bin /usr/local/bin/opencode \
  --opencode-service opencode.service \
  --host 127.0.0.1 \
  --port 4096 \
  --backend-port 4097
```

**Truy cập từ máy khác trong LAN:** thay `--host 127.0.0.1` trong cả hai lệnh bằng IP LAN của máy chủ, `--host IP_SERVER` (`IP_SERVER` là giá trị mẫu, cần thay bằng IP của máy đích). Cho phép cổng `4096` trong firewall cho mạng LAN cần sử dụng. Module không tự mở firewall.

Bộ cài sẽ:

1. Kiểm tra cấu hình, dịch vụ OpenCode, tệp thực thi, quyền thư mục và cổng.
2. Sao lưu các tệp sẽ thay đổi bằng Git tại `/var/lib/opencode-login-install-backup`, quyền `0700`.
3. Chuẩn bị mã nguồn và thư viện theo `npm-shrinkwrap.json` trước khi dừng dịch vụ.
4. Tạo người dùng hệ thống riêng `opencode-login`, không có shell đăng nhập.
5. Chuyển OpenCode sang địa chỉ nội bộ `127.0.0.1:4097`, đặt gateway đăng nhập ở địa chỉ/cổng bạn chọn.
6. Khởi động dịch vụ và kiểm tra cả trang đăng nhập lẫn backend có yêu cầu mật khẩu.
7. Cài dịch vụ quản trị riêng `opencode-login-admin.service`, giao tiếp với gateway qua Unix socket riêng; gateway vẫn chạy bằng người dùng không có quyền root. Tự động cập nhật mặc định tắt.

Module không cài hoặc cập nhật OpenCode. Bộ cài giữ cơ sở dữ liệu phiên và khóa IP khi cài lại. Nếu cập nhật thất bại sau khi thay đổi dịch vụ, bộ cài khôi phục tệp, thư viện và trạng thái dịch vụ cũ, đồng thời báo vị trí sao lưu Git.

### 4. Kiểm tra và đăng nhập

```sh
sudo systemctl status opencode.service opencode-login.service opencode-login-admin.service
sudo node /opt/opencode-login/bin/opencode-web-login.mjs doctor --config /etc/opencode-login.env
```

Mở một trong các địa chỉ phù hợp với `--host` đã cấu hình:

- Chỉ dùng trên máy chủ: `http://127.0.0.1:4096/login`.
- Dùng trong LAN: `http://IP_SERVER:4096/login`; thay `IP_SERVER` bằng IP của máy đích.

Sau khi cài thành công, bộ cài in trường `loginURL` với đúng cổng vừa cấu hình. Khi bind tất cả interface (`0.0.0.0` hoặc `::`), thông báo dùng `http://IP_SERVER:CỔNG_THỰC_TẾ/login` để bạn thay IP; nếu đã cấu hình domain HTTPS, thông báo dùng domain đó. Với cổng tùy chọn `6699`, ví dụ thông báo là `http://IP_SERVER:6699/login`, không dùng chữ `PORT` trong kết quả cài đặt. Các giá trị này được sinh từ cấu hình trên máy đích, không lưu trong mã nguồn.

Nhập tài khoản/mật khẩu OpenCode. Khi đăng nhập thành công, trình duyệt chuyển vào OpenCode. Trang đăng xuất nằm ở `/logout`.

Nếu trình duyệt đang giữ trang đăng nhập cũ, nhấn `Ctrl+F5` rồi thử lại. Nếu trang báo chưa gửi cookie, cho phép cookie cho địa chỉ này. Lỗi phiên hoặc CAPTCHA không được tính là nhập sai tài khoản/mật khẩu.

#### Đổi mật khẩu và cập nhật qua web

Sau khi đăng nhập, mở **Cài đặt** của OpenCode. Nhóm **Web Login Module** có hai mục:

- **Đổi mật khẩu:** nhập mật khẩu hiện tại, mật khẩu mới từ 16 đến 128 ký tự, xác nhận lại và đánh dấu đã lưu công việc. Module sao lưu cấu hình bằng Git, đổi mật khẩu thật của OpenCode và khởi động lại dịch vụ. Mọi phiên đăng nhập bị thu hồi; đăng nhập lại bằng mật khẩu mới. Nếu khởi động thất bại, module khôi phục cấu hình trước đó.
- **Cập nhật Web Login Module:** kiểm tra bản mới, chọn kênh **Bản ổn định** hoặc **Bản ổn định và beta**, bật/tắt tự động cập nhật hoặc bấm **Cập nhật ngay**. Lưu cấu hình và cài bản mới đều yêu cầu mật khẩu hiện tại. Cập nhật thủ công yêu cầu xác nhận đã lưu công việc; tự động cập nhật cũng sẽ khởi động lại dịch vụ khi có bản mới.

Trên điện thoại, hai nút xuất hiện ngay dưới thanh điều hướng Cài đặt. Nếu bản OpenCode khác đã đổi cấu trúc menu, mở trực tiếp `/web-login/password` hoặc `/web-login/updates` trên cùng địa chỉ gateway. Chưa đăng nhập sẽ không truy cập được các chức năng này.

Menu được tích hợp bằng script do gateway phục vụ trên cùng origin, không sửa tệp OpenCode. Bản OpenCode hiện tại chỉ nạp các trang cài đặt GUI tích hợp sẵn, chưa nạp renderer của extension bên ngoài; vì vậy đây là phần tích hợp của Web Login Module, không phải plugin GUI chính thức. Tích hợp menu áp dụng cho giao diện truy cập qua gateway.

**Mặc định:** cập nhật thủ công, kênh bản ổn định. Khi bật tự động, dịch vụ kiểm tra mỗi giờ. Bộ cập nhật chỉ nhận phiên bản cao hơn từ GitHub Release đã công bố của `hgn389/opencode-web-login-module`, xác minh SHA-256 theo GitHub API, kiểm tra nội dung gói và thư viện đã khóa, rồi gọi bộ cài có sao lưu và khôi phục. Không tải mã từ `main`, không hạ phiên bản, không cập nhật OpenCode và không tạo bản phát hành trên GitHub. Bộ cập nhật không tải một phiên bản bằng hoặc thấp hơn bản đang cài.

Yêu cầu giả mạo origin/CSRF bị từ chối. Nhập sai mật khẩu xác nhận cũng tính vào bộ đếm IP: đến 5 lần sẽ yêu cầu đăng nhập lại với CAPTCHA, đến 10 lần khóa IP. Mật khẩu mới không được ghi vào log hoặc repository công khai.

Nếu đang dùng bản module cũ, lấy tag `v1.1.0-beta` ở thư mục mã nguồn rồi chạy lại bước 3 với đầy đủ các tùy chọn cũ. Bản chạy độc lập bằng thư viện/CLI không tự có quyền quản trị; cần bộ cài Linux/systemd để bật đổi mật khẩu và cập nhật.

### 5. Thay đổi cấu hình sau khi cài

Tệp cấu hình dịch vụ là `/etc/opencode-login.env`. Dữ liệu bảo mật nằm tại `/var/lib/opencode-login/security.sqlite`.

| Biến | Giá trị mặc định |
| --- | --- |
| `LOGIN_HOST` | `127.0.0.1` |
| `LOGIN_PORT` | `4096` |
| `OPENCODE_BACKEND_HOST` | `127.0.0.1` |
| `OPENCODE_BACKEND_PORT` | `4097` |
| `LOGIN_STATE_DB` | `~/.local/state/opencode-web-login/security.sqlite` khi chạy độc lập |
| `LOGIN_PUBLIC_ORIGINS` | Rỗng; danh sách domain HTTPS phân cách bằng dấu phẩy |
| `LOGIN_TRUSTED_PROXIES` | `127.0.0.1,::1`; chỉ IP/CIDR của proxy do bạn kiểm soát |
| `LOGIN_ADMIN_SOCKET` | Rỗng khi chạy độc lập; bộ cài đặt `/run/NAME-admin/control.sock` |

CLI `--config` đọc file env. Biến môi trường đã có sẵn được ưu tiên hơn file. Bộ cài Linux đặt `LOGIN_STATE_DB` rõ ràng tại `/var/lib/NAME/security.sqlite`.

Cấu hình quản trị root: `/etc/NAME-admin.json` (`0600`). Tùy chọn cập nhật và trạng thái tác vụ: `/var/lib/NAME-admin/` (`0700`). Sau lần đổi mật khẩu đầu tiên, mật khẩu đang dùng được lưu riêng tại `/etc/NAME-backend-password.env` (`0600`), nạp qua drop-in `90-web-login-password.conf`; bộ cài giữ các tệp này khi cài lại. Không chia sẻ chúng hoặc đưa lên GitHub. Bản sao lưu Git riêng trên máy chủ cũng có thể chứa mật khẩu, cần giữ quyền `0700`.

Khi sửa địa chỉ, cổng, domain hoặc proxy trong `/etc/NAME.env`, chạy lại bộ cài với tùy chọn mới để đồng bộ cấu hình quản trị trước khi dùng cập nhật qua web. Nếu chỉ chỉnh env rồi khởi động gateway, bộ cập nhật vẫn dùng cấu hình cài đặt lần trước.

Sau khi chỉnh cấu hình gateway, khởi động lại dịch vụ:

```sh
sudo systemctl restart opencode-login.service
```

Nếu đổi cổng backend OpenCode, tên dịch vụ hoặc thư mục cài, chạy lại bộ cài với đầy đủ tùy chọn tương ứng để cập nhật đồng bộ. Khi cài lại, bộ cài ghi lại `/etc/opencode-login.env` theo các tùy chọn bạn truyền; hãy truyền cả cấu hình domain và proxy cũ nếu đang sử dụng.

Mỗi instance cần dịch vụ OpenCode, cổng gateway/backend và nơi lưu dữ liệu riêng. Có thể tùy chỉnh bằng `--name`, `--install-dir`, `--public-origins` và `--trusted-proxies`. Xem tất cả tùy chọn:

```sh
node /opt/opencode-web-login-src/bin/opencode-web-login.mjs install --help
```

### 6. Cấu hình domain và HTTPS

Cấu hình chứng chỉ TLS trên reverse proxy, rồi thêm domain bằng `LOGIN_PUBLIC_ORIGINS=https://coding.example.com` hoặc tùy chọn installer `--public-origins`.

Proxy phải giữ public Host, gửi `X-Forwarded-Proto: https` và chuỗi `X-Forwarded-For` chứa IP thật. Proxy đầu tiên phải xử lý header giả do client gửi. Chỉ thêm địa chỉ proxy đã kiểm tra vào `LOGIN_TRUSTED_PROXIES`. Nếu có Cloudflare/proxy nhiều tầng, kiểm tra dải IP và cách chuyển tiếp trước khi thêm trust.

Cấu hình WebSocket upgrade, chuyển HTTP sang HTTPS và chỉ công khai cổng proxy HTTPS. Domain HTTP sẽ được chuyển sang HTTPS; gửi form qua HTTP bị từ chối. Kiểm tra IP thật và khóa IP từ bên ngoài LAN trước khi đưa vào sử dụng.

Ví dụ khi reverse proxy chạy trên cùng máy:

```dotenv
LOGIN_PUBLIC_ORIGINS=https://coding.example.com
LOGIN_TRUSTED_PROXIES=127.0.0.1,::1
```

Thay `coding.example.com` bằng domain của bạn, cấu hình DNS/chứng chỉ và reverse proxy riêng, rồi khởi động lại gateway. Chỉ dùng HTTP trực tiếp trong mạng LAN tin cậy; khi đưa lên Internet, dùng HTTPS và giữ cổng backend OpenCode ở loopback.

## Các quy tắc bảo mật

- Sai tên đăng nhập hoặc mật khẩu 5 lần: hiện CAPTCHA ảnh; những lần tiếp theo phải giải đúng CAPTCHA.
- Sai tên đăng nhập hoặc mật khẩu 10 lần: khóa IP vĩnh viễn đến khi quản trị viên mở khóa.
- Đăng nhập đúng trước khi bị khóa đặt lại bộ đếm lỗi liên tiếp.
- Bộ đếm và khóa IP lưu trong SQLite, giữ qua các lần khởi động lại.
- CAPTCHA tồn tại 5 phút, dùng một lần; sai CAPTCHA không tăng bộ đếm tên đăng nhập/mật khẩu.
- Tối đa 40 yêu cầu vào trang đăng nhập, biểu mẫu và ảnh CAPTCHA mỗi IP mỗi phút; mỗi IP chỉ kiểm tra một mật khẩu tại một thời điểm.
- Phiên tối đa 8 giờ, hết hạn sau 30 phút không có yêu cầu được xác thực; đăng xuất thu hồi phiên ở máy chủ.
- Chặn việc né trang đăng nhập qua Basic Auth, token URL, cookie của OpenCode hoặc liên kết ghép nối.
- Giữ khóa ký CSRF qua lần khởi động lại; các tab cùng trình duyệt dùng chung mã còn hiệu lực. Form tự kiểm tra và làm mới mã trước khi gửi, không tự gửi lại mật khẩu.
- Bảo vệ CSRF, kiểm tra origin và proxy đáng tin cậy; vẫn hỗ trợ SSE và terminal WebSocket.
- Lọc header dành riêng cho từng kết nối, giới hạn thời gian chờ backend và kiểm tra WebSocket upgrade.
- Khi chạy qua domain HTTPS: cookie `__Host-`, Secure, HttpOnly, SameSite=Strict và HSTS.

IP dùng chung cũng dùng chung bộ đếm và khóa. Khóa này chỉ áp dụng tại gateway OpenCode, không chặn các website khác. Các luồng SSE/WebSocket kiểm tra lại phiên mỗi 30 giây. CAPTCHA ảnh là lớp giảm bot; khi mở Internet nên bổ sung MFA hoặc dịch vụ kiểm tra bot chuyên dụng.

## Chạy độc lập thay cho systemd

Cách này dành cho việc chạy thử hoặc tích hợp vào hệ thống khác. OpenCode vẫn phải được cài và cấu hình mật khẩu trước.

Trong một terminal, chạy OpenCode ở loopback:

```sh
opencode serve --hostname 127.0.0.1 --port 4097
```

Trong terminal khác, tại thư mục mã nguồn module:

```sh
cp environment.example login.env
# Chỉnh login.env theo địa chỉ/cổng muốn sử dụng.
node bin/opencode-web-login.mjs serve --config "$PWD/login.env"
```

Gateway mặc định nghe ở `127.0.0.1:4096`. Không chạy cách này đồng thời với dịch vụ đã chiếm cùng cổng. API/CLI OpenCode trên máy chủ có thể kết nối trực tiếp backend loopback; gateway bên ngoài chỉ nhận phiên tạo qua trang đăng nhập.

## Dùng như thư viện

Trong ứng dụng Node.js riêng, cài module từ bản clone trước:

```sh
npm install /opt/opencode-web-login-src
```

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

## Quản trị

```sh
sudo node /opt/opencode-login/bin/opencode-web-login.mjs doctor --config /etc/opencode-login.env

# Đọc/mở khóa database dưới đúng người dùng sở hữu.
sudo -u opencode-login node /opt/opencode-login/bin/opencode-web-login.mjs blocked --config /etc/opencode-login.env
sudo -u opencode-login node /opt/opencode-login/bin/opencode-web-login.mjs unblock 192.0.2.10 --config /etc/opencode-login.env
sudo -u opencode-login node /opt/opencode-login/bin/opencode-web-login.mjs revoke-sessions --config /etc/opencode-login.env

systemctl status opencode-login
journalctl -u opencode-login --since today
```

`doctor` kiểm tra cấu hình và backend có phản hồi JSON yêu cầu xác thực. Nó không thử mật khẩu và không chứng minh mọi API của các phiên bản OpenCode tương lai đều tương thích.

Trên Linux, thư mục cơ sở dữ liệu phải thuộc người chạy dịch vụ và có quyền `0700`; tệp cơ sở dữ liệu/WAL/SHM phải là tệp thường thuộc cùng người dùng, quyền `0600`. Module từ chối tệp liên kết hoặc quyền quá rộng. Không đưa database, WAL hoặc các file env chứa bí mật vào Git hay gói cài đặt. Nhật ký không ghi mật khẩu, đáp án CAPTCHA hoặc session token. Đổi mật khẩu OpenCode khiến native token cũ bị từ chối; gateway thu hồi phiên bị backend từ chối.

## Cập nhật mã nguồn và quy trình phát hành

Repository chính: [hgn389/opencode-web-login-module](https://github.com/hgn389/opencode-web-login-module), nhánh `main`.

Sau khi sửa mã nguồn hoặc lệnh cài đặt, cập nhật README và chạy kiểm tra:

```sh
npm ci --ignore-scripts
npm test
git diff --check
git status --short
```

**Chỉ commit, push hoặc phát hành khi chủ repository ra lệnh rõ ràng.** Chạy kiểm tra không đồng nghĩa với được phép đưa thay đổi lên GitHub. Không tự tăng phiên bản, tạo/push tag, tạo GitHub Release, đưa gói lên npm hoặc tải lên tệp phát hành.

Khi được lệnh đổi phiên bản, cập nhật đồng bộ `package.json`, `npm-shrinkwrap.json`, README và các ghi chú. Footer của trang đăng nhập và trang quản trị lấy số phiên bản trực tiếp từ `package.json`, tránh có một số phiên bản riêng bị quên cập nhật.

`git push` không tự cập nhật dịch vụ trên máy đã cài. Muốn áp dụng mã nguồn mới lên một máy, cập nhật bản clone tại `/opt/opencode-web-login-src`, rồi chạy lại bộ cài với đầy đủ tùy chọn đã dùng trên máy đó.

### Dữ liệu mẫu và bảo vệ thông tin khi đưa lên GitHub

- `IP_SERVER` là tên mẫu để thay bằng IP của máy đích; `PORT` là cổng được chọn khi cài. Ví dụ tổng quát: `http://IP_SERVER:PORT/login`. Với cổng mặc định của module: `http://IP_SERVER:4096/login`.
- Các lệnh dùng `127.0.0.1`/`::1` vì backend cần nghe ở loopback; đây là địa chỉ kỹ thuật dùng chung, không phải IP riêng của một máy chủ.
- Domain trong ví dụ là domain dành cho tài liệu. Repository chính thức và tài khoản chủ repository trong đường dẫn GitHub là thông tin công khai cần cho clone/cập nhật; không phải tài khoản đăng nhập OpenCode.
- Không đưa mật khẩu, token, cấu hình env thực tế, cấu hình quản trị `*-admin.json`, cơ sở dữ liệu/WAL/SHM, khóa riêng, log, ảnh chụp panel, bản sao lưu hoặc thư viện `node_modules` lên GitHub. `.gitignore` loại các tệp vận hành phổ biến; cần kiểm tra thêm tệp đã được theo dõi trong Git trước khi upload.
- Mật khẩu/token trong test là dữ liệu giả, chỉ dùng với dịch vụ và dữ liệu thử nghiệm riêng.
- Quy tắc làm việc nội bộ chỉ lưu tại máy, không nằm trong danh sách tệp công khai hoặc gói cài đặt.
- Tệp đã từng đưa lên GitHub có thể còn trong lịch sử Git hoặc gói phát hành cũ dù đã sửa bản hiện tại. Nếu phát hiện bí mật đã bị công khai, đổi/thu hồi bí mật đó trước rồi xử lý lịch sử và tài sản phát hành theo lệnh của chủ repository.

Bản sao lưu cấu hình trên máy chủ nằm ngoài repository công khai, có quyền truy cập riêng và có thể chứa thông tin đăng nhập. Không đính kèm bản sao lưu vào issue hoặc release.

Test dùng cơ sở dữ liệu tạm và đáp án CAPTCHA cố định chỉ trong tiến trình test riêng. Bản chạy thực tế không có endpoint hoặc tùy chọn bỏ qua CAPTCHA. Các tài nguyên CAPTCHA và giấy phép font được lưu cùng mã nguồn.
