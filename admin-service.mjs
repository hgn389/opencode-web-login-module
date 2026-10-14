import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, lstatSync, existsSync, renameSync, rmSync, mkdtempSync, readlinkSync, readdirSync, copyFileSync, chownSync, symlinkSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import { dirname, join, isAbsolute, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execFile } from 'node:child_process';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { readResponse, backendInfo } from './http-client.mjs';
import { latestRelease, download, extractPackage, compareVersions, moduleFiles, repository, latestOpenCode, openCodeRelease, openCodeVersions, downloadOpenCode, validateOpenCodePackage, openCodePackage, openCodePlatforms, legacyOpenCodePackage, legacyOpenCodePlatforms, packageForOpenCode, supportedOpenCodeVersion, versionParts } from './update.mjs';
import { normalizeConfig } from './config.mjs';
import { parse, parseTree, modify, applyEdits } from 'jsonc-parser';
import { maximumProviderModels, providerFailure, providerText, providerConnection, validModelID, fetchProviderModels } from './provider-models.mjs';

const providerPackage = '@opencode/ai/providers/openai-compatible';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateCustomProvider(value) {
  if (!record(value) || !/^[a-z][a-z0-9_-]{0,62}$/.test(value.id || '') || ['constructor', 'prototype', '__proto__'].includes(value.id)) throw providerFailure(422, 'ID nhà cung cấp cần bắt đầu bằng chữ thường, chỉ gồm chữ thường, số, dấu gạch ngang hoặc gạch dưới; tối đa 63 ký tự.');
  if (!providerText(value.name, 128)) throw providerFailure(422, 'Tên nhà cung cấp không hợp lệ; tối đa 128 ký tự.');
  const connection = providerConnection(value);
  if (!Array.isArray(value.models) || !value.models.length || value.models.length > maximumProviderModels) throw providerFailure(422, `Cần khai báo từ 1 đến ${maximumProviderModels} model.`);
  const ids = new Set();
  const models = value.models.map(model => {
    if (!record(model) || !validModelID(model.id) || ids.has(model.id)) throw providerFailure(422, 'Model ID không hợp lệ hoặc bị trùng.');
    if (model.name !== undefined && model.name !== '' && !providerText(model.name, 128)) throw providerFailure(422, 'Tên hiển thị model không hợp lệ.');
    ids.add(model.id); return { id: model.id, name: model.name || model.id };
  });
  const { allowPrivate, ...savedConnection } = connection;
  return { id: value.id, name: value.name, ...savedConnection, models };
}

function providerDocument(text) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw providerFailure(422, 'Tệp cấu hình quá lớn để sửa qua web.');
  const errors = [], options = { allowTrailingComma: true };
  const tree = parseTree(text, errors, options);
  if (errors.length || tree?.type !== 'object') throw providerFailure(422, 'Tệp cấu hình JSON/JSONC đang có lỗi; chưa ghi thay đổi.');
  const visit = (node, depth = 0) => {
    if (depth > 64) throw providerFailure(422, 'Tệp cấu hình lồng quá sâu.');
    if (node.type === 'object') {
      const seen = new Set();
      for (const property of node.children || []) {
        const key = property.children[0].value;
        if (seen.has(key) || key === '__proto__') throw providerFailure(422, 'Tệp cấu hình có khóa trùng hoặc không an toàn; chưa ghi thay đổi.');
        seen.add(key);
      }
    }
    for (const child of node.children || []) visit(child, depth + 1);
  };
  visit(tree);
  const data = parse(text, [], options);
  if (data.providers !== undefined && !record(data.providers)) throw providerFailure(422, 'Trường providers phải là một đối tượng.');
  return data;
}

function ownedProviderPath(path, directory = false, privateMode = false) {
  const info = lstatSync(path);
  if ((directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || info.uid !== process.getuid() || info.mode & (privateMode ? 0o077 : 0o022)) throw providerFailure(422, 'Tệp hoặc thư mục cấu hình có quyền truy cập không an toàn.');
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const entry = lstatSync(parent), temporary = entry.uid === 0 && entry.mode & 0o1000;
    if (!entry.isDirectory() || ![0, process.getuid()].includes(entry.uid) || entry.mode & 0o022 && !temporary) throw providerFailure(422, 'Thư mục cha của cấu hình không an toàn.');
    if (parent === '/') break;
  }
  return info;
}

function providerRead(path) {
  if (!lstatSync(path, { throwIfNoEntry: false })) return;
  ownedProviderPath(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.size > 1024 * 1024) throw providerFailure(422, 'Tệp cấu hình không an toàn hoặc quá lớn.');
    return { content: readFileSync(fd), mode: info.mode & 0o777 };
  } finally { closeSync(fd); }
}

function providerSource(context) {
  for (const field of ['directory', 'backupDirectory']) if (!isAbsolute(context[field] || '') || /[\x00-\x1f\x7f{}]/.test(context[field])) throw providerFailure(422, 'Đường dẫn cấu hình không hợp lệ.');
  mkdirSync(context.directory, { recursive: true, mode: 0o700 }); ownedProviderPath(context.directory, true);
  const file = context.file || ['opencode.jsonc', 'opencode.json'].map(name => join(context.directory, name)).find(path => lstatSync(path, { throwIfNoEntry: false })) || join(context.directory, 'opencode.json');
  if (dirname(file) !== context.directory) throw providerFailure(422, 'Đường dẫn cấu hình không hợp lệ.');
  const previous = providerRead(file), text = previous?.content.toString('utf8') || '{}\n', data = providerDocument(text);
  return { file, previous, text, data };
}

export function providerFileOperation(context, request) {
  if (request.action === 'read') return providerFileUnlocked(context, request);
  if (!isAbsolute(context.backupDirectory || '') || /[\x00-\x1f\x7f{}]/.test(context.backupDirectory)) throw providerFailure(422, 'Đường dẫn sao lưu không hợp lệ.');
  mkdirSync(context.backupDirectory, { recursive: true, mode: 0o700 }); ownedProviderPath(context.backupDirectory, true, true);
  const unlock = nativeOperationLock(context.backupDirectory);
  try { return providerFileUnlocked(context, request); }
  finally { unlock(); }
}

