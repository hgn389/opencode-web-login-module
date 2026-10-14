import { readResponse } from './http-client.mjs';

export async function adminCall(socketPath, operation, fields = {}, { signal, timeout = 20000 } = {}) {
  const body = JSON.stringify({ ...fields, operation });
  const response = await readResponse({ socketPath, path: '/', method: 'POST', headers: {
    'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
  } }, { signal, timeout, body, limit: ['providers-status', 'provider-models'].includes(operation) ? 2 * 1024 * 1024 : 65536 });
  let data;
  try { data = JSON.parse(response.body); }
  catch { throw new Error('Invalid admin response'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.status !== undefined && data.status !== response.status) throw new Error('Invalid admin response');
  return { ...data, status: response.status };
}
