import { i18n } from '/login/i18n-client.js';

(() => {
  'use strict';
  const items = [['password', 'Đổi mật khẩu'], ['updates', 'Cập nhật Web Login Module'], ['opencode', 'Update & Downgrade'], ['providers', 'Nhà cung cấp tùy chỉnh']];
  let dialog, frame, focusBefore;
  function close() {
    if (!dialog) return;
    dialog.close(); dialog.remove(); i18n.prune(dialog); dialog = null; frame = null;
    if (focusBefore?.isConnected) focusBefore.focus();
  }
  function open(id, title) {
    close(); focusBefore = document.activeElement;
    dialog = document.createElement('dialog'); dialog.className = 'web-login-dialog'; i18n.attr(dialog, 'aria-label', () => (title));
    const header = document.createElement('div'); header.className = 'web-login-dialog-header';
    const navigation = document.createElement('nav'); navigation.className = 'web-login-dialog-tabs'; i18n.attr(navigation, 'aria-label', 'Cài đặt Web Login Module');
    const select = (selected, label) => {
      i18n.attr(dialog, 'aria-label', () => label); i18n.attr(frame, 'title', () => label);
      for (const link of navigation.children) {
        if (link.dataset.page === selected) {
          link.setAttribute('aria-current', 'page');
          link.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        else link.removeAttribute('aria-current');
      }
    };
    for (const [page, label] of items) {
      const link = document.createElement('a'); link.href = `/web-login/${page}`; link.dataset.page = page; i18n.text(link, () => label);
      link.addEventListener('click', event => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (link.getAttribute('aria-current') === 'page') return;
        select(page, label); frame.src = link.href;
      });
      navigation.append(link);
    }
    const button = document.createElement('button'); button.type = 'button'; i18n.text(button, () => ('Đóng')); button.addEventListener('click', close);
    header.append(navigation, button);
    frame = document.createElement('iframe'); frame.src = `/web-login/${id}`; i18n.attr(frame, 'title', () => (title));
    const currentFrame = frame;
    frame.addEventListener('load', () => {
      if (frame !== currentFrame) return;
      try {
        const page = items.find(([page]) => currentFrame.contentWindow.location.pathname === `/web-login/${page}`);
        if (page) select(...page);
        currentFrame.contentWindow.postMessage({ type: 'web-login-language', locale: i18n.locale }, location.origin);
      } catch { /* Ignore a frame that has navigated outside this origin. */ }
    });
    select(id, title);
    dialog.append(header, frame); document.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.showModal(); button.focus();
  }
  function menu(className) {
    const group = document.createElement('div'); group.className = `web-login-menu ${className}`;
    const label = document.createElement('div'); label.className = 'web-login-menu-label'; i18n.text(label, () => ('Web Login Module')); group.append(label);
    for (const [id, title] of items) {
      const button = document.createElement('button'); button.type = 'button'; i18n.text(button, () => (title));
      button.addEventListener('click', () => open(id, title)); group.append(button);
    }
    return group;
  }
  let scheduled = false;
  function attach() {
    scheduled = false;
    const settings = document.querySelector('[data-testid="settings-screen"]');
    const legacy = document.querySelector('.settings-dialog');
    if (!settings && !legacy) return;
    const sidebar = settings?.querySelector('.settings-nav-groups');
    if (sidebar && !sidebar.querySelector('.web-login-menu')) sidebar.append(menu('web-login-desktop'));
    const mobile = settings?.querySelector('.settings-mobile-nav');
    if (mobile && !settings.querySelector('.web-login-mobile')) mobile.after(menu('web-login-mobile'));
    const legacySidebar = legacy?.querySelector('[role="tablist"]');
    if (legacySidebar && !legacySidebar.querySelector('.web-login-menu')) legacySidebar.append(menu('web-login-legacy'));
  }
  new MutationObserver(records => {
    if (scheduled || records.every(record => record.target.closest?.('.web-login-dialog, .web-login-menu'))) return;
    scheduled = true; requestAnimationFrame(attach);
  }).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('message', event => {
    if (event.origin === location.origin && event.source === frame?.contentWindow && event.data?.type === 'web-login-close') close();
  });
  i18n.subscribe(locale => {
    frame?.contentWindow?.postMessage({ type: 'web-login-language', locale }, location.origin);
  });
  attach();
})();
