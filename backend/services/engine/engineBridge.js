'use strict';
/**
 * engineBridge.js — the HTTP thread's window into the engine's memory.
 *
 * In the bot the Mini App handlers live in the same process as the scanner and read its memory
 * directly: `cache.get_candles` (the WS candle cache), `signal_freshness.get_current_price` (the
 * last cached 15m / 1H / 4H close), `scanner.get_trend()` (the LEVELS scanner's global BTC / ETH
 * trend text) and `trend_monitor.get_all()`. On the site that memory belongs to the engine worker
 * thread (workers/engineWorker.js), so the app routes ask it through a small query RPC:
 *
 *   main → worker  { type: 'query', id, method, args }
 *   worker → main  { type: 'query-result', id, ok, result | error }
 *
 *   method          worker side (answer())                          bot
 *   currentPrices   signalFreshness.getCurrentPrice per symbol       signal_freshness.get_current_price
 *   cachedCandles   candleCache.getCandles(symbol, tf) → columns      cache.get_candles
 *   globalTrend     ctx.levels.getTrend() (no scanner → {})           scanner.get_trend()
 *   marketTrend     trendMonitor.getAll()                             trend_monitor.get_all()
 *
 * `setRemote(fn)` is installed by startEngine (the supervisor's query). Without a worker (tests,
 * ENGINE_WORKER=0) the answers come from this thread's own module instances — an empty cache,
 * no scanner — which is exactly the bot with nothing cached and `_ctx["scanner"]` unset.
 * A query that does not come back within its timeout resolves to the "nothing known" answer
 * (the bot's `asyncio.wait_for(…, 2)` → None).
 */

const METHODS = Object.freeze(['currentPrices', 'cachedCandles', 'globalTrend', 'marketTrend']);
const DEFAULT_TIMEOUT_MS = 2000;

let remote = null;
let overrides = null;

/** Frame → structured-clone friendly columns (and back). */
function frameToColumns(f) {
  if (!f) return null;
  return { t: Float64Array.from(f.t), o: Float64Array.from(f.o), h: Float64Array.from(f.h), l: Float64Array.from(f.l), c: Float64Array.from(f.c), v: Float64Array.from(f.v) };
}

function columnsToFrame(c) {
  if (!c) return null;
  const { Frame } = require('../../strategies/common/frame');
  return Frame.fromColumns(c);
}

/**
 * Worker side: answer one query from this thread's module state. `ctx` = the scheduler context
 * (ctx.levels = the MidScanner instance) or null.
 */
function answer(method, args = [], ctx = null) {
  switch (method) {
    case 'currentPrices': {
      const fr = require('./signalFreshness');
      const out = {};
      for (const s of (args[0] || [])) {
        let px = null;
        try { px = fr.getCurrentPrice(String(s)); } catch (_e) { px = null; }
        out[s] = px === undefined ? null : px;
      }
      return out;
    }
    case 'cachedCandles': {
      const cc = require('../marketData/candleCache');
      let f = null;
      try { f = cc.getCandles(String(args[0]), String(args[1])); } catch (_e) { f = null; }
      return f && f.length ? frameToColumns(f) : null;
    }
    case 'globalTrend': {
      const sc = ctx && ctx.levels;
      try { return sc && typeof sc.getTrend === 'function' ? (sc.getTrend() || {}) : {}; } catch (_e) { return {}; }
    }
    case 'marketTrend': {
      try { return require('./trendMonitor').getAll(); } catch (_e) { return {}; }
    }
    default:
      throw new Error(`unknown engine query: ${method}`);
  }
}

/** The worker's handler for a { type: 'query' } message (engineWorker.runWorker). */
function handleQueryMessage(msg, post, ctx) {
  if (!msg || msg.type !== 'query') return false;
  try {
    post({ type: 'query-result', id: msg.id, ok: true, result: answer(msg.method, msg.args || [], ctx) });
  } catch (e) {
    post({ type: 'query-result', id: msg.id, ok: false, error: String((e && e.message) || e) });
  }
  return true;
}

/**
 * Main side: a query client over `post` (the supervisor's postMessage). Returns
 * { query(method, args, timeoutMs), handleMessage(msg), failAll() }.
 */
function createQueryClient(post, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (h) => clearTimeout(h) } = {}) {
  const pending = new Map();
  let nextId = 1;
  return {
    query(method, args = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => { pending.delete(id); reject(new Error('engine query timeout')); }, timeoutMs);
        if (timer && timer.unref) timer.unref();
        pending.set(id, { resolve, reject, timer });
        try {
          post({ type: 'query', id, method, args });
        } catch (e) {
          clearTimer(timer); pending.delete(id); reject(e);
        }
      });
    },
    handleMessage(msg) {
      if (!msg || msg.type !== 'query-result') return false;
      const p = pending.get(msg.id);
      if (!p) return true;
      pending.delete(msg.id);
      clearTimer(p.timer);
      if (msg.ok) p.resolve(msg.result); else p.reject(new Error(String(msg.error || 'engine query failed')));
      return true;
    },
    failAll(reason = 'engine worker gone') {
      for (const [id, p] of pending) { clearTimer(p.timer); p.reject(new Error(reason)); pending.delete(id); }
    },
    get pendingCount() { return pending.size; },
  };
}

/** Installed by startEngine: (method, args, timeoutMs) → Promise. null = no worker. */
function setRemote(fn) { remote = typeof fn === 'function' ? fn : null; }

/** Tests: per-method fakes { currentPrices(symbols), cachedCandles(symbol, tf), globalTrend(), marketTrend() }. */
function setOverrides(o) { overrides = o || null; }

async function ask(method, args, timeoutMs, fallback) {
  try {
    if (overrides && typeof overrides[method] === 'function') return await overrides[method](...args);
    if (remote) return await remote(method, args, timeoutMs);
    return answer(method, args, null);
  } catch (_e) {
    return fallback;
  }
}

/** {symbol: price | null} for "XXX-USDT-SWAP" symbols (get_current_price, 2 s). */
async function currentPrices(symbols, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const out = await ask('currentPrices', [Array.from(symbols)], timeoutMs, null);
  return out && typeof out === 'object' ? out : {};
}

/** The cached frame of (symbol, tf) or null (cache.get_candles). */
async function cachedCandles(symbol, tf, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const c = await ask('cachedCandles', [symbol, tf], timeoutMs, null);
  if (!c) return null;
  return c.t && c.c ? columnsToFrame(c) : c;
}

/** scanner.get_trend() → {BTC: {trend_text}, ETH: {...}} | {} */
async function globalTrend(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const t = await ask('globalTrend', [], timeoutMs, {});
  return t && typeof t === 'object' ? t : {};
}

/** trend_monitor.get_all() */
async function marketTrend(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const t = await ask('marketTrend', [], timeoutMs, {});
  return t && typeof t === 'object' ? t : {};
}

module.exports = {
  METHODS, DEFAULT_TIMEOUT_MS,
  answer, handleQueryMessage, createQueryClient, setRemote, setOverrides,
  currentPrices, cachedCandles, globalTrend, marketTrend, frameToColumns, columnsToFrame,
};
