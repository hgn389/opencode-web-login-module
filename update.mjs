import { createHash, timingSafeEqual } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const repository = 'hgn389/opencode-web-login-module';
export const moduleFiles = ['package.json', 'npm-shrinkwrap.json', 'index.mjs', 'config.mjs', 'security.mjs', 'http-client.mjs', 'cli.mjs', 'server.mjs', 'manage.mjs', 'install.mjs', 'login.html', 'login-client.js', 'README.md', 'environment.example', 'bin/opencode-web-login.mjs', 'assets/DejaVuSans-Bold.ttf', 'assets/LICENSE-fonts.txt', 'admin-client.mjs', 'admin-service.mjs', 'admin.html', 'admin-ui.js', 'settings-hook.js', 'settings-hook.css', 'update.mjs'];

export function versionParts(value) {
  if (typeof value !== 'string') return;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return;
  const core = match.slice(1, 4).map(Number);
  if (core.some(n => !Number.isSafeInteger(n))) return;
  const pre = match[4]?.split('.');
  if (pre?.some(x => /^\d+$/.test(x) && (x.length > 1 && x[0] === '0' || !Number.isSafeInteger(Number(x))))) return;
  return { core, pre, value: value.replace(/^v/, '') };
}
export function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  if (!x || !y) throw new Error('Invalid version');
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i]);
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]), yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) return Math.sign(Number(x.pre[i]) - Number(y.pre[i]));
    if (xn !== yn) return xn ? -1 : 1;
    return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

export function selectRelease(releases, current, channel) {
  if (!Array.isArray(releases) || !['stable', 'beta'].includes(channel)) throw new Error('Invalid release list');
  return releases.filter(item => {
    const version = versionParts(item.tag_name);
    return !item.draft && version && (channel === 'beta' || (!item.prerelease && !version.pre)) && compareVersions(version.value, current) > 0;
  }).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}

export async function download(url, limit = 2 * 1024 * 1024, { asset = false } = {}) {
  const parsed = new URL(url);
  const permitted = asset ? ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'] : ['api.github.com'];
  if (parsed.protocol !== 'https:' || !permitted.includes(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw new Error('Invalid GitHub download URL');
  const timeout = AbortSignal.timeout(15000);
  let response = await fetch(url, { signal: timeout, redirect: 'manual', headers: { 'user-agent': 'OpenCode-Web-Login', accept: asset ? 'application/octet-stream' : 'application/vnd.github+json' } });
  for (let count = 0; [301, 302, 303, 307, 308].includes(response.status); count++) {
    if (count >= 3) { await response.body?.cancel(); throw new Error('Too many download redirects'); }
    const next = new URL(response.headers.get('location'), response.url);
    await response.body?.cancel();
    if (!asset || next.protocol !== 'https:' || !permitted.includes(next.hostname) || next.username || next.password || next.port) throw new Error('Invalid GitHub redirect');
    response = await fetch(next, { signal: timeout, redirect: 'manual', headers: { 'user-agent': 'OpenCode-Web-Login' } });
  }
  if (!response.ok) { await response.body?.cancel(); throw new Error('GitHub unavailable'); }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('GitHub response too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function latestRelease(current, channel) {
  const releases = JSON.parse((await download(`https://api.github.com/repos/${repository}/releases?per_page=100`)).toString());
  const release = selectRelease(releases, current, channel);
  if (!release) return null;
  const version = versionParts(release.tag_name).value;
  const filename = `opencode-web-login-${version}.tgz`;
  const asset = release.assets?.find(a => a.name === filename && a.state === 'uploaded');
  const digest = asset?.digest;
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(digest || '') || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 8 * 1024 * 1024 || asset.browser_download_url !== `https://github.com/${repository}/releases/download/${release.tag_name}/${filename}`) throw new Error('Release asset or SHA-256 digest missing');
  return { version, tag: release.tag_name, url: `https://github.com/${repository}/releases/tag/${release.tag_name}`, assetURL: asset.browser_download_url, digest: digest.slice(7), size: asset.size };
}

export function extractPackage(archive, destination, expected) {
  const actual = createHash('sha256').update(archive).digest();
  if (!/^[a-f0-9]{64}$/.test(expected.digest) || !timingSafeEqual(actual, Buffer.from(expected.digest, 'hex')) || archive.length !== expected.size) throw new Error('Release digest mismatch');
  const tar = gunzipSync(archive, { maxOutputLength: 20 * 1024 * 1024 });
  const entries = new Map();
  const text = buffer => buffer.toString('utf8').split('\0')[0];
  for (let offset = 0; offset < tar.length;) {
    if (offset + 512 > tar.length) throw new Error('Truncated archive');
    const header = tar.subarray(offset, offset + 512);
    if (header.every(x => x === 0)) break;
    const name = text(header.subarray(0, 100));
    const sizeText = text(header.subarray(124, 136)).trim();
    const sumText = text(header.subarray(148, 156)).trim();
    if (!/^[0-7]+$/.test(sizeText) || !/^[0-7]+$/.test(sumText) || text(header.subarray(345, 500))) throw new Error('Unsupported archive header');
    const checksum = header.reduce((sum, x, i) => sum + (i >= 148 && i < 156 ? 32 : x), 0);
    if (checksum !== parseInt(sumText, 8)) throw new Error('Archive checksum mismatch');
    const size = parseInt(sizeText, 8);
    const filename = name.startsWith('package/') ? name.slice(8) : '';
    if (![0, 48].includes(header[156]) || !moduleFiles.includes(filename) || entries.has(filename) || size > 4 * 1024 * 1024 || offset + 512 + size > tar.length) throw new Error('Unexpected or unsafe archive entry');
    entries.set(filename, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const file of moduleFiles) if (!entries.has(file)) throw new Error('Incomplete module archive');
  const pkg = JSON.parse(entries.get('package.json').toString());
  const lock = JSON.parse(entries.get('npm-shrinkwrap.json').toString());
  if (pkg.name !== 'opencode-web-login' || pkg.version !== expected.version || lock.name !== pkg.name || lock.version !== pkg.version || !lock.packages) throw new Error('Package identity mismatch');
  for (const [path, item] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!/^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(path) || typeof item.resolved !== 'string' || !item.resolved.startsWith('https://registry.npmjs.org/') || !/^sha512-/.test(item.integrity || '') || item.link || item.hasInstallScript) throw new Error('Unsupported dependency lock entry');
  }
  for (const [file, content] of entries) {
    const target = join(destination, file);
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
    writeFileSync(target, content, { mode: file.startsWith('bin/') ? 0o755 : 0o644, flag: 'wx' });
  }
}
