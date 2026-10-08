'use strict';
/**
 * coinBasket.js — the genome coin basket (genome-challenge-profiles.md §1.7):
 *
 *   scoreCoin(df, strategy)                  ATR % / volume / EMA9-21 trend score (null = skip)
 *   buildTierMixedBasket(scored, limit, tier2Pool)   Tier 1 benchmark 40 % + Tier 2 mcap 30 % + Tier 3 ATR
 *   getTier2Dynamic(deps)                    CoinGecko top-30 by mcap → canonical symbols (24 h cache), static fallback
 *   getContextAwareCoins(tf, strategy, limit, deps)  the whole _get_context_aware_coins (15 min cache)
 *   getTopCoinsCached(tf, deps)              the fallback list (10 min cache, 3 attempts, stale, hardcoded 20)
 *
 * I/O is injected: `deps.loader` = candleStore.HistoryLoader-like {getTopCoins(min), loadCached(coin, tf, days)},
 * `deps.http` = httpClient.fetchJson-like (CoinGecko), `deps.sleep(ms)`, `deps.now()` (s), `deps.log`.
 */

const S = require('../../strategies/common/series');
const { pyMin2 } = require('../../strategies/common/pyval');
const C = require('./config');

const COIN_BLACKLIST = Object.freeze(new Set([
  'LAB-USDT-SWAP', 'MON-USDT-SWAP', 'PENGU-USDT-SWAP', 'BASED-USDT-SWAP', 'WLFI-USDT-SWAP',
  'GALA-USDT-SWAP', 'HMSTR-USDT-SWAP', 'ENJ-USDT-SWAP', 'BOME-USDT-SWAP', 'WET-USDT-SWAP',
  'ZAMA-USDT-SWAP', 'SAHARA-USDT-SWAP', 'ROBO-USDT-SWAP', 'STABLE-USDT-SWAP', 'SIGN-USDT-SWAP',
]));

const TIER1_BENCHMARK = Object.freeze(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'BNB-USDT-SWAP', 'XRP-USDT-SWAP']);

const TIER2_MCAP_STATIC = Object.freeze([
  'ADA-USDT-SWAP', 'AVAX-USDT-SWAP', 'LINK-USDT-SWAP', 'DOT-USDT-SWAP',
  'ATOM-USDT-SWAP', 'LTC-USDT-SWAP', 'TRX-USDT-SWAP', 'DOGE-USDT-SWAP',
  'MATIC-USDT-SWAP', 'NEAR-USDT-SWAP', 'OP-USDT-SWAP', 'ARB-USDT-SWAP',
  'APT-USDT-SWAP', 'TON-USDT-SWAP', 'FIL-USDT-SWAP', 'INJ-USDT-SWAP',
  'TIA-USDT-SWAP', 'SUI-USDT-SWAP', 'SEI-USDT-SWAP', 'JUP-USDT-SWAP',
]);

/** _CG_ID_TO_OKX (null = already Tier 1). */
const CG_ID_TO_OKX = Object.freeze({
  bitcoin: null, ethereum: null, solana: null, binancecoin: null, ripple: null,
  cardano: 'ADA-USDT-SWAP', 'avalanche-2': 'AVAX-USDT-SWAP',
  chainlink: 'LINK-USDT-SWAP', polkadot: 'DOT-USDT-SWAP',
  cosmos: 'ATOM-USDT-SWAP', litecoin: 'LTC-USDT-SWAP',
  tron: 'TRX-USDT-SWAP', dogecoin: 'DOGE-USDT-SWAP',
  'matic-network': 'MATIC-USDT-SWAP', near: 'NEAR-USDT-SWAP',
  optimism: 'OP-USDT-SWAP', arbitrum: 'ARB-USDT-SWAP',
  aptos: 'APT-USDT-SWAP', 'the-open-network': 'TON-USDT-SWAP',
  filecoin: 'FIL-USDT-SWAP', 'injective-protocol': 'INJ-USDT-SWAP',
  celestia: 'TIA-USDT-SWAP', sui: 'SUI-USDT-SWAP',
  'sei-network': 'SEI-USDT-SWAP', 'jupiter-exchange-solana': 'JUP-USDT-SWAP',
  stellar: 'XLM-USDT-SWAP', 'hedera-hashgraph': 'HBAR-USDT-SWAP',
  'render-token': 'RNDR-USDT-SWAP', 'the-graph': 'GRT-USDT-SWAP',
  kaspa: 'KAS-USDT-SWAP', 'official-trump': 'TRUMP-USDT-SWAP',
});

const FALLBACK_COINS = Object.freeze([
  'BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'XRP-USDT-SWAP',
  'DOGE-USDT-SWAP', 'ADA-USDT-SWAP', 'AVAX-USDT-SWAP', 'LINK-USDT-SWAP',
  'DOT-USDT-SWAP', 'MATIC-USDT-SWAP', 'UNI-USDT-SWAP', 'ATOM-USDT-SWAP',
  'LTC-USDT-SWAP', 'FIL-USDT-SWAP', 'APT-USDT-SWAP', 'ARB-USDT-SWAP',
  'OP-USDT-SWAP', 'NEAR-USDT-SWAP', 'TIA-USDT-SWAP', 'SUI-USDT-SWAP',
]);

