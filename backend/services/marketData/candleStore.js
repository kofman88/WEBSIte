'use strict';
/**
 * candleStore.js — persistent candle history for backtests / Genome
 * (`candle_store.py` + `backtest.BingXHistoryLoader`), stored in the site's
 * `candles_cache` table under `exchange = 'bingx'` (the bot kept a separate
 * `candle_cache_bingx.db`; the site has one SQLite file — PLAN §2.1).
 *
 *   ensureCandles(symbol, tf, days, loader) → Frame | null
 *     use the store when oldest ≤ now − days, newest ≥ now − 2 h and ≥ 50 rows
 *     (adaptive TTL only with ADAPTIVE_CACHE_TTL_ENABLED=1); else `loader.load`
 *     under Semaphore(3) + 0.3 s delay, INSERT OR IGNORE, stale-cache fallback on error.
 *   storeCandles / getCandles / getCoverage / prefetchTopCoins / candlePrefetchLoop /
 *   cleanup (365 days) / cacheStats
 *   HistoryLoader — BingX `/v3/quote/klines` paged backwards in windows of ≤ 1440 bars.
 */

const fs = require('fs');
const { log: defaultLog } = require('./mdLog');
const { fetchJson, isTimeout } = require('./httpClient');
const { Semaphore, defaultSleep } = require('./rateGate');
const sym = require('./symbolMap');
const { Frame } = require('../../strategies/common/frame');
const { TF_TO_BINGX, TF_MS, rowsToFrame, pyInt, pyFloat, pyFalsy } = require('./candleFrame');
const { BINGX_KLINES, BINGX_TICKER, BINGX_CONTRACTS, codeOk, isPlainObject, parseContracts } = require('./bingxRest');
const { pyStrip } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const EXCHANGE = 'bingx';
const FETCH_CONCURRENCY = 3;
const FETCH_DELAY_MS = 300;
const MAX_AGE_DAYS = 365;
const DAY_MS = 86_400_000;
const FRESHNESS_MS = 2 * 3600 * 1000;
const PREFETCH_FRESHNESS_MS = 4 * 3600 * 1000;

// Per-TF base staleness for the adaptive TTL (candle_store._TTL_BASE_BY_TF).
const TTL_BASE_BY_TF = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 });

let _db = null;
let _sem = null;
function _getSem() { if (!_sem) _sem = new Semaphore(FETCH_CONCURRENCY); return _sem; }

/** Inject the better-sqlite3 handle (workers open their own); default = the site DB. */
function setDb(db) { _db = db; _stmts = null; }
function getDb() {
  if (!_db) _db = require('../../models/database');
  return _db;
}

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const db = getDb();
  _stmts = {
    insert: db.prepare(
      'INSERT OR IGNORE INTO candles_cache (exchange, symbol, timeframe, open_time, open, high, low, close, volume, close_time) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    select: db.prepare(
      'SELECT open_time, open, high, low, close, volume FROM candles_cache '
      + 'WHERE exchange = ? AND symbol = ? AND timeframe = ? AND open_time >= ? AND open_time <= ? ORDER BY open_time ASC',
    ),
    coverage: db.prepare(
      'SELECT MIN(open_time) AS oldest, MAX(open_time) AS newest FROM candles_cache WHERE exchange = ? AND symbol = ? AND timeframe = ?',
    ),
    deleteOld: db.prepare('DELETE FROM candles_cache WHERE exchange = ? AND open_time < ?'),
    countAll: db.prepare('SELECT COUNT(*) AS n FROM candles_cache WHERE exchange = ?'),
    countSeries: db.prepare("SELECT COUNT(DISTINCT symbol || '|' || timeframe) AS n FROM candles_cache WHERE exchange = ?"),
  };
  return _stmts;
}

function _tfMs(tf) { return TF_MS[TF_TO_BINGX[tf] ?? '1h'] ?? TF_MS['1h']; }

