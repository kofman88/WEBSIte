/**
 * /api/public/{trend,stats,feed} through server.js (supertest, the site's real DB + migrations):
 * mounting next to the existing public routes, the JSON contract, ETag / 304, Cache-Control,
 * the per-IP rate limit, bad cursors, failures, and no personal data in any answer.
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
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-public-landing.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const T0 = 1_760_000_000;
const H = 3600;
let db; let app; let router; let createPublicTrack; let quietLog;
const clock = { t: T0 };
let trendImpl = async () => ({ empty: true, reason: 'Тренд BTC появится после запуска монитора' });

beforeAll(async () => {
  db = nodeRequire('../../models/database.js');
  app = (await import('../../server.js')).default;
  router = nodeRequire('../../routes/publicLanding.js');
  ({ createPublicTrack } = nodeRequire('../../services/publicTrack/index.js'));
  ({ quietLog } = nodeRequire('./helpers.js'));
});

let uids = {};
function makeUser(email) {
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return Number(db.prepare("INSERT INTO users (email, password_hash, referral_code, locale) VALUES (?, 'x', ?, 'ru')").run(email, ref).lastInsertRowid);
}
let n = 0;
function signal(userId, over = {}) {
  n += 1;
  const row = {
    trade_id: `${userId}_${T0 * 1000 + n}_${100 + n}`, user_id: userId, symbol: 'BTC-USDT-SWAP', direction: 'LONG',
    entry: 61234.5, sl: 60001.25, original_sl: 60001.25, tp1: 63111.75, tp2: 64222.5, tp3: 65333.25, timeframe: '1h',
    strategy: 'LEVELS', created_at: T0 + n, signal_msg_id: 500 + n, progress_stage: '', progress_ts: 0, order_id: '', exchange: 'bingx',
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  return row;
}

beforeEach(() => {
  for (const t of ['signal_trades', 'trader_settings', 'notifications', 'users']) db.prepare(`DELETE FROM ${t}`).run();
  try { db.prepare('DELETE FROM public_track').run(); } catch (_e) { /* created by the first track */ }
  uids = { sys: makeUser('track-system@chm.local'), alts: makeUser('track-alts@chm.local'), person: makeUser('real.person@example.com') };
  clock.t = T0;
  trendImpl = async () => ({ empty: true, reason: 'Тренд BTC появится после запуска монитора' });
  router.setTrack(createPublicTrack({
    db, now: () => clock.t, log: quietLog,
    env: { PUBLIC_TRACK_USER_IDS: `${uids.sys},${uids.alts}:alts`, JWT_SECRET: process.env.JWT_SECRET, PUBLIC_API_RATE_PER_MIN: '60' },
    trend: { compute: () => trendImpl() },
  }));
  router.setClock(() => clock.t);
});

describe('mounting', () => {
  it('serves the three paths without auth; the other /api/public paths still 404 as before', async () => {
    for (const p of ['trend', 'stats', 'feed']) {
      const res = await request(app).get(`/api/public/${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body.empty).toBe(true);
    }
    for (const p of ['showcase', 'sandbox', 'genome', 'leaderboard']) {
      const res = await request(app).get(`/api/public/${p}`);
      expect(res.status, p).toBe(404);
      expect(res.body).toEqual({ error: 'Route not found', code: 'NOT_FOUND' });
    }
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/app/me')).status).toBe(401);
  });

  it('empty payloads are the README ones', async () => {
    expect((await request(app).get('/api/public/stats')).body).toEqual({ empty: true, reason: 'Статистика появится после 30 закрытых сигналов' });
    expect((await request(app).get('/api/public/trend')).body).toEqual({ empty: true, reason: 'Тренд BTC появится после запуска монитора' });
    expect((await request(app).get('/api/public/feed')).body.empty).toBe(true);
  });
});

describe('feed over HTTP', () => {
  it('page, cursor poll, Cache-Control, ETag and 304', async () => {
    const a = signal(uids.sys);
    signal(uids.person, { symbol: 'XRP-USDT-SWAP' });
    clock.t = T0 + 2 * H;
    const res = await request(app).get('/api/public/feed');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(res.headers.etag).toMatch(/^W\/"/);
    expect(res.body).toMatchObject({ delay_min: 60, levels_hidden: true, source: 'paper' });
    expect(res.body.items.map((x) => x.pair)).toEqual(['BTC/USDT']);
    const again = await request(app).get('/api/public/feed').set('If-None-Match', res.headers.etag);
    expect(again.status).toBe(304);
    expect(again.text).toBe('');
    db.prepare("UPDATE signal_trades SET progress_stage = 'SL', progress_ts = ? WHERE trade_id = ?").run(clock.t - 60, a.trade_id);
    clock.t += 60;
    await request(app).get('/api/public/stats');            // the minute's refresh sees SL
    clock.t += H;
    const poll = await request(app).get('/api/public/feed').query({ after: res.body.cursor });
    expect(poll.status).toBe(200);
    expect(poll.body.events).toEqual([{ type: 'update', id: res.body.items[0].id, status: 'sl', path: ['open', 'sl'], r: expect.any(Number) }]);
    expect(poll.body.events[0].r).toBeLessThan(-1);         // −1 R − fees
  });

  it('malformed cursors → 400 bad_cursor', async () => {
    for (const q of ['after=', 'after=nope', 'after[]=a.1.2', 'after[x]=1', 'after=a.1.2&after=b.1.2']) {
      const res = await request(app).get(`/api/public/feed?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body).toEqual({ error: 'bad_cursor' });
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('a failing track → 503, not a stack trace', async () => {
    router.setTrack({ config: { ratePerMin: 60 }, feed() { throw new Error('SQLITE_BUSY: database is locked at /home/x'); }, stats() { throw new Error('x'); }, async trend() { throw new Error('y'); } });
    for (const p of ['feed', 'stats', 'trend']) {
      const res = await request(app).get(`/api/public/${p}`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'unavailable', code: 'PUBLIC_UNAVAILABLE' });
      expect(res.text).not.toContain('SQLITE');
    }
  });
});

describe('trend over HTTP', () => {
  it('passes the source payload through with ETag; computed once per minute', async () => {
    let calls = 0;
    trendImpl = async () => { calls += 1; return { symbol: 'BTC', updated_at: clock.t * 1000, tfs: { '15m': { trend: 'LONG', strength: 71, since: 1 } }, change_24h: { BTC: 1.2, ETH: null }, source: 'trend_monitor' }; };
    const a = await request(app).get('/api/public/trend').query({ tick: 1 });
    expect(a.status).toBe(200);
    expect(a.body.tfs['15m']).toEqual({ trend: 'LONG', strength: 71, since: 1 });
    clock.t += 30;
    const b = await request(app).get('/api/public/trend').set('If-None-Match', a.headers.etag);
    expect(b.status).toBe(304);
    expect(calls).toBe(1);
    clock.t += 31;
    await request(app).get('/api/public/trend');
    expect(calls).toBe(2);
  });
});

describe('rate limit per IP', () => {
  it('60 requests per 60 s per IP over the three paths, then 429 + Retry-After; other IPs unaffected', async () => {
    const ip = (x) => ({ 'X-Forwarded-For': x });
    for (let i = 0; i < 60; i++) {
      const p = ['trend', 'stats', 'feed'][i % 3];
      expect((await request(app).get(`/api/public/${p}`).set(ip('203.0.113.7'))).status).toBe(200);
    }
    const over = await request(app).get('/api/public/feed').set(ip('203.0.113.7'));
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: 'Too many requests, please try again later', code: 'RATE_LIMITED' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request(app).get('/api/public/feed').set(ip('198.51.100.9'))).status).toBe(200);
    expect((await request(app).get('/api/public/showcase').set(ip('203.0.113.7'))).status).toBe(404);   // not counted / not limited here
    clock.t += 61;
    expect((await request(app).get('/api/public/feed').set(ip('203.0.113.7'))).status).toBe(200);
  });
});

