import { homedir } from 'node:os';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { lstatSync } from 'node:fs';
import { isIP } from 'node:net';

export function validateStateFiles(path, { requireDatabase = false } = {}) {
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077) throw new Error('The security database directory must be owned by the current user with permissions 0700');
  for (let directory = dirname(dirname(path)); ; directory = dirname(directory)) {
    const info = lstatSync(directory);
    const safeTemporaryDirectory = info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (!info.isDirectory() || ![0, process.getuid()].includes(info.uid) || info.mode & 0o022 && !safeTemporaryDirectory) throw new Error('Unsafe security database ancestor directory');
    if (directory === dirname(directory)) break;
  }
  for (const file of [path, path + '-wal', path + '-shm']) {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info) { if (file === path && requireDatabase) throw new Error('Security database does not exist'); continue; }
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('Security database files must be regular files owned by the current user with permissions 0600');
  }
}

export function defaultStatePath() {
  return join(homedir(), '.local', 'state', 'opencode-web-login', 'security.sqlite');
}

function port(value, name) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !/^\d+$/.test(value))) throw new Error(`${name} must be an integer between 1 and 65535`);
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error(`${name} must be an integer between 1 and 65535`);
  return result;
}

export function normalizeConfig(input = {}) {
  let host = input.host ?? '127.0.0.1';
  if (!isIP(host)) throw new Error('host must be an IPv4 or IPv6 listen address');
  if (isIP(host) === 6) host = new URL(`http://[${host}]`).hostname.slice(1, -1);
  const listenPort = port(input.port ?? 4096, 'port');
  const backendHost = input.backendHost ?? '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(backendHost)) throw new Error('The OpenCode backend must listen on loopback');
  const backendPort = port(input.backendPort ?? 4097, 'backendPort');
  if ((host === backendHost || ['0.0.0.0', '::'].includes(host)) && listenPort === backendPort) throw new Error('Gateway and backend ports must be different');
  const statePath = input.statePath ?? defaultStatePath();
  if (typeof statePath !== 'string' || statePath.includes('\0') || !isAbsolute(statePath)) throw new Error('statePath must be an absolute filename');
  const adminSocket = input.adminSocket || undefined;
  if (adminSocket !== undefined && (typeof adminSocket !== 'string' || !isAbsolute(adminSocket) || /[\x00-\x1f]/.test(adminSocket))) throw new Error('adminSocket must be an absolute Unix socket path');
  const publicOrigins = input.publicOrigins ?? [];
  const trustedProxies = input.trustedProxies ?? ['127.0.0.1', '::1'];
  if (!Array.isArray(publicOrigins) || !Array.isArray(trustedProxies)) throw new Error('publicOrigins and trustedProxies must be arrays');
  const authority = `${isIP(host) === 6 ? `[${host}]` : host}:${listenPort}`;
  const localOrigin = `http://${authority}`;
  for (const origin of publicOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || url.protocol !== 'https:') throw new Error('publicOrigins must contain exact HTTPS origins');
  }
  for (const address of trustedProxies) {
    if (typeof address !== 'string') throw new Error('Invalid trusted proxy address');
    const parts = address.split('/');
    const version = isIP(parts[0]);
    if (!version || parts.length > 2 || (parts.length === 2 && (!/^\d+$/.test(parts[1]) || Number(parts[1]) > (version === 4 ? 32 : 128)))) throw new Error('Invalid trusted proxy address or CIDR');
  }
  return Object.freeze({ host, port: listenPort, backendHost, backendPort, statePath: resolve(statePath), adminSocket, authority, localOrigin,
    publicOrigins: Object.freeze([...publicOrigins]), trustedProxies: Object.freeze([...trustedProxies]) });
}

export function configFromEnv(env = process.env) {
  const list = (value) => value.split(',').map((part) => part.trim()).filter(Boolean);
  return normalizeConfig({
    host: env.LOGIN_HOST,
    port: env.LOGIN_PORT,
    backendHost: env.OPENCODE_BACKEND_HOST,
    backendPort: env.OPENCODE_BACKEND_PORT,
    statePath: env.LOGIN_STATE_DB,
    adminSocket: env.LOGIN_ADMIN_SOCKET,
    publicOrigins: env.LOGIN_PUBLIC_ORIGINS === undefined ? undefined : list(env.LOGIN_PUBLIC_ORIGINS),
    trustedProxies: env.LOGIN_TRUSTED_PROXIES === undefined ? undefined : list(env.LOGIN_TRUSTED_PROXIES),
  });
}

export function loginAddress(config) {
  if (config.publicOrigins.length) return config.publicOrigins[0] + '/login';
  if (['0.0.0.0', '::'].includes(config.host)) return `http://IP_SERVER:${config.port}/login`;
  return config.localOrigin + '/login';
}
