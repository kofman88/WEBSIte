'use strict';
/**
 * exchangeSymbols.js — native symbol availability per exchange (`exchange_symbols.py`).
 *
 * Caches of native symbols:
 *   bybit   GET api.bybit.com/v5/market/instruments-info?category=linear&limit=1000 (paged, ≤ 10 pages,
 *           DNS-flap retry ×3) → endswith "USDT" && status == "Trading"
 *   bingx   /openApi/swap/v2/quote/contracts → endswith "-USDT" (also feeds symbolMap.rememberLive)
 *   binance fapi{,1..4}.binance.com/fapi/v1/exchangeInfo → endswith "USDT" && status == "TRADING"
 *           (3 consecutive failures → 1 h pause; DISABLE_BINANCE=1 disables)
 *   okx     /api/v5/public/instruments?instType=SWAP → endswith "-USDT-SWAP"
 * Refresh at start and every 4 h (TTL 14400); an empty/failed result keeps the previous
 * cache; Bybit gets one 10 s retry; `updatedAt` advances only when ≥ 1 exchange refreshed;
 * if bybit or binance is still empty the next refresh comes in 5 min.
 *
 * isAvailable(okxSymbol, exchange, strict=false) / isSymbolAvailable(exchange, symbol, strict):
 * exchange lower-cased; empty cache → true (strict → false); cache age > 2×TTL (8 h) →
 * strict false; native name via toBybitSymbol / toBingxSymbol / toBinanceSymbol / identity
 * for okx; unknown exchange → true (strict false); then `native in set`.
 */

const { fetchJson } = require('../marketData/httpClient');
const { defaultSleep } = require('../marketData/rateGate');
const { log: defaultLog } = require('../marketData/mdLog');
const sym = require('../marketData/symbolMap');
const { pyLower, pyStrip, pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const TTL = 14400;
const STALE_THRESHOLD_SEC = 2 * TTL;
const BINANCE_MAX_FAILS = 3;
const BINANCE_SKIP_SEC = 3600;
const BYBIT_URL = 'https://api.bybit.com/v5/market/instruments-info';
const BINGX_URL = 'https://open-api.bingx.com/openApi/swap/v2/quote/contracts';
const BINANCE_URLS = Object.freeze([
  'https://fapi.binance.com/fapi/v1/exchangeInfo',
  'https://fapi1.binance.com/fapi/v1/exchangeInfo',
  'https://fapi2.binance.com/fapi/v1/exchangeInfo',
  'https://fapi3.binance.com/fapi/v1/exchangeInfo',
  'https://fapi4.binance.com/fapi/v1/exchangeInfo',
]);
const OKX_URL = 'https://www.okx.com/api/v5/public/instruments';
const EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);
const DNS_MARKERS = Object.freeze(['name or service not known', 'name resolution', 'failed to resolve', 'getaddrinfo', 'temporary failure', 'cannot connect', 'connection reset', 'enotfound', 'eai_again', 'econnreset']);
const HEADERS = Object.freeze({ 'User-Agent': 'CHM-Bot/1.0' });

const state = {
  symbols: { bybit: new Set(), bingx: new Set(), binance: new Set(), okx: new Set() },
  updatedAt: 0.0,
  binanceConsecutiveFails: 0,
  binanceSkipUntil: 0.0,
  skipCounter: 0,
  skipSamples: {},
};

let _metricHook = null;
/** Optional metrics sink: (name, tags) → void. Never throws. */
function setMetricHook(fn) { _metricHook = typeof fn === 'function' ? fn : null; }
function _metric(name, tags) {
  if (!_metricHook) return;
  try { _metricHook(name, tags); } catch (_e) { /* metrics must never break business logic */ }
}

const _host = (url) => url.split('//')[1].split('/')[0];

function binanceDisabled(env = process.env) {
  return ['1', 'true', 'yes'].includes(pyStrip(String(env.DISABLE_BINANCE ?? '')));
}

// ── fetchers ────────────────────────────────────────────────────────────────