const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';

const isBlacklisted = (coin) => COIN_BLACKLIST.has(coin);

// process-wide caches (genome._CONTEXT_COINS_CACHE / _top_coins_cache / _TIER2_DYNAMIC_CACHE)
const caches = { context: new Map(), top: new Map(), tier2: { ts: 0, list: [] } };
function _resetCaches() { caches.context.clear(); caches.top.clear(); caches.tier2 = { ts: 0, list: [] }; }

const defaultLog = () => require('../../utils/logger');
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * _score_coin's pure part on a 14-day frame: null when < 100 rows or ATR % < 1.0;
 * score = min(2, atr%/1.5) + min(1.5, √(vol/2M)) + trend (LEVELS/SMC: min(1.5, |ema9−ema21|/ema21×100) if > 1, else 1).
 */
function scoreCoin(df, strategy) {
  if (!df || df.length < 100 || !df.h || !df.l) return null;
  const n = df.length;
  const tr = S.trueRange(df.h, df.l, df.c);
  const atr = S.rollingMean(tr, 14, 14)[n - 1];
  const close = df.c[n - 1];
  const atrPct = close > 0 ? atr / close * 100 : 0;
  if (atrPct < 1.0) return null;
  const atrScore = pyMin2(2.0, atrPct / 1.5);
  const vol = df.v ? df.v[n - 1] : 0;
  const volScore = pyMin2(1.5, Math.sqrt(vol / 2_000_000));
  let trendScore = 1.0;
  if (strategy === 'LEVELS' || strategy === 'SMC') {
    const ef = S.ewmSpan(df.c, 9)[n - 1];
    const es = S.ewmSpan(df.c, 21)[n - 1];
    const diff = Math.abs(ef - es) / es * 100;
    if (diff > 1.0) trendScore = pyMin2(1.5, diff);
  }
  return atrScore + volScore + trendScore;
}

/** _get_tier2_dynamic(): CoinGecko (10 s timeout) mapped through CG_ID_TO_OKX, cached 24 h. */
async function getTier2Dynamic(deps = {}) {
  const now = (deps.now || (() => Date.now() / 1000))();
  const log = deps.log || defaultLog();
  if (caches.tier2.list.length && now - caches.tier2.ts < C.TIER2_DYNAMIC_TTL) return caches.tier2.list.slice();
  try {
    const http = deps.http || require('../marketData/httpClient').fetchJson;
    const resp = await http(COINGECKO_MARKETS, {
      params: { vs_currency: 'usd', order: 'market_cap_desc', per_page: '30', page: '1' }, timeoutMs: 10_000,
    });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
    const data = resp.json;
    if (!Array.isArray(data)) throw new Error('Bad CoinGecko response shape');
    const out = [];
    for (const item of data) {
      const id = item && typeof item === 'object' && item.id !== undefined ? item.id : '';
      const okx = Object.prototype.hasOwnProperty.call(CG_ID_TO_OKX, id) ? CG_ID_TO_OKX[id] : null;
      if (okx && !out.includes(okx)) out.push(okx);
    }
    if (!out.length) throw new Error('Empty mapped list');
    caches.tier2 = { ts: now, list: out };
    log.info(`🧬 [GENOME-HOTFIX] Tier2 dynamic refresh: ${out.length} coins from CoinGecko`);
    return out.slice();
  } catch (e) {
    log.debug(`Tier2 dynamic fetch failed (using static): ${e && e.message}`);
    return TIER2_MCAP_STATIC.slice();
  }
}

/** _build_tier_mixed_basket(scored, limit, …) with the Tier 2 pool given. */
function buildTierMixedBasket(scored, limit, tier2Pool) {
  if (limit <= 0) return [];
  const nT1 = Math.max(1, Math.trunc(limit * 0.40));
  const nT2 = Math.max(1, Math.trunc(limit * 0.30));
  const scoredMap = new Map(scored.map(([c, s]) => [c, s]));
  const used = new Set();
  const result = [];

  for (const coin of TIER1_BENCHMARK) {
    if (result.length >= nT1) break;
    if (used.has(coin) || isBlacklisted(coin)) continue;
    used.add(coin);
    result.push(coin);
  }

  const pool = tier2Pool || [];
  const poolSet = new Set(pool);
  const t2 = pool.filter((c) => !used.has(c) && !isBlacklisted(c))
    .map((c, i) => [c, scoredMap.has(c) ? scoredMap.get(c) : 0.0, i])
    .sort((a, b) => (b[1] - a[1]) || (a[2] - b[2]))
    .map((x) => x[0]);
  for (const coin of t2) {
    if (result.filter((c) => poolSet.has(c)).length >= nT2) break;
    used.add(coin);
    result.push(coin);
  }

  for (const [coin] of scored) {
    if (result.length >= limit) break;
    if (used.has(coin) || isBlacklisted(coin)) continue;
    used.add(coin);
    result.push(coin);
  }

  if (result.length < limit) {
    for (const coin of pool) {
      if (result.length >= limit) break;
      if (!used.has(coin) && !isBlacklisted(coin)) {
        used.add(coin);
        result.push(coin);
      }
    }
  }
  return result.slice(0, limit);
}

