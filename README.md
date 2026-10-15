# OpenCode Web Login Module

Module độc lập cung cấp trang đăng nhập và bảo mật cho OpenCode. Module chạy thành dịch vụ riêng phía trước OpenCode, kết nối qua HTTP API và không cần sửa mã nguồn OpenCode.

**Thứ tự cài đặt: cài OpenCode trước → cấu hình mật khẩu và dịch vụ OpenCode → cài module này → cấu hình domain/HTTPS nếu cần truy cập Internet.**

**Bản thử nghiệm:** [v1.2.1-beta](https://github.com/hgn389/opencode-web-login-module/releases/tag/v1.2.1-beta). Phiên bản gói: `1.2.1-beta`.

**v1.2.1-beta cải tiến quản lý provider: danh sách với nút Sửa/Xóa, popup thêm/sửa gọn hơn, tự quét model và thông báo đen 2 giây. Các thao tác quản trị dùng phiên đăng nhập, không cần nhập lại mật khẩu; gateway kiểm tra phiên với OpenCode trước khi thực hiện lệnh. Hỗ trợ ID như `9router`, header chứa bốn tab và 63 ngôn ngữ. Tự động cập nhật module mặc định tắt; cập nhật/hạ cấp OpenCode luôn thực hiện thủ công.**

**Nâng cấp từ v1.1.2-beta trở xuống:** dùng quy trình nâng cấp thủ công ở bước 2. Bộ cập nhật qua web của các bản cũ từ chối những tệp mới ngoài danh sách đã đóng gói; không dùng nút **Cập nhật ngay** của bản cũ để cài lần chuyển này.

## Cài đặt và cấu hình

### 1. Chuẩn bị OpenCode và công cụ cần thiết

Máy đích cần có:

- OpenCode đã cài, có tài khoản/mật khẩu và dịch vụ Linux đang chạy, ví dụ `opencode.service`. Hỗ trợ OpenCode v2 và OpenCode v1 ổn định từ `1.18.20`.
- OpenCode v2 dùng các API `/api/info`, `/api/pair` và `/auth/connect/:code`. OpenCode v1 dùng `/global/health` và HTTP Basic ở backend; trình duyệt vẫn đăng nhập bằng biểu mẫu của module.
- Node.js **24 trở lên**, npm và Git. Node.js dùng để chạy dịch vụ phải được cài ngoài `/root` và `/home`, ví dụ trong `/usr` hoặc `/usr/local`.
- Linux có systemd và quyền quản trị nếu chọn cài thành dịch vụ. Cập nhật OpenCode qua web cần `flock` và `runuser` (gói `util-linux`).

Kiểm tra trước khi cài module:

```sh
node --version
npm --version
git --version
command -v opencode
sudo systemctl status opencode.service
```

Ghi lại đường dẫn binary từ `command -v opencode` và tên dịch vụ OpenCode thực tế. Các ví dụ bên dưới dùng `/usr/local/bin/opencode` và `opencode.service`; thay chúng theo máy của bạn. Tài khoản/mật khẩu vẫn do OpenCode quản lý, module không tạo một tài khoản khác.

Dùng bản OpenCode v2 được cài theo phương thức chính thức và đặt binary ở vị trí cố định, tránh `/tmp`. Thêm binary tự dựng vào `PATH` giúp terminal gọi được lệnh, nhưng không giúp `opencode upgrade` nhận diện phương thức cài đặt. Binary mà terminal gọi và binary mà dịch vụ OpenCode sử dụng cần trỏ tới cùng bản cài.

### 2. Tải mã nguồn module từ GitHub

```sh
sudo git clone --branch v1.2.1-beta https://github.com/hgn389/opencode-web-login-module.git /opt/opencode-web-login-src
cd /opt/opencode-web-login-src
sudo npm ci --omit=dev --ignore-scripts
node bin/opencode-web-login.mjs --help
```

Lệnh clone trên lấy đúng bản beta đã phát hành, bao gồm các bản sửa bảo mật và menu quản trị. Nếu muốn mã đang phát triển, thay `--branch v1.2.1-beta` bằng `--branch main`; nhánh `main` có thể có thay đổi chưa phát hành. `/opt/opencode-web-login-src` là thư mục mã nguồn. Bộ cài sẽ tạo thư mục dịch vụ riêng tại `/opt/opencode-login`, nên không cần cài global bằng npm để dùng những lệnh dưới đây.

#### Cài từ gói `.tgz` trên GitHub Release

Nếu muốn cài CLI global, tải hai tệp `opencode-web-login-1.2.1-beta.tgz` và `opencode-web-login-1.2.1-beta.tgz.sha256` từ [trang phát hành](https://github.com/hgn389/opencode-web-login-module/releases/tag/v1.2.1-beta). Trong thư mục đã tải, chạy:

```sh
sha256sum --check opencode-web-login-1.2.1-beta.tgz.sha256
sudo npm install -g --ignore-scripts ./opencode-web-login-1.2.1-beta.tgz
opencode-web-login --help
```

Sau khi cài gói, dùng `sudo opencode-web-login install` thay cho `sudo node /opt/opencode-web-login-src/bin/opencode-web-login.mjs install` trong các lệnh ở bước 3, giữ nguyên các tùy chọn phù hợp với máy của bạn. Gói phát hành cần tải thư viện từ npm khi cài đặt; không có mật khẩu hoặc cấu hình của máy chủ trong gói.

#### Nâng cấp từ bản đã cài

Nếu đã clone mã nguồn theo hướng dẫn, chạy trong thư mục mã nguồn:

```sh
cd /opt/opencode-web-login-src
sudo git fetch origin --tags
sudo git checkout --detach v1.2.1-beta
sudo npm ci --omit=dev --ignore-scripts
```

Sau đó chạy lại lệnh **cài thật ở bước 3**, giữ nguyên các tùy chọn cài đặt đang dùng, gồm đường dẫn OpenCode, tên dịch vụ, địa chỉ/cổng, domain và trusted proxy nếu có. Chạy với `--dry-run` trước để kiểm tra. Bộ cài sao lưu, giữ cơ sở dữ liệu phiên/khóa IP và khôi phục khi thất bại. Nếu Git báo có thay đổi cục bộ, lưu hoặc xử lý chúng trước khi chuyển tag; không dùng tùy chọn ép ghi đè.

Nếu đã cài CLI global từ `.tgz`, xác minh SHA-256 rồi cài gói `1.2.1-beta` như trên, sau đó chạy lại `sudo opencode-web-login install` với các tùy chọn cũ. Cài gói global chỉ thay CLI; cần bước `install` để cập nhật dịch vụ đang chạy.

Các bản từ `v1.1.2-beta` trở xuống cần quy trình thủ công này do bản mới bổ sung tệp chương trình và bản dịch. Bản cũ từ chối gói mới một cách an toàn, thay vì bỏ qua những tệp chưa biết. Không cần tắt kiểm tra gói hoặc mở cổng backend để nâng cấp.

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
   Bộ cài bảo vệ mật khẩu đang dùng bằng tệp riêng chỉ root đọc được, che giá trị mật khẩu inline trong thuộc tính systemd và đặt quyền riêng tư cho unit/drop-in có khai báo mật khẩu cũ.
4. Tạo người dùng hệ thống riêng `opencode-login`, không có shell đăng nhập.
5. Chuyển OpenCode sang địa chỉ nội bộ `127.0.0.1:4097`, đặt gateway đăng nhập ở địa chỉ/cổng bạn chọn.
6. Khởi động dịch vụ và kiểm tra cả trang đăng nhập lẫn backend có yêu cầu mật khẩu.
7. Cài dịch vụ quản trị riêng `opencode-login-admin.service`, giao tiếp với gateway qua Unix socket riêng; gateway vẫn chạy bằng người dùng không có quyền root. Tự động cập nhật mặc định tắt.

Bộ cài module không tự cài hoặc cập nhật OpenCode. Bộ cài giữ cơ sở dữ liệu phiên và khóa IP khi cài lại. Nếu cập nhật thất bại sau khi thay đổi dịch vụ, bộ cài khôi phục tệp, thư viện và trạng thái dịch vụ cũ, đồng thời báo vị trí sao lưu Git.

### 4. Kiểm tra và đăng nhập

```sh
sudo systemctl status opencode.service opencode-login.service opencode-login-admin.service
sudo node /opt/opencode-login/bin/opencode-web-login.mjs doctor --config /etc/opencode-login.env
```

Mở một trong các địa chỉ phù hợp với `--host` đã cấu hình:

- Chỉ dùng trên máy chủ: `http://127.0.0.1:4096/login`.
- Dùng trong LAN: `http://IP_SERVER:4096/login`; thay `IP_SERVER` bằng IP của máy đích.

Sau khi cài thành công, bộ cài in trường `loginURL` với đúng cổng vừa cấu hình. Khi bind tất cả interface (`0.0.0.0` hoặc `::`), thông báo dùng `http://IP_SERVER:CỔNG_THỰC_TẾ/login` để bạn thay IP; nếu đã cấu hình domain HTTPS, thông báo dùng domain đó. Với cổng tùy chọn `6699`, ví dụ thông báo là `http://IP_SERVER:6699/login`, không dùng chữ `PORT` trong kết quả cài đặt. Các giá trị này được sinh từ cấu hình trên máy đích, không lưu trong mã nguồn.

Khi bind tất cả interface, gateway chỉ chấp nhận Host là IP của interface trên máy chủ hoặc domain HTTPS đã khai báo, không chấp nhận domain tùy ý. Nếu IP của interface thay đổi, khởi động lại gateway để cập nhật danh sách địa chỉ. Bind tất cả interface không tự mở firewall; vẫn cần giới hạn truy cập LAN hoặc dùng reverse proxy HTTPS.

Nhập tài khoản/mật khẩu OpenCode. Khi đăng nhập thành công, trình duyệt chuyển vào OpenCode. Trang đăng xuất nằm ở `/logout`.

Nếu trình duyệt đang giữ trang đăng nhập cũ, nhấn `Ctrl+F5` rồi thử lại. Nếu trang báo chưa gửi cookie, cho phép cookie cho địa chỉ này. Lỗi phiên hoặc CAPTCHA không được tính là nhập sai tài khoản/mật khẩu.

#### Quản trị qua web

Sau khi đăng nhập, mở **Cài đặt** của OpenCode. Nhóm **Web Login Module** có bốn mục:

- **Đổi mật khẩu:** nhập mật khẩu mới từ 16 đến 128 ký tự, xác nhận lại và đánh dấu đã lưu công việc. Module sao lưu cấu hình bằng Git, đổi mật khẩu thật của OpenCode và khởi động lại dịch vụ. Mọi phiên đăng nhập bị thu hồi; đăng nhập lại bằng mật khẩu mới. Nếu khởi động thất bại, module khôi phục cấu hình trước đó.
- **Cập nhật Web Login Module:** kiểm tra bản mới, chọn kênh **Bản ổn định** hoặc **Bản ổn định và beta**, bật/tắt tự động cập nhật hoặc bấm **Cập nhật ngay**. Các thao tác dùng phiên đăng nhập hiện tại, không yêu cầu nhập lại mật khẩu. Cập nhật thủ công yêu cầu xác nhận đã lưu công việc; tự động cập nhật cũng sẽ khởi động lại dịch vụ khi có bản mới.
- **Update & Downgrade**: xem phiên bản đang chạy/đã cài, kiểm tra bản mới nhất của nhánh hiện tại, chọn phiên bản muốn cập nhật hoặc hạ cấp. Hỗ trợ OpenCode v2 và v1 từ `1.18.20`. Xác nhận đã lưu công việc rồi bấm nút xác nhận tương ứng; thao tác luôn chạy thủ công, có sao lưu và khôi phục khi thất bại.

- **Nhà cung cấp tùy chỉnh**: thêm, sửa hoặc xóa provider OpenAI-compatible trong cấu hình OpenCode v2; khai báo Base URL, API key và model qua web, có sao lưu riêng và kiểm tra sau khi tải lại cấu hình.

Trên điện thoại, các nút xuất hiện ngay dưới thanh điều hướng Cài đặt. Nếu bản OpenCode khác đã đổi cấu trúc menu, mở trực tiếp `/web-login/password`, `/web-login/updates`, `/web-login/opencode` hoặc `/web-login/providers` trên cùng địa chỉ gateway. Chưa đăng nhập sẽ không truy cập được các chức năng này.

**Đa ngôn ngữ:** module đồng bộ **63 ngôn ngữ** với bộ chọn ngôn ngữ của OpenCode hiện tại. Đổi ngôn ngữ trong OpenCode sẽ cập nhật menu, tiêu đề popup và biểu mẫu đang mở; dữ liệu nhập và các lựa chọn model được giữ lại. Ngôn ngữ viết từ phải sang trái có bố cục RTL. Các trường URL, API key và Model ID vẫn hiển thị từ trái sang phải để tránh đọc nhầm.

Trang đăng nhập có bộ chọn ngôn ngữ riêng. Lựa chọn được lưu trong trình duyệt và dùng cho OpenCode khi đăng nhập; khi chưa có lựa chọn, module dùng ngôn ngữ trình duyệt. Trang đăng xuất, CAPTCHA, lỗi đăng nhập và thông báo quản trị cũng được dịch. Ngôn ngữ chưa hỗ trợ hoặc khóa dịch còn thiếu dùng bản tiếng Anh dự phòng. Bản dịch được đóng gói cùng module, không gọi dịch vụ dịch bên ngoài trong quá trình sử dụng và không gửi thông tin đăng nhập đi để dịch.

Popup quản trị có kích thước tối đa **960 × 1060 px**, tự thu nhỏ theo cửa sổ trình duyệt, chừa khoảng cách với mép màn hình. Bốn tab chức năng nằm trên header cùng hàng với nút **Đóng**; màn hình hẹp có thể cuộn ngang các tab trong khi nút đóng luôn hiển thị. Nội dung dài cuộn bên trong popup. Khi mở trực tiếp một trang `/web-login/...`, các liên kết điều hướng vẫn nằm trên trang.

Thông báo thao tác xuất hiện dưới dạng popup đen ở cuối cửa sổ và tự ẩn sau khoảng **2 giây**, không đẩy nội dung biểu mẫu. Trạng thái quét và kết quả tác vụ vẫn nằm trong khối liên quan để xem lại. Giao diện dùng nền dịu, các khối có viền bo tròn và bóng nhẹ, có chế độ tối theo trình duyệt; khối Model và từng dòng model có khung riêng.

Menu được tích hợp bằng script do gateway phục vụ trên cùng origin, không sửa tệp OpenCode. Bản OpenCode hiện tại chỉ nạp các trang cài đặt GUI tích hợp sẵn, chưa nạp renderer của extension bên ngoài; vì vậy đây là phần tích hợp của Web Login Module, không phải plugin GUI chính thức. Tích hợp menu áp dụng cho giao diện truy cập qua gateway.

**Mặc định:** cập nhật thủ công, kênh bản ổn định. Khi bật tự động, dịch vụ kiểm tra mỗi giờ. Bộ cập nhật chỉ nhận phiên bản cao hơn từ GitHub Release đã công bố của `hgn389/opencode-web-login-module`, xác minh SHA-256 theo GitHub API, kiểm tra nội dung gói và thư viện đã khóa, rồi gọi bộ cài có sao lưu và khôi phục. Không tải mã từ `main`, không hạ phiên bản, không cập nhật OpenCode và không tạo bản phát hành trên GitHub. Bộ cập nhật không tải một phiên bản bằng hoặc thấp hơn bản đang cài.

Tắt tự động cập nhật hoặc lưu lại cấu hình sẽ hủy kết quả kiểm tra đang chờ trước đó. Tác vụ cập nhật đang chuẩn bị bị hủy nếu thông tin đăng nhập backend thay đổi trong lúc chờ kết quả từ GitHub.

Trang cập nhật tiếp tục kiểm tra kết quả khi dịch vụ tạm ngắt kết nối trong lúc khởi động lại. Mất phiên hoặc bị từ chối quyền truy cập sẽ dừng kiểm tra; chức năng này không tự gửi lại lệnh cài đặt.

Các chức năng quản trị dùng phiên đăng nhập hiện tại, không yêu cầu nhập lại mật khẩu. Yêu cầu thiếu phiên, giả mạo origin/CSRF bị từ chối. Trước khi chuyển lệnh quản trị tới dịch vụ root, gateway kiểm tra lại phiên đang tồn tại và được backend OpenCode chấp nhận; phiên đã đăng xuất, bị thu hồi hoặc backend từ chối không thể gửi lệnh mới. Các thao tác khởi động lại, cập nhật/hạ cấp hoặc lưu/xóa provider vẫn cần ô xác nhận. Quét model và lưu cấu hình cập nhật không cần ô xác nhận khởi động lại. Bộ đếm nhập sai mật khẩu chỉ áp dụng cho đăng nhập: đến 5 lần hiện CAPTCHA, đến 10 lần khóa IP; thao tác quản trị thành công không xóa bộ đếm này. Mật khẩu mới không được ghi vào log hoặc repository công khai.

Đăng nhập tạm dừng khi đang đổi mật khẩu, cập nhật OpenCode hoặc cần khôi phục tác vụ bị gián đoạn, không tính thành nhập sai. Nếu đã bật dịch vụ quản trị nhưng dịch vụ này không phản hồi, gateway tạm từ chối tạo phiên mới. Thu hồi toàn bộ phiên, kể cả bằng CLI, cũng vô hiệu hóa những lần đăng nhập đang xử lý để chúng không tạo lại phiên sau lệnh thu hồi.

Nếu đang dùng bản module cũ, lấy tag `v1.2.1-beta` ở thư mục mã nguồn rồi chạy lại bước 3 với đầy đủ các tùy chọn cũ. Bản chạy độc lập bằng thư viện/CLI không tự có quyền quản trị; cần bộ cài Linux/systemd để bật đổi mật khẩu và cập nhật.

#### Cập nhật OpenCode qua terminal

Với OpenCode được cài theo phương thức chính thức, lưu công việc rồi chạy:

```sh
sudo opencode upgrade
sudo systemctl restart opencode.service
opencode --version
```

Thay `opencode.service` bằng tên dịch vụ thực tế nếu khác. Lệnh khởi động lại sẽ ngắt kết nối web trong thời gian dịch vụ khởi động. Nếu binary mới nằm ở đường dẫn khác, chạy lại bước 3 với `--opencode-bin` mới và đầy đủ tùy chọn đang dùng để đồng bộ cấu hình quản trị.

Nếu gặp `Could not detect the installation method`, cần chuyển bản dựng/sao chép thủ công sang phương thức cài chính thức và đồng bộ đường dẫn dịch vụ trước. Khi chuyển kênh hoặc bản dựng OpenCode, sao lưu dữ liệu và kiểm tra tệp cơ sở dữ liệu; các kênh có thể dùng tên tệp khác nhau.

Menu **Cập nhật Web Login Module** quản lý phiên bản của module. Nâng cấp OpenCode thực hiện bằng các lệnh trên hoặc mục **Update & Downgrade** trong bản này.

#### Update & Downgrade qua web

Yêu cầu OpenCode v2 ổn định với gói chính thức `@opencode/cli`, hoặc OpenCode v1 ổn định từ `1.18.20` với gói `opencode-ai`, cài global bằng npm. Binary phải ở đường dẫn cố định ngoài `/root`, `/home`, `/tmp`; các tệp và thư mục cài đặt do root quản lý, không cho nhóm/người khác ghi. Binary của terminal, cấu hình quản trị và dịch vụ OpenCode cần dùng chung bản cài. Với bản tự dựng hoặc phương thức khác, trang vẫn có thể đọc phiên bản đang chạy nhưng sẽ giải thích vì sao chưa hỗ trợ cập nhật qua web.

Mở **Cài đặt → Web Login Module → Update & Downgrade**, hoặc `/web-login/opencode` sau khi đăng nhập:

1. Bấm **Kiểm tra phiên bản** để tải bản mới nhất của nhánh đang dùng và danh sách các phiên bản ổn định gần đây từ kho chính thức.
2. Trong **Phiên bản muốn cài**, chọn phiên bản cần dùng, ví dụ `v1.18.20`. Chọn bản thấp hơn để hạ cấp, bản cao hơn để cập nhật; để lựa chọn mặc định nếu muốn bản mới nhất của nhánh hiện tại.
3. Đánh dấu đã lưu công việc.
4. Bấm **Xác nhận hạ cấp v1.18.20** hoặc nút xác nhận cập nhật tương ứng. Trang sẽ theo dõi kết quả khi dịch vụ khởi động lại. Nếu đổi nhánh v1/v2, mọi phiên đăng nhập được thu hồi; đăng nhập lại sau khi hoàn tất.

Chỉ cho chọn bản ổn định từ danh sách chính thức, chưa hỗ trợ beta hoặc v1 trước `1.18.20`. Phiên bản được kiểm tra lại phía máy chủ; không nhận URL hay lệnh cài từ trình duyệt. Thay lựa chọn phiên bản sẽ bỏ đánh dấu xác nhận trước đó. Bản đang cài không được cài lại khi không cần khởi động lại.

Đánh dấu xác nhận đã lưu công việc. Bộ cập nhật tải gói từ `registry.npmjs.org`, xác minh SHA-512, chuẩn bị và kiểm tra binary trước khi dừng dịch vụ. Các lifecycle script của npm bị tắt; binary được kiểm tra bằng người dùng chạy dịch vụ OpenCode. Tệp cài đặt được sao lưu bằng Git riêng, còn cơ sở dữ liệu SQLite được sao lưu nhất quán bằng tài khoản dịch vụ trước khi thay bản cài. Trình duyệt chỉ gửi số phiên bản đã chọn trong danh sách; máy chủ tự xác định gói và URL chính thức, kiểm tra metadata cùng checksum. Không nhận tên gói, URL hoặc lệnh shell tùy ý.

Sau khi cập nhật, bộ quản trị kiểm tra đúng phiên bản, yêu cầu mật khẩu của backend và danh sách hội thoại. Nếu thất bại, bộ quản trị khôi phục bản cài và cơ sở dữ liệu đã sao lưu rồi khởi động lại. Giao diện tiếp tục theo dõi kết quả khi dịch vụ tạm ngắt kết nối. Thay binary dùng tệp tạm và đổi tên nguyên tử, từ chối đích là liên kết tệp. Bộ cập nhật và lệnh khôi phục dùng chung khóa hệ thống, tự nhả khi tiến trình kết thúc. Mỗi thời điểm chỉ chạy một tác vụ đổi mật khẩu hoặc cập nhật; tự động cập nhật module không tự cập nhật OpenCode.

**Dữ liệu khi hạ cấp:** giữa các bản cùng nhánh, cơ sở dữ liệu được sao lưu trước khi thay bản cài; nếu bản cũ không đọc được dữ liệu mới, bộ quản trị khôi phục bản cài và dữ liệu trước đó. Khi chuyển v2 ↔ v1, mỗi nhánh dùng một cơ sở dữ liệu hội thoại riêng; không mở cơ sở dữ liệu v2 bằng binary v1, không tự chuyển hội thoại giữa hai nhánh. Lần đầu chuyển nhánh có thể chưa có hội thoại; trở lại nhánh cũ sẽ dùng lại dữ liệu của nhánh đó. Cấu hình và thông tin nhà cung cấp vẫn ở vị trí hiện tại; nếu cấu hình không tương thích, cập nhật thất bại sẽ khôi phục bản trước.

Ánh xạ cơ sở dữ liệu của hai nhánh nằm trong `/var/lib/NAME-admin/database-branches.json` và drop-in `95-web-login-version.conf` của dịch vụ OpenCode. Không sửa những tệp này khi đang cập nhật. Khi chọn phiên bản thủ công, bộ quản trị đặt `OPENCODE_DISABLE_AUTOUPDATE=1` trong drop-in `96-web-login-manual-version.conf`, tránh OpenCode tự nâng lại bản vừa hạ. Thiết lập này được sao lưu và khôi phục nếu tác vụ thất bại; cơ chế tự cập nhật riêng của Web Login Module giữ nguyên cấu hình đã chọn.

Với OpenCode v1, thông tin xác thực backend của mỗi phiên được mã hóa AES-256-GCM, gắn với origin và lưu trong cơ sở dữ liệu bảo mật riêng. Khóa mã hóa nằm tại tệp `security.sqlite.key`, quyền `0600`, cùng thư mục trạng thái riêng `0700`; không đưa cả cơ sở dữ liệu lẫn khóa lên GitHub. Trình duyệt chỉ giữ cookie phiên ngẫu nhiên, không giữ mật khẩu backend hoặc hiển thị popup Basic Auth.

Bản sao lưu nằm tại `/var/lib/NAME-opencode-backup/`, quyền `0700`; có thể chứa hội thoại riêng và các binary dung lượng lớn. Không đưa thư mục này lên GitHub. Giữ đủ dung lượng đĩa cho bản chuẩn bị và bản sao lưu; module giữ lại bản sao lưu để quản trị viên kiểm tra.

Nếu tác vụ bị ngắt đột ngột hoặc báo cần khôi phục, kiểm tra dịch vụ và bản sao lưu bằng SSH. Với bộ cài mặc định, có thể yêu cầu khôi phục tác vụ OpenCode bị gián đoạn:

```sh
sudo node /opt/opencode-login/admin-service.mjs opencode-recover /etc/opencode-login-admin.json
```

Thay đường dẫn/tên dịch vụ theo instance nếu đã tùy chỉnh. Lệnh này chỉ dùng cho tác vụ bị gián đoạn, từ chối khi bộ cập nhật hoặc một lệnh khôi phục khác còn chạy, hoặc tác vụ đã thành công. Nếu tác vụ bị ngắt trước khi dừng dịch vụ và chưa tạo bản sao lưu, lệnh chỉ gỡ trạng thái chờ khôi phục sau khi xác nhận bản cài cũ cùng dịch vụ có yêu cầu mật khẩu vẫn hoạt động; không dừng hay cài lại dịch vụ trong trường hợp này. Không tự thử lại lệnh cập nhật khi chưa xử lý trạng thái cần khôi phục.

#### Nhà cung cấp tùy chỉnh cho OpenCode v2

Chức năng này lưu provider bằng cấu hình tệp, theo cách khắc phục trong [báo cáo lỗi Custom Provider #53873](https://github.com/anomalyco/opencode/issues/53873) và [hướng dẫn provider của OpenCode v2](https://dev.opencode.ai/v2/docs/providers/). Đây là biểu mẫu riêng của module khi truy cập qua gateway; không sửa chương trình OpenCode hoặc biểu mẫu của ứng dụng Desktop. Desktop dùng chung backend có thể sử dụng model đã cấu hình trên backend đó; Desktop chạy backend riêng cần cấu hình riêng.

Mở **Cài đặt → Web Login Module → Nhà cung cấp tùy chỉnh**, hoặc `/web-login/providers` sau khi đăng nhập:

1. Trang đầu hiển thị khối **Danh sách nhà cung cấp đang được kết nối** và nút **Tải lại danh sách**. Bấm vào tên hoặc nút **Sửa** bên cạnh provider để mở popup chỉnh sửa. Nút **Xóa nhà cung cấp** ngay sau **Sửa** mở popup xác nhận riêng, hiển thị đúng tên/ID cần xóa; tích đồng ý tải lại cấu hình rồi bấm xóa, hoặc **Đóng** để hủy. Bấm **Thêm nhà cung cấp mới** để mở popup trống; biểu mẫu chỉ hiển thị trong popup. Danh sách gồm provider trong tệp cấu hình mà module đang quản lý; provider dùng kiểu cấu hình khác được hiển thị nhưng không sửa bằng biểu mẫu OpenAI-compatible.

   Popup thêm/sửa dùng bố cục gọn: các trường đặt thành hai cột trên màn hình rộng, một cột trên màn hình nhỏ; giảm khoảng cách và chiều cao ô nhập/nút bấm. Từng model dùng một dòng gọn trên desktop, hai ô xếp dọc trên điện thoại; nút **×** bỏ dòng model. Danh sách model cuộn trong khung riêng, giữ các xác nhận HTTP/LAN và thông tin trợ giúp.
2. Nhập **ID**, **Tên hiển thị**, **Base URL** và API key nếu API yêu cầu. ID tối đa 63 ký tự, bắt đầu bằng chữ thường hoặc số, sau đó dùng chữ thường, số, dấu gạch ngang hoặc gạch dưới; ví dụ `9router`, `my-router` hoặc `my-openrouter`. Không dùng ID có sẵn của OpenCode như `openrouter`; chọn ID riêng để tránh ghi đè. URL mẫu `https://api.example.com/v1` cần thay theo dịch vụ thực tế.
3. Sau khi nhập **Base URL** và **API key**, rời ô nhập để module tự quét sau khoảng **1 giây**. HTTP cần tích xác nhận trước; router localhost/LAN cần tích cho phép mạng nội bộ. Module không quét khi đang gõ trong ô URL/API key, không lặp lại cùng lượt nhập hoặc tự lưu cấu hình. Có thể bấm **Quét model** để thử lại, quét API không dùng khóa hoặc dùng khóa đã lưu; cũng có thể nhập Model ID thủ công. Dùng **Select All** để chọn tất cả, **Uncheck All** để bỏ chọn tất cả, sau đó đánh dấu các model cần dùng. Chỉ model được chọn mới được lưu; tối đa 2000 model. Tên hiển thị model là tùy chọn.
4. Xác nhận đồng ý tải lại cấu hình rồi bấm **Lưu nhà cung cấp**. Module kiểm tra provider và model đã xuất hiện trong OpenCode, không gửi yêu cầu tạo nội dung có tính phí để thử API key.
5. Khi lưu thành công, popup đóng và danh sách được cập nhật. Tải lại giao diện OpenCode và chọn model dạng `my-provider/MODEL_ID`. Để xóa, mở popup sửa provider, xác nhận rồi bấm **Xóa nhà cung cấp**. Nút **Đóng** hoặc phím **Esc** chỉ đóng popup thêm/sửa, đưa bạn về danh sách. Đóng popup khi đang quét sẽ bỏ qua kết quả quét đó; các ô chưa lưu và API key đang nhập được xóa khi đóng. Nếu đã gửi lệnh lưu/xóa, tác vụ vẫn hoàn tất và danh sách được cập nhật; lỗi lưu giữ popup đang mở để kiểm tra lại.

**Quét model:** hỗ trợ API danh sách model OpenAI-compatible, gồm [9router](https://github.com/decolua/9router), [OmniRoute](https://github.com/devolkus/omniroute) và [OpenRouter](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties). Với OpenRouter, Base URL là `https://openrouter.ai/api/v1`; với router tự triển khai, dùng `http://IP_SERVER:PORT/v1` hoặc URL HTTPS thực tế của router. Kết nối được thực hiện từ máy chủ chạy module; `localhost` chỉ máy chủ đó. Router localhost/LAN cần đánh dấu **Cho phép quét router trên máy chủ hoặc mạng nội bộ**; HTTP còn cần xác nhận dùng kết nối không mã hóa.

Quét chỉ gọi `GET /models`, không gửi yêu cầu chat, không lưu provider và không khởi động lại OpenCode. Danh sách được gộp với model trong biểu mẫu, giữ nguyên tên và lựa chọn đang có, bỏ mục trùng/không hợp lệ. Model mới được chọn sẵn; hãy bỏ chọn những model không cần rồi xác nhận **Lưu nhà cung cấp**. Danh sách từ router có thể gồm model chưa được tài khoản của bạn cấp quyền; quét thành công không xác nhận khả năng gọi từng model. API không hỗ trợ `/models` vẫn có thể khai báo model thủ công.

Nếu bấm **Quét model** chưa có kết quả, đọc thông báo ngay dưới các nút quét/chọn model: module hiển thị tại đây cả lỗi Base URL, thiếu xác nhận HTTP và lỗi kết nối/API. API key là khóa do router cấp; quét model không cần nhập lại mật khẩu OpenCode. Base URL phải truy cập được từ máy chủ chạy module; không dùng `localhost` để chỉ một router đang chạy trên máy tính khác.

Quét yêu cầu phiên đăng nhập hợp lệ và CSRF; tối đa 6 lần mỗi phút, một yêu cầu quét tại một thời điểm. API key được gửi bằng Bearer từ máy chủ tới đúng Base URL đã nhập, không chuyển tiếp qua redirect. Module kiểm tra địa chỉ DNS và cố định IP cho kết nối để ngăn DNS rebinding; mặc định chặn địa chỉ nội bộ, luôn chặn metadata và địa chỉ đặc biệt. Có giới hạn thời gian, kích thước phản hồi và số model. Không phản chiếu nội dung lỗi từ nhà cung cấp về trình duyệt.

Khi sửa provider cùng Base URL, quét có thể dùng khóa đã lưu bằng module mà không trả khóa về trình duyệt. Khóa dùng tham chiếu môi trường hoặc tệp bên ngoài module cần nhập lại để quét. Đổi Base URL cần nhập lại hoặc xóa khóa, kể cả khi chỉ quét model. Nếu cấu hình thay đổi trong lúc quét, kết quả bị từ chối để bạn tải lại danh sách.

Khóa đã lưu không được điền lại vào biểu mẫu. Để trống API key khi sửa để giữ khóa hiện tại, nhập khóa mới để thay, hoặc đánh dấu **Xóa cấu hình API key hiện tại**. Khi đổi Base URL, cần nhập lại hoặc xóa khóa nhằm tránh tự gửi khóa cũ tới địa chỉ mới. HTTPS được ưu tiên; HTTP cần xác nhận riêng vì thông tin gửi tới nhà cung cấp không được mã hóa trên đường truyền. URL không nhận user/password, query, fragment hoặc biến tham chiếu từ biểu mẫu.

Module dùng tài khoản chạy dịch vụ OpenCode để đọc và sửa cấu hình toàn cục `~/.config/opencode/opencode.json(c)`, có xét `XDG_CONFIG_HOME`; nếu dịch vụ khai báo `OPENCODE_CONFIG` thì dùng tệp đó. Khi có cả JSON và JSONC trong cùng thư mục, chọn JSONC theo thứ tự ưu tiên của OpenCode. Không cho trình duyệt chọn đường dẫn tệp hoặc gói thực thi. Cấu hình inline `OPENCODE_CONFIG_CONTENT`, tệp có liên kết, quyền không an toàn hoặc cấu trúc không được hỗ trợ sẽ bị từ chối thay vì ghi đè.

Các phần cấu hình khác và chú thích JSONC không liên quan được giữ lại. Chỉ sửa provider dùng package cố định `@opencode/ai/providers/openai-compatible`; không tự đổi package hoặc sửa provider dùng kiểu khác. Provider có hơn 2000 model cần sửa bằng tệp để tránh bỏ sót model. Tệp cấu hình vẫn được giới hạn ở 1 MiB; nếu vượt giới hạn, module từ chối ghi và giữ cấu hình hiện tại. Không ghi đè ID đã được provider có sẵn hoặc cấu hình khác sử dụng. Nếu provider là model mặc định trong tệp đang sửa, cần đổi model mặc định trước khi xóa; khi lưu cũng không được bỏ chọn model mặc định đó. Cấu hình của dự án hoặc cấu hình quản trị cấp cao hơn vẫn có thể ưu tiên hơn cấu hình toàn cục.

API key nằm trong `.web-login-secrets/PROVIDER_ID-RANDOM.key` bên cạnh tệp cấu hình, thư mục `0700`, tệp `0600`; cấu hình chỉ chứa tham chiếu `{file:...}`. Mỗi lần thay khóa dùng một tệp mới, sau đó mới đổi tham chiếu cấu hình, tránh dùng lẫn khóa khi chuyển endpoint. Tệp cấu hình sau khi sửa có quyền `0600`. Khóa và mật khẩu mới không đi vào tham số dòng lệnh, log của module, phản hồi quản trị hoặc repository công khai. Khi đọc cấu hình/provider/model qua gateway, module che các trường nhạy cảm như `apiKey` và `Authorization`, bao gồm đường dẫn mã hóa. Không mở trực tiếp cổng backend ra Internet.

Trước khi ghi, module sao lưu cấu hình cùng khóa liên quan bằng Git riêng tại `~/.local/state/opencode-web-login/provider-backup` của tài khoản OpenCode, có xét `XDG_STATE_HOME`; thư mục quyền `0700`, tệp sao lưu `0600`. Bản sao lưu có thể chứa khóa cũ nên phải được giữ riêng. Các tệp khóa cũ cũng có thể được giữ trong thư mục bí mật để không làm hỏng tham chiếu thủ công của cấu hình khác; xóa provider không xóa bản sao lưu. Không upload cấu hình, khóa hoặc bản sao lưu lên GitHub.

Thao tác ghi dùng khóa hệ thống và thay tệp nguyên tử; kiểm tra revision để tránh ghi đè thay đổi từ tab khác hoặc terminal. Nếu có xung đột, bấm **Tải lại danh sách** rồi sửa lại. Sau khi ghi, module gọi chức năng tải lại cấu hình của OpenCode, kiểm tra danh sách provider/model và cố khôi phục nếu không áp dụng được. Tải lại cấu hình không khởi động lại tiến trình dịch vụ, nhưng có thể hủy các yêu cầu xác nhận đang chờ. Các thao tác provider, đổi mật khẩu và cập nhật dùng chung hàng đợi quản trị.

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

Cấu hình quản trị root: `/etc/NAME-admin.json` (`0600`). Tùy chọn cập nhật và trạng thái tác vụ: `/var/lib/NAME-admin/` (`0700`). Ngay từ khi cài, mật khẩu đang dùng được lưu riêng tại `/etc/NAME-backend-password.env` (`0600`), nạp qua drop-in `90-web-login-password.conf`; bộ cài giữ mật khẩu thực tế của tiến trình OpenCode khi cài lại. Giá trị inline của hai biến mật khẩu được đặt rỗng trong thuộc tính systemd, còn unit/drop-in có khai báo mật khẩu cũ được đặt quyền `0600`. Nếu có drop-in khác ghi đè làm lộ mật khẩu qua thuộc tính systemd, bộ cài từ chối và khôi phục cấu hình. Không chia sẻ những tệp này hoặc đưa lên GitHub. Bản sao lưu Git riêng trên máy chủ cũng có thể chứa mật khẩu, cần giữ quyền `0700`.

Sau khi từng dùng mật khẩu inline trong unit đọc được bởi người khác, nên đổi mật khẩu qua menu **Đổi mật khẩu**. Việc bảo vệ cấu hình giữ nguyên mật khẩu đang dùng, không thu hồi những bản sao đã được đọc trước đó. Tiến trình OpenCode và tài khoản hệ thống chạy tiến trình đó vẫn có quyền đọc mật khẩu cần cho hoạt động của OpenCode.

Dịch vụ quản trị từ chối thư mục dữ liệu có quyền truy cập cho nhóm/người khác, tệp dữ liệu không riêng tư hoặc symlink. Thư mục Unix socket không được cho phép nhóm ghi. IP bị khóa vẫn chịu giới hạn yêu cầu; API trả lỗi JSON để giao diện hiển thị đúng thông báo.

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

- Chặn API ghép nối và kết nối xác thực native cả khi đường dẫn có mã hóa, dấu `/` lặp lại hoặc dấu `/` cuối.
- WebSocket chỉ chuyển dữ liệu sau khi xác minh phản hồi upgrade hợp lệ; không chuyển cookie native hoặc header yêu cầu Basic Auth về trình duyệt. Yêu cầu có body bị từ chối, socket bị từ chối được đóng và mỗi IP được thử tối đa 60 kết nối WebSocket/phút.
- Khi đổi mật khẩu, tác vụ quản trị thu hồi phiên trực tiếp từ database sau khi backend xác nhận mật khẩu mới, kể cả khi kết nối đến trình duyệt đã ngắt.

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

Trên Linux, thư mục cơ sở dữ liệu phải thuộc người chạy dịch vụ và có quyền `0700`; tệp cơ sở dữ liệu/WAL/SHM phải là tệp thường thuộc cùng người dùng, quyền `0600`. Những kiểm tra này áp dụng cho gateway và cả lệnh quản trị CLI. Module từ chối tệp liên kết, quyền quá rộng hoặc thư mục cha có thể bị tài khoản khác thay thế; thư mục tạm do root sở hữu có sticky bit như `/tmp` được hỗ trợ. Không đưa database, WAL hoặc các file env chứa bí mật vào Git hay gói cài đặt. Nhật ký không ghi mật khẩu, đáp án CAPTCHA hoặc session token. Gateway thu hồi toàn bộ phiên khi đổi mật khẩu và thu hồi riêng phiên bị backend từ chối.

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
- Không đưa mật khẩu, token, cấu hình env thực tế, cấu hình quản trị `*-admin.json`, cơ sở dữ liệu/WAL/SHM, khóa `security.sqlite.key`, khóa riêng, log, ảnh chụp panel, bản sao lưu hoặc thư viện `node_modules` lên GitHub. `.gitignore` loại các tệp vận hành phổ biến; cần kiểm tra thêm tệp đã được theo dõi trong Git trước khi upload.
- Mật khẩu/token trong test là dữ liệu giả, chỉ dùng với dịch vụ và dữ liệu thử nghiệm riêng.
- Quy tắc làm việc nội bộ chỉ lưu tại máy, không nằm trong danh sách tệp công khai hoặc gói cài đặt.
- Tệp đã từng đưa lên GitHub có thể còn trong lịch sử Git hoặc gói phát hành cũ dù đã sửa bản hiện tại. Nếu phát hiện bí mật đã bị công khai, đổi/thu hồi bí mật đó trước rồi xử lý lịch sử và tài sản phát hành theo lệnh của chủ repository.

Bản sao lưu cấu hình trên máy chủ nằm ngoài repository công khai, có quyền truy cập riêng và có thể chứa thông tin đăng nhập. Không đính kèm bản sao lưu vào issue hoặc release.

Test dùng cơ sở dữ liệu tạm và đáp án CAPTCHA cố định chỉ trong tiến trình test riêng. Bản chạy thực tế không có endpoint hoặc tùy chọn bỏ qua CAPTCHA. Các tài nguyên CAPTCHA và giấy phép font được lưu cùng mã nguồn.

### Bảo trì bản dịch

Danh sách ngôn ngữ và chiều hiển thị nằm trong `locales.json`; mỗi tệp `locales/CODE.json` chứa cùng bộ khóa. `vi.json` giữ câu gốc, `en.json` là bản dự phòng. Khi thêm hoặc sửa câu giao diện, cập nhật các tệp dịch tương ứng; giữ nguyên các biến `{0}`, `{1}` và đường dẫn/API kỹ thuật. Chạy `npm test` để kiểm tra đủ khóa, biến nội suy, tài nguyên cài đặt và hành vi đồng bộ ngôn ngữ. Không đưa thông tin riêng của máy chủ vào bản dịch.
