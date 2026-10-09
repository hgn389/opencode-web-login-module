(() => {
  'use strict';
  const items = [['password', 'Đổi mật khẩu'], ['updates', 'Cập nhật Web Login Module']];
  let dialog, frame, focusBefore;
  function close() {
    if (!dialog) return;
    dialog.close(); dialog.remove(); dialog = null; frame = null;
    if (focusBefore?.isConnected) focusBefore.focus();
  }
  function open(id, title) {
    close(); focusBefore = document.activeElement;
    dialog = document.createElement('dialog'); dialog.className = 'web-login-dialog'; dialog.setAttribute('aria-label', title);
    const header = document.createElement('div'); header.className = 'web-login-dialog-header';
    const label = document.createElement('strong'); label.textContent = title;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Đóng'; button.addEventListener('click', close);
    header.append(label, button);
    frame = document.createElement('iframe'); frame.src = `/web-login/${id}`; frame.title = title;
    dialog.append(header, frame); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.showModal(); button.focus();
  }
  function menu(className) {
    const group = document.createElement('div'); group.className = `web-login-menu ${className}`;
    const label = document.createElement('div'); label.className = 'web-login-menu-label'; label.textContent = 'Web Login Module'; group.append(label);
    for (const [id, title] of items) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
      button.addEventListener('click', () => open(id, title)); group.append(button);
    }
    return group;
  }
  let scheduled = false;
  function attach() {
    scheduled = false;
    const settings = document.querySelector('[data-testid="settings-screen"]');
    if (!settings) return;
    const sidebar = settings.querySelector('.settings-nav-groups');
    if (sidebar && !sidebar.querySelector('.web-login-menu')) sidebar.append(menu('web-login-desktop'));
    const mobile = settings.querySelector('.settings-mobile-nav');
    if (mobile && !settings.querySelector('.web-login-mobile')) mobile.after(menu('web-login-mobile'));
  }
  new MutationObserver(records => {
    if (scheduled || records.every(record => record.target.closest?.('.web-login-dialog, .web-login-menu'))) return;
    scheduled = true; requestAnimationFrame(attach);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === frame?.contentWindow && event.data?.type === 'web-login-close') close();
  });
  attach();
})();
