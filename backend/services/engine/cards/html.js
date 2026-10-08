/**
 * cards/html — Python `html.escape(s, quote=True)` and the i18n-style string
 * helpers shared by the card renderers.
 */

'use strict';

/** html.escape(s): & < > " ' → entities (quote=True default). */
function escape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Python truthiness for the values a signal object carries (NaN is truthy like in Python). */
function pyTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * i18n.t(key, lang, **kwargs): MESSAGES[key][lang] → MESSAGES[key]["ru"] → key;
 * `{name}` placeholders filled from kwargs (a missing placeholder → the raw text,
 * like the bot's `except Exception: return text`).
 */
function makeT(messages) {
  return function t(key, lang = 'ru', kwargs = null) {
    const entry = messages[key];
    if (!entry) return key;
    const text = entry[lang] || entry.ru || key;
    if (!kwargs) return text;
    let missing = false;
    const out = text.replace(/\{(\w+)(?::[^}]*)?\}/g, (m, name) => {
      if (!Object.prototype.hasOwnProperty.call(kwargs, name)) { missing = true; return m; }
      return String(kwargs[name]);
    });
    return missing ? text : out;
  };
}

/** `"x" * n` for n possibly ≤ 0. */
function repeat(s, n) {
  return n > 0 ? s.repeat(n) : '';
}

module.exports = { escape, pyTruthy, makeT, repeat };
