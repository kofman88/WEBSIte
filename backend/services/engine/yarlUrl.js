'use strict';
/**
 * yarlUrl.js — how the bot's aiohttp 3.14 / yarl 1.25 server reads a request target, so the
 * site's /api/app data routes see the same trade id and the same query values for any raw URL
 * (the server routes the raw path as sent: no dot-segment folding):
 *
 *   unquote(s, opts)          yarl _Unquoter (_quoting_py.py / _quoting_c.pyx): %XX in either
 *                             case → byte, bytes → strict UTF-8 (CPython table 3-7: no overlong
 *                             forms, no surrogates, ≤ U+10FFFF); an escape that is not valid
 *                             UTF-8 is kept as written (or U+FFFD with `replaceInvalid`), a '%'
 *                             that starts no escape stays; `plus` turns '+' into ' '; `ignore`
 *                             ASCII characters are written back as their upper-case escape
 *   pathSafe(raw)             URL.path_safe = PATH_SAFE_UNQUOTER (ignore "/%"): what the router
 *                             matches the dynamic resources against
 *   unquotePathSafe(v)        web_urldispatcher._unquote_path_safe: the match_info value
 *   matchDynamic(path, re)    DynamicResource._match: fullmatch on path_safe + unquote the groups
 *   queryToPairs(raw)         yarl query_to_pairs = urllib.parse.parse_qsl(keep_blank_values=True):
 *                             split on '&' only (';' is data), empty fields skipped, partition on
 *                             the first '=', UNQUOTER_PLUS (+ → space, invalid UTF-8 → U+FFFD)
 *   queryGet(pairs, k, d)     MultiDictProxy.get: the FIRST value of the key, else the default
 *   rawQuery(url)             the query part of req.originalUrl (fragment dropped like yarl)
 */

const HEX = (c) => {
  const x = c.charCodeAt(0);
  if (x >= 48 && x <= 57) return x - 48;
  if (x >= 65 && x <= 70) return x - 55;
  if (x >= 97 && x <= 102) return x - 87;
  return -1;
};

/** _PCT_BYTES.get(val[pos+1:pos+3]): two hex digits right after the '%', else null. */
function pctByte(s, pos) {
  if (pos + 2 > s.length - 1) return null;
  const a = HEX(s[pos + 1]);
  const b = HEX(s[pos + 2]);
  if (a < 0 || b < 0) return null;
  return a * 16 + b;
}

// _UTF8_LEADS: lead byte → [need, low, high, payload]
const LEADS = new Map();
for (let b = 0xc2; b < 0xe0; b++) LEADS.set(b, [2, 0x80, 0xbf, 0x1f]);
LEADS.set(0xe0, [3, 0xa0, 0xbf, 0x0f]);
for (let b = 0xe1; b < 0xed; b++) LEADS.set(b, [3, 0x80, 0xbf, 0x0f]);
LEADS.set(0xee, [3, 0x80, 0xbf, 0x0f]);
LEADS.set(0xef, [3, 0x80, 0xbf, 0x0f]);
LEADS.set(0xed, [3, 0x80, 0x9f, 0x0f]);
LEADS.set(0xf0, [4, 0x90, 0xbf, 0x07]);
for (let b = 0xf1; b < 0xf4; b++) LEADS.set(b, [4, 0x80, 0xbf, 0x07]);
LEADS.set(0xf4, [4, 0x80, 0x8f, 0x07]);

