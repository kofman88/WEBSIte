'use strict';
/**
 * signalStats.js — the bot's signal statistics over `signal_trades`
 * (signal-pipeline.md §12.3–12.8 + the Mini App `GET stats` / `GET dashboard` payloads):
 *
 *   db/signal_stats.py  aggregate · signal_stats · signal_rows_since · pro_overview ·
 *                       rating_from_rows · strategy_rating (15 min cache)
 *   db/stats.py         normalize_strategy · _trade_strategy · db_get_auto_stats(_period) ·
 *                       db_get_today_loss_rr · db_get_recent_sl_count · db_get_user_trades ·
 *                       db_get_user_stats · _ev_calc · _pnl_aggregate · _strategy_stats ·
 *                       db_get_user_stats_by_strategy · db_dashboard_stats · format_ev_block ·
 *                       format_ev_short · STATS_HELP_TEXT_RU
 *   miniapp_api.py      _stat_bucket · h_stats (by_symbol / by_timeframe / by_source /
 *                       by_context / sessions / weekdays / equity) · _signal · _trend_ctx ·
 *                       _user_signals · _attach_live
 *
 * Pure functions take rows and `now`; the SQL helpers take a better-sqlite3 handle (`db`)
 * and run the bot's statements verbatim on `signal_trades` (the bot's `trades`) and
 * `trader_settings` (the bot's `users` for `sub_plan`). Number semantics follow CPython:
 * `sum()` is the 3.12 compensated sum (series.pySum), `+=` loops stay sequential, round()
 * is banker's on the exact binary value (pyround), `//` is floor division.
 *
 * Quirks kept (PORT_DECISIONS D6 lists none here):
 *   • aggregate: a signal at stage TP1 / TP2 counts in `open` AND as a closed winning trade
 *     with its planned R (the TP1/TP2 double count);
 *   • aggregate: `best_rr` is compared against the already ROUNDED previous best;
 *   • rating / pro_overview: one signal = (strategy, symbol, DIRECTION, created_at // 3600),
 *     the first known R wins (a later non-None R only replaces a None);
 *   • db_dashboard_stats: totals are NOT rounded; legacy strategies count only in ALL;
 *   • _strategy_stats: an EXPIRED / CLOSED row with R > 0 is not a "win" (the stats screen),
 *     while the session / weekday buckets count `rr > 0` as a win.
 */

const { signalStatus, signalRr, COUNTABLE_SQL, countableSql, _g } = require('./signalOutcome');
const { pyRound, pyRoundInt, pyFloorDiv } = require('../../strategies/common/pyround');
const { pySum } = require('../../strategies/common/series');
const { levelsStars } = require('../../strategies/levels/stars');
const { pyFloat, pyInt } = require('./pycoerce');
const { pyRepr } = require('../../strategies/common/pyfmt');

const STRATS = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const COLS = 'result, result_rr, progress_stage, entry, sl, original_sl, tp1, tp2, tp3, '
  + 'created_at, strategy, order_id, signal_msg_id, symbol, direction, expire_rr';
const RATING_TTL_S = 900.0;

const nowSec = () => Date.now() / 1000;
const isNone = (v) => v === null || v === undefined;

/** Python falsiness for row values. */
function falsy(v) {
  return v === null || v === undefined || v === false || v === 0 || v === '';
}

/** float(x or 0) */
function fOr0(v) { return falsy(v) ? 0.0 : pyFloat(v); }

/** str(x or '') */
function sOr(v, dflt = '') { return falsy(v) ? dflt : String(v); }

/** str(x) — None → 'None' like Python. */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/** str.replace(old, new) — every occurrence. */
function replaceAll(s, a, b) { return String(s).split(a).join(b); }

function stripQuote(sym) { return replaceAll(replaceAll(sOr(sym), '-USDT-SWAP', ''), '-USDT', ''); }

// ═══════════════════════════════════════════════════════════════════════
//  db/signal_stats.py
// ═══════════════════════════════════════════════════════════════════════

function blank() {
  return { signals: 0, trades: 0, wins: 0, losses: 0, be: 0, win_rate: 0.0, total_rr: 0.0, rr_7d: 0.0 };
}

/** aggregate(rows, days=30, now) — one user's rows → the summary (§12.4). */
function aggregate(rows, days = 30, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const cutoff7 = t - 7 * 86400;
  const perStrategy = {};
  for (const s of STRATS) perStrategy[s] = blank();
  const out = {
    days, ...blank(), open: 0, expired: 0, missed: 0, best_rr: null,
    best_symbol: '', best_direction: '', best_strategy: '',
    equity: [], per_strategy: perStrategy,
  };
  let cum = 0.0;
  const sorted = rows.slice().sort((a, b) => fOr0(a.created_at) - fOr0(b.created_at));   // stable like sorted()
  for (const r of sorted) {
    const strat = sOr(r.strategy).toUpperCase();
    const buckets = [out].concat(Object.prototype.hasOwnProperty.call(perStrategy, strat) ? [perStrategy[strat]] : []);
    for (const b of buckets) b.signals += 1;
    const st = signalStatus(r, t);
    if (st === 'open' || st === 'tp1' || st === 'tp2') out.open += 1;
    else if (st === 'expired') out.expired += 1;      // 72 h without TP/SL — not in the win rate
    else if (st === 'missed') out.missed += 1;        // [SIGNAL-MISSED] ran away without an entry
    const rr = signalRr(r, st);
    if (rr === null) continue;
    const recent = fOr0(r.created_at) >= cutoff7;
    for (const b of buckets) {
      b.trades += 1;
      b.wins += rr > 0 ? 1 : 0;
      b.losses += rr < 0 ? 1 : 0;
      b.be += rr === 0 ? 1 : 0;
      b.total_rr += rr;
      if (recent) b.rr_7d += rr;
    }
    if (out.best_rr === null || rr > out.best_rr) {
      out.best_rr = pyRound(rr, 2);
      out.best_symbol = replaceAll(sOr(r.symbol), '-USDT-SWAP', '');
      out.best_direction = sOr(r.direction).toUpperCase();
      out.best_strategy = strat;
    }
    cum += rr;
    out.equity.push({ t: Math.trunc(fOr0(r.created_at)), r: pyRound(cum, 2) });
  }
  for (const b of [out].concat(Object.values(perStrategy))) {
    if (b.trades) b.win_rate = pyRound(b.wins / b.trades * 100, 1);
    b.total_rr = pyRound(b.total_rr, 2);
    b.rr_7d = pyRound(b.rr_7d, 2);
  }
  return out;
}

