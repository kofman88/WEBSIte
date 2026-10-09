/**
 * /api/public/* against hostile requests through server.js (supertest, real migrations):
 *   • no query parameter or cursor moves the view time: every item / event of every answer was
 *     created at or before V = now − 60 min and carries the archive's published state; crafted
 *     cursors (future view time, a counter beyond the archive, a foreign epoch, zero) only change
 *     new-vs-update, never what is visible; repeated / bracketed / huge params → 400 bad_cursor;
 *   • cache busting does not recompute: junk params give the same body and ETag as the plain URL;
 *   • ETag: weak and strong If-None-Match forms and `*` → 304 with ETag + Cache-Control; errors
 *     (400 / 429 / 503) are no-store without an ETag; other methods are not served;
 *   • levels never leak: no price of any track signal appears in any field of any answer;
 *   • a payload is computed once per minute whatever the parameters (one SQL read of the track).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-public-adversarial.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const T0 = 1_760_000_000;
const H = 3600;
let db; let app; let router; let createPublicTrack; let quietLog; let parseCursor;
const clock = { t: T0 };
let uids = {};
let n = 0;

beforeAll(async () => {
  db = nodeRequire('../../models/database.js');
  app = (await import('../../server.js')).default;
  router = nodeRequire('../../routes/publicLanding.js');
  ({ createPublicTrack } = nodeRequire('../../services/publicTrack/index.js'));
  ({ quietLog } = nodeRequire('./helpers.js'));
  ({ parseCursor } = nodeRequire('../../services/publicTrack/feed.js'));
});

function makeUser(email) {
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return Number(db.prepare("INSERT INTO users (email, password_hash, referral_code, locale) VALUES (?, 'x', ?, 'ru')").run(email, ref).lastInsertRowid);
}

/** A paper signal with distinctive prices (none of them may ever appear in an answer). */
function signal(userId, over = {}) {
  n += 1;
  const base = 70000 + n * 37.13;
  const row = {
    trade_id: `${userId}_${T0 * 1000 + n}_${100 + n}`, user_id: userId, symbol: ['BTC', 'ETH', 'SOL'][n % 3] + '-USDT-SWAP',
    direction: n % 2 ? 'LONG' : 'SHORT', entry: base, sl: base * (n % 2 ? 0.987 : 1.013), original_sl: base * (n % 2 ? 0.987 : 1.013),
    tp1: base * (n % 2 ? 1.021 : 0.979), tp2: base * (n % 2 ? 1.034 : 0.966), tp3: base * (n % 2 ? 1.052 : 0.948), timeframe: '1h',
    strategy: ['LEVELS', 'SMC', 'VOLUME'][n % 3], created_at: T0 + n * 600, signal_msg_id: 900 + n, progress_stage: '', progress_ts: 0,
    order_id: '', exchange: 'bybit', ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  return row;
}

let reads = 0;
beforeEach(() => {
  for (const t of ['signal_trades', 'trader_settings', 'notifications', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  try { db.prepare('DELETE FROM public_track').run(); } catch (_e) { /* created by the first track */ }
  uids = { sys: makeUser('sys@chm.local'), alts: makeUser('alts@chm.local') };
  clock.t = T0;
  reads = 0;
  n = 0;
  const counting = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql) => { if (/FROM signal_trades/.test(sql)) reads += 1; return target.prepare(sql); };
      }
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  router.setTrack(createPublicTrack({
    db: counting, now: () => clock.t, log: quietLog,
    env: { PUBLIC_TRACK_USER_IDS: `${uids.sys},${uids.alts}:alts`, JWT_SECRET: process.env.JWT_SECRET, PUBLIC_API_RATE_PER_MIN: '0' },
    trend: { compute: async () => ({ empty: true, reason: 'x' }) },
  }));
  router.setClock(() => clock.t);
});

/** 40 signals over ~7 h with stages recorded on the way; returns the rows. */
function seedHistory() {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    const r = signal(i % 2 ? uids.sys : uids.alts);
    rows.push(r);
    const stage = ['TP1', 'SL', 'TP3', '', 'BE', 'TP2'][i % 6];
    if (stage) db.prepare('UPDATE signal_trades SET progress_stage = ?, progress_ts = ? WHERE trade_id = ?').run(stage, r.created_at + 900, r.trade_id);
  }
  return rows;
}

