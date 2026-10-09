/**
 * services/publicTrack — the paper track of the system accounts behind GET /api/public/feed and
 * /stats: the 60-minute delay, hidden levels, the source filter, the archive (survives the bot's
 * 30-day purge of SKIP rows), the stats rules, the per-minute cache and the empty states.
 * Cursor semantics have their own file (cursor.test.js).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { T0, makeDb, insertSignal, setStage, makeTrack, body } = require('./helpers.js');
const { FEED_EMPTY_REASON } = require('../../services/publicTrack/index.js');
const { EMPTY_REASON } = require('../../services/publicTrack/stats.js');
const { parseAccounts } = require('../../services/publicTrack/config.js');

const H = 3600;
const ITEM_KEYS = ['id', 't', 'pair', 'bot_id', 'strategy', 'strategy_name', 'tf', 'side', 'status', 'path', 'r'];
let db;
let clock;
beforeEach(() => {
  db = makeDb();
  clock = { t: T0 };
});

describe('config: track accounts', () => {
  it('PUBLIC_TRACK_USER_IDS → ids with public aliases; junk, zero and repeats dropped', () => {
    expect(parseAccounts('7, 8:Alts,0,x,7,9:alts, 10:bad alias!,11:sys1')).toEqual([
      { userId: 7, alias: 'sys1' }, { userId: 8, alias: 'alts' }, { userId: 9, alias: 'sys3' },
      { userId: 10, alias: 'sys4' }, { userId: 11, alias: 'sys5' },
    ]);
    expect(parseAccounts('')).toEqual([]);
    expect(parseAccounts(undefined)).toEqual([]);
  });
});

describe('feed: delay 60 min, levels hidden', () => {
  it('a signal appears exactly 60 minutes after it was created', () => {
    insertSignal(db, { created_at: T0 });
    const pt = makeTrack(db, clock);
    clock.t = T0 + H - 1;
    expect(body(pt.feed())).toEqual({ empty: true, reason: FEED_EMPTY_REASON });
    clock.t = T0 + H + 60;          // next minute: recomputed
    const p = body(pt.feed());
    expect(p.items).toHaveLength(1);
    expect(p).toMatchObject({ delay_min: 60, levels_hidden: true, source: 'paper', updated_at: (T0 + 60) * 1000 });
  });

  it('item shape: the README keys in order, no price level, no user / trade id, no exchange', () => {
    const r = insertSignal(db, { created_at: T0, symbol: 'ETH-USDT-SWAP', direction: 'SHORT', entry: 2345.67, sl: 2399.01,
      original_sl: 2399.01, tp1: 2290.12, tp2: 2250.34, tp3: 2200.56, strategy: 'SMC', timeframe: '15m', entry_lo: 2340.11, entry_hi: 2350.22 });
    clock.t = T0 + 2 * H;
    const p = body(makeTrack(db, clock).feed());
    const it = p.items[0];
    expect(Object.keys(it)).toEqual(ITEM_KEYS);
    expect(it).toMatchObject({ t: T0 * 1000, pair: 'ETH/USDT', bot_id: 'sys1-smc', strategy: 'SMC', strategy_name: 'SMC', tf: '15m', side: 'SHORT', status: 'open', path: ['open'], r: null });
    const json = JSON.stringify(p);
    for (const secret of [r.trade_id, '2345.67', '2399.01', '2290.12', '2250.34', '2200.56', '2340.11', '2350.22', 'bybit', 'u7@x', 'user_id', 'trade_id', 'entry', 'order']) {
      expect(json).not.toContain(secret);
    }
  });

  it('status changes are delayed too: the track as of now − 60 min', () => {
    const r = insertSignal(db, { created_at: T0 });
    const pt = makeTrack(db, clock);
    clock.t = T0 + 2 * H;
    expect(body(pt.feed()).items[0].status).toBe('open');
    setStage(db, r.trade_id, 'TP1', T0 + 2 * H - 900);    // tracker: TP1 in the 15m bar that just closed
    clock.t += 60;
    expect(body(pt.feed()).items[0].status).toBe('open');  // known for 1 min, shown after 60
    clock.t = T0 + 3 * H - 60;
    expect(body(pt.feed()).items[0].status).toBe('open');
    clock.t = T0 + 3 * H + 60;
    expect(body(pt.feed()).items[0]).toMatchObject({ status: 'tp1', path: ['open', 'tp1'], r: null });
  });

  it('a stage the archive sees late is dated at most one hour after its bar (no 60-min freeze after a pause)', () => {
    const r = insertSignal(db, { created_at: T0 });
    setStage(db, r.trade_id, 'SL', T0 + 600);
    clock.t = T0 + 10 * H;           // first look 10 h later: SL dated T0 + 600 + 1 h, long before V
    expect(body(makeTrack(db, clock).feed()).items[0]).toMatchObject({ status: 'sl', path: ['open', 'sl'] });
  });

  it('TP2 seen before break-even → tp2be; R after fees', () => {
    const r = insertSignal(db, { created_at: T0 });
    const pt = makeTrack(db, clock);
    const step = (stage, dt) => { clock.t += dt; setStage(db, r.trade_id, stage, clock.t - 900); pt.feed(); };
    clock.t = T0 + 30 * 60;
    pt.feed();
    step('TP1', 600);
    step('TP2', 1200);
    step('BE', 1200);
    clock.t += 2 * H;
    const it = body(pt.feed()).items[0];
    expect(it).toMatchObject({ status: 'tp2be', path: ['open', 'tp1', 'tp2', 'be'] });
    expect(it.r).toBe(-0.11);        // 0 R − 0.22 / 2 % risk
  });

  it('newest first, at most 20 items; strategy names and bots per account', () => {
    for (let i = 0; i < 25; i++) insertSignal(db, { created_at: T0 + i * 60, strategy: ['LEVELS', 'SMC', 'VOLUME'][i % 3], user_id: i % 2 ? 8 : 7 });
    clock.t = T0 + 5 * H;
    const p = body(makeTrack(db, clock).feed());
    expect(p.items).toHaveLength(20);
    const ts = p.items.map((x) => x.t);
    expect(ts).toEqual(ts.slice().sort((a, b) => b - a));
    expect(new Set(p.items.map((x) => x.strategy_name))).toEqual(new Set(['Уровни', 'SMC', 'Объём + MA']));
    expect(new Set(p.items.map((x) => x.bot_id))).toEqual(new Set(['sys1-levels', 'sys1-smc', 'sys1-volume', 'alts-levels', 'alts-smc', 'alts-volume']));
  });
});

describe('source: only the paper signals of the track accounts', () => {
  it('other users, exchange trades, undelivered, ORPHAN and unknown strategies stay out', () => {
    insertSignal(db, { user_id: 7, symbol: 'BTC-USDT-SWAP' });
    insertSignal(db, { user_id: 9, symbol: 'XRP-USDT-SWAP' });                       // not a track account
    insertSignal(db, { user_id: 7, symbol: 'SOL-USDT-SWAP', order_id: 'ord-123' });   // exchange position
    insertSignal(db, { user_id: 7, symbol: 'DOGE-USDT-SWAP', signal_msg_id: 0 });     // never delivered
    insertSignal(db, { user_id: 7, symbol: 'ADA-USDT-SWAP', result: 'ORPHAN' });
    insertSignal(db, { user_id: 7, symbol: 'LINK-USDT-SWAP', strategy: 'GERCHIK' });
    insertSignal(db, { user_id: 7, symbol: 'AVAX-USDT-SWAP', direction: 'BUY' });
    clock.t = T0 + 2 * H;
    const p = body(makeTrack(db, clock).feed());
    expect(p.items.map((x) => x.pair)).toEqual(['BTC/USDT']);
    expect(JSON.stringify(p)).not.toContain('ord-123');
  });

  it('a manual result or a ghost-cleanup SKIP does not change the paper track', () => {
    const a = insertSignal(db, { created_at: T0, result: 'TP3', result_rr: 4 });
    const b = insertSignal(db, { created_at: T0 + 1, result: 'SKIP', skip_reason: 'ghost' });
    setStage(db, a.trade_id, 'SL', T0 + 600);
    setStage(db, b.trade_id, 'TP1', T0 + 600);
    clock.t = T0 + 3 * H;
    const items = body(makeTrack(db, clock).feed()).items;
    expect(items.find((x) => x.t === T0 * 1000)).toMatchObject({ status: 'sl', r: -1.11 });
    expect(items.find((x) => x.t === (T0 + 1) * 1000)).toMatchObject({ status: 'tp1', r: null });
  });

  it('no track accounts → honest empty payloads, nothing read', () => {
    insertSignal(db, {});
    clock.t = T0 + 2 * H;
    const pt = makeTrack(db, clock, { PUBLIC_TRACK_USER_IDS: '' });
    expect(body(pt.feed())).toEqual({ empty: true, reason: FEED_EMPTY_REASON });
    expect(body(pt.stats())).toEqual({ empty: true, reason: EMPTY_REASON });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'public_track'").get()).toBeUndefined();
  });

  it('an account removed from the config is no longer published', () => {
    insertSignal(db, { user_id: 8 });
    clock.t = T0 + 2 * H;
    expect(body(makeTrack(db, clock).feed()).items).toHaveLength(1);
    expect(body(makeTrack(db, clock, { PUBLIC_TRACK_USER_IDS: '7' }).feed())).toEqual({ empty: true, reason: FEED_EMPTY_REASON });
  });
});

describe('archive: the track outlives signal_trades', () => {
  it('rows deleted by the 30-day SKIP purge keep their published outcome', () => {
    const rows = [];
    for (let i = 0; i < 3; i++) rows.push(insertSignal(db, { created_at: T0 + i * 60 }));
    rows.forEach((r) => setStage(db, r.trade_id, 'SL', T0 + 900));
    const pt = makeTrack(db, clock);
    clock.t = T0 + 3 * H;
    const before = body(pt.feed()).items;
    expect(before.map((x) => x.status)).toEqual(['sl', 'sl', 'sl']);
    db.prepare('DELETE FROM signal_trades').run();                   // ghostCleanup + trades GC, 30 days later
    clock.t = T0 + 31 * 86400;
    expect(body(pt.feed()).items).toEqual(before);
    expect(body(makeTrack(db, clock).feed()).items).toEqual(before); // a new process reads the same archive
  });
});

describe('stats', () => {
  /** n closed signals per account with the given public outcome mix */
  function seedClosed(spec) {
    let k = 0;
    for (const [uid, strategy, outcomes, start] of spec) {
      outcomes.forEach((o, i) => {
        const created = (start || T0) + i * 600 + (k++);
        const r = insertSignal(db, { user_id: uid, strategy, created_at: created });
        const t = created + 300;
        if (o === 'sl') setStage(db, r.trade_id, 'SL', t);
        else if (o === 'tp3') setStage(db, r.trade_id, 'TP3', t);
        else if (o === 'be') setStage(db, r.trade_id, 'BE', t);
        else if (o === 'exp') setStage(db, r.trade_id, 'EXPIRED', t, { expire_rr: 0.5 });
        else if (o === 'tp1') setStage(db, r.trade_id, 'TP1', t);
        else if (o === 'missed') setStage(db, r.trade_id, 'MISSED', t);
      });
    }
  }

  it('fewer than 30 closed signals → «Статистика появится после 30 закрытых сигналов»', () => {
    seedClosed([[7, 'LEVELS', Array(29).fill('sl')]]);
    insertSignal(db, { created_at: T0 + 50 });                       // open: not closed
    clock.t = T0 + 30 * H;
    expect(body(makeTrack(db, clock).stats())).toEqual({ empty: true, reason: EMPTY_REASON });
  });

  it('counters, per-bot medians (no platform sum), outcomes of the last 24 per bot, registry', () => {
    // sys1-levels: 20 × TP3 (+4 R) and 10 × SL; alts-smc: 12 × SL; one open, one TP1 running, one missed
    seedClosed([
      [7, 'LEVELS', [...Array(20).fill('tp3'), ...Array(10).fill('sl')]],
      [8, 'SMC', Array(12).fill('sl')],
      [7, 'VOLUME', ['tp1', 'missed'], T0 + 7 * H],
    ]);
    insertSignal(db, { user_id: 8, strategy: 'SMC', created_at: T0 + 8 * H });
    clock.t = T0 + 40 * H;
    const s = body(makeTrack(db, clock).stats());
    const v = (T0 + 39 * H) * 1000;
    expect(Object.keys(s).slice(0, 8)).toEqual(['source', 'tracked_signals', 'closed_signals', 'open_signals', 'showcase_days', 'bots_30d', 'outcomes_recent', 'registry']);
    expect(s.source).toBe('paper');
    expect(s.tracked_signals).toEqual({ value: 45, updated_at: v });
    expect(s.closed_signals).toEqual({ value: 42, updated_at: v });
    expect(s.open_signals).toEqual({ value: 2, updated_at: v });
    expect(s.missed_signals).toEqual({ value: 1, updated_at: v });
    expect(s.showcase_days).toEqual({ value: 1, since: T0 * 1000, updated_at: v });
    // levels: 20 × (4 − 0.11) + 10 × (−1.11) = 77.8 − 11.1 = 66.7; smc: 12 × −1.11 = −13.32
    expect(s.bots_30d).toEqual({ median_r: 26.69, positive: 1, total: 2, worst_r: -13.32, best_r: 66.7, n: 42, median_dd_r: 12.21, updated_at: v });
    expect(s.outcomes_recent).toEqual({ tp2plus: 14, tp1be: 0, sl: 22, exp: 0, window: 'последние 24 сделки каждого бота', updated_at: v });
    expect(s.registry).toEqual({ launched_since: T0 * 1000, candidates: 3, published: 0, waiting: 3, archived: 0, qualified: 0 });
    expect(s.fees).toMatchObject({ round_trip_pct: 0.12, slippage_pct: 0.1, note: 'после комиссий, оценка' });
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/total_r\b|sum_r|platform/);
  });

  it('stats are delayed like the feed; a bot qualifies after 30 closed signals AND 30 days', () => {
    const pt = makeTrack(db, clock);
    let seenAt = 0;
    for (let i = 0; i < 30; i++) {               // the tracker closes each signal 5 min after it, the archive looks every 10 min
      const created = T0 + i * 600;
      const r = insertSignal(db, { created_at: created });
      setStage(db, r.trade_id, 'SL', created + 300);
      clock.t = created + 330;
      pt.stats();
      seenAt = clock.t;
    }
    clock.t = seenAt + H - 60;                   // the last SL is known for 59 min
    expect(body(pt.stats()).empty).toBe(true);
    clock.t = seenAt + H;
    const s = body(pt.stats());
    expect(s.closed_signals.value).toBe(30);
    expect(s.registry.qualified).toBe(0);       // 30 signals, but not 30 days
    clock.t = T0 + 30 * 86400 + H + 60;
    expect(body(pt.stats()).registry.qualified).toBe(1);
  });

  it('bots_30d covers the last 30 days only; EXPIRED by mark-to-market counts with its R', () => {
    seedClosed([[7, 'LEVELS', Array(30).fill('sl')], [8, 'SMC', ['exp'], T0 + 40 * 86400]]);
    clock.t = T0 + 41 * 86400;
    const s = body(makeTrack(db, clock).stats());
    expect(s.bots_30d).toMatchObject({ total: 1, n: 1, median_r: 0.39, best_r: 0.39, worst_r: 0.39 });   // 0.5 − 0.11
    expect(s.outcomes_recent).toMatchObject({ sl: 24, exp: 1 });
  });
});