/** Frame → rows (INSERT OR IGNORE). Returns the number of rows handed to SQLite. */
function storeCandles(symbol, tf, frame, { log = defaultLog } = {}) {
  if (!frame || !frame.length) return 0;
  const n = frame.length;
  const tfMs = _tfMs(tf);
  const stmts = S();
  const run = getDb().transaction(() => {
    for (let i = 0; i < n; i++) {
      stmts.insert.run(EXCHANGE, symbol, tf, frame.t[i], frame.o[i], frame.h[i], frame.l[i], frame.c[i], frame.v[i], frame.t[i] + tfMs);
    }
  });
  try {
    run();
    log.debug(`store_candles ${symbol}/${tf}: ${n} rows`);
    return n;
  } catch (e) {
    log.debug(`store_candles ${symbol}/${tf} skip: ${e && e.message}`);
    return 0;
  }
}

/** Rows in [startMs, endMs] → Frame or null when empty. */
function getCandles(symbol, tf, startMs, endMs) {
  const rows = S().select.all(EXCHANGE, symbol, tf, startMs, endMs);
  if (!rows.length) return null;
  return Frame.fromBars(rows.map((r) => [r.open_time, r.open, r.high, r.low, r.close, r.volume]));
}

/** [oldest_ts, newest_ts] — [0, 0] when nothing is stored. */
function getCoverage(symbol, tf) {
  const row = S().coverage.get(EXCHANGE, symbol, tf);
  if (!row || row.oldest === null || row.oldest === undefined) return [0, 0];
  return [Number(row.oldest), Number(row.newest)];
}

/**
 * candle_store._adaptive_freshness_ms: legacy 2 h unless ADAPTIVE_CACHE_TTL_ENABLED=1;
 * then volatility (last 5 vs last 50 bar ranges) shrinks (×0.5, no 2 h floor, min 30 s)
 * or extends (×1.5) the per-TF base, both floored at 2 h except the shrink.
 */
function adaptiveFreshnessMs(frame, tf, env = process.env, { log = defaultLog } = {}) {
  const baseSec = TTL_BASE_BY_TF[tf] ?? 7200;
  const baseMs = baseSec * 1000;
  const legacyFloorMs = 2 * 3600 * 1000;
  if (pyStrip(String(env.ADAPTIVE_CACHE_TTL_ENABLED ?? '0')) !== '1') return legacyFloorMs;
  if (!frame || frame.length < 50) return Math.max(baseMs, legacyFloorMs);
  try {
    const n = frame.length;
    let s5 = 0; for (let i = n - 5; i < n; i++) s5 += frame.h[i] - frame.l[i];
    let s50 = 0; for (let i = n - 50; i < n; i++) s50 += frame.h[i] - frame.l[i];
    const atrRecent = s5 / 5;
    const atrAvg = s50 / 50;
    if (atrAvg <= 0) return Math.max(baseMs, legacyFloorMs);
    const volRatio = atrRecent / atrAvg;
    if (volRatio > 1.5) {
      const adaptive = Math.max(Math.floor(baseMs / 2), 30_000);
      log.debug(`[CACHE-TTL] tf=${tf} vol_ratio=${volRatio.toFixed(2)} volatile → ttl=${Math.floor(adaptive / 1000)}s`);
      return Math.max(adaptive, 30_000);
    }
    if (volRatio < 0.5) {
      const adaptive = Math.trunc(baseMs * 1.5);
      log.debug(`[CACHE-TTL] tf=${tf} vol_ratio=${volRatio.toFixed(2)} calm → ttl=${Math.floor(adaptive / 1000)}s`);
      return Math.max(adaptive, legacyFloorMs);
    }
    return Math.max(baseMs, legacyFloorMs);
  } catch (_e) {
    return Math.max(baseMs, legacyFloorMs);
  }
}

/**
 * Guarantee candles for the last N days: store hit (coverage + freshness + ≥ 50 rows)
 * or `loader.load(symbol, tf, days)` (Semaphore(3) + 0.3 s), stored with INSERT OR IGNORE.
 */