async function fetchBybit({ http = fetchJson, sleep = defaultSleep, log = defaultLog, random = Math.random } = {}) {
  const result = new Set();
  let cursor = '';
  let pages = 0;
  while (pages < 10) {
    const params = { category: 'linear', limit: '1000' };
    if (cursor) params.cursor = cursor;
    let pageOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await http(BYBIT_URL, { params, timeoutMs: 30_000, headers: HEADERS });
        if (resp.status !== 200) {
          log.warning(`Bybit instruments HTTP ${resp.status}`);
          return result;
        }
        const data = resp.json || {};
        const items = ((data.result || {}).list) || [];
        for (const item of items) {
          const s = item.symbol || '';
          if (s.endsWith('USDT') && item.status === 'Trading') result.add(s);
        }
        cursor = (data.result || {}).nextPageCursor || '';
        pages += 1;
        pageOk = true;
        if (!cursor) return result;
        await sleep(100);
        break;
      } catch (e) {
        const err = pyLower(String(e && (e.message || e.code) || e));
        const isDns = DNS_MARKERS.some((m) => err.includes(m));
        if (isDns && attempt < 2) {
          const backoff = (attempt + 1) * 2 * (0.7 + random() * 0.6);
          log.warning(`Bybit instruments DNS flap attempt=${attempt + 1} — retry in ${backoff.toFixed(1)}s: ${e && e.message}`);
          await sleep(backoff * 1000);
          continue;
        }
        log.warning(`Bybit instruments fetch error: ${e && e.message}`);
        return result;
      }
    }
    if (!pageOk) break;
  }
  return result;
}

async function fetchBingx({ http = fetchJson, log = defaultLog } = {}) {
  const result = new Set();
  try {
    const resp = await http(BINGX_URL, { timeoutMs: 30_000, headers: HEADERS });
    if (resp.status !== 200) {
      log.warning(`BingX contracts HTTP ${resp.status}`);
      return result;
    }
    const live = [];
    for (const item of ((resp.json || {}).data) || []) {
      const s = item.symbol || '';
      if (s.endsWith('-USDT')) {
        result.add(s);
        if (['1', 'True', 'true'].includes(String(item.status === undefined ? 1 : item.status))) live.push(s);
      }
    }
    try { sym.rememberLive(live); } catch (e) { log.debug(`BingX live names: ${e && e.message}`); }
  } catch (e) {
    log.warning(`BingX contracts fetch error: ${e && e.message}`);
  }
  return result;
}

async function fetchBinance({ http = fetchJson, now = () => Date.now() / 1000, log = defaultLog, env = process.env } = {}) {
  const result = new Set();
  if (binanceDisabled(env)) return result;
  const t = now();
  if (t < state.binanceSkipUntil) return result; // circuit breaker — silent
  let lastError = null;
  for (const url of BINANCE_URLS) {
    try {
      const resp = await http(url, { timeoutMs: 15_000, headers: HEADERS });
      if (resp.status !== 200) {
        log.debug(`Binance ${_host(url)} HTTP ${resp.status}`);
        continue;
      }
      for (const item of ((resp.json || {}).symbols) || []) {
        const s = item.symbol || '';
        if (s.endsWith('USDT') && item.status === 'TRADING') result.add(s);
      }
      if (result.size) {
        log.info(`Binance symbols loaded from ${_host(url)}: ${result.size}`);
        state.binanceConsecutiveFails = 0;
        return result;
      }
    } catch (e) {
      lastError = e;
      log.debug(`Binance ${_host(url)} error: ${e && e.message}`);
      continue;
    }
  }
  state.binanceConsecutiveFails += 1;
  if (state.binanceConsecutiveFails >= BINANCE_MAX_FAILS) {
    state.binanceSkipUntil = t + BINANCE_SKIP_SEC;
    log.warning(`Binance: ${state.binanceConsecutiveFails} неудач подряд — пауза ${BINANCE_SKIP_SEC}с (вероятно, геоблок). Поставь DISABLE_BINANCE=1 в .env чтобы заглушить.`);
    state.binanceConsecutiveFails = 0;
  } else if (lastError) {
    log.warning(`Binance: все endpoints недоступны. Последняя ошибка: ${lastError && lastError.message}`);
  }
  return result;
}

