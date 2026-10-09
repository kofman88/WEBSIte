'use strict';
/**
 * publicTrack/trend.js — GET /api/public/trend: the BTC trend monitor's state for the landing
 * ticker.
 *
 * The trend monitor (services/engine/trendMonitor.js = the bot's trend_monitor.py) runs in the
 * engine worker; the HTTP thread sees what it persists: engine_kv `trend_state_v1`
 * ({tf: {trend, since, price}}, written on every confirmed change). This module loads that state
 * into a read-only monitor instance (load_state: same parsing, same TF set) and answers its
 * get_all(), so trend and `since` are the worker's. The ribbon strength is not persisted by the
 * bot, so it is recomputed here with the monitor's own ribbon_strength(df, trend) over the same
 * BTC closed bars (BingX REST: 15m / 1H / 4H every minute, 1D / 1W / 1M every 30 min like the
 * monitor's TREND_REST_REFRESH_S). change_24h is the bot's Mini App `_market()`:
 * round(float(get_24h_change(coin).change_pct or 0), 2), 6 s timeout, null when unavailable.
 *
 * Payload: { symbol: 'BTC', updated_at, tfs: {tf: {trend, strength, since}}, change_24h: {BTC, ETH},
 * source: 'trend_monitor' } — Unix ms; a TF the monitor has no state for is left out; no state
 * for 15m / 1H / 4H → { empty: true, reason }. `strength` / a change is null when the bars / the
 * ticker could not be read.
 */

const tm = require('../engine/trendMonitor');
const { pyRound } = require('../../strategies/common/pyround');

const EMPTY_REASON = 'Тренд BTC появится после запуска монитора';
const CORE_TFS = Object.freeze(['15m', '1H', '4H']);
const SLOW_TTL_S = 1800;
const FAST_TTL_S = 55;
const LIMIT = Object.freeze({ '1M': 120 });
const COINS = Object.freeze(['BTC', 'ETH']);

const quiet = { debug() {}, info() {}, warn() {}, warning() {}, error() {}, critical() {} };

function withTimeout(p, ms) {
  let h = null;
  const timer = new Promise((resolve) => { h = setTimeout(() => resolve(null), ms); if (h && h.unref) h.unref(); });
  return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(h));
}

/**
 * createTrendSource({ kvGet, rest, now, timeoutMs })
 *   kvGet(key) → string | null   (engine_kv; default services/engineKvService.get)
 *   rest       { getCandles(symbol, tf, limit) → Frame|null, get24hChange(symbol) → {change_pct}|null }
 *   now()      unix seconds
 */
function createTrendSource({ kvGet = null, rest = null, now = () => Date.now() / 1000, timeoutMs = 6000 } = {}) {
  const getKv = kvGet || ((k) => require('../engineKvService').get(k));
  const restOf = () => rest || require('../marketData/bingxRest').getRest();
  const frames = new Map();   // tf → { at, frame }

  async function frameOf(tf, t) {
    const ttl = tm.REST_TFS.includes(tf) ? SLOW_TTL_S : FAST_TTL_S;
    const hit = frames.get(tf);
    if (hit && t - hit.at < ttl) return hit.frame;
    let frame = null;
    try {
      frame = await withTimeout(restOf().getCandles(tm.SYMBOL, tf, LIMIT[tf] || 300), timeoutMs);
    } catch (_e) {
      frame = null;
    }
    if (frame && frame.length) {
      frames.set(tf, { at: t, frame });
      return frame;
    }
    return hit ? hit.frame : null;                 // a failed / empty refetch keeps the last bars
  }

  async function changeOf(coin) {
    try {
      const d = await withTimeout(restOf().get24hChange(`${coin}-USDT-SWAP`), timeoutMs);
      if (!d) return null;
      const v = Number(d.change_pct || 0);
      return Number.isFinite(v) ? pyRound(v, 2) : null;
    } catch (_e) {
      return null;
    }
  }

  return {
    async compute() {
      const t = now();
      const mon = tm.createTrendMonitor({
        kv: { get: getKv, set() {}, del() {}, has() { return false; } },
        cache: { getCandles: () => null, setCandles() {} },
        fetcher: null, send: null, log: quiet, now: () => t, env: {},
      });
      mon.loadState();
      const state = mon._state;
      if (!CORE_TFS.every((tf) => state[tf])) return { empty: true, reason: EMPTY_REASON };
      await Promise.all(Object.keys(state).map(async (tf) => {
        const frame = await frameOf(tf, t);
        const s = frame ? tm.ribbonStrength(frame, state[tf].trend) : null;
        if (s !== null && s !== undefined) mon._strength[tf] = s;
      }));
      const all = mon.getAll();
      const tfs = {};
      for (const tf of tm.TFS) {
        const st = all[tf];
        if (!st) continue;
        tfs[tf] = {
          trend: st.trend,
          strength: st.strength === undefined ? null : st.strength,
          since: st.since > 0 ? Math.round(st.since * 1000) : null,
        };
      }
      const changes = await Promise.all(COINS.map(changeOf));
      const change24h = {};
      COINS.forEach((c, i) => { change24h[c] = changes[i]; });
      return { symbol: 'BTC', updated_at: Math.round(t * 1000), tfs, change_24h: change24h, source: 'trend_monitor' };
    },
    _frames: frames,
  };
}

module.exports = { EMPTY_REASON, CORE_TFS, createTrendSource };