/** signal_stats(user_id, days): countable rows created in the last `days` days → aggregate. */
function signalStats(db, userId, days = 30, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const rows = db.prepare(
    `SELECT ${COLS} FROM signal_trades WHERE user_id=? AND created_at > ? AND ${COUNTABLE_SQL} ORDER BY created_at`,
  ).all(userId, t - days * 86400);
  return aggregate(rows, days, t);
}

/** [CHALLENGE] signal_rows_since(user_id, since_ts) — countable rows from since_ts on. */
function signalRowsSince(db, userId, sinceTs) {
  return db.prepare(
    `SELECT ${COLS} FROM signal_trades WHERE user_id=? AND created_at >= ? AND ${COUNTABLE_SQL} ORDER BY created_at`,
  ).all(userId, pyFloat(sinceTs));
}

/** The unique-signal key of pro_overview / rating_from_rows (without the strategy prefix). */
function hourBucket(r) { return Math.trunc(pyFloorDiv(fOr0(r.created_at), 3600)); }

/**
 * pro_overview(days=7): Pro users' rows (sub_plan='pro'), countable, newer than now − days;
 * pro_users = distinct uids, avg_signals = round(rows / users, 1), unique signals by
 * (symbol, DIRECTION, STRATEGY, hour) keeping the first known R.
 */
function proOverview(db, days = 7, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const cols = COLS.split(',').map((c) => `t.${c.trim()}`).join(', ');
  const rows = db.prepare(
    `SELECT t.user_id, ${cols} FROM signal_trades t JOIN trader_settings u ON u.user_id = t.user_id `
    + `WHERE u.sub_plan='pro' AND t.created_at > ? AND ${countableSql('t.')}`,
  ).all(t - days * 86400);
  return proOverviewFromRows(rows, days, t);
}

function proOverviewFromRows(rows, days = 7, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const users = new Set(rows.map((r) => Math.trunc(Number(r.user_id))));
  const uniq = new Map();
  for (const r of rows) {
    const key = JSON.stringify([pyStr(r.symbol), pyStr(r.direction).toUpperCase(), pyStr(r.strategy).toUpperCase(), hourBucket(r)]);
    const rr = signalRr(r, signalStatus(r, t));
    if (!uniq.has(key) || (rr !== null && uniq.get(key) === null)) uniq.set(key, rr);
  }
  const vals = Array.from(uniq.values()).filter((v) => v !== null);
  return {
    days,
    pro_users: users.size,
    avg_signals: users.size ? pyRound(rows.length / users.size, 1) : 0.0,
    unique_signals: uniq.size,
    unique_rr: pyRound(pySum(vals), 2),
  };
}

/**
 * rating_from_rows(rows, now): all users' rows → per strategy over UNIQUE signals
 * (STRATEGY, symbol, DIRECTION, hour) with the first known R; `best` = the strategy with
 * the highest rounded total_rr among those with trades.
 */
function ratingFromRows(rows, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const uniq = new Map();      // key → { strat, rr }
  for (const r of rows) {
    const strat = sOr(r.strategy).toUpperCase();
    if (!STRATS.includes(strat)) continue;
    const key = JSON.stringify([strat, pyStr(r.symbol), pyStr(r.direction).toUpperCase(), hourBucket(r)]);
    const rr = signalRr(r, signalStatus(r, t));
    if (!uniq.has(key) || (rr !== null && uniq.get(key).rr === null)) uniq.set(key, { strat, rr });
  }
  const out = {};
  for (const s of STRATS) out[s] = blank();
  for (const { strat, rr } of uniq.values()) {
    const b = out[strat];
    b.signals += 1;
    if (rr === null) continue;
    b.trades += 1;
    b.wins += rr > 0 ? 1 : 0;
    b.losses += rr < 0 ? 1 : 0;
    b.be += rr === 0 ? 1 : 0;
    b.total_rr += rr;
  }
  let best = ''; let bestRr = null;
  for (const s of STRATS) {
    const b = out[s];
    if (b.trades) b.win_rate = pyRound(b.wins / b.trades * 100, 1);
    b.total_rr = pyRound(b.total_rr, 2);
    delete b.rr_7d;
    if (b.trades && (bestRr === null || b.total_rr > bestRr)) { best = s; bestRr = b.total_rr; }
  }
  return { days: 30, best, by_strategy: out };
}

const ratingCache = new Map();     // days → [ts, out]

/** strategy_rating(days=30, force=False) — all users, cached per `days` for 900 s. */
function strategyRating(db, days = 30, { force = false, now = null } = {}) {
  const t = isNone(now) ? nowSec() : now;
  const hit = ratingCache.get(days);
  if (hit && !force && t - hit[0] < RATING_TTL_S) return hit[1];
  const rows = db.prepare(
    `SELECT ${COLS} FROM signal_trades WHERE created_at > ? AND ${COUNTABLE_SQL}`,
  ).all(t - days * 86400);
  const out = ratingFromRows(rows, t);
  out.days = days;
  ratingCache.set(days, [t, out]);
  return out;
}

function _resetRatingCache() { ratingCache.clear(); }

// ═══════════════════════════════════════════════════════════════════════
//  db/stats.py
// ═══════════════════════════════════════════════════════════════════════

const VALID_STRATEGIES = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const LEGACY_STRATEGIES = Object.freeze(['GERCHIK', 'SCALPING', 'LIQUIDATION']);
const LEGACY_ALIASES = Object.freeze({ ГЕРЧИК: 'GERCHIK', GERCH: 'GERCHIK', SCALP: 'SCALPING' });

/** normalize_strategy(value): empty → LEVELS, canonical → itself, legacy (+aliases) → LEGACY, else LEVELS. */
function normalizeStrategy(value) {
  if (falsy(value)) return 'LEVELS';
  let s = String(value).trim().toUpperCase();
  if (VALID_STRATEGIES.includes(s)) return s;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ALIASES, s)) s = LEGACY_ALIASES[s];
  if (LEGACY_STRATEGIES.includes(s)) return 'LEGACY';
  return 'LEVELS';
}