async function fetchOkx({ http = fetchJson, log = defaultLog } = {}) {
  const result = new Set();
  try {
    const resp = await http(OKX_URL, { params: { instType: 'SWAP' }, timeoutMs: 30_000, headers: HEADERS });
    if (resp.status !== 200) {
      log.warning(`OKX instruments HTTP ${resp.status}`);
      return result;
    }
    for (const item of ((resp.json || {}).data) || []) {
      const s = item.instId || '';
      if (s.endsWith('-USDT-SWAP')) result.add(s);
    }
  } catch (e) {
    log.warning(`OKX instruments fetch error: ${e && e.message}`);
  }
  return result;
}

// ── refresh ─────────────────────────────────────────────────────────────────

async function refresh({
  http = fetchJson, now = () => Date.now() / 1000, sleep = defaultSleep, log = defaultLog,
  env = process.env, random = Math.random,
} = {}) {
  const prevSnapshot = Object.fromEntries(Object.entries(state.symbols).map(([k, v]) => [k, new Set(v)]));
  try {
    const settled = await Promise.allSettled([
      fetchBybit({ http, sleep, log, random }),
      fetchBingx({ http, log }),
      fetchBinance({ http, now, log, env }),
      fetchOkx({ http, log }),
    ]);
    const asResult = (r) => (r.status === 'fulfilled' ? r.value : r.reason);
    let succeeded = 0;
    const plan = [
      ['bybit', asResult(settled[0]), () => fetchBybit({ http, sleep, log, random })],
      ['bingx', asResult(settled[1]), null],
      ['binance', asResult(settled[2]), null],
      ['okx', asResult(settled[3]), null],
    ];
    for (const [name, result, retryFetcher] of plan) {
      if (result instanceof Set && result.size) {
        state.symbols[name] = result;
        succeeded += 1;
        continue;
      }
      const prevCount = (state.symbols[name] || new Set()).size;
      const age = state.updatedAt ? Math.trunc(now() - state.updatedAt) : -1;
      if (result instanceof Set) {
        log.warning(`${pyUpper(name)} refresh returned 0 — keeping previous cache (${prevCount} symbols, age ${age}s)`);
      } else {
        log.warning(`${pyUpper(name)} refresh raised — keeping previous cache (${prevCount} symbols, age ${age}s): ${result && result.message ? result.message : result}`);
      }
      if (!retryFetcher) continue;
      log.warning(`⚠️ ${pyUpper(name)}: retry через 10с...`);
      await sleep(10_000);
      try {
        const retry = await retryFetcher();
        if (retry && retry.size) {
          state.symbols[name] = retry;
          succeeded += 1;
          log.info(`✅ ${pyUpper(name)} retry: ${retry.size} символов`);
        } else {
          log.warning(`${pyUpper(name)} retry still returned 0 — cache preserved (${prevCount} symbols)`);
        }
      } catch (re) {
        log.warning(`${pyUpper(name)} retry failed — cache preserved (${prevCount} symbols): ${re && re.message}`);
      }
    }

    const beforeBybit = prevSnapshot.bybit || new Set();
    let delistedExamples = [];
    if (beforeBybit.size && state.symbols.bybit.size) {
      const delisted = Array.from(beforeBybit).filter((s) => !state.symbols.bybit.has(s));
      if (delisted.length) delistedExamples = delisted.sort().slice(0, 5);
    }
    if (succeeded > 0) {
      state.updatedAt = now();
    } else {
      log.warning(`exchange_symbols.refresh: ALL 4 exchanges returned empty — NOT advancing _updated_at (current age: ${state.updatedAt ? Math.trunc(now() - state.updatedAt) : -1}s). Staleness metric will fire after ${Math.trunc(STALE_THRESHOLD_SEC / 3600)}h.`);
    }
    const counts = `Bybit=${state.symbols.bybit.size}, BingX=${state.symbols.bingx.size}, Binance=${state.symbols.binance.size}, OKX=${state.symbols.okx.size}`;
    if (delistedExamples.length) log.info(`Exchange symbols refreshed: ${counts} | Bybit delisted examples: ${delistedExamples.join(', ')}`);
    else log.info(`Exchange symbols refreshed: ${counts}`);

    let criticalFailed = false;
    for (const ex of ['bybit', 'bingx', 'binance']) {
      if (state.symbols[ex].size) continue;
      if (ex === 'binance' && (binanceDisabled(env) || now() < state.binanceSkipUntil)) {
        log.debug('Binance disabled/paused — filter off');
        continue;
      }
      log.warning(`⚠️ ${pyUpper(ex)}: 0 символов — фильтрация ОТКЛЮЧЕНА (fail-open). Сигналы будут идти без проверки доступности на бирже.`);
      if (ex === 'bybit' || ex === 'binance') criticalFailed = true;
    }
    if (criticalFailed) {
      state.updatedAt = now() - (TTL - 300);
      log.info('🔄 Critical exchange has 0 symbols — next refresh in 5 min');
    }
  } catch (e) {
    log.warning(`exchange_symbols.refresh failed: ${e && e.message}`);
  }
}

