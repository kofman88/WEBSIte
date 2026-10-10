/**
 * signalOutcome.js + signalStats.js vs the bot (db/signal_outcome.py, db/signal_stats.py,
 * db/stats.py, miniapp_api.h_stats / _user_signals).
 *
 * fixtures/stats_vectors.json is printed by the bot's own Python
 * (gen/gen_stats_vectors.py, bot venv, time.time pinned to NOW): signal_status / signal_rr
 * on 146 rows, and every aggregate on a bot-schema SQLite seeded with 341 trades of 9 users
 * — the same rows are inserted here into signal_trades / trader_settings, numbers must be
 * exact. e.g.
 *   python -c "from db.signal_outcome import signal_status as s; print(s({'result':'SKIP','signal_msg_id':9,'created_at':0}, 1e9))"
 *   → expired
 *
 * [STATS-HONEST 2026-10] (bot 7e20066 + 51e8256): is_final / is_exchange_result / stop_pct / row_cost_r /
 * net_rr on every status row and on stop edge rows; the bot test's grid with manual «Пропустил» rows
 * (aggregate, the _COLS projection, rating_from_rows, _signal, 20 SIGNAL_STATS_* env values);
 * per user `live` (_attach_live: risk from sl0, only _is_live) and `env` (cost 0.3 / exchange 0);
 * h_dashboard's fallback stats.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const SO = nodeRequire('../../../services/engine/signalOutcome.js');
const SS = nodeRequire('../../../services/engine/signalStats.js');
const { engineDb, seedUsers, seedTrades } = nodeRequire('./helpers.js');

const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures', 'stats_vectors.json'), 'utf8'));
const NOW = V.now;

let db;
beforeAll(() => {
  db = engineDb();
  seedUsers(db, V.users);
  seedTrades(db, V.trades, V.insert_cols);
});

/** Deep copy keeping signed zeros (Python round() keeps -0.0; JSON.stringify would not). */
const J = (x) => globalThis.structuredClone(x);

describe('signal_status / signal_rr (§12.1–12.2)', () => {
  it(`${V.status.length} rows: status, rr, rr for every status, has_card, is_exchange_trade`, () => {
    const bad = [];
    for (const c of V.status) {
      const st = SO.signalStatus(c.row, NOW);
      if (st !== c.status) bad.push({ row: c.row, st, want: c.status });
      if (!Object.is(SO.signalRr(c.row, st), c.rr === undefined ? null : c.rr)) bad.push({ row: c.row, rr: SO.signalRr(c.row, st), want: c.rr });
      for (const [s, want] of Object.entries(c.rr_by)) {
        const got = SO.signalRr(c.row, s);
        if (!Object.is(got, want)) bad.push({ row: c.row, s, got, want });
      }
      if (SO.hasCard(c.row) !== c.has_card) bad.push({ row: c.row, hasCard: SO.hasCard(c.row) });
      if (SO.isExchangeTrade(c.row) !== c.exchange) bad.push({ row: c.row, ex: SO.isExchangeTrade(c.row) });
    }
    expect(bad).toEqual([]);
    expect(V.status.length).toBeGreaterThanOrEqual(60);
  });
  it('the 10 rules are all exercised and COUNTABLE_SQL / MAX_AGE_S are verbatim', () => {
    const seen = new Set(V.status.map((c) => c.status));
    expect([...seen].sort()).toEqual(['be', 'closed', 'expired', 'missed', 'open', 'skip', 'sl', 'tp1', 'tp2', 'tp3']);
    expect(SO.COUNTABLE_SQL).toBe(V.countable_sql);
    expect(SO.MAX_AGE_S).toBe(V.max_age_s);
  });
  it('SKIP of a delivered card (signal_msg_id > 0) is not an outcome; manual SKIP is', () => {
    expect(SO.signalStatus({ result: 'SKIP', skip_reason: 'ghost', signal_msg_id: 5, created_at: NOW - 10 }, NOW)).toBe('open');
    expect(SO.signalStatus({ result: 'SKIP', skip_reason: 'ghost', signal_msg_id: 0, created_at: NOW - 10 }, NOW)).toBe('skip');
    expect(SO.signalStatus({ result: 'SKIP', skip_reason: 'manual', signal_msg_id: 5, progress_stage: 'TP2' }, NOW)).toBe('skip');
    expect(SO.countableSql('t.')).toBe(V.countable_sql.replaceAll('result', 't.result')
      .replaceAll('signal_msg_id', 't.signal_msg_id').replaceAll('order_id', 't.order_id'));
  });
});

