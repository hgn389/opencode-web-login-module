import http from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual, createHmac, createHash } from 'node:crypto';
import { SecurityStore } from './security.mjs';
import { readResponse } from './http-client.mjs';
import { adminCall } from './admin-client.mjs';

import { normalizeConfig } from './config.mjs';

export { configFromEnv, normalizeConfig } from './config.mjs';

export function createLoginServer(options = {}) {
  const config = normalizeConfig(options);
  const { host: hostname, port, backendPort, backendHost, authority, localOrigin: lanOrigin } = config;
  const allowedOrigins = new Set([lanOrigin, ...config.publicOrigins]);
  if (['0.0.0.0', '::'].includes(hostname)) {
    for (const item of Object.values(networkInterfaces()).flat()) {
      const address = item.address;
      if (address.includes('%') || (hostname === '0.0.0.0' && net.isIP(address) !== 4)) continue;
      allowedOrigins.add(new URL(`http://${net.isIP(address) === 6 ? `[${address}]` : address}:${port}`).origin);
    }
  }
  const trustedProxies = new net.BlockList();
  for (const address of config.trustedProxies) {
    const [ip, bits] = address.split('/');
    const version = net.isIP(ip);
    if (!version) throw new Error('Invalid trusted proxy address');
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (bits !== undefined) trustedProxies.addSubnet(ip, Number(bits), family);
    else trustedProxies.addAddress(ip, family);
  }
  const template = readFileSync(new URL('./login.html', import.meta.url), 'utf8');
  const { version: moduleVersion } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
  const loginScript = readFileSync(new URL('./login-client.js', import.meta.url), 'utf8');
  const adminPage = readFileSync(new URL('./admin.html', import.meta.url), 'utf8').replaceAll('{{VERSION}}', escapeHtml(moduleVersion));
  const adminAssets = new Map(['admin-ui.js', 'settings-hook.js', 'settings-hook.css'].map(file => [file, readFileSync(new URL(file, import.meta.url), 'utf8')]));
  const state = new SecurityStore(config.statePath);
  const shutdown = new AbortController();
  const csrfKey = state.csrfKey;
  const headers = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cross-origin-resource-policy': 'same-origin',
    'x-robots-tag': 'noindex, nofollow',
  };

  function normalizeIP(ip) {
    if (ip?.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) return ip.slice(7);
    const version = net.isIP(ip || '');
    if (version === 4) return ip;
    if (version === 6) return new URL(`http://[${ip}]`).hostname.slice(1, -1);
    throw new Error('Invalid client IP');
  }

  function trusted(ip) { return trustedProxies.check(ip, net.isIP(ip) === 4 ? 'ipv4' : 'ipv6'); }

  function context(req) {
    const peer = normalizeIP(req.socket.remoteAddress);
    const isProxy = trusted(peer);
    let ip = peer;
    if (isProxy && req.headers['x-forwarded-for']) {
      const chain = req.headers['x-forwarded-for'].split(',').map((value) => normalizeIP(value.trim()));
      if (chain.length > 10) throw new Error('Proxy chain too long');
      chain.push(peer);
      while (chain.length > 1 && trusted(chain.at(-1))) chain.pop();
      ip = chain.at(-1);
    }
    const secure = req.socket.encrypted === true || (isProxy && req.headers['x-forwarded-proto'] === 'https');
    const hostURL = new URL(`${secure ? 'https' : 'http'}://${req.headers.host}`);
    if (hostURL.username || hostURL.password || hostURL.pathname !== '/' || hostURL.search || hostURL.hash) throw new Error('Invalid host');
    const origin = hostURL.origin;
    const httpsOrigin = new URL(`https://${req.headers.host}`).origin;
    if (!allowedOrigins.has(origin)) {
      if (!secure && allowedOrigins.has(httpsOrigin)) return { redirect: httpsOrigin, ip };
      throw new Error('Unexpected host or scheme');
    }
    if (secure && isProxy && !req.headers['x-forwarded-for']) throw new Error('HTTPS proxy must supply client IP');
    return {
      ip, origin, secure,
      cookie: secure ? '__Host-opencode_login' : `opencode_login_${port}`,
      csrfCookie: secure ? '__Host-opencode_csrf' : `opencode_csrf_${port}`,
    };
  }

  function responseHeaders(ctx) {
    return { ...headers, ...(ctx.secure ? { 'strict-transport-security': 'max-age=31536000' } : {}), ...(shutdown.signal.aborted ? { connection: 'close' } : {}) };
  }
  function escapeHtml(value) { return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function cookies(req) {
    const values = Object.create(null);
    for (const part of (req.headers.cookie || '').split(';')) {
      const at = part.indexOf('=');
      if (at > 0) {
        const name = part.slice(0, at).trim();
        if (!Object.hasOwn(values, name)) values[name] = part.slice(at + 1).trim();
      }
    }
    return values;
  }
  function cookie(ctx, name, value, age, path = '/') {
    return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${age}${ctx.secure ? '; Secure' : ''}`;
  }
  function safeNext(value, ctx) {
    if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
    const url = new URL(value, ctx.origin);
    return url.origin === ctx.origin && !['/login', '/logout'].includes(url.pathname) ? url.pathname + url.search : '/';
  }
  function csrfSignature(value, ctx) { return createHmac('sha256', csrfKey).update(value + '\0' + ctx.ip + '\0' + ctx.origin).digest('hex'); }
  function newCSRF(ctx) {
    const value = `${Date.now()}.${randomBytes(24).toString('hex')}`;
    return value + '.' + csrfSignature(value, ctx);
  }
  function validCSRF(token, expected, ctx) {
    if (!/^[0-9]{13}\.[a-f0-9]{48}\.[a-f0-9]{64}$/.test(token) || token !== expected) return false;
    const parts = token.split('.');
    const age = Date.now() - Number(parts[0]);
    return age >= 0 && age <= 600000 && timingSafeEqual(Buffer.from(parts[2]), Buffer.from(csrfSignature(parts.slice(0, 2).join('.'), ctx)));
  }
  function formCSRF(req, ctx) {
    const previous = cookies(req)[ctx.csrfCookie];
    const remaining = Number(previous?.split('.')[0]) + 600000 - Date.now();
    return validCSRF(previous, previous, ctx) && remaining > 15000 ? previous : newCSRF(ctx);
  }
  function csrfCookies(ctx, token) {
    const age = Math.max(0, Math.ceil((Number(token.split('.')[0]) + 600000 - Date.now()) / 1000));
    return [cookie(ctx, ctx.csrfCookie, token, age, ctx.secure ? '/' : '/login'),
      ...(!ctx.secure ? [cookie(ctx, ctx.csrfCookie, '', 0)] : [])];
  }
  function page(req, res, ctx, status = 200, message = '', next = '/') {
    const locked = state.state(ctx.ip).blocked;
    const csrf = formCSRF(req, ctx);
    let captcha = '';
    if (!locked && state.state(ctx.ip).failures >= 5) {
      const refresh = new URL(req.url, ctx.origin).searchParams.get('refresh') === '1';
      if (refresh || !state.image(csrf, ctx.ip)) state.challenge(csrf, ctx.ip);
      captcha = '<div class="captcha"><label for="captcha">Mã xác minh</label><img src="/login/captcha" width="270" height="86" alt="Mã xác minh gồm 6 ký tự trong ảnh"><input id="captcha" name="captcha" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" minlength="6" maxlength="6" required aria-describedby="captcha-help"><small id="captcha-help">Nhập 6 ký tự trong ảnh. <a href="/login?refresh=1&amp;next=' + encodeURIComponent(safeNext(next, ctx)) + '">Đổi mã</a></small></div>';
    }
    const body = template.replace('{{MESSAGE}}', escapeHtml(message)).replace('{{CSRF}}', csrf)
      .replace('{{NEXT}}', escapeHtml(safeNext(next, ctx))).replace('{{CAPTCHA}}', captcha)
      .replace('{{FORM_STATE}}', locked ? 'disabled' : '').replaceAll('{{VERSION}}', escapeHtml(moduleVersion));
    res.writeHead(status, {
      ...responseHeaders(ctx),
      'content-security-policy': "default-src 'none'; img-src 'self'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'content-type': 'text/html; charset=utf-8',
      'set-cookie': csrfCookies(ctx, csrf),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }
  function redirect(res, ctx, location, extra = {}) {
    res.writeHead(303, { ...responseHeaders(ctx), location, ...extra });
    res.end();
  }
  function reject(res, ctx, status, message) {
    res.writeHead(status, { ...responseHeaders(ctx), 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message }));
  }
  function backend(path, method = 'GET', headers = {}) {
    return readResponse({ hostname: backendHost, port: backendPort, path, method, headers: { host: authority, ...headers } }, { signal: shutdown.signal });
  }
  async function changingPassword() {
    if (!config.adminSocket) return false;
    const result = await adminCall(config.adminSocket, 'status', {}, { signal: shutdown.signal });
    if (result.status !== 200) throw new Error('Administration unavailable');
    return result.job?.type === 'password' && ['starting', 'running'].includes(result.job.phase);
  }

  async function login(req, res, ctx) {
    if (req.headers.origin !== ctx.origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
      return page(req, res, ctx, 403, 'Phiên đăng nhập không hợp lệ. Vui lòng thử lại.');
    }
    const length = Number(req.headers['content-length'] || 0);
    if (!Number.isFinite(length) || length > 8192) return reject(res, ctx, 413, 'Dữ liệu đăng nhập quá lớn.');
    let size = 0;
    const chunks = [];
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 8192) { req.resume(); return reject(res, ctx, 413, 'Dữ liệu đăng nhập quá lớn.'); }
      chunks.push(chunk);
    }
    const fields = new URLSearchParams(Buffer.concat(chunks).toString());
    const next = safeNext(fields.get('next'), ctx);
    const csrf = fields.get('csrf') || '';
    const expectedCSRF = cookies(req)[ctx.csrfCookie];
    if (!validCSRF(csrf, expectedCSRF, ctx)) {
      const reason = !expectedCSRF ? 'cookie_missing' : csrf !== expectedCSRF ? 'token_mismatch' : 'expired_or_invalid';
      console.log(JSON.stringify({ event: 'login_csrf_rejected', ip: ctx.ip, reason, at: new Date().toISOString() }));
      return page(req, res, ctx, 403, !expectedCSRF
        ? 'Trình duyệt chưa gửi cookie đăng nhập. Vui lòng cho phép cookie cho trang này rồi thử lại.'
        : 'Trang đăng nhập đã hết hạn. Vui lòng thử lại với phiên mới.', next);
    }
    if (!state.begin(ctx.ip)) return page(req, res, ctx, 429, 'Yêu cầu trước đang được xử lý. Vui lòng thử lại.', next);
    try {
      const revision = state.sessionRevision();
      if (await changingPassword()) return page(req, res, ctx, 503, 'Đang đổi mật khẩu và khởi động lại OpenCode. Vui lòng chờ rồi đăng nhập lại.', next);
      const account = state.state(ctx.ip);
      if (account.blocked) return page(req, res, ctx, 403, 'IP này đã bị khóa do đăng nhập sai 10 lần. Vui lòng liên hệ quản trị viên.', next);
      if (account.failures >= 5 && !state.verifyChallenge(csrf, ctx.ip, (fields.get('captcha') || '').trim().toUpperCase())) {
        return page(req, res, ctx, 422, 'Mã xác minh không đúng hoặc đã hết hạn. Vui lòng nhập mã mới.', next);
      }
      const username = fields.get('username') || '';
      const password = fields.get('password') || '';
      let check;
      if (!username || username.includes(':') || username.length > 128 || !password || password.length > 2048) check = { status: 401 };
      else {
        const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
        check = await backend('/api/info', 'GET', { authorization });
      }
      if (check.status === 401 || check.status === 403) {
        const result = state.fail(ctx.ip);
        const message = result.blocked ? 'IP này đã bị khóa do đăng nhập sai 10 lần. Vui lòng liên hệ quản trị viên.'
          : `Tên đăng nhập hoặc mật khẩu không đúng. Đã sai ${result.failures}/10 lần.${result.failures >= 5 ? ' Vui lòng nhập mã xác minh.' : ''}`;
        return page(req, res, ctx, result.blocked ? 403 : 401, message, next);
      }
      if (check.status !== 200) throw new Error('Backend unavailable');
      const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
      const pairing = await backend('/api/pair', 'POST', { authorization });
      if (pairing.status !== 200) throw new Error('Pairing unavailable');
      const { code } = JSON.parse(pairing.body);
      if (typeof code !== 'string' || !code) throw new Error('Invalid pairing response');
      const session = await backend(`/auth/connect/${encodeURIComponent(code)}`, 'GET', { accept: 'application/json' });
      if (session.status !== 200) throw new Error('Session unavailable');
      const { token } = JSON.parse(session.body);
      if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('Invalid session response');
      if (await changingPassword()) return page(req, res, ctx, 503, 'Đang đổi mật khẩu và khởi động lại OpenCode. Vui lòng chờ rồi đăng nhập lại.', next);
      state.revoke(cookies(req)[ctx.cookie]);
      const value = state.createSession(token, ctx.origin, revision);
      if (!value) return page(req, res, ctx, 409, 'Phiên đã bị thu hồi trong lúc đăng nhập. Vui lòng thử lại.', next);
      state.succeed(ctx.ip);
      redirect(res, ctx, next, { 'set-cookie': [cookie(ctx, ctx.cookie, value, 28800), cookie(ctx, ctx.csrfCookie, '', 0, ctx.secure ? '/' : '/login')] });
    } finally { state.end(ctx.ip); }
  }

  function endToEndHeaders(input) {
    const result = { ...input };
    const connection = String(input.connection || '').split(',').map((key) => key.trim().toLowerCase());
    for (const key of [...connection, 'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']) delete result[key];
    return result;
  }
  function upstreamHeaders(req, ctx, session, websocket = false) {
    const result = endToEndHeaders(req.headers);
    for (const key of ['authorization', 'proxy-authorization', 'cookie', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded', 'x-real-ip']) delete result[key];
    result.host = new URL(ctx.origin).host;
    if (session) result.authorization = 'Basic ' + Buffer.from('opencode:' + session.token).toString('base64');
    if (websocket) { result.connection = 'Upgrade'; result.upgrade = 'websocket'; }
    return result;
  }
  function upstreamPath(req, ctx) {
    const url = new URL(req.url, ctx.origin);
    url.searchParams.delete('auth_token');
    return url.pathname + url.search;
  }
  function canonicalPath(pathname) {
    let path = pathname;
    for (let count = 0; count < 3; count++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    return new URL(path.replaceAll('\\', '/').replace(/\/{2,}/g, '/'), 'http://127.0.0.1').pathname.replace(/\/+$/, '');
  }
  function watchSession(req, ctx, target) {
    const timer = setInterval(() => {
      try {
        if (state.state(ctx.ip).blocked || !state.session(cookies(req)[ctx.cookie], ctx.origin, false)) target.destroy();
      } catch { target.destroy(); }
    }, 30000);
    timer.unref();
    target.once('close', () => clearInterval(timer));
  }
  function proxy(req, res, ctx, session) {
    const path = upstreamPath(req, ctx);
    const navigation = session && req.method === 'GET' && !path.startsWith('/api/') && req.headers.accept?.includes('text/html');
    const requestHeaders = upstreamHeaders(req, ctx, session);
    if (navigation) {
      requestHeaders['accept-encoding'] = 'identity';
      delete requestHeaders['if-none-match']; delete requestHeaders['if-modified-since'];
    }
    const request = http.request({ hostname: backendHost, port: backendPort, method: req.method, path, headers: requestHeaders, signal: shutdown.signal }, async (response) => {
      clearTimeout(headerTimer);
      const result = { ...endToEndHeaders(response.headers), ...responseHeaders(ctx) };
      if (path.startsWith('/_assets/') || path.startsWith('/icons/')) result['cache-control'] = response.headers['cache-control'] || 'public, max-age=3600';
      delete result['www-authenticate'];
      delete result['set-cookie'];
      if (session && response.statusCode === 401) {
        try { state.revoke(cookies(req)[ctx.cookie]); }
        catch { response.destroy(); res.destroy(); return; }
        result['set-cookie'] = cookie(ctx, ctx.cookie, '', 0);
      }
      if (navigation && response.statusCode === 200 && response.headers['content-type']?.includes('text/html') && !response.headers['content-encoding']) {
        const timer = setTimeout(() => response.destroy(new Error('HTML response timeout')), 15000);
        timer.unref();
        try {
          let size = 0;
          const chunks = [];
          for await (const chunk of response) {
            size += chunk.length;
            if (size > 1024 * 1024) throw new Error('HTML response too large');
            chunks.push(chunk);
          }
          const html = Buffer.concat(chunks).toString();
          const hook = '<link rel="stylesheet" href="/web-login/settings-hook.css"><script src="/web-login/settings-hook.js" defer></script>';
          const body = html.includes('</head>') ? html.replace('</head>', hook + '</head>') : html + hook;
          for (const key of ['content-length', 'etag', 'content-md5', 'digest']) delete result[key];
          res.writeHead(200, result); res.end(body);
        } catch { if (!res.headersSent) reject(res, ctx, 502, 'Không tải được giao diện OpenCode. Vui lòng thử lại.'); else res.destroy(); }
        finally { clearTimeout(timer); }
        return;
      }
      res.writeHead(response.statusCode, result);
      response.pipe(res);
      response.on('error', () => res.destroy());
    });
    const headerTimer = setTimeout(() => request.destroy(new Error('Backend headers timeout')), 15000);
    headerTimer.unref();
    request.once('close', () => clearTimeout(headerTimer));
    request.on('error', () => {
      if (res.headersSent) return res.destroy();
      reject(res, ctx, 502, 'OpenCode tạm thời không khả dụng. Vui lòng thử lại.');
    });
    res.once('close', () => request.destroy());
    req.once('aborted', () => request.destroy());
    if (session) watchSession(req, ctx, res);
    req.pipe(request);
  }

  function adminCSRF(ctx, session, value = `${Date.now()}.${randomBytes(24).toString('hex')}`) {
    return value + '.' + createHmac('sha256', csrfKey).update('admin\0' + session.id + '\0' + value + '\0' + ctx.ip + '\0' + ctx.origin).digest('hex');
  }
  async function administration(req, res, ctx, session, url) {
    const send = (status, data) => { res.writeHead(status, { ...responseHeaders(ctx), 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    if (!session) return send(401, { message: 'Vui lòng đăng nhập lại.', loginRequired: true });
    const asset = adminAssets.get(url.pathname.slice('/web-login/'.length));
    if (asset !== undefined && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { ...responseHeaders(ctx), 'content-type': url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : asset); return;
    }
    if (['/web-login/password', '/web-login/updates'].includes(url.pathname) && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { ...responseHeaders(ctx), 'x-frame-options': 'SAMEORIGIN', 'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'; base-uri 'none'" });
      res.end(req.method === 'HEAD' ? undefined : adminPage); return;
    }
    const operation = url.pathname.slice('/web-login/api/'.length);
    if (!url.pathname.startsWith('/web-login/api/') || !['status', 'check', 'password', 'preferences', 'update'].includes(operation)) return send(404, { message: 'Không tìm thấy trang.' });
    if (!state.allowRequest(ctx.ip, 'admin', 60)) return send(429, { message: 'Quá nhiều yêu cầu. Vui lòng thử lại sau một phút.' });
    if (req.headers['x-opencode-login'] !== '1' || req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== ctx.origin)) return send(403, { message: 'Yêu cầu không hợp lệ.' });
    if (operation === 'status') {
      if (req.method !== 'GET') return send(405, { message: 'Phương thức không hợp lệ.' });
      if (!config.adminSocket) return send(200, { available: false, message: 'Chưa bật dịch vụ quản trị. Cài lại bằng bộ cài Linux để sử dụng.', csrf: adminCSRF(ctx, session) });
      const result = await adminCall(config.adminSocket, 'status', {}, { signal: shutdown.signal });
      return send(result.status, { ...result, csrf: adminCSRF(ctx, session) });
    }
    const token = req.headers['x-web-login-csrf'];
    const parts = typeof token === 'string' ? token.split('.') : [];
    const age = Date.now() - Number(parts[0]);
    if (req.method !== 'POST' || req.headers.origin !== ctx.origin || req.headers['content-type']?.split(';')[0] !== 'application/json' || !/^\d{13}\.[a-f0-9]{48}\.[a-f0-9]{64}$/.test(token || '') || age < 0 || age > 600000 || !timingSafeEqual(Buffer.from(token), Buffer.from(adminCSRF(ctx, session, parts.slice(0, 2).join('.'))))) return send(403, { message: 'Phiên xác nhận không hợp lệ. Vui lòng tải lại trang.' });
    if (operation !== 'check' && state.state(ctx.ip).failures >= 5) {
      state.revoke(cookies(req)[ctx.cookie]);
      return send(401, { message: 'Vui lòng đăng nhập lại và nhập mã xác minh trước khi tiếp tục.', loginRequired: true });
    }
    if (!config.adminSocket) return send(503, { message: 'Chưa bật dịch vụ quản trị.' });
    if (!state.begin(ctx.ip)) return send(429, { message: 'Yêu cầu trước đang được xử lý. Vui lòng chờ.' });
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 8192) { req.resume(); return send(413, { message: 'Dữ liệu quá lớn.' }); }
        chunks.push(chunk);
      }
      let fields;
      try { fields = JSON.parse(Buffer.concat(chunks).toString()); }
      catch { return send(400, { message: 'Dữ liệu không hợp lệ.' }); }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return send(400, { message: 'Dữ liệu không hợp lệ.' });
      const picked = Object.fromEntries(['password', 'newPassword', 'confirmPassword', 'automatic', 'channel'].filter(key => Object.hasOwn(fields, key)).map(key => [key, fields[key]]));
      const result = await adminCall(config.adminSocket, operation, picked, { signal: shutdown.signal });
      console.log(JSON.stringify({ event: 'web_admin_request', operation, ip: ctx.ip, status: result.status, at: new Date().toISOString() }));
      if (result.status === 401) {
        const failed = state.fail(ctx.ip);
        if (failed.failures >= 5) { state.revoke(cookies(req)[ctx.cookie]); result.loginRequired = true; }
      }
      else if ([200, 202].includes(result.status) && operation !== 'check') state.succeed(ctx.ip);
      if (result.status === 202 && operation === 'password') state.revokeAll();
      return send(result.status, result);
    } finally { state.end(ctx.ip); }
  }

  const server = http.createServer({ connectionsCheckingInterval: 1000 }, async (req, res) => {
    req.on('error', () => res.destroy());
    let ctx;
    try { ctx = context(req); }
    catch { res.writeHead(400, headers); res.end(); return; }
    if (ctx.redirect) {
      if (req.method === 'GET' || req.method === 'HEAD') { res.writeHead(308, { ...headers, location: ctx.redirect + (req.url.startsWith('/') && !req.url.startsWith('//') ? req.url : '/') }); res.end(); }
      else { res.writeHead(400, headers); res.end(); }
      return;
    }
    try {
      const url = new URL(req.url, ctx.origin);
      if (url.origin !== ctx.origin) return reject(res, ctx, 400, 'Yêu cầu không hợp lệ.');
      if (url.pathname === '/login/client.js' && ['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(200, { ...responseHeaders(ctx), 'content-type': 'text/javascript; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : loginScript);
        return;
      }
      if (url.pathname === '/login/session') {
        if (!state.allowRequest(ctx.ip)) return reject(res, ctx, 429, 'Quá nhiều yêu cầu. Vui lòng thử lại sau một phút.');
        if (req.method !== 'GET' || req.headers['x-opencode-login'] !== '1' || (req.headers.origin && req.headers.origin !== ctx.origin) || req.headers['sec-fetch-site'] === 'cross-site') return reject(res, ctx, 403, 'Yêu cầu không hợp lệ.');
        if (state.state(ctx.ip).blocked) return reject(res, ctx, 403, 'IP này đã bị khóa do đăng nhập sai 10 lần. Vui lòng liên hệ quản trị viên.');
        const csrf = formCSRF(req, ctx);
        const captcha = state.state(ctx.ip).failures >= 5;
        const refreshed = captcha && !state.image(csrf, ctx.ip);
        if (refreshed) state.challenge(csrf, ctx.ip);
        res.writeHead(200, { ...responseHeaders(ctx), 'content-type': 'application/json; charset=utf-8', 'set-cookie': csrfCookies(ctx, csrf) });
        res.end(JSON.stringify({ csrf, captcha, refreshed }));
        return;
      }
      if (state.state(ctx.ip).blocked) {
        if (!state.allowRequest(ctx.ip, 'blocked')) { res.setHeader('retry-after', '60'); return reject(res, ctx, 429, 'Quá nhiều yêu cầu. Vui lòng thử lại sau một phút.'); }
        const message = 'IP này đã bị khóa do đăng nhập sai 10 lần. Vui lòng liên hệ quản trị viên.';
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/web-login/api/')) return reject(res, ctx, 403, message);
        return page(req, res, ctx, 403, message);
      }
      const session = state.session(cookies(req)[ctx.cookie], ctx.origin);
      if (url.pathname.startsWith('/web-login/')) return await administration(req, res, ctx, session, url);
      if (url.pathname === '/login' || url.pathname === '/login/captcha') {
        if (!state.allowRequest(ctx.ip)) { res.setHeader('retry-after', '60'); return reject(res, ctx, 429, 'Quá nhiều yêu cầu. Vui lòng thử lại sau một phút.'); }
        if (url.pathname === '/login/captcha') {
          if (req.method !== 'GET') return reject(res, ctx, 405, 'Phương thức không hợp lệ.');
          const image = state.image(cookies(req)[ctx.csrfCookie], ctx.ip);
          if (!image) return reject(res, ctx, 404, 'Mã xác minh đã hết hạn.');
          res.writeHead(200, { ...responseHeaders(ctx), 'content-type': 'image/png', 'content-length': image.length });
          res.end(image);
          return;
        }
        if (req.method === 'POST') return await login(req, res, ctx);
        if (req.method !== 'GET' && req.method !== 'HEAD') return reject(res, ctx, 405, 'Phương thức không hợp lệ.');
        if (session) return redirect(res, ctx, safeNext(url.searchParams.get('next'), ctx));
        return page(req, res, ctx, 200, '', url.searchParams.get('next'));
      }
      if (url.pathname === '/logout') {
        if (!session) return redirect(res, ctx, '/login');
        if (req.method === 'GET') {
          res.writeHead(200, { ...responseHeaders(ctx), 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; style-src 'unsafe-inline'" });
          res.end('<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Đăng xuất · OpenCode</title><style>body{font:16px/1.5 system-ui;margin:0;min-height:100dvh;display:grid;place-items:center;background:#f4f4f5;color:#222;padding:24px;box-sizing:border-box}main{max-width:380px}button{font:inherit;padding:12px 24px;border:0;border-radius:8px;background:#222;color:#fff;cursor:pointer}a{display:inline-block;margin-top:20px;color:#555}</style><main><h1>Đăng xuất</h1><p>Kết thúc phiên đăng nhập trên thiết bị này?</p><form method="post" action="/logout"><button type="submit">Đăng xuất</button></form><a href="/">Quay lại OpenCode</a></main></html>');
          return;
        }
        if (req.method !== 'POST' || req.headers.origin !== ctx.origin) return reject(res, ctx, 403, 'Yêu cầu không hợp lệ.');
        state.revoke(cookies(req)[ctx.cookie]);
        return redirect(res, ctx, '/login', { 'set-cookie': cookie(ctx, ctx.cookie, '', 0) });
      }
      let path;
      try { path = canonicalPath(url.pathname); }
      catch { return reject(res, ctx, 400, 'Đường dẫn không hợp lệ.'); }
      if (path === '/auth' || path.startsWith('/auth/') || path === '/api/pair' || path.startsWith('/api/pair/')) return reject(res, ctx, 403, 'Đăng nhập qua trang đăng nhập.');
      const publicPath = url.pathname.startsWith('/_assets/') || url.pathname.startsWith('/icons/') || ['/site.webmanifest', '/sw.js', '/registerSW.js'].includes(url.pathname);
      if (publicPath && !['GET', 'HEAD'].includes(req.method)) return reject(res, ctx, 405, 'Phương thức không hợp lệ.');
      const apiPath = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname === '/openapi.json';
      if (!publicPath && !session) {
        if (apiPath) return reject(res, ctx, 401, 'Vui lòng đăng nhập.');
        return redirect(res, ctx, '/login?next=' + encodeURIComponent(safeNext(req.url, ctx)));
      }
      if (session && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== ctx.origin) return reject(res, ctx, 403, 'Yêu cầu không hợp lệ.');
      proxy(req, res, ctx, session);
    } catch {
      if (res.headersSent) return res.destroy();
      if (req.url.startsWith('/web-login/')) return reject(res, ctx, 503, 'Dịch vụ quản trị tạm thời không khả dụng. Vui lòng thử lại.');
      try {
        page(req, res, ctx, 503, 'OpenCode đang khởi động hoặc tạm thời không khả dụng. Vui lòng thử lại.');
      } catch {
        reject(res, ctx, 503, 'OpenCode tạm thời không khả dụng. Vui lòng thử lại.');
      }
    }
  });

  function rejectUpgrade(socket, status = 403) {
    if (socket.destroyed || socket.writableEnded) return;
    const reason = { 403: 'Forbidden', 429: 'Too Many Requests', 502: 'Bad Gateway' }[status];
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${status === 429 ? 'Retry-After: 60\r\n' : ''}\r\n`, () => socket.destroy());
  }
  server.on('upgrade', (req, socket, head) => {
    let ctx, session;
    try {
      ctx = context(req);
      if (!state.allowRequest(ctx.ip, 'websocket', 60)) return rejectUpgrade(socket, 429);
      const url = new URL(req.url, ctx.origin);
      session = state.session(cookies(req)[ctx.cookie], ctx.origin);
      if (req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(req.headers['sec-websocket-key'] || '') || ctx.redirect || state.state(ctx.ip).blocked || !session || req.headers.origin !== ctx.origin || url.origin !== ctx.origin || req.headers['transfer-encoding'] || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || !/^\/api\/(?:pty|experimental\/persistent-pty)\/[^/]+\/connect$/.test(url.pathname) || !/^\/api\/(?:pty|experimental\/persistent-pty)\/[^/]+\/connect$/.test(canonicalPath(url.pathname))) throw new Error('Unauthorized upgrade');
    } catch {
      rejectUpgrade(socket);
      return;
    }
    let upstream;
    const request = http.request({ hostname: backendHost, port: backendPort, method: 'GET', path: upstreamPath(req, ctx),
      headers: upstreamHeaders(req, ctx, session, true), maxHeaderSize: 16384, signal: shutdown.signal });
    const handshakeTimer = setTimeout(() => request.destroy(new Error('WebSocket handshake timeout')), 15000);
    handshakeTimer.unref();
    request.once('upgrade', (response, target, upstreamHead) => {
      clearTimeout(handshakeTimer);
      upstream = target;
      upstream.on('error', () => socket.destroy());
      upstream.once('close', () => socket.destroy());
      const expected = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (socket.destroyed || response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket' || !String(response.headers.connection || '').toLowerCase().split(',').map(x => x.trim()).includes('upgrade') || response.headers['sec-websocket-accept'] !== expected) {
        upstream.destroy(); rejectUpgrade(socket, 502); return;
      }
      const result = { ...endToEndHeaders(response.headers), ...responseHeaders(ctx), connection: 'Upgrade', upgrade: 'websocket' };
      for (const key of ['set-cookie', 'www-authenticate', 'content-length']) delete result[key];
      const lines = ['HTTP/1.1 101 Switching Protocols'];
      for (const [key, value] of Object.entries(result)) {
        for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) lines.push(`${key}: ${entry}`);
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.setTimeout(0); socket.setTimeout(0);
      watchSession(req, ctx, socket);
      socket.pipe(upstream).pipe(socket);
    });
    request.once('response', response => { clearTimeout(handshakeTimer); response.destroy(); rejectUpgrade(socket, 502); });
    request.once('error', () => { if (upstream) socket.destroy(); else rejectUpgrade(socket, 502); });
    request.once('close', () => clearTimeout(handshakeTimer));
    socket.once('close', () => { clearTimeout(handshakeTimer); request.destroy(); upstream?.destroy(); });
    request.end();
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;
  server.maxConnections = 256;
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  let closing;
  let listening;
  let closed = false;
  return {
    server,
    config,
    async listen() {
      if (closed) throw new Error('This login server has been closed');
      if (server.listening) return server.address();
      listening ??= new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        try { server.listen(port, hostname); }
        catch (error) { server.off('error', onError); server.off('listening', onListening); reject(error); }
      });
      const pending = listening;
      try { await pending; }
      catch (error) { if (listening === pending) listening = undefined; throw error; }
      if (closed) throw new Error('This login server has been closed');
      return server.address();
    },
    close() {
      if (closing) return closing;
      closed = true;
      shutdown.abort();
      closing = (async () => {
        if (listening) { try { await listening; } catch {} }
        await new Promise((resolve) => {
          const finish = () => { clearTimeout(timer); for (const socket of sockets) socket.destroy(); state.close(); resolve(); };
          const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 5000);
          timer.unref();
          if (!server.listening) { finish(); return; }
          server.close(finish);
          server.closeIdleConnections();
        });
      })();
      return closing;
    },
  };
}
