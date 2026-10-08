'use strict';
/**
 * wsPool.js — the sharded WS pool of the bot (`ws_feed.run_ws_feed` /
 * `_run_single_feed`, `ws_feed_bingx.required_shards` / `shard_symbols_balanced`,
 * universe selection of `bot._start_ws_feed`).
 *
 *   timeframes = ["15m", "1H", "4H", "1D"]; symbols = top-N of the LEVELS coins list
 *   (`cache.getCoins()`) else `rest.getAllUsdtPairs(WS_FEED_MIN_VOL_USDT = 500000)`.
 *   N = env `WS_FEED_MAX_SYMBOLS`, default 150 (PLAN §2.2: 150 coins × 4 TF = 600
 *   channels = 3 connections of ≤ 200 subscriptions; the bot's DATA_SOURCE=bingx
 *   default of 300 is not carried over — the 1-core budget is sized for 150).
 *   required_shards = ceil(num_symbols / max(1, 200 // num_tfs)); symbols are assigned
 *   round-robin (`symbols[i::n]`); every shard writes to the same cache.
 *
 * Per shard: start the feed, REST-fill cold channels in batches (5 symbols / 1.0 s
 * with the warmer enabled, 10 / 0.5 s otherwise; a channel is cold when the cache
 * holds < 50 bars), then subscribe all channels.
 */

const { log: defaultLog } = require('./mdLog');
const { defaultSleep } = require('./rateGate');
const candleCache = require('./candleCache');
const { TF_NORM } = require('./candleFrame');
const { BingxWsFeed, maxSubsPerConn } = require('./bingxWsFeed');
const { intOrUndefined } = require('../../strategies/common/pynum');

const DEFAULT_TIMEFRAMES = Object.freeze(['15m', '1H', '4H', '1D']);
const DEFAULT_MAX_SYMBOLS = 150;
const DEFAULT_MIN_VOL_USDT = 500_000;

function _envInt(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = intOrUndefined(String(raw));   // int(os.getenv(name, …)) — CPython int() of the text
  return n === undefined ? dflt : n;
}

/** Connections needed so that num_symbols × num_tfs channels fit `perConn` subscriptions each. */
function requiredShards(numSymbols, numTfs, perConn = null) {
  const per = perConn || maxSubsPerConn();
  if (numSymbols <= 0) return 1;
  const symsPerConn = Math.max(1, Math.floor(per / Math.max(1, numTfs)));
  return Math.max(1, Math.ceil(numSymbols / symsPerConn));
}

/** Round-robin split: shard sizes differ by at most 1 (`symbols[i::n]`). */
function shardSymbolsBalanced(symbols, numShards) {
  if (numShards <= 1) return [symbols.slice()];
  const out = [];
  for (let i = 0; i < numShards; i++) {
    const part = [];
    for (let j = i; j < symbols.length; j += numShards) part.push(symbols[j]);
    out.push(part);
  }
  return out;
}

function resolveMaxSymbols(env = process.env) {
  return _envInt(env, 'WS_FEED_MAX_SYMBOLS', DEFAULT_MAX_SYMBOLS);
}

/**
 * Coin universe of the WS pool: LEVELS coins list if cached, else the volume-floored
 * list from REST; truncated to the top N.
 */
async function selectUniverse({ rest, cache = candleCache, env = process.env, log = defaultLog } = {}) {
  let symbols = cache.getCoins();
  if (!symbols || !symbols.length) {
    const floor = _envInt(env, 'WS_FEED_MIN_VOL_USDT', DEFAULT_MIN_VOL_USDT);
    symbols = await rest.getAllUsdtPairs(floor);
  }
  if (!symbols || !symbols.length) {
    log.warning('ws_feed: нет монет для подписки, отложен запуск');
    return [];
  }
  const maxN = resolveMaxSymbols(env);
  return symbols.slice(0, maxN);
}

const _activeFeeds = [];
function getActiveFeeds() { return _activeFeeds.slice(); }
function _resetActiveFeeds() { _activeFeeds.length = 0; }

