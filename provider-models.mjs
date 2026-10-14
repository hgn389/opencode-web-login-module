import { lookup as resolveHost } from 'node:dns/promises';
import { isIP } from 'node:net';
import { readResponse } from './http-client.mjs';

export const maximumProviderModels = 2000;
export const providerFailure = (status, message) => Object.assign(new Error(message), { status, publicMessage: message });
export const providerText = (value, maximum) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]|\{(?:env|file):|\$\{/.test(value);
export const validModelID = value => providerText(value, 128) && !/\s|[{}]/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);

export function providerConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw providerFailure(422, 'Thông tin kết nối nhà cung cấp không hợp lệ.');
  let endpoint;
  try { endpoint = new URL(value.baseURL); } catch { throw providerFailure(422, 'Base URL không hợp lệ.'); }
  if (!providerText(value.baseURL, 2048) || !['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || /[{}]/.test(value.baseURL)) throw providerFailure(422, 'Base URL phải là địa chỉ HTTP/HTTPS, không chứa tài khoản, mật khẩu, query, fragment hoặc biến tham chiếu.');
  if (endpoint.protocol === 'http:' && value.allowHttp !== true) throw providerFailure(422, 'Cần xác nhận riêng khi dùng HTTP vì API key có thể được gửi không mã hóa tới nhà cung cấp.');
  if (value.apiKey !== undefined && value.apiKey !== '' && (!providerText(value.apiKey, 4096) || !/^[\x21-\x7e]+$/.test(value.apiKey))) throw providerFailure(422, 'API key không hợp lệ; dùng ký tự ASCII không có khoảng trắng, ký tự điều khiển hoặc biến tham chiếu.');
  if (value.clearKey !== undefined && typeof value.clearKey !== 'boolean' || value.clearKey && value.apiKey) throw providerFailure(422, 'Không thể vừa thay vừa xóa API key.');
  if (value.allowPrivate !== undefined && typeof value.allowPrivate !== 'boolean') throw providerFailure(422, 'Xác nhận kết nối nội bộ không hợp lệ.');
  return { baseURL: endpoint.href.replace(/\/$/, ''), apiKey: value.apiKey || '', clearKey: value.clearKey === true, allowHttp: endpoint.protocol === 'http:', allowPrivate: value.allowPrivate === true };
}

export function modelAddressAllowed(address, allowPrivate = false) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    if (!a || a >= 224 || ['100.100.100.200', '168.63.129.16'].includes(address) || a === 169 && b === 254 || a === 192 && b === 0 && [0, 2].includes(c) || a === 198 && [18, 19].includes(b) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) return false;
    if (a === 10 || a === 127 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127) return allowPrivate;
    return true;
  }
  if (family !== 6 || address.includes('%')) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, tail] = normalized.split('::');
  const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const words = (tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]).map(word => parseInt(word, 16));
  if (words[0] === 0xfd00 && words[1] === 0xec2) return false;
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) return modelAddressAllowed(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`, allowPrivate);
  if (words.slice(0, 7).every(word => word === 0) && words[7] === 1 || (words[0] & 0xfe00) === 0xfc00) return allowPrivate;
  return (words[0] & 0xe000) === 0x2000 && words[0] !== 0x2002 && !(words[0] === 0x2001 && [0, 0xdb8].includes(words[1]));
}

export async function fetchProviderModels(input, { lookup = resolveHost, request = readResponse, timeout = 10000, limit = 8 * 1024 * 1024 } = {}) {
  const connection = providerConnection(input), endpoint = new URL(connection.baseURL + '/models');
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, ''), controller = new AbortController(), signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout);
  let abort;
  try {
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([lookup(hostname, { all: true, verbatim: true }), new Promise((_, reject) => {
      abort = () => reject(providerFailure(504, 'Quét model quá thời gian. Vui lòng thử lại.')); signal.addEventListener('abort', abort, { once: true });
    })]);
    if (!addresses.length || addresses.some(entry => !modelAddressAllowed(entry.address, connection.allowPrivate))) throw providerFailure(422, 'Địa chỉ đích bị chặn. Với router localhost/LAN, hãy xác nhận cho phép kết nối nội bộ; địa chỉ metadata và địa chỉ đặc biệt luôn bị chặn.');
    const pinned = addresses.find(entry => entry.family === 4) || addresses[0];
    const response = await request({ protocol: endpoint.protocol, hostname, port: endpoint.port || undefined, method: 'GET', path: endpoint.pathname, agent: false, autoSelectFamily: false,
      lookup: (_name, options, callback) => options?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
      headers: { accept: 'application/json', 'accept-encoding': 'identity', ...(connection.apiKey ? { authorization: 'Bearer ' + connection.apiKey } : {}) },
    }, { timeout, limit, signal });
    if (response.status >= 300 && response.status < 400) throw providerFailure(422, 'API chuyển hướng. Hãy nhập Base URL cuối cùng; module không chuyển tiếp API key qua redirect.');
    if ([401, 403].includes(response.status)) throw providerFailure(422, 'API từ chối truy cập danh sách model. Kiểm tra API key và quyền truy cập của nhà cung cấp.');
    if (response.status !== 200) throw providerFailure(502, response.status === 404 ? 'Không tìm thấy API /models. Kiểm tra Base URL, bao gồm đường dẫn /v1 hoặc /api/v1 nếu dịch vụ yêu cầu.' : 'Nhà cung cấp không trả về danh sách model. Vui lòng thử lại.');
    if (!/^application\/(?:json|[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers['content-type'] || '')) throw providerFailure(502, 'API không trả về JSON. Kiểm tra Base URL của nhà cung cấp.');
    let data;
    try { data = JSON.parse(response.body); } catch { throw providerFailure(502, 'Danh sách model không phải JSON hợp lệ.'); }
    if (!Array.isArray(data?.data) || data.data.length > 10000) throw providerFailure(502, 'Danh sách model không đúng định dạng OpenAI-compatible hoặc quá lớn.');
    const models = [], seen = new Set(); let skipped = 0;
    for (const model of data.data) {
      if (!model || !validModelID(model.id) || seen.has(model.id) || connection.apiKey && model.id.includes(connection.apiKey)) { skipped++; continue; }
      seen.add(model.id); models.push({ id: model.id, name: providerText(model.name, 128) && !(connection.apiKey && model.name.includes(connection.apiKey)) ? model.name : model.id });
      if (models.length > maximumProviderModels) throw providerFailure(422, `Danh sách có hơn ${maximumProviderModels} model. Hãy giới hạn danh sách tại router hoặc khai báo model thủ công.`);
    }
    if (!models.length) throw providerFailure(422, 'API chưa trả về model hợp lệ. Bạn vẫn có thể nhập Model ID thủ công.');
    return { status: 200, models, skipped };
  } catch (error) {
    if (error.publicMessage) throw error;
    throw providerFailure(signal.aborted ? 504 : 502, signal.aborted ? 'Quét model quá thời gian. Vui lòng thử lại.' : 'Không kết nối được API để quét model. Kiểm tra địa chỉ, chứng chỉ HTTPS và kết nối từ máy chủ.');
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); }
}
