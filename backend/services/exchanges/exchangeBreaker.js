'use strict';
/**
 * exchangeBreaker.js — one-to-one port of `exchange_breaker.py` ([F-013]).
 *
 * Global per-exchange circuit breaker: after `failThreshold` (10) consecutive transient
 * failures the breaker opens for `openDurationS` (300 s); after that it is half-open and
 * lets one probe through every `halfOpenProbeS` (60 s); a success closes it.
 * Logs `[CB-OPEN]` / `[CB-CLOSE]`.
 *
 * NOTE (spec §7.4 / quirk 13): in the bot nothing calls the breaker except
 * `api_retry.call_with_retry(..., exchange=...)`, and no trader passes `exchange=` —
 * so it is effectively unused. Ported as-is for parity / metrics.
 */

const { log: defaultLog } = require('../marketData/mdLog');
const { pyLower } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const DEFAULT_FAIL_THRESHOLD = 10;
const DEFAULT_OPEN_DURATION_S = 300;
const DEFAULT_HALF_OPEN_PROBE_S = 60;

const TRANSIENT_HINTS = Object.freeze([
  'timeout', 'timed out', 'connection reset', 'connection aborted',
  '5xx', '503', '502', '504', '500',
  'service unavailable', 'bad gateway', 'gateway timeout',
  'internal server error', 'max retries exceeded',
]);

class ExchangeBreaker {
  constructor({
    failThreshold = DEFAULT_FAIL_THRESHOLD,
    openDurationS = DEFAULT_OPEN_DURATION_S,
    halfOpenProbeS = DEFAULT_HALF_OPEN_PROBE_S,
    now = () => Date.now() / 1000,
    log = defaultLog,
  } = {}) {
    this.failThreshold = failThreshold;
    this.openDurationS = openDurationS;
    this.halfOpenProbeS = halfOpenProbeS;
    this.now = now;
    this.log = log;
    this._states = new Map();
  }

  _st(exchange) {
    let st = this._states.get(exchange);
    if (!st) {
      st = { fail_count: 0, opened_at: 0.0, last_probe_at: 0.0 };
      this._states.set(exchange, st);
    }
    return st;
  }

  isOpen(exchange) {
    const st = this._st(exchange);
    if (!st.opened_at) return false;
    const elapsed = this.now() - st.opened_at;
    if (elapsed >= this.openDurationS) return false;
    return true;
  }

  isProbeAllowed(exchange) {
    const st = this._st(exchange);
    if (!st.opened_at) return true;
    const elapsed = this.now() - st.opened_at;
    if (elapsed < this.openDurationS) return false;
    if ((this.now() - st.last_probe_at) < this.halfOpenProbeS) return false;
    st.last_probe_at = this.now();
    return true;
  }

  recordSuccess(exchange) {
    const st = this._st(exchange);
    if (st.opened_at) {
      this.log.info(`[CB-CLOSE] ${exchange} breaker closed after success (was open ${(this.now() - st.opened_at).toFixed(0)}s)`);
    }
    st.fail_count = 0;
    st.opened_at = 0.0;
    st.last_probe_at = 0.0;
  }

  recordFailure(exchange) {
    const st = this._st(exchange);
    st.fail_count += 1;
    if (st.fail_count >= this.failThreshold && !st.opened_at) {
      st.opened_at = this.now();
      this.log.warning(`[CB-OPEN] ${exchange} breaker opened after ${st.fail_count} failures — skipping requests for ${this.openDurationS}s`);
    }
  }

  stateDict() {
    const out = {};
    const now = this.now();
    for (const [exchange, st] of this._states.entries()) {
      out[exchange] = {
        fail_count: st.fail_count,
        is_open: this.isOpen(exchange),
        opened_for_s: st.opened_at ? (now - st.opened_at) : 0,
      };
    }
    return out;
  }

  _reset() { this._states.clear(); }
}

/** Module-level singleton — shared across all callers. */
const breaker = new ExchangeBreaker();

/**
 * True for server-side / network errors. Accepts an Error (TimeoutError-like errors are
 * transient by type) or a string; otherwise matches the lower-cased message.
 */
function isTransientError(err) {
  if (err instanceof Error) {
    if (err.pyType === 'TimeoutError' || err.name === 'TimeoutError' || err.code === 'ETIMEDOUT') return true;
    return TRANSIENT_HINTS.some((h) => pyLower(String(err.message)).includes(h));
  }
  const msg = pyLower(String(err));
  return TRANSIENT_HINTS.some((h) => msg.includes(h));
}

module.exports = {
  ExchangeBreaker, breaker, isTransientError, TRANSIENT_HINTS,
  DEFAULT_FAIL_THRESHOLD, DEFAULT_OPEN_DURATION_S, DEFAULT_HALF_OPEN_PROBE_S,
};
