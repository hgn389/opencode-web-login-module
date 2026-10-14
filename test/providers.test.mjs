import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { once } from 'node:events';
import http from 'node:http';
import { createAdminController, providerFileOperation, validateCustomProvider } from '../admin-service.mjs';
import { createLoginServer } from '../index.mjs';
import { SecurityStore } from '../security.mjs';

const apiKey = 'isolated-custom-provider-api-key';
const password = 'isolated-provider-admin-password';
const provider = () => ({ id: 'acme', name: 'Acme API', baseURL: 'https://api.example.com/v1', apiKey, models: [{ id: 'coder', name: 'Coder' }] });
const sleep = ms => new Promise(done => setTimeout(done, ms));
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'custom-provider-test-'));
  const context = { directory: join(directory, 'config'), backupDirectory: join(directory, 'backups') };
  mkdirSync(context.directory, { mode: 0o700 });
  return { directory, context, file: join(context.directory, 'opencode.jsonc'), close: () => rmSync(directory, { recursive: true, force: true }) };
};

test('custom provider validation restricts IDs, URLs, interpolation, secrets and model definitions', () => {
  assert.equal(validateCustomProvider({ ...provider(), command: 'arbitrary', file: '/etc/passwd', package: 'arbitrary' }).id, 'acme');
  assert(!Object.hasOwn(validateCustomProvider(provider()), 'command'));
  for (const fields of [{ id: '__proto__' }, { id: 'constructor' }, { id: 'UPPERCASE' }, { id: '../file' }, { name: '{file:/etc/passwd}' }, { baseURL: 'file:///etc/passwd' }, { baseURL: 'https://user:pass@api.example.com' }, { baseURL: 'https://api.example.com/?key=secret' }, { baseURL: 'http://127.0.0.1:8000/v1' }, { apiKey: 'key\nvalue' }, { apiKey: '{env:HOME}' }, { clearKey: true }, { models: [] }, { models: [{ id: 'x' }, { id: 'x' }] }, { models: [{ id: '${HOME}' }] }]) assert.throws(() => validateCustomProvider({ ...provider(), ...fields }));
  assert.equal(validateCustomProvider({ ...provider(), baseURL: 'http://127.0.0.1:8000/v1', allowHttp: true }).allowHttp, true);
  assert.throws(() => validateCustomProvider({ ...provider(), apiKey: 'khóa-không-hợp-lệ' }));
  assert.throws(() => validateCustomProvider({ ...provider(), apiKey: 'key with spaces' }));
});

test('JSONC edits preserve other settings, hide stored keys, use private files and Git backups, and restore exactly', () => {
  const f = fixture();
  const original = `{
  // Preserve this comment and all unrelated settings.
  "shell": "/bin/bash",
  "providers": {
    "other": {"package":"different-package","settings":{"apiKey":"other-isolated-key"}},
    "acme": {"package":"@opencode/ai/providers/openai-compatible","env":["ACME_KEY"],"headers":{"Authorization":"isolated-header-key"},"settings":{"baseURL":"https://old.example/v1","apiKey":"old-isolated-key","timeout":123},"models":{"coder":{"limit":{"context":4096}}}}
  },
}
`;
  writeFileSync(f.file, original, { mode: 0o600 });
  try {
    const before = providerFileOperation(f.context, { action: 'read' });
    assert(!JSON.stringify(before).includes('isolated-key')); assert(!JSON.stringify(before).includes('isolated-header-key')); assert.equal(before.providers.find(p => p.id === 'other').editable, false);
    const saved = providerFileOperation(f.context, { action: 'save', revision: before.revision, provider: provider() });
    const text = readFileSync(f.file, 'utf8'), data = parse(text, [], { allowTrailingComma: true });
    assert(text.includes('// Preserve this comment')); assert.equal(data.shell, '/bin/bash'); assert.equal(data.providers.other.settings.apiKey, 'other-isolated-key');
    assert.equal(data.providers.acme.settings.timeout, 123); assert.equal(data.providers.acme.models.coder.limit.context, 4096);
    assert(data.providers.acme.settings.apiKey.startsWith('{file:')); assert(!text.includes(apiKey));
    const keyFile = data.providers.acme.settings.apiKey.slice(6, -1);
    assert.equal(readFileSync(keyFile, 'utf8'), apiKey); assert.equal(lstatSync(keyFile).mode & 0o777, 0o600);
    assert.equal(lstatSync(join(f.context.directory, '.web-login-secrets')).mode & 0o777, 0o700);
    assert(lstatSync(join(f.context.backupDirectory, '.git')).isDirectory());
    const after = providerFileOperation(f.context, { action: 'read' }); assert(!JSON.stringify(after).includes(apiKey)); assert(after.providers.find(p => p.id === 'acme').hasKey);
    assert.throws(() => providerFileOperation(f.context, { action: 'save', revision: before.revision, provider: provider() }), /thay đổi/);
    assert.equal(providerFileOperation(f.context, { action: 'restore', backup: saved.backup }).status, 200);
    assert.equal(readFileSync(f.file, 'utf8'), original); assert.equal(lstatSync(keyFile, { throwIfNoEntry: false }), undefined);
  } finally { f.close(); }
});

