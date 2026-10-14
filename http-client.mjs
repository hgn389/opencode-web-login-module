import http from 'node:http';
import https from 'node:https';

// Bound the complete exchange, including responses that arrive one byte at a time.
export function readResponse(options, { timeout = 10000, limit = 65536, signal, body } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const request = (options.protocol === 'https:' ? https : http).request({ ...options, signal }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) response.destroy(new Error('Backend response too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('Backend response interrupted')));
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
      response.once('close', () => clearTimeout(timer));
    });
    timer = setTimeout(() => request.destroy(new Error('Backend timeout')), timeout);
    timer.unref();
    request.once('error', reject);
    request.once('close', () => clearTimeout(timer));
    request.end(body);
  });
}

export async function protectedBackend(config, timeout = 3000) {
  const response = await readResponse({ hostname: config.backendHost, port: config.backendPort, path: '/api/info' }, { timeout });
  if (response.status !== 401) return false;
  if ((response.headers['content-type'] || '').includes('application/json')) return true;
  if (!/^Basic\s/i.test(response.headers['www-authenticate'] || '')) return false;
  const health = await readResponse({ hostname: config.backendHost, port: config.backendPort, path: '/global/health' }, { timeout });
  return health.status === 401 && /^Basic\s/i.test(health.headers['www-authenticate'] || '');
}

export async function backendInfo(config, authorization, { probe = readResponse, ...options } = {}) {
  const request = path => probe({ hostname: config.backendHost, port: config.backendPort, path, headers: { authorization } }, options);
  let response = await request('/api/info');
  if (response.status !== 200) return { status: response.status };
  let data;
  try { data = JSON.parse(response.body); } catch { /* v1 serves its HTML fallback here. */ }
  if (typeof data?.version === 'string' && data.version.length <= 128 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(data.version)) return { status: 200, version: data.version, major: 2 };
  response = await request('/global/health');
  if (response.status !== 200) return { status: response.status };
  try { data = JSON.parse(response.body); } catch { throw new Error('Invalid OpenCode health response'); }
  if (data.healthy !== true || !/^1\.\d+\.\d+$/.test(data.version)) throw new Error('Unsupported OpenCode backend');
  return { status: 200, version: data.version, major: 1 };
}