function providerFileUnlocked(context, request) {
  const { file, previous, text, data } = providerSource(context);
  const revision = value => createHash('sha256').update(file + '\0' + value).digest('hex');
  const secretDirectory = join(context.directory, '.web-login-secrets');
  const keyPattern = /^[a-z][a-z0-9_-]{0,79}\.key$/;
  const safeEndpoint = value => { try { const url = new URL(value); return providerText(value, 2048) && !/[{}]/.test(value) && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } };
  const summary = () => ({ status: 200, supported: true, revision: revision(text), providers: Object.entries(data.providers || {}).slice(0, 100).map(([id, provider]) => ({
    id, name: typeof provider?.name === 'string' ? provider.name : id,
    editable: provider?.package === providerPackage && Object.keys(provider.models || {}).length <= maximumProviderModels && (provider?.settings?.baseURL === undefined || safeEndpoint(provider.settings.baseURL)) && /^[a-z][a-z0-9_-]{0,62}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id),
    baseURL: safeEndpoint(provider?.settings?.baseURL) ? provider.settings.baseURL : '',
    hasKey: Boolean(provider?.settings?.apiKey || provider?.env?.length),
    models: Object.entries(provider?.models || {}).slice(0, maximumProviderModels).map(([id, model]) => ({ id, name: typeof model?.name === 'string' ? model.name : id })),
  })) });
  if (request.action === 'read') return summary();
  mkdirSync(context.backupDirectory, { recursive: true, mode: 0o700 }); ownedProviderPath(context.backupDirectory, true, true);
  if (request.action === 'restore') {
    if (!/^snapshot-[A-Za-z0-9]+$/.test(request.backup || '')) throw providerFailure(422, 'Bản sao lưu cấu hình không hợp lệ.');
    const directory = join(context.backupDirectory, request.backup); ownedProviderPath(directory, true, true);
    const manifest = JSON.parse(providerRead(join(directory, 'manifest.json')).content);
    if (manifest.file !== file || revision(text) !== manifest.afterRevision) throw providerFailure(409, 'Tệp đã thay đổi ở nơi khác; không ghi đè khi khôi phục. Bản sao lưu riêng vẫn được giữ.');
    for (const entry of manifest.entries) {
      if (entry.file !== file && (dirname(entry.file) !== secretDirectory || !keyPattern.test(entry.file.slice(secretDirectory.length + 1)))) throw providerFailure(422, 'Bản sao lưu cấu hình không hợp lệ.');
      if (entry.exists) atomic(entry.file, providerRead(join(directory, entry.saved)).content, entry.mode);
      else rmSync(entry.file, { force: true });
    }
    return { status: 200 };
  }
  if (!['save', 'remove'].includes(request.action) || request.revision !== revision(text)) throw providerFailure(409, 'Cấu hình đã thay đổi. Vui lòng tải lại danh sách trước khi lưu.');
  const input = request.action === 'save' ? validateCustomProvider(request.provider) : { id: request.id };
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(input.id || '') || ['constructor', 'prototype', '__proto__'].includes(input.id)) throw providerFailure(422, 'ID nhà cung cấp không hợp lệ.');
  const existing = data.providers?.[input.id];
  if (existing && existing.package !== providerPackage) throw providerFailure(422, 'Nhà cung cấp này dùng kiểu cấu hình khác; không sửa qua biểu mẫu OpenAI-compatible.');
  if (request.action === 'save' && Object.keys(existing?.models || {}).length > maximumProviderModels) throw providerFailure(422, `Nhà cung cấp có hơn ${maximumProviderModels} model; cần sửa tệp để tránh bỏ sót model khi dùng biểu mẫu.`);
  if (request.action === 'remove' && !existing) throw providerFailure(404, 'Không tìm thấy nhà cung cấp trong tệp cấu hình này.');
  if (request.action === 'remove' && typeof data.model === 'string' && data.model.startsWith(input.id + '/')) throw providerFailure(422, 'Nhà cung cấp đang được đặt làm model mặc định. Hãy đổi model mặc định trước khi xóa.');
  if (request.action === 'save' && typeof data.model === 'string' && data.model.startsWith(input.id + '/') && !input.models.some(model => input.id + '/' + model.id === data.model)) throw providerFailure(422, 'Model đang được đặt làm mặc định chưa được chọn. Hãy giữ model đó hoặc đổi model mặc định trước khi lưu.');
  if (request.action === 'save' && existing && existing.settings?.baseURL?.replace(/\/$/, '') !== input.baseURL && (existing.settings?.apiKey || existing.env?.length) && !input.apiKey && !input.clearKey) throw providerFailure(422, 'Khi đổi Base URL, hãy nhập lại hoặc xóa API key để tránh gửi khóa cũ tới địa chỉ mới.');
  const newKey = request.action === 'save' && input.apiKey ? join(secretDirectory, input.id + '-' + randomBytes(8).toString('hex') + '.key') : undefined;
  const reference = existing?.settings?.apiKey;
  const previousKey = typeof reference === 'string' && reference.startsWith('{file:') && reference.endsWith('}') ? reference.slice(6, -1) : undefined;
  const relatedKey = previousKey && dirname(previousKey) === secretDirectory && keyPattern.test(previousKey.slice(secretDirectory.length + 1)) ? previousKey : undefined;
  const changes = [];
  if (request.action === 'remove') changes.push([['providers', input.id], undefined]);
  else {
    if (!existing) changes.push([['providers', input.id], { name: input.name, package: providerPackage, settings: { baseURL: input.baseURL }, models: {} }]);
    changes.push([['providers', input.id, 'name'], input.name], [['providers', input.id, 'settings', 'baseURL'], input.baseURL]);
    const models = Object.fromEntries(input.models.map(model => [model.id, { ...(existing?.models?.[model.id] || {}), name: model.name }]));
    changes.push([['providers', input.id, 'models'], models]);
    if (input.apiKey) changes.push([['providers', input.id, 'settings', 'apiKey'], `{file:${newKey}}`]);
    if (input.clearKey) changes.push([['providers', input.id, 'settings', 'apiKey'], undefined], [['providers', input.id, 'env'], []]);
  }
  let updated = text;
  for (const [path, value] of changes) updated = applyEdits(updated, modify(updated, path, value, { formattingOptions: { tabSize: 2, insertSpaces: true, eol: text.includes('\r\n') ? '\r\n' : '\n' } }));
  providerDocument(updated);
  mkdirSync(secretDirectory, { recursive: true, mode: 0o700 }); ownedProviderPath(secretDirectory, true, true);
  const savedKey = relatedKey ? providerRead(relatedKey) : undefined;
  const directory = mkdtempSync(join(context.backupDirectory, 'snapshot-'));
  if (savedKey) writeFileSync(join(directory, 'previous-key'), savedKey.content, { mode: 0o600, flag: 'wx' });
  const entries = [{ file, before: previous }, ...(newKey ? [{ file: newKey }] : [])].map((entry, index) => {
    if (entry.before) { writeFileSync(join(directory, String(index)), entry.before.content, { mode: 0o600, flag: 'wx' }); return { file: entry.file, exists: true, saved: String(index), mode: entry.before.mode }; }
    return { file: entry.file, exists: false };
  });
  const manifest = { file, entries, afterRevision: revision(updated) };
  atomic(join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n');
  const git = args => execFileSync('git', ['-C', context.backupDirectory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, env: { PATH: '/usr/bin:/bin', HOME: context.directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  if (!existsSync(join(context.backupDirectory, '.git'))) { git(['init', '--quiet']); chmodSync(join(context.backupDirectory, '.git'), 0o700); }
  ownedProviderPath(join(context.backupDirectory, '.git'), true, true);
  const snapshotName = directory.slice(context.backupDirectory.length + 1);
  git(['add', '--', snapshotName]); const tree = git(['write-tree']); git(['update-ref', `refs/snapshots/${snapshotName}`, tree]);
  if (revision(providerRead(file)?.content.toString('utf8') || '{}\n') !== request.revision) throw providerFailure(409, 'Cấu hình vừa thay đổi ở nơi khác. Chưa ghi thay đổi mới.');
  try {
    // A new immutable file keeps a changed endpoint from briefly reading the previous provider's key.
    if (newKey) writeFileSync(newKey, input.apiKey, { mode: 0o600, flag: 'wx' });
    // Retain removed key files in the private directory: another manually configured provider may reference one.
    atomic(file, updated, 0o600);
  } catch {
    for (const entry of entries) {
      if (entry.exists) atomic(entry.file, readFileSync(join(directory, entry.saved)), entry.mode);
      else rmSync(entry.file, { force: true });
    }
    throw providerFailure(503, 'Không lưu được cấu hình; đã thử khôi phục dữ liệu trước đó.');
  }
  return { status: 200, backup: snapshotName };
}

export async function discoverProviderModels(context, request, dependencies) {
  const source = providerSource(context);
  const revision = value => createHash('sha256').update(source.file + '\0' + value).digest('hex');
  if (request.revision !== revision(source.text)) throw providerFailure(409, 'Cấu hình đã thay đổi. Vui lòng tải lại danh sách trước khi quét.');
  const input = request.provider;
  const connection = providerConnection(input);
  const existing = input.id ? source.data.providers?.[input.id] : undefined;
  if (!connection.apiKey && !connection.clearKey && existing) {
    if (existing.package !== providerPackage) throw providerFailure(422, 'Nhà cung cấp này không dùng cấu hình OpenAI-compatible của module.');
    if (existing.settings?.baseURL?.replace(/\/$/, '') !== connection.baseURL) throw providerFailure(422, 'Khi đổi Base URL, hãy nhập lại hoặc xóa API key trước khi quét model.');
    const reference = existing.settings?.apiKey;
    if (typeof reference === 'string' && reference.startsWith('{file:') && reference.endsWith('}')) {
      const key = reference.slice(6, -1), directory = join(context.directory, '.web-login-secrets');
      if (dirname(key) !== directory || !/^[a-z][a-z0-9_-]{0,79}\.key$/.test(key.slice(directory.length + 1))) throw providerFailure(422, 'Khóa dùng tham chiếu tệp ngoài module. Hãy nhập API key để quét model.');
      ownedProviderPath(directory, true, true); ownedProviderPath(key, false, true);
      connection.apiKey = providerRead(key).content.toString('utf8');
    } else if (reference) connection.apiKey = reference;
    else if (existing.env?.length) throw providerFailure(422, 'Khóa đang lấy từ môi trường OpenCode. Hãy nhập API key để quét model.');
  }
  const result = await fetchProviderModels(connection, dependencies);
  if (revision(providerSource(context).text) !== request.revision) throw providerFailure(409, 'Cấu hình thay đổi trong lúc quét. Vui lòng tải lại danh sách.');
  return result;
}

async function providerContext(config) {
  const pid = command('systemctl', ['show', config.backendService, '-p', 'MainPID', '--value']);
  if (!/^[1-9]\d*$/.test(pid)) throw providerFailure(503, 'OpenCode chưa chạy.');
  const environment = new Map(readFileSync(`/proc/${pid}/environ`).toString().split('\0').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  const { password, username } = runningCredentials(config);
  const info = await backendInfo(config.gateway, 'Basic ' + Buffer.from(username + ':' + password).toString('base64'), { timeout: 1500 });
  if (info.status !== 200 || info.major !== 2) throw providerFailure(422, 'Nhà cung cấp tùy chỉnh trong module hiện dành cho OpenCode v2.');
  if (environment.get('OPENCODE_CONFIG_CONTENT')?.trim()) throw providerFailure(422, 'OpenCode đang dùng cấu hình inline. Hãy chuyển cấu hình inline sang tệp trước khi sửa provider qua module.');
  const user = command('systemctl', ['show', config.backendService, '-p', 'User', '--value']) || 'root';
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(user) || !isAbsolute(environment.get('HOME') || '')) throw providerFailure(422, 'Không xác định được tài khoản và thư mục cấu hình OpenCode.');
  const home = environment.get('HOME'), explicit = environment.get('OPENCODE_CONFIG');
  const file = explicit ? resolve(readlinkSync(`/proc/${pid}/cwd`), explicit) : undefined;
  return { user, gid: command('id', ['-g', user]), directory: file ? dirname(file) : join(environment.get('XDG_CONFIG_HOME') || join(home, '.config'), 'opencode'), file,
    backupDirectory: join(environment.get('XDG_STATE_HOME') || join(home, '.local/state'), 'opencode-web-login', 'provider-backup') };
}

async function providerWorker(config, context, request) {
  const args = ['--quiet', '--wait', '--pipe', '--collect', '--service-type=exec', `--unit=${config.name}-provider-${randomBytes(5).toString('hex')}`, `--uid=${context.user}`, `--gid=${context.gid}`, '--property=UMask=0077', '--property=NoNewPrivileges=yes', '--property=ProtectSystem=full', '--property=MemoryMax=128M', '--property=RuntimeMaxSec=30', config.node, join(config.installDirectory, 'admin-service.mjs'), 'provider-file'];
  const output = await new Promise((resolve, reject) => {
    const child = execFile('systemd-run', args, { encoding: 'utf8', timeout: 35000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('Provider file worker failed')) : resolve(stdout));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ context, request }));
  });
  const result = JSON.parse(output);
  if (!record(result) || !Number.isInteger(result.status)) throw new Error('Invalid provider worker response');
  return result;
}

async function providerReload(config, id, models, remove, baseURL) {
  const { password, username } = runningCredentials(config);
  const headers = { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') };
  const connection = { hostname: config.gateway.backendHost, port: config.gateway.backendPort };
  const reload = await readResponse({ ...connection, path: '/api/location/reload', method: 'POST', headers }, { timeout: 8000 });
  if (![200, 204].includes(reload.status)) throw new Error('OpenCode config reload failed');
  if (!id) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await readResponse({ ...connection, path: '/api/provider/' + encodeURIComponent(id), headers }, { timeout: 1500, limit: 1024 * 1024 });
    if (remove && response.status === 404) return;
    if (!remove && response.status === 200) {
      const payload = JSON.parse(response.body), provider = payload.data || payload;
      const catalog = await readResponse({ ...connection, path: '/api/model', headers }, { timeout: 1500, limit: 4 * 1024 * 1024 });
      const result = JSON.parse(catalog.body), entries = result.data || result;
      if (provider.id === id && provider.activation === 'enabled' && provider.settings?.baseURL?.replace(/\/$/, '') === baseURL && Array.isArray(entries) && models.every(model => entries.some(item => item.providerID === id && item.id === model.id && item.enabled !== false))) return;
    }
    await pause(200);
  }
  throw new Error('Provider configuration was not applied');
}