test('provider edits reject unsafe paths, duplicate JSONC keys, endpoint changes with retained keys and conflicting rollback', () => {
  const f = fixture();
  try {
    writeFileSync(f.file, '{"providers":{},"providers":{}}', { mode: 0o600 }); assert.throws(() => providerFileOperation(f.context, { action: 'read' }), /trùng/);
    writeFileSync(f.file, '{}');
    let status = providerFileOperation(f.context, { action: 'read' });
    const saved = providerFileOperation(f.context, { action: 'save', revision: status.revision, provider: provider() });
    status = providerFileOperation(f.context, { action: 'read' });
    assert.throws(() => providerFileOperation(f.context, { action: 'save', revision: status.revision, provider: { ...provider(), apiKey: '', baseURL: 'https://another.example/v1' } }), /nhập lại/);
    writeFileSync(f.file, readFileSync(f.file, 'utf8') + '\n// External edit\n');
    assert.throws(() => providerFileOperation(f.context, { action: 'restore', backup: saved.backup }), /không ghi đè/);
    const outside = join(f.directory, 'outside.json'); writeFileSync(outside, '{}', { mode: 0o600 }); rmSync(f.file); symlinkSync(outside, f.file);
    assert.throws(() => providerFileOperation(f.context, { action: 'read' }), /không an toàn/); assert.equal(readFileSync(outside, 'utf8'), '{}');
  } finally { f.close(); }
});

test('provider removal and API key clearing preserve unrelated providers and protect a configured default', () => {
  const f = fixture();
  try {
    const read = () => providerFileOperation(f.context, { action: 'read' });
    providerFileOperation(f.context, { action: 'save', revision: read().revision, provider: provider() });
    const file = join(f.context.directory, 'opencode.json');
    providerFileOperation(f.context, { action: 'save', revision: read().revision, provider: { ...provider(), apiKey: '', clearKey: true } });
    assert.equal(read().providers[0].hasKey, false);
    const data = parse(readFileSync(file, 'utf8')); data.model = 'acme/coder'; writeFileSync(file, JSON.stringify(data));
    assert.throws(() => providerFileOperation(f.context, { action: 'remove', revision: read().revision, id: 'acme' }), /mặc định/);
    delete data.model; writeFileSync(file, JSON.stringify(data));
    providerFileOperation(f.context, { action: 'remove', revision: read().revision, id: 'acme' }); assert.equal(read().providers.length, 0);
  } finally { f.close(); }
});