async function ensureCandles(symbol, tf, days, loader, {
  now = () => Date.now(), sleep = defaultSleep, log = defaultLog, env = process.env,
} = {}) {
  const nowMs = Math.trunc(now());
  const startMs = nowMs - days * DAY_MS;
  const freshnessMs = FRESHNESS_MS;

  const [oldestTs, newestTs] = getCoverage(symbol, tf);
  if (oldestTs > 0 && oldestTs <= startMs && newestTs >= nowMs - freshnessMs) {
    const frame = getCandles(symbol, tf, startMs, nowMs);
    if (frame && frame.length >= 50) {
      const adaptiveMs = adaptiveFreshnessMs(frame, tf, env, { log });
      if (adaptiveMs < freshnessMs && newestTs < nowMs - adaptiveMs) {
        log.debug(`candle_store ADAPTIVE-REFRESH ${symbol}/${tf}: need fresher (newest_age=${Math.floor((nowMs - newestTs) / 1000)}s, adaptive_ttl=${Math.floor(adaptiveMs / 1000)}s)`);
      } else {
        log.debug(`candle_store HIT ${symbol}/${tf}: ${frame.length} bars from cache`);
        return frame;
      }
    }
  }

  const sem = _getSem();
  await sem.acquire();
  let frame;
  try {
    try {
      frame = await loader.load(symbol, tf, days);
    } catch (e) {
      log.warning(`candle_store FETCH ${symbol}/${tf}: ${e && e.message ? e.message : e}`);
      const cached = getCandles(symbol, tf, startMs, nowMs);
      if (cached && cached.length >= 50) {
        log.info(`candle_store FALLBACK ${symbol}/${tf}: ${cached.length} bars from stale cache`);
        return cached;
      }
      return null;
    }
    await sleep(FETCH_DELAY_MS);
  } finally {
    sem.release();
  }

  if (!frame || !frame.length) return null;
  try {
    storeCandles(symbol, tf, frame, { log });
  } catch (e) {
    log.warning(`candle_store STORE ${symbol}/${tf}: ${e && e.message}`);
  }
  return frame;
}

/** Prefetch the top-N coins × tfs × days (4 h freshness). Returns { loaded, cached, failed }. */
async function prefetchTopCoins(loader, topN = 50, tfs = null, days = 30, {
  now = () => Date.now(), sleep = defaultSleep, log = defaultLog,
} = {}) {
  const timeframes = tfs || ['15m', '1h', '4h'];
  const stats = { loaded: 0, cached: 0, failed: 0 };
  let coins;
  try {
    coins = (await loader.getTopCoins(5_000_000)).slice(0, topN);
  } catch (e) {
    log.warning(`prefetch get_top_coins: ${e && e.message}`);
    return stats;
  }
  log.info(`candle_store prefetch: ${coins.length} coins × ${timeframes.length} tfs × ${days} days`);
  for (const tf of timeframes) {
    for (const symbol of coins) {
      try {
        const nowMs = Math.trunc(now());
        const startMs = nowMs - days * DAY_MS;
        const [oldestTs, newestTs] = getCoverage(symbol, tf);
        if (oldestTs > 0 && oldestTs <= startMs && newestTs >= nowMs - PREFETCH_FRESHNESS_MS) {
          stats.cached += 1;
          continue;
        }
        const sem = _getSem();
        await sem.acquire();
        let frame;
        try {
          frame = await loader.load(symbol, tf, days);
          await sleep(FETCH_DELAY_MS);
        } finally {
          sem.release();
        }
        if (frame && frame.length) {
          storeCandles(symbol, tf, frame, { log });
          stats.loaded += 1;
        } else {
          stats.failed += 1;
        }
      } catch (e) {
        log.debug(`prefetch ${symbol}/${tf}: ${e && e.message}`);
        stats.failed += 1;
      }
    }
  }
  log.info(`candle_store prefetch done: ${JSON.stringify(stats)}`);
  return stats;
}

/**
 * Background loop: after a 600 s delay, every `intervalS` prefetch top-20 × (1h, 4h) × 21 d.
 * Returns { stop() }.
 */
function candlePrefetchLoop(loader, intervalS = 3600, {
  initialDelayS = 600, sleep = defaultSleep, log = defaultLog, now,
} = {}) {
  let running = true;
  const run = (async () => {
    log.info(`candle_store prefetch loop started (interval=${intervalS}s)`);
    await sleep(initialDelayS * 1000);
    while (running) {
      try {
        await prefetchTopCoins(loader, 20, ['1h', '4h'], 21, { sleep, log, now });
      } catch (e) {
        log.warning(`candle_prefetch_loop: ${e && e.message}`);
      }
      if (!running) break;
      await sleep(intervalS * 1000);
    }
    log.info('candle_store prefetch loop stopped.');
  })();
  return { stop() { running = false; }, done: run };
}

