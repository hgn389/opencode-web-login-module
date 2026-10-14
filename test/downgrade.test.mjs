import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { SecurityStore } from '../security.mjs';
import { createLoginServer } from '../index.mjs';
import { createAdminController } from '../admin-service.mjs';
import { protectedBackend, backendInfo } from '../http-client.mjs';
import { openCodeVersions, openCodeRelease, downloadOpenCode, supportedOpenCodeVersion, validateOpenCodePackage } from '../update.mjs';

const password = 'isolated-legacy-test-password';
const archive = Buffer.from('isolated-legacy-registry-archive');
const metadata = version => ({ name: version.startsWith('1.') ? 'opencode-ai' : '@opencode/cli', version, bin: { opencode: './bin/opencode.exe' }, optionalDependencies: { [version.startsWith('1.') ? 'opencode-linux-x64' : '@opencode/cli-linux-x64']: version } });
const release = version => ({ version, assetURL: version.startsWith('1.') ? `https://registry.npmjs.org/opencode-ai/-/opencode-ai-${version}.tgz` : `https://registry.npmjs.org/@opencode/cli/-/cli-${version}.tgz`, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), url: 'https://www.npmjs.com/package/' + (version.startsWith('1.') ? 'opencode-ai' : '@opencode/cli') + '/v/' + version });
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

test('version choices use official stable tags and fixed npm metadata for v1 and v2', async () => {
  const versions = await openCodeVersions({ read: async url => {
    assert.equal(url, 'https://api.github.com/repos/anomalyco/opencode/tags?per_page=100');
    return Buffer.from(JSON.stringify(['v1.18.20', 'v2.0.29', 'v2.0.27', 'v2.0.29', 'v1.18.19', 'v2.0.29-beta', 'v3.0.0', '../../arbitrary'].map(name => ({ name }))));
  } });
  assert.deepEqual(versions, ['2.0.29', '2.0.27', '1.18.20']);
  for (const version of ['1.18.20', '2.0.27']) {
    assert(supportedOpenCodeVersion(version)); assert.equal(validateOpenCodePackage(metadata(version)).version, version);
    const expected = release(version);
    const actual = await openCodeRelease(version, { read: async url => {
      assert.equal(url, `https://registry.npmjs.org/${metadata(version).name.replace('/', '%2f')}/${version}`);
      return Buffer.from(JSON.stringify({ ...metadata(version), dist: { tarball: expected.assetURL, integrity: expected.integrity } }));
    } });
    assert.deepEqual(actual, expected); assert.deepEqual(await downloadOpenCode(actual, { read: async () => archive }), archive);
  }
  for (const version of ['1.18.19', 'v1.18.20', '2.0.27-beta', '3.0.0', '../outside', '2.0.27;id', 'latest', undefined]) await assert.rejects(openCodeRelease(version));
  assert.throws(() => validateOpenCodePackage({ ...metadata('1.18.20'), name: '@opencode/cli' }));
  await assert.rejects(downloadOpenCode(release('1.18.20'), { read: async () => Buffer.from('tampered') }), /integrity/);
});