describe('cache: computed at most once per minute, ETag', () => {
  it('a change inside the minute is not seen; the ETag is stable until the next refresh', () => {
    insertSignal(db, { created_at: T0 });
    const pt = makeTrack(db, clock);
    clock.t = T0 + 2 * H;
    const a = pt.feed();
    insertSignal(db, { created_at: T0 + 30, symbol: 'ETH-USDT-SWAP' });
    clock.t += 59;
    const b = pt.feed();
    expect(b).toBe(a);                                  // same object: no recompute
    expect(body(b).items).toHaveLength(1);
    expect(a.etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    clock.t += 1;
    const c = pt.feed();
    expect(body(c).items).toHaveLength(2);
    expect(c.etag).not.toBe(a.etag);
  });

  it('one SQL read of the track per minute whatever the number of requests', () => {
    insertSignal(db, { created_at: T0 });
    const pt = makeTrack(db, clock);
    clock.t = T0 + 2 * H;
    let reads = 0;
    const prep = db.prepare.bind(db);
    db.prepare = (sql) => { if (/FROM signal_trades/.test(sql)) reads += 1; return prep(sql); };
    const cursor = body(pt.feed()).cursor;
    for (let i = 0; i < 50; i++) { pt.feed(); pt.stats(); pt.feed(cursor); clock.t += 1; }
    expect(reads).toBe(1);
    db.prepare = prep;
  });
});
