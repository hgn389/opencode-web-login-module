import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createAdminController, rotatePassword, applyUpdate, validPassword } from '../admin-service.mjs';
import { moduleFiles, extractPackage, compareVersions, selectRelease, download } from '../update.mjs';
import { SecurityStore } from '../security.mjs';
import { createLoginServer } from '../index.mjs';

const currentPassword = 'private-fixture-current-password';
const nextPassword = 'private-fixture-new-password';
const root = new URL('../', import.meta.url).pathname;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function archiveFixture({ extras = [], missing, version = '1.0.1', badLock = false } = {}) {
  const buffers = [];
  const entries = moduleFiles.filter(file => file !== missing).map(file => {
    let content = readFileSync(join(root, file));
    if (['package.json', 'npm-shrinkwrap.json'].includes(file)) {
      const value = JSON.parse(content); value.version = version;
      if (badLock && file === 'npm-shrinkwrap.json') value.packages['node_modules/evil'] = { resolved: 'file:/root/secret', integrity: 'sha512-fixture' };
      content = Buffer.from(JSON.stringify(value));
    }
    return { name: 'package/' + file, content, type: 48 };
  });
  for (const entry of [...entries, ...extras]) {
    const header = Buffer.alloc(512);
    header.write(entry.name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(entry.content.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header[156] = entry.type; header.write('ustar\0', 257);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    buffers.push(header, entry.content, Buffer.alloc((512 - entry.content.length % 512) % 512));
  }
  buffers.push(Buffer.alloc(1024));
  const archive = gzipSync(Buffer.concat(buffers));
  return { archive, expected: { version, size: archive.length, digest: createHash('sha256').update(archive).digest('hex') } };
}

test('update channels reject drafts, downgrade, equal versions and malformed versions', () => {
  assert.equal(compareVersions('1.0.0-beta', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('v1.0.1', '1.0.0-beta'), 1);
  assert.throws(() => compareVersions('1.0.0;reboot', '1.0.0'));
  const releases = [
    { tag_name: 'v1.0.0-beta', prerelease: true }, { tag_name: 'v1.0.1' },
    { tag_name: 'v1.1.0-beta', prerelease: true }, { tag_name: 'v2.0.0', draft: true },
    { tag_name: 'v1.2.0-beta', prerelease: false }, { tag_name: 'v100.0.0;reboot' },
  ];
  assert.equal(selectRelease(releases, '1.0.0-beta', 'stable').tag_name, 'v1.0.1');
  assert.equal(selectRelease(releases, '1.0.0-beta', 'beta').tag_name, 'v1.2.0-beta');
  assert.equal(selectRelease(releases, '2.0.0', 'beta'), undefined);
});

test('update extraction verifies digest, full manifest, identity and rejects traversal, links and unsafe dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-archive-test-'));
  try {
    const good = archiveFixture();
    extractPackage(good.archive, join(dir, 'good'), good.expected);
    assert.equal(JSON.parse(readFileSync(join(dir, 'good/package.json'))).version, '1.0.1');
    const cases = [
      { extras: [{ name: 'package/../../outside', content: Buffer.from('bad'), type: 48 }] },
      { extras: [{ name: 'package/.env', content: Buffer.from('bad'), type: 48 }] },
      { extras: [{ name: 'package/index.mjs', content: Buffer.from('bad'), type: 50 }] },
      { extras: [{ name: 'package/index.mjs', content: Buffer.from('bad'), type: 48 }] },
      { missing: 'admin-service.mjs' }, { badLock: true },
    ];
    for (let i = 0; i < cases.length; i++) {
      const fixture = archiveFixture(cases[i]);
      assert.throws(() => extractPackage(fixture.archive, join(dir, String(i)), fixture.expected));
      assert.equal(existsSync(join(dir, String(i))), false, 'Validate the entire archive before writing any entry');
    }
    assert.throws(() => extractPackage(good.archive, join(dir, 'bad-digest'), { ...good.expected, digest: '0'.repeat(64) }));
    assert.throws(() => extractPackage(good.archive, join(dir, 'bad-version'), { ...good.expected, version: '1.0.2' }));
    await assert.rejects(download('http://github.com/a'));
    await assert.rejects(download('https://attacker.example/a', 100, { asset: true }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('administration requires actual password, keeps automatic updates off, persists settings and serializes changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-admin-controller-'));
  const installDirectory = join(dir, 'code'); mkdirSync(installDirectory);
  writeFileSync(join(installDirectory, 'package.json'), JSON.stringify({ version: '1.0.0-beta' }));
  let rotations = 0, launches = 0, checks = 0;
  let channel;
  const config = { installDirectory };
  const deps = { stateDir: join(dir, 'state'), password: () => currentPassword,
    rotate: async () => { rotations++; }, launch: () => { launches++; },
    release: async (version, selected) => { checks++; channel = selected; return { version: '1.0.1', url: 'https://github.com/hgn389/opencode-web-login-module/releases/tag/v1.0.1' }; },
  };
  try {
    const controller = createAdminController(config, deps);
    assert.equal((await controller.call({ operation: 'status' })).preferences.automatic, false);
    await controller.automatic(); assert.equal(checks, 0);
    assert.equal((await controller.call({ operation: 'preferences', password: 'native_session_token', automatic: true, channel: 'beta' })).status, 401);
    assert.equal((await controller.call({ operation: 'preferences', password: currentPassword, automatic: true, channel: 'attacker' })).status, 422);
    assert.equal((await controller.call({ operation: 'preferences', password: currentPassword, automatic: false, channel: 'beta' })).status, 200);
    assert.equal((await createAdminController(config, deps).call({ operation: 'status' })).preferences.channel, 'beta');
    await controller.call({ operation: 'check' }); assert.equal(channel, 'beta'); assert.equal(launches, 0);
    assert.equal((await controller.call({ operation: 'password', password: currentPassword, newPassword: 'short', confirmPassword: 'short' })).status, 422);
    assert.equal((await controller.call({ operation: 'password', password: currentPassword, newPassword: nextPassword, confirmPassword: nextPassword })).status, 202);
    assert.equal((await controller.call({ operation: 'update', password: currentPassword })).status, 409);
    await sleep(600); assert.equal(rotations, 1);
    assert.equal((await controller.call({ operation: 'status' })).job.phase, 'succeeded');
    await controller.call({ operation: 'preferences', password: currentPassword, automatic: true, channel: 'stable' });
    await controller.automatic(); assert.equal(launches, 1); assert.equal(channel, 'stable');
    await controller.automatic(); assert.equal(launches, 1);
    for (let i = 0; i < 15; i++) await controller.call({ operation: 'password', password: 'incorrect' });
    assert.equal((await controller.call({ operation: 'password', password: 'incorrect' })).status, 429);
    assert.equal(validPassword('short'), false); assert.equal(validPassword(nextPassword + '\n'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('password rotation restores previous files and services when restart fails', { skip: process.getuid?.() !== 0 }, async () => {
  const name = `oc-password-test-${process.pid}`;
  const passwordFile = `/etc/${name}-backend-password.env`;
  const backendService = `${name}-backend.service`;
  const dropin = `/etc/systemd/system/${backendService}.d/90-web-login-password.conf`;
  const backup = `/var/lib/${name}-install-backup`;
  for (const path of [passwordFile, dirname(dropin), backup]) assert.equal(existsSync(path), false);
  mkdirSync(dirname(dropin));
  const calls = [];
  try {
    const config = { name, backendService, gateway: {} };
    await assert.rejects(rotatePassword(config, nextPassword, { run(binary, args) {
      calls.push(args);
      if (args[0] === 'restart' && args[1] === backendService && calls.filter(x => x[0] === 'restart').length === 1) throw new Error('Injected failure');
    } }), /previous configuration restored/);
    assert.equal(existsSync(passwordFile), false); assert.equal(existsSync(dropin), false);
    assert.equal(calls.filter(x => x[0] === 'restart' && x[1] === backendService).length, 2);
    assert(calls.some(x => x[0] === 'restart' && x[1] === `${name}.service`));
    assert(existsSync(join(backup, '.git')));
    let revoked = false;
    await rotatePassword(config, nextPassword, { run: () => {}, revoke: () => { revoked = true; }, probe: async () => ({ status: 200, headers: { 'content-type': 'application/json' } }) });
    assert(revoked, 'Session invalidation must also happen in the privileged rotation task');
    assert(readFileSync(passwordFile, 'utf8').includes('OPENCODE_SERVER_PASSWORD='));
  } finally {
    rmSync(passwordFile, { force: true }); rmSync(dirname(dropin), { recursive: true, force: true }); rmSync(backup, { recursive: true, force: true });
  }
});

test('update worker verifies package before installer, preserves fixed options and records failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-update-worker-'));
  const code = join(dir, 'code'); mkdirSync(code);
  const stateDir = join(dir, 'state'); mkdirSync(stateDir, { mode: 0o700 });
  writeFileSync(join(code, 'package.json'), JSON.stringify({ version: '1.0.0-beta' }));
  const fixture = archiveFixture();
  const release = { ...fixture.expected, version: '1.0.1', assetURL: 'https://github.com/fixture' };
  const jobPath = join(stateDir, 'job.json');
  const prepare = () => writeFileSync(jobPath, JSON.stringify({ type: 'update', phase: 'starting', started: Date.now(), version: release.version, release }), { mode: 0o600 });
  const config = { name: 'oc-fixture', installDirectory: code, node: process.execPath, backendService: 'oc-backend.service', opencode: '/usr/bin/true', gateway: { host: '127.0.0.1', port: 4096, backendPort: 4097, publicOrigins: [], trustedProxies: ['127.0.0.1'] } };
  let executions = 0;
  try {
    prepare();
    await applyUpdate(config, { stateDir, release: async () => release, download: async () => fixture.archive, execute(binary, args, options) {
      executions++;
      assert.equal(args[1], 'install'); assert(args.includes('oc-backend.service')); assert(args.includes('/usr/bin/true'));
      assert.equal(options.env.npm_config_ignore_scripts, 'true');
    } });
    assert.equal(executions, 1); assert.equal(JSON.parse(readFileSync(jobPath)).phase, 'succeeded');
    prepare();
    await applyUpdate(config, { stateDir, release: async () => release, download: async () => Buffer.from('corrupt'), execute: () => { executions++; } });
    assert.equal(executions, 1); assert.equal(JSON.parse(readFileSync(jobPath)).phase, 'failed');
    process.exitCode = 0;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('web admin protects session, origin and CSRF; password rotation revokes all sessions; native menu hook is served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-web-admin-'));
  const socket = join(dir, 'admin.sock');
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const database = join(dir, 'state.sqlite');
  let calls = 0;
  const helper = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks)); calls++;
    const status = data.operation === 'password' ? data.password === currentPassword ? 202 : 401 : 200;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status, available: true, version: '1.0.0-beta', preferences: { automatic: false, channel: 'stable' }, message: 'Fixture' }));
  });
  const backend = http.createServer((req, res) => { const body = '<html><head></head><body>Fixture</body></html>'; res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) }); res.end(body); });
  helper.listen(socket); backend.listen(0, '127.0.0.1'); await Promise.all([once(helper, 'listening'), once(backend, 'listening')]);
  const login = createLoginServer({ port, backendPort: backend.address().port, statePath: database, adminSocket: socket });
  await login.listen();
  const store = new SecurityStore(database);
  const first = store.createSession('native_fixture_token', origin), second = store.createSession('another_native_token', origin);
  const cookie = `opencode_login_${port}=${first}`;
  const request = (path, options = {}) => fetch(origin + path, { redirect: 'manual', ...options, headers: { cookie, 'x-opencode-login': '1', ...options.headers } });
  try {
    assert.equal((await fetch(origin + '/web-login/api/status')).status, 401);
    assert.equal((await fetch(origin + '/web-login/admin-ui.js')).status, 401);
    assert.equal((await request('/web-login/api/status', { headers: { origin: 'https://attacker.example' } })).status, 403);
    assert.equal(calls, 0);
    const status = await (await request('/web-login/api/status')).json();
    assert(status.csrf);
    const options = { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-web-login-csrf': status.csrf }, body: JSON.stringify({ password: currentPassword, newPassword: nextPassword, confirmPassword: nextPassword }) };
    assert.equal((await request('/web-login/api/password', { ...options, headers: { ...options.headers, 'x-web-login-csrf': 'forged' } })).status, 403);
    assert.equal((await request('/web-login/api/password', { ...options, headers: { ...options.headers, cookie: `opencode_login_${port}=${second}` } })).status, 403);
    assert.equal(calls, 1);
    const html = await (await request('/', { headers: { accept: 'text/html' } })).text();
    assert(html.includes('/web-login/settings-hook.js')); assert(html.includes('/web-login/settings-hook.css'));
    const panel = await request('/web-login/password');
    assert.equal(panel.headers.get('x-frame-options'), 'SAMEORIGIN');
    const panelBody = await panel.text();
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert(panelBody.includes(`OpenCode Web Login · v${version}`));
    assert(!panelBody.includes('{{VERSION}}'));
    assert.equal((await request('/web-login/admin-ui.js')).status, 200);
    const wrong = await request('/web-login/api/password', { ...options, body: JSON.stringify({ password: 'native_fixture_token', newPassword: nextPassword, confirmPassword: nextPassword }) });
    assert.equal(wrong.status, 401); assert.equal(store.state('127.0.0.1').failures, 1);
    assert.equal((await request('/web-login/api/password', options)).status, 202);
    assert.equal(store.state('127.0.0.1').failures, 0, 'Successful password confirmation resets consecutive credential failures');
    assert.equal(store.session(first, origin), undefined); assert.equal(store.session(second, origin), undefined);
    assert.equal((await request('/web-login/api/status')).status, 401);
    const third = store.createSession('third_native_fixture', origin);
    for (let i = 0; i < 5; i++) store.fail('127.0.0.1');
    const thirdStatus = await (await request('/web-login/api/status', { headers: { cookie: `opencode_login_${port}=${third}` } })).json();
    const before = calls;
    const gated = await request('/web-login/api/password', { ...options, headers: { ...options.headers, cookie: `opencode_login_${port}=${third}`, 'x-web-login-csrf': thirdStatus.csrf } });
    assert.equal(gated.status, 401); assert.equal((await gated.json()).loginRequired, true);
    assert.equal(calls, before, 'A second session cannot bypass the CAPTCHA requirement after five failures');
  } finally {
    store.close(); await login.close(); helper.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise(resolve => helper.close(resolve)), new Promise(resolve => backend.close(resolve))]);
    rmSync(dir, { recursive: true, force: true });
  }
});
