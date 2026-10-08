/**
 * /api/app/* body parsing mirrors miniapp_api._read_body():
 *
 *     try: body = await request.json(); return body if isinstance(body, dict) else {}
 *     except Exception: return {}
 *
 * aiohttp's Request.json() ignores the Content-Type, so malformed JSON, a top level that
 * is not an object (string, number, array, null) and a body sent as text/plain all reach
 * the handler as {} — the route answers with its own business error, never with a parser
 * 400. A well-formed object is used whatever the Content-Type says.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const { readBotBody, normalizeEncoding, charsetOf } = nodeRequire('../../services/engine/botBody.js');
const VECTORS = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'bot_body.json'), 'utf8'));

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-app-body.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, app, ts, authService, appRouter, plan;

beforeAll(async () => {
  freshDb();
  db = (await import('../../models/database.js')).default;
  app = (await import('../../server.js')).default;
  ts = (await import('../../services/traderSettingsService.js')).default;
  plan = (await import('../../services/planService.js')).default;
  authService = (await import('../../services/authService.js')).default;
  appRouter = nodeRequire('../../routes/app.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM plan_changes').run();
  db.prepare('DELETE FROM engine_kv').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
  appRouter.resetRateLimits();
});

function makeUser({ pro = false } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const uid = db.prepare('INSERT INTO users (email, password_hash, referral_code, is_admin) VALUES (?, ?, ?, ?)').run(e, 'x', ref, 0).lastInsertRowid;
  if (pro) plan.grantAccess(uid, 30, { actor: 'test' });
  return uid;
}
const H = (uid) => ({ Authorization: 'Bearer ' + authService._signAccessToken(uid) });
const raw = (uid, url, text, type = 'application/json') =>
  request(app).post(url).set(H(uid)).set('Content-Type', type).send(text);

// Bodies the bot reads as {}: malformed, non-object top levels, empty, NaN literal (see server.js note)
const AS_EMPTY = ['not json', '{', '"LEVELS"', '[1]', '[{"strategy":"LEVELS"}]', '42', 'null', 'true', ''];

const ROUTES = [
  // route, expected status/body for {} (the business answer of each handler; _bad() is a 200 in the bot)
  ['/api/app/strategy', 400, { ok: false, error: 'bad_strategy' }],
  ['/api/app/settings', 400, { ok: false, error: 'nothing_to_change' }],
  ['/api/app/lang', 200, { ok: false, error: 'bad_request', message: 'lang' }],
  ['/api/app/profile', 200, { ok: false, error: 'bad_request', message: 'name' }],
];

describe('/api/app body: anything but a JSON object reads as {}', () => {
  for (const [url, status, want] of ROUTES) {
    it(`${url}: {} gives the handler's own answer`, async () => {
      const uid = makeUser();
      const r = await raw(uid, url, '{}');
      expect(r.status).toBe(status);
      expect(r.body).toEqual(want);
    });
    for (const text of AS_EMPTY) {
      it(`${url}: ${JSON.stringify(text)} answers exactly like {}`, async () => {
        const uid = makeUser({ pro: true });
        const r = await raw(uid, url, text);
        expect(r.status).toBe(status);
        expect(r.body).toEqual(want);
      });
    }
  }

  it('Content-Type is ignored: an object sent as text/plain or without a JSON type is used', async () => {
    const uid = makeUser({ pro: true });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/octet-stream']) {
      const r = await raw(uid, '/api/app/lang', '{"lang":"en"}', type);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true, lang: 'en' });
    }
  });

  it('a well-formed object still drives the handler (strategy toggle)', async () => {
    const uid = makeUser({ pro: true });
    const r = await raw(uid, '/api/app/strategy', '{"strategy":"levels","long":true,"short":false}');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.strategy).toBe('LEVELS');
  });

  it('POST settings/all with a non-object body applies nothing and answers ok (empty sections dict)', async () => {
    const uid = makeUser();
    const a = await raw(uid, '/api/app/settings/all', '{}');
    const b = await raw(uid, '/api/app/settings/all', '[1,2]');
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
  });

  it('auth still comes first: no token → 401 whatever the body', async () => {
    const r = await request(app).post('/api/app/strategy').set('Content-Type', 'application/json').send('not json');
    expect(r.status).toBe(401);
  });

  it('routes outside /api/app keep the strict JSON parser', async () => {
    const r = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('not json');
    expect(r.status).toBe(400);
  });
});

// fixtures/bot_body.json: miniapp_api._read_body() on a real aiohttp server (gen_bot_body.py)
const F = { nan: NaN, inf: Infinity, '-inf': -Infinity };
function decodeExpected(v) {
  if (Array.isArray(v)) return v.map(decodeExpected);
  if (v && typeof v === 'object') {
    if ('$f' in v) return v.$f in F ? F[v.$f] : Number(v.$f);
    const o = {};
    for (const [k, x] of v.$o) o[k] = decodeExpected(x);
    return o;
  }
  return v;
}

describe('readBotBody vs the bot on aiohttp (Python 3.11 vectors)', () => {
  it('vectors come from the production Python', () => {
    expect(VECTORS.python.startsWith('3.11.')).toBe(true);
    expect(VECTORS.cases.length).toBe(53);
  });
  for (const c of VECTORS.cases) {
    const label = `${JSON.stringify(Buffer.from(c.hex, 'hex').toString('latin1')).slice(0, 60)} ${c.ctype === null ? '(no type)' : c.ctype}`;
    it(label, () => {
      // the generator sent an empty Content-Type header for "no type"
      expect(readBotBody(Buffer.from(c.hex, 'hex'), c.ctype === null ? '' : c.ctype)).toEqual(decodeExpected(c.result));
    });
  }
  it('charset parsing and Python codec name normalisation', () => {
    expect(charsetOf('application/json; charset="UTF-8"')).toBe('UTF-8');
    expect(charsetOf('application/json;charset=l1')).toBe('l1');
    expect(charsetOf('application/json')).toBe(null);
    expect(normalizeEncoding(' UTF--8 ')).toBe('utf_8');
    expect(normalizeEncoding('ISO 8859-1')).toBe('iso_8859_1');
  });
  it('a non-Buffer (no body) reads as {}', () => {
    expect(readBotBody(undefined, 'application/json')).toEqual({});
    expect(readBotBody({}, 'application/json')).toEqual({});
  });
});

describe('/api/app over HTTP: BOM and invalid bytes read as {}', () => {
  it('UTF-8 BOM before the object → {} (json.loads rejects it)', async () => {
    const uid = makeUser();
    const r = await raw(uid, '/api/app/lang', '﻿{"lang":"en"}');
    expect(r.body).toEqual({ ok: false, error: 'bad_request', message: 'lang' });
  });
  it('invalid UTF-8 → {}; the same bytes with charset=latin-1 decode', async () => {
    const uid = makeUser();
    const bytes = Buffer.from('{"lang":"en","x":"\xff"}', 'latin1');
    const a = await request(app).post('/api/app/lang').set(H(uid)).set('Content-Type', 'application/octet-stream').send(bytes);
    expect(a.body).toEqual({ ok: false, error: 'bad_request', message: 'lang' });
    const b = await request(app).post('/api/app/lang').set(H(uid)).set('Content-Type', 'application/octet-stream; charset=latin-1').send(bytes);
    expect(b.body).toEqual({ ok: true, lang: 'en' });
  });
  it('NaN literal parses (Python json): settings with a NaN toggle is a truthy bool like bool(nan)', async () => {
    const uid = makeUser();
    const r = await raw(uid, '/api/app/settings', '{"send_chart_enabled": NaN}');
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.prefs.send_chart_enabled).toBe(true);
  });
});
