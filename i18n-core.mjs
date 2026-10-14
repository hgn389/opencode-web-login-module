export function normalizeLocale(value, languages) {
  if (typeof value !== 'string' || value.length > 64) return;
  const tag = value.trim().toLowerCase().replaceAll('_', '-');
  const supported = new Set(languages.map(language => language.code));
  if (supported.has(tag)) return tag;
  if (/^zh-(?:tw|hk|mo|hant)(?:-|$)/.test(tag)) return supported.has('zht') ? 'zht' : undefined;
  if (tag === 'pt' || tag.startsWith('pt-')) return supported.has('br') ? 'br' : undefined;
  if (/^(?:nb|nn)(?:-|$)/.test(tag)) return supported.has('no') ? 'no' : undefined;
  const primary = tag.split('-')[0], alias = { iw: 'he', in: 'id' }[primary] || primary;
  return supported.has(alias) ? alias : undefined;
}

export function createTranslator(source, dictionary, fallback = {}) {
  const entries = Object.entries(source), bySource = new Map(entries.map(([key, value]) => [value, key]));
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const templates = entries.filter(([, value]) => /\{\d+\}/.test(value)).map(([key, value]) => {
    const slots = [];
    let offset = 0, pattern = '^';
    for (const match of value.matchAll(/\{(\d+)\}/g)) {
      pattern += escape(value.slice(offset, match.index)) + '([\\s\\S]*?)';
      slots.push(Number(match[1])); offset = match.index + match[0].length;
    }
    return { key, source: value, slots, pattern: new RegExp(pattern + escape(value.slice(offset)) + '$') };
  }).sort((a, b) => b.source.length - a.source.length);
  const keyText = (key, values = []) => {
    const text = Object.hasOwn(dictionary, key) ? dictionary[key] : fallback[key] ?? source[key];
    return typeof text === 'string' ? text.replace(/\{(\d+)\}/g, (token, slot) => values[Number(slot)] === undefined ? token : String(values[Number(slot)])) : '';
  };
  function translate(value, depth = 0) {
    if (typeof value !== 'string') return value == null ? '' : String(value);
    const exact = bySource.get(value);
    if (exact !== undefined) return keyText(exact);
    if (value.length > 8192 || depth > 2) return value;
    for (const template of templates) {
      const match = template.pattern.exec(value);
      if (!match) continue;
      const values = [];
      template.slots.forEach((slot, index) => { values[slot] = match[index + 1]; });
      // Only nested interface phrases are translated; identifiers and version numbers stay literal.
      const nested = template.source.startsWith('Quét được ') ? [2] : template.source.startsWith('Tên đăng nhập hoặc mật khẩu không đúng.') ? [1] : template.source.startsWith('Đang chuẩn bị {0} OpenCode') || template.source.startsWith('{0} từ ') ? [0] : [];
      for (const slot of nested) values[slot] = translate(values[slot], depth + 1);
      return keyText(template.key, values);
    }
    return value;
  }
  return { t: translate, key: keyText };
}
