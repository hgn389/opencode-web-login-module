import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchProviderModels, modelAddressAllowed, maximumProviderModels } from '../provider-models.mjs';
import { discoverProviderModels, providerFileOperation, createAdminController, validateCustomProvider } from '../admin-service.mjs';

const key = 'isolated-model-discovery-key';
const password = 'isolated-model-discovery-password';
const response = data => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ data }) });
const input = { baseURL: 'https://api.example.com/v1', apiKey: key };
const publicDNS = async () => [{ address: '93.184.216.34', family: 4 }];

test('model discovery pins DNS, preserves provider path, filters IDs and never reflects credentials or error bodies', async () => {
  let lookups = 0, requests = 0;
  const result = await fetchProviderModels(input, {
    lookup: async () => { lookups++; return publicDNS(); },
    request: async options => {
      requests++; assert.equal(options.protocol, 'https:'); assert.equal(options.path, '/v1/models'); assert.equal(options.headers.authorization, 'Bearer ' + key); assert.equal(options.agent, false);
      options.lookup('api.example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); });
      options.lookup('api.example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]); });
      return response([{ id: 'router/coder', name: 'Coder' }, { id: 'router/coder' }, { id: '__proto__' }, { id: 'bad id' }, { id: '{env:HOME}' }, { id: key }, { id: 'safe', name: key }, { id: 'long', name: 'x'.repeat(129) }]);
    },
  });
  assert.equal(lookups, 1); assert.equal(requests, 1); assert.equal(result.skipped, 5);
  assert.deepEqual(result.models, [{ id: 'router/coder', name: 'Coder' }, { id: 'safe', name: 'safe' }, { id: 'long', name: 'long' }]);
  assert(!JSON.stringify(result).includes(key));
  for (const [status, expected] of [[302, 422], [401, 422], [403, 422], [404, 502], [500, 502]]) {
    let count = 0;
    await assert.rejects(fetchProviderModels(input, { lookup: publicDNS, request: async () => { count++; return { status, headers: { location: 'http://169.254.169.254/models' }, body: key }; } }), error => error.status === expected && !error.message.includes(key));
    assert.equal(count, 1);
  }
});

test('discovery blocks metadata, special IPs and DNS rebinding; LAN requires separate permission for IPv4 and IPv6', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '100.64.0.1', '::1', 'fd12::1', '::ffff:127.0.0.1']) {
    assert.equal(modelAddressAllowed(address), false, address); assert.equal(modelAddressAllowed(address, true), true, address);
  }
  for (const address of ['0.0.0.0', '169.254.169.254', '169.254.170.2', '100.100.100.200', '168.63.129.16', '192.0.0.192', '224.0.0.1', '255.255.255.255', '::', 'fe80::1', 'ff02::1', 'fd00:ec2::254', '::ffff:169.254.169.254', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1']) assert.equal(modelAddressAllowed(address, true), false, address);
  for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.equal(modelAddressAllowed(address), true);
  let calls = 0;
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [...await publicDNS(), { address: '169.254.169.254', family: 4 }]]) await assert.rejects(fetchProviderModels(input, { lookup: async () => addresses, request: async () => { calls++; return response([{ id: 'coder' }]); } }), error => error.status === 422);
  assert.equal(calls, 0);
  await assert.rejects(fetchProviderModels({ ...input, baseURL: 'http://127.0.0.1/v1', allowPrivate: true }, { request: async () => { calls++; } }), error => error.status === 422);
  assert.equal(calls, 0);
});