/** yarl _Unquoter(ignore=…, qs=False, plus=…, replace_invalid=…)(val) — the pure-Python algorithm. */
function unquote(val, { ignore = '', plus = false, replaceInvalid = false } = {}) {
  let s = String(val);
  if (!s) return '';
  if (plus && s.includes('+')) s = s.split('+').join(' ');
  let pos = s.indexOf('%');
  if (pos === -1) return s;
  const keep = new Set(Array.from(ignore));
  const invalid = replaceInvalid ? '�' : '';
  const ret = [];
  let pending = 0; let pendingStart = 0; let codePoint = 0; let need = 0; let low = 0; let high = 0;
  let idx = 0;
  while (pos !== -1) {
    const byte = pctByte(s, pos);
    if (pending && (pos > idx || byte === null || !(low <= byte && byte <= high))) {
      ret.push(invalid || s.slice(pendingStart, idx));
      pending = 0;
    }
    if (pos > idx) ret.push(s.slice(idx, pos));
    if (byte === null) {
      idx = pos;
      pos = s.indexOf('%', pos + 1);
      continue;
    }
    idx = pos + 3;
    if (pending) {
      codePoint = (codePoint << 6) | (byte & 0x3f);
      pending += 1;
      low = 0x80; high = 0xbf;
      if (pending === need) {
        ret.push(String.fromCodePoint(codePoint));
        pending = 0;
      }
    } else if (byte < 0x80) {
      const ch = String.fromCharCode(byte);
      ret.push(keep.has(ch) ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}` : ch);
    } else if (LEADS.has(byte)) {
      const lead = LEADS.get(byte);
      [need, low, high] = lead;
      codePoint = byte & lead[3];
      pending = 1;
      pendingStart = pos;
    } else {
      ret.push(invalid || s.slice(pos, idx));
    }
    pos = s.indexOf('%', idx);
  }
  if (pending) ret.push(invalid || s.slice(pendingStart, idx));
  ret.push(s.slice(idx));
  return ret.join('');
}

/** URL.path_safe — '/' and '%' stay escaped (as %2F / %25), everything else is decoded. */
function pathSafe(rawPath) {
  return unquote(rawPath, { ignore: '/%' });
}

/** web_urldispatcher._unquote_path_safe */
function unquotePathSafe(value) {
  const v = String(value);
  if (!v.includes('%')) return v;
  return v.split('%2F').join('/').split('%25').join('%');
}

/**
 * DynamicResource._match: `re` must be anchored (^…$) over the path_safe form; every group is
 * a `{name}` placeholder ([^{}/]+). Returns the unquoted groups or null.
 */
function matchDynamic(safePath, re) {
  const m = re.exec(safePath);
  if (!m) return null;
  return m.slice(1).map(unquotePathSafe);
}

const UNQUOTE_PLUS = { plus: true, replaceInvalid: true };

/** yarl query_to_pairs (== urllib.parse.parse_qsl(qs, keep_blank_values=True)). */
function queryToPairs(qs) {
  const s = String(qs || '');
  if (!s) return [];
  const pairs = [];
  const decode = s.includes('%');
  for (const nameValue of s.split('&')) {
    if (!nameValue) continue;
    const eq = nameValue.indexOf('=');
    let name = eq === -1 ? nameValue : nameValue.slice(0, eq);
    let value = eq === -1 ? '' : nameValue.slice(eq + 1);
    if (decode) {
      name = unquote(name, UNQUOTE_PLUS);
      value = unquote(value, UNQUOTE_PLUS);
    } else {
      name = name.split('+').join(' ');
      value = value.split('+').join(' ');
    }
    pairs.push([name, value]);
  }
  return pairs;
}

/** MultiDictProxy.get(key, default) — the first pair with that key. */
function queryGet(pairs, key, dflt) {
  for (const [k, v] of pairs) if (k === key) return v;
  return dflt;
}

/** The raw query string of an Express request (originalUrl after the first '?', fragment dropped). */
function rawQuery(originalUrl) {
  const u = String(originalUrl || '');
  const q = u.indexOf('?');
  if (q === -1) return '';
  let s = u.slice(q + 1);
  const h = s.indexOf('#');
  if (h !== -1) s = s.slice(0, h);
  return s;
}

/** The raw path of an Express request relative to its router (req.url without the query / fragment). */
function rawPath(url) {
  let s = String(url || '');
  const h = s.indexOf('#');
  if (h !== -1) s = s.slice(0, h);
  const q = s.indexOf('?');
  return q === -1 ? s : s.slice(0, q);
}

module.exports = { unquote, pathSafe, unquotePathSafe, matchDynamic, queryToPairs, queryGet, rawQuery, rawPath };