// ── availability ────────────────────────────────────────────────────────────

function cacheAgeSec(now = () => Date.now() / 1000) {
  if (!state.updatedAt) return null;
  return now() - state.updatedAt;
}

function _strictOf(opts) {
  if (opts && typeof opts === 'object') return !!opts.strict;
  return !!opts;
}

function _nativeFor(exchange, symbol) {
  if (exchange === 'bybit') return sym.toBybitSymbol(symbol);
  if (exchange === 'bingx') return sym.toBingxSymbol(symbol);
  if (exchange === 'binance') return sym.toBinanceSymbol(symbol);
  if (exchange === 'okx') return symbol;
  return undefined;
}

/**
 * Is the canonical symbol tradable on `exchange`? Fail-open (true) on an empty cache or
 * unknown exchange unless `strict`; a cache older than 8 h fails closed in strict mode.
 */
function isAvailable(okxSymbol, exchange, opts = false, { now = () => Date.now() / 1000 } = {}) {
  const strict = _strictOf(opts);
  const ex = pyLower(String(exchange || ''));
  _metric('symbol_check_total', { exchange: ex });
  const set = state.symbols[ex];
  if (!set || !set.size) {
    _metric('symbol_check_fail_open', { exchange: ex, reason: 'cache_empty', symbol: String(okxSymbol || '').slice(0, 20) });
    return !strict;
  }
  const age = cacheAgeSec(now);
  if (age !== null && age > STALE_THRESHOLD_SEC) {
    _metric('symbol_check_stale', { exchange: ex, age_hours: Math.trunc(age / 3600) });
    if (strict) return false;
  }
  const native = _nativeFor(ex, okxSymbol);
  if (native === undefined) {
    _metric('symbol_check_fail_open', { exchange: ex, reason: 'unknown_exchange', symbol: String(okxSymbol || '').slice(0, 20) });
    return !strict;
  }
  const found = set.has(native);
  if (!found) _metric('scanner_invalid_symbol_filtered', { exchange: ex, symbol: String(okxSymbol || '').slice(0, 20) });
  return found;
}

