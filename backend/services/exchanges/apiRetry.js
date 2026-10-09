'use strict';
/**
 * apiRetry.js — one-to-one port of `api_retry.py` ([MONEY-PATH-P1 §3.1]).
 *
 * call_with_retry(fn, …): retries transient failures with exponential backoff
 * `min(base × 2^(attempt−1), max_backoff) × uniform(0.7, 1.3)` (±30 % jitter, [F-012]).
 *   • result dict with ok=False, retCode≠0 or Binance code<0 → retryable iff the error text
 *     matches a transient marker and no non-retryable marker (auth / balance / delisted);
 *   • raised exception → same classification on str(e): non-retryable re-raises at once,
 *     retryable sleeps and retries, the last attempt re-raises;
 *   • all attempts retryable-failed → the last result is returned.
 * Optional `exchange` wires the exchange breaker ([F-013], pre-empt when open, record
 * success on ok=True, record failure on exhausted transient errors).
 * Logs `[API-RETRY]`, `[CB-PREEMPT]`.
 */

const { log: defaultLog } = require('../marketData/mdLog');
const { pyGet, pyStr, pyTruthy, errStr, pySlice, isDict, pyRepr, rethrowCancelled } = require('./pyCompat');
const { breaker: defaultBreaker, isTransientError } = require('./exchangeBreaker');
const { pyLower, pyStrip } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

/** Default sleep — seconds, like asyncio.sleep (every injected `sleep` in services/exchanges takes seconds). */
const sleepS = (s) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000));

const RETRYABLE_ERROR_SUBSTRINGS = Object.freeze([
  '429', 'rate limit', 'ratelimit', 'too many requests', 'timeout', 'timed out',
  'timestamp', 'recv_window', '10002', '10006', '10016', 'mark price', 'position not found',
  'internal error', 'try again', 'temporarily unavailable', 'service unavailable',
  'bad gateway', 'gateway timeout', '502', '503', '504', 'connection', 'network', 'socket',
]);

const NON_RETRYABLE_ERROR_SUBSTRINGS = Object.freeze([
  '10003', '10004', '10005', '401', '403', 'invalid api key', 'invalid signature',
  'insufficient balance', 'insufficient margin', '110007', '110012', '110074', '110125',
  'contract is not', 'not listed', 'symbol invalid',
]);

function isRetryableError(error) {
  if (!pyTruthy(error)) return false;
  const errLower = pyLower(pyStr(error));
  for (const m of NON_RETRYABLE_ERROR_SUBSTRINGS) if (errLower.includes(m)) return false;
  for (const m of RETRYABLE_ERROR_SUBSTRINGS) if (errLower.includes(m)) return true;
  return false;
}

/** → [retryNeeded, errorString] (api_retry._result_is_retryable). */
function resultIsRetryable(result) {
  if (isDict(result)) {
    if (pyGet(result, 'ok') === false) {
      const err = pyStr(pyGet(result, 'error', '') || '');
      return [isRetryableError(err), err];
    }
    const rc = pyGet(result, 'retCode');
    if (!(rc === null || rc === 0 || rc === false)) {
      const msg = pyStr(pyGet(result, 'retMsg', '') || pyGet(result, 'error', '') || '');
      const err = pyStrip(`${pyStr(rc)} ${msg}`);
      return [isRetryableError(err), err];
    }
    const bc = pyGet(result, 'code');
    if (bc !== null && (typeof bc === 'number' || typeof bc === 'boolean') && Number.isInteger(Number(bc)) && Number(bc) < 0) {
      const msg = pyStr(pyGet(result, 'msg', '') || pyGet(result, 'error', '') || '');
      const err = pyStrip(`${pyStr(bc)} ${msg}`);
      return [isRetryableError(err), err];
    }
    return [false, ''];
  }
  return [false, ''];
}

/**
 * @param {Function} fn         async or sync callable
 * @param {object}   opts       { args=[], maxAttempts=3, baseBackoff=0.3, maxBackoff=5.0, opName='',
 *                                exchange='', sleep(seconds), random, log, breaker }
 */
