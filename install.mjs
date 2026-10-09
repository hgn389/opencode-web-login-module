import { parseArgs } from 'node:util';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import { normalizeConfig } from './config.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const files = ['package.json', 'npm-shrinkwrap.json', 'index.mjs', 'config.mjs', 'security.mjs', 'cli.mjs', 'server.mjs', 'manage.mjs', 'install.mjs', 'login.html', 'README.md', 'environment.example', 'bin/opencode-web-login.mjs', 'assets/DejaVuSans-Bold.ttf', 'assets/LICENSE-fonts.txt'];
const help = `Install an OpenCode Web Login service on Linux with systemd.

Usage: opencode-web-login install --opencode-bin /absolute/path/opencode [options]
  --name NAME                  Service and system user name (default: opencode-login)
  --install-dir PATH           Code directory (default: /opt/NAME)
  --opencode-service UNIT       Existing OpenCode service (default: opencode.service)
  --host IP                    Listen address (default: 127.0.0.1)
  --port PORT                  Login port (default: 4096)
  --backend-port PORT          Private OpenCode port (default: 4097)
  --public-origins LIST        Comma-separated exact HTTPS origins
  --trusted-proxies LIST       Trusted IPs/CIDRs (default: 127.0.0.1,::1)
  --dry-run                    Print the configuration without changing anything

The existing OpenCode service must be installed with its password configured.
The installer backs up changed files in a private Git repository, installs the
module and its locked dependencies, then enables and starts the login service.
It preserves the existing session/lockout database and does not change firewall,
DNS or TLS configuration. For access on a LAN address, supply --host explicitly.
`;

