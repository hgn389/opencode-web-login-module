import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createAdminController } from '../admin-service.mjs';
import { createLoginServer } from '../index.mjs';
import { SecurityStore } from '../security.mjs';

const password = 'isolated-audit-fixture-password';
const release = { version: '1.0.1', url: 'https://github.com/hgn389/opencode-web-login-module/releases/tag/v1.0.1' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function controllerFixture(dependencies = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'login-audit-admin-'));
  const installDirectory = join(dir, 'code');
  mkdirSync(installDirectory);
  writeFileSync(join(installDirectory, 'package.json'), JSON.stringify({ version: '1.0.0' }));
  const stateDir = join(dir, 'state');
  return { dir, stateDir, create: () => createAdminController({ installDirectory }, { stateDir, password: () => password, ...dependencies }),
    close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('disabling automatic updates cancels a check already in progress', async () => {
  const pending = deferred();
  let launches = 0;
  const fixture = controllerFixture({ release: () => pending.promise, launch: () => { launches++; } });
  try {
    const controller = fixture.create();
    await controller.call({ operation: 'preferences', password, automatic: true, channel: 'stable' });
    const checking = controller.automatic();
    await controller.call({ operation: 'preferences', password, automatic: false, channel: 'stable' });
    pending.resolve(release);
    await checking;
    assert.equal(launches, 0, 'A completed check must not override the saved disable setting');
  } finally { fixture.close(); }
});

test('manual updates revalidate the password after an asynchronous release check', async () => {
  const pending = deferred();
  let actualPassword = password, launches = 0;
  const newPassword = 'isolated-audit-replacement-password';
  const fixture = controllerFixture({ password: () => actualPassword, release: () => pending.promise,
    rotate: async value => { actualPassword = value; }, launch: () => { launches++; } });
  try {
    const controller = fixture.create();
    const updating = controller.call({ operation: 'update', password });
    assert.equal((await controller.call({ operation: 'password', password, newPassword, confirmPassword: newPassword })).status, 202);
    await sleep(650);
    assert.equal(actualPassword, newPassword);
    pending.resolve(release);
    assert.equal((await updating).status, 401);
    assert.equal(launches, 0, 'Credentials invalidated during a check cannot start a privileged update');
  } finally { fixture.close(); }
});

test('changing update preferences invalidates pending release metadata even on the same channel', async () => {
  const pending = deferred();
  const fixture = controllerFixture({ release: () => pending.promise });
  try {
    const controller = fixture.create();
    const checking = controller.call({ operation: 'check' });
    await controller.call({ operation: 'preferences', password, automatic: false, channel: 'stable' });
    pending.resolve(release);
    assert.equal((await checking).release, null);
  } finally { fixture.close(); }
});

test('administrative state rejects shared directories and symlinked state files', () => {
  const fixture = controllerFixture();
  try {
    mkdirSync(fixture.stateDir, { mode: 0o755 });
    assert.throws(fixture.create, /[Pp]rivate|[Uu]nsafe/);
    chmodSync(fixture.stateDir, 0o700);
    const outside = join(fixture.dir, 'outside.json');
    writeFileSync(outside, JSON.stringify({ automatic: true, channel: 'stable' }), { mode: 0o600 });
    symlinkSync(outside, join(fixture.stateDir, 'preferences.json'));
    assert.throws(fixture.create, /[Pp]rivate|[Uu]nsafe/);
    rmSync(join(fixture.stateDir, 'preferences.json'));
    writeFileSync(join(fixture.stateDir, 'job.json'), '{}', { mode: 0o644 });
    assert.throws(fixture.create, /[Pp]rivate|[Uu]nsafe/);
  } finally { fixture.close(); }
});

async function freePort() {
  const socket = http.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
function request(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/login', headers: { host } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

test('wildcard binding accepts local IP addresses while rejecting unconfigured domains', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-audit-wildcard-'));
  const port = await freePort();
  const gateway = createLoginServer({ host: '0.0.0.0', port, statePath: join(dir, 'state.sqlite') });
  try {
    await gateway.listen();
    const address = `http://127.0.0.1:${port}/login`;
    const response = await fetch(address);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(await request(port, 'unconfigured.example'), 400);
  } finally { await gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('blocked IPs receive JSON for APIs and remain subject to request limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-audit-blocked-'));
  const path = join(dir, 'state.sqlite');
  const store = new SecurityStore(path);
  store.db.prepare('INSERT INTO login_ips(ip, failures, blocked, updated) VALUES (?, 10, 1, ?)').run('127.0.0.1', Date.now());
  store.close();
  const port = await freePort();
  const gateway = createLoginServer({ host: '127.0.0.1', port, statePath: path });
  try {
    await gateway.listen();
    const address = `http://127.0.0.1:${port}`;
    const denied = await fetch(address + '/web-login/api/status', { headers: { 'x-opencode-login': '1' } });
    assert.equal(denied.status, 403);
    assert.match(denied.headers.get('content-type'), /application\/json/);
    assert.match((await denied.json()).message, /IP/);
    for (let i = 0; i < 40; i++) {
      const response = await fetch(address + '/login');
      await response.text();
    }
    const limited = await fetch(address + '/login');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    await limited.text();
  } finally { await gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('global session revocation cancels login verification already in progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-audit-revocation-'));
  const path = join(dir, 'state.sqlite');
  const verified = deferred(), resume = deferred();
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/api/info') { verified.resolve(); await resume.promise; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/pair' ? { code: 'fixture' } : req.url === '/auth/connect/fixture' ? { token: 'native_fixture_token' } : {}));
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const gateway = createLoginServer({ port, backendPort: backend.address().port, statePath: path });
  const store = new SecurityStore(path);
  try {
    await gateway.listen();
    const form = await fetch(origin + '/login');
    const html = await form.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const cookie = form.headers.getSetCookie()[0].split(';')[0];
    const pending = fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'opencode', password, csrf }).toString() });
    await verified.promise;
    store.revokeAll();
    resume.resolve();
    const response = await pending;
    assert.equal(response.status, 409, 'A revoked authentication attempt must not create a replacement session');
    await response.text();
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    assert.equal(store.state('127.0.0.1').failures, 0);
  } finally {
    resume.resolve(); store.close(); await gateway.close(); backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve)); rmSync(dir, { recursive: true, force: true });
  }
});