function publishedById() {
  const m = new Map();
  for (const r of db.prepare('SELECT pub_id, created_at, status, path, r FROM public_track WHERE appear_seq IS NOT NULL').all()) {
    m.set(r.pub_id, { created_at: r.created_at, status: r.status, path: JSON.parse(r.path), r: r.r });
  }
  return m;
}

function checkVisible(answer, V) {
  const pub = publishedById();
  const items = answer.items || [];
  for (const e of answer.events || []) items.push(e.type === 'new' ? e.item : e);
  for (const it of items) {
    const p = pub.get(it.id);
    expect(p, `unpublished ${it.id}`).toBeTruthy();
    expect(p.created_at).toBeLessThanOrEqual(V);
    if (it.t !== undefined) expect(it.t).toBeLessThanOrEqual(V * 1000);
    expect({ status: it.status, path: it.path, r: it.r }).toEqual({ status: p.status, path: p.path, r: p.r });
  }
  return items.length;
}

describe('the delay cannot be moved by a parameter or a cursor', () => {
  it('crafted cursors and junk params only ever return published, delayed states', async () => {
    seedHistory();
    clock.t = T0 + 5 * H;
    const page = (await request(app).get('/api/public/feed')).body;
    const V = clock.t - H;
    expect(checkVisible(page, V)).toBeGreaterThan(5);
    const { epoch, seq } = parseCursor(page.cursor);
    const future = Math.floor(clock.t + 365 * 86400);
    const cursors = [
      `${epoch}.0.0`, `${epoch}.0.${future}`, `${epoch}.${seq}.${future}`, `${epoch}.${seq + 1}.${clock.t}`,
      `${epoch}.999999999999999.${future}`, `zzzz.0.0`, `zzzz.${seq}.${future}`, `zzzz.0.999999999999`, `${epoch}.${seq}.0`,
    ];
    let seen = 0;
    for (const after of cursors) {
      for (const extra of [{}, { delay: 0, now: future, v: future, tick: 1 }]) {
        const r = await request(app).get('/api/public/feed').query({ after, ...extra });
        expect(r.status, after).toBe(200);
        seen += checkVisible(r.body, V);
        expect(parseCursor(r.body.cursor).v).toBe(Math.floor(V));
        expect(r.body.updated_at).toBe(Math.floor(V * 1000));
      }
    }
    expect(seen).toBeGreaterThan(20);
    // later signals stay invisible however the cursor is built
    const late = signal(uids.sys, { created_at: clock.t - 10 * 60 });
    clock.t += 61;
    for (const after of cursors) {
      const r = await request(app).get('/api/public/feed').query({ after });
      const ids = (r.body.events || []).map((e) => (e.type === 'new' ? e.item.t : null)).filter((x) => x !== null);
      expect(ids).not.toContain(late.created_at * 1000);
    }
  });

  it('junk params on the first page / stats: same body and ETag as the plain URL, no recomputation', async () => {
    seedHistory();
    clock.t = T0 + 5 * H;
    for (const p of ['feed', 'stats']) {
      const plain = await request(app).get(`/api/public/${p}`);
      const readsAfterFirst = reads;
      for (const q of [{ delay: 0 }, { now: T0 + 99 * H }, { v: 1 }, { nocache: Math.random() }, { 'after[]': 'x' }].slice(0, p === 'feed' ? 4 : 5)) {
        const r = await request(app).get(`/api/public/${p}`).query(q);
        expect(r.status).toBe(200);
        expect(r.text).toBe(plain.text);
        expect(r.headers.etag).toBe(plain.headers.etag);
      }
      expect(reads).toBe(readsAfterFirst);
    }
  });

  it('malformed cursors → 400 bad_cursor, no-store, no ETag', async () => {
    clock.t = T0 + 5 * H;
    const bad = ['', 'x', 'a.1', 'A.1.2', 'a.-1.2', 'a.1.2.3', 'a.1.2 ', ' a.1.2', 'a.1.1e3', 'a.0x1.2', `a.${'9'.repeat(16)}.1`,
      `a.1.${'9'.repeat(13)}`, `${'a'.repeat(17)}.1.2`, 'ä.1.2', 'a.1.2%00', 'a..2'];
    for (const after of bad) {
      const r = await request(app).get('/api/public/feed').query({ after });
      expect(r.status, JSON.stringify(after)).toBe(400);
      expect(r.body).toEqual({ error: 'bad_cursor' });
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers.etag).toBeUndefined();
    }
    for (const qs of ['after=a.1.2&after=a.1.3', 'after[]=a.1.2', 'after[x]=1', `after=${'a'.repeat(8000)}`]) {
      const r = await request(app).get(`/api/public/feed?${qs}`);
      expect(r.status, qs.slice(0, 40)).toBe(400);
      expect(r.body).toEqual({ error: 'bad_cursor' });
    }
    // a request line past Node's 16 KiB header limit never reaches a handler
    const huge = await request(app).get(`/api/public/feed?after=${'a'.repeat(20000)}`);
    expect(huge.status).toBe(431);
  });
});