/** Store statistics: distinct (symbol, tf) series, rows, DB file size. */
function cacheStats() {
  const stats = { symbols: 0, candles: 0, size_mb: 0.0 };
  try {
    stats.symbols = S().countSeries.get(EXCHANGE).n;
    stats.candles = S().countAll.get(EXCHANGE).n;
    const p = getDb().name;
    if (p && fs.existsSync(p)) stats.size_mb = Math.round((fs.statSync(p).size / 1024 / 1024) * 100) / 100;
  } catch (_e) { /* diagnostics only */ }
  return stats;
}

/**
 * Delete rows older than MAX_AGE_DAYS. The bot also ran VACUUM on its dedicated file;
 * here the table lives in the shared site DB, so VACUUM is opt-in (`{ vacuum: true }`).
 */
function cleanup({ now = () => Date.now(), log = defaultLog, vacuum = false } = {}) {
  const cutoffMs = Math.trunc(now() - MAX_AGE_DAYS * DAY_MS);
  try {
    const res = S().deleteOld.run(EXCHANGE, cutoffMs);
    const deleted = res.changes || 0;
    const remaining = S().countAll.get(EXCHANGE).n;
    if (deleted > 0 && vacuum) getDb().exec('VACUUM');
    const p = getDb().name;
    const sizeMb = p && fs.existsSync(p) ? Math.round((fs.statSync(p).size / 1024 / 1024) * 100) / 100 : 0;
    log.info(`🕯 Candle store cleanup: удалено ${deleted} свечей, осталось ${remaining} (${sizeMb.toFixed(1)} MB)`);
    return deleted;
  } catch (e) {
    log.warning(`candle_store cleanup: ${e && e.message}`);
    return 0;
  }
}

// ── HistoryLoader (backtest.BingXHistoryLoader) ─────────────────────────────

class HistoryLoader {
  constructor({
    http = fetchJson, now = () => Date.now(), sleep = defaultSleep, log = defaultLog,
    useCache = true, pageLimit = 1440, pagePauseMs = 200, store = null,
  } = {}) {
    this.source = 'bingx';
    this._http = http;
    this._now = now;
    this._sleep = sleep;
    this._log = log;
    this._useCache = useCache;
    this.PAGE_LIMIT = pageLimit;
    this.PAGE_PAUSE_MS = pagePauseMs;
    this._store = store; // module-like { ensureCandles } (defaults to this module)
  }