async function callWithRetry(fn, opts = {}) {
  const {
    args = [], maxAttempts = 3, baseBackoff = 0.3, maxBackoff = 5.0, opName = '', exchange = '',
    sleep = sleepS, random = Math.random, log = defaultLog, breaker = defaultBreaker,
  } = opts;
  const name = opName || fn.name || 'fn';
  if (exchange) {
    try {
      if (breaker.isOpen(exchange) && !breaker.isProbeAllowed(exchange)) {
        log.warning(`[CB-PREEMPT] ${name}: ${exchange} breaker open — fail-fast`);
        return { ok: false, error: `${exchange} circuit-breaker open` };
      }
    } catch (e) { rethrowCancelled(e); log.debug(`api_retry exchange_breaker check: ${errStr(e)}`); }
  }
  let lastResult = null;
  const jitter = () => 0.7 + (1.3 - 0.7) * random(); // random.uniform(0.7, 1.3)
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result;
    try {
      result = await fn(...args);
    } catch (e) {
      rethrowCancelled(e);
      const errS = errStr(e);
      if (!isRetryableError(errS)) {
        log.warning(`[API-RETRY] ${name}: attempt ${attempt}/${maxAttempts} non-retryable exc=${pyRepr(pySlice(errS, 150))}`);
        throw e;
      }
      if (attempt < maxAttempts) {
        let backoff = Math.min(baseBackoff * (2 ** (attempt - 1)), maxBackoff);
        backoff *= jitter();
        log.warning(`[API-RETRY] ${name}: attempt ${attempt}/${maxAttempts} exc=${pyRepr(pySlice(errS, 150))} — backoff ${backoff.toFixed(2)}s`);
        await sleep(backoff);
        continue;
      }
      log.error(`[API-RETRY] ${name}: ALL ${maxAttempts} attempts raised exceptions. Last exc=${pyRepr(pySlice(errS, 200))}`);
      if (exchange) {
        try { if (isTransientError(e)) breaker.recordFailure(exchange); } catch (_e) { rethrowCancelled(_e); /* best effort */ }
      }
      throw e;
    }
    const [retryable, errMsg] = resultIsRetryable(result);
    if (!retryable) {
      if (attempt > 1) log.info(`[API-RETRY] ${name}: success on attempt ${attempt}/${maxAttempts}`);
      if (exchange) {
        try { if (isDict(result) && pyGet(result, 'ok') === true) breaker.recordSuccess(exchange); } catch (_e) { rethrowCancelled(_e); /* best effort */ }
      }
      return result;
    }
    lastResult = result;
    if (attempt < maxAttempts) {
      let backoff = Math.min(baseBackoff * (2 ** (attempt - 1)), maxBackoff);
      backoff *= jitter();
      log.warning(`[API-RETRY] ${name}: attempt ${attempt}/${maxAttempts} failed (retryable) err=${pyRepr(pySlice(errMsg, 150))} — backoff ${backoff.toFixed(2)}s`);
      await sleep(backoff);
    } else {
      log.error(`[API-RETRY] ${name}: ALL ${maxAttempts} attempts failed (retryable). Last err=${pyRepr(pySlice(errMsg, 200))}`);
      if (exchange) {
        try { if (isTransientError(errMsg)) breaker.recordFailure(exchange); } catch (_e) { rethrowCancelled(_e); /* best effort */ }
      }
    }
  }
  return lastResult;
}

/** Decorator form (`@retry_api`). */
function retryApi({ maxAttempts = 3, baseBackoff = 0.3, maxBackoff = 5.0, opName = '', ...rest } = {}) {
  return (fn) => async (...args) => callWithRetry(fn, {
    ...rest, args, maxAttempts, baseBackoff, maxBackoff, opName: opName || fn.name,
  });
}

module.exports = {
  sleepS, RETRYABLE_ERROR_SUBSTRINGS, NON_RETRYABLE_ERROR_SUBSTRINGS,
  isRetryableError, resultIsRetryable, callWithRetry, retryApi,
};