test('discovery bounds DNS time, response size, malformed catalogs and the full HTTP exchange', async () => {
  await assert.rejects(fetchProviderModels(input, { timeout: 25, lookup: () => new Promise(() => {}), request: async () => assert.fail('Unexpected HTTP request') }), error => error.status === 504);
  for (const data of [{}, { data: [] }, { data: [{ id: 'bad id' }] }, { data: Array.from({ length: maximumProviderModels + 1 }, (_, i) => ({ id: 'model-' + i })) }]) {
    await assert.rejects(fetchProviderModels(input, { lookup: publicDNS, request: async () => ({ ...response([]), body: JSON.stringify(data) }) }), error => [422, 502].includes(error.status));
  }
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer ' + key); assert.equal(req.url, '/api/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    if (mode === 'size') res.end(JSON.stringify({ data: [{ id: 'x'.repeat(500) }] }));
    else { res.write('{'); const timer = setInterval(() => res.write(' '), 5); res.on('close', () => clearInterval(timer)); }
  });
  let mode = 'size'; server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = { baseURL: `http://127.0.0.1:${server.address().port}/api/v1`, apiKey: key, allowHttp: true, allowPrivate: true };
  try {
    await assert.rejects(fetchProviderModels(local, { limit: 100 }), error => error.status === 502);
    mode = 'drip'; const start = Date.now();
    await assert.rejects(fetchProviderModels(local, { timeout: 40 }), error => [502, 504].includes(error.status));
    assert(Date.now() - start < 1000);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('saved-key discovery is read-only, binds the credential to its endpoint and revision, and rejects external file references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-scan-test-'));
  const context = { directory: join(root, 'config'), backupDirectory: join(root, 'snapshots') }; mkdirSync(context.directory, { mode: 0o700 });
  const read = () => providerFileOperation(context, { action: 'read' });
  const provider = { ...input, id: 'router', name: 'Router', models: [{ id: 'coder' }] };
  try {
    providerFileOperation(context, { action: 'save', revision: read().revision, provider });
    const file = join(context.directory, 'opencode.json'), before = readFileSync(file), snapshots = readdirSync(context.backupDirectory);
    const request = { revision: read().revision, provider: { id: 'router', baseURL: input.baseURL } };
    const result = await discoverProviderModels(context, request, { lookup: publicDNS, request: async options => { assert.equal(options.headers.authorization, 'Bearer ' + key); return response([{ id: 'coder' }]); } });
    assert.equal(result.status, 200); assert.deepEqual(readFileSync(file), before); assert.deepEqual(readdirSync(context.backupDirectory), snapshots); assert(!JSON.stringify(result).includes(key));
    let calls = 0; const connection = { lookup: publicDNS, request: async options => { calls++; assert.equal(options.headers.authorization, undefined); return response([{ id: 'anonymous' }]); } };
    await assert.rejects(discoverProviderModels(context, { ...request, provider: { ...request.provider, baseURL: 'https://changed.example/v1' } }, connection), error => error.status === 422);
    await assert.rejects(discoverProviderModels(context, { ...request, revision: '0'.repeat(64) }, connection), error => error.status === 409); assert.equal(calls, 0);
    assert.equal((await discoverProviderModels(context, { ...request, provider: { ...request.provider, clearKey: true, baseURL: 'https://changed.example/v1' } }, connection)).status, 200);
    await assert.rejects(discoverProviderModels(context, request, { lookup: publicDNS, request: async () => { writeFileSync(file, before.toString() + ' '); return response([{ id: 'coder' }]); } }), error => error.status === 409);
    const data = JSON.parse(before); data.providers.router.settings.apiKey = '{file:/etc/passwd}'; writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
    await assert.rejects(discoverProviderModels(context, { ...request, revision: read().revision }, connection), error => error.status === 422); assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('model discovery requires password, limits concurrent scans and retries, and supports catalogs larger than twenty models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-scan-admin-')); let calls = 0, release;
  const scan = new Promise(resolve => { release = resolve; });
  const controller = createAdminController({ installDirectory: new URL('..', import.meta.url).pathname }, { stateDir: root, password: () => password, providerContext: async () => ({}), providerWorker: async () => { calls++; if (calls === 1) await scan; return response([{ id: 'coder' }]); } });
  const fields = { operation: 'provider-models', password, revision: 'a'.repeat(64), provider: input };
  try {
    assert.equal((await controller.call({ ...fields, password: 'wrong' })).status, 401); assert.equal(calls, 0);
    const first = controller.call(fields); await new Promise(resolve => setImmediate(resolve));
    assert.equal((await controller.call(fields)).status, 409); release(); assert.equal((await first).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await controller.call(fields)).status, 200);
    assert.equal((await controller.call(fields)).status, 429); assert.equal(calls, 6);
    const models = Array.from({ length: maximumProviderModels }, (_, i) => ({ id: 'model-' + i }));
    assert.equal(validateCustomProvider({ ...input, id: 'router', name: 'Router', models }).models.length, maximumProviderModels);
    assert.throws(() => validateCustomProvider({ ...input, id: 'router', name: 'Router', models: [...models, { id: 'too-many' }] }));
  } finally { release(); rmSync(root, { recursive: true, force: true }); }
});

test('large selections persist completely and cannot remove the configured default model', () => {
  const root = mkdtempSync(join(tmpdir(), 'model-selection-test-'));
  const context = { directory: join(root, 'config'), backupDirectory: join(root, 'snapshots') }; mkdirSync(context.directory, { mode: 0o700 });
  const file = join(context.directory, 'opencode.json'), models = Array.from({ length: 500 }, (_, i) => ({ id: 'router/model-' + i }));
  const read = () => providerFileOperation(context, { action: 'read' });
  try {
    writeFileSync(file, JSON.stringify({ model: 'router/router/model-0' }), { mode: 0o600 });
    const provider = { ...input, id: 'router', name: 'Router', models };
    providerFileOperation(context, { action: 'save', revision: read().revision, provider });
    assert.equal(read().providers[0].models.length, 500); assert.equal(read().providers[0].editable, true);
    const before = readFileSync(file);
    assert.throws(() => providerFileOperation(context, { action: 'save', revision: read().revision, provider: { ...provider, models: models.slice(1) } }), error => error.status === 422);
    assert.deepEqual(readFileSync(file), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
