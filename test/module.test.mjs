import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { createLoginServer, configFromEnv, normalizeConfig } from '../index.mjs';

test('import has no server or database side effects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-import-'));
  const db = join(dir, 'unused.sqlite');
  try {
    const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `await import(${JSON.stringify(new URL('../index.mjs', import.meta.url).href)});`], {
      env: { ...process.env, LOGIN_STATE_DB: db, LOGIN_PORT: 'this-is-not-a-port' }, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(existsSync(db), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('library configuration is explicit, validated and independent of environment', () => {
  assert.equal(normalizeConfig().host, '127.0.0.1');
  assert.equal(normalizeConfig({ host: '::1' }).authority, '[::1]:4096');
  assert.throws(() => normalizeConfig({ port: '4096garbage' }));
  assert.throws(() => normalizeConfig({ backendHost: '198.51.100.1' }));
  assert.throws(() => normalizeConfig({ port: 4097 }));
  assert.throws(() => normalizeConfig({ publicOrigins: ['http://public.example'] }));
  assert.throws(() => normalizeConfig({ trustedProxies: ['127.0.0.1/33'] }));
  assert.throws(() => normalizeConfig({ trustedProxies: ['::1/-1'] }));
  const config = configFromEnv({ LOGIN_HOST: '192.0.2.10', LOGIN_PORT: '8080', OPENCODE_BACKEND_PORT: '8081', LOGIN_PUBLIC_ORIGINS: 'https://login.example', LOGIN_STATE_DB: '/tmp/test.sqlite' });
  assert.equal(config.localOrigin, 'http://192.0.2.10:8080');
  assert.deepEqual(config.publicOrigins, ['https://login.example']);
  assert(Object.isFrozen(config));
});

test('a module instance can listen and close without exiting its caller', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-instance-'));
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const login = createLoginServer({ host: '127.0.0.1', port, statePath: join(dir, 'state.sqlite') });
  try {
    assert.equal(login.server.listening, false);
    await login.listen();
    const response = await fetch(`http://127.0.0.1:${port}/login`);
    assert.equal(response.status, 200);
    assert((await response.text()).includes('Đăng nhập'));
    await login.close();
    await login.close();
    assert.equal(login.server.listening, false);
    await assert.rejects(login.listen(), /closed/);
  } finally { await login.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('installer dry-run creates a portable, hardened plan without touching files', () => {
  const path = new URL('../bin/opencode-web-login.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [path, 'install', '--name', 'login-test', '--opencode-service', 'coding.service',
    '--opencode-bin', '/usr/local/bin/opencode', '--host', '192.0.2.10', '--port', '8080', '--backend-port', '8081', '--public-origins', 'https://login.example', '--dry-run'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.installDirectory, '/opt/login-test');
  assert(plan.files['/etc/login-test.env'].includes('LOGIN_HOST="192.0.2.10"'));
  assert(plan.files['/etc/systemd/system/login-test.service'].includes('User=login-test'));
  assert(plan.files['/etc/systemd/system/login-test.service'].includes('Requires=coding.service'));
  assert(plan.files['/etc/systemd/system/login-test.service'].includes('WorkingDirectory=/opt/login-test\n'));
  assert(plan.files['/etc/systemd/system/coding.service.d/web-login.conf'].includes('"/usr/local/bin/opencode" serve --hostname 127.0.0.1 --port 8081'));
  assert.equal(existsSync('/etc/login-test.env'), false);
});