/** Bounded concurrency map (asyncio.Semaphore(n) + gather), results in input order. */
async function mapBounded(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      try { out[k] = await fn(items[k], k); } catch (_e) { out[k] = null; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** _get_top_coins_cached(tf): 10 min cache; 3 attempts (2 s pause after an error); stale; hardcoded 20. */
async function getTopCoinsCached(tf, deps = {}) {
  const now = deps.now || (() => Date.now() / 1000);
  const sleep = deps.sleep || realSleep;
  const log = deps.log || defaultLog();
  const cached = caches.top.get(tf);
  if (cached && now() - cached.ts < C.TOP_COINS_CACHE_TTL) return cached.list.slice();
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const loader = deps.loader || newLoader();
      const coins = (await loader.getTopCoins(3_000_000)).slice(0, C.EVAL_TOP_N);
      if (coins.length) {
        caches.top.set(tf, { list: coins, ts: now() });
        log.info(`🧬 [${tf}] loaded ${coins.length} coins (attempt ${attempt + 1}/${maxRetries})`);
        return coins.slice();
      }
    } catch (e) {
      log.warn(`_get_top_coins_cached: attempt ${attempt + 1}/${maxRetries} failed: ${e && e.message}`);
      if (attempt < maxRetries - 1) await sleep(2000);
    }
  }
  if (cached) {
    log.warn(`_get_top_coins_cached: using stale cache (${cached.list.length} coins)`);
    return cached.list.slice();
  }
  log.warn('_get_top_coins_cached: OKX unavailable + no cache → using hardcoded top-20');
  return FALLBACK_COINS.slice();
}

function newLoader() {
  const { HistoryLoader } = require('../marketData/candleStore');
  return new HistoryLoader();
}

/**
 * _get_context_aware_coins(tf, strategy, limit): top coins by 24 h volume (≥ 2 M) minus the
 * blacklist, first 50, scored on 14 days of candles (10 parallel, 15 s each), tier-mixed;
 * any error / empty basket → the fallback list. An empty candidate list returns [] (no fallback).
 */
async function getContextAwareCoins(tf, strategy, limit = C.EVAL_TOP_N, deps = {}) {
  const now = deps.now || (() => Date.now() / 1000);
  const log = deps.log || defaultLog();
  const key = `${tf}_${strategy}`;
  const cached = caches.context.get(key);
  if (cached && now() - cached.ts < C.CONTEXT_COINS_TTL) return cached.list.slice();
  try {
    const loader = deps.loader || newLoader();
    let candidates = await loader.getTopCoins(2_000_000);
    if (!candidates || !candidates.length) return [];
    const before = candidates.length;
    candidates = candidates.filter((c) => !isBlacklisted(c));
    if (before - candidates.length > 0) log.debug(`🧬 [${strategy}/${tf}] blacklist отфильтровал ${before - candidates.length} монет`);
    candidates = candidates.slice(0, 50);

    const scoredRaw = await mapBounded(candidates, 10, async (coin) => {
      try {
        const df = await withTimeout(Promise.resolve(loader.loadCached(coin, tf, 14)), deps.scoreTimeoutMs || 15_000);
        const s = scoreCoin(df, strategy);
        return s === null ? null : [coin, s];
      } catch (e) {
        log.debug(`genome scoring ${coin}: ${e && e.message}`);
        return null;
      }
    });
    const scored = scoredRaw.filter((x) => x !== null).map((x, i) => [x[0], x[1], i])
      .sort((a, b) => (b[1] - a[1]) || (a[2] - b[2])).map((x) => [x[0], x[1]]);

    const tier2 = await getTier2Dynamic(deps);
    const result = buildTierMixedBasket(scored, limit, tier2);
    if (result.length) {
      caches.context.set(key, { list: result, ts: now() });
      const pool = new Set(await getTier2Dynamic(deps));
      const t1 = result.filter((c) => TIER1_BENCHMARK.includes(c)).length;
      const t2 = result.filter((c) => pool.has(c) && !TIER1_BENCHMARK.includes(c)).length;
      log.info(`🧬 [${strategy}/${tf}] tier-mix basket: ${result.length} coins [T1=${t1} T2=${t2} T3=${result.length - t1 - t2}] (T1=BTC/ETH/SOL benchmark)`);
      return result.slice();
    }
  } catch (e) {
    log.warn(`_get_context_aware_coins: ${e && e.message}`);
  }
  return getTopCoinsCached(tf, deps);
}

module.exports = {
  COIN_BLACKLIST, TIER1_BENCHMARK, TIER2_MCAP_STATIC, CG_ID_TO_OKX, FALLBACK_COINS, COINGECKO_MARKETS,
  isBlacklisted, scoreCoin, getTier2Dynamic, buildTierMixedBasket, getContextAwareCoins, getTopCoinsCached,
  mapBounded, withTimeout, caches, _resetCaches,
};
