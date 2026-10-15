import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, chmodSync, chownSync, symlinkSync, lstatSync, readlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createLoginServer } from '../index.mjs';
import { SecurityStore } from '../security.mjs';
import { createAdminController, applyOpenCodeUpdate, recoverOpenCodeUpdate, openCodeInstallation, snapshotOpenCode, snapshotOpenCodeData, restoreOpenCode } from '../admin-service.mjs';
import { latestOpenCode, downloadOpenCode, registryRead, validateOpenCodePackage } from '../update.mjs';

const password = 'isolated-native-update-password';
const pkg = version => ({ name: '@opencode/cli', version, bin: { opencode: './bin/opencode.exe', opencode2: './bin/opencode.exe' }, optionalDependencies: Object.fromEntries(['linux-x64', 'linux-x64-baseline', 'linux-x64-musl', 'linux-x64-baseline-musl', 'linux-arm64', 'linux-arm64-musl'].map(platform => ['@opencode/cli-' + platform, version])) });
const archive = Buffer.from('isolated-registry-package');
const release = version => ({ version, assetURL: `https://registry.npmjs.org/@opencode/cli/-/cli-${version}.tgz`, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64'), url: `https://www.npmjs.com/package/@opencode/cli/v/${version}` });
const runProcess = promisify(execFile);
const run = async (file, args, options = {}) => (await runProcess(file, args, { encoding: 'utf8', timeout: 15000, ...options })).stdout.trim();
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('native releases require stable v2, official packages, safe binaries, pinned platform dependencies and SHA-512', async () => {
  assert.equal(validateOpenCodePackage(pkg('2.0.2')).version, '2.0.2');
  for (const metadata of [pkg('3.0.0'), pkg('1.0.0'), pkg('2.0.2-beta'), { ...pkg('2.0.2'), name: 'attacker' }, { ...pkg('2.0.2'), bin: { opencode: '../../outside' } }, { ...pkg('2.0.2'), dependencies: { attacker: '*' } }, { ...pkg('2.0.2'), optionalDependencies: { '@opencode/cli-linux-x64': '*' } }]) assert.throws(() => validateOpenCodePackage(metadata));
  const good = release('2.0.2');
  const metadata = { ...pkg('2.0.2'), dist: { tarball: good.assetURL, integrity: good.integrity } };
  const found = await latestOpenCode({ read: async url => { assert.equal(new URL(url).hostname, 'registry.npmjs.org'); return Buffer.from(JSON.stringify(metadata)); } });
  assert.deepEqual(found, good);
  assert.deepEqual(await downloadOpenCode(good, { read: async () => archive }), archive);
  await assert.rejects(downloadOpenCode(good, { read: async () => Buffer.from('tampered') }), /integrity/);
  await assert.rejects(downloadOpenCode({ ...good, assetURL: 'https://attacker.example/code.tgz' }), /Invalid/);
  await assert.rejects(latestOpenCode({ read: async () => Buffer.from(JSON.stringify({ ...metadata, dist: { ...metadata.dist, tarball: 'https://attacker.example/code.tgz' } })) }), /Invalid/);
  for (const url of ['http://registry.npmjs.org/a', 'https://attacker.example/a', 'https://user:pass@registry.npmjs.org/a', 'https://registry.npmjs.org:444/a']) await assert.rejects(registryRead(url), /Invalid/);
});

function controllerFixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'native-controller-'));
  mkdirSync(join(directory, 'code')); writeFileSync(join(directory, 'code/package.json'), JSON.stringify({ version: '1.1.1-beta' }));
  const stateDir = join(directory, 'state');
  const dependencies = { stateDir, password: () => password, nativeInfo: async () => ({ supported: true, version: '2.0.1', installedVersion: '2.0.1', pendingRestart: false }), nativeRelease: async () => release('2.0.2'), nativeVersions: async () => [], nativeLaunch: () => {}, ...overrides };
  return { directory, stateDir, controller: createAdminController({ installDirectory: join(directory, 'code') }, dependencies), close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('native update uses session authorization and requires acknowledgement, keeps automatic settings separate and serializes jobs', async () => {
  let launches = 0, checks = 0;
  const f = controllerFixture({ nativeLaunch: () => { launches++; }, nativeRelease: async () => { checks++; return release('2.0.2'); } });
  try {
    let status = await f.controller.call({ operation: 'opencode-status' });
    assert.equal(status.opencode.version, '2.0.1'); assert.equal(status.opencode.canUpdate, false);
    status = await f.controller.call({ operation: 'opencode-check' }); assert.equal(status.opencode.canUpdate, true);
    assert.equal((await f.controller.call({ operation: 'opencode-update' })).status, 422);
    assert.equal(launches, 0);
    assert.equal((await f.controller.call({ operation: 'opencode-update', acknowledge: true, version: '999.0.0', command: 'arbitrary' })).status, 202);
    const job = JSON.parse(readFileSync(join(f.stateDir, 'job.json')));
    assert.equal(job.version, '2.0.2'); assert.equal(job.type, 'opencode-update'); assert(!JSON.stringify(job).includes(password));
    assert.equal((await f.controller.call({ operation: 'preferences', password, automatic: true, channel: 'beta' })).status, 409);
    assert.equal((await f.controller.call({ operation: 'opencode-update', acknowledge: true })).status, 409);
    await f.controller.automatic(); assert.equal(launches, 1); assert.equal(checks, 1);
    assert.equal((await f.controller.call({ operation: 'status' })).preferences.automatic, false);
  } finally { f.close(); }
});

test('native update rejects equal, older and unsupported installations and can apply a pending installed release', async () => {
  for (const version of ['2.0.1', '2.0.0']) {
    const f = controllerFixture({ nativeRelease: async () => release(version) });
    try { assert.equal((await f.controller.call({ operation: 'opencode-update', acknowledge: true })).status, 409); } finally { f.close(); }
  }
  const unsupported = controllerFixture({ nativeInfo: async () => ({ supported: false, version: '0.0.0-v2-local', reason: 'Unsupported installation' }) });
  try { assert.equal((await unsupported.controller.call({ operation: 'opencode-update', acknowledge: true })).status, 422); } finally { unsupported.close(); }
  const pending = controllerFixture({ nativeInfo: async () => ({ supported: true, version: '2.0.0', installedVersion: '2.0.1', pendingRestart: true }), nativeRelease: async () => release('2.0.1') });
  try {
    assert.equal((await pending.controller.call({ operation: 'opencode-update', acknowledge: true })).status, 202);
    const job = JSON.parse(readFileSync(join(pending.stateDir, 'job.json'))); assert.equal(job.version, '2.0.1'); assert.equal(job.release, null);
  } finally { pending.close(); }
});

test('native update reauthenticates after a pending check and only one concurrent request launches', async () => {
  const gate = deferred(); let current = password, launches = 0;
  const f = controllerFixture({ password: () => current, nativeRelease: () => gate.promise, nativeLaunch: () => { launches++; } });
  try {
    const pending = f.controller.call({ operation: 'opencode-update', acknowledge: true });
    current = 'replacement-native-update-password'; gate.resolve(release('2.0.2'));
    assert.equal((await pending).status, 401); assert.equal(launches, 0);
    const results = await Promise.all([f.controller.call({ operation: 'opencode-update', password: current, acknowledge: true }), f.controller.call({ operation: 'opencode-update', password: current, acknowledge: true })]);
    assert.deepEqual(results.map(value => value.status).sort(), [202, 409]); assert.equal(launches, 1);
  } finally { f.close(); }
});

test('interrupted native jobs require recovery before another administrative change', async () => {
  const f = controllerFixture();
  try {
    writeFileSync(join(f.stateDir, 'job.json'), JSON.stringify({ type: 'opencode-update', phase: 'running', started: Date.now() - 31 * 60000 }), { mode: 0o600 });
    const status = await f.controller.call({ operation: 'status' }); assert.equal(status.job.phase, 'failed'); assert(status.job.recoveryRequired);
    assert.equal((await f.controller.call({ operation: 'preferences', password, automatic: true, channel: 'stable' })).status, 409);
  } finally { f.close(); }
});

test('native web APIs enforce session, origin, CSRF and acknowledgement without clearing failed attempts on checks', async () => {
  const f = controllerFixture({ nativeVersions: async () => ['2.0.0'], nativeSelectedRelease: async version => release(version) });
  const socket = join(f.directory, 'helper.sock'); let forwarded;
  const helper = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    forwarded = JSON.parse(Buffer.concat(chunks)); const result = await f.controller.call(forwarded);
    res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  const backend = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head></head><body>Fixture</body></html>'); });
  helper.listen(socket); backend.listen(0, '127.0.0.1'); await Promise.all([once(helper, 'listening'), once(backend, 'listening')]);
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const origin = `http://127.0.0.1:${port}`, database = join(f.directory, 'gateway.sqlite');
  const gateway = createLoginServer({ port, backendPort: backend.address().port, adminSocket: socket, statePath: database });
  const store = new SecurityStore(database), session = store.createSession('native_fixture_token', origin);
  const cookie = `opencode_login_${port}=${session}`;
  const request = (path, options = {}) => fetch(origin + path, { ...options, headers: { cookie, 'x-opencode-login': '1', ...options.headers } });
  await gateway.listen();
  try {
    assert.equal((await fetch(origin + '/web-login/opencode')).status, 401);
    assert.equal((await fetch(origin + '/web-login/api/opencode-status')).status, 401);
    const panel = await request('/web-login/opencode'); assert.equal(panel.headers.get('x-frame-options'), 'SAMEORIGIN'); assert((await panel.text()).includes('id="native-form"'));
    const status = await (await request('/web-login/api/opencode-status')).json(); assert(status.csrf); assert.equal(status.opencode.version, '2.0.1');
    const options = { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-web-login-csrf': status.csrf }, body: '{}' };
    assert.equal((await request('/web-login/api/opencode-check', { ...options, headers: { ...options.headers, origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await request('/web-login/api/opencode-update', { ...options, headers: { ...options.headers, 'x-web-login-csrf': 'forged' } })).status, 403);
    assert.equal((await request('/web-login/api/opencode-install', { ...options, headers: { ...options.headers, 'x-web-login-csrf': 'forged' } })).status, 403);
    assert.equal((await request('/web-login/api/opencode-install', { ...options, body: JSON.stringify({ acknowledge: true, version: '2.0.0;id' }) })).status, 422);
    for (let i = 0; i < 3; i++) store.fail('127.0.0.1');
    assert.equal((await request('/web-login/api/opencode-check', options)).status, 200); assert.equal(store.state('127.0.0.1').failures, 3);
    assert.equal((await fetch(origin + '/web-login/api/opencode-update', options)).status, 401); assert.equal(store.state('127.0.0.1').failures, 3);
    assert.equal((await request('/web-login/api/opencode-update', { ...options, body: JSON.stringify({}) })).status, 422);
    assert.equal((await request('/web-login/api/opencode-update', { ...options, body: JSON.stringify({ acknowledge: true, version: '999.0.0', command: 'arbitrary', url: 'https://attacker.example' }) })).status, 202);
    assert.deepEqual(Object.keys(forwarded).sort(), ['acknowledge', 'operation']); assert.equal(store.state('127.0.0.1').failures, 3);
    assert(store.session(session, origin), 'An OpenCode update must not revoke the unchanged login credential');
    writeFileSync(join(f.stateDir, 'job.json'), JSON.stringify({ type: 'opencode-update', phase: 'failed', recoveryRequired: false }), { mode: 0o600 });
    assert.equal((await request('/web-login/api/opencode-install', { ...options, body: JSON.stringify({ acknowledge: true, version: '2.0.0', command: 'arbitrary', url: 'https://attacker.example' }) })).status, 202);
    assert.deepEqual(Object.keys(forwarded).sort(), ['acknowledge', 'operation', 'version']);
    assert.equal(JSON.parse(readFileSync(join(f.stateDir, 'job.json'))).version, '2.0.0');
  } finally {
    store.close(); await gateway.close(); helper.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(done => helper.close(done)), new Promise(done => backend.close(done))]); f.close();
  }
});

function rootFixture() {
  const directory = mkdtempSync('/opt/oc-native-fixture-'); chmodSync(directory, 0o755);
  const prefix = join(directory, 'prefix'), code = join(prefix, 'lib/node_modules/@opencode/cli');
  mkdirSync(join(code, 'bin'), { recursive: true }); mkdirSync(join(prefix, 'bin'));
  writeFileSync(join(code, 'package.json'), JSON.stringify(pkg('2.0.1'))); writeFileSync(join(code, 'bin/opencode.exe'), 'old-native-binary', { mode: 0o755 });
  symlinkSync('../lib/node_modules/@opencode/cli/bin/opencode.exe', join(prefix, 'bin/opencode'));
  symlinkSync('../lib/node_modules/@opencode/cli/bin/opencode.exe', join(prefix, 'bin/opencode2'));
  const data = join(directory, 'data'); mkdirSync(data, { mode: 0o700 }); chownSync(data, 65534, 65534);
  const database = join(data, 'opencode.db'); const db = new DatabaseSync(database); db.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'before\')'); db.close(); chmodSync(database, 0o600); chownSync(database, 65534, 65534);
  const module = join(directory, 'module'); mkdirSync(module); writeFileSync(join(module, 'package.json'), JSON.stringify({ version: '1.1.1-beta' }));
  const name = 'oc-native-' + randomBytes(4).toString('hex');
  const config = { name, opencode: join(prefix, 'bin/opencode'), node: process.execPath, installDirectory: module, backendService: `${name}-backend.service`, gateway: {} };
  assert.equal(lstatSync(`/etc/systemd/system/${config.backendService}.d`, { throwIfNoEntry: false }), undefined);
  const context = { user: 'nobody', uid: 65534, gid: 65534, databases: [database], sessionIds: ['fixture-session'] };
  return { directory, prefix, code, database, config, context, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('native snapshots preserve npm binaries, links and SQLite data using the backend user', { skip: process.getuid?.() !== 0 }, async () => {
  const f = rootFixture();
  try {
    const install = openCodeInstallation(f.config);
    const directory = await snapshotOpenCode(f.config, install, f.context, { root: join(f.directory, 'backups') });
    await snapshotOpenCodeData(f.config, directory);
    assert.equal(lstatSync(join(directory, 'databases/database-0.sqlite')).uid, 0);
    assert.equal(lstatSync(join(directory, 'databases')).mode & 0o777, 0o700);
    assert(lstatSync(join(f.directory, 'backups/.git')).isDirectory());
    writeFileSync(join(f.code, 'package.json'), JSON.stringify(pkg('2.0.2'))); writeFileSync(join(f.code, 'bin/opencode.exe'), 'changed');
    let db = new DatabaseSync(f.database); db.exec("INSERT INTO fixture VALUES ('after')"); db.close();
    await restoreOpenCode(f.config, directory);
    assert.equal(JSON.parse(readFileSync(join(f.code, 'package.json'))).version, '2.0.1'); assert.equal(readFileSync(join(f.code, 'bin/opencode.exe'), 'utf8'), 'old-native-binary');
    assert.equal(readlinkSync(join(f.prefix, 'bin/opencode')), '../lib/node_modules/@opencode/cli/bin/opencode.exe');
    db = new DatabaseSync(f.database); assert.deepEqual(db.prepare('SELECT value FROM fixture').all().map(row => row.value), ['before']); db.close();
    assert.equal(lstatSync(f.database).uid, 65534);
  } finally { f.close(); }
});

for (const scenario of [null, 'install', 'health', 'recovery', 'preflight', 'symlink', 'diagnostics', 'downgrade', 'downgrade-health']) test(`native worker ${scenario || 'success'} stages before stopping and restores real files/data on failure`, { skip: process.getuid?.() !== 0 }, async () => {
  const downgrade = scenario?.startsWith('downgrade'), failure = downgrade ? scenario === 'downgrade-health' ? 'health' : null : scenario;
  const targetVersion = downgrade ? '2.0.0' : '2.0.2';
  const f = rootFixture(), stateDir = join(f.directory, 'state'); mkdirSync(stateDir, { mode: 0o700 });
  const jobPath = join(stateDir, 'job.json'), requested = release(targetVersion);
  writeFileSync(jobPath, JSON.stringify({ type: 'opencode-update', phase: 'starting', version: targetVersion, explicitTarget: Boolean(downgrade), fromVersion: '2.0.1', release: requested, passwordRevision: createHash('sha256').update(password).digest('hex'), started: Date.now() }), { mode: 0o600 });
  const calls = []; let failedHealth = false;
  const workerRun = async (binary, args, options = {}) => {
    if (binary === 'systemctl') { calls.push(args[0]); return ''; }
    if (binary === f.config.node && args.includes('install')) {
      assert(args.includes('--ignore-scripts')); assert.equal(options.env.npm_config_registry, 'https://registry.npmjs.org');
      if (!args.includes('--global')) {
        calls.push('stage'); const staging = args[args.indexOf('--prefix') + 1]; const metadata = pkg(targetVersion);
        const code = join(staging, 'node_modules/@opencode/cli'); mkdirSync(code, { recursive: true }); writeFileSync(join(code, 'package.json'), JSON.stringify(metadata));
        for (const name of Object.keys(metadata.optionalDependencies)) { const platform = join(staging, 'node_modules', name); mkdirSync(join(platform, 'bin'), { recursive: true }); writeFileSync(join(platform, 'package.json'), JSON.stringify({ name, version: targetVersion })); writeFileSync(join(platform, 'bin/opencode'), 'new-native-binary', { mode: 0o755 }); }
      } else {
        calls.push('install'); writeFileSync(join(f.code, 'package.json'), JSON.stringify(pkg(targetVersion))); writeFileSync(join(f.code, 'bin/opencode.exe'), 'placeholder');
        const db = new DatabaseSync(f.database); db.exec("INSERT INTO fixture VALUES ('migration')"); db.close();
        if (failure === 'symlink') {
          writeFileSync(join(f.directory, 'unrelated-file'), 'must-remain-unchanged');
          rmSync(join(f.code, 'bin/opencode.exe')); symlinkSync(join(f.directory, 'unrelated-file'), join(f.code, 'bin/opencode.exe'));
        }
        if (['install', 'diagnostics'].includes(failure)) throw new Error('Injected installation failure');
      }
      return '';
    }
    if (binary === 'runuser' && args.at(-1) === '--version') return 'opencode v' + targetVersion;
    return run(binary, args, options);
  };
  try {
    await applyOpenCodeUpdate(f.config, { stateDir, run: workerRun, password: () => password, context: () => f.context,
      release: async () => failure === 'preflight' ? { ...requested, integrity: 'changed' } : requested, download: async () => archive,
      onError: () => { if (failure === 'diagnostics') throw new Error('Injected diagnostic failure'); },
      snapshot: (config, install, context, options) => snapshotOpenCode(config, install, context, { ...options, root: join(f.directory, 'backups') }),
      healthy: async (config, version, pw, options) => {
        assert.equal(pw, password);
        if (failure === 'recovery') return false;
        if (failure === 'health' && !failedHealth) { failedHealth = true; return false; }
        if (!failure) assert.deepEqual(options.expectedSessions, ['fixture-session']);
        return true;
      },
    });
    const job = JSON.parse(readFileSync(jobPath)); assert.equal(job.phase, failure ? 'failed' : 'succeeded'); assert.equal(Boolean(job.recoveryRequired), failure === 'recovery');
    assert(!JSON.stringify(job).includes(password));
    if (failure === 'preflight') assert.deepEqual(calls, []);
    else assert(calls.indexOf('stage') < calls.indexOf('stop'));
    const expected = failure ? '2.0.1' : targetVersion; assert.equal(JSON.parse(readFileSync(join(f.code, 'package.json'))).version, expected);
    assert.equal(readFileSync(join(f.code, 'bin/opencode.exe'), 'utf8'), failure ? 'old-native-binary' : 'new-native-binary');
    if (failure === 'symlink') assert.equal(readFileSync(join(f.directory, 'unrelated-file'), 'utf8'), 'must-remain-unchanged');
    if (downgrade) {
      const dropin = `/etc/systemd/system/${f.config.backendService}.d/96-web-login-manual-version.conf`;
      if (failure) assert.equal(lstatSync(dropin, { throwIfNoEntry: false }), undefined);
      else assert(readFileSync(dropin, 'utf8').includes('OPENCODE_DISABLE_AUTOUPDATE=1'));
    }
    if (failure) { const db = new DatabaseSync(f.database); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture').get().count, 1); db.close(); }
  } finally {
    if (downgrade) {
      rmSync(`/etc/systemd/system/${f.config.backendService}.d/96-web-login-manual-version.conf`, { force: true });
      // Remove only the empty fixture directory; never recursively remove service configuration.
      try { rmdirSync(`/etc/systemd/system/${f.config.backendService}.d`); } catch {}
    }
    process.exitCode = 0; f.close();
  }
});

test('native worker and recovery share an exclusive lock without overwriting an active job', { skip: process.getuid?.() !== 0 }, async () => {
  const f = rootFixture(), stateDir = join(f.directory, 'state'); mkdirSync(stateDir, { mode: 0o700 });
  const jobPath = join(stateDir, 'job.json');
  writeFileSync(jobPath, JSON.stringify({ type: 'opencode-update', phase: 'starting', version: '2.0.1', fromVersion: '2.0.1', started: Date.now(), passwordRevision: createHash('sha256').update(password).digest('hex') }), { mode: 0o600 });
  const ready = deferred(); let active;
  try {
    active = applyOpenCodeUpdate(f.config, { stateDir, password: () => password, context: () => ready.promise, run: async () => '', snapshot: async () => 'isolated-snapshot', snapshotData: async () => {}, healthy: async () => true });
    const before = readFileSync(jobPath, 'utf8');
    await assert.rejects(applyOpenCodeUpdate(f.config, { stateDir }), /Another OpenCode/);
    await assert.rejects(recoverOpenCodeUpdate(f.config, { stateDir }), /Another OpenCode/);
    assert.equal(readFileSync(jobPath, 'utf8'), before);
    ready.resolve(f.context); await active;
    assert.equal(JSON.parse(readFileSync(jobPath)).phase, 'succeeded');
    await assert.rejects(applyOpenCodeUpdate(f.config, { stateDir }), /Invalid OpenCode update job/);
    assert.equal(JSON.parse(readFileSync(jobPath)).phase, 'succeeded');
  } finally { ready.resolve(f.context); await active; process.exitCode = 0; f.close(); }
});

test('interrupted preparation is cleared only after verifying the original service and installation', { skip: process.getuid?.() !== 0 }, async () => {
  const f = rootFixture(), stateDir = join(f.directory, 'state'); mkdirSync(stateDir, { mode: 0o700 });
  const jobPath = join(stateDir, 'job.json'), original = { type: 'opencode-update', phase: 'failed', recoveryRequired: true, version: '2.0.2', fromVersion: '2.0.1' };
  const calls = [];
  const dependencies = { stateDir, run: async (file, args) => { calls.push(args[0]); return 'inactive'; }, password: () => password, healthy: async (config, version, pw) => { assert.equal(version, '2.0.1'); assert.equal(pw, password); return true; } };
  const save = job => writeFileSync(jobPath, JSON.stringify(job), { mode: 0o600 });
  try {
    for (const [job, overrides] of [[{ ...original, stopStarted: true }, {}], [original, { healthy: async () => false }], [original, { installation: () => ({ version: '2.0.2' }) }], [original, { run: async () => 'active' }]]) {
      save(job); await assert.rejects(recoverOpenCodeUpdate(f.config, { ...dependencies, ...overrides }));
      assert.equal(JSON.parse(readFileSync(jobPath)).recoveryRequired, true);
    }
    save(original);
    const ready = deferred(); const recovering = recoverOpenCodeUpdate(f.config, { ...dependencies, healthy: () => ready.promise });
    await assert.rejects(recoverOpenCodeUpdate(f.config, dependencies), /Another OpenCode/);
    ready.resolve(true); await recovering;
    assert.equal(JSON.parse(readFileSync(jobPath)).recoveryRequired, false);
    assert(calls.every(action => action === 'show'));
  } finally { f.close(); }
});
