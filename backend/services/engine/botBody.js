/**
 * botBody — miniapp_api._read_body() on aiohttp, byte for byte:
 *
 *     async def _read_body(request):
 *         try:
 *             body = await request.json()   # bytes.decode(request.charset or "utf-8"); json.loads
 *             return body if isinstance(body, dict) else {}
 *         except Exception:
 *             return {}
 *
 * aiohttp's Request.json() ignores the Content-Type and only reads its `charset` parameter.
 * The decode is strict (invalid bytes raise) and a UTF-8 BOM stays in the text, where
 * json.loads rejects it. json.loads reads NaN / Infinity / -Infinity literals (pyJsonParse).
 *
 * Charset names resolve like Python's codecs.lookup for the codecs a client can plausibly
 * send (utf-8, utf-8-sig, latin-1, ascii and their aliases). Any other name goes to the WHATWG
 * TextDecoder; an unknown name raises there as LookupError does in Python, so the body is {}.
 */

'use strict';

const { TextDecoder } = require('util');
const { pyJsonParse } = require('./pyjson');
const { pyLower, isAlnumChar } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str.lower() / isalnum()

// encodings.aliases for the codecs below (Python 3.11), keys after normalisation
const UTF8 = new Set(['utf_8', 'utf8', 'u8', 'utf', 'cp65001', 'utf8_ucs2', 'utf8_ucs4']);
const UTF8_SIG = new Set(['utf_8_sig']);
const LATIN1 = new Set(['latin_1', 'iso8859_1', '8859', 'cp819', 'csisolatin1', 'ibm819', 'iso8859',
  'iso_8859_1', 'iso_8859_1_1987', 'iso_ir_100', 'l1', 'latin', 'latin1']);
const ASCII = new Set(['ascii', '646', 'ansi_x3.4_1968', 'ansi_x3.4_1986', 'ansi_x3_4_1968', 'cp367',
  'csascii', 'ibm367', 'iso646_us', 'iso_646.irv_1991', 'iso_ir_6', 'us', 'us_ascii']);

/**
 * encodings.normalize_encoding after lower(): runs of punctuation (not str.isalnum(), not '.') between
 * kept characters → one '_'; a non-ASCII alphanumeric is dropped without counting as punctuation.
 */
function normalizeEncoding(name) {
  let out = '';
  let punct = false;
  for (const c of pyLower(String(name))) {
    const cp = c.codePointAt(0);
    if (c === '.' || isAlnumChar(cp)) {
      if (punct && out) out += '_';
      if (cp < 0x80) out += c;
      punct = false;
    } else {
      punct = true;
    }
  }
  return out;
}

/** request.charset: the `charset` parameter of Content-Type, or null. */
function charsetOf(contentType) {
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(String(contentType || ''));
  if (!m) return null;
  const v = m[1] !== undefined ? m[1] : m[2];
  return v ? v : null;
}

/** bytes.decode(encoding) with errors="strict"; throws where Python raises. */
function decodeStrict(buf, encoding) {
  const n = normalizeEncoding(encoding);
  if (UTF8.has(n)) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  if (UTF8_SIG.has(n)) return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf);
  if (LATIN1.has(n)) return buf.toString('latin1');
  if (ASCII.has(n)) {
    for (const b of buf) if (b > 0x7f) throw new RangeError("'ascii' codec can't decode byte");
    return buf.toString('latin1');
  }
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(buf);
}

/** _read_body(): the parsed JSON object, or {} on any error or a non-object top level. */
function readBotBody(buf, contentType) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return {};
  try {
    const v = pyJsonParse(decodeStrict(buf, charsetOf(contentType) || 'utf-8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (_e) {
    return {};
  }
}

module.exports = { readBotBody, decodeStrict, charsetOf, normalizeEncoding };
