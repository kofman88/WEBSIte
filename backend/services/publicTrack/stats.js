'use strict';
/**
 * publicTrack/stats.js — GET /api/public/stats from the published (delayed) states of the
 * archive. Pure: rows [{bot_id, created_at, status, r}] (oldest first) + view time V.
 *
 * Counting rules (the honesty rules of frontend/landing/README.md):
 *   • one paper signal counts once, by its public status: open / tp1 → open; tp1be, tp2be, tp3,
 *     sl, exp → closed; missed (never filled) → neither (missed_signals). The per-user bot
 *     aggregate (signalStats.aggregate) also counts a running TP1 / TP2 as a closed win with its
 *     planned R — a bot quirk the app keeps, the public track does not inherit it;
 *   • R is after the fee estimate (view.feeR); an `exp` without a mark-to-market R counts as an
 *     outcome but not in any R figure;
 *   • no platform-wide R sum: per bot (track account × strategy) 30-day R, then the median, the
 *     number of bots in plus, the worst next to the best, the median drawdown;
 *   • fewer than STATS_MIN_CLOSED closed signals → the honest empty payload.
 * Time fields are Unix ms; `updated_at` is V (the track as of now − 60 min).
 */

const { pyRound } = require('../../strategies/common/pyround');
const {
  STATS_MIN_CLOSED, SHOWCASE_MIN_SIGNALS, SHOWCASE_MIN_DAYS, OUTCOMES_WINDOW, BOTS_WINDOW_DAYS, DELAY_S, FEES,
} = require('./config');
const { isFinal, isRunning } = require('./view');

const EMPTY_REASON = 'Статистика появится после 30 закрытых сигналов';
const DAY = 86400;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** max peak-to-trough of the cumulative R (starting at 0) */
function maxDrawdown(rs) {
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    eq += r;
    if (eq > peak) peak = eq;
    if (peak - eq > dd) dd = peak - eq;
  }
  return dd;
}

const r2 = (x) => (x === null ? null : pyRound(x, 2));

function statsPayload(rows, v) {
  const vMs = Math.floor(v * 1000);
  let tracked = 0;
  let open = 0;
  let closed = 0;
  let missed = 0;
  let first = null;
  const bots = new Map();
  for (const row of rows) {
    if (row.created_at > v) continue;
    tracked += 1;
    if (first === null || row.created_at < first) first = row.created_at;
    let b = bots.get(row.bot_id);
    if (!b) { b = { first: row.created_at, closed: [] }; bots.set(row.bot_id, b); }
    if (row.created_at < b.first) b.first = row.created_at;
    if (isRunning(row.status)) open += 1;
    else if (isFinal(row.status)) { closed += 1; b.closed.push(row); }
    else missed += 1;
  }
  if (closed < STATS_MIN_CLOSED) return { empty: true, reason: EMPTY_REASON };

  const cutoff = v - BOTS_WINDOW_DAYS * DAY;
  const sums = [];
  const dds = [];
  let n30 = 0;
  for (const b of bots.values()) {
    const rs = b.closed.filter((x) => x.created_at > cutoff && x.r !== null && x.r !== undefined).map((x) => Number(x.r));
    if (!rs.length) continue;
    let s = 0;
    for (const x of rs) s += x;            // Python sum(): left to right
    sums.push(pyRound(s, 2));
    dds.push(pyRound(maxDrawdown(rs), 2));
    n30 += rs.length;
  }
  const outcomes = { tp2plus: 0, tp1be: 0, sl: 0, exp: 0 };
  for (const b of bots.values()) {
    for (const x of b.closed.slice(-OUTCOMES_WINDOW)) {
      if (x.status === 'tp2be' || x.status === 'tp3') outcomes.tp2plus += 1;
      else if (x.status === 'tp1be') outcomes.tp1be += 1;
      else if (x.status === 'sl') outcomes.sl += 1;
      else outcomes.exp += 1;
    }
  }
  let qualified = 0;
  for (const b of bots.values()) {
    if (b.closed.length >= SHOWCASE_MIN_SIGNALS && v - b.first >= SHOWCASE_MIN_DAYS * DAY) qualified += 1;
  }
  const firstMs = Math.floor(first * 1000);
  return {
    source: 'paper',
    tracked_signals: { value: tracked, updated_at: vMs },
    closed_signals: { value: closed, updated_at: vMs },
    open_signals: { value: open, updated_at: vMs },
    showcase_days: { value: Math.floor((v - first) / DAY), since: firstMs, updated_at: vMs },
    bots_30d: {
      median_r: r2(median(sums)),
      positive: sums.filter((x) => x > 0).length,
      total: sums.length,
      worst_r: sums.length ? Math.min(...sums) : null,
      best_r: sums.length ? Math.max(...sums) : null,
      n: n30,
      median_dd_r: r2(median(dds)),
      updated_at: vMs,
    },
    outcomes_recent: { ...outcomes, window: `последние ${OUTCOMES_WINDOW} сделки каждого бота`, updated_at: vMs },
    registry: {
      launched_since: firstMs, candidates: bots.size, published: 0, waiting: bots.size, archived: 0, qualified,
    },
    missed_signals: { value: missed, updated_at: vMs },
    delay_min: DELAY_S / 60,
    updated_at: vMs,
    rules: { min_closed: STATS_MIN_CLOSED, min_signals: SHOWCASE_MIN_SIGNALS, min_days: SHOWCASE_MIN_DAYS, bots_window_days: BOTS_WINDOW_DAYS },
    fees: FEES,
  };
}

module.exports = { EMPTY_REASON, median, maxDrawdown, statsPayload };
