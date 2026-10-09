import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';

test('failed installation restores files, dependencies and service state', { skip: process.platform !== 'linux' || process.getuid?.() !== 0, timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-installer-test-'));
  const name = `oc-review-${process.pid}`;
  const directory = `/opt/${name}`;
  const environment = `/etc/${name}.env`;
  const service = `/etc/systemd/system/${name}.service`;
  const backend = `${name}-backend.service`;
  const dropinDirectory = `/etc/systemd/system/${backend}.d`;
  const dropin = join(dropinDirectory, 'web-login.conf');
  const backup = `/var/lib/${name}-install-backup`;
  for (const path of [directory, environment, service, dropinDirectory, backup]) assert.equal(existsSync(path), false, `Refuse to touch an existing fixture: ${path}`);
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const originals = new Map([[environment, 'ORIGINAL=preserved\n'], [service, '# Original fixture service\n'], [dropin, '# Original fixture override\n'], [join(directory, 'package.json'), '{"name":"previous-fixture"}\n']]);
  const tools = join(dir, 'tools');
  const log = join(dir, 'commands.jsonl');
  const failure = join(dir, 'failure-injected');
  const script = `#!${process.execPath}
    import {basename} from 'node:path';
    import {appendFileSync,existsSync,writeFileSync,mkdirSync} from 'node:fs';
    const name=basename(process.argv[1]); const args=process.argv.slice(2);
    appendFileSync(${JSON.stringify(log)},JSON.stringify({name,args})+'\\n');
    if(name==='systemctl') {
      if(args[0]==='show') console.log(args.includes('LoadState')?'loaded':args.includes('ActiveState')?'active':'0');
      else if(args[0]==='is-enabled') console.log('enabled');
      else if(args[0]==='restart' && args[1]===${JSON.stringify(backend)} && !existsSync(${JSON.stringify(failure)})) {writeFileSync(${JSON.stringify(failure)},'failed');process.exitCode=1;}
    } else if(name==='getent') {
      console.log(args[0]==='passwd'?${JSON.stringify(`${name}:x:0:0:fixture:/var/lib/${name}:/usr/sbin/nologin`)}:${JSON.stringify(`${name}:x:0:`)});
    } else if(name==='npm') {mkdirSync('node_modules');writeFileSync('node_modules/fixture','new-dependencies');}
  `;
  try {
    mkdirSync(tools);
    for (const binary of ['systemctl', 'systemd-analyze', 'getent', 'npm', 'chown']) writeFileSync(join(tools, binary), script, { mode: 0o755 });
    for (const [path, text] of originals) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text, { mode: path === environment ? 0o640 : 0o644 }); }
    mkdirSync(join(directory, 'node_modules'));
    writeFileSync(join(directory, 'node_modules', 'fixture'), 'previous-dependencies');
    const child = spawn(process.execPath, [new URL('../bin/opencode-web-login.mjs', import.meta.url).pathname, 'install', '--name', name, '--install-dir', directory, '--opencode-service', backend, '--opencode-bin', '/usr/bin/true', '--port', String(port), '--backend-port', String(port === 65535 ? 65534 : port + 1)], { env: { ...process.env, PATH: `${tools}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.resume(); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(stderr, /Previous files, dependencies and service state restored/);
    assert(stderr.includes(backup));
    for (const [path, text] of originals) assert.equal(readFileSync(path, 'utf8'), text);
    assert.equal(statSync(environment).mode & 0o777, 0o640);
    assert.equal(existsSync(join(directory, 'index.mjs')), false, 'Files absent before installation must be removed during restoration');
    assert.equal(readFileSync(join(directory, 'node_modules', 'fixture'), 'utf8'), 'previous-dependencies');
    assert(existsSync(join(backup, '.git')));
    const commands = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(commands.filter((entry) => entry.name === 'systemctl' && entry.args[0] === 'restart' && entry.args[1] === backend).length, 2, 'Rollback must restore the active backend');
    assert(commands.some((entry) => entry.name === 'systemctl' && entry.args[0] === 'restart' && entry.args[1] === `${name}.service`));
    assert.equal(commands.some((entry) => entry.name === 'systemctl' && entry.args[0] === 'disable'), false, 'Previously enabled services must remain enabled');
  } finally {
    for (const path of [directory, dropinDirectory, backup, dir]) rmSync(path, { recursive: true, force: true });
    for (const path of [environment, service]) rmSync(path, { force: true });
  }
});
