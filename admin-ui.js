(() => {
  'use strict';
  const notice = document.querySelector('#notice');
  const passwordPage = location.pathname.endsWith('/password');
  const nativePage = location.pathname.endsWith('/opencode');
  document.querySelector(passwordPage ? '#password-page' : nativePage ? '#opencode-page' : '#updates-page').hidden = false;
  document.title = `${passwordPage ? 'Đổi mật khẩu' : nativePage ? 'Cập nhật OpenCode' : 'Cập nhật Web Login Module'} · OpenCode`;
  document.querySelectorAll('form button, #check-update, #native-check').forEach(button => { button.disabled = true; });
  let csrf, busy = false, available = false, timer, reconnecting = false, watchingJob = false;
  const message = text => { notice.textContent = text; };
  async function call(operation, fields) {
    const response = await fetch(`/web-login/api/${operation}`, {
      method: fields === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'x-opencode-login': '1', ...(fields !== undefined ? { 'content-type': 'application/json', 'x-web-login-csrf': csrf } : {}) },
      ...(fields !== undefined ? { body: JSON.stringify(fields) } : {}), signal: AbortSignal.timeout(25000),
    });
    const data = await response.json();
    if (response.status === 401 && data.loginRequired) {
      message('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
      setTimeout(() => { window.top.location.href = '/login'; }, 1500);
    }
    if (!response.ok) throw Object.assign(new Error(data.message || 'Không xử lý được yêu cầu.'), { status: response.status });
    return data;
  }
  function scheduleRefresh(delay = 3000) {
    clearTimeout(timer);
    timer = setTimeout(refreshWithRetry, delay);
  }
  async function refreshWithRetry() {
    try {
      await refresh();
      if (reconnecting) { reconnecting = false; message('Đã kết nối lại với dịch vụ.'); }
    } catch (error) {
      available = false;
      document.querySelectorAll('form button, #check-update, #native-check').forEach(button => { button.disabled = true; });
      if ([401, 403].includes(error.status)) { clearTimeout(timer); message(error.message); return; }
      reconnecting = true;
      message('Tạm mất kết nối với dịch vụ. Đang chờ kết nối lại để kiểm tra trạng thái.');
      scheduleRefresh(error.status === 429 ? 60000 : 5000);
    }
  }
  function draw(data) {
    if (data.csrf) csrf = data.csrf;
    available = data.available;
    const running = ['starting', 'running'].includes(data.job?.phase);
    if (['succeeded', 'failed'].includes(data.job?.phase)) watchingJob = false;
    const locked = running || watchingJob || data.job?.recoveryRequired;
    document.querySelectorAll('form button').forEach(button => { button.disabled = busy || !available || locked; });
    document.querySelectorAll('#check-update, #native-check').forEach(button => { button.disabled = busy || !available; });
    clearTimeout(timer);
    if (running || watchingJob) scheduleRefresh();
    if (!available) { message(data.message || 'Chưa bật dịch vụ quản trị. Cài lại module bằng bộ cài Linux để sử dụng.'); return; }
    if (passwordPage) return;
    if (nativePage) {
      const info = data.opencode || {};
      document.querySelector('#native-version').textContent = info.version || 'Chưa đọc được';
      document.querySelector('#native-installed').textContent = info.installedVersion || 'Chưa nhận diện được';
      document.querySelector('#native-release').textContent = info.release?.version || (info.checked ? info.checkError || 'Chưa có bản v2 ổn định được hỗ trợ' : 'Chưa kiểm tra');
      document.querySelector('#native-checked').textContent = info.checked ? new Date(info.checked).toLocaleString('vi-VN') : 'Chưa kiểm tra';
      document.querySelector('#native-support').textContent = info.reason || (info.pendingRestart ? 'Bản đã cài khác bản đang chạy. Cần khởi động lại để áp dụng.' : info.checked && !info.checkError && !info.canUpdate && !locked ? 'OpenCode đã ở phiên bản mới nhất được hỗ trợ.' : '');
      const install = document.querySelector('#native-form [name=install]');
      install.disabled = busy || !info.canUpdate || locked;
      install.textContent = info.pendingRestart && (!info.release || info.release.version === info.installedVersion) ? 'Áp dụng bản đã cài' : 'Cập nhật OpenCode';
      document.querySelector('#native-job').textContent = data.job?.message || '';
      return;
    }
    document.querySelector('#version').textContent = data.version;
    const release = document.querySelector('#release');
    release.replaceChildren();
    if (data.release) {
      const link = document.createElement('a');
      link.href = data.release.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = data.release.version;
      release.append(link);
    } else release.textContent = data.checked ? data.checkError || 'Chưa có bản mới phù hợp với kênh đã chọn' : 'Chưa kiểm tra';
    document.querySelector('#checked').textContent = data.checked ? new Date(data.checked).toLocaleString('vi-VN') : 'Chưa kiểm tra';
    const form = document.querySelector('#update-form');
    if (document.activeElement?.closest('form') !== form) {
      form.elements.automatic.checked = data.preferences.automatic;
      form.elements.channel.value = data.preferences.channel;
    }
    form.querySelector('[name=install]').disabled = busy || !data.release || locked;
    document.querySelector('#job').textContent = data.job?.message || '';
  }
  async function refresh() { draw(await call(nativePage ? 'opencode-status' : 'status')); }
  for (const [selector, operation] of [['#check-update', 'check'], ['#native-check', 'opencode-check']]) document.querySelector(selector).addEventListener('click', async event => {
    event.target.disabled = true;
    try { draw(await call(operation, {})); }
    catch (error) { message(error.message); }
    finally { event.target.disabled = busy || !available; }
  });
  for (const form of document.querySelectorAll('form')) form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !available) return;
    const password = form.elements.password.value;
    const operation = form.id === 'password-form' ? 'password' : form.id === 'native-form' ? 'opencode-update' : event.submitter?.name === 'install' ? 'update' : 'preferences';
    const fields = { password };
    if (operation === 'password') {
      if (form.elements.newPassword.value !== form.elements.confirmPassword.value) { message('Hai ô mật khẩu mới chưa khớp.'); return; }
      fields.newPassword = form.elements.newPassword.value; fields.confirmPassword = form.elements.confirmPassword.value;
    }
    if (['update', 'opencode-update'].includes(operation)) {
      if (!form.elements.acknowledge.checked) { message('Vui lòng xác nhận đã lưu công việc trước khi cập nhật.'); return; }
      fields.acknowledge = true;
    }
    if (operation === 'preferences') { fields.automatic = form.elements.automatic.checked; fields.channel = form.elements.channel.value; }
    busy = true; form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await refresh();
      const data = await call(operation, fields);
      if (['update', 'opencode-update'].includes(operation)) watchingJob = true;
      form.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; });
      message(data.message);
      if (operation === 'password') {
        form.hidden = true;
        setTimeout(() => { window.top.location.href = '/login'; }, 6000);
        return;
      }
    } catch (error) { message(error.message); }
    finally { busy = false; if (!form.hidden) refreshWithRetry(); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && window.parent !== window) window.parent.postMessage({ type: 'web-login-close' }, location.origin);
  });
  refreshWithRetry();
})();
