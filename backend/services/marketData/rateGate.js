'use strict';
/**
 * rateGate.js — the process-wide REST gate of the bot (`fetcher.OKXFetcher._gate`):
 * token bucket 15 req/s, burst 10 (acquire timeout 8 s, then the request proceeds
 * anyway) + a Semaphore(8) for in-flight concurrency. Every public REST call of
 * the market-data layer goes through `sharedGate.run(fn)`.
 *
 * `recordRateLimitHit` is the throttled `[OKX-429-BURST]` warning (one line per
 * 60 s with the suppressed count) and the monotonic `rateLimitHitsTotal` counter.
 *
 * `now` is wall-clock ms and `sleep` is setTimeout based, so vitest fake timers
 * drive the whole thing deterministically.
 */

const { log: defaultLog } = require('./mdLog');

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class TokenBucket {
  /** @param {number} rate tokens per second @param {number} burst bucket size */
  constructor(rate, burst, { now = () => Date.now(), sleep = defaultSleep } = {}) {
    this._rate = rate;
    this._burst = burst;
    this._tokens = burst;
    this._now = now;
    this._sleep = sleep;
    this._last = now();
  }

  /** @returns {Promise<boolean>} true = token taken, false = timed out (caller proceeds anyway). */
  async acquire(timeoutMs = 8000) {
    const deadline = this._now() + timeoutMs;
    for (;;) {
      const now = this._now();
      this._tokens = Math.min(this._burst, this._tokens + ((now - this._last) / 1000) * this._rate);
      this._last = now;
      if (this._tokens >= 1.0) {
        this._tokens -= 1.0;
        return true;
      }
      if (this._now() >= deadline) return false;
      await this._sleep(25);
    }
  }

  get tokens() { return this._tokens; }
}

class Semaphore {
  constructor(n) {
    this._free = n;
    this._waiters = [];
  }

  acquire() {
    if (this._free > 0) {
      this._free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  release() {
    const next = this._waiters.shift();
    if (next) next();
    else this._free += 1;
  }

  get available() { return this._free; }
  get waiting() { return this._waiters.length; }
}

class RateGate {
  constructor({ rate = 15.0, burst = 10, concurrency = 8, now, sleep } = {}) {
    this.bucket = new TokenBucket(rate, burst, { now, sleep });
    this.sem = new Semaphore(concurrency);
  }

  /** Token bucket (throughput) + semaphore (concurrency) around `fn`. */
  async run(fn) {
    await this.bucket.acquire();
    await this.sem.acquire();
    try {
      return await fn();
    } finally {
      this.sem.release();
    }
  }
}

/** The bot's class-level shared bucket + semaphore: one per process. */
const sharedGate = new RateGate();

// ── [OKX-429-BURST] throttled warning ───────────────────────────────────────
const RATE_LIMIT_WARN_INTERVAL_S = 60;
const _rl = { suppressed: 0, lastWarnTs: 0, total: 0 };

function recordRateLimitHit(symbol, timeframe, wait, { now = () => Date.now() / 1000, log = defaultLog } = {}) {
  _rl.total += 1;
  _rl.suppressed += 1;
  const t = now();
  if (t - _rl.lastWarnTs >= RATE_LIMIT_WARN_INTERVAL_S) {
    log.warning(
      `[OKX-429-BURST] ${_rl.suppressed} hit(s) in last ${RATE_LIMIT_WARN_INTERVAL_S}s; latest sym=${symbol} tf=${timeframe} `
      + `retry-after=${wait}s (total-since-start=${_rl.total})`,
    );
    _rl.suppressed = 0;
    _rl.lastWarnTs = t;
  }
}

function getRateLimitStats() {
  return { rateLimitHitsTotal: _rl.total, suppressed: _rl.suppressed, lastWarnTs: _rl.lastWarnTs };
}

function _resetRateLimitStats() {
  _rl.suppressed = 0; _rl.lastWarnTs = 0; _rl.total = 0;
}

module.exports = {
  TokenBucket, Semaphore, RateGate, sharedGate, defaultSleep,
  recordRateLimitHit, getRateLimitStats, _resetRateLimitStats, RATE_LIMIT_WARN_INTERVAL_S,
};