const command = (binary, args) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
const nativeRun = (binary, args, options = {}) => new Promise((resolve, reject) => {
  let failure, output = '';
  const child = execFile(binary, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024, ...options }, (error, stdout) => { failure = error; output = stdout; });
  child.once('close', () => failure ? reject(failure) : resolve(output.trim()));
});
function atomic(file, value, mode = 0o600) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.new';
  writeFileSync(temporary, value, { mode, flag: 'wx' });
  try { chmodSync(temporary, mode); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
function json(file, fallback) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
function privateState(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Unsafe administrative state directory; private permissions 0700 are required');
  for (const name of ['preferences.json', 'job.json', 'database-branches.json']) {
    const file = lstatSync(join(directory, name), { throwIfNoEntry: false });
    if (file && (!file.isFile() || file.uid !== process.getuid() || file.mode & 0o077)) throw new Error('Unsafe administrative state file; private permissions 0600 are required');
  }
}
function nativeOperationLock(directory) {
  const fd = openSync(join(directory, 'opencode.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.nlink !== 1 || info.mode & 0o077) throw new Error('Unsafe OpenCode operation lock');
    execFileSync('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 5000 });
    return () => closeSync(fd);
  } catch { closeSync(fd); throw new Error('Another OpenCode update or recovery is running, or its lock is unsafe'); }
}
const paths = config => ({
  state: `/var/lib/${config.name}-admin`,
  password: `/etc/${config.name}-backend-password.env`,
  dropin: `/etc/systemd/system/${config.backendService}.d/90-web-login-password.conf`,
});

export function runningPassword(config, run = command) {
  return runningCredentials(config, run).password;
}
function runningCredentials(config, run = command) {
  const pid = run('systemctl', ['show', config.backendService, '-p', 'MainPID', '--value']);
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('Backend not running');
  const environment = new Map(readFileSync(`/proc/${pid}/environ`).toString().split('\0').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  const password = environment.get('OPENCODE_PASSWORD') || environment.get('OPENCODE_SERVER_PASSWORD');
  if (!password) throw new Error('Backend password not configured');
  return { password, username: environment.get('OPENCODE_SERVER_USERNAME') || 'opencode' };
}
export function validPassword(value) {
  return typeof value === 'string' && [...value].length >= 16 && [...value].length <= 128 && !/[\x00-\x1f\x7f]/.test(value) && value.trim().length >= 16;
}

export function privateBackup(config, files) {
  const root = `/var/lib/${config.name}-install-backup`;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o077) throw new Error('Unsafe backup directory');
  if (!existsSync(join(root, '.git'))) command('git', ['init', '--quiet', root]);
  const snapshot = files.map(file => {
    const previous = lstatSync(file, { throwIfNoEntry: false });
    if (!previous) return { file };
    if (!previous.isFile() || previous.uid !== 0 || previous.mode & 0o022) throw new Error('Unsafe administrative file');
    const content = readFileSync(file);
    const destination = join(root, file.slice(1));
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeFileSync(destination, content, { mode: 0o600 });
    chmodSync(destination, 0o600);
    return { file, content, mode: previous.mode & 0o777 };
  });
  command('git', ['-C', root, 'add', '--all']);
  if (command('git', ['-C', root, 'diff', '--cached', '--name-only'])) command('git', ['-C', root, '-c', 'user.name=System Administrator', '-c', 'user.email=admin@localhost', 'commit', '--quiet', '-m', 'Back up configuration before a web administration change']);
  return () => {
    for (const item of snapshot) {
      if (item.content) atomic(item.file, item.content, item.mode);
      else rmSync(item.file, { force: true });
    }
  };
}

function writeBackendPassword(config, password) {
  const target = paths(config);
  atomic(target.password, `OPENCODE_PASSWORD=${JSON.stringify(password)}\nOPENCODE_SERVER_PASSWORD=${JSON.stringify(password)}\n`);
  atomic(target.dropin, `[Service]\nEnvironment=OPENCODE_PASSWORD=\nEnvironment=OPENCODE_SERVER_PASSWORD=\nEnvironmentFile=${target.password}\n`, 0o644);
}

export function protectBackendPassword(config, { run = command, backup = privateBackup } = {}) {
  if (process.getuid?.() !== 0) throw new Error('Protecting backend configuration requires root');
  const password = runningPassword(config, run);
  if (/[\x00-\x1f\x7f]/.test(password)) throw new Error('Backend password cannot be represented safely in EnvironmentFile');
  const fragment = run('systemctl', ['show', config.backendService, '-p', 'FragmentPath', '--value']);
  const dropins = run('systemctl', ['show', config.backendService, '-p', 'DropInPaths', '--value']);
  const unitFiles = [fragment, ...dropins.split(/\s+/).filter(Boolean)];
  const secretFiles = unitFiles.filter(file => {
    if (!isAbsolute(file)) throw new Error('Invalid backend unit path');
    const info = lstatSync(file);
    if (!info.isFile() || info.uid !== 0 || info.mode & 0o022) throw new Error('Unsafe backend unit file');
    return /OPENCODE_(?:SERVER_)?PASSWORD\s*=/.test(readFileSync(file, 'utf8'));
  });
  const target = paths(config);
  mkdirSync(dirname(target.dropin), { recursive: true, mode: 0o755 });
  const restore = backup(config, [...new Set([target.password, target.dropin, ...secretFiles])]);
  try {
    writeBackendPassword(config, password);
    for (const file of secretFiles) chmodSync(file, 0o600);
    run('systemctl', ['daemon-reload']);
    const visible = run('systemctl', ['show', config.backendService, '-p', 'Environment', '--value']);
    const nonempty = visible.replace(/(?:^|\s)(?:"OPENCODE_(?:SERVER_)?PASSWORD="|OPENCODE_(?:SERVER_)?PASSWORD=)(?=\s|$)/g, '');
    if (/OPENCODE_(?:SERVER_)?PASSWORD=/.test(nonempty)) throw new Error('A later drop-in exposes the password');
    return restore;
  } catch {
    restore(); run('systemctl', ['daemon-reload']);
    throw new Error('Could not protect backend password; previous configuration restored');
  }
}

export async function rotatePassword(config, password, { run = command, probe = readResponse, backup = privateBackup, revoke } = {}) {
  const target = paths(config);
  let username = 'opencode';
  try { username = runningCredentials(config, run).username; } catch { /* Test and standalone callers may not have a running unit. */ }
  mkdirSync(dirname(target.dropin), { recursive: true, mode: 0o755 });
  const restore = backup(config, [target.password, target.dropin]);
  try {
    writeBackendPassword(config, password);
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['restart', config.backendService]);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await backendInfo(config.gateway, 'Basic ' + Buffer.from(username + ':' + password).toString('base64'), { probe, timeout: 1000 });
        if (response.status === 200) { ready = true; break; }
      } catch { /* The backend may still be starting. */ }
      await pause(1000);
    }
    if (!ready) throw new Error('Backend did not accept new password');
    if (revoke) await revoke();
    else {
      const owner = run('systemctl', ['show', `${config.name}.service`, '-p', 'User', '--value']) || 'root';
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(owner) || !config.gateway.statePath || !config.node || !config.installDirectory) throw new Error('Invalid session revocation configuration');
      run('runuser', ['-u', owner, '--', '/usr/bin/env', `LOGIN_STATE_DB=${config.gateway.statePath}`, config.node, join(config.installDirectory, 'manage.mjs'), 'revoke-sessions']);
    }
    run('systemctl', ['restart', `${config.name}.service`]);
  } catch {
    restore();
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['restart', config.backendService]);
    run('systemctl', ['restart', `${config.name}.service`]);
    throw new Error('Password change failed; previous configuration restored');
  }
}

function trustedRootPath(file, directory = false) {
  const info = lstatSync(file);
  if (info.uid !== 0 || info.mode & 0o022 || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Unsafe OpenCode installation path');
  for (let parent = dirname(file); parent !== '/'; parent = dirname(parent)) {
    const value = lstatSync(parent);
    if (!value.isDirectory() || value.uid !== 0 || value.mode & 0o022) throw new Error('Unsafe OpenCode installation parent');
  }
}

function trustedCommand(file) {
  for (let count = 0; count < 8; count++) {
    const info = lstatSync(file);
    trustedRootPath(dirname(file), true);
    if (info.uid !== 0) throw new Error('Untrusted command owner');
    if (!info.isSymbolicLink()) { trustedRootPath(file); return file; }
    file = resolve(dirname(file), readlinkSync(file));
  }
  throw new Error('Too many command links');
}

export function openCodeInstallation(config) {
  trustedCommand(config.node);
  trustedCommand('/usr/bin/flock');
  const executable = trustedCommand(config.opencode);
  const packageDirectory = dirname(dirname(executable));
  const packageName = [openCodePackage, legacyOpenCodePackage].find(name => packageDirectory.endsWith(`/lib/node_modules/${name}`));
  const suffix = `/lib/node_modules/${packageName}`;
  if (!packageDirectory.endsWith(suffix) || /^\/(?:root|home|tmp)(?:\/|$)/.test(packageDirectory)) throw new Error('OpenCode is not a supported global npm installation');
  trustedRootPath(executable);
  trustedRootPath(join(packageDirectory, 'package.json'));
  const metadata = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'));
  const { version, binary } = validateOpenCodePackage(metadata);
  if (resolve(packageDirectory, binary) !== executable) throw new Error('OpenCode binary does not match its package');
  const prefix = packageDirectory.slice(0, -suffix.length);
  if (trustedCommand(join(prefix, 'bin/opencode')) !== executable) throw new Error('OpenCode npm command does not match the service');
  const npm = trustedCommand(existsSync(join(dirname(config.node), 'npm')) ? join(dirname(config.node), 'npm') : '/usr/bin/npm');
  if (!npm.endsWith('/npm/bin/npm-cli.js')) throw new Error('Unsupported npm executable');
  return { executable, packageDirectory, packageName, prefix, npm, version, binary };
}

export async function inspectOpenCode(config) {
  let version = null, installedVersion = null;
  try {
    const { password, username } = runningCredentials(config);
    const info = await backendInfo(config.gateway, 'Basic ' + Buffer.from(username + ':' + password).toString('base64'), { timeout: 1500 });
    if (info.status !== 200 || !versionParts(info.version)) throw new Error('OpenCode version unavailable');
    version = info.version;
    const installation = openCodeInstallation(config);
    installedVersion = installation.version;
    const pid = command('systemctl', ['show', config.backendService, '-p', 'MainPID', '--value']);
    if (readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '') !== installation.executable) throw new Error('Running service differs from its npm installation');
    return { version, installedVersion, supported: true, method: 'npm', pendingRestart: compareVersions(installedVersion, version) !== 0 };
  } catch {
    return { version, installedVersion, supported: false, reason: version ? 'Cần OpenCode v2 hoặc v1 từ 1.18.20, cài global bằng npm (@opencode/cli hoặc opencode-ai), ở đường dẫn cố định do root quản lý và dùng chung với dịch vụ.' : 'Chưa đọc được phiên bản OpenCode. Kiểm tra dịch vụ hoặc chờ tác vụ hiện tại hoàn tất.' };
  }
}