describe('no personal data', () => {
  it('no email, user id, trade id, price level, exchange or order in any answer', async () => {
    const rows = [];
    for (let i = 0; i < 34; i++) {
      const r = signal(i % 2 ? uids.sys : uids.alts, { strategy: ['LEVELS', 'SMC', 'VOLUME'][i % 3] });
      db.prepare("UPDATE signal_trades SET progress_stage = ?, progress_ts = ? WHERE trade_id = ?").run(i % 4 ? 'SL' : 'TP3', T0 + 600, r.trade_id);
      rows.push(r);
    }
    rows.push(signal(uids.person, { symbol: 'PEPE-USDT-SWAP' }));
    rows.push(signal(uids.sys, { symbol: 'SOL-USDT-SWAP', order_id: 'bingx-ord-778899' }));
    trendImpl = async () => ({ symbol: 'BTC', updated_at: 1, tfs: {}, change_24h: { BTC: 1, ETH: 2 }, source: 'trend_monitor' });
    clock.t = T0 + 5 * H;
    const answers = [];
    for (const p of ['feed', 'stats', 'trend']) answers.push((await request(app).get(`/api/public/${p}`)).text);
    const page = JSON.parse(answers[0]);
    answers.push((await request(app).get('/api/public/feed').query({ after: page.cursor.replace(/\.\d+\./, '.0.') })).text);
    const stats = JSON.parse(answers[1]);
    expect(stats.closed_signals.value).toBe(34);
    const all = answers.join('\n');
    const forbidden = ['@', 'chm.local', 'example.com', 'user_id', 'userId', 'trade_id', 'email', 'bingx', 'bybit', 'exchange', 'order', 'PEPE',
      '61234', '60001', '63111', '64222', '65333', 'entry', 'original_sl', '"tp1":', '"tp3":', 'api_key'];
    for (const f of forbidden) expect(all, f).not.toContain(f);
    for (const r of rows) expect(all).not.toContain(r.trade_id);
    for (const uid of Object.values(uids)) expect(all).not.toMatch(new RegExp(`"(id|bot_id)":"[^"]*\\b${uid}_`));
    expect(page.items.every((x) => /^s[A-Za-z0-9_-]{12}$/.test(x.id) && /^(sys1|alts)-(levels|smc|volume)$/.test(x.bot_id))).toBe(true);
    const ITEM = ['id', 't', 'pair', 'bot_id', 'strategy', 'strategy_name', 'tf', 'side', 'status', 'path', 'r'];
    for (const it of page.items) expect(Object.keys(it)).toEqual(ITEM);
    for (const e of JSON.parse(answers[3]).events) expect(Object.keys(e.type === 'new' ? e.item : e)).toEqual(e.type === 'new' ? ITEM : ['type', 'id', 'status', 'path', 'r']);
  });
});