test('replacing an endpoint and key uses an immutable new secret file and rolls back without changing the old key', () => {
  const f = fixture();
  try {
    const read = () => providerFileOperation(f.context, { action: 'read' });
    providerFileOperation(f.context, { action: 'save', revision: read().revision, provider: provider() });
    const file = join(f.context.directory, 'opencode.json'), before = readFileSync(file, 'utf8');
    const previousKey = parse(before).providers.acme.settings.apiKey.slice(6, -1);
    const saved = providerFileOperation(f.context, { action: 'save', revision: read().revision, provider: { ...provider(), apiKey: 'replacement-isolated-key', baseURL: 'https://replacement.example/v1' } });
    const nextKey = parse(readFileSync(file, 'utf8')).providers.acme.settings.apiKey.slice(6, -1);
    assert.notEqual(previousKey, nextKey); assert.equal(readFileSync(previousKey, 'utf8'), apiKey); assert.equal(readFileSync(nextKey, 'utf8'), 'replacement-isolated-key');
    assert.equal(readFileSync(join(f.context.backupDirectory, saved.backup, 'previous-key'), 'utf8'), apiKey);
    providerFileOperation(f.context, { action: 'restore', backup: saved.backup });
    assert.equal(readFileSync(file, 'utf8'), before); assert.equal(readFileSync(previousKey, 'utf8'), apiKey); assert.equal(lstatSync(nextKey, { throwIfNoEntry: false }), undefined);
  } finally { f.close(); }
});

test('provider jobs require password and acknowledgement, serialize changes and roll back a failed reload', async () => {
  for (const fail of [false, true]) {
    const f = fixture(); let reloads = 0;
    const code = join(f.directory, 'code'); mkdirSync(code); writeFileSync(join(code, 'package.json'), '{"version":"1.1.2-beta"}');
    const stateDir = join(f.directory, 'state');
    const controller = createAdminController({ installDirectory: code }, { stateDir, password: () => password, providerContext: async () => f.context, providerWorker: async (context, request) => providerFileOperation(context, request), providerExists: async () => false,
      providerReload: async id => { reloads++; if (fail && id) throw new Error('Injected reload failure'); },
    });
    try {
      const status = await controller.call({ operation: 'providers-status' });
      const fields = { operation: 'provider-save', password, acknowledge: true, revision: status.providers.revision, provider: provider() };
      assert.equal((await controller.call({ ...fields, password: 'wrong' })).status, 401);
      assert.equal((await controller.call({ ...fields, acknowledge: false })).status, 422);
      assert.equal((await controller.call(fields)).status, 202);
      assert.equal((await controller.call(fields)).status, 409);
      assert.equal((await controller.call({ operation: 'preferences', password, automatic: true, channel: 'stable' })).status, 409);
      for (let attempt = 0; attempt < 50; attempt++) { if ((await controller.call({ operation: 'status' })).job.phase !== 'running') break; await sleep(20); }
      const result = await controller.call({ operation: 'providers-status' }); assert.equal(result.job.phase, fail ? 'failed' : 'succeeded');
      assert.equal(result.providers.providers.length, fail ? 0 : 1); assert.equal(reloads, fail ? 2 : 1);
      assert(!JSON.stringify(result).includes(apiKey)); assert(!readFileSync(join(stateDir, 'job.json'), 'utf8').includes(apiKey));
    } finally { f.close(); }
  }
});