/** _trade_strategy(t): strategy, else the legacy breakout_type. */
function tradeStrategy(t) {
  const raw = !falsy(t.strategy) ? t.strategy : (!falsy(t.breakout_type) ? t.breakout_type : '');
  return normalizeStrategy(raw);
}

/** db_get_auto_stats(user_id) — exchange trades only, one SQL. */
function autoStats(db, userId, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const row = db.prepare(`
            SELECT
                COUNT(CASE WHEN created_at >= ? AND order_id != '' THEN 1 END) AS c0,
                COUNT(CASE WHEN result = ''  AND order_id != '' THEN 1 END) AS c1,
                COUNT(CASE WHEN result = 'TP1' THEN 1 END) AS c2,
                COUNT(CASE WHEN result = 'TP2' THEN 1 END) AS c3,
                COUNT(CASE WHEN result = 'TP3' THEN 1 END) AS c4,
                COUNT(CASE WHEN result = 'SL'  THEN 1 END) AS c5,
                COALESCE(SUM(CASE WHEN result NOT IN ('','SKIP') THEN result_rr END), 0) AS c6,
                COUNT(CASE WHEN result = 'MANUAL' THEN 1 END) AS c7
            FROM signal_trades
            WHERE user_id = ? AND order_id != ''
  `).get(t - 86400, userId);
  if (!row) return { trades_24h: 0, open_now: 0, tp1: 0, tp2: 0, tp3: 0, sl: 0, manual: 0, total_rr: 0.0 };
  return {
    trades_24h: row.c0 || 0, open_now: row.c1 || 0, tp1: row.c2 || 0, tp2: row.c3 || 0,
    tp3: row.c4 || 0, sl: row.c5 || 0, total_rr: Number(row.c6 || 0), manual: row.c7 || 0,
  };
}

/** db_get_auto_stats_period(user_id, period_days) — exchange trades, counts by created_at. */
function autoStatsPeriod(db, userId, periodDays, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const since = t - Math.trunc(Number(periodDays)) * 86400;
  const row = db.prepare(`
            SELECT
                COUNT(CASE WHEN created_at >= ? AND order_id != '' THEN 1 END) AS c0,
                COUNT(CASE WHEN result = '' AND order_id != '' THEN 1 END) AS c1,
                COUNT(CASE WHEN result = 'TP1' AND created_at >= ? THEN 1 END) AS c2,
                COUNT(CASE WHEN result = 'TP2' AND created_at >= ? THEN 1 END) AS c3,
                COUNT(CASE WHEN result = 'TP3' AND created_at >= ? THEN 1 END) AS c4,
                COUNT(CASE WHEN result = 'SL'  AND created_at >= ? THEN 1 END) AS c5,
                COALESCE(SUM(CASE WHEN result NOT IN ('','SKIP') AND created_at >= ? THEN result_rr END), 0) AS c6,
                COUNT(CASE WHEN result = 'BE'  AND created_at >= ? THEN 1 END) AS c7,
                COUNT(CASE WHEN result = 'CLOSED' AND created_at >= ? THEN 1 END) AS c8,
                COUNT(CASE WHEN result = 'MANUAL' AND result_rr > 0 AND created_at >= ? THEN 1 END) AS c9,
                COUNT(CASE WHEN result = 'MANUAL' AND result_rr < 0 AND created_at >= ? THEN 1 END) AS c10,
                COUNT(CASE WHEN result = 'MANUAL' AND created_at >= ? THEN 1 END) AS c11
            FROM signal_trades
            WHERE user_id = ? AND order_id != ''
  `).get(since, since, since, since, since, since, since, since, since, since, since, userId);
  const v = (k) => (row ? (row[k] || 0) : 0);
  const tradesOpened = v('c0'); const openNow = v('c1');
  const tp1 = v('c2'); const tp2 = v('c3'); const tp3 = v('c4'); const sl = v('c5');
  const totalRr = row ? Number(row.c6 || 0) : 0.0;
  const be = v('c7'); const closedOther = v('c8');
  const manualWins = v('c9'); const manualLosses = v('c10'); const manualTotal = v('c11');
  const wins = tp1 + tp2 + tp3 + manualWins;
  const losses = sl + manualLosses;
  const closed = wins + losses + be + closedOther + (manualTotal - manualWins - manualLosses);
  const winratePct = closed > 0 ? pyRoundInt(wins / closed * 100) : 0;
  const best = db.prepare(`
            SELECT symbol, SUM(result_rr) as sum_rr
            FROM signal_trades
            WHERE user_id=? AND order_id != '' AND result NOT IN ('','SKIP')
              AND created_at >= ?
            GROUP BY symbol ORDER BY sum_rr DESC LIMIT 1
  `).get(userId, since);
  const worst = db.prepare(`
            SELECT symbol, SUM(result_rr) as sum_rr
            FROM signal_trades
            WHERE user_id=? AND order_id != '' AND result NOT IN ('','SKIP')
              AND created_at >= ?
            GROUP BY symbol ORDER BY sum_rr ASC LIMIT 1
  `).get(userId, since);
  return {
    trades_opened: tradesOpened, open_now: openNow, tp1, tp2, tp3, sl, be,
    closed_other: closedOther, manual: manualTotal, total_rr: totalRr, winrate_pct: winratePct,
    wins, losses, closed,
    best_symbol: best ? best.symbol : '', worst_symbol: worst ? worst.symbol : '',
  };
}

