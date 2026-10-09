/**
 * botTransport — the request-body transport of the bot's aiohttp server (bot.py `_health_server`:
 * `web.Application()` with the default client_max_size = 1 MiB, CPython 3.11, aiohttp 3.14 with
 * its C parser, no Brotli / zstandard installed) in front of miniapp_api._read_body() (botBody.js).
 * Mounted on /api/app/* before anything else of that surface, so these answers come first, as
 * aiohttp's do (before the router, before the initData / JWT check):
 *
 *   Content-Encoding (the first header, lower-cased; aiohttp: `enc.lower() in ("gzip", "deflate",
 *   "br", "zstd")`, any other value — x-gzip, "gzip, identity", identity — leaves the bytes as they are)
 *     br / zstd          → 400 text/plain "Can not decode content-encoding: brotli (br). Please install
 *                          `Brotli`" / "... zstandard (zstd). Please install `backports.zstd`" — the
 *                          decoder cannot be built, with or without a body
 *     gzip               → decoded member after member (concatenated members, at most 1024 —
 *                          MAX_DECOMPRESS_MEMBERS), no end-of-stream check: a cut stream gives what
 *                          was decoded; a bad header / CRC / length / data → a read error
 *     deflate            → zlib stream, or raw deflate when the first byte is not a zlib header
 *                          (`chunk[0] & 0xF != 8`), members as for gzip; a stream that does not reach
 *                          its end → 400 text/plain "deflate" (DeflateBuffer.feed_eof); bad data → a
 *                          read error
 *   size: more than 1 MiB of (decoded) body → a read error (Request.read() raises
 *   HTTPRequestEntityTooLarge); a read error is what `_read_body` turns into {} — the handler then
 *   answers with its own business error (`bad_request …`), a 401 without auth, a 404 for an unknown
 *   path: never the site's 413 / 415 / 400 JSON.
 *
 * The site reads at most READ_CAP bytes of an encoded body (MAX_BODY + 1 of a plain one) and
 * discards the rest while the request goes on (aiohttp keeps reading compressed input until the
 * decoded size passes 1 MiB; a compressed body above 4 MiB that still decodes to ≤ 1 MiB exists only
 * when crafted — the site answers it as oversized). The upload of an oversized body keeps flowing to
 * /dev/null like aiohttp's lingering read; Node's requestTimeout bounds it.
 *
 * Vectors: tests/app/fixtures/body_transport.json (tests/app/gen/gen_body_transport.py, the bot's
 * server driven over a socket).
 */

'use strict';

const zlib = require('zlib');

const MAX_BODY = 1024 * 1024;              // aiohttp web.Application(client_max_size=1024**2)
const READ_CAP = 4 * 1024 * 1024;          // encoded bytes the site buffers at most
const MAX_MEMBERS = 1024;                  // aiohttp compression_utils.MAX_DECOMPRESS_MEMBERS
const NO_DECODER = Object.freeze({
  br: 'Can not decode content-encoding: brotli (br). Please install `Brotli`',
  zstd: 'Can not decode content-encoding: zstandard (zstd). Please install `backports.zstd`',
});
const ENCODINGS = Object.freeze(['gzip', 'deflate', 'br', 'zstd']);

class ReadError extends Error {}          // set on the payload → Request.read() raises → _read_body {}
class EofError extends Error {}           // raised by the parser at the end of the body → 400 text

/** The first Content-Encoding header of the request (aiohttp's headers.get), or undefined. */
function firstHeader(req, name) {
  const raw = req.rawHeaders;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) if (String(raw[i]).toLowerCase() === name) return raw[i + 1];
    return undefined;
  }
  const v = req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** 'gzip' | 'deflate' | 'br' | 'zstd' | null (anything else: the body is used as sent). */
function contentEncoding(value) {
  if (value === undefined || value === null) return null;
  const enc = String(value).trim().toLowerCase();
  return ENCODINGS.includes(enc) ? enc : null;
}

// ── CRC-32 (zlib's, for the gzip trailer and header CRC; Node 20 < 20.15 has no zlib.crc32) ──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf, start = 0, end = buf.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * One deflate stream (zlib-wrapped or raw) from the start of `buf`:
 * → { out, used, complete } — complete = the stream reached its end (zlib `eof`); a cut stream
 * gives what decodes so far. Bad data → ReadError; more than `room` bytes of output → ReadError.
 */
function inflateOne(buf, raw, room) {
  const fn = raw ? zlib.inflateRawSync : zlib.inflateSync;
  const opts = { info: true, maxOutputLength: Math.max(1, room) };
  try {
    const r = fn(buf, opts);
    return { out: r.buffer, used: r.engine.bytesWritten, complete: true };
  } catch (e) {
    if (e && e.code === 'Z_BUF_ERROR') {                    // unexpected end of file: cut
      try {
        const r = fn(buf, { ...opts, finishFlush: zlib.constants.Z_SYNC_FLUSH });
        return { out: r.buffer, used: buf.length, complete: false };
      } catch (e2) {
        throw new ReadError(String(e2 && e2.message));
      }
    }
    throw new ReadError(String(e && e.message));          // data error, missing dictionary, > room
  }
}

/**
 * The gzip member header at `pos` the way zlib's inflate (windowBits 16 + 15) reads it:
 * → { end } (offset of the deflate data), { cut: true } (the input ends inside it: zlib waits for
 * more, no error) or a ReadError ("incorrect header check", "unknown compression method",
 * "unknown header flags set", "header crc mismatch").
 */
