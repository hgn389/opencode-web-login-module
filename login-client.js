const form = document.querySelector('form[action="/login"]');
if (form && !form.querySelector('fieldset').disabled) {
  let pending = false;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (pending) return;
    pending = true;
    const button = form.querySelector('button[type="submit"]');
    const message = document.querySelector('.message');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let submitted = false;
    button.disabled = true;
    try {
      const response = await fetch('/login/session', {
        credentials: 'same-origin', cache: 'no-store', headers: { 'X-OpenCode-Login': '1' }, signal: controller.signal,
      });
      const session = await response.json();
      if (!response.ok) throw new Error(session.message || 'Không thể chuẩn bị phiên đăng nhập. Vui lòng thử lại.');
      const field = form.elements.namedItem('csrf');
      const changed = field.value !== session.csrf;
      field.value = session.csrf;
      const captcha = form.elements.namedItem('captcha');
      if (session.captcha && captcha && (changed || session.refreshed)) {
        form.querySelector('.captcha img').src = '/login/captcha?refresh=' + Date.now();
        captcha.value = '';
        message.textContent = 'Mã xác minh đã hết hạn. Vui lòng nhập mã mới.';
        captcha.focus();
        return;
      }
      HTMLFormElement.prototype.submit.call(form);
      submitted = true;
    } catch (error) {
      message.textContent = error.name === 'AbortError'
        ? 'Kết nối bị chậm. Vui lòng thử lại.'
        : error instanceof TypeError || error instanceof SyntaxError ? 'Không kết nối được với máy chủ. Vui lòng thử lại.' : error.message;
    } finally { clearTimeout(timeout); if (!submitted) { pending = false; button.disabled = false; } }
  });
}
