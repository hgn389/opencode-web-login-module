import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createLoginServer, normalizeConfig } from '../index.mjs';
import { readResponse, protectedBackend } from '../http-client.mjs';
import { SecurityStore } from '../security.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function request(port, path, { method = 'GET', headers = {}, chunks = [] } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.once('error', reject);
    });
    req.once('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('IPv6 configuration is canonical and malformed ports are rejected', () => {
  assert.equal(normalizeConfig({ host: '0:0:0:0:0:0:0:1' }).localOrigin, 'http://[::1]:4096');
  for (const port of [true, false, ' 4096', '4.096e3', '0x1000']) assert.throws(() => normalizeConfig({ port }));
});

test('concurrent listen and immediate close cannot leave a listening socket', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-race-'));
  let login;
  try {
    const port = await freePort();
    login = createLoginServer({ port, statePath: join(dir, 'state.sqlite') });
    const [a, b] = await Promise.all([login.listen(), login.listen()]);
    assert.deepEqual(a, b);
    await login.close();
    login = createLoginServer({ port, statePath: join(dir, 'state.sqlite') });
    const pending = login.listen();
    const results = await Promise.allSettled([pending, login.close()]);
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(login.server.listening, false);
    const probe = net.createServer();
    probe.listen(port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise((resolve) => probe.close(resolve));
  } finally { await login?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backend exchanges reject truncation, slow drip, oversize and cancellation', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/truncated') {
      res.writeHead(401, { 'content-type': 'application/json', 'content-length': '100' });
      res.write('{}');
      setTimeout(() => res.destroy(), 10);
    } else if (req.url === '/drip') {
      res.writeHead(200);
      res.write('a');
      const interval = setInterval(() => res.write('a'), 15);
      res.once('close', () => clearInterval(interval));
    } else if (req.url === '/large') res.end('a'.repeat(200));
    else { res.writeHead(req.url === '/api/info' ? 401 : 200, { 'content-type': 'application/json' }); res.end('{}'); }
  });
  const port = await listen(server);
  const options = { hostname: '127.0.0.1', port };
  try {
    await assert.rejects(readResponse({ ...options, path: '/truncated' }), /interrupted|aborted|reset/i);
    const start = Date.now();
    await assert.rejects(readResponse({ ...options, path: '/drip' }, { timeout: 120 }), /timeout/);
    assert(Date.now() - start < 1000, 'Continuous response bytes must not extend the absolute deadline');
    await assert.rejects(readResponse({ ...options, path: '/large' }, { limit: 100 }), /too large|interrupted/);
    const controller = new AbortController();
    const pending = readResponse({ ...options, path: '/drip' }, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /aborted/i);
    assert.equal(await protectedBackend({ backendHost: '127.0.0.1', backendPort: port }), true);
    const unprotected = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    const unprotectedPort = await listen(unprotected);
    try { assert.equal(await protectedBackend({ backendHost: '127.0.0.1', backendPort: unprotectedPort }), false); }
    finally { await new Promise((resolve) => unprotected.close(resolve)); }
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test('chunked large forms return HTTP 413; proxy strips connection headers in both directions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-proxy-'));
  let calls = 0;
  const backend = http.createServer((req, res) => {
    calls++;
    res.writeHead(200, { 'content-type': 'application/json', connection: 'x-back-hop', 'x-back-hop': 'hidden', 'www-authenticate': 'Basic realm="native"', 'set-cookie': 'native=bad' });
    res.end(JSON.stringify(req.headers));
  });
  const backendPort = await listen(backend);
  const port = await freePort();
  const login = createLoginServer({ port, backendPort, statePath: join(dir, 'state.sqlite') });
  await login.listen();
  try {
    const tooLarge = await request(port, '/login', { method: 'POST', headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' }, chunks: ['username=x&', 'password=' + 'a'.repeat(9000)] });
    assert.equal(tooLarge.status, 413);
    assert(tooLarge.body.includes('Dữ liệu đăng nhập quá lớn'));
    const response = await request(port, '/_assets/test', { headers: { connection: 'x-hop, authorization, host', 'x-hop': 'hidden', authorization: 'Basic attacker', cookie: 'native=attacker', 'x-forwarded-for': '198.51.100.1' } });
    const incoming = JSON.parse(response.body);
    assert.equal(incoming['x-hop'], undefined);
    assert.equal(incoming.authorization, undefined);
    assert.equal(incoming.cookie, undefined);
    assert.equal(incoming['x-forwarded-for'], undefined);
    assert.equal(incoming.host, `127.0.0.1:${port}`);
    assert.equal(response.headers['x-back-hop'], undefined);
    assert.equal(response.headers['www-authenticate'], undefined);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    const before = calls;
    assert.equal((await request(port, '/_assets/test', { method: 'POST' })).status, 405);
    assert.equal(calls, before);
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(`GET /api/pty/test/connect HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    const [reply] = await once(socket, 'data');
    assert(reply.toString().startsWith('HTTP/1.1 403'));
    socket.destroy();
    assert.equal((await request(port, '/login')).status, 200);
  } finally {
    await login.close(); backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('closing during password verification cancels the backend exchange', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-cancel-'));
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const backend = http.createServer(() => started());
  const backendPort = await listen(backend);
  const port = await freePort();
  const login = createLoginServer({ port, backendPort, statePath: join(dir, 'state.sqlite') });
  await login.listen();
  try {
    const form = await request(port, '/login');
    const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)[1];
    const pending = request(port, '/login', { method: 'POST', headers: { cookie: form.headers['set-cookie'][0].split(';')[0], origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' }, chunks: [new URLSearchParams({ csrf, username: 'opencode', password: 'test-password' }).toString()] }).catch(() => undefined);
    await entered;
    const start = Date.now();
    await login.close();
    await pending;
    assert(Date.now() - start < 1500, 'Shutdown must cancel verification rather than wait for its timeout');
  } finally {
    await login.close(); backend.closeAllConnections(); await new Promise((resolve) => backend.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('security storage rejects shared directories and dangling symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-permissions-'));
  try {
    const shared = join(dir, 'shared');
    mkdirSync(shared, { mode: 0o755 });
    assert.throws(() => new SecurityStore(join(shared, 'state.sqlite')), /0700/);
    symlinkSync(join(dir, 'missing.sqlite'), join(dir, 'state.sqlite'));
    assert.throws(() => new SecurityStore(join(dir, 'state.sqlite')), /regular files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('installer rejects unsafe systemd paths and administrative CLI rejects surplus arguments', () => {
  const bin = new URL('../bin/opencode-web-login.mjs', import.meta.url).pathname;
  for (const directory of ['/opt/test\\broken', '/opt/test"broken', '/opt/test ']) {
    const result = spawnSync(process.execPath, [bin, 'install', '--opencode-bin', '/usr/bin/opencode', '--install-dir', directory, '--dry-run'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /absolute path/);
  }
  for (const args of [['blocked', 'unexpected'], ['unblock', '127.0.0.1', 'unexpected'], ['unblock']]) {
    const result = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid command arguments/);
  }
});
