'use strict';
/**
 * cacheWarmer.js — throttled background REST fill of cold WS subscriptions
 * (`cache_warmer.CacheWarmer`), one per WS shard.
 *
 * Env: CACHE_WARMER_ENABLED=1, CACHE_WARMER_RATE=5.0 req/s (min 0.5),
 * CACHE_WARMER_INTERVAL=30 s (min 5). After a 10 s initial delay, each cycle walks
 * the feed's subscriptions; a channel is cold when it is not reserved in
 * `feed._loadedChannels`, or reserved ≥ 60 s ago (`channelStale`) with an empty cache.
 * Each cold channel is reserved first (so the feed's `_initialLoad` cannot race),
 * REST-loaded (`getCandles(limit=300)`), stored with `TTL_MAP`; failure / no data
 * releases the reservation. `sleep(1/rate)` between fetches.
 *
 * Markers: [WARMER-START], [WARMER-CYCLE] cold=… / total=…, [WARMER-DONE] warmed=… errors=…,
 * [WARMER-FAIL] (debug), [WARMER-DISABLED].
 */

const { log: defaultLog } = require('./mdLog');
const { defaultSleep } = require('./rateGate');
const candleCache = require('./candleCache');
const { TTL_MAP } = require('./candleFrame');
const { floatFromStr } = require('../../strategies/common/pynum');
const { pyMax } = require('../../strategies/common/pyround');   // builtin max()/min(): a NaN 2nd argument is ignored

class CacheWarmer {
  constructor(wsFeed, fetcher, {
    ratePerSec = 5.0, cycleIntervalS = 30.0, cache = candleCache,
    sleep = defaultSleep, now = () => Date.now() / 1000, log = defaultLog, env = process.env,
    initialDelayS = 10.0,
  } = {}) {
    this._wsFeed = wsFeed;
    this._fetcher = fetcher;
    this._rate = pyMax(0.5, ratePerSec);
    this._cycleInterval = pyMax(5.0, cycleIntervalS);
    this._cache = cache;
    this._sleep = sleep;
    this._now = now;
    this._log = log;
    this._env = env;
    this._initialDelayS = initialDelayS;
    this._task = null;
    this._running = false;
    this._totalWarmed = 0;
    this._totalErrors = 0;
    this._cycles = 0;
    this._lastCycleTs = 0.0;
  }

  static fromEnv(wsFeed, fetcher, opts = {}) {
    const env = opts.env || process.env;
    // float(os.getenv("CACHE_WARMER_RATE", "5.0")) — CPython float() of the text (PEP 515, Unicode digits, inf/nan)
    const rate = floatFromStr(String(env.CACHE_WARMER_RATE ?? '5.0'));
    const interval = floatFromStr(String(env.CACHE_WARMER_INTERVAL ?? '30.0'));
    return new CacheWarmer(wsFeed, fetcher, {
      ...opts, env,
      ratePerSec: rate === undefined ? 5.0 : rate,
      cycleIntervalS: interval === undefined ? 30.0 : interval,
    });
  }

  get stats() {
    return {
      total_warmed: this._totalWarmed,
      total_errors: this._totalErrors,
      cycles: this._cycles,
      last_cycle_ts: this._lastCycleTs,
      rate_per_sec: this._rate,
    };
  }

  get running() { return this._running; }

  async start() {
    if (this._running) return;
    if ((this._env.CACHE_WARMER_ENABLED ?? '1') !== '1') {
      this._log.info('[WARMER-DISABLED] CACHE_WARMER_ENABLED=0');
      return;
    }
    this._running = true;
    this._task = this._loop().catch((e) => this._log.warning(`[WARMER-LOOP] ${e && e.message}`));
    this._log.info(`[WARMER-START] rate=${this._rate.toFixed(1)}/sec interval=${Math.round(this._cycleInterval)}s`);
  }