function path(value, name) {
  if (!isAbsolute(value) || /[\x00-\x1f%$]/.test(value)) throw new Error(`${name} must be an absolute path without control characters, % or $`);
  return resolve(value);
}
function command(binary, args) { return execFileSync(binary, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function git(repo, args) { return command('git', ['-C', repo, ...args]); }
function commit(repo, message) {
  git(repo, ['add', '--all']);
  if (git(repo, ['diff', '--cached', '--name-only'])) git(repo, ['-c', 'user.name=System Administrator', '-c', 'user.email=admin@localhost', 'commit', '--quiet', '-m', message]);
}
async function checkPort(config, name) {
  const probe = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(config.port, config.host, resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const pid = command('systemctl', ['show', `${name}.service`, '-p', 'MainPID', '--value']);
    const sockets = command('ss', ['-H', '-ltnp', `sport = :${config.port}`]);
    const owned = Number(pid) > 0 && sockets.split('\n').some((line) => {
      const address = line.trim().split(/\s+/)[3];
      return line.includes(`pid=${pid},`) && [config.authority, `0.0.0.0:${config.port}`, `*:${config.port}`, `[::]:${config.port}`].includes(address);
    });
    if (!owned) throw new Error(`Login port ${config.authority} is already used by another process`);
  }
}
function ready(config) {
  return new Promise((resolve) => {
    const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
    const request = http.get({ hostname: host, port: config.port, path: '/login', headers: { host: config.authority } }, (response) => {
      let body = '';
      response.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
      response.on('end', () => resolve([200, 403].includes(response.statusCode) && body.includes('name="csrf"')));
      response.on('error', () => resolve(false));
    });
    request.setTimeout(500, () => request.destroy());
    request.on('error', () => resolve(false));
  });
}
function backup(name, targets) {
  const repo = `/var/lib/${name}-install-backup`;
  mkdirSync(repo, { recursive: true, mode: 0o700 });
  chmodSync(repo, 0o700);
  if (!existsSync(join(repo, '.git'))) command('git', ['init', '--quiet', repo]);
  for (const target of targets) {
    if (!existsSync(target)) continue;
    const dest = join(repo, target.slice(1));
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    copyFileSync(target, dest);
    chmodSync(dest, 0o600);
  }
  commit(repo, 'Back up configuration before installing the login module');
  return repo;
}

export async function install(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'opencode-bin': { type: 'string' }, 'opencode-service': { type: 'string' }, name: { type: 'string' },
    'install-dir': { type: 'string' }, host: { type: 'string' }, port: { type: 'string' },
    'backend-port': { type: 'string' }, 'public-origins': { type: 'string' }, 'trusted-proxies': { type: 'string' },
    'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  if (positionals.length) throw new Error('Unexpected installer arguments');
  const name = values.name || 'opencode-login';
  if (!/^[a-z][a-z0-9-]{0,27}$/.test(name)) throw new Error('Invalid service name');
  const backendService = values['opencode-service'] || 'opencode.service';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9@_.-]*\.service$/.test(backendService) || backendService === `${name}.service`) throw new Error('Invalid OpenCode service name');
  if (!values['opencode-bin']) throw new Error('--opencode-bin is required');
  const opencode = path(values['opencode-bin'], 'opencode-bin');
  const directory = path(values['install-dir'] || `/opt/${name}`, 'install-dir');
  if (directory === '/' || /^\/(root|home)(\/|$)/.test(directory)) throw new Error('install-dir must be outside home directories');
  const node = path(process.execPath, 'Node executable');
  if (/^\/(root|home)(\/|$)/.test(node)) throw new Error('Use a system Node.js 24+ installation outside home directories');
  const list = (value) => value.split(',').map((part) => part.trim()).filter(Boolean);
  const config = normalizeConfig({ host: values.host, port: values.port, backendPort: values['backend-port'],
    statePath: `/var/lib/${name}/security.sqlite`, publicOrigins: list(values['public-origins'] || ''),
    trustedProxies: values['trusted-proxies'] === undefined ? undefined : list(values['trusted-proxies']) });
  const envPath = `/etc/${name}.env`;
  const servicePath = `/etc/systemd/system/${name}.service`;
  const dropinPath = `/etc/systemd/system/${backendService}.d/web-login.conf`;
  const environment = Object.entries({ LOGIN_HOST: config.host, LOGIN_PORT: config.port,
    OPENCODE_BACKEND_HOST: config.backendHost, OPENCODE_BACKEND_PORT: config.backendPort,
    LOGIN_STATE_DB: config.statePath, LOGIN_PUBLIC_ORIGINS: config.publicOrigins.join(','),
    LOGIN_TRUSTED_PROXIES: config.trustedProxies.join(',') }).map(([key, value]) => `${key}=${JSON.stringify(String(value))}`).join('\n') + '\n';
  const unit = `[Unit]
Description=OpenCode Web Login
Requires=${backendService}
PartOf=${backendService}
Wants=network-online.target
After=network-online.target ${backendService}

[Service]
Type=simple
User=${name}
Group=${name}
WorkingDirectory=${JSON.stringify(directory)}
EnvironmentFile=${JSON.stringify(envPath)}
StateDirectory=${name}
StateDirectoryMode=0700
ExecStart=${JSON.stringify(node)} ${JSON.stringify(join(directory, 'bin/opencode-web-login.mjs'))} serve
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryMax=256M
TasksMax=64
UMask=0077

[Install]
WantedBy=multi-user.target
`;
  const dropin = `[Service]\nExecStart=\nExecStart=${JSON.stringify(opencode)} serve --hostname 127.0.0.1 --port ${config.backendPort}\n`;
  const plan = { service: `${name}.service`, installDirectory: directory, backupDirectory: `/var/lib/${name}-install-backup`,
    files: { [envPath]: environment, [servicePath]: unit, [dropinPath]: dropin } };
  if (values['dry-run']) { console.log(JSON.stringify(plan, null, 2)); return plan; }
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('System service installation requires root on Linux');
  accessSync(opencode, constants.X_OK);
  command('git', ['--version']);
  if (command('systemctl', ['show', backendService, '-p', 'LoadState', '--value']) !== 'loaded') throw new Error('Install and configure the existing OpenCode service first');
  await checkPort(config, name);
  const repo = backup(name, [...Object.keys(plan.files), ...files.map((file) => join(directory, file))]);
  let account;
  try { account = command('getent', ['passwd', name]).split(':'); }
  catch (error) { if (error.status !== 2) throw error; }
  if (account) {
    if (account[5] !== `/var/lib/${name}` || !account[6].endsWith('/nologin')) throw new Error('Existing service user must have its own state home and nologin shell');
  }
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  for (const file of files) {
    const dest = join(directory, file);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    if (resolve(join(source, file)) !== resolve(dest)) copyFileSync(join(source, file), dest);
    chmodSync(dest, file.startsWith('bin/') ? 0o755 : 0o644);
  }
  if (!account) command('useradd', ['--system', '--user-group', '--home-dir', `/var/lib/${name}`, '--shell', '/usr/sbin/nologin', name]);
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit' });
  for (const [target, content] of Object.entries(plan.files)) {
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, content, { mode: target === envPath ? 0o640 : 0o644 });
    chmodSync(target, target === envPath ? 0o640 : 0o644);
  }
  command('chown', [`root:${name}`, envPath]);
  command('systemctl', ['daemon-reload']);
  command('systemctl', ['enable', `${name}.service`]);
  command('systemctl', ['restart', backendService]);
  command('systemctl', ['restart', `${name}.service`]);
  for (let attempt = 0; attempt < 50; attempt++) {
    if (command('systemctl', ['show', `${name}.service`, '-p', 'ActiveState', '--value']) === 'active' && await ready(config)) {
      console.log(JSON.stringify({ installed: true, service: `${name}.service`, config: envPath, gateway: config.localOrigin, backup: repo }, null, 2));
      return plan;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`The login service did not start. Configuration backups: ${repo}`);
}
