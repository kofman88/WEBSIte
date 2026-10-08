'use strict';
/**
 * globalTrend.js — the LEVELS header trend of BTC/ETH (`fetcher.get_global_trend` +
 * `fetcher.global_trend_mark`, periods from `trend_monitor`).
 *
 *   {"BTC": {"trend_text": "H1: 🟢 | H4: 🔴 | D1: ⚪ | W1: ❓"}, "ETH": {...}}
 *
 * Rule (one rule with the trend monitor): on the last closed bar, LONG when
 * close > EMA_slow and EMA_fast > EMA_slow, SHORT when mirrored, else RANGE;
 * EMA = close.ewm(span, adjust=False); periods 50/200, 1W 20/50, 1M 10/20; requires
 * len ≥ slow + 5. BTC uses the confirmed trend monitor state when available (M9 plugs
 * `getMonitorTrend(tf)` in). Cached for TREND_UPDATE_INTERVAL (env, default 900 s).
 */

const { log: defaultLog } = require('./mdLog');
const { ewmSpan } = require('../../strategies/common/series');

const TREND_MARK = Object.freeze({ LONG: '🟢', SHORT: '🔴', RANGE: '⚪' });
const UNKNOWN_MARK = '❓';
const EMA_FAST = 50;
const EMA_SLOW = 200;
const EMA_BY_TF = Object.freeze({ '1W': [20, 50], '1M': [10, 20] });
// trend_monitor._TF_ALIAS
const TF_ALIAS = Object.freeze({
  '15m': '15m', '30m': '1H', '1h': '1H', '1H': '1H', '2h': '4H', '4h': '4H', '4H': '4H',
  '1d': '1D', '1D': '1D', '1w': '1W', '1W': '1W', '1M': '1M', '': '15m',
});
const TREND_TFS = Object.freeze({ '1H': 'H1', '4H': 'H4', '1D': 'D1', '1W': 'W1' });
const TREND_SYMBOLS = Object.freeze(['BTC-USDT-SWAP', 'ETH-USDT-SWAP']);
const DEFAULT_INTERVAL_S = 900;

/** trend_monitor.norm_tf: exact alias, else lower-cased alias, else '15m'. */
function normTf(tf) {
  const s = String(tf ?? '');
  if (Object.prototype.hasOwnProperty.call(TF_ALIAS, s)) return TF_ALIAS[s];
  const l = s.toLowerCase();
  return Object.prototype.hasOwnProperty.call(TF_ALIAS, l) ? TF_ALIAS[l] : '15m';
}

function emaPeriods(tf) { return EMA_BY_TF[tf] || [EMA_FAST, EMA_SLOW]; }

/** Trend on closed bar i (negative i counts from the end); null when i is out of range. */
function trendAt(close, eFast, eSlow, i) {
  const n = close.length;
  const idx = i < 0 ? n + i : i;
  if (idx < 0 || idx >= n || idx >= eFast.length || idx >= eSlow.length) return null;
  const c = close[idx], f = eFast[idx], s = eSlow[idx];
  if (c > s && f > s) return 'LONG';
  if (c < s && f < s) return 'SHORT';
  return 'RANGE';
}

/**
 * 🟢/🔴/⚪ for the header. `frame === null` → the confirmed monitor state for BTC
 * (null when unknown / not BTC); otherwise computed on the frame of closed bars
 * (null when fewer than slow + 5 bars).
 */
function globalTrendMark(name, tf, frame, { getMonitorTrend = null, log = defaultLog } = {}) {
  if (frame === null || frame === undefined) {
    if (name !== 'BTC') return null;
    const t = typeof getMonitorTrend === 'function' ? getMonitorTrend(tf) : null;
    return TREND_MARK[t || ''] ?? null;
  }
  try {
    const [fast, slow] = emaPeriods(normTf(tf));
    if (frame.length < slow + 5) return null;
    const close = frame.c;
    const eFast = ewmSpan(close, fast);
    const eSlow = ewmSpan(close, slow);
    const t = trendAt(close, eFast, eSlow, -1);
    return TREND_MARK[t || ''] ?? null;
  } catch (e) {
    log.debug(`global_trend_mark ${name}/${tf}: ${e && e.message}`);
    return null;
  }
}

function resolveInterval(env = process.env) {
  const n = parseInt(env.TREND_UPDATE_INTERVAL ?? '', 10);
  return Number.isFinite(n) ? n : DEFAULT_INTERVAL_S;
}

/**
 * The cached global-trend getter bound to a REST client.
 *   const gt = createGlobalTrend({ rest }); await gt.get() → { BTC: { trend_text }, ETH: { trend_text } }
 */
function createGlobalTrend({
  rest, now = () => Date.now() / 1000, env = process.env, getMonitorTrend = null, log = defaultLog,
  intervalS = null,
} = {}) {
  let cache = {};
  let cacheTs = 0.0;
  const interval = intervalS === null ? resolveInterval(env) : intervalS;

  async function fetchOne(symbol, okxTf, humTf) {
    const name = symbol.includes('BTC') ? 'BTC' : 'ETH';
    try {
      let mark = globalTrendMark(name, okxTf, null, { getMonitorTrend, log });
      if (mark === null) {
        const frame = await rest.getCandles(symbol, okxTf, 300);
        mark = globalTrendMark(name, okxTf, frame, { getMonitorTrend, log });
      }
      return [name, humTf, `${humTf}: ${mark || UNKNOWN_MARK}`];
    } catch (e) {
      log.warning(`fetcher._fetch_one() unhandled exception: ${e && e.message}`);
      return [name, humTf, `${humTf}: ${UNKNOWN_MARK}`];
    }
  }

  async function get() {
    if (Object.keys(cache).length && now() - cacheTs < interval) return cache;
    const tasks = [];
    for (const symbol of TREND_SYMBOLS) {
      for (const [okxTf, humTf] of Object.entries(TREND_TFS)) tasks.push(fetchOne(symbol, okxTf, humTf));
    }
    const settled = await Promise.allSettled(tasks);
    const byName = { BTC: [], ETH: [] };
    const tfOrder = Object.values(TREND_TFS);
    for (const r of settled) {
      if (r.status !== 'fulfilled') continue;
      const [name, humTf, s] = r.value;
      byName[name].push([humTf, s]);
    }
    const result = {};
    for (const [name, rows] of Object.entries(byName)) {
      rows.sort((a, b) => (tfOrder.includes(a[0]) ? tfOrder.indexOf(a[0]) : 99) - (tfOrder.includes(b[0]) ? tfOrder.indexOf(b[0]) : 99));
      result[name] = { trend_text: rows.map(([, s]) => s).join(' | ') };
    }
    cache = result;
    cacheTs = now();
    return result;
  }

  return { get, invalidate() { cache = {}; cacheTs = 0; }, get interval() { return interval; } };
}

module.exports = {
  TREND_MARK, UNKNOWN_MARK, EMA_FAST, EMA_SLOW, EMA_BY_TF, TF_ALIAS, TREND_TFS, TREND_SYMBOLS, DEFAULT_INTERVAL_S,
  normTf, emaPeriods, trendAt, globalTrendMark, resolveInterval, createGlobalTrend,
};
