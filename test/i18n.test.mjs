import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createTranslator, normalizeLocale } from '../i18n-core.mjs';
import { languages, requestLocale, localizeHTML } from '../i18n-server.mjs';
import { createLoginServer } from '../index.mjs';
import { SecurityStore } from '../security.mjs';
import { moduleFiles } from '../update.mjs';

const catalog = code => JSON.parse(readFileSync(new URL(`../locales/${code}.json`, import.meta.url), 'utf8'));
const source = catalog('vi'), english = catalog('en');
const placeholders = text => [...text.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();

test('all OpenCode locales have complete, nonempty catalogs, matching interpolation tokens and installation entries', () => {
  assert.equal(languages.length, 63); assert.equal(new Set(languages.map(language => language.code)).size, 63);
  for (const language of languages) {
    const translated = catalog(language.code);
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(source).sort(), language.code);
    assert(moduleFiles.includes(`locales/${language.code}.json`));
    assert.doesNotThrow(() => new Intl.Locale(language.tag));
    for (const [key, value] of Object.entries(translated)) {
      assert(typeof value === 'string' && value.trim(), `${language.code}/${key}`);
      assert.deepEqual(placeholders(value), placeholders(source[key]), `${language.code}/${key}`);
      assert(!/XKm\d+KX|XTP\d+PTX|⟦\d+⟧|⟪\d+⟫/.test(value), `${language.code}/${key}`);
    }
  }
  for (const file of ['i18n-core.mjs', 'i18n-server.mjs', 'i18n-client.js', 'locales.json']) assert(moduleFiles.includes(file));
});

test('locale negotiation follows explicit choices, OpenCode cookies and language quality, rejecting unrecognized input', () => {
  const normalize = value => normalizeLocale(value, languages);
  for (const [tag, code] of [['vi-VN', 'vi'], ['en_US', 'en'], ['zh-Hant-TW', 'zht'], ['zh-Hans', 'zh'], ['pt-BR', 'br'], ['nb-NO', 'no'], ['iw-IL', 'he']]) assert.equal(normalize(tag), code);
  for (const tag of ['__proto__', '../en', '<script>', 'x'.repeat(65), null]) assert.equal(normalize(tag), undefined);
  assert.equal(requestLocale({ url: '/login', headers: {} }), 'vi');
  assert.equal(requestLocale({ url: '/login', headers: { 'accept-language': '*' } }), 'vi');
  assert.equal(requestLocale({ url: '/login', headers: { 'accept-language': 'es;q=0,en;q=0.8,vi;q=0.9' } }), 'vi');
  assert.equal(requestLocale({ url: '/login', headers: { cookie: 'oc_locale=ja', 'accept-language': 'fr' } }), 'ja');
  assert.equal(requestLocale({ url: '/login?lang=fr', headers: { cookie: 'oc_locale=ja' } }), 'fr');
  assert.equal(requestLocale({ url: '/login?lang=fr', headers: { 'x-web-login-locale': 'de', cookie: 'oc_locale=ja' } }), 'de');
  assert.equal(requestLocale({ url: '/login?lang=%22%3E%3Cscript%3E', headers: { cookie: 'oc_locale=%ZZ; web_login_locale=vi' } }), 'vi');
  assert.equal(requestLocale({ url: '/login', headers: { 'accept-language': 'unsupported' } }), 'en');
});