test('login waits for password rotation to complete without checking credentials or counting failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-audit-password-job-'));
  const socket = join(dir, 'admin.sock');
  let passwordChecks = 0;
  const helper = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 200, job: { type: 'password', phase: 'running' } })); });
  const backend = http.createServer((req, res) => { passwordChecks++; res.writeHead(401); res.end(); });
  helper.listen(socket); backend.listen(0, '127.0.0.1');
  await Promise.all([once(helper, 'listening'), once(backend, 'listening')]);
  const port = await freePort(), origin = `http://127.0.0.1:${port}`;
  const gateway = createLoginServer({ port, backendPort: backend.address().port, statePath: join(dir, 'state.sqlite'), adminSocket: socket });
  try {
    await gateway.listen();
    const form = await fetch(origin + '/login');
    const html = await form.text();
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1];
    const cookie = form.headers.getSetCookie()[0].split(';')[0];
    const response = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: 'opencode', password, csrf }).toString() });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /đổi mật khẩu/);
    assert.equal(passwordChecks, 0);
  } finally {
    await gateway.close(); helper.closeAllConnections(); backend.closeAllConnections();
    await Promise.all([new Promise(resolve => helper.close(resolve)), new Promise(resolve => backend.close(resolve))]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI revocation invalidates pending authentication and persists across storage restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-audit-cli-'));
  const path = join(dir, 'state.sqlite'), origin = 'https://login.example';
  let store = new SecurityStore(path);
  try {
    const revision = store.sessionRevision();
    const previous = store.createSession('fixture_native_token', origin);
    execFileSync(process.execPath, ['--no-warnings', new URL('../manage.mjs', import.meta.url).pathname, 'revoke-sessions'],
      { env: { ...process.env, LOGIN_STATE_DB: path }, stdio: 'pipe', timeout: 5000 });
    assert.equal(store.session(previous, origin), undefined);
    assert.equal(store.createSession('fixture_native_token', origin, revision), undefined);
    store.close(); store = new SecurityStore(path);
    assert.equal(store.createSession('fixture_native_token', origin, revision), undefined);
    assert.equal(typeof store.createSession('fixture_native_token', origin), 'string');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