describe('seeded DB — per user, numbers exact', () => {
  for (const [uid] of V.users) {
    it(`user ${uid}: signal_stats 30/7, rows_since, dashboard, auto stats, user stats, by strategy, SL count, EV texts`, () => {
      const P = V.per_user[String(uid)];
      expect(J(SS.signalStats(db, uid, 30, NOW))).toEqual(P.signal_stats_30);
      expect(J(SS.signalStats(db, uid, 7, NOW))).toEqual(P.signal_stats_7);
      const since = SS.signalRowsSince(db, uid, NOW - 5 * 86400);
      expect(J(since)).toEqual(P.rows_since);
      expect(J(SS.dashboardStats(db, uid, 30, NOW))).toEqual(P.dashboard);
      expect(J(SS.dashboardStats(db, uid, 7, NOW))).toEqual(P.dashboard_7);
      expect(J(SS.autoStats(db, uid, NOW))).toEqual(P.auto);
      expect(J(SS.autoStatsPeriod(db, uid, 1, NOW))).toEqual(P.auto_1);
      expect(J(SS.autoStatsPeriod(db, uid, 7, NOW))).toEqual(P.auto_7);
      expect(J(SS.autoStatsPeriod(db, uid, 30, NOW))).toEqual(P.auto_30);
      const us = SS.userStats(db, uid);
      expect(J(us)).toEqual(P.user_stats);
      const bs = SS.userStatsByStrategy(db, uid);
      expect(J(bs)).toEqual(P.by_strategy);
      expect(SS.recentSlCount(db, uid, 24, NOW)).toBe(P.sl_count_24);
      expect(SS.recentSlCount(db, uid, 240, NOW)).toBe(P.sl_count_240);
      expect(SS.formatEvBlock(us)).toBe(P.ev_block);
      for (const [k, v] of Object.entries(P.ev_short)) expect(SS.formatEvShort(bs[k]), k).toBe(v);
    });
    it(`user ${uid}: Mini App GET stats (12 query variants) and signal lists (30 variants)`, () => {
      const P = V.per_user[String(uid)];
      for (const [q, want] of Object.entries(P.stats)) {
        const query = JSON.parse(q);
        expect(J(SS.statsForUser(db, uid, { ...query, now: NOW })), q).toEqual(want);
      }
      for (const [k, want] of Object.entries(P.signals)) {
        const [status, strategy, limit] = k.split('|');
        expect(J(SS.userSignals(db, uid, { status, strategy, limit: Number(limit), now: NOW })), k).toEqual(want);
      }
    });
  }
});