test('translations preserve literal identifiers, handle nested statuses and fall back safely without inserting HTML', () => {
  const translator = createTranslator(source, {}, english);
  assert.equal(translator.t('Đổi mật khẩu'), 'Change password');
  assert.equal(translator.t('Đã chọn 5 / 12 model.'), 'Selected 5 / 12 models.');
  assert.equal(translator.t('Chọn model router/coder-123'), 'Select model router/coder-123');
  assert.equal(translator.t('Chọn model Đóng'), 'Select model Đóng');
  assert.equal(translator.t('Đang chuẩn bị hạ cấp OpenCode về 1.18.20.'), 'Preparing to downgrade OpenCode to 1.18.20.');
  assert.equal(translator.t('Tên đăng nhập hoặc mật khẩu không đúng. Đã sai 5/10 lần. Vui lòng nhập mã xác minh.'), 'Incorrect username or password. Failed attempts: 5/10. Please enter verification code.');
  assert.equal(translator.t('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>');
  const key = Object.keys(source).find(key => source[key] === 'Đổi mật khẩu');
  const localized = localizeHTML(`<html lang="vi"><h1><span data-i18n="${key}">Đổi mật khẩu</span></h1><input value="Đổi mật khẩu"></html>`, 'en');
  assert(localized.includes('lang="en" dir="ltr"')); assert(localized.includes('>Change password</span>')); assert(localized.includes('value="Đổi mật khẩu"'));
});

test('public locale assets expose only catalogs; localized login, CAPTCHA and logout preserve authentication and CSRF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'login-i18n-')), statePath = join(root, 'state.sqlite');
  const backend = http.createServer((_req, res) => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{}'); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const gateway = createLoginServer({ port, backendPort: backend.address().port, statePath }); await gateway.listen();
  const origin = `http://127.0.0.1:${port}`, store = new SecurityStore(statePath);
  try {
    const boot = await (await fetch(origin + '/login/locales')).json(); assert.deepEqual(Object.keys(boot).sort(), ['english', 'languages', 'source']);
    assert.equal((await fetch(origin + '/login/locales/ja.json')).status, 200);
    assert.equal((await fetch(origin + '/login/locales/xx.json')).status, 404);
    assert.equal((await fetch(origin + '/login/locales', { method: 'POST' })).status, 405);
    for (const file of ['i18n-core.mjs', 'i18n-client.js']) assert((await fetch(origin + '/login/' + file)).headers.get('content-type').includes('javascript'));
    assert.equal((await fetch(origin + '/web-login/api/status')).status, 401);
    const login = await fetch(origin + '/login', { headers: { 'accept-language': 'en' } }), html = await login.text();
    assert(html.includes('lang="en" dir="ltr"')); assert(html.includes('>Sign in</span>')); assert(html.includes('>Username</span>'));
    assert(html.includes('type="module"')); assert(html.includes('data-language-select'));
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)[1], cookie = `opencode_csrf_${port}=${csrf}`;
    const form = new URLSearchParams({ csrf, username: 'fixture', password: 'isolated-wrong-password' });
    const forged = await fetch(origin + '/login', { method: 'POST', headers: { cookie, origin: 'https://attacker.example', 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'en' }, body: form }); assert.equal(forged.status, 403); assert.equal(store.state('127.0.0.1').failures, 0);
    const wrong = await fetch(origin + '/login', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded', 'accept-language': 'en' }, body: form });
    assert.equal(wrong.status, 401); assert((await wrong.text()).includes('Incorrect username or password. Failed attempts: 1/10.')); assert.equal(store.state('127.0.0.1').failures, 1);
    for (let i = 0; i < 4; i++) store.fail('127.0.0.1');
    const challenge = await (await fetch(origin + '/login', { headers: { 'accept-language': 'en' } })).text();
    assert(challenge.includes('Verification code consists of 6 characters in the image')); assert(challenge.includes('>Change code</span>'));
    const session = store.createSession('isolated-locale-native-session', origin);
    const logout = await (await fetch(origin + '/logout', { headers: { cookie: `opencode_login_${port}=${session}; oc_locale=ar` } })).text();
    assert(logout.includes('lang="ar" dir="rtl"')); assert(logout.includes('تسجيل الخروج'));
    assert(store.session(session, origin)); assert.equal(store.state('127.0.0.1').failures, 5);
  } finally { store.close(); await gateway.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); rmSync(root, { recursive: true, force: true }); }
});
