import { i18n } from '/login/i18n-client.js';
import { modelPreferenceKey, readModelPreferences, modelVisible, saveModelVisibility, saveModelVisibilityBatch } from '/web-login/model-visibility.mjs';

(() => {
  'use strict';
  if (window.parent !== window && window.frameElement?.closest('.web-login-dialog')) document.documentElement.dataset.embedded = 'true';
  const notice = document.querySelector('#notice');
  const passwordPage = location.pathname.endsWith('/password');
  const nativePage = location.pathname.endsWith('/opencode');
  const providersPage = location.pathname.endsWith('/providers');
  document.querySelector(passwordPage ? '#password-page' : nativePage ? '#opencode-page' : providersPage ? '#providers-page' : '#updates-page').hidden = false;
  i18n.text(document.querySelector('title'), () => i18n.t(passwordPage ? 'Đổi mật khẩu' : nativePage ? 'Update & Downgrade' : providersPage ? 'Nhà cung cấp tùy chỉnh' : 'Cập nhật Web Login Module') + ' · OpenCode');
  document.querySelectorAll('form button, #check-update, #native-check').forEach(button => { button.disabled = true; });
  let csrf, busy = false, available = false, timer, reconnecting = false, watchingJob = false, nativeInfo, nativeLocked;
  let providerData, providerRevision, providerLocked, providerPendingId;
  let providerPendingVisibility, providerVisibilityRetry, modelPreferences, providerSubmitting = false;
  const providerForm = document.querySelector('#provider-form');
  const providerEditor = document.querySelector('#provider-editor');
  const providerList = document.querySelector('#provider-list');
  const visibilityModels = document.querySelector('#provider-visibility-models');
  let visibilityCatalogKey = '';
  const noticeHome = notice.parentNode, noticeAnchor = notice.nextSibling;
  let selectedProviderId = '', editorTrigger;
  const maximumProviderModels = 2000;
  const modelRows = () => [...document.querySelectorAll('.provider-model-row')];
  let toastTimer, autoScanTimer, connectionVersion = 0, scannedVersion = -1, automaticScanning = false;
  const message = text => {
    clearTimeout(toastTimer);
    notice.hidden = !text;
    i18n.text(notice, () => text);
    if (text) toastTimer = setTimeout(() => { notice.hidden = true; i18n.text(notice, ''); }, 2000);
  };
  providerForm.addEventListener('invalid', event => {
    const control = event.target;
    const label = control.closest('label')?.textContent.trim();
    message(`${label ? label + ': ' : ''}${control.validationMessage}`);
  }, true);
  async function call(operation, fields) {
    const response = await fetch(`/web-login/api/${operation}`, {
      method: fields === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'x-opencode-login': '1', 'x-web-login-locale': i18n.locale, ...(fields !== undefined ? { 'content-type': 'application/json', 'x-web-login-csrf': csrf } : {}) },
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
      document.querySelector('#provider-refresh').disabled = true;
      if (providersPage) lockProvider();
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
    if (['succeeded', 'failed'].includes(data.job?.phase)) {
      if (watchingJob && data.job.message) message(data.job.message);
      watchingJob = false;
    }
    const locked = running || watchingJob || data.job?.recoveryRequired;
    document.querySelectorAll('form button').forEach(button => { button.disabled = busy || !available || locked; });
    document.querySelectorAll('#check-update, #native-check').forEach(button => { button.disabled = busy || !available; });
    clearTimeout(timer);
    if (running || watchingJob) scheduleRefresh();
    if (!available) {
      message(data.message || 'Chưa bật dịch vụ quản trị. Cài lại module bằng bộ cài Linux để sử dụng.');
      if (providersPage) {
        i18n.text(document.querySelector('#provider-info'), () => data.message || 'Chưa bật dịch vụ quản trị. Cài lại module bằng bộ cài Linux để sử dụng.');
        lockProvider();
      }
      return;
    }
    if (passwordPage) return;
    if (providersPage) {
      providerData = data.providers || {}; providerLocked = locked;
      renderProviders();
      let savedProvider;
      if (providerPendingId !== undefined && data.job?.phase === 'succeeded') {
        const id = providerPendingId; providerPendingId = undefined;
        savedProvider = id;
        providerVisibilityRetry = providerPendingVisibility; providerPendingVisibility = undefined;
        document.querySelector('#provider-visibility-apply').hidden = false;
        applyProviderVisibility();
        if (providerEditor.open && providerForm.elements.providerId.value.trim() === id) closeProviderEditor();
      }
      if (data.job?.phase === 'failed') { providerPendingId = undefined; providerPendingVisibility = undefined; }
      renderProviderVisibility(savedProvider);
      i18n.text(document.querySelector('#provider-info'), () => (providerData.supported ? '' : providerData.reason || 'Chưa đọc được cấu hình nhà cung cấp.'));
      i18n.text(document.querySelector('#provider-job'), () => (data.job?.type === 'providers' && data.job.phase !== 'succeeded' ? data.job.message || '' : ''));
      lockProvider(); return;
    }
    if (nativePage) {
      const info = data.opencode || {};
      nativeInfo = info; nativeLocked = locked;
      i18n.text(document.querySelector('#native-version'), () => (info.version || 'Chưa đọc được'));
      i18n.text(document.querySelector('#native-installed'), () => (info.installedVersion || 'Chưa nhận diện được'));
      i18n.text(document.querySelector('#native-release'), () => (info.release?.version || (info.checked ? info.checkError || 'Chưa có bản ổn định được hỗ trợ' : 'Chưa kiểm tra')));
      i18n.text(document.querySelector('#native-checked'), () => (info.checked ? new Date(info.checked).toLocaleString(i18n.languages.find(language => language.code === i18n.locale)?.tag || 'en') : 'Chưa kiểm tra'));
      i18n.text(document.querySelector('#native-support'), () => (info.reason || (info.pendingRestart ? 'Bản đã cài khác bản đang chạy. Cần khởi động lại để áp dụng.' : info.checked && !info.checkError && !info.canUpdate && !locked ? 'OpenCode đã ở phiên bản mới nhất được hỗ trợ.' : '')));
      const select = document.querySelector('#native-target'), selected = select.value;
      const versions = (info.versions || []).filter(version => /^\d+\.\d+\.\d+$/.test(version));
      const key = [info.installedVersion, ...versions].join(',');
      if (select.dataset.versions !== key) {
        select.dataset.versions = key;
        select.replaceChildren(i18n.option(() => ('Bản mới nhất của nhánh đang dùng'), ''), ...versions.map(version => i18n.option(() => (`v${version}${version === info.installedVersion ? i18n.t(' (đã cài)') : ''}`), version)));
        if (versions.includes(selected)) select.value = selected;
      }
      i18n.text(document.querySelector('#native-versions-status'), () => (info.versionsError || (info.versionsChecked ? `Có ${versions.length} phiên bản ổn định gần đây; hỗ trợ v1 từ 1.18.20 và v2.` : 'Bấm kiểm tra để tải danh sách phiên bản.')));
      drawNativeTarget();
      i18n.text(document.querySelector('#native-job'), () => (data.job?.message || ''));
      return;
    }
    i18n.text(document.querySelector('#version'), () => (data.version));
    const release = document.querySelector('#release');
    release.replaceChildren();
    if (data.release) {
      const link = document.createElement('a');
      link.href = data.release.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; i18n.text(link, () => (data.release.version));
      release.append(link);
    } else i18n.text(release, () => (data.checked ? data.checkError || 'Chưa có bản mới phù hợp với kênh đã chọn' : 'Chưa kiểm tra'));
    i18n.text(document.querySelector('#checked'), () => (data.checked ? new Date(data.checked).toLocaleString(i18n.languages.find(language => language.code === i18n.locale)?.tag || 'en') : 'Chưa kiểm tra'));
    const form = document.querySelector('#update-form');
    if (document.activeElement?.closest('form') !== form) {
      form.elements.automatic.checked = data.preferences.automatic;
      form.elements.channel.value = data.preferences.channel;
    }
    form.querySelector('[name=install]').disabled = busy || !data.release || locked;
    i18n.text(document.querySelector('#job'), () => (data.job?.message || ''));
  }
  function drawNativeTarget() {
    if (!nativeInfo) return;
    const select = document.querySelector('#native-target'), target = select.value, info = nativeInfo;
    const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]); return 0; };
    const direction = target && info.installedVersion ? compare(target, info.installedVersion) : 0;
    const crossMajor = target && info.installedVersion && target.split('.')[0] !== info.installedVersion.split('.')[0];
    i18n.text(document.querySelector('#native-target-help'), () => (crossMajor
      ? `Chuyển sang v${target}: hội thoại của v1 và v2 được giữ trong hai cơ sở dữ liệu riêng. Khi trở lại nhánh cũ, bạn dùng lại hội thoại của nhánh đó. Bạn cần đăng nhập lại sau khi chuyển.`
      : target ? `${direction < 0 ? 'Hạ cấp' : direction > 0 ? 'Cập nhật' : 'Áp dụng'} từ ${info.installedVersion} sang ${target}. Nếu dữ liệu không tương thích, bộ quản trị sẽ khôi phục bản trước.` : 'Chọn phiên bản thấp hơn để hạ cấp, hoặc cao hơn để cập nhật.'));
    const install = document.querySelector('#native-form [name=install]');
    select.disabled = busy || !available || nativeLocked || !info.supported;
    install.disabled = busy || !available || nativeLocked || (target ? !info.supported || direction === 0 && !info.pendingRestart : !info.canUpdate);
    i18n.text(install, () => (target ? `${i18n.t(direction < 0 ? 'Xác nhận hạ cấp' : direction > 0 ? 'Xác nhận cập nhật' : 'Áp dụng bản đã cài')} v${target}` : info.pendingRestart && (!info.release || info.release.version === info.installedVersion) ? 'Áp dụng bản đã cài' : 'Cập nhật OpenCode'));
  }
  document.querySelector('#native-target').addEventListener('change', () => {
    document.querySelector('#native-form [name=acknowledge]').checked = false;
    drawNativeTarget();
  });
  function lockProvider() {
    const locked = !available || providerLocked || !providerData?.supported;
    const disabled = busy || locked;
    providerForm.querySelectorAll('input, button').forEach(control => { control.disabled = locked || busy && (!automaticScanning || control.tagName === 'BUTTON'); });
    document.querySelector('#provider-new').disabled = disabled;
    providerList.querySelectorAll('button').forEach(button => { button.disabled = disabled || button.dataset.editable !== 'true'; });
    document.querySelector('#provider-refresh').disabled = busy || !available || providerLocked;
    providerForm.elements.remove.disabled = disabled || !selectedProviderId;
    document.querySelector('#provider-add-model').disabled = disabled || modelRows().length >= maximumProviderModels;
    providerForm.elements.apiKey.disabled = locked || busy && !automaticScanning || providerForm.elements.clearKey.checked;
    for (const row of modelRows()) row.querySelector('[data-model-visible]').disabled ||= !row.querySelector('[data-model-selected]').checked;
    document.querySelector('#provider-visibility-reload').disabled = busy || providerPendingId !== undefined;
    const noModels = !visibilityModels.querySelector('input');
    document.querySelectorAll('#provider-visibility-controls input, #provider-visibility-controls .visibility-bulk').forEach(control => { control.disabled = disabled || noModels; });
    if (providersPage && window.parent !== window) window.parent.postMessage({ type: 'web-login-provider-pending', pending: providerSubmitting || providerPendingId !== undefined }, location.origin);
  }
  function applyProviderVisibility() {
    if (!providerVisibilityRetry) return true;
    try {
      const { id, choices, remove } = providerVisibilityRetry;
      saveModelVisibility(localStorage, id, choices, remove); providerVisibilityRetry = undefined;
      return true;
    } catch { message('Không truy cập được bộ nhớ trình duyệt. Hãy cho phép lưu trữ rồi thử lại.'); return false; }
  }
  document.querySelector('#provider-visibility-reload').addEventListener('click', () => {
    if (!applyProviderVisibility()) return;
    if (window.parent !== window && window.frameElement?.closest('.web-login-dialog')) window.parent.location.reload();
    else location.href = '/';
  });
  function syncVisibilitySwitches() {
    const preferences = readModelPreferences(localStorage);
    for (const input of visibilityModels.querySelectorAll('input')) input.checked = modelVisible(preferences, input.dataset.visibilityProvider, input.dataset.visibilityModel);
  }
  function renderProviderVisibility(preferred) {
    const providers = (providerData.providers || []).filter(provider => /^[a-z0-9][a-z0-9_-]{0,62}$/.test(provider.id) && provider.models?.length);
    if (providers.length) document.querySelector('#provider-visibility-apply').hidden = false;
    const key = JSON.stringify(providers.map(({ id, name, models }) => [id, name, models]));
    if (key !== visibilityCatalogKey || preferred) {
      visibilityCatalogKey = key;
      renderVisibilityModels(providers);
    } else {
      try { syncVisibilitySwitches(); } catch { /* Keep the current controls when storage is temporarily unavailable. */ }
    }
  }
  function renderVisibilityModels(providers) {
    visibilityModels.replaceChildren();
    document.querySelector('#provider-visibility-empty').hidden = Boolean(providers.length);
    let preferences;
    try { preferences = readModelPreferences(localStorage); }
    catch { message('Không truy cập được bộ nhớ trình duyệt. Hãy cho phép lưu trữ rồi thử lại.'); return; }
    const fragment = document.createDocumentFragment();
    for (const provider of providers) {
      const group = document.createElement('section'); group.className = 'provider-visibility-group'; group.dataset.visibilityGroup = provider.id;
      const heading = document.createElement('h3'); heading.id = `visibility-group-${provider.id}`; heading.textContent = provider.name || provider.id;
      group.setAttribute('aria-labelledby', heading.id);
      const providerID = document.createElement('code'); providerID.className = 'provider-visibility-provider-id'; providerID.textContent = provider.id; providerID.dir = 'ltr';
      group.append(heading, providerID);
      for (const model of provider.models) {
        const row = document.createElement('label'); row.className = 'model-visibility provider-visibility-row';
        const text = document.createElement('span'); text.className = 'provider-visibility-name';
        const name = document.createElement('strong'); name.textContent = model.name || model.id;
        const id = document.createElement('code'); id.textContent = model.id; id.dir = 'ltr'; text.append(name, id);
        const input = document.createElement('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.dataset.visibilityProvider = provider.id; input.dataset.visibilityModel = model.id; input.checked = modelVisible(preferences, provider.id, model.id);
        i18n.attr(input, 'aria-label', () => `${i18n.t('Hiển thị trong bộ chọn')} · ${provider.name || provider.id} · ${model.name || model.id} · ${model.id}`);
        const track = document.createElement('span'); track.className = 'model-switch-track'; track.setAttribute('aria-hidden', 'true');
        input.addEventListener('change', () => { if (!saveVisibilityChoices([{ providerID: provider.id, choices: [{ modelID: model.id, visible: input.checked }] }])) input.checked = !input.checked; });
        row.append(text, input, track); group.append(row);
      }
      fragment.append(group);
    }
    visibilityModels.append(fragment); i18n.prune();
  }
  function saveVisibilityChoices(groups) {
    if (busy || providerLocked || !available || !groups.length) return false;
    try {
      if (!applyProviderVisibility()) return false;
      saveModelVisibilityBatch(localStorage, groups);
      document.querySelector('#provider-visibility-apply').hidden = false;
      message('Đã lưu hiển thị model.'); return true;
    } catch { message('Không truy cập được bộ nhớ trình duyệt. Hãy cho phép lưu trữ rồi thử lại.'); return false; }
  }
  for (const [id, visible] of [['#provider-visibility-all', true], ['#provider-visibility-none', false]]) document.querySelector(id).addEventListener('click', () => {
    const groups = [...visibilityModels.querySelectorAll('[data-visibility-group]')].map(group => ({ providerID: group.dataset.visibilityGroup, choices: [...group.querySelectorAll('input')].map(input => ({ modelID: input.dataset.visibilityModel, visible })) }));
    if (saveVisibilityChoices(groups)) syncVisibilitySwitches();
  });
  window.addEventListener('storage', event => {
    if (providersPage && (event.key === modelPreferenceKey || event.key === null)) {
      try { syncVisibilitySwitches(); } catch { /* Do not replace preferences from an invalid storage event. */ }
    }
  });
  function renderProviders() {
    const fragment = document.createDocumentFragment();
    for (const provider of providerData.providers || []) {
      const row = document.createElement('li'); row.className = 'provider-list-row'; row.dataset.providerId = provider.id;
      const details = document.createElement('div'); details.className = 'provider-list-details';
      const name = document.createElement('button'); name.type = 'button'; name.className = 'provider-list-name'; name.textContent = provider.name || provider.id;
      const id = document.createElement('code'); id.textContent = provider.id; id.dir = 'ltr';
      const meta = document.createElement('p'); meta.className = 'note';
      i18n.text(meta, () => `${i18n.t('Model')}: ${provider.models?.length || 0}${provider.editable ? '' : i18n.t(' — kiểu cấu hình khác')}`);
      details.append(name, id, meta);
      const edit = document.createElement('button'); edit.type = 'button'; i18n.text(edit, 'Sửa'); i18n.attr(edit, 'aria-label', () => `${i18n.t('Sửa')} ${provider.name || provider.id}`);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'provider-list-delete'; i18n.text(remove, 'Xóa nhà cung cấp'); i18n.attr(remove, 'aria-label', () => `${i18n.t('Xóa nhà cung cấp')} · ${provider.name || provider.id}`);
      for (const button of [name, edit]) {
        button.dataset.editable = String(Boolean(provider.editable));
        button.addEventListener('click', () => openProviderEditor(provider.id));
      }
      remove.dataset.editable = String(Boolean(provider.editable));
      remove.addEventListener('click', () => openProviderEditor(provider.id, true));
      const actions = document.createElement('div'); actions.className = 'provider-list-actions'; actions.append(edit, remove);
      row.append(details, actions); fragment.append(row);
    }
    providerList.replaceChildren(fragment);
    document.querySelector('#provider-empty').hidden = !providerData.supported || Boolean(providerData.providers?.length);
    i18n.prune();
  }
  function openProviderEditor(id = '', deleting = false) {
    if (busy || !available || providerLocked || !providerData?.supported) return;
    const provider = providerData.providers?.find(provider => provider.id === id);
    if (id && !provider?.editable) return;
    if (providerVisibilityRetry && !applyProviderVisibility()) return;
    try { modelPreferences = readModelPreferences(localStorage); }
    catch { message('Không truy cập được bộ nhớ trình duyệt. Hãy cho phép lưu trữ rồi thử lại.'); return; }
    editorTrigger = document.activeElement;
    fillProvider(id);
    providerEditor.toggleAttribute('data-delete', deleting);
    providerForm.querySelectorAll('fieldset').forEach(fieldset => { fieldset.hidden = deleting; });
    providerForm.elements.save.hidden = deleting;
    const summary = document.querySelector('#provider-delete-summary'); summary.hidden = !deleting;
    summary.textContent = deleting ? `${provider.name || provider.id} (${provider.id})` : '';
    i18n.text(document.querySelector('#provider-editor-title'), () => deleting ? i18n.t('Xóa nhà cung cấp') : provider ? `${i18n.t('Sửa')} · ${provider.name || provider.id}` : 'Thêm nhà cung cấp mới');
    providerEditor.append(notice);
    providerEditor.showModal();
    document.querySelector('.provider-editor-body').scrollTop = 0;
    (deleting ? document.querySelector('#provider-editor-close') : providerForm.elements[provider ? 'providerName' : 'providerId']).focus({ preventScroll: true });
  }
  function closeProviderEditor() {
    if (!providerEditor.open) return;
    const previousId = selectedProviderId;
    clearTimeout(autoScanTimer); connectionVersion++; scannedVersion = -1;
    providerEditor.close(); noticeHome.insertBefore(notice, noticeAnchor);
    providerForm.reset(); selectedProviderId = ''; providerRevision = undefined;
    document.querySelector('#provider-models').replaceChildren(); i18n.prune();
    if (editorTrigger?.isConnected) editorTrigger.focus();
    else ([...providerList.children].find(row => row.dataset.providerId === previousId)?.querySelector('.provider-list-name') || document.querySelector('#provider-new')).focus();
  }
  document.querySelector('#provider-new').addEventListener('click', () => openProviderEditor());
  document.querySelector('#provider-editor-close').addEventListener('click', closeProviderEditor);
  providerEditor.addEventListener('cancel', event => { event.preventDefault(); closeProviderEditor(); });
  function modelCount() {
    const rows = modelRows(), count = rows.filter(row => row.querySelector('[data-model-selected]').checked).length;
    i18n.text(document.querySelector('#provider-model-count'), () => (`Đã chọn ${count} / ${rows.length} model.`));
  }
  function modelRow(model = {}, selected = true, container = document.querySelector('#provider-models')) {
    const row = document.createElement('div'); row.className = 'provider-model-row';
    const choice = document.createElement('label'); choice.className = 'check model-choice';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.modelSelected = ''; checkbox.checked = selected; i18n.attr(checkbox, 'aria-label', () => (`Chọn model ${model.id || i18n.t('mới')}`));
    const choiceText = document.createElement('span'); i18n.text(choiceText, 'Chọn');
    choice.append(checkbox, choiceText); row.append(choice);
    for (const [field, title] of [['id', 'Model ID'], ['name', 'Tên hiển thị model']]) {
      const label = document.createElement('label');
      const caption = document.createElement('span'); caption.className = 'model-field-caption'; i18n.text(caption, () => title);
      const input = document.createElement('input'); input.type = 'text'; input.maxLength = 128; input.dataset.modelField = field; input.value = model[field] || ''; input.required = field === 'id' && selected; input.autocomplete = 'off'; input.dir = field === 'id' ? 'ltr' : 'auto';
      input.addEventListener('input', () => {
        providerForm.elements.acknowledge.checked = false;
        if (field === 'id') {
          i18n.attr(checkbox, 'aria-label', () => (`Chọn model ${input.value || i18n.t('mới')}`));
          // Renaming creates a new model; require an explicit visibility choice again.
          visibility.checked = savedModelVisible(input.value.trim());
          labelVisibility();
        }
      });
      label.append(caption, input); row.append(label);
    }
    const visibilityLabel = document.createElement('label'); visibilityLabel.className = 'model-visibility';
    const visibilityCaption = document.createElement('span'); visibilityCaption.className = 'model-field-caption'; i18n.text(visibilityCaption, 'Hiển thị trong bộ chọn');
    const visibility = document.createElement('input'); visibility.type = 'checkbox'; visibility.setAttribute('role', 'switch'); visibility.dataset.modelVisible = ''; visibility.checked = savedModelVisible(model.id);
    const track = document.createElement('span'); track.className = 'model-switch-track'; track.setAttribute('aria-hidden', 'true');
    const labelVisibility = () => {
      i18n.attr(visibility, 'aria-label', () => `${i18n.t('Hiển thị trong bộ chọn')} · ${row.querySelector('[data-model-field=id]').value || i18n.t('mới')}`);
    };
    visibility.addEventListener('change', () => { row.dataset.visibilityChanged = 'true'; providerForm.elements.acknowledge.checked = false; });
    visibilityLabel.append(visibilityCaption, visibility, track); row.append(visibilityLabel); labelVisibility();
    checkbox.addEventListener('change', () => { row.querySelector('[data-model-field=id]').required = checkbox.checked; providerForm.elements.acknowledge.checked = false; lockProvider(); modelCount(); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'model-remove'; remove.textContent = '×'; i18n.attr(remove, 'aria-label', 'Bỏ model'); i18n.attr(remove, 'title', 'Bỏ model');
    remove.addEventListener('click', () => {
      if (modelRows().length > 1) row.remove();
      else { row.querySelectorAll('[data-model-field]').forEach(input => { input.value = ''; }); checkbox.checked = true; visibility.checked = false; labelVisibility(); row.querySelector('[data-model-field=id]').required = true; }
      providerForm.elements.acknowledge.checked = false; lockProvider(); modelCount(); i18n.prune();
    });
    row.append(remove); container.append(row);
  }
  function chooseModels(selected) {
    for (const row of modelRows()) { row.querySelector('[data-model-selected]').checked = selected; row.querySelector('[data-model-field=id]').required = selected; }
    providerForm.elements.acknowledge.checked = false; lockProvider(); modelCount();
  }
  function savedModelVisible(id) {
    // Newly scanned/added IDs stay hidden until their switch is enabled, even if an old preference exists.
    return Boolean(selectedProviderId && providerData?.providers?.find(provider => provider.id === selectedProviderId)?.models?.some(model => model.id === id) && modelVisible(modelPreferences, selectedProviderId, id));
  }
  function fillProvider(id) {
    clearTimeout(autoScanTimer); connectionVersion++; scannedVersion = -1;
    const provider = providerData?.providers?.find(provider => provider.id === id);
    selectedProviderId = provider?.id || '';
    providerRevision = providerData?.revision;
    providerForm.reset();
    providerForm.elements.providerId.value = provider?.id || ''; providerForm.elements.providerId.readOnly = Boolean(provider);
    providerForm.elements.providerName.value = provider?.name || ''; providerForm.elements.baseURL.value = provider?.baseURL || '';
    i18n.text(document.querySelector('#provider-key-help'), () => (provider?.hasKey ? 'Khóa đã được cấu hình. Để trống để giữ nguyên; nhập khóa mới để thay thế. Khi đổi Base URL, cần nhập lại hoặc xóa khóa.' : 'Có thể để trống nếu API không yêu cầu khóa. Khóa đã lưu không được trả về trình duyệt.'));
    document.querySelector('#provider-models').replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const model of provider?.models?.length ? provider.models : [{}]) modelRow(model, true, fragment);
    document.querySelector('#provider-models').append(fragment);
    i18n.text(document.querySelector('#provider-scan-status'), () => (''));
    modelCount(); httpConfirmation(); lockProvider(); i18n.prune();
  }
  function httpConfirmation() {
    let insecure = false;
    try { insecure = new URL(providerForm.elements.baseURL.value.trim()).protocol === 'http:'; } catch { /* URL validation runs before requests. */ }
    document.querySelector('#provider-http').hidden = !insecure; providerForm.elements.allowHttp.required = insecure;
  }
  document.querySelector('#provider-add-model').addEventListener('click', () => { if (modelRows().length < maximumProviderModels) modelRow(); providerForm.elements.acknowledge.checked = false; lockProvider(); modelCount(); });
  providerForm.elements.baseURL.addEventListener('input', () => { providerForm.elements.allowHttp.checked = false; providerForm.elements.allowPrivate.checked = false; providerForm.elements.acknowledge.checked = false; i18n.text(document.querySelector('#provider-scan-status'), () => ('')); httpConfirmation(); });
  providerForm.elements.clearKey.addEventListener('change', () => { if (providerForm.elements.clearKey.checked) providerForm.elements.apiKey.value = ''; lockProvider(); });
  function scheduleAutomaticScan() {
    clearTimeout(autoScanTimer);
    if (!providersPage) return;
    autoScanTimer = setTimeout(() => {
      if (!providerEditor.open || providerEditor.hasAttribute('data-delete') || document.hidden || busy || !available || providerLocked || !providerData?.supported || scannedVersion === connectionVersion) return;
      const { baseURL, apiKey, allowHttp, clearKey, providerId } = providerForm.elements;
      if ([baseURL, apiKey].includes(document.activeElement) || !baseURL.value.trim() || !baseURL.checkValidity() || !apiKey.value.trim() || clearKey.checked || allowHttp.required && !allowHttp.checked || providerId.value && !providerId.checkValidity()) return;
      scanModels({ automatic: true });
    }, 1000);
  }
  for (const name of ['baseURL', 'apiKey', 'providerId']) {
    const control = providerForm.elements[name];
    control.addEventListener('input', () => { connectionVersion++; providerForm.elements.acknowledge.checked = false; scheduleAutomaticScan(); });
    control.addEventListener('change', scheduleAutomaticScan);
    control.addEventListener('blur', scheduleAutomaticScan);
  }
  for (const name of ['allowHttp', 'allowPrivate', 'clearKey']) providerForm.elements[name].addEventListener('change', () => { connectionVersion++; scheduleAutomaticScan(); });
  document.querySelector('#provider-refresh').addEventListener('click', async event => {
    event.target.disabled = true;
    try { await refresh(); message('Đã tải lại danh sách và cấu hình nhà cung cấp.'); }
    catch (error) { message(error.message); }
    finally { lockProvider(); }
  });
  document.querySelector('#provider-select-all').addEventListener('click', () => chooseModels(true));
  document.querySelector('#provider-uncheck-all').addEventListener('click', () => chooseModels(false));
  async function scanModels({ automatic = false } = {}) {
    clearTimeout(autoScanTimer);
    const status = document.querySelector('#provider-scan-status');
    const scanMessage = text => { i18n.text(status, () => text); message(text); };
    if (!providerEditor.open || busy || !available || providerLocked || !providerData?.supported) return;
    if (!providerForm.elements.baseURL.reportValidity()) { scanMessage(providerForm.elements.baseURL.validationMessage); return; }
    if (providerForm.elements.allowHttp.required && !providerForm.elements.allowHttp.checked) { scanMessage('Vui lòng xác nhận dùng HTTP trước khi quét model.'); providerForm.elements.allowHttp.focus(); return; }
    const fields = { revision: providerRevision, provider: {
      id: providerForm.elements.providerId.value.trim(), baseURL: providerForm.elements.baseURL.value.trim(), apiKey: providerForm.elements.apiKey.value.trim(), clearKey: providerForm.elements.clearKey.checked,
      allowHttp: providerForm.elements.allowHttp.checked, allowPrivate: providerForm.elements.allowPrivate.checked,
    } };
    const version = connectionVersion;
    scannedVersion = version;
    busy = true; automaticScanning = automatic; lockProvider(); i18n.text(status, () => ('Đang lấy danh sách model từ nhà cung cấp…'));
    try {
      await refresh();
      const data = await call('provider-models', fields);
      if (version !== connectionVersion) return;
      const rows = modelRows(), existing = new Set(rows.map(row => row.querySelector('[data-model-field=id]').value.trim()));
      const added = data.models.filter(model => !existing.has(model.id));
      const empty = rows.filter(row => ![...row.querySelectorAll('[data-model-field]')].some(input => input.value.trim()));
      if (rows.length - empty.length + added.length > maximumProviderModels) throw new Error(`Danh sách gộp vượt ${maximumProviderModels} model. Hãy bỏ bớt model rồi quét lại.`);
      empty.forEach(row => row.remove());
      const fragment = document.createDocumentFragment();
      for (const model of added) modelRow(model, true, fragment);
      document.querySelector('#provider-models').append(fragment);
      i18n.prune();
      providerForm.elements.acknowledge.checked = false;
      modelCount();
      i18n.text(status, () => (`Quét được ${data.models.length} model, thêm ${added.length} model mới vào biểu mẫu.${data.skipped ? ` Bỏ qua ${data.skipped} mục trùng hoặc không hợp lệ.` : ''} Các lựa chọn và tên model đang có được giữ lại. Chưa lưu cấu hình.`));
      message('Đã quét model. Dùng Select All hoặc Uncheck All, chọn model cần dùng rồi lưu nhà cung cấp.');
    } catch (error) {
      if (version === connectionVersion) {
        scanMessage(error.message);
        if (!automatic) status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
    finally {
      busy = false; automaticScanning = false; lockProvider();
      if (automatic && version !== connectionVersion) scheduleAutomaticScan();
    }
  }
  document.querySelector('#provider-scan-models').addEventListener('click', scanModels);
  window.addEventListener('pagehide', () => { clearTimeout(toastTimer); clearTimeout(autoScanTimer); clearTimeout(timer); notice.hidden = true; });
  window.addEventListener('beforeunload', event => { if (providersPage && (providerSubmitting || providerPendingId !== undefined)) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pageshow', event => { if (event.persisted) refreshWithRetry(); });
  providerForm.addEventListener('submit', async event => {
    event.preventDefault(); if (!providerEditor.open || busy || !available || !providerData?.supported || providerLocked) return;
    if (!providerForm.elements.acknowledge.checked) { message('Vui lòng tải lại danh sách và xác nhận đồng ý tải lại cấu hình OpenCode.'); return; }
    const remove = providerEditor.hasAttribute('data-delete') || event.submitter?.name === 'remove', id = providerForm.elements.providerId.value.trim();
    const fields = { acknowledge: true, revision: providerRevision };
    const existingIDs = new Set(providerData?.providers?.find(provider => provider.id === id)?.models?.map(model => model.id) || []);
    const visibility = { id, remove, choices: remove ? [] : modelRows().filter(row => row.querySelector('[data-model-selected]').checked && (row.dataset.visibilityChanged === 'true' || !existingIDs.has(row.querySelector('[data-model-field=id]').value.trim()))).map(row => ({ modelID: row.querySelector('[data-model-field=id]').value.trim(), visible: row.querySelector('[data-model-visible]').checked })) };
    if (remove) fields.id = id;
    else fields.provider = { id, name: providerForm.elements.providerName.value.trim(), baseURL: providerForm.elements.baseURL.value.trim(), apiKey: providerForm.elements.apiKey.value.trim(), clearKey: providerForm.elements.clearKey.checked, allowHttp: providerForm.elements.allowHttp.checked,
      models: modelRows().filter(row => row.querySelector('[data-model-selected]').checked).map(row => Object.fromEntries([...row.querySelectorAll('[data-model-field]')].map(input => [input.dataset.modelField, input.value.trim()]))) };
    if (!remove && !fields.provider.models.length) { message('Hãy chọn ít nhất một model trước khi lưu nhà cung cấp.'); return; }
    busy = true; providerSubmitting = true; lockProvider();
    try {
      // Reject unavailable/malformed browser preferences before changing server configuration.
      try { readModelPreferences(localStorage); }
      catch { throw new Error('Không truy cập được bộ nhớ trình duyệt. Hãy cho phép lưu trữ rồi thử lại.'); }
      await refresh();
      const data = await call(remove ? 'provider-remove' : 'provider-save', fields);
      providerForm.elements.apiKey.value = ''; providerForm.elements.acknowledge.checked = false;
      watchingJob = true; providerPendingId = id; providerPendingVisibility = visibility; message(data.message);
    } catch (error) { message(error.message); }
    finally { busy = false; providerSubmitting = false; refreshWithRetry(); }
  });
  async function refresh() { draw(await call(nativePage ? 'opencode-status' : providersPage ? 'providers-status' : 'status')); }
  for (const [selector, operation] of [['#check-update', 'check'], ['#native-check', 'opencode-check']]) document.querySelector(selector).addEventListener('click', async event => {
    event.target.disabled = true;
    try { draw(await call(operation, {})); }
    catch (error) { message(error.message); }
    finally { event.target.disabled = busy || !available; }
  });
  for (const form of document.querySelectorAll('form')) form.addEventListener('submit', async event => {
    if (form === providerForm) return;
    event.preventDefault();
    if (busy || !available) return;
    const operation = form.id === 'password-form' ? 'password' : form.id === 'native-form' ? form.elements.version.value ? 'opencode-install' : 'opencode-update' : event.submitter?.name === 'install' ? 'update' : 'preferences';
    const fields = {};
    if (operation === 'opencode-install') fields.version = form.elements.version.value;
    if (operation === 'password') {
      if (form.elements.newPassword.value !== form.elements.confirmPassword.value) { message('Hai ô mật khẩu mới chưa khớp.'); return; }
      if (!form.elements.acknowledge.checked) { message('Vui lòng xác nhận đã lưu công việc và đồng ý khởi động lại OpenCode.'); return; }
      fields.newPassword = form.elements.newPassword.value; fields.confirmPassword = form.elements.confirmPassword.value; fields.acknowledge = true;
    }
    if (['update', 'opencode-update', 'opencode-install'].includes(operation)) {
      if (!form.elements.acknowledge.checked) { message('Vui lòng xác nhận đã lưu công việc trước khi cập nhật.'); return; }
      fields.acknowledge = true;
    }
    if (operation === 'preferences') { fields.automatic = form.elements.automatic.checked; fields.channel = form.elements.channel.value; }
    busy = true; form.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      await refresh();
      const data = await call(operation, fields);
      if (['update', 'opencode-update', 'opencode-install'].includes(operation)) watchingJob = true;
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
    if (event.key === 'Escape' && providerEditor.open) { event.preventDefault(); event.stopPropagation(); closeProviderEditor(); return; }
    if (event.key === 'Escape' && window.parent !== window) window.parent.postMessage({ type: 'web-login-close' }, location.origin);
  });
  if (providersPage) lockProvider();
  refreshWithRetry();
})();