describe('all users — pro_overview, strategy_rating (dedup + cache)', () => {
  it('pro_overview 7 / 30 / 1 days', () => {
    expect(J(SS.proOverview(db, 7, NOW))).toEqual(V.pro_overview_7);
    expect(J(SS.proOverview(db, 30, NOW))).toEqual(V.pro_overview_30);
    expect(J(SS.proOverview(db, 1, NOW))).toEqual(V.pro_overview_1);
  });
  it('strategy_rating 30 / 7 / 90 days', () => {
    SS._resetRatingCache();
    expect(J(SS.strategyRating(db, 30, { force: true, now: NOW }))).toEqual(V.rating_30);
    expect(J(SS.strategyRating(db, 7, { force: true, now: NOW }))).toEqual(V.rating_7);
    expect(J(SS.strategyRating(db, 90, { force: true, now: NOW }))).toEqual(V.rating_90);
  });
  it('rating is cached per days for 900 s (stale rows ignored until expiry or force)', () => {
    SS._resetRatingCache();
    const a = SS.strategyRating(db, 30, { now: NOW });
    db.prepare("INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, created_at, strategy, signal_msg_id, progress_stage, original_sl) VALUES ('cache1', 101, 'ZZZ-USDT-SWAP', 'LONG', 100, 95, 110, 120, 130, ?, 'SMC', 5, 'TP3', 95)").run(NOW - 60);
    expect(SS.strategyRating(db, 30, { now: NOW + 899 })).toBe(a);
    const b = SS.strategyRating(db, 30, { now: NOW + 900 });
    expect(b).not.toBe(a);
    expect(b.by_strategy.SMC.signals).toBe(a.by_strategy.SMC.signals + 1);
    expect(SS.strategyRating(db, 30, { now: NOW + 901, force: true })).not.toBe(b);
    db.prepare("DELETE FROM signal_trades WHERE trade_id='cache1'").run();
    SS._resetRatingCache();
  });
  it('dedup key = (STRATEGY, symbol, DIRECTION, hour); first known R wins, a later R fills a None', () => {
    const base = { symbol: 'X', direction: 'long', strategy: 'smc', entry: 100, sl: 95, original_sl: 95, tp1: 110, tp2: 120, tp3: 130, signal_msg_id: 1 };
    const rows = [
      { ...base, created_at: 3600 * 10 + 5, progress_stage: '' },              // open → None
      { ...base, created_at: 3600 * 10 + 900, progress_stage: 'TP2' },         // same hour → fills None (4.0)
      { ...base, created_at: 3600 * 10 + 1000, progress_stage: 'SL' },         // ignored: already known
      { ...base, created_at: 3600 * 11, progress_stage: 'SL' },                // next hour → new signal
      { ...base, strategy: 'GERCHIK', created_at: 3600 * 12, progress_stage: 'TP3' },   // not in STRATS
    ];
    const r = SS.ratingFromRows(rows, 3600 * 13);
    expect(r.by_strategy.SMC).toEqual({ signals: 2, trades: 2, wins: 1, losses: 1, be: 0, win_rate: 50.0, total_rr: 3.0 });
    expect(r.best).toBe('SMC');
    const p = SS.proOverviewFromRows(rows.map((x, i) => ({ ...x, user_id: 1 + (i % 2) })), 7, 3600 * 13);
    // pro_overview has no strategy filter: the GERCHIK TP3 (+6R) is a third unique signal
    expect(p).toEqual({ days: 7, pro_users: 2, avg_signals: 2.5, unique_signals: 3, unique_rr: 9.0 });
  });
});

describe('dashboard payload (h_dashboard)', () => {
  it('stats 30 d + 6 newest signals with live R + the cached rating; shape like the Mini App', async () => {
    const { pyRound } = nodeRequire('../../../strategies/common/pyround.js');
    const prices = { BTC: 70000, ETH: null };
    let liveN = 0;
    for (const uid of [101, 110]) {          // 110: the bot test's grid (a BE-moved TP1 row among the 6 newest)
      SS._resetRatingCache();
      const P = V.per_user[String(uid)];
      const d = await SS.dashboardPayload(db, uid, {
        now: NOW, priceOf: (b) => (Object.prototype.hasOwnProperty.call(prices, b) ? prices[b] : 1.0),
        market: { BTC: { price: 1, change_pct: 0 } }, trend: { BTC: { H1: 'up' } }, marketTrend: { '15m': { trend: 'up' } },
      });
      expect(Object.keys(d)).toEqual(['ok', 'stats', 'market', 'recent', 'trend', 'rating', 'market_trend']);
      expect(J(d.stats)).toEqual(P.signal_stats_30);
      expect(J(d.rating)).toEqual(V.rating_30);
      const plain = J(d.recent).map((s) => { const { price: _p, r_now: _r, ...rest } = s; return rest; });
      expect(plain).toEqual(P.signals['all||6']);
      for (const s of d.recent) {
        // [STATS-HONEST 2026-10] the bot changed _attach_live: only _is_live (not final) and the risk from sl0
        const live = ['open', 'tp1', 'tp2'].includes(s.status) && !s.final;
        const px = Object.prototype.hasOwnProperty.call(prices, s.symbol) ? prices[s.symbol] : 1.0;
        const risk = Math.abs(s.entry - (s.sl0 || s.sl));
        if (live && px && risk > 0) {
          liveN++;
          expect(s.price).toBe(px);
          const move = s.direction === 'LONG' ? px - s.entry : s.entry - px;
          expect(s.r_now).toBe(pyRound(move / risk, 2));
        } else {
          expect(s.price).toBeUndefined();
        }
      }
    }
    expect(liveN).toBeGreaterThan(0);
    SS._resetRatingCache();
  });
});