test('provider API enforces authentication, origin, CSRF and field restrictions; native config reads redact secrets and encoded aliases', async () => {
  const f = fixture(), socket = join(f.directory, 'admin.sock'); let forwarded;
  const helper = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk); forwarded = JSON.parse(Buffer.concat(chunks));
    const result = forwarded.operation === 'providers-status' ? { status: 200, available: true, providers: { supported: true, revision: 'a'.repeat(64), providers: [] } } : forwarded.operation === 'provider-models' ? forwarded.password === password ? { status: 200, models: [{ id: 'coder', name: 'Coder' }], skipped: 0 } : { status: 401, message: 'Incorrect password' } : { status: 202, message: 'Fixture accepted' };
    res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  const backend = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json', etag: 'private' }); res.end(JSON.stringify({ name: 'Fixture', settings: { apiKey }, headers: { Authorization: 'isolated-header-value' }, models: [{ id: 'coder', enabled: true }] })); });
  helper.listen(socket); backend.listen(0, '127.0.0.1'); await Promise.all([once(helper, 'listening'), once(backend, 'listening')]);
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const origin = `http://127.0.0.1:${port}`, database = join(f.directory, 'gateway.sqlite'), gateway = createLoginServer({ port, backendPort: backend.address().port, statePath: database, adminSocket: socket });
  const store = new SecurityStore(database), cookie = `opencode_login_${port}=${store.createSession('isolated-native-token', origin)}`;
  await gateway.listen();
  const request = (path, options = {}) => fetch(origin + path, { ...options, headers: { cookie, 'x-opencode-login': '1', ...options.headers } });
  try {
    assert.equal((await fetch(origin + '/web-login/api/providers-status')).status, 401);
    const status = await (await request('/web-login/api/providers-status')).json();
    const options = { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-web-login-csrf': status.csrf }, body: JSON.stringify({ password, acknowledge: true, revision: status.providers.revision, provider: provider(), file: '/etc/passwd', command: 'arbitrary' }) };
    assert.equal((await request('/web-login/api/provider-save', { ...options, headers: { ...options.headers, origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await request('/web-login/api/provider-save', { ...options, headers: { ...options.headers, 'x-web-login-csrf': 'forged' } })).status, 403);
    assert.equal((await request('/web-login/api/provider-save', options)).status, 202); assert.deepEqual(Object.keys(forwarded).sort(), ['acknowledge', 'operation', 'password', 'provider', 'revision']);
    const scan = { ...options, body: JSON.stringify({ password, revision: status.providers.revision, provider: { baseURL: provider().baseURL, apiKey }, file: '/etc/passwd', operation: 'password' }) };
    assert.equal((await fetch(origin + '/web-login/api/provider-models')).status, 401);
    assert.equal((await request('/web-login/api/provider-models', { ...scan, headers: { ...scan.headers, origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await request('/web-login/api/provider-models', { ...scan, headers: { ...scan.headers, 'x-web-login-csrf': 'forged' } })).status, 403);
    assert.equal((await request('/web-login/api/provider-models', { ...scan, body: JSON.stringify({ password: 'wrong', revision: status.providers.revision, provider: { baseURL: provider().baseURL } }) })).status, 401);
    const failures = store.state('127.0.0.1').failures; assert.equal(failures, 1);
    assert.equal((await request('/web-login/api/provider-models', scan)).status, 200);
    assert.equal(store.state('127.0.0.1').failures, failures);
    assert.deepEqual(Object.keys(forwarded).sort(), ['operation', 'password', 'provider', 'revision']);
    assert.equal(forwarded.operation, 'provider-models');
    const large = { ...provider(), models: Array.from({ length: 500 }, (_, i) => ({ id: 'model-' + i + '-'.repeat(100), name: 'Name'.repeat(30) })) };
    assert.equal((await request('/web-login/api/provider-save', { ...options, body: JSON.stringify({ password, acknowledge: true, revision: status.providers.revision, provider: large }) })).status, 202);
    assert.equal(forwarded.provider.models.length, 500);
    for (const path of ['/api/provider/acme', '/api/%70rovider/acme', '/api/config', '/api/model', '/provider']) {
      const response = await request(path); const text = await response.text(); assert.equal(response.status, 200); assert(!text.includes(apiKey)); assert(!text.includes('isolated-header-value')); assert(text.includes('coder')); assert(!response.headers.has('etag'));
    }
  } finally { store.close(); await gateway.close(); helper.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(done => helper.close(done)), new Promise(done => backend.close(done))]); f.close(); }
});