  /** 3 attempts: 429 → sleep Retry-After and retry; timeout → 2^attempt s; other errors → null. */
  async _getJson(url, params, what = '') {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await this._http(url, { params, timeoutMs: 30_000, headers: { 'User-Agent': 'CHM-Backtest/1.0' } });
        if (resp.status === 429) {
          const h = resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null;
          let wait = 3;
          try { wait = pyInt(pyFalsy(h) ? 3 : h); } catch (_e) { wait = 3; }
          this._log.warning(`BingX history ${what}: 429, жду ${wait}с`);
          await this._sleep(wait * 1000);
          continue;
        }
        if (resp.status !== 200) {
          this._log.warning(`BingX history ${what}: HTTP ${resp.status}`);
          return null;
        }
        const data = resp.json;
        if (!isPlainObject(data) || !codeOk(data.code)) {
          this._log.warning(`BingX history ${what}: code=${(data || {}).code} msg=${(data || {}).msg ?? ''}`);
          return null;
        }
        return data;
      } catch (e) {
        if (isTimeout(e)) {
          const wait = 2 ** attempt;
          this._log.warning(`BingX history ${what}: таймаут (попытка ${attempt + 1}/3), жду ${wait}с...`);
          if (attempt < 2) await this._sleep(wait * 1000);
        } else {
          this._log.warning(`BingX history ${what}: ${e && e.name ? e.name : 'Error'}: ${e && e.message}`);
          return null;
        }
      }
    }
    return null;
  }

  /** Last `days` days of closed bars, paged backwards in windows of PAGE_LIMIT bars. */
  async load(symbol, timeframe, days) {
    const tf = TF_TO_BINGX[timeframe] ?? '1h';
    const tfMs = TF_MS[tf];
    const nowMs = Math.trunc(this._now());
    const cutoffMs = nowMs - days * DAY_MS;
    const bsym = sym.toBingx(symbol);
    const allRows = [];
    let endMs = nowMs;
    const maxPages = Math.trunc((days * DAY_MS) / (tfMs * this.PAGE_LIMIT)) + 3;
    for (let page = 0; page < maxPages; page++) {
      if (endMs <= cutoffMs) break;
      const startMs = Math.max(cutoffMs, endMs - this.PAGE_LIMIT * tfMs);
      const data = await this._getJson(BINGX_KLINES, {
        symbol: bsym, interval: tf,
        startTime: String(startMs), endTime: String(endMs), limit: String(this.PAGE_LIMIT),
      }, `${symbol}/${tf}`);
      const rows = ((data || {}).data) || [];
      if (!rows.length) break;
      allRows.push(...rows);
      const times = [];
      for (const r of rows) {
        try {
          if (isPlainObject(r)) times.push(pyInt('time' in r ? r.time : r.openTime));
          else times.push(pyInt(r[0]));
        } catch (_e) { /* skip */ }
      }
      if (!times.length) break;
      const oldest = Math.min(...times);
      if (oldest <= cutoffMs || oldest >= endMs) break;
      endMs = oldest - 1;
      await this._sleep(this.PAGE_PAUSE_MS);
    }
    if (!allRows.length) return null;
    const frame = rowsToFrame(allRows, tf, sym.priceMultiplier(symbol), nowMs);
    if (!frame || !frame.length) return null;
    let i = 0;
    while (i < frame.length && frame.t[i] < cutoffMs) i++;
    const out = frame.slice(i).copy();
    return out.length ? out : null;
  }

  /** Through the store (first call = HTTP + INSERT, later = SQLite). */
  async loadCached(symbol, timeframe, days) {
    if (!this._useCache) return this.load(symbol, timeframe, days);
    try {
      const store = this._store || module.exports;
      return await store.ensureCandles(symbol, timeframe, days, this, { now: this._now, sleep: this._sleep, log: this._log });
    } catch (e) {
      this._log.debug(`load_cached ${symbol}/${timeframe}: ${e && e.message} — fallback to direct`);
      return this.load(symbol, timeframe, days);
    }
  }

  /** Top USDT perps by 24 h quoteVolume (canonical symbols), live crypto contracts only. */
  async getTopCoins(minVolumeUsdt = 5_000_000) {
    try {
      const contracts = await this._getJson(BINGX_CONTRACTS, {}, 'contracts');
      const tickers = await this._getJson(BINGX_TICKER, {}, 'ticker');
      if (!tickers) return [];
      let live = null;
      if (contracts) live = parseContracts(contracts.data || []).canon;
      const pairs = [];
      for (const t of tickers.data || []) {
        if (!isPlainObject(t)) continue;
        if (sym.isNonCrypto(t.symbol || '')) continue;
        const canon = sym.fromBingx(t.symbol || '');
        if (!canon || (live !== null && !live.has(canon))) continue;
        let vol;
        try { vol = pyFloat(pyFalsy(t.quoteVolume) ? 0 : t.quoteVolume); } catch (_e) { vol = 0.0; }
        if (vol >= minVolumeUsdt) pairs.push([canon, vol]);
      }
      pairs.sort((a, b) => b[1] - a[1]);
      return pairs.map(([s]) => s);
    } catch (e) {
      this._log.error(`get_top_coins (BingX): ${e && e.message}`);
      return [];
    }
  }
}

function _resetForTests() { _db = null; _stmts = null; _sem = null; }

module.exports = {
  EXCHANGE, FETCH_CONCURRENCY, FETCH_DELAY_MS, MAX_AGE_DAYS, FRESHNESS_MS, PREFETCH_FRESHNESS_MS, TTL_BASE_BY_TF,
  setDb, getDb, storeCandles, getCandles, getCoverage, adaptiveFreshnessMs, ensureCandles,
  prefetchTopCoins, candlePrefetchLoop, cacheStats, cleanup, HistoryLoader, _resetForTests,
};