/**
 * `_run_single_feed`: one shard — feed start, throttled initial REST fill, subscribe.
 * Resolves with the feed once subscribed (the feed keeps running on its own timers).
 */
async function runSingleFeed({
  rest, cache = candleCache, symbols, timeframes = DEFAULT_TIMEFRAMES, shardId = 0,
  makeFeed = (o) => new BingxWsFeed(o), env = process.env, sleep = defaultSleep, log = defaultLog,
  feedOptions = {},
}) {
  const feed = makeFeed({
    fetcher: rest, cache, maxSubscriptions: symbols.length * timeframes.length + 50,
    env, sleep, log, shardId, ...feedOptions,
  });
  _activeFeeds.push(feed);
  if (shardId) log.info(`[PHASE-16.5] shard ${shardId}: ${symbols.length} symbols starting`);
  await feed.start();

  const warmer = (env.CACHE_WARMER_ENABLED ?? '1') === '1';
  const batchSize = warmer ? 5 : 10;
  const batchPauseMs = warmer ? 1000 : 500;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const tasks = [];
    for (const s of batch) {
      for (const tf of timeframes) {
        const tfNorm = TF_NORM[tf] ?? tf;
        const existing = cache.getCandles(s, tfNorm);
        if (!existing || existing.length < 50) tasks.push(feed.initialLoad(s, tfNorm));
      }
    }
    if (tasks.length) {
      await Promise.allSettled(tasks);
      await sleep(batchPauseMs);
    }
  }

  feed.subscribeSymbols(symbols, timeframes);
  log.info(`ws_feed: подписались на ${feed.activeSubscriptions} каналов (${symbols.length} символов × ${timeframes.length} TF)`);
  return feed;
}

/**
 * `run_ws_feed`: shard the symbols (env WS_FEED_NUM_SHARDS may only raise the count)
 * and run one feed per shard. Returns { feeds, stop() }.
 */
async function runWsPool({
  rest, cache = candleCache, symbols, timeframes = DEFAULT_TIMEFRAMES,
  env = process.env, log = defaultLog, sleep = defaultSleep, makeFeed, feedOptions,
}) {
  let numShards = Math.max(1, _envInt(env, 'WS_FEED_NUM_SHARDS', 1));
  const need = requiredShards(symbols.length, timeframes.length, maxSubsPerConn(env));
  if (need > numShards) {
    log.info(`[BINGX-WS] ${symbols.length * timeframes.length} каналов → ${need} соединений (WS_FEED_NUM_SHARDS=${numShards})`);
    numShards = need;
  }
  const shards = numShards <= 1 ? [symbols.slice()] : shardSymbolsBalanced(symbols, numShards);
  if (numShards > 1) {
    log.info(`[PHASE-16.5] WS multi-shard: ${numShards} shards × ~${Math.floor(symbols.length / numShards)} symbols (total ${symbols.length})`);
  }
  const feeds = await Promise.all(shards
    .map((shardSyms, idx) => ({ shardSyms, idx }))
    .filter(({ shardSyms }) => shardSyms.length)
    .map(({ shardSyms, idx }) => runSingleFeed({
      rest, cache, symbols: shardSyms, timeframes, shardId: idx, makeFeed, env, sleep, log, feedOptions,
    })));
  return {
    feeds,
    shards,
    async stop() {
      for (const f of feeds) {
        try { await f.stop(); } catch (_e) { /* best effort */ }
        const i = _activeFeeds.indexOf(f);
        if (i >= 0) _activeFeeds.splice(i, 1);
      }
    },
  };
}

module.exports = {
  DEFAULT_TIMEFRAMES, DEFAULT_MAX_SYMBOLS, DEFAULT_MIN_VOL_USDT,
  requiredShards, shardSymbolsBalanced, resolveMaxSymbols, selectUniverse,
  runSingleFeed, runWsPool, getActiveFeeds, _resetActiveFeeds,
};