function gzipHeader(buf, pos) {
  const n = buf.length;
  const CUT = { cut: true };
  if (n - pos < 2) return CUT;
  if (buf[pos] !== 0x1f || buf[pos + 1] !== 0x8b) throw new ReadError('incorrect header check');
  if (n - pos < 4) return CUT;
  const cm = buf[pos + 2];
  const flg = buf[pos + 3];
  if (cm !== 8) throw new ReadError('unknown compression method');
  if (flg & 0xe0) throw new ReadError('unknown header flags set');
  let p = pos + 10;                                         // MTIME (4), XFL, OS
  if (p > n) return CUT;
  if (flg & 0x04) {                                         // FEXTRA
    if (p + 2 > n) return CUT;
    const len = buf.readUInt16LE(p);
    p += 2 + len;
    if (p > n) return CUT;
  }
  for (const bit of [0x08, 0x10]) {                         // FNAME, FCOMMENT: zero-terminated
    if (!(flg & bit)) continue;
    const z = buf.indexOf(0, p);
    if (z === -1) return CUT;
    p = z + 1;
  }
  if (flg & 0x02) {                                         // FHCRC
    if (p + 2 > n) return CUT;
    if (buf.readUInt16LE(p) !== (crc32(buf, pos, p) & 0xffff)) throw new ReadError('header crc mismatch');
    p += 2;
  }
  return { end: p };
}

/** gzip body → Buffer (aiohttp ZLibDecompressor(gzip) + members, no eof check). */
function gunzipBody(buf) {
  const parts = [];
  let produced = 0;
  let pos = 0;
  let members = 0;
  while (pos < buf.length) {
    members += 1;
    if (members > MAX_MEMBERS) throw new ReadError(`Compressed stream has more than ${MAX_MEMBERS} members`);
    const h = gzipHeader(buf, pos);
    if (h.cut) break;
    const m = inflateOne(buf.subarray(h.end), true, MAX_BODY + 1 - produced);
    parts.push(m.out);
    produced += m.out.length;
    if (!m.complete) break;
    const t = h.end + m.used;
    const avail = buf.length - t;
    if (avail >= 4 && buf.readUInt32LE(t) !== crc32(m.out)) throw new ReadError('incorrect data check');
    if (avail >= 8 && buf.readUInt32LE(t + 4) !== (m.out.length >>> 0)) throw new ReadError('incorrect length check');
    if (avail < 8) break;
    pos = t + 8;
  }
  return Buffer.concat(parts);
}

/** deflate body → Buffer (zlib or raw by the first byte; members; a cut stream → EofError). */
function inflateBody(buf) {
  if (!buf.length) return buf;                              // DeflateBuffer.feed_eof: size 0, no check
  const raw = (buf[0] & 0x0f) !== 8;
  const parts = [];
  let produced = 0;
  let pos = 0;
  let members = 0;
  while (pos < buf.length) {
    members += 1;
    if (members > MAX_MEMBERS) throw new ReadError(`Compressed stream has more than ${MAX_MEMBERS} members`);
    const m = inflateOne(buf.subarray(pos), raw, MAX_BODY + 1 - produced);
    parts.push(m.out);
    produced += m.out.length;
    if (!m.complete) throw new EofError('deflate');
    pos += m.used;
  }
  return Buffer.concat(parts);
}

/**
 * The body as `_read_body` gets it: decoded bytes, or an empty buffer for a read error (→ {}).
 * Throws EofError for the parser-level 400.
 */
function decodeBody(buf, encoding) {
  try {
    let out = buf;
    if (encoding === 'gzip') out = gunzipBody(buf);
    else if (encoding === 'deflate') out = inflateBody(buf);
    return out.length > MAX_BODY ? Buffer.alloc(0) : out;
  } catch (e) {
    if (e instanceof EofError) throw e;
    return Buffer.alloc(0);
  }
}

function sendText(res, status, text) {
  res.status(status).set('Content-Type', 'text/plain; charset=utf-8').send(text);
}

/**
 * Express middleware: reads the raw body of every /api/app request (any method, any Content-Type)
 * into req.body as a Buffer the way the bot's server would hand it to `_read_body`, or answers
 * the transport 400 itself. GET handlers never look at it (aiohttp's do not read it either).
 */
function middleware() {
  return function botTransport(req, res, next) {
    const encoding = contentEncoding(firstHeader(req, 'content-encoding'));
    if (encoding === 'br' || encoding === 'zstd') return sendText(res, 400, NO_DECODER[encoding]);
    const cap = encoding ? READ_CAP : MAX_BODY;
    const chunks = [];
    let size = 0;
    let finished = false;
    // how: 'end' (the whole body), 'over' (more than `cap` bytes) or 'abort' (the upload was cut):
    // the last two are read errors → {} like Request.read() raising inside _read_body
    const finish = (how) => {
      if (finished) return undefined;
      finished = true;
      req._body = true;                                     // body-parser's "already read" flag
      let body = Buffer.alloc(0);
      if (how === 'end') {
        try {
          body = decodeBody(Buffer.concat(chunks), encoding);
        } catch (e) {
          if (e instanceof EofError) return sendText(res, 400, e.message);
        }
      }
      chunks.length = 0;
      req.body = body;
      return next();
    };
    if (req.readableEnded || req.complete) return finish('end');
    req.on('data', (c) => {
      if (finished) return undefined;                       // discard the rest (lingering read)
      size += c.length;
      if (size > cap) return finish('over');
      chunks.push(c);
      return undefined;
    });
    req.on('end', () => finish('end'));
    req.on('close', () => { if (!req.complete) finish('abort'); });
    req.on('error', () => finish('abort'));
    return undefined;
  };
}

module.exports = {
  MAX_BODY, READ_CAP, MAX_MEMBERS, NO_DECODER,
  contentEncoding, crc32, gzipHeader, gunzipBody, inflateBody, decodeBody, middleware,
  ReadError, EofError,
};
