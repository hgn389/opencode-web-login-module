import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, chmodSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoginServer } from '../index.mjs';
import { SecurityStore } from '../security.mjs';
import { adminCall } from '../admin-client.mjs';
import { manage } from '../manage.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const key = 'AAAAAAAAAAAAAAAAAAAAAA==';
const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'login-deep-audit-'));
  const backend = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const port = await freePort(), origin = `http://127.0.0.1:${port}`, path = join(dir, 'state.sqlite');
  const gateway = createLoginServer({ port, backendPort: backend.address().port, statePath: path, ...options });
  const store = new SecurityStore(path);
  const cookie = `opencode_login_${port}=${store.createSession('fixture_native_token', origin)}`;
  await gateway.listen();
  return { dir, path, backend, port, origin, gateway, store, cookie, async close() {
    store.close(); await gateway.close(); backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve)); rmSync(dir, { recursive: true, force: true });
  } };
}
async function handshake(f, { cookie = f.cookie, extra = '' } = {}) {
  const socket = net.connect({ host: '127.0.0.1', port: f.port, allowHalfOpen: true });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`GET /api/pty/fixture/connect HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nOrigin: ${f.origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${cookie ? 'Cookie: ' + cookie + '\r\n' : ''}${extra}\r\n`);
  let text = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Handshake fixture timeout')); }, 1000);
    socket.on('data', chunk => { text += chunk; if (text.includes('\r\n\r\n')) { clearTimeout(timer); resolve(); } });
    socket.once('error', () => { clearTimeout(timer); reject(new Error('Handshake fixture interrupted')); });
  });
  return { socket, text };
}

test('native pairing and authentication endpoints cannot be reached through encoded or trailing-slash aliases', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/pair/', '/api/%70air', '/api/pair%2f', '/api//pair', '/auth%2fconnect%2ffixture', '/%61uth/connect/fixture']) {
      const response = await fetch(f.origin + path, { method: 'POST', headers: { origin: f.origin, cookie: f.cookie } });
      assert.equal(response.status, 403, 'Forbidden native authentication alias: ' + path);
      await response.text();
    }
  } finally { await f.close(); }
});

test('rejected WebSocket upgrades close server sockets even when clients keep their side open', async () => {
  const f = await fixture();
  let socket;
  try {
    const response = await handshake(f, { cookie: '' }); socket = response.socket;
    assert.match(response.text, /^HTTP\/1\.1 403/);
    await sleep(30);
    const connections = await new Promise(resolve => f.gateway.server.getConnections((error, count) => resolve(count)));
    assert.equal(connections, 0, 'An unauthenticated client must not retain a denied upgrade connection');
  } finally { socket?.destroy(); await f.close(); }
});

test('WebSocket handshakes strip native cookies and authentication challenges', async () => {
  const f = await fixture();
  let socket, upstream;
  f.backend.on('upgrade', (req, target) => {
    upstream = target;
    target.on('error', () => {});
    assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('opencode:fixture_native_token').toString('base64'));
    assert.equal(req.headers.cookie, undefined);
    target.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: native_token=private_fixture\r\nWWW-Authenticate: Basic realm="fixture"\r\n\r\n`);
  });
  try {
    const response = await handshake(f); socket = response.socket;
    assert.match(response.text, /^HTTP\/1\.1 101/);
    assert.doesNotMatch(response.text, /set-cookie|www-authenticate|private_fixture/i);
  } finally { socket?.destroy(); upstream?.destroy(); await f.close(); }
});

test('invalid WebSocket handshakes and bodies never become a raw HTTP tunnel', async () => {
  const f = await fixture();
  let socket, upstream, calls = 0;
  f.backend.on('upgrade', (req, target) => {
    calls++; upstream = target; target.on('error', () => {});
    target.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: invalid-fixture\r\nSet-Cookie: native_token=private_fixture\r\n\r\n');
  });
  try {
    const invalid = await handshake(f); socket = invalid.socket;
    assert.match(invalid.text, /^HTTP\/1\.1 502/);
    assert.doesNotMatch(invalid.text, /private_fixture/);
    socket.destroy(); upstream?.destroy();
    const body = await handshake(f, { extra: 'Content-Length: 5\r\n' }); socket = body.socket;
    assert.match(body.text, /^HTTP\/1\.1 403/);
    assert.equal(calls, 1, 'Reject request bodies before opening the backend connection');
  } finally { socket?.destroy(); upstream?.destroy(); await f.close(); }
});

test('administration exchanges honor cancellation and reject conflicting response status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-admin-exchange-')), socket = join(dir, 'admin.sock');
  let conflicting = false;
  const server = http.createServer((req, res) => {
    req.resume();
    if (conflicting) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":202}'); }
  });
  server.listen(socket); await once(server, 'listening');
  try {
    const controller = new AbortController();
    const pending = adminCall(socket, 'status', {}, { signal: controller.signal }).then(() => false, error => error.name === 'AbortError');
    controller.abort();
    assert.equal(await Promise.race([pending, sleep(150).then(() => false)]), true);
    conflicting = true;
    await assert.rejects(adminCall(socket, 'status'), /Invalid admin response/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});

test('administrative database commands reject shared parents and linked SQLite sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-command-storage-')), path = join(dir, 'state.sqlite');
  const store = new SecurityStore(path); store.close();
  try {
    chmodSync(dir, 0o755);
    assert.throws(() => manage('blocked', undefined, path), /database directory|private|Unsafe/);
    chmodSync(dir, 0o700);
    const outside = join(dir, 'outside'); writeFileSync(outside, '', { mode: 0o600 });
    symlinkSync(outside, path + '-wal');
    assert.throws(() => manage('blocked', undefined, path), /database files|private|Unsafe/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a CAPTCHA check from another IP cannot consume the original challenge', () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-challenge-owner-'));
  const store = new SecurityStore(join(dir, 'state.sqlite'));
  try {
    store.challenge('fixture_csrf', '198.51.100.1');
    assert.equal(store.verifyChallenge('fixture_csrf', '198.51.100.2', 'ABC234'), false);
    assert(store.image('fixture_csrf', '198.51.100.1'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('private database directories cannot be replaced through a shared non-sticky ancestor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-storage-ancestor-')), privateDir = join(dir, 'private');
  mkdirSync(privateDir, { mode: 0o700 });
  const path = join(privateDir, 'state.sqlite');
  const store = new SecurityStore(path); store.close();
  try {
    chmodSync(dir, 0o777);
    assert.throws(() => manage('blocked', undefined, path), /Unsafe.*ancestor/);
    assert.throws(() => { const reopened = new SecurityStore(path); reopened.close(); }, /Unsafe.*ancestor/);
  } finally { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }); }
});

test('gateway shutdown cancels an administration request instead of waiting for the helper timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-admin-shutdown-')), path = join(dir, 'admin.sock');
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const helper = http.createServer(req => { req.resume(); entered(); });
  helper.listen(path); await once(helper, 'listening');
  const f = await fixture({ adminSocket: path });
  try {
    const pending = fetch(f.origin + '/web-login/api/status', { headers: { cookie: f.cookie, 'x-opencode-login': '1' } }).then(response => response.text(), () => {});
    await ready;
    const started = Date.now();
    await f.gateway.close();
    assert(Date.now() - started < 1000, 'Stop outstanding helper requests promptly');
    await pending;
  } finally { await f.close(); helper.closeAllConnections(); await new Promise(resolve => helper.close(resolve)); rmSync(dir, { recursive: true, force: true }); }
});
