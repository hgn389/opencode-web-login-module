import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, lstatSync, existsSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { readResponse } from './http-client.mjs';
import { latestRelease, download, extractPackage, compareVersions, moduleFiles, repository } from './update.mjs';
import { normalizeConfig } from './config.mjs';

const command = (binary, args) => execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const equal = (a, b) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
function atomic(file, value, mode = 0o600) {
  const temporary = file + '.' + randomBytes(8).toString('hex') + '.new';
  writeFileSync(temporary, value, { mode, flag: 'wx' });
  try { chmodSync(temporary, mode); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}
function json(file, fallback) { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; }
const paths = config => ({
  state: `/var/lib/${config.name}-admin`,
  password: `/etc/${config.name}-backend-password.env`,
  dropin: `/etc/systemd/system/${config.backendService}.d/90-web-login-password.conf`,
});

export function runningPassword(config, run = command) {
  const pid = run('systemctl', ['show', config.backendService, '-p', 'MainPID', '--value']);
  if (!/^[1-9]\d*$/.test(pid)) throw new Error('Backend not running');
  const environment = new Map(readFileSync(`/proc/${pid}/environ`).toString().split('\0').filter(x => x.includes('=')).map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
  const password = environment.get('OPENCODE_PASSWORD') || environment.get('OPENCODE_SERVER_PASSWORD');
  if (!password) throw new Error('Backend password not configured');
  return password;
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

export async function rotatePassword(config, password, { run = command, probe = readResponse, backup = privateBackup } = {}) {
  const target = paths(config);
  mkdirSync(dirname(target.dropin), { recursive: true, mode: 0o755 });
  const restore = backup(config, [target.password, target.dropin]);
  try {
    // EnvironmentFile values override Environment values; both native variable names are set.
    atomic(target.password, `OPENCODE_PASSWORD=${JSON.stringify(password)}\nOPENCODE_SERVER_PASSWORD=${JSON.stringify(password)}\n`);
    atomic(target.dropin, `[Service]\nEnvironmentFile=${target.password}\n`, 0o644);
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['restart', config.backendService]);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const response = await probe({ hostname: config.gateway.backendHost, port: config.gateway.backendPort, path: '/api/info', headers: { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') } }, { timeout: 1000 });
        if (response.status === 200 && (response.headers['content-type'] || '').includes('application/json')) { ready = true; break; }
      } catch { /* The backend may still be starting. */ }
      await pause(1000);
    }
    if (!ready) throw new Error('Backend did not accept new password');
    run('systemctl', ['restart', `${config.name}.service`]);
  } catch {
    restore();
    run('systemctl', ['daemon-reload']);
    run('systemctl', ['restart', config.backendService]);
    run('systemctl', ['restart', `${config.name}.service`]);
    throw new Error('Password change failed; previous configuration restored');
  }
}

export function createAdminController(config, dependencies = {}) {
  const stateDir = dependencies.stateDir || paths(config).state;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const preferencesPath = join(stateDir, 'preferences.json');
  const jobPath = join(stateDir, 'job.json');
  const currentVersion = () => JSON.parse(readFileSync(join(config.installDirectory, 'package.json'), 'utf8')).version;
  const preferences = () => json(preferencesPath, { automatic: false, channel: 'stable' });
  const setJob = job => atomic(jobPath, JSON.stringify({ ...job, updated: Date.now() }) + '\n');
  const job = () => {
    const value = json(jobPath, null);
    if (['starting', 'running'].includes(value?.phase) && Date.now() - value.started > 15 * 60000) {
      setJob({ ...value, phase: 'failed', message: 'Tác vụ bị gián đoạn hoặc quá thời gian. Kiểm tra dịch vụ và bản sao lưu trước khi thử lại.' });
      return json(jobPath, null);
    }
    return value;
  };
  const busy = () => ['starting', 'running'].includes(job()?.phase);
  const getPassword = dependencies.password || (() => runningPassword(config));
  const getRelease = dependencies.release || latestRelease;
  const rotate = dependencies.rotate || (password => rotatePassword(config, password));
  // The installer needs the host's existing OpenCode path, including installations under /tmp.
  const launch = dependencies.launch || (() => command('systemd-run', ['--quiet', `--unit=${config.name}-update`, '--collect', '--property=Type=exec', '--property=UMask=0077', '--property=NoNewPrivileges=yes', '--property=PrivateTmp=no', '--property=RuntimeMaxSec=600', '--property=TimeoutStopSec=15', '--property=StandardOutput=null', '--property=StandardError=null', config.node, join(config.installDirectory, 'admin-service.mjs'), 'apply', config.configPath]));
  let cachedRelease = null, checked = 0, checkError = '', checking;
  let attempts = 0, until = 0;
  const authenticate = password => {
    if (Date.now() >= until) { until = Date.now() + 60000; attempts = 0; }
    if (++attempts > 10) return { status: 429, message: 'Quá nhiều lần xác nhận mật khẩu. Vui lòng thử lại sau một phút.' };
    if (typeof password !== 'string' || password.length > 2048 || !equal(password, getPassword())) return { status: 401, message: 'Mật khẩu hiện tại không đúng.' };
  };
  async function check(force = false) {
    if (checking) return checking;
    if (checked && Date.now() - checked < (force ? 60000 : 300000)) return;
    checking = (async () => {
      const channel = preferences().channel;
      try { cachedRelease = await getRelease(currentVersion(), channel); checkError = ''; }
      catch { cachedRelease = null; checkError = 'Chưa kiểm tra được GitHub. Vui lòng thử lại sau.'; }
      if (channel !== preferences().channel) { checked = 0; cachedRelease = null; }
      else checked = Date.now();
    })();
    try { await checking; } finally { checking = null; }
  }
  const status = () => {
    const value = job();
    return { status: 200, available: true, version: currentVersion(), repository, preferences: preferences(),
      release: cachedRelease && { version: cachedRelease.version, url: cachedRelease.url }, checked, checkError,
      job: value && { type: value.type, phase: value.phase, version: value.version, message: value.message, updated: value.updated } };
  };
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
      if (!['password', 'preferences', 'update'].includes(operation)) return { status: 400, message: 'Thao tác không hợp lệ.' };
      const rejected = authenticate(fields.password);
      if (rejected) return rejected;
      if (busy()) return { status: 409, message: 'Đang xử lý một tác vụ quản trị. Vui lòng chờ.' };
      if (operation === 'preferences') {
        if (typeof fields.automatic !== 'boolean' || !['stable', 'beta'].includes(fields.channel)) return { status: 422, message: 'Cấu hình cập nhật không hợp lệ.' };
        if (!dependencies.stateDir) privateBackup(config, [preferencesPath]);
        atomic(preferencesPath, JSON.stringify({ automatic: fields.automatic, channel: fields.channel }) + '\n');
        checked = 0; cachedRelease = null;
        return { ...status(), message: 'Đã lưu cấu hình cập nhật.' };
      }
      if (operation === 'update') { await check(); return startUpdate(); }
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
      if (cachedRelease && !busy()) await startUpdate();
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
  const directory = dirname(config.socket);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== 0 || info.mode & 0o007) throw new Error('Unsafe admin socket directory');
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
        if (size > 8192) { req.resume(); return send({ status: 413, message: 'Dữ liệu quá lớn.' }); }
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
  const jobPath = join(dependencies.stateDir || paths(config).state, 'job.json');
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.getuid?.() !== 0 || !['serve', 'apply'].includes(process.argv[2]) || process.argv.length !== 4) throw new Error('Run as a configured root system service');
    const config = loadAdminConfig(process.argv[3]);
    await (process.argv[2] === 'serve' ? serveAdmin(config) : applyUpdate(config));
  } catch { console.error('OpenCode web administration failed; check private configuration and service state.'); process.exitCode = 1; }
}
