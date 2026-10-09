(() => {
  'use strict';
  const notice = document.querySelector('#notice');
  const passwordPage = location.pathname.endsWith('/password');
  document.querySelector(passwordPage ? '#password-page' : '#updates-page').hidden = false;
  document.title = `${passwordPage ? 'Đổi mật khẩu' : 'Cập nhật Web Login Module'} · OpenCode`;
  let csrf, busy = false, available = false, timer, reconnecting = false;
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
    timer = setTimeout(async () => {
      try {
        await refresh();
        if (reconnecting) { reconnecting = false; message('Đã kết nối lại với dịch vụ.'); }
      } catch (error) {
        if ([401, 403].includes(error.status)) { message(error.message); return; }
        reconnecting = true;
        message('Tạm mất kết nối với dịch vụ. Đang chờ kết nối lại để kiểm tra kết quả cập nhật.');
        scheduleRefresh(error.status === 429 ? 60000 : 5000);
      }
    }, delay);
  }
  function draw(data) {
    if (data.csrf) csrf = data.csrf;
    available = data.available;
    document.querySelectorAll('form button').forEach(button => { button.disabled = busy || !available; });
    if (!available) { message(data.message || 'Chưa bật dịch vụ quản trị. Cài lại module bằng bộ cài Linux để sử dụng.'); return; }
    if (passwordPage) return;
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
    const running = ['starting', 'running'].includes(data.job?.phase);
    form.querySelector('[name=install]').disabled = busy || !data.release || running;
    document.querySelector('#job').textContent = data.job?.message || '';
    clearTimeout(timer);
    if (running) scheduleRefresh();
  }
  async function refresh() { draw(await call('status')); }
  document.querySelector('#check-update').addEventListener('click', async event => {
    event.target.disabled = true;
    try { draw(await call('check', {})); }
    catch (error) { message(error.message); }
    finally { event.target.disabled = false; }
  });
  for (const form of document.querySelectorAll('form')) form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !available) return;
    const password = form.elements.password.value;
    const operation = form.id === 'password-form' ? 'password' : event.submitter?.name === 'install' ? 'update' : 'preferences';
    const fields = { password };
    if (operation === 'password') {
      if (form.elements.newPassword.value !== form.elements.confirmPassword.value) { message('Hai ô mật khẩu mới chưa khớp.'); return; }
      fields.newPassword = form.elements.newPassword.value; fields.confirmPassword = form.elements.confirmPassword.value;
    }
    if (operation === 'update' && !form.elements.acknowledge.checked) { message('Vui lòng xác nhận đã lưu công việc trước khi cập nhật.'); return; }
    if (operation === 'preferences') { fields.automatic = form.elements.automatic.checked; fields.channel = form.elements.channel.value; }
    busy = true; form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await refresh();
      const data = await call(operation, fields);
      form.querySelectorAll('input[type=password]').forEach(input => { input.value = ''; });
      message(data.message);
      if (operation === 'password') {
        form.hidden = true;
        setTimeout(() => { window.top.location.href = '/login'; }, 6000);
        return;
      }
      busy = false;
      await refresh();
    } catch (error) { message(error.message); }
    finally { busy = false; if (!form.hidden) refresh().catch(() => {}); }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && window.parent !== window) window.parent.postMessage({ type: 'web-login-close' }, location.origin);
  });
  refresh().catch(error => message(error.message));
})();
