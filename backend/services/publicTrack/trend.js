'use strict';
/**
 * publicTrack/trend.js — GET /api/public/trend: the BTC trend monitor's state for the landing
 * ticker.
 *
 * The trend monitor (services/engine/trendMonitor.js = the bot's trend_monitor.py) runs in the
 * engine worker. While the worker runs, its get_all() is read live through the engine bridge
 * (services/engine/engineBridge.js marketTrend, the same answer the dashboard's `market_trend`
 * gets): trend, `since` and the ribbon strength exactly as the monitor that notifies users holds
 * them. Without a worker (ENGINE_WORKER=0, a web-only process) or when the worker has no state for
 * 15m / 1H / 4H yet, the HTTP thread falls back to what the worker persists: engine_kv
 * `trend_state_v1` ({tf: {trend, since, price}}, written on every confirmed change), loaded into a
 * read-only monitor instance (load_state: same parsing, same TF set). The ribbon strength is not
 * persisted by the bot, so for a TF without one it is recomputed here with the monitor's own
 * ribbon_strength(df, trend) over the same BTC closed bars (BingX REST: 15m / 1H / 4H every
 * minute, 1D / 1W / 1M every 30 min like the monitor's TREND_REST_REFRESH_S). change_24h is the
 * bot's Mini App `_market()`: round(float(get_24h_change(coin).change_pct or 0), 2), 6 s timeout,
 * null when unavailable.
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

/** The running engine worker's trend_monitor.get_all() (engine bridge), or null without a worker. */
async function workerTrend() {
  const bridge = require('../engine/engineBridge');
  if (!bridge.hasRemote()) return null;
  return bridge.marketTrend();
}

/**
 * createTrendSource({ kvGet, rest, now, timeoutMs, live })
 *   kvGet(key) → string | null   (engine_kv; default services/engineKvService.get)
 *   rest       { getCandles(symbol, tf, limit) → Frame|null, get24hChange(symbol) → {change_pct}|null }
 *   now()      unix seconds
 *   live()     → the worker monitor's get_all() | null (default: the engine bridge while a worker runs)
 */
function createTrendSource({ kvGet = null, rest = null, now = () => Date.now() / 1000, timeoutMs = 6000, live = workerTrend } = {}) {
  const getKv = kvGet || ((k) => require('../engineKvService').get(k));
  const restOf = () => rest || require('../marketData/bingxRest').getRest();
  const frames = new Map();   // tf → { at, frame }

  /** get_all() of the worker's monitor when it holds 15m / 1H / 4H, else null. */
  async function liveAll() {
    if (typeof live !== 'function') return null;
    let all = null;
    try { all = await live(); } catch (_e) { return null; }
    if (!all || typeof all !== 'object' || !CORE_TFS.every((tf) => all[tf] && typeof all[tf] === 'object')) return null;
    return all;
  }

  /** get_all() of a read-only monitor over the persisted state (null: no 15m / 1H / 4H), strengths from REST. */
  async function persistedAll(t) {
    const mon = tm.createTrendMonitor({
      kv: { get: getKv, set() {}, del() {}, has() { return false; } },
      cache: { getCandles: () => null, setCandles() {} },
      fetcher: null, send: null, log: quiet, now: () => t, env: {},
    });
    mon.loadState();
    const state = mon._state;
    if (!CORE_TFS.every((tf) => state[tf])) return null;
    await Promise.all(Object.keys(state).map(async (tf) => {
      const frame = await frameOf(tf, t);
      const s = frame ? tm.ribbonStrength(frame, state[tf].trend) : null;
      if (s !== null && s !== undefined) mon._strength[tf] = s;
    }));
    return mon.getAll();
  }

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
      let all = await liveAll();
      if (all) {
        // the worker's monitor; a TF it has not measured yet (strength comes with its first refresh) from REST
        all = Object.fromEntries(Object.entries(all).map(([tf, st]) => [tf, { ...st }]));
        await Promise.all(Object.keys(all).filter((tf) => tm.TFS.includes(tf) && all[tf].strength === undefined).map(async (tf) => {
          const frame = await frameOf(tf, t);
          const s = frame ? tm.ribbonStrength(frame, all[tf].trend) : null;
          if (s !== null && s !== undefined) all[tf].strength = Math.trunc(s);
        }));
      } else {
        all = await persistedAll(t);
        if (!all) return { empty: true, reason: EMPTY_REASON };
      }
      const tfs = {};
      for (const tf of tm.TFS) {
        const st = all[tf];
        if (!st) continue;
        tfs[tf] = {
          trend: st.trend,
          strength: st.strength === undefined ? null : st.strength,
          since: Number(st.since) > 0 ? Math.round(Number(st.since) * 1000) : null,
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

module.exports = { EMPTY_REASON, CORE_TFS, createTrendSource, workerTrend };