test('selected installs authenticate, require confirmation, restrict versions, and recheck after asynchronous work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-downgrade-controller-'));
  mkdirSync(join(directory, 'code')); writeFileSync(join(directory, 'code/package.json'), '{"version":"1.1.2-beta"}');
  let currentPassword = password, launches = 0, resume, started;
  const gate = new Promise(resolve => { resume = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  let blocked = false;
  const stateDir = join(directory, 'state');
  const controller = createAdminController({ installDirectory: join(directory, 'code') }, {
    stateDir, password: () => currentPassword, nativeInfo: async () => ({ version: '2.0.29', installedVersion: '2.0.29', supported: true }),
    nativeVersions: async () => ['2.0.29', '2.0.27', '1.18.20'], nativeLaunch: () => { launches++; },
    nativeSelectedRelease: async version => { if (blocked) { started(); await gate; } return release(version); },
  });
  const install = fields => controller.call({ operation: 'opencode-install', password: currentPassword, acknowledge: true, version: '1.18.20', ...fields });
  try {
    assert.equal((await install({ password: 'wrong' })).status, 401);
    assert.equal((await install({ acknowledge: false })).status, 422);
    assert.equal((await install({ version: '2.0.26' })).status, 422);
    assert.equal((await install({ version: 'v1.18.20' })).status, 422);
    assert.equal((await install({ version: '2.0.29' })).status, 409);
    assert.equal(launches, 0);
    blocked = true;
    const pending = install({}); await entered; currentPassword = 'changed-isolated-password'; resume();
    assert.equal((await pending).status, 401); assert.equal(launches, 0);
    blocked = false;
    const results = await Promise.all([install({}), install({})]); assert.deepEqual(results.map(x => x.status).sort(), [202, 409]);
    const job = JSON.parse(readFileSync(join(stateDir, 'job.json')));
    assert.equal(job.version, '1.18.20'); assert.equal(job.explicitTarget, true); assert.equal(job.fromVersion, '2.0.29'); assert.equal(launches, 1);
    assert(!JSON.stringify(job).includes(currentPassword));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('v1 session credentials are encrypted, persistent, bound to origin, and reject unsafe keys', () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-legacy-session-')), path = join(directory, 'security.sqlite');
  let store = new SecurityStore(path);
  try {
    const origin = 'https://login.example', token = store.basicCredential('opencode', password, origin);
    assert(!token.includes(password)); assert(!token.includes(Buffer.from('opencode:' + password).toString('base64')));
    const cookie = store.createSession(token, origin); assert.equal(lstatSync(path + '.key').mode & 0o777, 0o600);
    store.close(); store = new SecurityStore(path);
    const session = store.session(cookie, origin); assert.equal(store.sessionAuthorization(session), 'Basic ' + Buffer.from('opencode:' + password).toString('base64'));
    assert.throws(() => store.sessionAuthorization({ ...session, origin: 'https://other.example' }));
    const altered = Buffer.from(token.slice(6), 'base64url'); altered[28] ^= 1;
    assert.throws(() => store.sessionAuthorization({ ...session, token: 'basic:' + altered.toString('base64url') }));
    const target = join(directory, 'unsafe-key'); writeFileSync(target, Buffer.alloc(32), { mode: 0o600 }); rmSync(path + '.key'); symlinkSync(target, path + '.key');
    assert.throws(() => store.basicCredential('opencode', password, origin));
    assert.deepEqual(readFileSync(target), Buffer.alloc(32));
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('legacy login verifies backend protection, proxies credentials privately, and revokes on password rotation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-legacy-gateway-'));
  const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64'); let requirePassword = true, acceptedPassword = auth;
  const backend = http.createServer((req, res) => {
    if (requirePassword && req.headers.authorization !== acceptedPassword) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Secure Area"' }); res.end('Unauthorized'); return; }
    if (req.url === '/global/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"healthy":true,"version":"1.18.20"}'); }
    else if (req.url === '/api/session') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[],"cursor":null}'); }
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head></head><body>Legacy fixture</body></html>'); }
  });
  const backendPort = await listen(backend), reserve = http.createServer(); const port = await listen(reserve); await new Promise(done => reserve.close(done));
  const config = { port, backendPort, statePath: join(directory, 'security.sqlite') }, origin = `http://127.0.0.1:${port}`;
  const gateway = createLoginServer(config); await gateway.listen();
  const login = async inputPassword => {
    const form = await fetch(origin + '/login'); const html = await form.text();
    return fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: { origin, cookie: form.headers.getSetCookie()[0].split(';')[0], 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf: html.match(/name="csrf" value="([^"]+)"/)[1], username: 'opencode', password: inputPassword }) });
  };
  try {
    assert(await protectedBackend({ backendHost: '127.0.0.1', backendPort }));
    assert.equal((await backendInfo({ backendHost: '127.0.0.1', backendPort }, auth)).major, 1);
    assert.equal((await login('wrong')).status, 401);
    const logged = await login(password); assert.equal(logged.status, 303); assert(!logged.headers.has('www-authenticate'));
    const cookie = logged.headers.getSetCookie()[0].split(';')[0]; assert(!cookie.includes(password));
    const result = await fetch(origin + '/api/session', { headers: { cookie, authorization: 'Basic attacker' } }); assert.equal(result.status, 200);
    const html = await (await fetch(origin + '/', { headers: { cookie, accept: 'text/html' } })).text(); assert(html.includes('/web-login/settings-hook.js')); assert(!html.includes(password));
    acceptedPassword = 'different';
    const revoked = await fetch(origin + '/api/session', { headers: { cookie } }); assert.equal(revoked.status, 401); assert(revoked.headers.getSetCookie().some(x => x.includes('Max-Age=0')));
    acceptedPassword = auth; requirePassword = false;
    assert.equal((await login(password)).status, 503);
  } finally { await gateway.close(); backend.closeAllConnections(); await new Promise(done => backend.close(done)); rmSync(directory, { recursive: true, force: true }); }
});
