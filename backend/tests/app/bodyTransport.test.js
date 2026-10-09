/**
 * /api/app request-body transport = the bot's aiohttp server (services/engine/botTransport.js):
 * every case of tests/app/fixtures/body_transport.json (gen_body_transport.py: the bot's
 * miniapp_api served by aiohttp 3.14 / CPython 3.11, requests written byte for byte over a socket)
 * is replayed against the site with the same bytes — status, Content-Type family and body equal.
 *
 * Covers the 1 MiB client_max_size (Content-Length and chunked, decoded size for gzip), the order
 * (an oversized body is {} for the handler: 401 without auth, 404 on an unknown path, a business
 * error on the route — never a 413), gzip / deflate / raw deflate decoding with members, cut
 * streams, bad CRCs and garbage, the transport 400s (br / zstd without decoder, a cut deflate
 * stream), and a body on a GET.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import zlib from 'zlib';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const FIX = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'body_transport.json'), 'utf8'));

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-app-transport.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

let server; let port; let token; let db; let ts; let appRouter;
const UID = 4242;

beforeAll(async () => {
  db = nodeRequire('../../models/database.js');
  const app = (await import('../../server.js')).default;
  ts = nodeRequire('../../services/traderSettingsService.js');
  appRouter = nodeRequire('../../routes/app.js');
  const authService = nodeRequire('../../services/authService.js');
  db.prepare('INSERT INTO users (id, email, password_hash, referral_code) VALUES (?, ?, ?, ?)').run(UID, 't@x.test', 'x', 'RT1');
  ts.getOrCreate(UID);
  token = authService._signAccessToken(UID);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function padded(total) {
  const head = Buffer.from('{"lang":"en","pad":"');
  const tail = Buffer.from('"}');
  return Buffer.concat([head, Buffer.alloc(total - head.length - tail.length, 'x'), tail]);
}

function bodyOf(c) {
  if (c.body_b64 !== null) return Buffer.from(c.body_b64, 'base64');
  const b = padded(c.body_gen.padded);
  return c.body_gen.gzip ? zlib.gzipSync(b) : b;
}

function chunked(b, size = 65536) {
  const parts = [];
  for (let i = 0; i < b.length; i += size) {
    const p = b.subarray(i, i + size);
    parts.push(Buffer.from(`${p.length.toString(16)}\r\n`), p, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from('0\r\n\r\n'));
  return Buffer.concat(parts);
}

/** One request written byte for byte (Connection: close), read to EOF → { status, contentType, text }. */
function send({ method, target, headers, body, transfer }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const lines = [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close', ...headers.map(([k, v]) => `${k}: ${v}`)];
    let payload = Buffer.alloc(0);
    if (transfer === 'length') { lines.push(`Content-Length: ${body.length}`); payload = body; }
    if (transfer === 'chunked') { lines.push('Transfer-Encoding: chunked'); payload = chunked(body); }
    const out = [];
    sock.on('data', (c) => out.push(c));
    sock.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? null : reject(e)));
    sock.on('close', () => {
      const raw = Buffer.concat(out);
      const sep = raw.indexOf('\r\n\r\n');
      const head = raw.subarray(0, sep).toString('latin1').split('\r\n');
      const hdrs = {};
      for (const ln of head.slice(1)) { const i = ln.indexOf(':'); hdrs[ln.slice(0, i).trim().toLowerCase()] = ln.slice(i + 1).trim(); }
      let rest = raw.subarray(sep + 4);
      if (hdrs['transfer-encoding'] === 'chunked') {
        const parts = [];
        for (;;) {
          const e = rest.indexOf('\r\n');
          const n = parseInt(rest.subarray(0, e).toString('latin1'), 16);
          if (!n) break;
          parts.push(rest.subarray(e + 2, e + 2 + n));
          rest = rest.subarray(e + 2 + n + 2);
        }
        rest = Buffer.concat(parts);
      }
      resolve({ status: Number((head[0] || '').split(' ')[1]), contentType: hdrs['content-type'] || '', text: rest.toString('utf8') });
    });
    sock.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1'), payload]));
  });
}

const family = (ct) => String(ct).split(';')[0].trim();

describe('the bot transport vectors (aiohttp 3.14, CPython 3.11)', () => {
  it('fixture provenance', () => {
    expect(FIX.python.startsWith('3.11.')).toBe(true);
    expect(FIX.client_max_size).toBe(1024 * 1024);
    expect(FIX.cases.length).toBeGreaterThan(100);
  });

  for (const c of FIX.cases) {
    it(`${c.name}: ${c.method} ${c.path} → ${c.expected.status}`, async () => {
      const u = ts.getOrCreate(UID);
      u.lang = 'ru';                     // the bot's fake user is a fresh Russian user every request
      ts.save(u);
      appRouter.resetRateLimits();
      const headers = c.headers.slice();
      if (c.auth) headers.push(['Authorization', `Bearer ${token}`]);
      const r = await send({ method: c.method, target: `/api/app${c.path}`, headers, body: bodyOf(c), transfer: c.transfer });
      expect(r.status).toBe(c.expected.status);
      expect(family(r.contentType)).toBe(family(c.expected.content_type));
      if (c.expected.json !== null) expect(JSON.parse(r.text)).toEqual(c.expected.json);
      else expect(r.text).toBe(c.expected.text);
    }, 20000);
  }
});

describe('transport bounds', () => {
  it('an oversized upload is answered while it is still being sent; nothing is buffered past the cap', async () => {
    const T = nodeRequire('../../services/engine/botTransport.js');
    const r = await send({ method: 'POST', target: '/api/app/lang', headers: [['Authorization', `Bearer ${token}`]], body: padded(8 * 1024 * 1024), transfer: 'length' });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: false, error: 'bad_request', message: 'lang' });
    expect(T.MAX_BODY).toBe(1048576);
  }, 30000);

  it('a gzip bomb is cut at 1 MiB + 1 of output (maxOutputLength), not inflated in full', () => {
    const T = nodeRequire('../../services/engine/botTransport.js');
    const bomb = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(T.READ_CAP);
    const t0 = process.hrtime.bigint();
    expect(T.decodeBody(bomb, 'gzip').length).toBe(0);
    expect(T.decodeBody(zlib.deflateSync(Buffer.alloc(64 * 1024 * 1024, 0x20)), 'deflate').length).toBe(0);
    expect(Number(process.hrtime.bigint() - t0) / 1e6).toBeLessThan(2000);
  });

  it('JSON nesting: the depth json.loads reaches on the bot\'s route (RecursionError past it → {})', () => {
    const { MAX_JSON_DEPTH, jsonDepth } = nodeRequire('../../services/engine/botBody.js');
    expect(FIX.recursion_limit).toBe(1000);
    expect(MAX_JSON_DEPTH).toBe(FIX.json_nested_ok_max.array + 1);      // + the top-level object
    expect(MAX_JSON_DEPTH).toBe(FIX.json_nested_ok_max.object + 1);
    expect(2 * FIX.json_nested_ok_max.mixed + 1).toBeLessThanOrEqual(MAX_JSON_DEPTH);
    expect(2 * (FIX.json_nested_ok_max.mixed + 1) + 1).toBeGreaterThan(MAX_JSON_DEPTH);
    expect(jsonDepth('{"a":"[[[[{{{{","b":[{"c":"\\\\\\"[["}]}')).toBe(3);
    expect(jsonDepth('[]{}')).toBe(1);
  });

  it('crc32 is zlib\'s', () => {
    const T = nodeRequire('../../services/engine/botTransport.js');
    expect(T.crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    expect(T.crc32(Buffer.alloc(0))).toBe(0);
  });
});
