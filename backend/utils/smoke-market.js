#!/usr/bin/env node
'use strict';
/**
 * smoke-market.js — live check of the market-data layer against BingX (PLAN M8 verify):
 *
 *   1. the top-150 universe (`getAllUsdtPairs(WS_FEED_MIN_VOL_USDT=500000)`, env WS_FEED_MAX_SYMBOLS),
 *   2. the WS pool: 150 × 4 TF = 600 channels → 3 shards of ≤ 200 subscriptions, initial REST fill, warmers,
 *   3. waits for the first 15m bar close (≤ 15 min, env SMOKE_TIMEOUT_MIN),
 *   4. prints the cache keys (per-TF counts, samples) and the cache statistics.
 *
 *   node backend/utils/smoke-market.js            # from the repo root
 *   MARKET_LOG_LEVEL=debug node utils/smoke-market.js
 *
 * Exit codes: 0 = a 15m close was observed, 1 = timed out, 2 = BingX unreachable / no universe.
 * No database is touched (the persistent candle store is not exercised here).
 */

const { BingxRest, BINGX_CONTRACTS } = require('../services/marketData/bingxRest');
const { fetchJson } = require('../services/marketData/httpClient');
const candleCache = require('../services/marketData/candleCache');
const { registerOnBarClose } = require('../services/marketData/bingxWsFeed');
const { selectUniverse, runWsPool, DEFAULT_TIMEFRAMES } = require('../services/marketData/wsPool');
const { CacheWarmer } = require('../services/marketData/cacheWarmer');
const { log, setLevel } = require('../services/marketData/mdLog');

const TIMEOUT_MIN = Number(process.env.SMOKE_TIMEOUT_MIN || 15);
const STATUS_EVERY_MS = 10_000;
const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19);
const fmtVol = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1e3)}K`);

async function main() {
  setLevel(process.env.MARKET_LOG_LEVEL || 'info');
  const started = Date.now();
  console.log(`[smoke-market] start ${new Date(started).toISOString()} timeout=${TIMEOUT_MIN} min`);

  // 0. reachability
  try {
    const probe = await fetchJson(BINGX_CONTRACTS, { timeoutMs: 10_000 });
    const n = ((probe.json || {}).data || []).length;
    console.log(`[smoke-market] GET /quote/contracts → HTTP ${probe.status}, ${n} contracts`);
    if (probe.status !== 200 || !n) throw new Error(`unexpected contracts response (HTTP ${probe.status})`);
  } catch (e) {
    console.error(`[smoke-market] BingX unreachable: ${e && e.message}`);
    process.exit(2);
  }

  // 1. universe
  const rest = new BingxRest();
  candleCache.initCache(4000);
  const symbols = await selectUniverse({ rest });
  if (!symbols.length) {
    console.error('[smoke-market] empty universe — getAllUsdtPairs returned nothing');
    process.exit(2);
  }
  console.log(`[smoke-market] universe: ${symbols.length} symbols (24h USDT volume ≥ ${process.env.WS_FEED_MIN_VOL_USDT || 500000}, top ${process.env.WS_FEED_MAX_SYMBOLS || 150})`);
  const show = (s) => `${s} ${fmtVol(rest.volBySym[s] || 0)}`;
  console.log(`  top:  ${symbols.slice(0, 10).map(show).join(' | ')}`);
  console.log(`  tail: ${symbols.slice(-5).map(show).join(' | ')}`);

  // 2. bar-close listener + pool
  const closes = [];
  let first15m = null;
  registerOnBarClose((inst, tf) => {
    closes.push({ inst, tf, at: Date.now() });
    if (tf === '15m' && !first15m) first15m = { inst, at: Date.now() };
  });
  const pool = await runWsPool({ rest, symbols, timeframes: DEFAULT_TIMEFRAMES });
  console.log(`[smoke-market] WS pool: ${pool.feeds.length} shard(s) for ${symbols.length} × ${DEFAULT_TIMEFRAMES.length} channels`);
  for (const f of pool.feeds) {
    const m = f.metrics();
    console.log(`  shard ${f.shardId}: connected=${m.connected} subs=${m.subscriptions} loaded=${m.loaded_channels}`);
  }
  const warmers = pool.feeds.map((f) => CacheWarmer.fromEnv(f, rest));
  for (const w of warmers) await w.start();

  // 3. wait for the first 15m close
  const deadline = started + TIMEOUT_MIN * 60_000;
  let lastStatus = 0;
  while (!first15m && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (Date.now() - lastStatus >= STATUS_EVERY_MS) {
      lastStatus = Date.now();
      const stats = candleCache.cacheStats();
      const tot = pool.feeds.reduce((acc, f) => {
        const m = f.metrics();
        acc.pushes += m.pushes_received; acc.candles += m.candles_received_total; acc.pings += m.pings_received;
        acc.connected += m.connected ? 1 : 0; acc.loaded += m.loaded_channels; acc.subErr += m.sub_errors;
        return acc;
      }, { pushes: 0, candles: 0, pings: 0, connected: 0, loaded: 0, subErr: 0 });
      console.log(`[smoke-market] ${hhmmss(Date.now())} +${Math.round((Date.now() - started) / 1000)}s `
        + `shards=${tot.connected}/${pool.feeds.length} pushes=${tot.pushes} pings=${tot.pings} closes=${closes.length} `
        + `candlesTotal=${tot.candles} loaded=${tot.loaded} subErrors=${tot.subErr} cache size=${stats.size} hits=${stats.hits} misses=${stats.misses} `
        + `warmed=${warmers.reduce((a, w) => a + w.stats.total_warmed, 0)}`);
    }
  }

  // 4. report
  const keys = candleCache.cacheKeys();
  const byTf = {};
  for (const k of keys) { const tf = k.slice(k.lastIndexOf('_') + 1); byTf[tf] = (byTf[tf] || 0) + 1; }
  console.log(`[smoke-market] cache keys: ${keys.length} total — ${Object.entries(byTf).map(([tf, n]) => `${tf}:${n}`).join(' ')}`);
  console.log(`  sample: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`);
  console.log(`  stats: ${JSON.stringify(candleCache.cacheStats())}`);
  const byTfCloses = {};
  for (const c of closes) byTfCloses[c.tf] = (byTfCloses[c.tf] || 0) + 1;
  console.log(`[smoke-market] bar closes observed: ${closes.length} — ${Object.entries(byTfCloses).map(([tf, n]) => `${tf}:${n}`).join(' ') || 'none'}`);
  if (first15m) {
    const f = candleCache.getCandles(first15m.inst, '15m');
    console.log(`[smoke-market] first 15m bar close: ${first15m.inst} at ${hhmmss(first15m.at)} (+${Math.round((first15m.at - started) / 1000)}s); `
      + `cache ${first15m.inst}_15m has ${f ? f.length : 0} bars, last open ${f ? new Date(f.lastOpenMs()).toISOString() : '-'}`);
  } else {
    console.log(`[smoke-market] no 15m bar close within ${TIMEOUT_MIN} min`);
  }

  for (const w of warmers) await w.stop();
  await pool.stop();
  process.exit(first15m ? 0 : 1);
}

main().catch((e) => {
  log.error(`[smoke-market] failed: ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
