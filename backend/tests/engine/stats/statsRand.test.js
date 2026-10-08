/**
 * signalStats.js vs the bot on 500 random trades of 12 users (gen/gen_stats_rand.py →
 * fixtures/stats_rand.json): the same rows in a bot-schema SQLite (venv, time.time pinned)
 * and in signal_trades / trader_settings here. Every number must be exact: signal_stats
 * (aggregate incl. equity and per_strategy) for 30/7/90/1 days, signal_rows_since,
 * db_dashboard_stats, auto stats, user stats + by strategy (EV, PnL), SL counts, EV texts,
 * Mini App h_stats (by_strategy / by_symbol / by_timeframe / by_source / by_context /
 * sessions / weekdays / equity) and signal lists, pro_overview, strategy_rating.
 * Adversarial data: created_at ties and exact day boundaries, shared signals with different
 * outcomes per user, .xx5 halves, lowercase / legacy / NULL strategies and results.
 * e.g. python -c "print(round(2.675, 2), round(0.125, 2))"  → 2.67 0.12
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const SS = nodeRequire('../../../services/engine/signalStats.js');
const { engineDb, seedUsers, seedTrades } = nodeRequire('./helpers.js');

const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures', 'stats_rand.json'), 'utf8'));
const NOW = V.now;
const J = (x) => globalThis.structuredClone(x);

function wrap(fn) {
  try { return { ok: fn() }; } catch (e) { return { raise: e.name }; }
}

let db;
beforeAll(() => {
  db = engineDb();
  seedUsers(db, V.users);
  seedTrades(db, V.trades, V.insert_cols);
});

describe('500 random trades — per user, numbers exact', () => {
  for (const [uid] of V.users) {
    it(`user ${uid}`, () => {
      const P = V.per_user[String(uid)];
      for (const d of [30, 7, 90, 1]) expect(J(SS.signalStats(db, uid, d, NOW)), `signal_stats ${d}`).toEqual(P[`signal_stats_${d}`]);
      expect(J(SS.signalRowsSince(db, uid, NOW - 7 * 86400))).toEqual(P.rows_since);
      expect(J(SS.dashboardStats(db, uid, 30, NOW))).toEqual(P.dashboard_30);
      expect(J(SS.dashboardStats(db, uid, 7, NOW))).toEqual(P.dashboard_7);
      expect(J(SS.autoStats(db, uid, NOW))).toEqual(P.auto);
      for (const p of [1, 7, 30]) expect(J(SS.autoStatsPeriod(db, uid, p, NOW)), `auto ${p}`).toEqual(P[`auto_${p}`]);
      const us = wrap(() => SS.userStats(db, uid));
      expect(J(us)).toEqual(P.user_stats);
      const bs = wrap(() => SS.userStatsByStrategy(db, uid));
      expect(J(bs)).toEqual(P.by_strategy);
      expect(SS.recentSlCount(db, uid, 24, NOW)).toBe(P.sl_count_24);
      expect(SS.recentSlCount(db, uid, 720, NOW)).toBe(P.sl_count_720);
      expect(wrap(() => SS.formatEvBlock(us.ok !== undefined ? us.ok : {}))).toEqual(P.ev_block);
      for (const [k, v] of Object.entries(P.ev_short)) expect(SS.formatEvShort(bs.ok[k]), k).toBe(v);
      for (const [q, want] of Object.entries(P.stats)) {
        expect(J(SS.statsForUser(db, uid, { ...JSON.parse(q), now: NOW })), q).toEqual(want);
      }
      for (const [k, want] of Object.entries(P.signals)) {
        const [status, strategy, limit] = k.split('|');
        expect(J(SS.userSignals(db, uid, { status, strategy, limit: Number(limit), now: NOW })), k).toEqual(want);
      }
    });
  }
});

describe('500 random trades — all users', () => {
  it('pro_overview 7 / 30 / 1 / 90', () => {
    for (const d of [7, 30, 1, 90]) expect(J(SS.proOverview(db, d, NOW)), String(d)).toEqual(V[`pro_overview_${d}`]);
  });
  it('strategy_rating 30 / 7 / 90', () => {
    SS._resetRatingCache();
    for (const d of [30, 7, 90]) expect(J(SS.strategyRating(db, d, { force: true, now: NOW })), String(d)).toEqual(V[`rating_${d}`]);
    SS._resetRatingCache();
  });
});
