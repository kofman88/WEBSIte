/**
 * cards/html — Python `html.escape(s, quote=True)`, `str()` of the values a card
 * prints, the cards' `_fp(v)` wrapper and the i18n-style `t()` the card modules use.
 */

'use strict';

const { fp: fpNumber, fmtFixed, fmtG, pyRepr } = require('../../../strategies/common/pyfmt');
const { pyFloat } = require('../pycoerce');

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
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** str(v) for the scalars a card prints (int → "7", float → repr, None/True/False). */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) < 1e16 && !Object.is(v, -0) ? String(v) : pyRepr(v);
  return String(v);
}

/**
 * The LEVELS / SMC / lite `_fp(v)`: `float(v)` failing (None, non-numeric string)
 * → `str(v)`; otherwise the adaptive price format (NaN raises from math.floor like
 * in the bot).
 */
function cardFp(v) {
  let x;
  try {
    x = typeof v === 'number' ? v : pyFloat(v);
  } catch (_e) {
    return pyStr(v);
  }
  return fpNumber(x);
}

/** str.format field with an optional `:.Nf` / `:g` spec (the specs the bot's i18n strings use). */
function formatField(value, spec) {
  if (!spec) return pyStr(value);
  const m = /^\.(\d+)f$/.exec(spec);
  if (m) return fmtFixed(Number(value), Number(m[1]));
  if (spec === 'g') return fmtG(Number(value), 6);
  throw new Error(`unsupported format spec :${spec}`);
}

/**
 * i18n.t(key, lang, **kwargs): MESSAGES[key][lang] → MESSAGES[key]["ru"] → key;
 * `{name}` / `{name:.1f}` placeholders filled from kwargs; any formatting error
 * (missing name, bad spec) → the raw text, like the bot's `except Exception: return text`.
 */
function makeT(messages) {
  return function t(key, lang = 'ru', kwargs = null) {
    const entry = messages[key];
    if (!entry) return key;
    const text = entry[lang] || entry.ru || key;
    if (!kwargs || !Object.keys(kwargs).length) return text;
    try {
      return text.replace(/\{(\w+)(?::([^}]*))?\}/g, (_m, name, spec) => {
        if (!Object.prototype.hasOwnProperty.call(kwargs, name)) throw new Error(`KeyError: ${name}`);
        return formatField(kwargs[name], spec);
      });
    } catch (_e) {
      return text;
    }
  };
}

/** `"x" * n` for n possibly ≤ 0. */
function repeat(s, n) {
  return n > 0 ? s.repeat(n) : '';
}

module.exports = { escape, pyTruthy, pyStr, cardFp, makeT, repeat };