export function createAdminController(config, dependencies = {}) {
  const stateDir = dependencies.stateDir || paths(config).state;
  privateState(stateDir);
  const preferencesPath = join(stateDir, 'preferences.json');
  const jobPath = join(stateDir, 'job.json');
  const currentVersion = () => JSON.parse(readFileSync(join(config.installDirectory, 'package.json'), 'utf8')).version;
  const preferences = () => json(preferencesPath, { automatic: false, channel: 'stable' });
  const setJob = job => atomic(jobPath, JSON.stringify({ ...job, updated: Date.now() }) + '\n');
  const job = () => {
    const value = json(jobPath, null);
    if (['starting', 'running'].includes(value?.phase) && Date.now() - value.started > (value.type === 'opencode-update' ? 30 : 15) * 60000) {
      setJob({ ...value, phase: 'failed', recoveryRequired: value.type === 'opencode-update', message: 'Tác vụ bị gián đoạn hoặc quá thời gian. Kiểm tra dịch vụ và bản sao lưu trước khi thử lại.' });
      return json(jobPath, null);
    }
    return value;
  };
  const busy = () => { const value = job(); return ['starting', 'running'].includes(value?.phase) || value?.recoveryRequired === true; };
  const getPassword = dependencies.password || (() => runningPassword(config));
  const getRelease = dependencies.release || latestRelease;
  const rotate = dependencies.rotate || (password => rotatePassword(config, password));
  // The installer needs the host's existing OpenCode path, including installations under /tmp.
  const launch = dependencies.launch || (() => command('systemd-run', ['--quiet', `--unit=${config.name}-update`, '--collect', '--property=Type=exec', '--property=UMask=0077', '--property=NoNewPrivileges=yes', '--property=PrivateTmp=no', '--property=RuntimeMaxSec=600', '--property=TimeoutStopSec=15', '--property=StandardOutput=null', '--property=StandardError=null', config.node, join(config.installDirectory, 'admin-service.mjs'), 'apply', config.configPath]));
  const launchNative = dependencies.nativeLaunch || (() => command('systemd-run', ['--quiet', `--unit=${config.name}-opencode-update`, '--collect', '--property=Type=exec', '--property=UMask=0077', '--property=NoNewPrivileges=yes', '--property=PrivateTmp=no', '--property=MemoryMax=1G', '--property=RuntimeMaxSec=1200', '--property=TimeoutStopSec=120', '--property=StandardOutput=null', '--property=StandardError=null', config.node, join(config.installDirectory, 'admin-service.mjs'), 'opencode-apply', config.configPath]));
  const inspectNative = dependencies.nativeInfo || (() => inspectOpenCode(config));
  const releaseNative = dependencies.nativeRelease || latestOpenCode;
  const selectedNative = dependencies.nativeSelectedRelease || openCodeRelease;
  const listNative = dependencies.nativeVersions || openCodeVersions;
  const getProviderContext = dependencies.providerContext || (() => providerContext(config));
  const runProvider = dependencies.providerWorker || ((context, request) => providerWorker(config, context, request));
  const reloadProvider = dependencies.providerReload || ((...args) => providerReload(config, ...args));
  const providerExists = dependencies.providerExists || (async id => {
    const { password, username } = runningCredentials(config);
    const response = await readResponse({ hostname: config.gateway.backendHost, port: config.gateway.backendPort, path: '/api/provider/' + encodeURIComponent(id), headers: { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') } }, { timeout: 2000, limit: 1024 * 1024 });
    if (![200, 404].includes(response.status)) throw new Error('Provider lookup failed');
    return response.status === 200;
  });
  let nativeRelease = null, nativeChecked = 0, nativeError = '', nativeChecking, nativeMajor;
  let versions = [], versionsChecked = 0, versionsError = '', versionsChecking;
  let cachedRelease = null, checked = 0, checkError = '', checking, preferenceRevision = 0;
  let attempts = 0, until = 0, discovering = false, discoveryAttempts = 0, discoveryUntil = 0;
  const matchesPassword = password => typeof password === 'string' && password.length <= 2048 && equal(password, getPassword());
  const authenticate = password => {
    if (Date.now() >= until) { until = Date.now() + 60000; attempts = 0; }
    if (++attempts > 10) return { status: 429, message: 'Quá nhiều lần xác nhận mật khẩu. Vui lòng thử lại sau một phút.' };
    if (!matchesPassword(password)) return { status: 401, message: 'Mật khẩu hiện tại không đúng.' };
  };
  async function check(force = false) {
    if (checking) return checking;
    if (checked && Date.now() - checked < (force ? 60000 : 300000)) return;
    checking = (async () => {
      const channel = preferences().channel;
      const version = currentVersion(), revision = preferenceRevision;
      try { cachedRelease = await getRelease(version, channel); checkError = ''; }
      catch { cachedRelease = null; checkError = 'Chưa kiểm tra được GitHub. Vui lòng thử lại sau.'; }
      if (revision !== preferenceRevision || channel !== preferences().channel || version !== currentVersion()) { checked = 0; cachedRelease = null; checkError = ''; }
      else checked = Date.now();
    })();
    try { await checking; } finally { checking = null; }
  }
  const status = () => {
    const value = job();
    return { status: 200, available: true, version: currentVersion(), repository, preferences: preferences(),
      release: cachedRelease && { version: cachedRelease.version, url: cachedRelease.url }, checked, checkError,
      job: value && { type: value.type, phase: value.phase, version: value.version, message: value.message, updated: value.updated, recoveryRequired: value.recoveryRequired === true } };
  };
  async function checkNative() {
    if (nativeChecking) return nativeChecking;
    nativeChecking = (async () => {
      try {
        const info = await inspectNative(), major = versionParts(info.installedVersion)?.core[0] || 2;
        if (nativeMajor === major && nativeChecked && Date.now() - nativeChecked < 60000) return;
        nativeMajor = major; nativeRelease = await releaseNative({ major }); nativeError = '';
      }
      catch { nativeRelease = null; nativeError = 'Chưa kiểm tra được bản OpenCode mới từ npm. Vui lòng thử lại sau.'; }
      nativeChecked = Date.now();
    })();
    try { await nativeChecking; } finally { nativeChecking = null; }
  }
  async function checkVersions() {
    if (versionsChecking) return versionsChecking;
    if (versionsChecked && Date.now() - versionsChecked < (versionsError ? 60000 : 300000)) return;
    versionsChecking = (async () => {
      try { versions = await listNative(); if (!Array.isArray(versions) || versions.length > 500 || versions.some(v => !supportedOpenCodeVersion(v))) throw new Error('Invalid versions'); versionsError = ''; }
      catch { versions = []; versionsError = 'Chưa tải được danh sách phiên bản từ GitHub. Vui lòng thử lại sau.'; }
      versionsChecked = Date.now();
    })();
    try { await versionsChecking; } finally { versionsChecking = null; }
  }
  async function nativeStatus() {
    const info = await inspectNative();
    if (nativeMajor && nativeMajor !== versionParts(info.installedVersion)?.core[0]) { nativeRelease = null; nativeChecked = 0; nativeError = ''; }
    const newer = info.installedVersion && nativeRelease && compareVersions(nativeRelease.version, info.installedVersion) > 0;
    return { ...status(), opencode: { ...info, checked: nativeChecked, checkError: nativeError,
      release: nativeRelease && { version: nativeRelease.version, url: nativeRelease.url }, versions, versionsChecked, versionsError,
      canUpdate: Boolean(info.supported && !busy() && (newer || info.pendingRestart)) } };
  }
  async function providersStatus() {
    try {
      const context = await getProviderContext(), result = await runProvider(context, { action: 'read' });
      if (result.status !== 200) return { ...status(), providers: { supported: false, reason: result.message } };
      return { ...status(), providers: result };
    } catch (error) { return { ...status(), providers: { supported: false, reason: error.publicMessage || 'Chưa đọc được cấu hình nhà cung cấp. Kiểm tra quyền tệp và dịch vụ OpenCode.' } }; }
  }
  async function changeProvider(context, fields, input, remove) {
    let saved;
    try {
      if (!matchesPassword(fields.password)) throw providerFailure(401, 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.');
      const current = await runProvider(context, { action: 'read' });
      if (current.status !== 200) throw providerFailure(current.status, current.message);
      if (!remove && !current.providers.some(provider => provider.id === input.id) && await providerExists(input.id)) throw providerFailure(409, 'ID này đã được OpenCode hoặc cấu hình khác sử dụng. Hãy chọn một ID tùy chỉnh mới.');
      if (!matchesPassword(fields.password)) throw providerFailure(401, 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.');
      saved = await runProvider(context, remove ? { action: 'remove', id: input.id, revision: fields.revision } : { action: 'save', provider: input, revision: fields.revision });
      if (saved.status !== 200) throw providerFailure(saved.status, saved.message);
      setJob({ type: 'providers', phase: 'running', started: Date.now(), context, backup: saved.backup, message: 'Đã lưu tệp riêng; đang tải lại cấu hình và kiểm tra model trong OpenCode.' });
      await reloadProvider(input.id, input.models || [], remove, input.baseURL);
      setJob({ type: 'providers', phase: 'succeeded', message: remove ? 'Đã xóa nhà cung cấp tùy chỉnh và tải lại cấu hình OpenCode.' : 'Đã lưu nhà cung cấp tùy chỉnh; model đã xuất hiện trong OpenCode. Tải lại giao diện để chọn model.' });
    } catch (error) {
      let restored = !saved?.backup;
      if (saved?.backup) {
        try {
          const result = await runProvider(context, { action: 'restore', backup: saved.backup });
          restored = result.status === 200;
          if (restored) await reloadProvider(undefined, [], false);
        } catch { restored = false; }
      }
      setJob({ type: 'providers', phase: 'failed', context: saved?.backup ? context : undefined, backup: saved?.backup,
        message: saved?.backup ? restored ? 'Không áp dụng được provider; đã khôi phục cấu hình trước đó.' : 'Không áp dụng được provider; cần kiểm tra cấu hình và bản sao lưu riêng trên máy chủ.' : error.publicMessage || 'Không lưu được nhà cung cấp. Kiểm tra cấu hình và thử lại.' });
    }
  }
  async function startUpdate() {
    if (busy()) return { status: 409, message: 'Đang xử lý một tác vụ quản trị. Vui lòng chờ.' };
    if (!cachedRelease || compareVersions(cachedRelease.version, currentVersion()) <= 0) return { status: 409, message: 'Chưa có bản phát hành mới phù hợp.' };
    setJob({ type: 'update', phase: 'starting', version: cachedRelease.version, release: cachedRelease, started: Date.now(), message: 'Đang chuẩn bị cập nhật.' });
    try { await launch(); }
    catch { setJob({ type: 'update', phase: 'failed', message: 'Không khởi động được bộ cập nhật. Vui lòng kiểm tra dịch vụ quản trị.' }); return { status: 503, message: 'Không khởi động được bộ cập nhật.' }; }
    return { status: 202, message: 'Đã bắt đầu cập nhật. Trang có thể ngắt kết nối trong khi khởi động lại.' };
  }
  return {
    async call({ operation, ...fields }) {
      if (operation === 'status') return status();
      if (operation === 'check') { await check(true); return status(); }
      if (operation === 'opencode-status') return nativeStatus();
      if (operation === 'opencode-check') { await Promise.all([checkNative(), checkVersions()]); return nativeStatus(); }
      if (operation === 'providers-status') return providersStatus();
      if (!['password', 'preferences', 'update', 'opencode-update', 'opencode-install', 'provider-save', 'provider-remove', 'provider-models'].includes(operation)) return { status: 400, message: 'Thao tác không hợp lệ.' };
      const rejected = authenticate(fields.password);
      if (rejected) return rejected;
      if (busy()) return { status: 409, message: 'Đang xử lý một tác vụ quản trị. Vui lòng chờ.' };
      if (operation === 'provider-models') {
        if (discovering) return { status: 409, message: 'Đang quét model. Vui lòng chờ.' };
        if (Date.now() >= discoveryUntil) { discoveryUntil = Date.now() + 60000; discoveryAttempts = 0; }
        if (++discoveryAttempts > 6) return { status: 429, message: 'Tối đa 6 lần quét model mỗi phút. Vui lòng chờ rồi thử lại.' };
        if (!/^[a-f0-9]{64}$/.test(fields.revision || '')) return { status: 422, message: 'Vui lòng tải lại danh sách trước khi quét model.' };
        discovering = true;
        try {
          providerConnection(fields.provider);
          if (fields.provider.id && (!/^[a-z][a-z0-9_-]{0,62}$/.test(fields.provider.id) || ['constructor', 'prototype', '__proto__'].includes(fields.provider.id))) throw providerFailure(422, 'ID nhà cung cấp không hợp lệ.');
          const context = await getProviderContext();
          if (!matchesPassword(fields.password)) return { status: 401, message: 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.' };
          if (busy()) return { status: 409, message: 'Đang xử lý một tác vụ quản trị. Vui lòng chờ.' };
          const result = await runProvider(context, { action: 'discover', revision: fields.revision, provider: fields.provider });
          if (!matchesPassword(fields.password)) return { status: 401, message: 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.' };
          return result;
        } catch (error) { return { status: error.status || 503, message: error.publicMessage || 'Không quét được model. Kiểm tra kết nối và cấu hình nhà cung cấp.' }; }
        finally { discovering = false; }
      }
      if (['provider-save', 'provider-remove'].includes(operation)) {
        if (fields.acknowledge !== true || !/^[a-f0-9]{64}$/.test(fields.revision || '')) return { status: 422, message: 'Vui lòng tải lại danh sách và xác nhận đồng ý tải lại cấu hình OpenCode.' };
        const remove = operation === 'provider-remove'; let input, context;
        try {
          input = remove ? { id: fields.id } : validateCustomProvider(fields.provider);
          if (!/^[a-z][a-z0-9_-]{0,62}$/.test(input.id || '') || ['constructor', 'prototype', '__proto__'].includes(input.id)) throw providerFailure(422, 'ID nhà cung cấp không hợp lệ.');
          context = await getProviderContext();
        } catch (error) { return { status: error.status || 503, message: error.publicMessage || 'Chưa xác định được cấu hình OpenCode để lưu provider.' }; }
        if (!matchesPassword(fields.password)) return { status: 401, message: 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.' };
        if (busy()) return { status: 409, message: 'Đang xử lý một tác vụ quản trị. Vui lòng chờ.' };
        setJob({ type: 'providers', phase: 'running', started: Date.now(), message: remove ? 'Đang xóa nhà cung cấp và tải lại cấu hình OpenCode.' : 'Đang sao lưu và lưu nhà cung cấp tùy chỉnh.' });
        setTimeout(() => changeProvider(context, fields, input, remove).catch(() => {}), 100);
        return { status: 202, message: 'Đã nhận yêu cầu. Trang sẽ theo dõi việc lưu và tải lại cấu hình OpenCode.' };
      }
      if (['opencode-update', 'opencode-install'].includes(operation)) {
        if (fields.acknowledge !== true) return { status: 422, message: 'Vui lòng xác nhận đã lưu công việc và đồng ý khởi động lại OpenCode.' };
        const explicit = operation === 'opencode-install';
        let selected;
        if (explicit) {
          if (!supportedOpenCodeVersion(fields.version)) return { status: 422, message: 'Phiên bản được chọn không hợp lệ hoặc chưa được hỗ trợ.' };
          await checkVersions();
          if (!versions.includes(fields.version)) return { status: 422, message: versionsError || 'Phiên bản không nằm trong danh sách phát hành chính thức. Vui lòng kiểm tra lại danh sách.' };
          selected = await selectedNative(fields.version, { signal: AbortSignal.timeout(6000) });
          if (selected.version !== fields.version) throw new Error('Selected release mismatch');
        } else await checkNative();
        if (!matchesPassword(fields.password)) return { status: 401, message: 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.' };
        const info = await inspectNative();
        if (!matchesPassword(fields.password)) return { status: 401, message: 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.' };
        if (busy()) return { status: 409, message: 'Đang xử lý một tác vụ quản trị. Vui lòng chờ.' };
        if (!info.supported) return { status: 422, message: info.reason };
        const release = explicit ? selected : nativeRelease && compareVersions(nativeRelease.version, info.installedVersion) > 0 ? nativeRelease : null;
        if (explicit && release.version === info.installedVersion && !info.pendingRestart) return { status: 409, message: 'OpenCode đã cài phiên bản được chọn.' };
        if (!release && !info.pendingRestart) return { status: 409, message: nativeError || 'OpenCode đã ở phiên bản mới nhất được hỗ trợ.' };
        const version = release?.version || info.installedVersion;
        const downgrade = compareVersions(version, info.installedVersion) < 0;
        setJob({ type: 'opencode-update', phase: 'starting', version, release: version === info.installedVersion ? null : release, explicitTarget: explicit, fromVersion: info.installedVersion, passwordRevision: createHash('sha256').update(getPassword()).digest('hex'), started: Date.now(), message: release ? `Đang chuẩn bị ${downgrade ? 'hạ cấp' : 'cập nhật'} OpenCode về ${version}.` : 'Đang chuẩn bị khởi động lại OpenCode để dùng bản đã cài.' });
        try { await launchNative(); }
        catch { setJob({ type: 'opencode-update', phase: 'failed', message: 'Không khởi động được bộ cập nhật OpenCode.' }); return { status: 503, message: 'Không khởi động được bộ cập nhật OpenCode.' }; }
        return { status: 202, message: 'Đã bắt đầu tác vụ OpenCode. Trang sẽ kiểm tra kết quả sau khi dịch vụ khởi động lại.' };
      }
      if (operation === 'preferences') {
        if (typeof fields.automatic !== 'boolean' || !['stable', 'beta'].includes(fields.channel)) return { status: 422, message: 'Cấu hình cập nhật không hợp lệ.' };
        if (!dependencies.stateDir) privateBackup(config, [preferencesPath]);
        atomic(preferencesPath, JSON.stringify({ automatic: fields.automatic, channel: fields.channel }) + '\n');
        preferenceRevision++;
        checked = 0; cachedRelease = null;
        return { ...status(), message: 'Đã lưu cấu hình cập nhật.' };
      }
      if (operation === 'update') {
        await check();
        if (!matchesPassword(fields.password)) return { status: 401, message: 'Mật khẩu hiện tại đã thay đổi. Vui lòng xác nhận lại.' };
        return startUpdate();
      }
      if (!validPassword(fields.newPassword) || fields.newPassword !== fields.confirmPassword || equal(fields.newPassword, fields.password)) return { status: 422, message: 'Mật khẩu mới cần khác mật khẩu cũ, từ 16 đến 128 ký tự và khớp với ô xác nhận.' };
      setJob({ type: 'password', phase: 'running', started: Date.now(), message: 'Đang đổi mật khẩu và khởi động lại OpenCode.' });
      setTimeout(async () => {
        try { await rotate(fields.newPassword); setJob({ type: 'password', phase: 'succeeded', message: 'Đã đổi mật khẩu. Vui lòng đăng nhập lại.' }); }
        catch { setJob({ type: 'password', phase: 'failed', message: 'Đổi mật khẩu thất bại. Kiểm tra cấu hình và bản sao lưu trên máy chủ.' }); }
      }, 500);
      return { status: 202, message: 'Đang đổi mật khẩu. Chờ OpenCode khởi động lại rồi đăng nhập bằng mật khẩu mới.' };
    },
    async automatic() {
      if (!preferences().automatic || busy()) return;
      await check();
      if (preferences().automatic && cachedRelease && !busy()) await startUpdate();
    },
  };
}

export function loadAdminConfig(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.uid !== 0 || info.mode & 0o077) throw new Error('Admin config must be root-owned with mode 0600');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!/^[a-z][a-z0-9-]{0,27}$/.test(config.name) || !/^[a-zA-Z0-9][a-zA-Z0-9@_.-]*\.service$/.test(config.backendService) || config.backendService === `${config.name}.service`) throw new Error('Invalid admin services');
  for (const value of [file, config.installDirectory, config.opencode, config.node]) if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f%$"\\]/.test(value)) throw new Error('Invalid admin path');
  if (config.socket !== `/run/${config.name}-admin/control.sock`) throw new Error('Invalid admin socket');
  return { ...config, gateway: normalizeConfig(config.gateway), configPath: file };
}

export async function serveAdmin(config) {
  const controller = createAdminController(config);
  const oldJob = json(join(paths(config).state, 'job.json'), null);
  if (oldJob?.type === 'password' && oldJob.phase === 'running') atomic(join(paths(config).state, 'job.json'), JSON.stringify({ type: 'password', phase: 'failed', message: 'Tác vụ đổi mật khẩu bị gián đoạn. Kiểm tra dịch vụ và đăng nhập lại.', updated: Date.now() }));
  if (oldJob?.type === 'providers' && oldJob.phase === 'running') atomic(join(paths(config).state, 'job.json'), JSON.stringify({ ...oldJob, phase: 'failed', message: 'Tác vụ provider bị gián đoạn. Tải lại danh sách để kiểm tra cấu hình; bản sao lưu riêng vẫn được giữ.', updated: Date.now() }));
  const directory = dirname(config.socket);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o027) throw new Error('Unsafe admin socket directory');
  rmSync(config.socket, { force: true });
  const server = http.createServer({ connectionsCheckingInterval: 1000 }, async (req, res) => {
    const send = result => { res.writeHead(result.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result)); };
    req.on('error', () => res.destroy());
    try {
      if (req.method !== 'POST' || req.url !== '/' || req.headers['content-type'] !== 'application/json') return send({ status: 400, message: 'Yêu cầu không hợp lệ.' });
      let size = 0;
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) { req.resume(); return send({ status: 413, message: 'Dữ liệu quá lớn.' }); }
        chunks.push(chunk);
      }
      send(await controller.call(JSON.parse(Buffer.concat(chunks).toString())));
    } catch { send({ status: 503, message: 'Dịch vụ quản trị tạm thời không khả dụng.' }); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 20; server.maxHeadersCount = 20;
  server.on('connection', socket => socket.on('error', () => socket.destroy()));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
  chmodSync(config.socket, 0o660);
  const timer = setInterval(() => controller.automatic().catch(() => {}), 3600000);
  timer.unref();
  const stop = () => { clearInterval(timer); server.closeAllConnections(); server.close(); rmSync(config.socket, { force: true }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  console.log('OpenCode web administration service ready');
  return server;
}

export async function applyUpdate(config, dependencies = {}) {
  const stateDir = dependencies.stateDir || paths(config).state;
  privateState(stateDir);
  const jobPath = join(stateDir, 'job.json');
  const job = json(jobPath, null);
  let staging;
  const finish = (phase, message) => atomic(jobPath, JSON.stringify({ ...job, phase, message, release: undefined, updated: Date.now() }) + '\n');
  try {
    if (job?.type !== 'update' || job.phase !== 'starting' || Date.now() - job.started > 600000) throw new Error('Invalid update job');
    const version = JSON.parse(readFileSync(join(config.installDirectory, 'package.json'), 'utf8')).version;
    const preferences = json(join(dependencies.stateDir || paths(config).state, 'preferences.json'), { automatic: false, channel: 'stable' });
    const release = await (dependencies.release || latestRelease)(version, preferences.channel);
    if (!release || release.version !== job.version || release.digest !== job.release.digest) throw new Error('Release changed since update was requested');
    finish('running', 'Đang tải và kiểm tra gói cập nhật.');
    staging = mkdtempSync(join(dirname(config.installDirectory), `.${config.name}-update-`));
    const archive = await (dependencies.download || download)(release.assetURL, 8 * 1024 * 1024, { asset: true });
    extractPackage(archive, staging, release);
    const binary = join(staging, 'bin/opencode-web-login.mjs');
    for (const file of moduleFiles.filter(x => x.endsWith('.mjs') || x.endsWith('.js'))) command(config.node, ['--check', join(staging, file)]);
    const env = { ...process.env, PATH: `${dirname(config.node)}:/usr/local/bin:/usr/bin:/bin`, npm_config_ignore_scripts: 'true', npm_config_registry: 'https://registry.npmjs.org' };
    (dependencies.execute || execFileSync)(config.node, [binary, 'install', '--name', config.name, '--install-dir', config.installDirectory, '--opencode-service', config.backendService, '--opencode-bin', config.opencode,
      '--host', config.gateway.host, '--port', String(config.gateway.port), '--backend-port', String(config.gateway.backendPort), '--public-origins', config.gateway.publicOrigins.join(','), '--trusted-proxies', config.gateway.trustedProxies.join(',')], {
      env, timeout: 480000, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024,
    });
    finish('succeeded', `Đã cập nhật Web Login Module lên ${release.version}.`);
  } catch {
    finish('failed', 'Cập nhật thất bại. Bản cài hiện tại được giữ lại hoặc khôi phục; kiểm tra bản sao lưu trên máy chủ.');
    process.exitCode = 1;
  } finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}

async function nativeContext(config) {
  const pid = command('systemctl', ['show', config.backendService, '-p', 'MainPID', '--value']);
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('OpenCode is not running');
  const user = command('systemctl', ['show', config.backendService, '-p', 'User', '--value']) || 'root';
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(user)) throw new Error('Invalid backend user');
  const environment = new Map(readFileSync(`/proc/${pid}/environ`).toString().split('\0').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  const databases = [...new Set(readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
    try { const file = readlinkSync(`/proc/${pid}/fd/${fd}`); return /\.(?:db|sqlite|sqlite3)$/.test(file) ? [file] : []; }
    catch { return []; }
  }))];
  if (!databases.length) {
    const data = join(environment.get('XDG_DATA_HOME') || join(environment.get('HOME') || '/', '.local/share'), 'opencode');
    const file = environment.get('OPENCODE_DB') || 'opencode.db';
    if (file !== ':memory:') databases.push(resolve(data, file));
  }
  if (!databases.length || databases.length > 16 || databases.some(file => !isAbsolute(file) || /[\x00-\x1f\x7f]/.test(file))) throw new Error('Unsupported database paths');
  const { password, username } = runningCredentials(config);
  const response = await readResponse({ hostname: config.gateway.backendHost, port: config.gateway.backendPort, path: '/api/session', headers: { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') } }, { timeout: 3000, limit: 1024 * 1024 });
  const payload = JSON.parse(response.body), sessions = payload.data || payload;
  if (response.status !== 200 || !Array.isArray(sessions) || sessions.some(item => typeof item.id !== 'string')) throw new Error('Session inventory unavailable');
  const data = join(environment.get('XDG_DATA_HOME') || join(environment.get('HOME') || '/', '.local/share'), 'opencode');
  const primaryDatabase = resolve(data, environment.get('OPENCODE_DB') || 'opencode.db');
  if (!databases.includes(primaryDatabase)) throw new Error('OpenCode database cannot be identified safely');
  return { user, username, uid: Number(command('id', ['-u', user])), gid: Number(command('id', ['-g', user])), databases, primaryDatabase, sessionIds: sessions.map(item => item.id) };
}

const databaseCopyScript = `
import { DatabaseSync, backup } from 'node:sqlite';
import { lstatSync, copyFileSync, chmodSync, renameSync, rmSync, constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
const entries=JSON.parse(process.argv[1]), action=process.argv[2], result=[];
for (let i=0;i<entries.length;i++) {
  const entry=entries[i], file=entry.file, saved='database-'+i+'.sqlite';
  if (action==='snapshot') {
    const info=lstatSync(file,{throwIfNoEntry:false});
    if (info && (!info.isFile() || info.uid!==process.getuid() || info.nlink!==1)) throw new Error('Unsafe backend database');
    if (info) { const db=new DatabaseSync(file,{readOnly:true}); try { if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Database check failed');await backup(db,saved);chmodSync(saved,0o600); } finally { db.close(); } }
    result.push({file,exists:Boolean(info),saved});
  } else {
    for(const suffix of ['-wal','-shm'])rmSync(file+suffix,{force:true});
    if(!entry.exists){rmSync(file,{force:true});continue}
    const temporary=file+'.restore-'+randomBytes(8).toString('hex');
    try {copyFileSync(entry.saved,temporary,constants.COPYFILE_EXCL);chmodSync(temporary,0o600);renameSync(temporary,file)}finally{rmSync(temporary,{force:true})}
  }
}
console.log(JSON.stringify(result));
`;

export async function snapshotOpenCode(config, installation, context, { run = nativeRun, root = `/var/lib/${config.name}-opencode-backup` } = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  trustedRootPath(root, true);
  if (lstatSync(root).mode & 0o077) throw new Error('OpenCode backups require mode 0700');
  const directory = mkdtempSync(join(root, 'snapshot-'));
  const files = join(directory, 'files'); mkdirSync(files, { mode: 0o700 });
  const targets = [join(installation.prefix, 'bin/opencode'), join(installation.prefix, 'bin/opencode2'), ...(context.administrativeFiles || [])];
  for (const name of [openCodePackage, ...openCodePlatforms, legacyOpenCodePackage, ...legacyOpenCodePlatforms]) {
    for (const file of ['package.json', 'postinstall.mjs', 'postinstall.js', 'README.md', 'bin/opencode', 'bin/opencode.exe']) targets.push(join(installation.prefix, 'lib/node_modules', name, file));
  }
  const entries = targets.map((file, index) => {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info) return { file, exists: false };
    trustedRootPath(dirname(file), true);
    if (info.uid !== 0 || !info.isSymbolicLink() && (!info.isFile() || info.mode & 0o022)) throw new Error('Unsafe OpenCode backup target');
    if (info.isSymbolicLink()) return { file, exists: true, link: readlinkSync(file) };
    const saved = `files/${index}`;
    copyFileSync(file, join(directory, saved)); chmodSync(join(directory, saved), 0o600);
    return { file, exists: true, saved, mode: info.mode & 0o777 };
  });
  atomic(join(directory, 'manifest.json'), JSON.stringify({ entries, context, version: installation.version }) + '\n');
  if (!existsSync(join(root, '.git'))) await run('git', ['init', '--quiet', root]);
  const index = join(root, `index-${randomBytes(8).toString('hex')}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await run('git', ['-C', root, 'read-tree', '--empty'], { env });
    await run('git', ['-C', root, 'add', '--', relative(root, files), relative(root, join(directory, 'manifest.json'))], { env });
    const tree = await run('git', ['-C', root, 'write-tree'], { env });
    await run('git', ['-C', root, 'update-ref', `refs/snapshots/${directory.slice(directory.lastIndexOf('/') + 1)}`, tree]);
  } finally { rmSync(index, { force: true }); }
  return directory;
}

export async function snapshotOpenCodeData(config, directory, { run = nativeRun } = {}) {
  const manifest = json(join(directory, 'manifest.json'));
  const data = join(directory, 'databases'); mkdirSync(data, { mode: 0o700 });
  const temporary = mkdtempSync(`/var/tmp/${config.name}-db-`);
  chownSync(temporary, manifest.context.uid, manifest.context.gid);
  try {
    manifest.databases = JSON.parse(await run('runuser', ['-u', manifest.context.user, '--', config.node, '--no-warnings', '--input-type=module', '-e', databaseCopyScript, JSON.stringify(manifest.context.databases.map(file => ({ file }))), 'snapshot'], { cwd: temporary, timeout: 60000 }));
    if (!Array.isArray(manifest.databases) || manifest.databases.length !== manifest.context.databases.length || manifest.databases.some((entry, index) => entry.file !== manifest.context.databases[index] || entry.saved !== `database-${index}.sqlite` || typeof entry.exists !== 'boolean')) throw new Error('Invalid database snapshot response');
    for (const entry of manifest.databases) if (entry.exists) {
      const fd = openSync(join(temporary, entry.saved), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.uid !== manifest.context.uid || info.nlink !== 1) throw new Error('Unsafe database snapshot');
        copyFileSync(`/proc/self/fd/${fd}`, join(data, entry.saved), constants.COPYFILE_EXCL); chownSync(join(data, entry.saved), 0, 0); chmodSync(join(data, entry.saved), 0o600);
      } finally { closeSync(fd); }
    }
    atomic(join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n');
  } finally {
    await removeNativeTemporary(config, manifest.context.user, temporary, run);
  }
}

async function removeNativeTemporary(config, user, directory, run) {
  await run('runuser', ['-u', user, '--', config.node, '-e', 'require("node:fs").rmSync(process.argv[1],{recursive:true,force:true})', directory], { cwd: '/var/tmp', timeout: 15000 });
}

export async function restoreOpenCode(config, directory, { run = nativeRun } = {}) {
  const manifest = json(join(directory, 'manifest.json'));
  for (const entry of manifest.entries) {
    if (!entry.exists) { rmSync(entry.file, { force: true }); continue; }
    mkdirSync(dirname(entry.file), { recursive: true, mode: 0o755 });
    const temporary = entry.file + '.' + randomBytes(8).toString('hex') + '.restore';
    try {
      if (entry.link !== undefined) symlinkSync(entry.link, temporary);
      else { copyFileSync(join(directory, entry.saved), temporary); chmodSync(temporary, entry.mode); }
      renameSync(temporary, entry.file);
    } finally { rmSync(temporary, { force: true }); }
  }
  if (!manifest.databases) return;
  const data = join(directory, 'databases');
  const temporary = mkdtempSync(`/var/tmp/${config.name}-db-`);
  let handedOver = false;
  try {
    for (const entry of manifest.databases) if (entry.exists) {
      const file = join(temporary, entry.saved);
      copyFileSync(join(data, entry.saved), file, constants.COPYFILE_EXCL); chmodSync(file, 0o600); chownSync(file, manifest.context.uid, manifest.context.gid);
    }
    chownSync(temporary, manifest.context.uid, manifest.context.gid);
    handedOver = true;
    await run('runuser', ['-u', manifest.context.user, '--', config.node, '--no-warnings', '--input-type=module', '-e', databaseCopyScript, JSON.stringify(manifest.databases), 'restore'], { cwd: temporary, timeout: 60000 });
  } finally {
    if (!handedOver) chownSync(temporary, manifest.context.uid, manifest.context.gid);
    await removeNativeTemporary(config, manifest.context.user, temporary, run);
  }
}

async function nativeHealthy(config, version, password, { probe = readResponse, signal, expectedSessions = [] } = {}) {
  for (let attempt = 0; attempt < 40; attempt++) {
    signal?.throwIfAborted();
    try {
      const username = runningCredentials(config).username;
      const options = { hostname: config.gateway.backendHost, port: config.gateway.backendPort, path: versionParts(version).core[0] === 1 ? '/global/health' : '/api/info', headers: { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64') } };
      const response = await backendInfo(config.gateway, options.headers.authorization, { probe, timeout: 1000, signal });
      const anonymous = await probe({ ...options, headers: {} }, { timeout: 1000, signal });
      if (response.status === 200 && response.version === version && anonymous.status === 401) {
        const sessionResponse = await probe({ ...options, path: '/api/session' }, { timeout: 3000, limit: 1024 * 1024, signal });
        const payload = JSON.parse(sessionResponse.body), sessions = payload.data || payload;
        if (sessionResponse.status === 200 && Array.isArray(sessions) && expectedSessions.every(id => sessions.some(item => item.id === id))) return true;
      }
    } catch { /* Wait for the restarted backend. */ }
    await pause(500);
  }
  return false;
}

export async function applyOpenCodeUpdate(config, dependencies = {}) {
  const stateDir = dependencies.stateDir || paths(config).state; privateState(stateDir);
  const jobPath = join(stateDir, 'job.json');
  const unlock = nativeOperationLock(stateDir);
  let job, staging, snapshot, stopped = false;
  try {
    job = json(jobPath, null);
    const age = Date.now() - job?.started;
    if (job?.type !== 'opencode-update' || job.phase !== 'starting' || !Number.isSafeInteger(job.started) || age < 0 || age > 600000) throw new Error('Invalid OpenCode update job');
  } catch (error) { unlock(); throw error; }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const run = dependencies.run || nativeRun;
  const finish = (phase, message, extra = {}) => { job = { ...job, phase, message, ...extra, updated: Date.now() }; atomic(jobPath, JSON.stringify(job) + '\n'); };
  try {
    const password = (dependencies.password || runningPassword)(config);
    if (job.passwordRevision !== createHash('sha256').update(password).digest('hex')) throw new Error('Password changed since confirmation');
    const installation = (dependencies.installation || openCodeInstallation)(config);
    if (!supportedOpenCodeVersion(job.version) || installation.version !== job.fromVersion || compareVersions(job.version, installation.version) < 0 && job.explicitTarget !== true) throw new Error('Installed OpenCode changed');
    if (!job.release && job.version !== installation.version) throw new Error('Invalid restart-only job');
    const context = structuredClone(await (dependencies.context || nativeContext)(config));
    const crossMajor = versionParts(job.version).core[0] !== versionParts(installation.version).core[0];
    const manualDropin = job.explicitTarget ? `/etc/systemd/system/${config.backendService}.d/96-web-login-manual-version.conf` : null;
    if (manualDropin) context.administrativeFiles = [manualDropin];
    let branchPlan;
    if (crossMajor) {
      const source = context.primaryDatabase;
      if (!isAbsolute(source || '') || !context.databases.includes(source)) throw new Error('Unsupported database for major version change');
      const mapFile = join(stateDir, 'database-branches.json'), dropin = `/etc/systemd/system/${config.backendService}.d/95-web-login-version.conf`;
      const branches = json(mapFile, {}), from = String(versionParts(installation.version).core[0]), to = String(versionParts(job.version).core[0]);
      if (branches[from] && branches[from] !== source) throw new Error('OpenCode database branch changed');
      branches[from] = source;
      const target = branches[to] || join(dirname(source), `opencode-web-login-v${to}.db`);
      if (!isAbsolute(target) || target === source || dirname(target) !== dirname(source) || /[\x00-\x1f\x7f]/.test(target)) throw new Error('Unsafe OpenCode database branch');
      branches[to] = target;
      branchPlan = { mapFile, dropin, branches, target };
      context.administrativeFiles = [...(context.administrativeFiles || []), mapFile, dropin];
      if (!context.databases.includes(target)) context.databases.push(target);
    }
    let stageBinary, npmEnvironment;
    if (job.release) {
      const release = await (dependencies.release || (job.explicitTarget ? options => openCodeRelease(job.version, options) : latestOpenCode))({ signal: abort.signal, major: versionParts(installation.version).core[0] });
      if (release.version !== job.version || release.integrity !== job.release.integrity || (job.explicitTarget !== true && compareVersions(release.version, installation.version) <= 0)) throw new Error('OpenCode release changed');
      finish('running', 'Đang tải và kiểm tra gói OpenCode trước khi dừng dịch vụ.');
      staging = mkdtempSync(join(dirname(config.installDirectory), `.${config.name}-opencode-`)); chmodSync(staging, 0o755);
      const archive = await (dependencies.download || downloadOpenCode)(release, { signal: abort.signal });
      const tarball = join(staging, 'opencode.tgz'); writeFileSync(tarball, archive, { mode: 0o644 });
      const userConfig = join(staging, 'user.npmrc'), globalConfig = join(staging, 'global.npmrc');
      writeFileSync(userConfig, '', { mode: 0o600, flag: 'wx' }); writeFileSync(globalConfig, '', { mode: 0o600, flag: 'wx' });
      npmEnvironment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key))), PATH: `${dirname(config.node)}:/usr/local/bin:/usr/bin:/bin`, npm_config_ignore_scripts: 'true', npm_config_registry: 'https://registry.npmjs.org', npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig, npm_config_cache: join(staging, 'npm-cache') };
      const npmOptions = { env: npmEnvironment, signal: abort.signal };
      await run(config.node, [installation.npm, 'install', '--prefix', staging, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tarball], npmOptions);
      const targetPackage = packageForOpenCode(job.version);
      const metadata = json(join(staging, 'node_modules', targetPackage, 'package.json'));
      validateOpenCodePackage(metadata);
      if (metadata.version !== job.version) throw new Error('Staged OpenCode version mismatch');
      const baseline = process.arch === 'x64' && !/\bavx2\b/i.test(readFileSync('/proc/cpuinfo', 'utf8'));
      const musl = !process.report.getReport().header.glibcVersionRuntime;
      const platform = `${targetPackage === legacyOpenCodePackage ? 'opencode' : openCodePackage}-linux-${process.arch}${baseline ? '-baseline' : ''}${musl ? '-musl' : ''}`;
      if (metadata.optionalDependencies[platform] !== job.version) throw new Error('Unsupported OpenCode platform');
      stageBinary = join(staging, 'node_modules', platform, 'bin/opencode'); trustedRootPath(stageBinary);
      for (let directory = dirname(stageBinary); directory !== dirname(staging); directory = dirname(directory)) chmodSync(directory, 0o755);
      chmodSync(stageBinary, 0o755);
      const platformMetadata = json(join(dirname(dirname(stageBinary)), 'package.json'));
      if (platformMetadata.name !== platform || platformMetadata.version !== job.version) throw new Error('OpenCode platform version mismatch');
      const validation = mkdtempSync(`/var/tmp/${config.name}-version-`); chownSync(validation, context.uid, context.gid);
      let version;
      try {
        version = await run('runuser', ['-u', context.user, '--', '/usr/bin/env', `XDG_DATA_HOME=${join(validation, 'data')}`, `XDG_STATE_HOME=${join(validation, 'state')}`, `XDG_CACHE_HOME=${join(validation, 'cache')}`, `XDG_CONFIG_HOME=${join(validation, 'config')}`, `OPENCODE_CONFIG_DIR=${join(validation, 'config')}`, `TMPDIR=${validation}`, stageBinary, '--version'], { signal: abort.signal, timeout: 15000 });
      } finally { await removeNativeTemporary(config, context.user, validation, run); }
      if (![job.version, `opencode v${job.version}`].includes(version.trim())) throw new Error('Staged OpenCode cannot run');
      if (crossMajor) {
        const allowed = [openCodePackage, legacyOpenCodePackage].map(name => join(installation.prefix, 'lib/node_modules', name));
        for (const name of Object.keys(metadata.bin)) {
          const existing = join(installation.prefix, 'bin', name);
          if (!lstatSync(existing, { throwIfNoEntry: false })) continue;
          const target = trustedCommand(existing);
          if (!allowed.some(directory => [join(directory, 'bin/opencode'), join(directory, 'bin/opencode.exe')].includes(target))) throw new Error('OpenCode command would replace an unrelated executable');
        }
      }
    }
    const current = (dependencies.installation || openCodeInstallation)(config);
    if (current.version !== job.fromVersion) throw new Error('OpenCode changed during preparation');
    if ((dependencies.password || runningPassword)(config) !== password) throw new Error('Password changed during preparation');
    abort.signal.throwIfAborted();
    snapshot = await (dependencies.snapshot || snapshotOpenCode)(config, installation, context, { run });
    finish('running', 'Đang sao lưu dữ liệu và khởi động lại OpenCode.', { backup: snapshot, stopStarted: true });
    // Once stopping begins, every failure restores the saved installation and databases.
    stopped = true;
    await run('systemctl', ['stop', `${config.name}.service`, config.backendService], { signal: abort.signal });
    await (dependencies.snapshotData || snapshotOpenCodeData)(config, snapshot, { run });
    if (manualDropin) {
      mkdirSync(dirname(manualDropin), { recursive: true, mode: 0o755 }); trustedRootPath(dirname(manualDropin), true);
      atomic(manualDropin, '[Service]\nEnvironment=OPENCODE_DISABLE_AUTOUPDATE=1\n', 0o644);
    }
    if (branchPlan) {
      mkdirSync(dirname(branchPlan.dropin), { recursive: true, mode: 0o755 }); trustedRootPath(dirname(branchPlan.dropin), true);
      atomic(branchPlan.mapFile, JSON.stringify(branchPlan.branches) + '\n');
      atomic(branchPlan.dropin, `[Service]\nEnvironment=${JSON.stringify('OPENCODE_DB=' + branchPlan.target.replaceAll('%', '%%'))}\nEnvironment=OPENCODE_DISABLE_AUTOUPDATE=1\n`, 0o644);
    }
    if (branchPlan || manualDropin) await run('systemctl', ['daemon-reload']);
    if (stageBinary) {
      await run(config.node, [installation.npm, 'install', '--global', '--prefix', installation.prefix, ...(crossMajor ? ['--force'] : []), '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(staging, 'opencode.tgz')], { env: npmEnvironment, signal: abort.signal });
      const packageDirectory = join(installation.prefix, 'lib/node_modules', packageForOpenCode(job.version));
      const installed = json(join(packageDirectory, 'package.json')); const identity = validateOpenCodePackage(installed);
      if (identity.version !== job.version) throw new Error('Installed OpenCode version mismatch');
      const binary = resolve(packageDirectory, identity.binary);
      trustedRootPath(binary);
      const temporary = binary + '.' + randomBytes(8).toString('hex') + '.new';
      try { copyFileSync(stageBinary, temporary, constants.COPYFILE_EXCL); chmodSync(temporary, 0o755); renameSync(temporary, binary); }
      finally { rmSync(temporary, { force: true }); }
      for (let directory = dirname(binary); directory !== installation.prefix; directory = dirname(directory)) { trustedRootPath(directory, true); chmodSync(directory, 0o755); }
      if ((dependencies.installation || openCodeInstallation)(config).version !== job.version) throw new Error('OpenCode command changed');
    }
    await run('systemctl', ['start', config.backendService], { signal: abort.signal });
    if (!await (dependencies.healthy || nativeHealthy)(config, job.version, password, { signal: abort.signal, expectedSessions: crossMajor ? [] : context.sessionIds })) throw new Error('Updated OpenCode health check failed');
    if (crossMajor) {
      const owner = await run('systemctl', ['show', `${config.name}.service`, '-p', 'User', '--value']);
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(owner || 'root') || !config.gateway.statePath) throw new Error('Invalid session revocation configuration');
      await run('runuser', ['-u', owner || 'root', '--', '/usr/bin/env', `LOGIN_STATE_DB=${config.gateway.statePath}`, config.node, join(config.installDirectory, 'manage.mjs'), 'revoke-sessions']);
    }
    await run('systemctl', ['start', `${config.name}.service`], { signal: abort.signal });
    finish('succeeded', `OpenCode đang chạy phiên bản ${job.version}.`, { release: undefined });
  } catch (error) {
    try { dependencies.onError?.(error); } catch { /* Diagnostics must not interrupt rollback. */ }
    if (staging) { try { rmSync(staging, { recursive: true, force: true }); staging = undefined; } catch { /* Attempt recovery even if temporary files cannot be removed. */ } }
    let restored = !stopped;
    if (stopped && snapshot) {
      try {
        await run('systemctl', ['stop', `${config.name}.service`, config.backendService]);
        await (dependencies.restore || restoreOpenCode)(config, snapshot, { run });
        await run('systemctl', ['daemon-reload']);
        await run('systemctl', ['start', config.backendService]);
        restored = await (dependencies.healthy || nativeHealthy)(config, job.fromVersion, (dependencies.password || runningPassword)(config));
        if (restored) await run('systemctl', ['start', `${config.name}.service`]);
      } catch { restored = false; }
    }
    finish('failed', restored ? 'Cập nhật OpenCode thất bại. Bản cài và dữ liệu trước đó đã được giữ lại hoặc khôi phục.' : 'Cập nhật OpenCode thất bại; khôi phục chưa hoàn tất. Cần quản trị viên kiểm tra bản sao lưu trên máy chủ.', { recoveryRequired: !restored, release: undefined });
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    if (staging) { try { rmSync(staging, { recursive: true, force: true }); } catch { /* The private job records the result independently of cleanup. */ } }
    unlock();
  }
}

export async function recoverOpenCodeUpdate(config, dependencies = {}) {
  const stateDir = dependencies.stateDir || paths(config).state; privateState(stateDir);
  const unlock = nativeOperationLock(stateDir);
  try { await recoverNativeOperation(config, dependencies, stateDir); }
  finally { unlock(); }
}

async function recoverNativeOperation(config, dependencies, stateDir) {
  const jobPath = join(stateDir, 'job.json'), job = json(jobPath, null);
  if (job?.type !== 'opencode-update' || job.phase === 'succeeded' || !job.recoveryRequired && !['starting', 'running'].includes(job.phase)) throw new Error('No interrupted OpenCode update to recover');
  const run = dependencies.run || nativeRun;
  const active = await run('systemctl', ['show', `${config.name}-opencode-update.service`, '-p', 'ActiveState', '--value']);
  if (!['inactive', 'failed'].includes(active)) throw new Error('OpenCode update is still running');
  if (!job.backup && job.stopStarted !== true) {
    const installation = (dependencies.installation || openCodeInstallation)(config);
    if (installation.version !== job.fromVersion || !await (dependencies.healthy || nativeHealthy)(config, job.fromVersion, (dependencies.password || runningPassword)(config))) throw new Error('Interrupted preparation cannot be safely cleared');
    atomic(jobPath, JSON.stringify({ ...job, phase: 'failed', recoveryRequired: false, release: undefined, message: 'Tác vụ bị ngắt khi chuẩn bị; bản cài và dịch vụ cũ vẫn hoạt động. Có thể kiểm tra lại trước khi cập nhật.', updated: Date.now() }) + '\n');
    return;
  }
  const root = `/var/lib/${config.name}-opencode-backup`;
  if (typeof job.backup !== 'string' || dirname(job.backup) !== root || !/^snapshot-[A-Za-z0-9]+$/.test(job.backup.slice(root.length + 1))) throw new Error('No valid OpenCode backup');
  trustedRootPath(job.backup, true); trustedRootPath(join(job.backup, 'manifest.json'));
  await run('systemctl', ['stop', `${config.name}.service`, config.backendService]);
  try {
    await (dependencies.restore || restoreOpenCode)(config, job.backup);
    await run('systemctl', ['daemon-reload']);
    await run('systemctl', ['start', config.backendService]);
    if (!await (dependencies.healthy || nativeHealthy)(config, job.fromVersion, (dependencies.password || runningPassword)(config))) throw new Error('Recovered service is not healthy');
    await run('systemctl', ['start', `${config.name}.service`]);
    atomic(jobPath, JSON.stringify({ ...job, phase: 'failed', recoveryRequired: false, message: 'Đã khôi phục OpenCode và dữ liệu từ bản sao lưu. Có thể kiểm tra lại trước khi cập nhật.', updated: Date.now() }) + '\n');
  } catch {
    atomic(jobPath, JSON.stringify({ ...job, phase: 'failed', recoveryRequired: true, message: 'Khôi phục chưa hoàn tất. Cần kiểm tra dịch vụ và bản sao lưu trên máy chủ.', updated: Date.now() }) + '\n');
    throw new Error('OpenCode recovery failed');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === 'provider-file' && process.argv.length === 3) {
      process.umask(0o077);
      try {
        let size = 0; const chunks = [];
        for await (const chunk of process.stdin) { size += chunk.length; if (size > 2 * 1024 * 1024) throw providerFailure(413, 'Dữ liệu cấu hình quá lớn.'); chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        console.log(JSON.stringify(input.request.action === 'discover' ? await discoverProviderModels(input.context, input.request) : providerFileOperation(input.context, input.request)));
      } catch (error) { console.log(JSON.stringify({ status: error.status || 503, message: error.publicMessage || 'Không xử lý được tệp cấu hình nhà cung cấp an toàn.' })); }
    } else {
      if (process.getuid?.() !== 0 || !['serve', 'apply', 'opencode-apply', 'opencode-recover'].includes(process.argv[2]) || process.argv.length !== 4) throw new Error('Run as a configured root system service');
      const config = loadAdminConfig(process.argv[3]);
      await (process.argv[2] === 'serve' ? serveAdmin(config) : process.argv[2] === 'apply' ? applyUpdate(config) : process.argv[2] === 'opencode-apply' ? applyOpenCodeUpdate(config) : recoverOpenCodeUpdate(config));
    }
  } catch { console.error('OpenCode web administration failed; check private configuration and service state.'); process.exitCode = 1; }
}