describe('aggregate quirks pinned', () => {
  it('TP1/TP2 stages count both as open and as winning trades (double count)', () => {
    const P = V.per_user['109'].signal_stats_30;
    expect(P.open).toBe(3);
    expect(P.trades).toBe(3);
    expect(P.wins).toBe(3);
    const rows = [{ progress_stage: 'TP1', signal_msg_id: 1, entry: 100, sl: 95, tp1: 110, created_at: 10, strategy: 'LEVELS' }];
    const a = SS.aggregate(rows, 30, 100);
    expect([a.open, a.trades, a.wins, a.total_rr, a.per_strategy.LEVELS.trades]).toEqual([1, 1, 1, 2, 1]);
  });
  it('best_rr compares against the ROUNDED previous best', () => {
    const mk = (rr, t) => ({ result: 'CLOSED', result_rr: rr, created_at: t, symbol: `S${t}-USDT-SWAP`, direction: 'long', strategy: 'smc' });
    const a = SS.aggregate([mk(1.004, 1), mk(1.003, 2)], 30, 100);
    expect(a.best_rr).toBe(1.0);
    expect(a.best_symbol).toBe('S2');      // 1.003 > round(1.004, 2) = 1.0
  });
});

describe('pure helpers vs Python', () => {
  it('normalize_strategy / _trade_strategy', () => {
    for (const [k, want] of Object.entries(V.normalize)) {
      const arg = k === 'None' ? null : k === '0' ? 0 : k;
      expect(SS.normalizeStrategy(arg), k).toBe(want);
    }
    for (const c of V.trade_strategy) expect(SS.tradeStrategy(c.t)).toBe(c.s);
  });
  it('_ev_calc / _pnl_aggregate', () => {
    for (const c of V.ev) {
      expect(J(SS.evCalc(c.trades))).toEqual(c.ev);
      expect(J(SS.pnlAggregate(c.trades))).toEqual(c.pnl);
    }
  });
  it('format_ev_block / format_ev_short texts', () => {
    for (const c of V.ev_text) {
      expect(SS.formatEvBlock(c.stats), JSON.stringify(c.stats)).toBe(c.block);
      expect(SS.formatEvShort(c.stats), JSON.stringify(c.stats)).toBe(c.short);
    }
  });
  it('STATS_HELP_TEXT_RU verbatim; session buckets', () => {
    expect(SS.STATS_HELP_TEXT_RU).toBe(V.help_text);
    for (const [h, s] of Object.entries(V.sessions)) expect(SS.sessionForHour(Number(h))).toBe(s);
  });
  it('today loss R sums negative results since UTC midnight', () => {
    const midnight = SS.utcMidnight(NOW);
    expect(midnight).toBe(Math.floor(NOW / 86400) * 86400);
    const d = engineDb();
    seedUsers(d, [[1, 'pro']]);
    const ins = d.prepare('INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, created_at, result, result_rr) VALUES (?, 1, \'X\', \'LONG\', 1, 1, 1, 1, 1, ?, ?, ?)');
    ins.run('a', midnight + 10, 'SL', -1.0);
    ins.run('b', midnight - 10, 'SL', -1.0);
    ins.run('c', midnight + 20, 'MANUAL', -0.5);
    ins.run('d', midnight + 30, 'TP1', 2.0);
    ins.run('e', midnight + 40, 'SKIP', -3.0);
    expect(SS.todayLossRr(d, 1, NOW)).toBe(-1.5);
    expect(SS.todayLossRr(d, 2, NOW)).toBe(0);
  });
});