  async stop() {
    this._running = false;
    if (this._task) {
      try { await this._task; } catch (_e) { /* cancelled */ }
      this._task = null;
    }
  }

  async _loop() {
    // Initial delay: let the feed finish subscribing and receive the first messages.
    await this._sleep(this._initialDelayS * 1000);
    while (this._running) {
      try {
        await this.warmOneCycle();
        this._cycles += 1;
        this._lastCycleTs = this._now();
      } catch (e) {
        this._log.warning(`[WARMER-CYCLE-ERROR] ${e && e.message}`);
      }
      // Sleep in short slices so stop() reacts quickly even with a long interval.
      let slept = 0.0;
      while (this._running && slept < this._cycleInterval) {
        await this._sleep(Math.min(1.0, this._cycleInterval - slept) * 1000);
        slept += 1.0;
      }
    }
  }

  async warmOneCycle() {
    if (!this._wsFeed || !this._fetcher) return;
    const subs = this._wsFeed.subscriptions || [];
    if (!subs.length) {
      this._log.debug('[WARMER] no subscriptions yet');
      return;
    }
    const loaded = this._wsFeed._loadedChannels || new Set();
    const cold = [];
    for (const [s, tf] of subs) {
      if (this.isCold(s, tf, loaded)) cold.push([s, tf]);
    }
    if (!cold.length) {
      this._log.debug(`[WARMER] all ${subs.length} channels warm`);
      return;
    }
    this._log.info(`[WARMER-CYCLE] cold=${cold.length} / total=${subs.length} — fill at ${this._rate.toFixed(1)}/sec`);
    const delayPerFetchMs = (1.0 / this._rate) * 1000;
    let warmed = 0;
    let errors = 0;
    for (const [s, tf] of cold) {
      try {
        if (await this.warmChannel(s, tf)) {
          warmed += 1;
          this._totalWarmed += 1;
        }
      } catch (e) {
        errors += 1;
        this._totalErrors += 1;
        this._log.debug(`[WARMER-FAIL] ${s}/${tf}: ${e && e.message}`);
      }
      await this._sleep(delayPerFetchMs);
    }
    this._log.info(`[WARMER-DONE] warmed=${warmed} errors=${errors} total_warmed=${this._totalWarmed} cold_remaining=${cold.length - warmed - errors}`);
  }

  /** Cold = not reserved, OR reserved long ago and the cache is empty (TTL expiry / eviction). */
  isCold(s, tf, loaded) {
    const key = `${s}_${tf}`;
    if (!loaded.has(key)) return true;
    const stale = this._wsFeed.channelStale;
    if (typeof stale !== 'function' || !this._wsFeed.channelStale(key)) return false;
    let frame;
    try { frame = this._cache.getCandles(s, tf); } catch (_e) { return false; }
    return !frame || frame.length === 0;
  }

  /** Warm one channel. true = fetched + cached. Reservation before the fetch; released on failure. */
  async warmChannel(s, tf) {
    const channelKey = `${s}_${tf}`;
    const loadedSet = this._wsFeed._loadedChannels;
    const stale = typeof this._wsFeed.channelStale === 'function' ? this._wsFeed.channelStale(channelKey) : false;
    if (loadedSet.has(channelKey) && !stale) return false;
    if (typeof this._wsFeed.reserveChannel === 'function') this._wsFeed.reserveChannel(channelKey);
    else loadedSet.add(channelKey);
    let frame;
    try {
      frame = await this._fetcher.getCandles(s, tf, 300);
    } catch (e) {
      loadedSet.delete(channelKey);
      throw e;
    }
    if (!frame || frame.length === 0) {
      loadedSet.delete(channelKey); // no data → release, let the WS re-trigger
      return false;
    }
    const ttl = TTL_MAP[tf] ?? 3600;
    this._cache.setCandles(s, tf, frame, { [tf]: ttl });
    return true;
  }
}

module.exports = { CacheWarmer };
