import http from 'node:http';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const hostname = process.env.LOGIN_HOST || '192.168.1.150';
const port = Number(process.env.LOGIN_PORT || 4096);
const backendPort = Number(process.env.OPENCODE_BACKEND_PORT || 4097);
const backendHost = process.env.OPENCODE_BACKEND_HOST || '127.0.0.1';
const authority = `${hostname}:${port}`;
const origin = `http://${authority}`;
const sessionCookie = `opencode_session_${port}`;
const csrfCookie = `opencode_login_csrf_${port}`;
const template = readFileSync(new URL('./login.html', import.meta.url), 'utf8');
const attempts = new Map();
const interval = 10 * 60 * 1000;
const safeHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const at = part.indexOf('=');
    return at < 0 ? ['', ''] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
  }));
}

function safeNext(value) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n]/.test(value)) return '/';
  const url = new URL(value, origin);
  return url.origin === origin && !['/login', '/logout'].includes(url.pathname) ? url.pathname + url.search : '/';
}

function page(res, status = 200, message = '', next = '/') {
  const csrf = randomBytes(32).toString('hex');
  res.writeHead(status, {
    ...safeHeaders,
    'content-type': 'text/html; charset=utf-8',
    'set-cookie': `${csrfCookie}=${csrf}; Path=/login; HttpOnly; SameSite=Strict; Max-Age=600`,
  });
  res.end(template.replace('{{MESSAGE}}', escapeHtml(message)).replace('{{CSRF}}', csrf).replace('{{NEXT}}', escapeHtml(safeNext(next))));
}

function redirect(res, location, extra = {}) {
  res.writeHead(303, { 'cache-control': 'no-store', location, ...extra });
  res.end();
}

function backend(path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: backendHost, port: backendPort, path, method, headers: { host: authority, ...headers } }, (res) => {
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 65536) res.destroy(new Error('Backend response too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.setTimeout(10000, () => req.destroy(new Error('Backend timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function loggedIn(req) {
  const token = cookies(req)[sessionCookie];
  if (!token || token.length > 512) return false;
  const check = await backend('/api/info', 'GET', { cookie: `${sessionCookie}=${token}` });
  return check.status === 200;
}

async function login(req, res) {
  if (req.headers.origin !== origin || req.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
    return page(res, 403, 'Phiên đăng nhập không hợp lệ. Vui lòng thử lại.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) { res.writeHead(413, safeHeaders); res.end(); return; }
    chunks.push(chunk);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString());
  const next = safeNext(fields.get('next'));
  const csrf = fields.get('csrf') || '';
  const expected = cookies(req)[csrfCookie] || '';
  if (!/^[a-f0-9]{64}$/.test(csrf) || !/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))) {
    return page(res, 403, 'Phiên đăng nhập đã hết hạn. Vui lòng thử lại.', next);
  }
  const ip = req.socket.remoteAddress;
  const now = Date.now();
  for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  const rate = attempts.get(ip) || { count: 0, until: now + interval };
  if (rate.count >= 10 || attempts.size >= 4096) {
    res.setHeader('retry-after', String(Math.max(1, Math.ceil((rate.until - now) / 1000))));
    return page(res, 429, 'Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau ít phút.', next);
  }
  rate.count += 1;
  attempts.set(ip, rate);
  const username = fields.get('username') || '';
  const password = fields.get('password') || '';
  if (!username || username.includes(':') || username.length > 128 || !password || password.length > 2048) {
    return page(res, 422, 'Vui lòng nhập tên đăng nhập và mật khẩu hợp lệ.', next);
  }
  const authorization = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const check = await backend('/api/info', 'GET', { authorization });
  if (check.status === 401 || check.status === 403) return page(res, 401, 'Tên đăng nhập hoặc mật khẩu không đúng.', next);
  if (check.status !== 200) throw new Error('Backend unavailable');
  const pairing = await backend('/api/pair', 'POST', { authorization });
  if (pairing.status !== 200) throw new Error('Pairing unavailable');
  const { code } = JSON.parse(pairing.body);
  if (typeof code !== 'string' || !code) throw new Error('Invalid pairing response');
  const session = await backend(`/auth/connect/${encodeURIComponent(code)}`, 'GET', { accept: 'application/json' });
  if (session.status !== 200) throw new Error('Session unavailable');
  const { token } = JSON.parse(session.body);
  if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(token)) throw new Error('Invalid session response');
  attempts.delete(ip);
  redirect(res, next, { 'set-cookie': [
    `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
    `${csrfCookie}=; Path=/login; HttpOnly; SameSite=Strict; Max-Age=0`,
  ] });
}

function proxy(req, res) {
  const headers = { ...req.headers, host: authority };
  delete headers['proxy-authorization'];
  const upstream = http.request({ hostname: backendHost, port: backendPort, method: req.method, path: req.url, headers }, (response) => {
    const headers = { ...response.headers };
    delete headers['www-authenticate'];
    res.writeHead(response.statusCode, headers);
    response.pipe(res);
    response.on('error', () => res.destroy());
  });
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { ...safeHeaders, 'content-type': 'text/plain; charset=utf-8' });
    res.end('OpenCode tạm thời không khả dụng. Vui lòng thử lại.');
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== authority) { res.writeHead(400); res.end(); return; }
    const url = new URL(req.url, origin);
    if (url.pathname === '/login') {
      if (req.method === 'POST') return await login(req, res);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { allow: 'GET, HEAD, POST' }); res.end(); return; }
      if (await loggedIn(req)) return redirect(res, safeNext(url.searchParams.get('next')));
      return page(res, 200, '', url.searchParams.get('next'));
    }
    if (url.pathname === '/logout') {
      if (req.method !== 'POST' || req.headers.origin !== origin) { res.writeHead(403, safeHeaders); res.end(); return; }
      return redirect(res, '/login', { 'set-cookie': `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    const publicPath = url.pathname.startsWith('/_assets/') || url.pathname.startsWith('/icons/') || ['/site.webmanifest', '/sw.js', '/registerSW.js'].includes(url.pathname);
    const apiPath = url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname === '/openapi.json';
    if (!publicPath && !apiPath && !(await loggedIn(req))) return redirect(res, '/login?next=' + encodeURIComponent(safeNext(req.url)));
    proxy(req, res);
  } catch {
    if (res.headersSent) return res.destroy();
    page(res, 503, 'OpenCode đang khởi động hoặc tạm thời không khả dụng. Vui lòng thử lại.');
  }
});

server.on('upgrade', (req, socket, head) => {
  if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== origin)) { socket.destroy(); return; }
  const upstream = net.connect(backendPort, backendHost, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'proxy-authorization') continue;
      for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) lines.push(`${key}: ${entry}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
  upstream.on('close', () => socket.destroy());
});
server.headersTimeout = 15000;
server.requestTimeout = 30000;
server.maxHeadersCount = 100;
server.listen(port, hostname, () => console.log(`OpenCode web sign-in listening on ${origin}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); setTimeout(() => process.exit(0), 5000).unref(); });
