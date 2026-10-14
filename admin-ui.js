import { i18n } from '/login/i18n-client.js';

(() => {
  'use strict';
  const notice = document.querySelector('#notice');
  const passwordPage = location.pathname.endsWith('/password');
  const nativePage = location.pathname.endsWith('/opencode');
  const providersPage = location.pathname.endsWith('/providers');
  document.querySelector(passwordPage ? '#password-page' : nativePage ? '#opencode-page' : providersPage ? '#providers-page' : '#updates-page').hidden = false;
  i18n.text(document.querySelector('title'), () => i18n.t(passwordPage ? 'Đổi mật khẩu' : nativePage ? 'Update & Downgrade' : providersPage ? 'Nhà cung cấp tùy chỉnh' : 'Cập nhật Web Login Module') + ' · OpenCode');
  document.querySelectorAll('form button, #check-update, #native-check').forEach(button => { button.disabled = true; });
  let csrf, busy = false, available = false, timer, reconnecting = false, watchingJob = false, nativeInfo, nativeLocked;
  let providerData, providerRevision, providerLocked, providerPendingId;
  const providerForm = document.querySelector('#provider-form');
  const maximumProviderModels = 2000;
  const modelRows = () => [...document.querySelectorAll('.provider-model-row')];
  const message = text => { i18n.text(notice, () => (text)); };
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
      if (providersPage) providerForm.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
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
    if (providersPage) {
      providerData = data.providers || {}; providerLocked = locked;
      const picker = document.querySelector('#provider-picker'), selected = picker.value;
      picker.replaceChildren(i18n.option(() => ('Thêm nhà cung cấp mới'), ''), ...(providerData.providers || []).map(provider => {
        const option = i18n.option(() => (`${provider.name} (${provider.id})${provider.editable ? '' : i18n.t(' — kiểu cấu hình khác')}`), provider.id);
        option.disabled = !provider.editable; return option;
      }));
      if ([...picker.options].some(option => option.value === selected && !option.disabled)) picker.value = selected;
      if (providerRevision === undefined && providerData.supported) fillProvider('');
      if (providerPendingId !== undefined && data.job?.phase === 'succeeded') { fillProvider((providerData.providers || []).some(provider => provider.id === providerPendingId) ? providerPendingId : ''); providerPendingId = undefined; }
      if (data.job?.phase === 'failed') providerPendingId = undefined;
      i18n.text(document.querySelector('#provider-info'), () => (providerData.supported ? 'Cấu hình OpenAI-compatible được lưu vào tệp JSON/JSONC của OpenCode. API key đã lưu không hiển thị lại.' : providerData.reason || 'Chưa đọc được cấu hình nhà cung cấp.'));
      i18n.text(document.querySelector('#provider-job'), () => (data.job?.message || ''));
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
    const disabled = busy || !available || providerLocked || !providerData?.supported;
    providerForm.querySelectorAll('input, button').forEach(control => { control.disabled = disabled; });
    document.querySelector('#provider-picker').disabled = disabled;
    document.querySelector('#provider-refresh').disabled = busy || !available || providerLocked;
    providerForm.elements.remove.disabled = disabled || !document.querySelector('#provider-picker').value;
    document.querySelector('#provider-add-model').disabled = disabled || modelRows().length >= maximumProviderModels;
    providerForm.elements.apiKey.disabled = disabled || providerForm.elements.clearKey.checked;
  }
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
      const label = document.createElement('label'); i18n.text(label, () => (title));
      const input = document.createElement('input'); input.type = 'text'; input.maxLength = 128; input.dataset.modelField = field; input.value = model[field] || ''; input.required = field === 'id' && selected; input.autocomplete = 'off'; input.dir = field === 'id' ? 'ltr' : 'auto';
      input.addEventListener('input', () => { providerForm.elements.acknowledge.checked = false; if (field === 'id') i18n.attr(checkbox, 'aria-label', () => (`Chọn model ${input.value || i18n.t('mới')}`)); });
      label.append(input); row.append(label);
    }
    checkbox.addEventListener('change', () => { row.querySelector('[data-model-field=id]').required = checkbox.checked; providerForm.elements.acknowledge.checked = false; modelCount(); });
    const remove = document.createElement('button'); remove.type = 'button'; i18n.text(remove, () => ('Bỏ model'));
    remove.addEventListener('click', () => {
      if (modelRows().length > 1) row.remove();
      else { row.querySelectorAll('[data-model-field]').forEach(input => { input.value = ''; }); checkbox.checked = true; row.querySelector('[data-model-field=id]').required = true; }
      providerForm.elements.acknowledge.checked = false; lockProvider(); modelCount(); i18n.prune();
    });
    row.append(remove); container.append(row);
  }
  function chooseModels(selected) {
    for (const row of modelRows()) { row.querySelector('[data-model-selected]').checked = selected; row.querySelector('[data-model-field=id]').required = selected; }
    providerForm.elements.acknowledge.checked = false; modelCount();
  }
  function fillProvider(id) {
    const provider = providerData?.providers?.find(provider => provider.id === id);
    document.querySelector('#provider-picker').value = provider?.id || '';
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
  document.querySelector('#provider-picker').addEventListener('change', event => fillProvider(event.target.value));
  document.querySelector('#provider-add-model').addEventListener('click', () => { if (modelRows().length < maximumProviderModels) modelRow(); providerForm.elements.acknowledge.checked = false; lockProvider(); modelCount(); });
  providerForm.elements.baseURL.addEventListener('input', () => { providerForm.elements.allowHttp.checked = false; providerForm.elements.allowPrivate.checked = false; providerForm.elements.acknowledge.checked = false; i18n.text(document.querySelector('#provider-scan-status'), () => ('')); httpConfirmation(); });
  providerForm.elements.clearKey.addEventListener('change', () => { if (providerForm.elements.clearKey.checked) providerForm.elements.apiKey.value = ''; lockProvider(); });
  document.querySelector('#provider-refresh').addEventListener('click', async event => {
    event.target.disabled = true;
    try { await refresh(); fillProvider(document.querySelector('#provider-picker').value); message('Đã tải lại danh sách và cấu hình nhà cung cấp.'); }
    catch (error) { message(error.message); }
    finally { lockProvider(); }
  });
  document.querySelector('#provider-select-all').addEventListener('click', () => chooseModels(true));
  document.querySelector('#provider-uncheck-all').addEventListener('click', () => chooseModels(false));
  document.querySelector('#provider-scan-models').addEventListener('click', async () => {
    if (busy || !available || providerLocked || !providerData?.supported) return;
    if (!providerForm.elements.baseURL.reportValidity()) return;
    if (providerForm.elements.allowHttp.required && !providerForm.elements.allowHttp.checked) { message('Vui lòng xác nhận dùng HTTP trước khi quét model.'); providerForm.elements.allowHttp.focus(); return; }
    if (!providerForm.elements.password.value) { message('Nhập mật khẩu OpenCode hiện tại ở bên dưới để quét model.'); providerForm.elements.password.focus(); return; }
    const fields = { password: providerForm.elements.password.value, revision: providerRevision, provider: {
      id: providerForm.elements.providerId.value.trim(), baseURL: providerForm.elements.baseURL.value.trim(), apiKey: providerForm.elements.apiKey.value.trim(), clearKey: providerForm.elements.clearKey.checked,
      allowHttp: providerForm.elements.allowHttp.checked, allowPrivate: providerForm.elements.allowPrivate.checked,
    } };
    const status = document.querySelector('#provider-scan-status');
    busy = true; lockProvider(); i18n.text(status, () => ('Đang lấy danh sách model từ nhà cung cấp…'));
    try {
      await refresh();
      const data = await call('provider-models', fields);
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
    } catch (error) { i18n.text(status, () => (error.message)); message(error.message); }
    finally { busy = false; lockProvider(); }
  });
  providerForm.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !available || !providerData?.supported || providerLocked) return;
    if (!providerForm.elements.password.value || !providerForm.elements.acknowledge.checked) { message('Nhập mật khẩu hiện tại và xác nhận đồng ý tải lại cấu hình trước khi lưu hoặc xóa.'); return; }
    const remove = event.submitter?.name === 'remove', id = providerForm.elements.providerId.value.trim();
    const fields = { password: providerForm.elements.password.value, acknowledge: true, revision: providerRevision };
    if (remove) fields.id = id;
    else fields.provider = { id, name: providerForm.elements.providerName.value.trim(), baseURL: providerForm.elements.baseURL.value.trim(), apiKey: providerForm.elements.apiKey.value.trim(), clearKey: providerForm.elements.clearKey.checked, allowHttp: providerForm.elements.allowHttp.checked,
      models: modelRows().filter(row => row.querySelector('[data-model-selected]').checked).map(row => Object.fromEntries([...row.querySelectorAll('[data-model-field]')].map(input => [input.dataset.modelField, input.value.trim()]))) };
    if (!remove && !fields.provider.models.length) { message('Hãy chọn ít nhất một model trước khi lưu nhà cung cấp.'); return; }
    busy = true; lockProvider();
    try {
      await refresh();
      const data = await call(remove ? 'provider-remove' : 'provider-save', fields);
      providerForm.elements.apiKey.value = ''; providerForm.elements.password.value = ''; providerForm.elements.acknowledge.checked = false;
      watchingJob = true; providerPendingId = id; message(data.message);
    } catch (error) { message(error.message); }
    finally { busy = false; refreshWithRetry(); }
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
    const password = form.elements.password.value;
    const operation = form.id === 'password-form' ? 'password' : form.id === 'native-form' ? form.elements.version.value ? 'opencode-install' : 'opencode-update' : event.submitter?.name === 'install' ? 'update' : 'preferences';
    const fields = { password };
    if (operation === 'opencode-install') fields.version = form.elements.version.value;
    if (operation === 'password') {
      if (form.elements.newPassword.value !== form.elements.confirmPassword.value) { message('Hai ô mật khẩu mới chưa khớp.'); return; }
      fields.newPassword = form.elements.newPassword.value; fields.confirmPassword = form.elements.confirmPassword.value;
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
    if (event.key === 'Escape' && window.parent !== window) window.parent.postMessage({ type: 'web-login-close' }, location.origin);
  });
  if (providersPage) lockProvider();
  refreshWithRetry();
})();