/** UTC midnight (unix s) of the day containing `now`. */
function utcMidnight(now) {
  const d = new Date(now * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
}

/** db_get_today_loss_rr(user_id): Σ negative result_rr of trades created since UTC midnight (≤ 0). */
function todayLossRr(db, userId, now = null) {
  const t = isNone(now) ? nowSec() : now;
  try {
    const row = db.prepare(`
                SELECT COALESCE(SUM(result_rr), 0.0) AS s
                FROM signal_trades
                WHERE user_id = ?
                  AND result NOT IN ('', 'SKIP')
                  AND result_rr < 0
                  AND created_at >= ?
    `).get(userId, utcMidnight(t));
    return row ? Number(row.s) : 0.0;
  } catch (_e) {
    return 0.0;
  }
}

/** db_get_recent_sl_count(user_id, hours=24) — SL results created in the last N hours. */
function recentSlCount(db, userId, hours = 24, now = null) {
  const t = isNone(now) ? nowSec() : now;
  try {
    const row = db.prepare(`
                SELECT COUNT(*) AS n
                FROM signal_trades
                WHERE user_id = ?
                  AND result = 'SL'
                  AND created_at >= ?
    `).get(userId, t - Number(hours) * 3600.0);
    return row ? Math.trunc(row.n) : 0;
  } catch (_e) {
    return 0;
  }
}

/** db_get_user_trades(user_id) — every row with a real result (not '' / SKIP), oldest first. */
function userTrades(db, userId) {
  return db.prepare(
    "SELECT * FROM signal_trades WHERE user_id=? AND result != '' AND result != 'SKIP' ORDER BY created_at",
  ).all(userId);
}

const TP_RESULTS = ['TP1', 'TP2', 'TP3'];
const rrOf = (t) => (Object.prototype.hasOwnProperty.call(t, 'result_rr') && t.result_rr !== undefined ? t.result_rr : 0);
const isManualWin = (t) => t.result === 'MANUAL' && rrOf(t) > 0;
const isManualLoss = (t) => t.result === 'MANUAL' && rrOf(t) < 0;
const isWin = (t) => TP_RESULTS.includes(t.result) || isManualWin(t);
const isLoss = (t) => t.result === 'SL' || isManualLoss(t);

/** _ev_calc(trades) — expectancy over non-BE closed trades (min 5), BE counted for the UI. */
function evCalc(trades) {
  const closedForUi = trades.filter((t) => ['TP1', 'TP2', 'TP3', 'SL', 'MANUAL', 'BE'].includes(t.result));
  const closedForMath = trades.filter((t) => ['TP1', 'TP2', 'TP3', 'SL', 'MANUAL'].includes(t.result));
  const rrF = (t) => pyFloat(rrOf(t));
  const winsRr = closedForMath.map(rrF).filter((v) => v > 0);
  const lossesRr = closedForMath.map(rrF).filter((v) => v < 0).map((v) => Math.abs(v));
  const mathTotal = closedForMath.length;
  const avgWin = winsRr.length ? pySum(winsRr) / winsRr.length : 0.0;
  const avgLoss = lossesRr.length ? pySum(lossesRr) / lossesRr.length : 0.0;
  let expectancy = null;
  if (mathTotal >= 5 && (winsRr.length || lossesRr.length)) {
    const wr = winsRr.length / mathTotal;
    expectancy = (wr * avgWin) - ((1 - wr) * avgLoss);
  }
  let evStatus;
  if (expectancy === null) evStatus = 'insufficient_data';
  else if (expectancy > 0.10) evStatus = 'positive';
  else if (expectancy < -0.05) evStatus = 'negative';
  else evStatus = 'breakeven';
  return {
    expectancy_r: expectancy !== null ? pyRound(expectancy, 3) : null,
    ev_status: evStatus,
    avg_win_r: winsRr.length ? pyRound(avgWin, 2) : 0.0,
    avg_loss_r: lossesRr.length ? pyRound(avgLoss, 2) : 0.0,
    closed_count: closedForUi.length,
  };
}

/** _pnl_aggregate(trades) — closed_pnl_usd total / coverage / average. */
function pnlAggregate(trades) {
  const vals = trades.filter((t) => t.closed_pnl_usd !== null && t.closed_pnl_usd !== undefined)
    .map((t) => pyFloat(t.closed_pnl_usd));
  const total = trades.length;
  const totalPnl = pySum(vals);
  return {
    total_pnl_usd: totalPnl,
    pnl_trades_count: vals.length,
    pnl_coverage_pct: total ? (vals.length / total * 100.0) : 0.0,
    avg_pnl_usd: vals.length ? totalPnl / vals.length : 0.0,
  };
}

/** db_get_user_stats(user_id) — the /stats screen ({} when the user has no closed trades). */
function userStats(db, userId) {
  const trades = userTrades(db, userId);
  if (!trades.length) return {};
  const wins = trades.filter(isWin);
  const losses = trades.filter(isLoss);
  const total = trades.length;
  const winrate = total ? wins.length / total * 100 : 0;
  const totalRr = pySum(trades.map((t) => t.result_rr));
  const avgRr = total ? totalRr / total : 0;
  const sym = new Map();
  for (const t of trades) {
    if (!sym.has(t.symbol)) sym.set(t.symbol, { wins: 0, total: 0 });
    const e = sym.get(t.symbol);
    e.total += 1;
    if (isWin(t)) e.wins += 1;
  }
  const keyOf = ([, v]) => (v.total >= 2 ? v.wins / v.total : 0);
  const best = Array.from(sym.entries()).sort((a, b) => keyOf(b) - keyOf(a)).slice(0, 5)
    .map(([k, v]) => [k, { ...v }]);
  let sw = 0; let sl = 0; let cw = 0; let cl = 0;
  for (const t of trades) {
    if (isWin(t)) { cw += 1; cl = 0; } else if (isLoss(t)) { cl += 1; cw = 0; }
    sw = Math.max(sw, cw); sl = Math.max(sl, cl);
  }
  const longs = trades.filter((t) => t.direction === 'LONG');
  const shorts = trades.filter((t) => t.direction === 'SHORT');
  const tpWins = trades.filter((t) => TP_RESULTS.includes(t.result));
  const winRr = pySum(wins.map((t) => pyFloat(rrOf(t))));
  const lossRr = Math.abs(pySum(losses.map((t) => pyFloat(rrOf(t)))));
  return {
    total, wins: wins.length, losses: losses.length, winrate, avg_rr: avgRr, total_rr: totalRr,
    profit_factor: lossRr > 0 ? pyRound(winRr / lossRr, 2) : pyRound(winRr, 2),
    streak_w: sw, streak_l: sl, best_symbols: best,
    longs_total: longs.length, longs_wins: longs.filter(isWin).length,
    shorts_total: shorts.length, shorts_wins: shorts.filter(isWin).length,
    tp1_cnt: tpWins.filter((t) => t.result === 'TP1').length,
    tp2_cnt: tpWins.filter((t) => t.result === 'TP2').length,
    tp3_cnt: tpWins.filter((t) => t.result === 'TP3').length,
    manual_cnt: trades.filter((t) => t.result === 'MANUAL').length,
    ...pnlAggregate(trades),
    ...evCalc(trades),
  };
}

/** _strategy_stats(trades) — one strategy's numbers ({} when empty). */
function strategyStats(trades) {
  if (!trades.length) return {};
  const wins = trades.filter(isWin);
  const losses = trades.filter(isLoss);
  const total = trades.length;
  const totalRr = pySum(trades.map((t) => t.result_rr));
  const tpWins = trades.filter((t) => TP_RESULTS.includes(t.result));
  const winRr = pySum(wins.map((t) => pyFloat(rrOf(t))));
  const lossRr = Math.abs(pySum(losses.map((t) => pyFloat(rrOf(t)))));
  return {
    total,
    wins: wins.length,
    losses: losses.length,
    profit_factor: lossRr > 0 ? pyRound(winRr / lossRr, 2) : pyRound(winRr, 2),
    be_cnt: trades.filter((t) => t.result === 'BE').length,
    manual_cnt: trades.filter((t) => t.result === 'MANUAL').length,
    winrate: total ? wins.length / total * 100 : 0.0,
    avg_rr: total ? totalRr / total : 0.0,
    total_rr: totalRr,
    tp1_cnt: tpWins.filter((t) => t.result === 'TP1').length,
    tp2_cnt: tpWins.filter((t) => t.result === 'TP2').length,
    tp3_cnt: tpWins.filter((t) => t.result === 'TP3').length,
    longs: trades.filter((t) => t.direction === 'LONG').length,
    shorts: trades.filter((t) => t.direction === 'SHORT').length,
    longs_w: trades.filter((t) => t.direction === 'LONG' && isWin(t)).length,
    shorts_w: trades.filter((t) => t.direction === 'SHORT' && isWin(t)).length,
    ...pnlAggregate(trades),
    ...evCalc(trades),
  };
}

/** db_get_user_stats_by_strategy(user_id) → {LEVELS, SMC, VOLUME, LEGACY, ALL}. */
function userStatsByStrategy(db, userId) {
  const trades = userTrades(db, userId);
  const buckets = { LEVELS: [], SMC: [], VOLUME: [], LEGACY: [] };
  for (const t of trades) buckets[tradeStrategy(t)].push(t);
  return {
    LEVELS: strategyStats(buckets.LEVELS),
    SMC: strategyStats(buckets.SMC),
    VOLUME: strategyStats(buckets.VOLUME),
    LEGACY: strategyStats(buckets.LEGACY),
    ALL: strategyStats(trades),
  };
}

/** db_dashboard_stats(user_id, days=30) — per strategy + ALL (legacy rows only in ALL), totals unrounded. */
function dashboardStats(db, userId, days = 30, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const cutoff30 = t - days * 86400;
  const cutoff7 = t - 7 * 86400;
  const empty = () => ({ trades: 0, wins: 0, win_rate: 0.0, total_rr: 0.0, rr_7d: 0.0 });
  const stats = { SMC: empty(), LEVELS: empty(), VOLUME: empty(), ALL: empty() };
  const rows = db.prepare(
    'SELECT strategy, result, result_rr, created_at, progress_stage, entry, sl, '
    + '       original_sl, tp1, tp2, tp3, order_id, signal_msg_id '
    + 'FROM signal_trades '
    + `WHERE user_id=? AND created_at > ? AND ${COUNTABLE_SQL}`,
  ).all(userId, cutoff30);
  for (const r of rows) {
    const strat = normalizeStrategy(sOr(_g(r, 'strategy', '')));
    const status = signalStatus(r, t);
    const rrV = signalRr(r, status);
    if (rrV === null) continue;
    const rr = Number(rrV);
    const ts = fOr0(_g(r, 'created_at', 0));
    const win = rr > 0;
    if (Object.prototype.hasOwnProperty.call(stats, strat) && strat !== 'ALL') {
      stats[strat].trades += 1;
      stats[strat].total_rr += rr;
      if (win) stats[strat].wins += 1;
      if (ts >= cutoff7) stats[strat].rr_7d += rr;
    }
    stats.ALL.trades += 1;
    stats.ALL.total_rr += rr;
    if (win) stats.ALL.wins += 1;
    if (ts >= cutoff7) stats.ALL.rr_7d += rr;
  }
  for (const d of Object.values(stats)) {
    if (d.trades > 0) d.win_rate = pyRound(d.wins / d.trades * 100, 1);
  }
  return stats;
}

/** f"{x}" of a Python float (repr): 0.0 → '0.0', 2.0 → '2.0', 0.125 → '0.125'. */
function pyNum(v) {
  return typeof v === 'number' ? pyRepr(v) : String(v);
}

/** format_ev_block(stats, lang) — the multi-line EV block of the stats text (RU only). */
function formatEvBlock(stats) {
  const status = stats.ev_status !== undefined ? stats.ev_status : 'insufficient_data';
  const closed = Math.trunc(Number(stats.closed_count || 0));
  const NL = '\n';
  if (status === 'insufficient_data') {
    if (closed === 0) return '';
    return NL + NL
      + '💡 <b>Мат ожидание</b>: недостаточно данных' + NL
      + `   Нужно минимум 5 закрытых сделок (сейчас: ${closed})` + NL
      + '   Чем больше сделок — тем точнее статистика.';
  }
  const expectancy = stats.expectancy_r;
  const avgWin = pyNum(fOr0(stats.avg_win_r));
  const avgLoss = pyNum(fOr0(stats.avg_loss_r));
  const per100 = pyNum(pyRound(fOr0(expectancy) * 100, 1));
  const sign = (fOr0(expectancy)) >= 0 ? '+' : '';
  const ev = isNone(expectancy) ? 'None' : pyNum(expectancy);
  if (status === 'positive') {
    return NL + NL
      + `💡 <b>Мат ожидание</b>: <b>${sign}${ev}R</b> за сделку ✅` + NL
      + `   Средний выигрыш: +${avgWin}R | Средний проигрыш: -${avgLoss}R` + NL
      + `   Прогноз на 100 сделок: <b>${sign}${per100}R</b>` + NL
      + '   <i>Стратегия работает в твою пользу. Продолжай.</i>';
  }
  if (status === 'negative') {
    return NL + NL
      + `⚠️ <b>Мат ожидание</b>: <b>${ev}R</b> за сделку ❌` + NL
      + `   Средний выигрыш: +${avgWin}R | Средний проигрыш: -${avgLoss}R` + NL
      + `   Прогноз на 100 сделок: <b>${per100}R</b>` + NL
      + '   <i>Стратегия работает в минус. Рекомендации:' + NL
      + '   • Попробовать другую стратегию или Strategy Genome' + NL
      + '   • Включить AI-фильтры для отсева слабых сигналов' + NL
      + '   • Сделать паузу 1-2 недели и проанализировать</i>';
  }
  return NL + NL
    + `〰️ <b>Мат ожидание</b>: ${sign}${ev}R за сделку` + NL
    + `   Средний выигрыш: +${avgWin}R | Средний проигрыш: -${avgLoss}R` + NL
    + '   Стратегия близка к нулю — небольшой плюс или минус.' + NL
    + '   <i>Можно оптимизировать настройки для лучшего результата.</i>';
}

/** format_ev_short(stats) — 'EV: <b>+0.32R</b> ✅' / 'EV: — (мало данных)'. */
function formatEvShort(stats) {
  const status = stats.ev_status !== undefined ? stats.ev_status : 'insufficient_data';
  if (status === 'insufficient_data') return 'EV: — (мало данных)';
  const ev = stats.expectancy_r;
  if (isNone(ev)) return 'EV: — (мало данных)';
  const sign = ev >= 0 ? '+' : '';
  const emoji = { positive: '✅', negative: '❌', breakeven: '〰️' }[status] || '';
  return `EV: <b>${sign}${pyNum(ev)}R</b> ${emoji}`.replace(/\s+$/u, '');
}

const STATS_HELP_TEXT_RU = `ℹ️ <b>Объяснение метрик</b>

📊 <b>Сделок</b> — общее количество всех твоих сделок.

✅ <b>Wins / Losses</b> — выигрышные и проигрышные сделки.

🎯 <b>WR (Win Rate)</b> — процент прибыльных сделок.
Пример: WR 55% значит 55 из 100 сделок были в плюс.
<i>⚠️ Высокий WR ≠ прибыль. Можно иметь WR 70% и всё равно терять деньги, если средний проигрыш больше среднего выигрыша.</i>

📐 <b>RR (Risk/Reward)</b> — отношение прибыли к риску.
Если RR = 2:1, то на каждый рисковый $1 ты целишь заработать $2.
В CHM BREAKER минимум RR = 2.0 — это защита.

📈 <b>Avg RR</b> — средний результат сделки в R-multiples.
1R = твой риск на сделку.
Avg RR +0.5 = в среднем зарабатываешь 0.5× риска на каждой сделке.

💰 <b>Total RR</b> — общая прибыль во всех R-multiples.
+15R за месяц при риске 1% = +15% к балансу.

💵 <b>Реальный PnL ($)</b> — точная прибыль в долларах.
Считается с биржи, с учётом комиссий и funding.
<i>Это самая честная цифра — не теоретическая, а реальная.</i>

🔥 <b>Profit Factor</b> — сумма выигрышей ÷ сумма проигрышей.
PF &gt; 1.0 = ты в плюсе
PF &gt; 1.5 = хорошая стратегия
PF &gt; 2.0 = отличная стратегия
PF &lt; 1.0 = стратегия теряет деньги

💡 <b>Мат ожидание (EV)</b> — главная метрика стратегии.
Средний результат одной сделки в долгосроке.
EV +0.5R = каждая сделка приносит 0.5R в среднем.
EV -0.2R = каждая сделка теряет 0.2R в среднем.

<u>Почему EV важнее WR:</u>
WR говорит <i>"как часто я выигрываю"</i>.
EV говорит <i>"сколько я заработаю в среднем"</i>.

Можно иметь WR 30% и быть прибыльным (если выигрыши большие).
Можно иметь WR 70% и терять деньги (если проигрыши большие).

EV объединяет всё в одну цифру.

🎯 <b>TP1 / TP2 / TP3</b> — сколько раз сработали разные уровни Take Profit.

🔥 <b>Серия побед / поражений</b> — макс. число сделок подряд в одну сторону.
Это нормально иметь серию из 5-10 лоссов даже у прибыльной стратегии.

🟢 <b>LONG / SHORT split</b> — сколько сделок в каждом направлении и WR для каждого. Помогает понять — лучше ли работаешь в LONG или SHORT.

📈 <b>Лучшие монеты</b> — на каких символах больше всего прибыли.

━━━━━━━━━━━━━━━━━━━━

<b>Главный вопрос:</b>
Стратегия прибыльная?

Смотри на 2 числа:
1. <b>EV</b> — должно быть положительное (+)
2. <b>Profit Factor</b> — должно быть &gt; 1.0

Если оба условия выполнены — стратегия математически прибыльна. Просадки — нормально, но в долгосроке ты в плюсе.

Если хотя бы одно отрицательное — стратегия теряет деньги. Нужно менять настройки или ждать другой рыночной фазы.`;

// ═══════════════════════════════════════════════════════════════════════
//  miniapp_api.py — stats / signals payloads
// ═══════════════════════════════════════════════════════════════════════

const TF_ORDER = Object.freeze(['15m', '30m', '1h', '4h', '1d']);
const CLOSED_RESULTS = ['TP1', 'TP2', 'TP3', 'SL', 'BE', 'MANUAL', 'TRAIL'];
const CTX_KEYS = Object.freeze(['aligned', 'with', 'counter', 'strong_counter']);

/** _stat_bucket(trades) — the compact numbers of one stats bucket. */
function statBucket(trades) {
  const s = trades.length ? strategyStats(trades) : {};
  const g = (k, d) => (Object.prototype.hasOwnProperty.call(s, k) ? s[k] : d);
  return {
    trades: Math.trunc(Number(g('total', 0))),
    wins: Math.trunc(Number(g('wins', 0))),
    losses: Math.trunc(Number(g('losses', 0))),
    be: Math.trunc(Number(g('be_cnt', 0))),
    win_rate: pyRound(Number(g('winrate', 0.0)), 1),
    avg_rr: pyRound(Number(g('avg_rr', 0.0)), 2),
    total_rr: pyRound(Number(g('total_rr', 0.0)), 2),
    profit_factor: Number(g('profit_factor', 0.0)),
    ev: g('expectancy_r', null),
    pnl_usd: pyRound(Number(g('total_pnl_usd', 0.0)), 2),
  };
}

/** _trend_ctx(row): the trend_ctx column, else aligned / counter from the legacy flags. */
function trendCtx(row) {
  const ctx = sOr(row.trend_ctx);
  if (ctx) return ctx;
  if (Math.trunc(fOr0(row.mtf_aligned))) return 'aligned';
  if (Math.trunc(fOr0(row.is_counter_trend))) return 'counter';
  return '';
}

/** cohort_stats._session_for_hour(hour_utc) */
function sessionForHour(h) {
  if (h >= 0 && h < 8) return 'asia';
  if (h >= 8 && h < 16) return 'europe';
  return 'us';
}

/**
 * h_stats(request) body after the SQL: rows = SELECT * … countable, created_at ≥ now − days,
 * ORDER BY created_at. `strategy` / `tf` are the raw query filters.
 */
function statsPayload(rows, { days = 30, strategy = '', tf = '', now = null } = {}) {
  const t = isNone(now) ? nowSec() : now;
  let fStrat = sOr(strategy).toUpperCase();
  fStrat = STRATS.includes(fStrat) ? fStrat : '';
  const fTf = sOr(tf).toLowerCase();
  const tradesAll = [];
  for (const row of rows) {
    const r = { ...row };
    const st = signalStatus(r, t);
    const rr = signalRr(r, st);
    if (rr === null) continue;
    if (!CLOSED_RESULTS.includes(sOr(r.result).toUpperCase())) r.result = st.toUpperCase();
    r.result_rr = Number(rr);
    r._tf = sOr(r.timeframe).toLowerCase();
    if (fTf && r._tf !== fTf) continue;
    tradesAll.push(r);
  }
  const byStrategy = { LEVELS: [], SMC: [], VOLUME: [] };
  for (const r of tradesAll) {
    const s = tradeStrategy(r);
    if (Object.prototype.hasOwnProperty.call(byStrategy, s)) byStrategy[s].push(r);
  }
  const trades = tradesAll.filter((r) => !fStrat || tradeStrategy(r) === fStrat);
  const tfSet = [];
  for (const r of tradesAll) if (r._tf && !tfSet.includes(r._tf)) tfSet.push(r._tf);
  const tfKey = (x) => (TF_ORDER.includes(x) ? TF_ORDER.indexOf(x) : 99);
  const timeframes = tfSet.slice().sort((a, b) => tfKey(a) - tfKey(b));
  const bySym = new Map();
  const byTf = new Map();
  const bySrc = { exchange: [], signals: [] };
  const byCtx = {};
  for (const k of CTX_KEYS) byCtx[k] = [];
  for (const r of trades) {
    const base = stripQuote(r.symbol);
    if (!bySym.has(base)) bySym.set(base, []);
    bySym.get(base).push(r);
    if (r._tf) {
      if (!byTf.has(r._tf)) byTf.set(r._tf, []);
      byTf.get(r._tf).push(r);
    }
    bySrc[sOr(r.order_id).trim() ? 'exchange' : 'signals'].push(r);
    const ctx = trendCtx(r);
    if (Object.prototype.hasOwnProperty.call(byCtx, ctx)) byCtx[ctx].push(r);
  }
  const symRows = Array.from(bySym.entries()).map(([k, v]) => ({ symbol: k, ...statBucket(v) }));
  symRows.sort((a, b) => (b.total_rr - a.total_rr) || (b.trades - a.trades));
  const bestSyms = symRows.filter((x) => x.total_rr > 0).slice(0, 5);
  const worstSyms = symRows.filter((x) => x.total_rr < 0).sort((a, b) => a.total_rr - b.total_rr).slice(0, 5);
  const sessions = {};
  for (const k of ['asia', 'europe', 'us']) sessions[k] = { trades: 0, wins: 0, total_rr: 0.0 };
  const weekdays = Array.from({ length: 7 }, () => ({ trades: 0, wins: 0, total_rr: 0.0 }));
  const equity = [];
  let cum = 0.0;
  for (const r of trades) {
    const ts = fOr0(r.created_at);
    const rr = r.result_rr;
    const res = sOr(r.result);
    const win = res.startsWith('TP') || rr > 0;
    const d = new Date(ts * 1000);
    const weekday = (d.getUTCDay() + 6) % 7;
    for (const b of [sessions[sessionForHour(d.getUTCHours())], weekdays[weekday]]) {
      b.trades += 1;
      b.wins += win ? 1 : 0;
      b.total_rr += rr;
    }
    cum += rr;
    equity.push({ t: Math.trunc(ts), r: pyRound(cum, 2) });
  }
  for (const b of Object.values(sessions).concat(weekdays)) {
    b.win_rate = b.trades ? pyRound(b.wins / b.trades * 100, 1) : 0.0;
    b.total_rr = pyRound(b.total_rr, 2);
  }
  const mapBuckets = (m) => Object.fromEntries(Array.from(m instanceof Map ? m.entries() : Object.entries(m))
    .map(([k, v]) => [k, statBucket(v)]));
  return {
    ok: true, days, summary: statBucket(trades),
    filters: { strategy: fStrat, tf: fTf, timeframes },
    by_strategy: mapBuckets(byStrategy),
    by_session: sessions, by_weekday: weekdays, equity,
    by_symbol: { best: bestSyms, worst: worstSyms },
    by_timeframe: mapBuckets(byTf),
    by_source: mapBuckets(bySrc),
    by_context: mapBuckets(byCtx),
  };
}

/** GET stats for one user: `days` clamped 1..365 (bad → 30), SELECT * countable rows, statsPayload. */
function statsForUser(db, userId, { days = '30', strategy = '', tf = '', now = null } = {}) {
  const t = isNone(now) ? nowSec() : now;
  let d;
  try { d = Math.max(1, Math.min(pyInt(String(days)), 365)); } catch (_e) { d = 30; }
  const rows = db.prepare(
    `SELECT * FROM signal_trades WHERE user_id=? AND created_at >= ? AND ${COUNTABLE_SQL} ORDER BY created_at`,
  ).all(userId, t - d * 86400);
  return statsPayload(rows, { days: d, strategy, tf, now: t });
}

/** _signal(row) — one feed / list item. */
function signalView(row, now = null) {
  const t = isNone(now) ? nowSec() : now;
  const base = stripQuote(row.symbol);
  const entry = fOr0(row.entry);
  const sl = fOr0(row.sl);
  const status = signalStatus(row, t);
  let rr = signalRr(row, status);
  rr = rr !== null ? pyRound(Number(rr), 2) : null;
  let q = Math.trunc(fOr0(row.quality));
  if (sOr(row.strategy).toUpperCase() === 'LEVELS') q = levelsStars(q);
  const res = sOr(row.result).toUpperCase();
  const orderId = sOr(row.order_id);
  return {
    id: sOr(row.trade_id),
    symbol: base, pair: `${base}/USDT`,
    direction: sOr(row.direction, 'LONG').toUpperCase(),
    strategy: sOr(row.strategy, 'LEVELS').toUpperCase(),
    timeframe: sOr(row.timeframe, '1h'),
    entry, sl,
    sl0: fOr0(row.original_sl) || sl,
    tp1: fOr0(row.tp1), tp2: fOr0(row.tp2), tp3: fOr0(row.tp3),
    quality: Math.max(1, Math.min(5, q || 1)),
    counter_trend: Boolean(Math.trunc(fOr0(row.is_counter_trend))),
    mtf_aligned: Boolean(Math.trunc(fOr0(row.mtf_aligned))),
    trend_ctx: trendCtx(row),
    note: sOr(row.user_note),
    on_exchange: Boolean(orderId),
    manual: Boolean(sOr(row.skip_reason) === 'manual' || (['TP1', 'TP2', 'TP3', 'SL', 'BE'].includes(res) && !orderId)),
    created_at: Math.trunc(fOr0(row.created_at)),
    status, rr,
  };
}

/** _user_signals(user_id, status, limit, strategy) — newest first, open = open/tp1/tp2. */
function userSignals(db, userId, { status = 'all', limit = 50, strategy = '', now = null } = {}) {
  const lim = Math.max(1, Math.min(Math.trunc(Number(limit)), 200));
  const strat = sOr(strategy).toUpperCase();
  let where = 'user_id=?';
  const params = [userId];
  if (STRATS.includes(strat)) {
    where += " AND UPPER(COALESCE(strategy, 'LEVELS'))=?";
    params.push(strat);
  }
  params.push(status !== 'all' ? lim * 3 : lim);
  const rows = db.prepare(`SELECT * FROM signal_trades WHERE ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
  let out = rows.map((r) => signalView(r, now));
  if (status === 'open') out = out.filter((s) => ['open', 'tp1', 'tp2'].includes(s.status));
  else if (status === 'closed') out = out.filter((s) => !['open', 'tp1', 'tp2'].includes(s.status));
  return out.slice(0, lim);
}

/**
 * _attach_live(signals): open items (≤ 25) get `price` and `r_now` = move / |entry − sl|
 * (the CURRENT stop) from `priceOf(symbolBase)` (async or sync; null = unknown).
 */
async function attachLive(signals, priceOf) {
  const live = signals.filter((s) => ['open', 'tp1', 'tp2'].includes(s.status)).slice(0, 25);
  if (!live.length || typeof priceOf !== 'function') return;
  const syms = Array.from(new Set(live.map((s) => s.symbol))).sort();
  const prices = new Map();
  await Promise.all(syms.map(async (b) => {
    let px = null;
    try { px = await priceOf(b); } catch (_e) { px = null; }
    prices.set(b, px);
  }));
  for (const s of live) {
    const px = prices.get(s.symbol);
    const risk = Math.abs(s.entry - s.sl);
    if (!px || risk <= 0) continue;
    const move = s.direction === 'LONG' ? (px - s.entry) : (s.entry - px);
    s.price = px;
    s.r_now = pyRound(move / risk, 2);
  }
}

/**
 * h_dashboard(request) body: 30-day signal stats (fallback zeros + warning when the read
 * fails), the 6 newest signals with live price / R, the all-users strategy rating (15 min
 * cache). `market` / `trend` / `marketTrend` come from the market-data and trend modules.
 */
async function dashboardPayload(db, userId, { now = null, priceOf = null, market = {}, trend = {}, marketTrend = {}, log = null } = {}) {
  const t = isNone(now) ? nowSec() : now;
  let stats = { days: 30, signals: 0, trades: 0, wins: 0, win_rate: 0.0, total_rr: 0.0, rr_7d: 0.0 };
  try {
    stats = signalStats(db, userId, 30, t);
  } catch (e) {
    if (log && log.warn) log.warn(`[MINIAPP] dashboard stats: ${e.message}`);
  }
  const recent = userSignals(db, userId, { status: 'all', limit: 6, now: t });
  await attachLive(recent, priceOf);
  let rating = null;
  try {
    rating = strategyRating(db, 30, { now: t });          // [STRATEGY-RATING] all users, 15 min cache
  } catch (e) {
    if (log && log.debug) log.debug(`[MINIAPP] strategy rating: ${e.message}`);
  }
  return { ok: true, stats, market, recent, trend, rating, market_trend: marketTrend };
}

module.exports = {
  dashboardPayload,
  STRATS, COLS, RATING_TTL_S, VALID_STRATEGIES, LEGACY_STRATEGIES, STATS_HELP_TEXT_RU, TF_ORDER,
  blank, aggregate, signalStats, signalRowsSince, proOverview, proOverviewFromRows, ratingFromRows,
  strategyRating, _resetRatingCache,
  normalizeStrategy, tradeStrategy, autoStats, autoStatsPeriod, todayLossRr, recentSlCount, userTrades,
  userStats, evCalc, pnlAggregate, strategyStats, userStatsByStrategy, dashboardStats,
  formatEvBlock, formatEvShort,
  statBucket, trendCtx, sessionForHour, statsPayload, statsForUser, signalView, userSignals, attachLive,
  pyStr, utcMidnight,
};