/** Same check with the rotated signature; accepts native names as-is. */
function isSymbolAvailable(exchange, symbol, opts = false, { now = () => Date.now() / 1000, log = defaultLog } = {}) {
  const strict = _strictOf(opts);
  const ex = pyLower(String(exchange || ''));
  _metric('symbol_check_total', { exchange: ex });
  const set = state.symbols[ex];
  if (!set || !set.size) {
    _metric('symbol_check_fail_open', { exchange: ex, reason: 'cache_empty', symbol: String(symbol || '').slice(0, 20) });
    return !strict;
  }
  const age = cacheAgeSec(now);
  if (age !== null && age > STALE_THRESHOLD_SEC) {
    _metric('symbol_check_stale', { exchange: ex, age_hours: Math.trunc(age / 3600) });
    if (strict) return false;
  }
  if (set.has(symbol)) return true;
  let native;
  try {
    native = _nativeFor(ex, symbol);
    if (native === undefined) {
      _metric('symbol_check_fail_open', { exchange: ex, reason: 'unknown_exchange', symbol: String(symbol || '').slice(0, 20) });
      return !strict;
    }
  } catch (e) {
    log.debug(`is_symbol_available normalize fail ${ex}/${symbol}: ${e && e.message}`);
    _metric('symbol_check_fail_open', { exchange: ex, reason: 'normalize_failed', symbol: String(symbol || '').slice(0, 20) });
    return !strict;
  }
  const found = set.has(native);
  if (!found) _metric('scanner_invalid_symbol_filtered', { exchange: ex, symbol: String(symbol || '').slice(0, 20) });
  return found;
}

function recordSkip(exchange, symbol) {
  const ex = pyLower(String(exchange || ''));
  state.skipCounter += 1;
  const key = `${ex}/${symbol}`;
  state.skipSamples[key] = (state.skipSamples[key] || 0) + 1;
}

function popSkipCounter() {
  const n = state.skipCounter;
  const samples = { ...state.skipSamples };
  state.skipCounter = 0;
  state.skipSamples = {};
  return [n, samples];
}

function getStats({ now = () => Date.now() / 1000, env = process.env } = {}) {
  const t = now();
  return {
    bybit: state.symbols.bybit.size,
    bingx: state.symbols.bingx.size,
    binance: state.symbols.binance.size,
    okx: state.symbols.okx.size,
    updated_at: state.updatedAt,
    age_sec: state.updatedAt ? Math.trunc(t - state.updatedAt) : null,
    skip_counter: state.skipCounter,
    ttl_sec: TTL,
    stale_threshold_sec: STALE_THRESHOLD_SEC,
    binance_disabled: binanceDisabled(env),
    binance_paused_until: state.binanceSkipUntil,
    binance_paused: t < state.binanceSkipUntil,
  };
}

/** Initial refresh + background loop (sleeps until updatedAt + TTL, min 60 s). Returns { stop }. */
async function startBackgroundRefresh(opts = {}) {
  const { now = () => Date.now() / 1000, sleep = defaultSleep } = opts;
  await refresh(opts);
  let running = true;
  const loop = (async () => {
    while (running) {
      const wait = Math.max(60, state.updatedAt + TTL - now());
      await sleep(wait * 1000);
      if (!running) break;
      await refresh(opts);
    }
  })();
  return { stop() { running = false; }, done: loop };
}

/** Tests: seed / inspect / reset the module state. */
function _setSymbols(exchange, symbols, { updatedAt } = {}) {
  state.symbols[pyLower(String(exchange))] = new Set(symbols);
  if (updatedAt !== undefined) state.updatedAt = updatedAt;
}
function _getState() { return state; }
function _resetForTests() {
  for (const ex of EXCHANGES) state.symbols[ex] = new Set();
  state.updatedAt = 0.0;
  state.binanceConsecutiveFails = 0;
  state.binanceSkipUntil = 0.0;
  state.skipCounter = 0;
  state.skipSamples = {};
  _metricHook = null;
}

module.exports = {
  TTL, STALE_THRESHOLD_SEC, BINANCE_MAX_FAILS, BINANCE_SKIP_SEC, EXCHANGES,
  BYBIT_URL, BINGX_URL, BINANCE_URLS, OKX_URL,
  fetchBybit, fetchBingx, fetchBinance, fetchOkx, refresh, cacheAgeSec,
  isAvailable, isSymbolAvailable, recordSkip, popSkipCounter, getStats, startBackgroundRefresh,
  setMetricHook, binanceDisabled, _setSymbols, _getState, _resetForTests,
};