describe('[STATS-HONEST 2026-10] honest stats vs the bot', () => {
  const ENV_KEYS = ['SIGNAL_STATS_COST_PCT', 'SIGNAL_STATS_EXCHANGE_COST_PCT'];
  function withEnv(env, fn) {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, env);
    try { return fn(); } finally {
      for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  }
  const H = V.honest;

  it('defaults and the _COLS projection (skip_reason) are the bot\'s', () => {
    expect(SS.DEFAULT_COST_PCT).toBe(V.defaults.cost_pct);
    expect(SS.DEFAULT_EXCHANGE_COST_PCT).toBe(V.defaults.exchange_cost_pct);
    expect(SS.COLS).toBe(V.defaults.cols);
    expect(SS.COLS.endsWith(', skip_reason')).toBe(true);
  });

  it(`${V.status.length} status rows: has_real_result / is_exchange_result / is_final / stop_pct / row_cost_r / net_rr`, () => {
    const bad = [];
    withEnv({}, () => {
      for (const c of V.status) {
        const got = {
          real: SO.hasRealResult(c.row), ex_result: SO.isExchangeResult(c.row), final: SO.isFinal(c.row, c.status),
          final_by: Object.fromEntries(Object.keys(c.final_by).map((s) => [s, SO.isFinal(c.row, s)])),
          stop_pct: SS.stopPct(c.row), cost_r: SS.rowCostR(c.row), cost_r_x: SS.rowCostR(c.row, 0.2, 0.05),
          net: SS.netRr(c.row, c.rr === undefined ? null : c.rr), net_x: SS.netRr(c.row, 1.5, 0.0, 0.3),
        };
        const want = { real: c.real, ex_result: c.ex_result, final: c.final, final_by: c.final_by, stop_pct: c.stop_pct,
          cost_r: c.cost_r, cost_r_x: c.cost_r_x, net: c.net, net_x: c.net_x };
        try { expect(J(got)).toEqual(want); } catch (_e) { bad.push({ row: c.row, got, want }); }
      }
    });
    expect(bad).toEqual([]);
    expect(V.status.some((c) => c.ex_result)).toBe(true);
    expect(V.status.some((c) => c.stop_pct === null)).toBe(true);
  });

  it(`${V.stop.length} stop edge rows (strings, inf / nan, −0.0, bool, exchange vs signal cost)`, () => {
    withEnv({}, () => {
      for (const c of V.stop) {
        const got = {
          row: c.row, stop_pct: SS.stopPct(c.row), cost_r: SS.rowCostR(c.row), cost_r_x: SS.rowCostR(c.row, 0.0, 0.5),
          net_1: SS.netRr(c.row, 1.0), net_none: SS.netRr(c.row, null), net_str: SS.netRr(c.row, '2.5'),
          ex_result: SO.isExchangeResult(c.row), real: SO.hasRealResult(c.row),
        };
        expect(J(got), JSON.stringify(c.row)).toEqual(c);
      }
    });
  });

  it('the bot test grid: status, is_final, aggregate 30 / 7 d, _COLS projection, no new keys in rating', () => {
    withEnv({}, () => {
      for (const r of H.rows) {
        expect(SO.signalStatus(r, NOW), r.trade_id).toBe(H.status[r.trade_id]);
        expect(SO.isFinal(r, H.status[r.trade_id]), r.trade_id).toBe(H.final[r.trade_id]);
      }
      expect(J(SS.aggregate(H.rows, 30, NOW))).toEqual(H.aggregate_30);
      expect(J(SS.aggregate(H.rows, 7, NOW))).toEqual(H.aggregate_7);
      const cols = SS.COLS.split(',').map((c) => c.trim());
      const proj = H.rows.map((r) => Object.fromEntries(cols.map((k) => [k, r[k] === undefined ? null : r[k]])));
      expect(J(SS.aggregate(proj, 30, NOW))).toEqual(H.aggregate_cols);
      expect(J(SS.aggregate(H.rows.filter((r) => r.skip_reason !== 'manual'), 30, NOW))).toEqual(H.aggregate_no_skip);
      expect(J(SS.aggregate([], 30, NOW))).toEqual(H.aggregate_empty);
      expect(J(SS.ratingFromRows(H.rows, NOW))).toEqual(H.rating);
      expect(J(H.rows.map((r) => SS.signalView(r, NOW)))).toEqual(H.signals);
    });
    // manual skips change nothing but `signals` (the review fix F2)
    const a = H.aggregate_30; const b = H.aggregate_no_skip;
    expect(a.signals - b.signals).toBe(4);
    for (const k of ['trades', 'final_trades', 'final_wins', 'final_losses', 'final_be', 'net_rr', 'total_rr', 'open', 'open_live']) {
      expect(a[k], k).toBe(b[k]);
    }
    expect([a.final_trades, a.final_wins, a.final_be, a.final_losses, a.open, a.open_live]).toEqual([9, 4, 2, 3, 5, 3]);
    expect(Object.keys(H.rating.by_strategy.VOLUME)).toEqual(Object.keys(SS.blank()).filter((k) => k !== 'rr_7d'));
  });

  it(`${H.env.length} SIGNAL_STATS_* env values: cost_pct / exchange_cost_pct read on every call, aggregate and _signal`, () => {
    for (const c of H.env) {
      withEnv(c.env, () => {
        const k = JSON.stringify(c.env);
        expect(Object.is(SS.costPct(), c.cost_pct), `${k} cost ${SS.costPct()}`).toBe(true);
        expect(Object.is(SS.exchangeCostPct(), c.exchange_cost_pct), k).toBe(true);
        expect(J(SS.aggregate(H.rows, 30, NOW)), k).toEqual(c.aggregate);
        expect(J(H.rows.slice(7, 12).map((r) => SS.signalView(r, NOW))), k).toEqual(c.signals);
      });
    }
  });

  it('seeded DB: per user _attach_live (only _is_live, risk from sl0) over the faked price source', async () => {
    const priceOf = (b) => {
      const v = V.prices[`${b}-USDT-SWAP`];
      if (v === 'raise') throw new Error('price boom');
      return v === undefined ? null : v;
    };
    let withPrice = 0;
    for (const [uid] of V.users) {
      const P = V.per_user[String(uid)];
      for (const [status, want] of Object.entries(P.live)) {
        const sigs = SS.userSignals(db, uid, { status, limit: 50, strategy: '', now: NOW });
        await SS.attachLive(sigs, priceOf);
        expect(J(sigs), `${uid} ${status}`).toEqual(want);
        withPrice += sigs.filter((x) => x.r_now !== undefined).length;
      }
    }
    expect(withPrice).toBeGreaterThan(5);
    // the BE-moved TP1 row of the grid gets r_now from the ORIGINAL stop (0.3 / 0.6 = 0.5R)
    const tp1 = V.per_user['110'].live.all.find((x) => x.id === 'h110-tp1-open');
    expect([tp1.sl, tp1.sl0, tp1.price, tp1.r_now]).toEqual([100.0, 99.4, 100.3, 0.5]);
    expect(V.per_user['110'].live.open.map((x) => x.id).sort()).toEqual(['h110-fresh', 'h110-tp1-open', 'h110-tp2-skip']);
  });

  it('seeded DB: per user lists and signal_stats under cost 0.3 / exchange 0', () => {
    withEnv({ SIGNAL_STATS_COST_PCT: '0.3', SIGNAL_STATS_EXCHANGE_COST_PCT: '0' }, () => {
      for (const [uid] of V.users) {
        const P = V.per_user[String(uid)];
        expect(J(SS.userSignals(db, uid, { status: 'all', limit: 50, strategy: '', now: NOW })), String(uid)).toEqual(P.env.signals);
        expect(J(SS.signalStats(db, uid, 30, NOW)), String(uid)).toEqual(P.env.signal_stats_30);
      }
    });
  });

  it('h_dashboard fallback stats (signal_stats raised) carry the extra fields', () => {
    expect(SS.dashboardFallbackStats()).toEqual(V.dashboard_fallback);
  });

  it('an unknown stop costs nothing and is logged like the bot ([STATS-HONEST] … стоп неизвестен)', () => {
    const lines = [];
    SS._setCostLog((m) => lines.push(m));
    try {
      expect(SS.rowCostR({ trade_id: 'z', symbol: 'X-USDT-SWAP', created_at: 5, entry: 0, sl: 1 })).toBe(0.0);
      expect(SS.rowCostR({ entry: 100, sl: 99.4 })).toBeCloseTo(0.25, 12);
    } finally {
      SS._setCostLog(null);
    }
    expect(lines).toEqual(['[STATS-HONEST] tid=z X-USDT-SWAP ts=5: стоп неизвестен (entry/sl) — издержки не вычтены']);
  });
});
