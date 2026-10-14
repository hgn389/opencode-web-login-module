import { readFileSync } from 'node:fs';
import { createTranslator, normalizeLocale } from './i18n-core.mjs';

export const languages = JSON.parse(readFileSync(new URL('./locales.json', import.meta.url), 'utf8'));
const catalogs = new Map(languages.map(language => [language.code, JSON.parse(readFileSync(new URL(`./locales/${language.code}.json`, import.meta.url), 'utf8'))]));
const source = catalogs.get('vi'), english = catalogs.get('en');
const translators = new Map(languages.map(language => [language.code, createTranslator(source, catalogs.get(language.code), english)]));
export const bootstrap = JSON.stringify({ languages, source, english });
export const localeCatalog = code => catalogs.has(code) ? JSON.stringify(catalogs.get(code)) : undefined;

export function requestLocale(req) {
  const choices = [req.headers['x-web-login-locale']];
  try { choices.push(new URL(req.url, 'http://localhost').searchParams.get('lang')); } catch { /* Invalid URLs are rejected by the gateway. */ }
  const cookies = Object.create(null);
  for (const part of (req.headers.cookie || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) {
      const key = part.slice(0, at).trim();
      if (!Object.hasOwn(cookies, key)) { try { cookies[key] = decodeURIComponent(part.slice(at + 1).trim()); } catch { /* Ignore malformed preferences. */ } }
    }
  }
  choices.push(cookies.oc_locale, cookies.web_login_locale);
  const accepted = String(req.headers['accept-language'] || '').slice(0, 4096).split(',').map((part, index) => {
    const [tag, ...parameters] = part.trim().split(';');
    const q = parameters.find(parameter => parameter.trim().startsWith('q='));
    return { tag, quality: q ? Number(q.trim().slice(2)) : 1, index };
  }).filter(item => item.tag && item.tag !== '*' && Number.isFinite(item.quality) && item.quality > 0 && item.quality <= 1).sort((a, b) => b.quality - a.quality || a.index - b.index);
  choices.push(...accepted.map(item => item.tag));
  for (const choice of choices) { const code = normalizeLocale(choice, languages); if (code) return code; }
  return choices.some(Boolean) ? 'en' : 'vi';
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const translate = (value, code) => (translators.get(code) || translators.get('en')).t(value);

export function localizeHTML(html, code) {
  const language = languages.find(language => language.code === code) || languages[0], translator = translators.get(language.code);
  return html.replace(/<html\b[^>]*>/i, tag => tag.replace(/\s(?:lang|dir)="[^"]*"/g, '').replace('>', ` lang="${language.tag}" dir="${language.dir}">`))
    .replace(/(<([a-z][\w-]*)\b[^>]*\bdata-i18n="([a-z0-9]+)"[^>]*>)[^<]*(<\/\2>)/gi, (_match, opening, _tag, key, closing) => opening + escapeHtml(translator.key(key)) + closing)
    .replace(/<[^>]+\bdata-i18n-(?:alt|title|aria-label)="[^"]+"[^>]*>/g, tag => {
      for (const match of tag.matchAll(/\bdata-i18n-(alt|title|aria-label)="([a-z0-9]+)"/g)) {
        const attribute = new RegExp(`(?<![\\w-])${match[1]}="[^"]*"`);
        tag = tag.replace(attribute, `${match[1]}="${escapeHtml(translator.key(match[2]))}"`);
      }
      return tag;
    });
}
