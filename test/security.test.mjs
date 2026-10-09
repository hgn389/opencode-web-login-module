import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SecurityStore } from '../security.mjs';

const root = new URL('../', import.meta.url).pathname;
const template = readFileSync(join(root, 'login.html'), 'utf8');
const goodPassword = 'test-password-not-a-real-credential';
const nativeToken = 'test_native_session_token';
const auth = (password) => 'Basic ' + Buffer.from('opencode:' + password).toString('base64');

function request(port, path, { method = 'GET', data, cookie, ip = '198.51.100.10', localAddress, extra = {}, secure = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      host: secure ? 'login.security.test' : `127.0.0.1:${port}`,
      'x-forwarded-for': ip,
      ...(secure ? { 'x-forwarded-proto': 'https' } : {}),
      ...(cookie ? { cookie } : {}), ...extra,
    };
    if (data !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      headers['content-length'] = Buffer.byteLength(data);
      headers.origin ??= secure ? 'https://login.security.test' : `http://127.0.0.1:${port}`;
    }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers, localAddress }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks), body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function fields(response) {
  return {
    csrf: /name="csrf" value="([^"]+)"/.exec(response.body)?.[1],
    cookie: response.headers['set-cookie']?.[0].split(';')[0],
  };
}

async function freePort() {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function start(port, backendPort, dbPath) {
  // A deterministic answer is confined to this test process; production has no test bypass.
  const script = `import {SecurityStore} from ${JSON.stringify(new URL('../security.mjs', import.meta.url).href)};
    const original = SecurityStore.prototype.challenge;
    SecurityStore.prototype.challenge = function(csrf, ip) {
      original.call(this, csrf, ip);
      this.challenges.get(csrf).digest = this.answerHash(csrf, ip, 'ABC234');
    };
    await import(${JSON.stringify(new URL('../server.mjs', import.meta.url).href)});`;
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, LOGIN_HOST: '127.0.0.1', LOGIN_PORT: String(port), OPENCODE_BACKEND_PORT: String(backendPort), LOGIN_STATE_DB: dbPath, LOGIN_PUBLIC_ORIGINS: 'https://login.security.test', LOGIN_TRUSTED_PROXIES: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start: ' + output)), 10000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Test server exited: ' + output)); });
  });
  return child;
}
async function stop(child) {
  const done = once(child, 'exit');
  child.kill('SIGTERM');
  await done;
}

 test('lockouts, challenge requirements, sessions and proxy boundaries', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-security-test-'));
  const dbPath = join(dir, 'security.sqlite');
  const port = await freePort();
  let nativeAuthorized = true;
  let calls = 0;
  let verificationGate, enteredVerification, releaseVerification;
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/api/info') {
      calls += 1;
      if (verificationGate) { enteredVerification(); await verificationGate; }
      else await new Promise((resolve) => setTimeout(resolve, 30));
      const accepted = req.headers.authorization === auth(goodPassword) || (nativeAuthorized && req.headers.authorization === auth(nativeToken));
      res.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(accepted ? { pid: 123, version: 'test' } : { message: 'Authentication required' }));
    } else if (req.url === '/api/pair') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'test-code' }));
    } else if (req.url === '/auth/connect/test-code') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ token: nativeToken }));
    } else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>OpenCode</html>'); }
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = backend.address().port;
  let child = await start(port, backendPort, dbPath);
  const db = new DatabaseSync(dbPath);
  const row = (ip) => db.prepare('SELECT * FROM login_ips WHERE ip = ?').get(ip);
  async function submit(password, options = {}) {
    const form = await request(port, '/login', options);
    const { csrf, cookie } = fields(form);
    const data = new URLSearchParams({ username: 'opencode', password, csrf, next: options.next || '/', captcha: options.captcha || '' }).toString();
    return request(port, '/login', { ...options, method: 'POST', data, cookie });
  }
  try {
    for (let i = 1; i <= 5; i++) {
      const result = await submit('wrong-password');
      assert.equal(result.status, 401);
      assert.equal(row('198.51.100.10').failures, i);
      assert.equal(result.body.includes('name="captcha"'), i >= 5);
    }
    const form = await request(port, '/login');
    const captcha = await request(port, '/login/captcha', { cookie: fields(form).cookie });
    assert.equal(captcha.headers['content-type'], 'image/png');
    assert.equal(captcha.raw.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const before = calls;
    assert.equal((await submit(goodPassword)).status, 422);
    assert.equal((await submit(goodPassword, { captcha: 'WRONG1' })).status, 422);
    assert.equal(calls, before, 'Invalid or missing challenges must not reach password verification');
    assert.equal(row('198.51.100.10').failures, 5);
    for (let i = 6; i <= 10; i++) {
      const result = await submit('wrong-password', { captcha: 'ABC234' });
      assert.equal(result.status, i < 10 ? 401 : 403);
      assert.equal(row('198.51.100.10').failures, i);
    }
    assert.equal(row('198.51.100.10').blocked, 1);
    const callsWhenBlocked = calls;
    assert.equal((await submit(goodPassword, { captcha: 'ABC234' })).status, 403);
    assert.equal((await request(port, '/api/info', { extra: { authorization: auth(goodPassword) } })).status, 403);
    assert.equal(calls, callsWhenBlocked);
    console.log('Verified CAPTCHA after 5 credential failures, permanent block at 10, and no password checks after blocking');

    const user = { ip: '198.51.100.20', secure: true };
    const signedIn = await submit(goodPassword, { ...user, next: '//evil.invalid' });
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.location, '/');
    assert(signedIn.headers['set-cookie'][0].startsWith('__Host-opencode_login='));
    assert(signedIn.headers['set-cookie'][0].includes('Secure'));
    assert(signedIn.headers['set-cookie'][0].includes('HttpOnly'));
    assert(signedIn.headers['strict-transport-security']);
    const sessionCookie = signedIn.headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(port, '/api/info', { ...user, cookie: sessionCookie })).status, 200);
    assert.equal((await request(port, '/api/info', { ...user, cookie: sessionCookie, extra: { connection: 'authorization, cookie, host', authorization: 'Basic attacker' } })).status, 200, 'Client connection headers cannot remove or replace gateway authentication');
    assert.equal((await request(port, '/api/info', { ip: '198.51.100.21', extra: { authorization: auth(goodPassword) } })).status, 401);
    assert.equal((await request(port, '/api/info?auth_token=anything', { ip: '198.51.100.21' })).status, 401);
    assert.equal((await request(port, '/auth/connect/test-code', { ip: '198.51.100.21' })).status, 403);
    assert.equal((await request(port, '/api/pair', { ...user, cookie: sessionCookie })).status, 403);
    assert.equal((await request(port, '/api/info', { ip: '198.51.100.20', cookie: sessionCookie })).status, 401, 'Sessions cannot move to another origin');
    console.log('Verified HTTPS cookie flags, session origin binding, and API/pairing bypass rejection');

    await stop(child);
    child = await start(port, backendPort, dbPath);
    assert.equal((await request(port, '/login')).status, 403, 'Blocked IP survives a restart');
    assert.equal((await request(port, '/api/info', { ...user, cookie: sessionCookie })).status, 200, 'Valid sessions survive a restart');
    const oldIP = '198.51.100.30';
    await submit('wrong-password', { ip: oldIP });
    assert.equal((await submit(goodPassword, { ip: oldIP })).status, 303);
    assert.equal(row(oldIP), undefined, 'Successful login resets consecutive failures');
    console.log('Verified persistent lockouts, persistent sessions and reset after a successful login');

    const untrusted = { ip: '198.51.100.99', localAddress: '127.0.0.2' };
    await submit('wrong-password', untrusted);
    assert.equal(row('127.0.0.2').failures, 1);
    assert.equal(row('198.51.100.99'), undefined, 'Untrusted clients cannot spoof X-Forwarded-For');
    const parallel = { ip: '198.51.100.40' };
    const entry = fields(await request(port, '/login', parallel));
    const data = new URLSearchParams({ username: 'opencode', password: 'wrong-password', csrf: entry.csrf }).toString();
    const entered = new Promise(resolve => { enteredVerification = resolve; });
    verificationGate = new Promise(resolve => { releaseVerification = resolve; });
    const first = request(port, '/login', { ...parallel, method: 'POST', data, cookie: entry.cookie });
    await entered;
    const responses = await Promise.all(Array.from({ length: 11 }, () => request(port, '/login', { ...parallel, method: 'POST', data, cookie: entry.cookie })));
    assert(responses.every((r) => r.status === 429));
    releaseVerification(); verificationGate = undefined;
    assert.equal((await first).status, 401);
    assert.equal(row(parallel.ip).failures, 1);
    console.log('Verified trusted proxy boundaries and serialized password verification per IP');

    const csrfTest = fields(await request(port, '/login', { ip: '198.51.100.50' }));
    assert.equal((await request(port, '/login', { ip: '198.51.100.50', method: 'POST', cookie: csrfTest.cookie, data: new URLSearchParams({ csrf: csrfTest.csrf, username: 'opencode', password: goodPassword }).toString(), extra: { origin: 'https://evil.invalid' } })).status, 403);
    assert.equal(row('198.51.100.50'), undefined);
    const loggedOut = await request(port, '/logout', { ...user, cookie: sessionCookie, method: 'POST', data: '' });
    assert.equal(loggedOut.status, 303);
    assert.equal((await request(port, '/api/info', { ...user, cookie: sessionCookie })).status, 401, 'Logout revokes the token server-side');
    const idle = await submit(goodPassword, user);
    const idleCookie = idle.headers['set-cookie'][0].split(';')[0];
    db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 31 * 60 * 1000);
    assert.equal((await request(port, '/api/info', { ...user, cookie: idleCookie })).status, 401);
    const rotated = await submit(goodPassword, user);
    const rotatedCookie = rotated.headers['set-cookie'][0].split(';')[0];
    nativeAuthorized = false;
    assert.equal((await request(port, '/api/info', { ...user, cookie: rotatedCookie })).status, 401);
    const callsAtRevocation = calls;
    assert.equal((await request(port, '/api/info', { ...user, cookie: rotatedCookie })).status, 401);
    assert.equal(calls, callsAtRevocation);
    console.log('Verified CSRF protection, server-side logout, idle expiry and revocation after backend password rotation');
    const plainDomain = await request(port, '/login', { ip: '198.51.100.60', extra: { host: 'login.security.test' } });
    assert.equal(plainDomain.status, 308);
    assert.equal(plainDomain.headers.location, 'https://login.security.test/login');
    assert.equal((await request(port, '/login', { method: 'POST', data: '', ip: '198.51.100.60', extra: { host: 'login.security.test' } })).status, 400);
    let limited;
    for (let i = 0; i < 41; i++) limited = await request(port, '/login', { ip: '198.51.100.70' });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers['retry-after'], '60');
    console.log('Verified HTTP-to-HTTPS redirect, refusal of plaintext domain submissions, and request throttling');
  } finally {
    releaseVerification?.();
    await stop(child);
    db.close();
    await new Promise((resolve) => backend.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CSRF supports multiple tabs, restart, recovery and rejects forged or missing cookies', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-csrf-test-'));
  const dbPath = join(dir, 'security.sqlite');
  const port = await freePort();
  let checks = 0;
  const backend = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/info') { checks++; res.writeHead(req.headers.authorization === auth(goodPassword) ? 200 : 401); res.end('{}'); }
    else if (req.url === '/api/pair') res.end(JSON.stringify({ code: 'code' }));
    else res.end(JSON.stringify({ token: nativeToken }));
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = backend.address().port;
  let child = await start(port, backendPort, dbPath);
  const user = { ip: '198.51.100.210' };
  const body = (csrf) => new URLSearchParams({ csrf, username: 'opencode', password: goodPassword }).toString();
  try {
    const first = fields(await request(port, '/login', user));
    const second = fields(await request(port, '/login', { ...user, cookie: first.cookie }));
    assert.equal(first.csrf, second.csrf, 'Opening another tab must preserve a valid browser token');
    await stop(child);
    child = await start(port, backendPort, dbPath);
    const afterRestart = await request(port, '/login', { ...user, cookie: first.cookie, method: 'POST', data: body(first.csrf) });
    assert.equal(afterRestart.status, 303, 'Forms opened before restart must remain valid until their original expiry');
    const before = checks;
    const missing = await request(port, '/login', { ...user, method: 'POST', data: body(first.csrf) });
    assert.equal(missing.status, 403);
    assert(missing.body.includes('Trình duyệt chưa gửi cookie'));
    assert.equal(checks, before);
    assert.equal((await request(port, '/login/session', user)).status, 403, 'Refresh requires the custom same-origin header');
    assert.equal((await request(port, '/login/session', { ...user, extra: { 'x-opencode-login': '1', origin: 'https://evil.invalid' } })).status, 403);
    const recovered = await request(port, '/login/session', { ...user, cookie: first.cookie, extra: { 'x-opencode-login': '1' } });
    assert.equal(recovered.status, 200);
    const session = JSON.parse(recovered.body);
    assert.equal(session.csrf, first.csrf);
    const renewedCookie = recovered.headers['set-cookie'][0].split(';')[0];
    const duplicate = await request(port, '/login', { ...user, cookie: `${renewedCookie}; opencode_csrf_${port}=stale-root-cookie`, method: 'POST', data: body(session.csrf) });
    assert.equal(duplicate.status, 303, 'A stale less-specific cookie must not replace the valid cookie');
    const missingBrowserCookie = await request(port, '/login/session', { ...user, extra: { 'x-opencode-login': '1' } });
    const fresh = JSON.parse(missingBrowserCookie.body);
    const freshCookie = missingBrowserCookie.headers['set-cookie'][0].split(';')[0];
    assert.notEqual(fresh.csrf, first.csrf);
    assert.equal((await request(port, '/login', { ...user, cookie: freshCookie, method: 'POST', data: body('forged-token') })).status, 403);
    assert.equal((await request(port, '/login', { ...user, cookie: freshCookie, method: 'POST', data: body(fresh.csrf) })).status, 303);
    assert.equal((await request(port, '/login', { ...user, ip: '198.51.100.211', cookie: freshCookie, method: 'POST', data: body(fresh.csrf) })).status, 403, 'Tokens remain bound to the client IP');
    assert.equal((await request(port, '/login', { ...user, secure: true, cookie: freshCookie, method: 'POST', data: body(fresh.csrf) })).status, 403, 'Tokens remain bound to their origin');
  } finally {
    await stop(child);
    await new Promise((resolve) => backend.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('challenge expiry and single use; session absolute expiry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-state-test-'));
  const store = new SecurityStore(join(dir, 'security.sqlite'));
  try {
    store.challenge('csrf', '192.0.2.1');
    store.challenges.get('csrf').digest = store.answerHash('csrf', '192.0.2.1', 'ABC234');
    assert.equal(store.verifyChallenge('csrf', '192.0.2.1', 'ABC234'), true);
    assert.equal(store.verifyChallenge('csrf', '192.0.2.1', 'ABC234'), false);
    store.challenge('expired', '192.0.2.1');
    store.challenges.get('expired').expires = Date.now() - 1;
    assert.equal(store.image('expired', '192.0.2.1'), undefined);
    assert.equal(store.verifyChallenge('expired', '192.0.2.1', 'ABC234'), false);
    const token = store.createSession('native', 'https://example.test');
    store.db.prepare('UPDATE sessions SET expires = ?').run(Date.now() - 1);
    assert.equal(store.session(token, 'https://example.test'), undefined);
    assert(!template.includes('value="{{CAPTCHA_ANSWER}}"'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
