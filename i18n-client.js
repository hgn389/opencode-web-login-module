import { createTranslator, normalizeLocale } from '/login/i18n-core.mjs';

let bootstrap;
try {
  const response = await fetch('/login/locales', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw new Error('Locale catalog unavailable');
  bootstrap = await response.json();
} catch { bootstrap = { languages: [{ code: 'en', name: 'English', tag: 'en', dir: 'ltr' }, { code: 'vi', name: 'Tiếng Việt', tag: 'vi', dir: 'ltr' }], source: {}, english: {} }; }
const { languages, source, english } = bootstrap;
const catalogs = new Map([['vi', source], ['en', english]]), pending = new Map(), listeners = new Set(), bindings = new Set();
const modulePage = document.documentElement.hasAttribute('data-web-login-page');
const normalize = value => normalizeLocale(value, languages);
let current, manualLocale, generation = 0, translator = createTranslator(source, english, english);

function preferenceCookie(name) {
  try { return decodeURIComponent(document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(name + '='))?.slice(name.length + 1) || ''); } catch { return ''; }
}
function preferred() {
  if (!modulePage) { const code = normalize(document.documentElement.lang); if (code) return code; }
  try { if (window.parent !== window && window.parent.location.origin === location.origin && window.parent.WebLoginI18n?.locale) return window.parent.WebLoginI18n.locale; } catch { /* Standalone and cross-origin embedding use local preferences. */ }
  for (const name of ['oc_locale', 'web_login_locale']) { const code = normalize(preferenceCookie(name)); if (code) return code; }
  try {
    for (const key of ['opencode.global.dat:language', 'opencode.language', 'language']) {
      const value = localStorage.getItem(key);
      if (!value) continue;
      try { const parsed = JSON.parse(value), code = normalize(typeof parsed === 'string' ? parsed : parsed?.locale); if (code) return code; } catch { const code = normalize(value); if (code) return code; }
    }
  } catch { /* Language selection also works when browser storage is disabled. */ }
  if (manualLocale) return manualLocale;
  for (const value of navigator.languages || [navigator.language]) { const code = normalize(value); if (code) return code; }
  return normalize(document.documentElement.lang) || 'en';
}

async function load(code) {
  if (catalogs.has(code)) return catalogs.get(code);
  if (!pending.has(code)) pending.set(code, (async () => {
    const response = await fetch(`/login/locales/${code}.json`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error('Locale catalog unavailable');
    const dictionary = await response.json();
    if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary) || Object.values(dictionary).some(value => typeof value !== 'string')) throw new Error('Invalid locale catalog');
    catalogs.set(code, dictionary); return dictionary;
  })().finally(() => pending.delete(code)));
  return pending.get(code);
}
function renderBinding(binding) {
  if (!binding.attribute && binding.node?.parentNode !== binding.element) { bindings.delete(binding); return; }
  const value = binding.key ? translator.key(binding.source) : translator.t(typeof binding.source === 'function' ? binding.source() : binding.source);
  if (binding.attribute) { if (binding.element.getAttribute(binding.attribute) !== value) binding.element.setAttribute(binding.attribute, value); }
  else if (binding.node.data !== value) binding.node.data = value;
}
const bound = new WeakMap();
function bind(element, value, attribute, key = false) {
  const slots = bound.get(element) || new Map(), slot = attribute || 'text';
  const previous = slots.get(slot); if (previous) bindings.delete(previous);
  const binding = { element, source: value, attribute, key }; slots.set(slot, binding); bound.set(element, slots); bindings.add(binding);
  // Detached controls are translated before insertion and retained for the next language change.
  const translated = key ? translator.key(value) : translator.t(typeof value === 'function' ? value() : value);
  if (attribute) element.setAttribute(attribute, translated);
  else { element.textContent = translated; binding.node = element.firstChild || element.appendChild(document.createTextNode('')); }
  return element;
}
function bindMarkup(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) if (Object.hasOwn(source, element.dataset.i18n)) bind(element, element.dataset.i18n, undefined, true);
  for (const attribute of ['alt', 'title', 'aria-label']) for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
    const key = element.getAttribute(`data-i18n-${attribute}`); if (Object.hasOwn(source, key)) bind(element, key, attribute, true);
  }
  for (const element of root.querySelectorAll('[data-i18n-value]')) bind(element, element.getAttribute('data-i18n-value'));
}
async function change(code) {
  code = normalize(code) || 'en';
  if (code === current) return;
  const revision = ++generation;
  let dictionary;
  try { dictionary = await load(code); } catch { dictionary = english; }
  if (revision !== generation) return;
  current = code; translator = createTranslator(source, dictionary, english);
  if (modulePage) {
    const language = languages.find(language => language.code === code);
    document.documentElement.lang = language?.tag || code; document.documentElement.dir = language?.dir || 'ltr';
  }
  for (const binding of [...bindings]) renderBinding(binding);
  for (const listener of listeners) listener(code);
}
function select(code) {
  code = normalize(code) || 'en';
  manualLocale = code;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  for (const name of ['oc_locale', 'web_login_locale']) document.cookie = `${name}=${encodeURIComponent(code)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
  try { localStorage.setItem('opencode.global.dat:language', JSON.stringify({ locale: code })); } catch { /* Cookies or the current page still retain the choice. */ }
  return change(code);
}
export const i18n = {
  languages, get locale() { return current || 'en'; }, t: value => translator.t(value), text: (element, value) => bind(element, value), attr: (element, attribute, value) => bind(element, value, attribute),
  option: (value, id) => bind(new Option('', id), value), select,
  prune(root) {
    for (const binding of bindings) if (root ? binding.element === root || root.contains(binding.element) : !binding.element.isConnected || !binding.attribute && binding.node?.parentNode !== binding.element) bindings.delete(binding);
  },
  subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};
window.WebLoginI18n = i18n;
const explicitLocale = normalize(new URLSearchParams(location.search).get('lang'));
if (modulePage && explicitLocale) await select(explicitLocale); else await change(preferred());
if (modulePage) bindMarkup();
const chooser = document.querySelector('[data-language-select]');
if (chooser) {
  if (Object.keys(source).length) chooser.replaceChildren(...languages.map(language => new Option(language.name, language.code)));
  chooser.value = i18n.locale; chooser.disabled = false;
  chooser.addEventListener('change', () => select(chooser.value)); i18n.subscribe(code => { chooser.value = code; });
}
let scheduled = false;
const sync = () => { if (scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; const code = preferred(); if (code !== current) change(code); }); };
new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['lang', 'dir'] });
window.addEventListener('storage', sync); window.addEventListener('pageshow', sync); document.addEventListener('visibilitychange', sync);
window.addEventListener('message', event => {
  if (window.parent !== window && event.source === window.parent && event.origin === location.origin && event.data?.type === 'web-login-language') sync();
});
const timer = setInterval(sync, 1000);
window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
