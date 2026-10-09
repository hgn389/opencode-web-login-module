import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { once } from 'node:events';
import { rotatePassword, runningPassword } from '../admin-service.mjs';
import { readResponse } from '../http-client.mjs';

test('real systemd password rotation preserves special characters and invalidates old password', {
  skip: process.getuid?.() !== 0 || !existsSync('/run/systemd/private'), timeout: 30000,
}, async () => {
  const name = `oc-smoke-${process.pid}`;
  const backendService = `${name}-backend.service`;
  const backendUnit = `/etc/systemd/system/${backendService}`;
  const gatewayUnit = `/etc/systemd/system/${name}.service`;
  const dropinDirectory = `/etc/systemd/system/${backendService}.d`;
  const passwordFile = `/etc/${name}-backend-password.env`;
  const backup = `/var/lib/${name}-install-backup`;
  const dir = mkdtempSync(join(tmpdir(), 'login-systemd-smoke-'));
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const original = randomBytes(24).toString('base64url');
  const replacement = randomBytes(24).toString('base64url') + ' $`"\'\\#; tiếng Việt';
  const run = args => execFileSync('systemctl', args, { stdio: 'pipe', timeout: 10000 });
  for (const file of [backendUnit, gatewayUnit, dropinDirectory, passwordFile, backup]) assert.equal(existsSync(file), false);
  try {
    const script = join(dir, 'backend.mjs');
    writeFileSync(script, `import http from 'node:http';
      http.createServer((req,res)=>{
        const good=req.headers.authorization==='Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64');
        res.writeHead(good?200:401,{'content-type':'application/json'});res.end('{}');
      }).listen(${port},'127.0.0.1');`);
    writeFileSync(backendUnit, `[Unit]\nDescription=Isolated password rotation test\n[Service]\nType=simple\nEnvironment=OPENCODE_PASSWORD=${original}\nExecStart=${process.execPath} ${script}\n`, { mode: 0o600 });
    writeFileSync(gatewayUnit, '[Unit]\nDescription=Isolated gateway fixture\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/true\n', { mode: 0o644 });
    run(['daemon-reload']); run(['start', backendService, `${name}.service`]);
    const config = { name, backendService, gateway: { backendHost: '127.0.0.1', backendPort: port } };
    for (let i = 0; i < 30; i++) {
      try { await readResponse({ hostname: '127.0.0.1', port, path: '/api/info' }, { timeout: 500 }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert(runningPassword(config) === original);
    await rotatePassword(config, replacement);
    assert(runningPassword(config) === replacement, 'Systemd must preserve password bytes without interpolation');
    assert.equal((await readResponse({ hostname: '127.0.0.1', port, path: '/api/info', headers: { authorization: 'Basic ' + Buffer.from('opencode:' + original).toString('base64') } })).status, 401);
    assert.equal((await readResponse({ hostname: '127.0.0.1', port, path: '/api/info', headers: { authorization: 'Basic ' + Buffer.from('opencode:' + replacement).toString('base64') } })).status, 200);
    assert(readFileSync(passwordFile, 'utf8').includes('OPENCODE_SERVER_PASSWORD='));
    await rotatePassword(config, original);
    assert(runningPassword(config) === original);
  } finally {
    try { run(['stop', backendService, `${name}.service`]); } catch {}
    for (const file of [backendUnit, gatewayUnit, passwordFile]) rmSync(file, { force: true });
    for (const file of [dropinDirectory, backup, dir]) rmSync(file, { recursive: true, force: true });
    try { run(['daemon-reload']); run(['reset-failed', backendService, `${name}.service`]); } catch {}
  }
});