describe('cache and ETag', () => {
  it('If-None-Match: weak, strong form, a list and * → 304 carrying ETag and Cache-Control; a stale tag → 200', async () => {
    seedHistory();
    clock.t = T0 + 5 * H;
    for (const p of ['feed', 'stats', 'trend']) {
      const first = await request(app).get(`/api/public/${p}`);
      const tag = first.headers.etag;
      expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
      expect(first.headers['cache-control']).toBe('public, max-age=30');
      for (const inm of [tag, tag.slice(2), `"nope", ${tag}`, '*']) {
        const r = await request(app).get(`/api/public/${p}`).set('If-None-Match', inm);
        expect(r.status, `${p} ${inm}`).toBe(304);
        expect(r.headers.etag).toBe(tag);
        expect(r.headers['cache-control']).toBe('public, max-age=30');
        expect(r.text).toBe('');
      }
      const stale = await request(app).get(`/api/public/${p}`).set('If-None-Match', 'W/"stale"');
      expect(stale.status).toBe(200);
    }
  });

  it('within the minute nothing changes; after it a changed track gets a new ETag', async () => {
    seedHistory();
    clock.t = T0 + 5 * H;
    const a = await request(app).get('/api/public/feed');
    signal(uids.sys, { created_at: T0 + 3 * H });
    clock.t += 59;
    const b = await request(app).get('/api/public/feed');
    expect(b.headers.etag).toBe(a.headers.etag);
    clock.t += 2;
    const c = await request(app).get('/api/public/feed');
    expect(c.headers.etag).not.toBe(a.headers.etag);
    expect(c.body.items.length).toBe(Math.min(20, a.body.items.length + 1));
  });

  it('only GET / HEAD are served; HEAD carries the ETag and no body', async () => {
    seedHistory();
    clock.t = T0 + 5 * H;
    const h = await request(app).head('/api/public/feed');
    expect(h.status).toBe(200);
    expect(h.headers.etag).toMatch(/^W\//);
    expect(h.text === undefined || h.text === '').toBe(true);
    for (const m of ['post', 'put', 'delete', 'patch']) {
      const r = await request(app)[m]('/api/public/feed').send({ after: 'x' });
      expect(r.status, m).toBe(404);
      expect(r.headers.etag).toBeUndefined();
    }
  });
});

describe('levels never leak', () => {
  it('no price of any signal (entry, sl, tps, as printed or rounded) in any answer', async () => {
    const rows = seedHistory();
    clock.t = T0 + 9 * H;
    const page = (await request(app).get('/api/public/feed')).body;
    const answers = [JSON.stringify(page), (await request(app).get('/api/public/stats')).text,
      (await request(app).get('/api/public/feed').query({ after: page.cursor.replace(/\.\d+\./, '.0.') })).text,
      (await request(app).get('/api/public/feed').query({ after: 'zzzz.0.0' })).text];
    const all = answers.join('\n');
    const numbers = new Set((all.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi) || []).map(Number));
    for (const r of rows) {
      for (const k of ['entry', 'sl', 'original_sl', 'tp1', 'tp2', 'tp3']) {
        const v = r[k];
        for (const cand of [v, Math.round(v), Math.round(v * 100) / 100, Math.round(v * 10) / 10, Math.floor(v)]) {
          expect(numbers.has(cand), `${r.trade_id} ${k}=${v} leaked as ${cand}`).toBe(false);
        }
      }
    }
    for (const it of page.items) expect(Object.keys(it)).toEqual(['id', 't', 'pair', 'bot_id', 'strategy', 'strategy_name', 'tf', 'side', 'status', 'path', 'r']);
  });
});
