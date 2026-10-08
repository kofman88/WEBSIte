'use strict';
/**
 * bybitTrader.js — one-to-one port of `bybit_trader.py` (Bybit V5, linear USDT perps).
 *
 * The bot talks to Bybit through pybit 5.14 (`bybitHttp.js` reproduces it on the wire)
 * plus a few raw aiohttp calls (server time, tickers, test_connection). Every Python
 * "sync" function runs here as an async function on the injectable runtime (runtime.js):
 * transport, clock, sleep, kv, killswitch, plan gate, metrics.
 *
 * Behaviour reproduced (spec autotrade.md §14.1, §3.6):
 *   • per-API-key token bucket 10 req/s burst 15 (sync buckets for "thread" code, async
 *     bucket for bybit_call), cap 600 keys;
 *   • server-time offset (`_get_timestamp`, 10 s resync, [BYBIT-TIME-DRIFT] > 2000 ms,
 *     reset to 0 after 600 s of failed syncs, 500 ms safety margin) — NOTE: pybit ignores
 *     the offset it is given (`session.time_offset`), only `test_connection` uses the
 *     server time directly — quirk reproduced;
 *   • instrument filter cache 4 h (qtyStep / tickSize, fallback 0.001 / 0.0001 not cached);
 *   • UNIFIED / CONTRACT account detection cached per key (+ per-key lock, backoffs
 *     0.5/1/2/4 s on network errors and 10006/429);
 *   • _try_set_leverage: 0/110043 ok, 10005 → fatal RU text, "maxLeverage [N]" → retry ×N//100;
 *   • place_trade: cross margin, leverage, sizing (risk / notional / margin), low-notional
 *     skip or opt-in boost, [RISK-AUDIT], tight-SL / margin / available-margin checks,
 *     atomic entry+TP1+SL (tpslMode=Partial) with [ATOMIC-FALLBACK], duplicate orderLinkId
 *     (110072) → verify position, 30228/110074 delisted 24 h, 10001/170214 failure counter,
 *     130125 positionIdx flip (hedge cache 5 min + engine_kv), CONTRACT SL retry ×3 then
 *     [SL-SAFETY-CLOSE-*] emergency reduce-only close, second 10001 → CONTRACT + sl_pending;
 *     with the real pybit session every retCode≠0 RAISES (InvalidRequestError), so — exactly
 *     as in the bot — those retCode branches only fire for sessions returning dicts;
 *   • TP ladder 50/25/25 via reduce-only limits after polling the position (30 × 1 s),
 *     110017 flash-close recheck, 110072 duplicate ok, [TP-PHANTOM] verification;
 *   • set_trailing_sl: mark-price pre-check, 34040 / "not modified" benign, 110010 retry ×3;
 *   • close_position: qty floored to step, 10001 "qty invalid" → benign;
 *   • cancel_all_orders via api_retry; delisted-symbol cache 24 h (cap 200); demo host.
 */

const { createPybitSession, InvalidRequestError, FailedRequestError } = require('./bybitHttp');
const { makeRuntime, makeLock } = require('./runtime');
const { TransportError, aiohttpJson } = require('./transport');
const {
  PyError, errStr, pyGet, pyIndex, pyFloat, pyInt, pyStr, pyRepr, pyFloatStr, pyTruthy, pyOr,
  htmlEscape, pySlice, isDict, pyBigInt, pyLen,
  pyIter,
} = require('./pyCompat');
const { fmtFixed, fmtSigned } = require('../../strategies/common/pyfmt');
const { pyRound, pyMax } = require('../../strategies/common/pyround');
const { pySum } = require('../../strategies/common/series');
const PP = require('./pricePrecision');
const { computeClientOrderId } = require('./orderIdUtils');
const { callWithRetry } = require('./apiRetry');
const sym = require('../marketData/symbolMap');
const { safeKeyId, apiKeyHash, pyDiv, killswitchGate, planGateDeny, recordPlaced, aioQuery, firstKey, sha256hex } = require('./traderCommon');

const MIN_NOTIONAL = 5.0;
const MAX_LEVERAGE = 50;
const TAKER_FEE = 0.00060;
const MAKER_FEE = 0.00010;
const DELISTING_TTL_S = 24 * 3600;
const INSTRUMENT_FILTER_TTL_S = 4 * 3600;
const HEDGE_CACHE_TTL_SEC = 300;
const AUTO_BLACKLIST_THRESHOLD = 3;
const PYBIT_SESSION_TTL = 12 * 3600;
const PYBIT_SESSION_MAX = 600;
const TIME_STALE_WARN_S = 60.0;
const TIME_STALE_RESET_S = 600.0;
const TIME_EXTREME_DRIFT_MS = 2000;
const LEV_GT_MAX_RE = /maxLeverage\s*\[(\d+)\]/i;

const BYBIT_ERROR_MAP = Object.freeze({
  401: 'Ошибка авторизации API (401). Проверьте: ключ/секрет, mainnet/testnet, IP whitelist и права ключа.',
  494: 'Ошибка временной метки (CDN 494). Синхронизация времени выполняется автоматически.',
  429: 'Превышен лимит запросов к API. Подождите 30 секунд и попробуйте снова.',
  403: 'Доступ заблокирован Bybit (403). Проверьте IP-ограничения API ключа.',
  10001: 'Неверный тип аккаунта или параметры. Если ошибка повторяется — переподключите API ключи.',
  10002: 'Timestamp вне допустимого диапазона. Проверьте системное время сервера.',
  10003: 'Неверный API ключ. Проверьте ключ в настройках.',
  10004: 'Неверная подпись API. Проверьте API Secret.',
  10005: 'Недостаточно прав API. Включите разрешение «Contract Trading».',
  10006: 'Превышен лимит запросов к API. Попробуйте ещё раз через несколько секунд.',
  10016: 'Сервис Bybit временно недоступен. Повторите попытку позже.',
  110001: 'Ордер не найден.',
  110003: 'Цена ордера выходит за допустимый диапазон. Попробуйте повторно — цена могла измениться.',
  110007: 'Недостаточно свободного баланса для открытия позиции. Пополните счёт или уменьшите объём.',
  110012: 'Недостаточно доступного баланса. Освободите маржу или пополните счёт.',
  110013: 'Не удалось установить маржу — позиция не найдена.',
  110014: 'Превышен лимит позиций по данному инструменту.',
  110015: 'Позиция уже закрыта или не существует.',
  110016: 'Инструмент недоступен для торговли в данный момент.',
  110074: 'Эта монета не торгуется на Bybit. Контракт делистнут или ещё не запущен.',
  110017: 'Ордер нарушает правило reduce-only (позиция уже меньше объёма ордера).',
  110025: 'Режим позиции уже установлен и не требует изменений.',
  110040: 'Превышен максимальный объём ордера для данного инструмента.',
  110043: 'Кредитное плечо уже установлено на данное значение.',
  110055: 'Торговля по данному инструменту приостановлена.',
  110066: 'Превышен лимит открытых ордеров.',
  130021: 'Объём ордера превышает размер открытой позиции.',
  130125: 'Несоответствие режима позиции (One-Way / Hedge). Выполняется автоматическая коррекция.',
});

const NETWORK_ERR_MARKERS = Object.freeze([
  'name or service not known', 'name resolution', 'failed to resolve',
  'getaddrinfo', 'temporary failure', 'nameresolutionerror',
  'cannot connect', 'connection reset', 'timeout',
  'max retries exceeded', '[errno -2]', '[errno -3]', '[errno 11001]',
  'network is unreachable', 'no route to host', 'server disconnected',
]);

const WALLET_NETWORK_KWS = Object.freeze([
  'retryable', 'timeout', 'connection', 'reset',
  'name resolution', 'failed to resolve', 'getaddrinfo',
  'temporary failure', 'name or service not known',
  'nameresolutionerror', 'max retries exceeded',
  '[errno -2]', '[errno -3]', '[errno 11001]',
  'network is unreachable', 'no route to host',
]);

// ── pure helpers ────────────────────────────────────────────────────────────

const toBybitSymbol = sym.toBybitSymbol;
const bybitPriceMultiplier = sym.bybitPriceMultiplier;

function isNetworkError(err) {
  const low = String(err).toLowerCase();
  return NETWORK_ERR_MARKERS.some((m) => low.includes(m));
}

/** _humanize_bybit_error */
function humanizeBybitError(raw) {
  if (!pyTruthy(raw)) return 'Неизвестная ошибка Bybit.';
  raw = String(raw);
  let code = null;
  let m = /\b(ErrCode|retCode|status_code)[:\s]+(\d+)/i.exec(raw);
  if (!m) {
    m = /\((\d{3,6})\)/.exec(raw);
    code = m ? parseInt(m[1], 10) : null;
  } else {
    code = parseInt(m[2], 10);
  }
  if (code && Object.prototype.hasOwnProperty.call(BYBIT_ERROR_MAP, code)) return BYBIT_ERROR_MAP[code];
  const low = raw.toLowerCase();
  if (low.includes('not live') || low.includes('contract is not')) return 'Эта монета не торгуется на Bybit Futures. Сигнал пропущен.';
  if (low.includes('auth failed') || (low.includes('retryable') && low.includes('auth'))) {
    return 'Ошибка авторизации API. Проверьте: ключ/секрет, mainnet/testnet, IP whitelist и права ключа (Contract - Trade).';
  }
  if (low.includes('retryable')) return 'Ошибка соединения с Bybit (сервер временно недоступен). Проверьте ключи и попробуйте ещё раз.';
  const clean = raw.replace(/\s*\(ErrCode:\s*\d+\)\s*|\s*\(ErrTime:\s*[\d:]+\)\s*/gi, '').trim().replace(/\.+$/, '');
  if (Array.from(clean).length < 5) return code ? `Ошибка Bybit (код ${code}).` : 'Неизвестная ошибка Bybit.';
  const first = String.fromCodePoint(clean.codePointAt(0));
  return first.toUpperCase() + clean.slice(first.length) + (clean.endsWith('.') ? '' : '.');
}

/** _split_tp_qtys → [[price, qtyStr, label], …] */
function splitTpQtys(qtyF, tp1, tp2, tp3, qtyStep) {
  if (!pyTruthy(tp2) && !pyTruthy(tp3)) return [[tp1, PP.roundQty(qtyF, qtyStep), '100%']];
  let qtyTp2F = qtyF * 0.25;
  let qtyTp3F = qtyF * 0.25;
  if (pyTruthy(tp3) && tp3 > 0 && qtyTp3F < qtyStep) { qtyTp2F += qtyTp3F; qtyTp3F = 0; }
  if (qtyTp2F < qtyStep) { qtyTp2F = 0; qtyTp3F = 0; }
  const qtyTp2 = PP.roundQty(qtyTp2F, qtyStep);
  const qtyTp3 = PP.roundQty(qtyTp3F, qtyStep);
  const qtyTp1F = qtyF - pyFloat(qtyTp2) - pyFloat(qtyTp3);
  const qtyTp1 = PP.roundQty(pyMax(qtyTp1F, pyFloat(qtyTp2) > 0 ? pyFloat(qtyTp2) : qtyStep), qtyStep);
  const out = [[tp1, qtyTp1, '50%']];
  if (pyFloat(qtyTp2) > 0) out.push([tp2, qtyTp2, '25%']);
  if (pyFloat(qtyTp3) > 0) out.push([tp3, qtyTp3, '25%']);
  return out;
}

function wantsTpOrders(tp1, tp2, tp3) {
  return [tp1, tp2, tp3].some((t) => pyFloat(pyOr(t, 0)) > 0);
}

/** float(x) where Python wraps in try/except (ValueError, TypeError). */
function tryFloat(v, dflt) {
  try { return pyFloat(v); } catch (e) {
    if (e && (e.pyType === 'ValueError' || e.pyType === 'TypeError')) return dflt;
    throw e;
  }
}

/** pybit transport errors surface as requests exceptions (ConnectionError / ReadTimeout). */
function asRequestsError(e) {
  if (e instanceof TransportError) {
    return new PyError(e.kind === 'timeout' ? 'ReadTimeout' : 'ConnectionError', e.message || (e.kind === 'timeout' ? 'Read timed out.' : 'Connection aborted.'));
  }
  return e;
}

// ── token buckets ───────────────────────────────────────────────────────────

class TokenBucket {
  constructor(rt, rate = 10.0, burst = 15) {
    this.rt = rt;
    this._rate = rate;
    this._burst = burst;
    this._tokens = burst;
    this._last = rt.monotonic();
  }

  /** threading/asyncio variants share the arithmetic; both poll every 25 ms. */
  async acquire(timeout = 8.0) {
    const deadline = this.rt.monotonic() + timeout;
    for (;;) {
      const now = this.rt.monotonic();
      this._tokens = Math.min(this._burst, this._tokens + (now - this._last) * this._rate);
      this._last = now;
      if (this._tokens >= 1.0) {
        this._tokens -= 1.0;
        return true;
      }
      if (this.rt.monotonic() >= deadline) return false;
      await this.rt.sleep(0.025);
    }
  }
}

// ── trader factory ──────────────────────────────────────────────────────────

function createBybitTrader(overrides = {}) {
  const rt = makeRuntime(overrides);
  const log = rt.log;
  const SAFETY_MARGIN_MS = parseInt(String(rt.env.BYBIT_TIME_SAFETY_MARGIN_MS || '500') || '500', 10);
  const sessionFactory = overrides.sessionFactory
    || ((apiKey, apiSecret, demo) => createPybitSession({ apiKey, apiSecret, demo, recvWindow: 15000, rt }));

  const st = {
    apiBucket: new TokenBucket(rt),
    asyncApiBucket: new TokenBucket(rt),
    perKeyBuckets: new Map(),
    asyncPerKeyBuckets: new Map(),
    perKeyLocks: new Map(),
    delisted: new Map(),
    instrumentFilterCache: new Map(),
    hedgeModeCache: new Map(),
    hedgeModeCacheTs: new Map(),
    symbolFailCount: new Map(),
    pybitSessions: new Map(),
    accountTypeCache: new Map(),
    timeOffsetMs: 0,
    timeSyncedAt: 0.0,
    timeLastWarnAt: 0.0,
  };

  // ── delisted cache ──
  function _isDelisted(bb) {
    const until = st.delisted.get(bb) || 0;
    if (!until) return false;
    if (rt.now() < until) return true;
    st.delisted.delete(bb);
    return false;
  }
  function _markDelisted(bb) {
    if (st.delisted.size >= 200) st.delisted.delete(firstKey(st.delisted));
    st.delisted.set(bb, rt.now() + DELISTING_TTL_S);
    log.info(`[DELISTED] ${bb} — caching for ${Math.floor(DELISTING_TTL_S / 3600)}h, skip future opens`);
  }
  function isSymbolDelisted(symbol) {
    let bb;
    try { bb = toBybitSymbol(symbol); } catch (_e) { log.error('bybit_trader.is_symbol_delisted() unhandled exception'); bb = symbol; }
    return _isDelisted(bb);
  }

  // ── buckets / locks ──
  function _getKeyBucket(apiKey) {
    const short = String(apiKey).slice(0, 16);
    if (!st.perKeyBuckets.has(short)) {
      if (st.perKeyBuckets.size >= 600) {
        st.perKeyBuckets.delete(firstKey(st.perKeyBuckets));
        log.debug('_per_key_buckets evicted (cap=600)');
      }
      st.perKeyBuckets.set(short, new TokenBucket(rt));
    }
    return st.perKeyBuckets.get(short);
  }
  function _getAsyncKeyBucket(apiKey) {
    const short = String(apiKey).slice(0, 16);
    let b = st.asyncPerKeyBuckets.get(short);
    if (!b) {
      if (st.asyncPerKeyBuckets.size >= 600) st.asyncPerKeyBuckets.delete(firstKey(st.asyncPerKeyBuckets));
      b = new TokenBucket(rt);
      st.asyncPerKeyBuckets.set(short, b);
    }
    return b;
  }
  function _getKeyLock(apiKey) {
    const short = String(apiKey).slice(0, 16);
    if (!st.perKeyLocks.has(short)) {
      if (st.perKeyLocks.size >= 600) {
        st.perKeyLocks.delete(firstKey(st.perKeyLocks));
        log.debug('_per_key_locks evicted (cap=600)');
      }
      st.perKeyLocks.set(short, makeLock());
    }
    return st.perKeyLocks.get(short);
  }

  /** bybit_call(fn, kwargs, {timeout, apiKey}) — async bucket + call; errors re-raised with a log. */
  async function bybitCall(fn, kwargs, { apiKey = '', fnName = 'fn' } = {}) {
    const bucket = apiKey ? _getAsyncKeyBucket(apiKey) : st.asyncApiBucket;
    if (!(await bucket.acquire(8.0))) log.warning(`bybit_call ${fnName}: rate bucket acquire timeout (proceeding anyway)`);
    try {
      return await fn(kwargs);
    } catch (e) {
      const err = asRequestsError(e);
      if (err instanceof InvalidRequestError) log.warning(`bybit_call ${fnName} InvalidRequestError: ${err.message}`);
      else if (err instanceof FailedRequestError) log.warning(`bybit_call ${fnName} FailedRequestError: ${err.message}`);
      else log.error(`bybit_call ${fnName} unexpected exception`);
      throw err;
    }
  }

  // ── time sync ──
  async function _getBybitServerTime() {
    try {
      const resp = await rt.transport({ method: 'GET', url: 'https://api.bybit.com/v5/market/time', headers: {}, timeoutMs: 2000 });
      const data = aiohttpJson(resp);
      const result = pyIndex(data, 'result');
      if (isDict(result) && Object.prototype.hasOwnProperty.call(result, 'timeNano')) {
        // int(result["timeNano"]) // 1_000_000 — exact (19-digit str), Python int() of bool / float / str
        const n = pyBigInt(pyIndex(result, 'timeNano'));
        const q = n / 1000000n;
        return Number(n < 0n && q * 1000000n !== n ? q - 1n : q);
      }
      return pyInt(pyIndex(result, 'timeSecond')) * 1000;
    } catch (e) {
      log.error('bybit_trader._get_bybit_server_time() unhandled exception');
      return Math.trunc(rt.now() * 1000);
    }
  }

  async function _getTimestamp() {
    const now = rt.now();
    if (now - st.timeSyncedAt > 10) {
      try {
        const serverMs = await _getBybitServerTime();
        const localMs = Math.trunc(now * 1000);
        const prev = st.timeOffsetMs;
        st.timeOffsetMs = serverMs - localMs;
        st.timeSyncedAt = now;
        st.timeLastWarnAt = 0.0;
        if (Math.abs(st.timeOffsetMs) > TIME_EXTREME_DRIFT_MS) {
          log.warning(`[BYBIT-TIME-DRIFT] |offset|=${st.timeOffsetMs}ms > ${TIME_EXTREME_DRIFT_MS}ms — host clock out of NTP sync`);
        } else {
          const d = st.timeOffsetMs - prev;
          log.info(`Bybit time sync: offset=${st.timeOffsetMs}ms (Δ from last: ${d >= 0 ? '+' : ''}${d}ms)`);
        }
      } catch (syncErr) {
        const staleFor = st.timeSyncedAt > 0 ? now - st.timeSyncedAt : 0;
        if (staleFor > TIME_STALE_WARN_S && (now - st.timeLastWarnAt) > 60) {
          log.warning(`⚠️ Bybit time sync FAIL for ${staleFor.toFixed(0)}s (offset=${st.timeOffsetMs}ms, err=${pySlice(errStr(syncErr), 100)}) — orders may be rejected as 'timestamp out of range'`);
          st.timeLastWarnAt = now;
        }
        if (staleFor > TIME_STALE_RESET_S && st.timeOffsetMs !== 0) {
          log.error(`🚨 Bybit time sync stale >${TIME_STALE_RESET_S.toFixed(0)}s — resetting offset ${st.timeOffsetMs}ms → 0 (using local time directly)`);
          st.timeOffsetMs = 0;
        }
      }
    }
    return Math.trunc(rt.now() * 1000) + st.timeOffsetMs - SAFETY_MARGIN_MS;
  }

  async function syncTime() {
    st.timeSyncedAt = 0.0;
    await _getTimestamp();
    return st.timeOffsetMs;
  }

  // ── instrument filters ──
  async function _getInstrumentFilters(session, symbol, apiKey = '') {
    const now = rt.now();
    const hit = st.instrumentFilterCache.get(symbol);
    if (hit !== undefined && (now - hit[0]) < INSTRUMENT_FILTER_TTL_S) return hit[1];
    try {
      await (apiKey ? _getKeyBucket(apiKey) : st.apiBucket).acquire();
      const resp = await session.get_instruments_info({ category: 'linear', symbol });
      if (pyGet(resp, 'retCode', -1) === 0) {
        const items = pyGet(pyIndex(resp, 'result'), 'list', []);
        if (pyTruthy(items)) {
          const lot = pyGet(items[0], 'lotSizeFilter', {});
          const prc = pyGet(items[0], 'priceFilter', {});
          const qtyStep = pyFloat(pyOr(pyGet(lot, 'qtyStep', ''), 0.001));
          const tickSize = pyFloat(pyOr(pyGet(prc, 'tickSize', ''), 0.0001));
          const val = [pyOr(qtyStep, 0.001), pyOr(tickSize, 0.0001)];
          st.instrumentFilterCache.set(symbol, [now, val]);
          return val;
        }
      }
    } catch (e) {
      log.debug(`get_instruments_info ${symbol}: ${errStr(asRequestsError(e))}`);
    }
    return [0.001, 0.0001];
  }

  // ── hedge mode cache ──
  function _hedgeCacheGet(apiKey) {
    if (!st.hedgeModeCache.has(apiKey)) return null;
    const ts = st.hedgeModeCacheTs.get(apiKey) || 0.0;
    if (ts === 0.0) {
      st.hedgeModeCacheTs.set(apiKey, rt.now());
      return st.hedgeModeCache.get(apiKey);
    }
    if (rt.now() - ts > HEDGE_CACHE_TTL_SEC) {
      st.hedgeModeCache.delete(apiKey);
      st.hedgeModeCacheTs.delete(apiKey);
      return null;
    }
    return st.hedgeModeCache.get(apiKey);
  }
  function _hedgeCacheSet(apiKey, isHedge) {
    if (st.hedgeModeCache.size >= 600 && !st.hedgeModeCache.has(apiKey)) {
      const oldest = firstKey(st.hedgeModeCache);
      st.hedgeModeCache.delete(oldest);
      st.hedgeModeCacheTs.delete(oldest);
    }
    st.hedgeModeCache.set(apiKey, isHedge);
    st.hedgeModeCacheTs.set(apiKey, rt.now());
  }
  /** `if len(_hedge_mode_cache) >= 600: pop oldest` (the extra cap the bot does before set). */
  function _hedgeCapPop() {
    if (st.hedgeModeCache.size >= 600) st.hedgeModeCache.delete(firstKey(st.hedgeModeCache));
  }

  function isDelisted(symbol) {
    let bb;
    try { bb = toBybitSymbol(symbol); } catch (_e) { log.error('bybit_trader.is_delisted() unhandled exception'); bb = symbol; }
    return _isDelisted(bb) || (st.symbolFailCount.get(symbol) || 0) >= AUTO_BLACKLIST_THRESHOLD;
  }
  function recordSymbolFailure(symbol) {
    const bb = toBybitSymbol(symbol);
    st.symbolFailCount.set(bb, (st.symbolFailCount.get(bb) || 0) + 1);
    if (st.symbolFailCount.get(bb) >= AUTO_BLACKLIST_THRESHOLD) log.warning(`Auto-blacklist: ${bb} after ${st.symbolFailCount.get(bb)} failures`);
  }
  function recordSymbolSuccess(symbol) {
    st.symbolFailCount.delete(toBybitSymbol(symbol));
  }
  function _initialPosIdx(apiKey, side) {
    if (pyTruthy(_hedgeCacheGet(apiKey))) return side === 'Buy' ? 1 : 2;
    return 0;
  }

  // ── leverage ──
  async function _trySetLeverage(session, bbSymbol, lev, apiKey) {
    const attempt = async (l) => {
      await _getKeyBucket(apiKey).acquire();
      try {
        const r = await session.set_leverage({ category: 'linear', symbol: bbSymbol, buyLeverage: String(l), sellLeverage: String(l) });
        return [isDict(r) ? pyInt(pyGet(r, 'retCode', -1)) : -1, isDict(r) ? pyStr(pyGet(r, 'retMsg', '')) : ''];
      } catch (e0) {
        const e = asRequestsError(e0);
        if (e instanceof InvalidRequestError) {
          const es = e.message;
          if (es.includes('110043') || e.status_code === 110043) {
            log.debug(`set_leverage ${bbSymbol} ×${l}: already set (110043)`);
            return [110043, 'leverage not modified'];
          }
          log.warning(`set_leverage ${bbSymbol} ×${l} InvalidRequestError: ${pySlice(es, 200)}`);
          return [pyOr(e.status_code, -1), es];
        }
        if (e instanceof FailedRequestError) {
          log.warning(`set_leverage ${bbSymbol} ×${l} FailedRequestError: ${pySlice(e.message, 200)}`);
          return [-1, e.message];
        }
        log.error(`set_leverage ${bbSymbol} ×${l} unexpected exception class (${e.pyType || e.name}): re-raising`);
        throw e;
      }
    };
    const [code, msg] = await attempt(lev);
    if (code === 0 || code === 110043) return { ok: true };
    if (code === 10005 || msg.includes('Permission denied') || msg.includes('10005')) {
      log.warning(`set_leverage ${bbSymbol} ×${lev}: 10005 Permission denied — API key lacks Contract Trade`);
      return {
        ok: false,
        error: '❌ <b>API ключ без прав торговли</b>\n\n'
          + 'У вашего Bybit API ключа отсутствует разрешение «Contract Trading» '
          + '(Unified Account → Trade).\n\n'
          + '<b>Как исправить:</b>\n'
          + '1. Bybit → API Management → ваш ключ → Edit\n'
          + '2. Включите «Unified Trading»\n'
          + '3. Сохраните и переподключите ключ в боте',
      };
    }
    const m = LEV_GT_MAX_RE.exec(msg);
    if (m) {
      const maxScaled = parseInt(m[1], 10);
      const maxLev = Math.max(1, Math.floor(maxScaled / 100));
      if (maxLev < lev) {
        log.info(`set_leverage ${bbSymbol} ×${lev}: bybit risk_limit max=×${maxLev} → retry with ×${maxLev}`);
        const [code2, msg2] = await attempt(maxLev);
        if (code2 === 0 || code2 === 110043) return { ok: true, downgraded_to: maxLev };
        log.warning(`set_leverage retry ${bbSymbol} ×${maxLev} FAILED: code=${pyStr(code2)} msg=${msg2}`);
        return {
          ok: false,
          error: '❌ <b>Биржа отклонила плечо</b>\n\n'
            + `Для ${bbSymbol} максимум ×${maxLev}, но повтор тоже не прошёл:\n`
            + `<i>${htmlEscape(pySlice(msg2, 200))}</i>`,
        };
      }
    }
    log.warning(`set_leverage ${bbSymbol} ×${lev} FAILED: code=${pyStr(code)} msg=${pySlice(msg, 200)}`);
    return { ok: true };
  }

  // ── sessions ──
  function _getSession(apiKey, apiSecret, demo = false) {
    const mode = demo ? 'demo' : 'live';
    const cacheKey = sha256hex(`${apiKey}:${mode}`).slice(0, 32);
    const entry = st.pybitSessions.get(cacheKey);
    let session = null;
    if (entry !== undefined) {
      const [sess, created] = entry;
      session = sess;
      if (rt.now() - created > PYBIT_SESSION_TTL) {
        st.pybitSessions.delete(cacheKey);
        session = null;
        log.debug(`pybit session TTL expired for key=${safeKeyId(apiKey)} mode=${mode}`);
      }
    }
    if (session === null) {
      session = sessionFactory(apiKey, apiSecret, demo);
      if (st.pybitSessions.size >= PYBIT_SESSION_MAX) {
        st.pybitSessions.delete(firstKey(st.pybitSessions));
        log.debug(`_pybit_sessions evicted oldest entry (cap=${PYBIT_SESSION_MAX})`);
      }
      st.pybitSessions.set(cacheKey, [session, rt.now()]);
    }
    session.time_offset = st.timeOffsetMs - SAFETY_MARGIN_MS;
    return session;
  }

  function closeAllPybitSessions() { st.pybitSessions.clear(); }

  function invalidatePybitSession(apiKey) {
    let removed = null;
    for (const suffix of ['live', 'demo']) {
      const k = sha256hex(`${apiKey}:${suffix}`).slice(0, 32);
      if (st.pybitSessions.has(k)) { removed = st.pybitSessions.get(k); st.pybitSessions.delete(k); }
    }
    st.accountTypeCache.delete(apiKey);
    st.hedgeModeCache.delete(apiKey);
    const short = String(apiKey).slice(0, 16);
    st.perKeyBuckets.delete(short);
    st.perKeyLocks.delete(short);
    if (removed !== null) log.info(`invalidate_pybit_session: сессия удалена для key=${safeKeyId(apiKey)}`);
    else log.debug(`invalidate_pybit_session: сессия не найдена для key=${safeKeyId(apiKey)}`);
  }

  function _cacheAccountType(apiKey, type) {
    if (!st.accountTypeCache.has(apiKey) && st.accountTypeCache.size >= 600) st.accountTypeCache.delete(firstKey(st.accountTypeCache));
    st.accountTypeCache.set(apiKey, type);
  }

  // ── wallet balance ──
  async function _getWalletBalanceResp(session, apiKey) {
    if (String(apiKey).startsWith('gAAAAA')) {
      throw new PyError('RuntimeError',
        '(ErrCode: 10003) API ключ повреждён: в БД хранится зашифрованный токен '
        + 'вместо реального ключа. Причина: BYBIT_FERNET_KEY не задан при запуске '
        + 'или database._decrypt_key не вызвал _init_fernet(). '
        + 'Переустанови ключи через 🔑 Настроить Bybit API.');
    }
    let cached = st.accountTypeCache.get(apiKey);
    if (cached) {
      await _getKeyBucket(apiKey).acquire();
      try {
        const resp = await session.get_wallet_balance({ accountType: cached, coin: 'USDT' });
        if (pyGet(resp, 'retCode', -1) === 0) return resp;
        log.debug(`Bybit cached acct type ${cached} failed, re-detecting (key=${safeKeyId(apiKey)})`);
        st.accountTypeCache.delete(apiKey);
      } catch (e) {
        log.debug(`Bybit cached acct type ${cached} raised: ${errStr(asRequestsError(e))}, re-detecting`);
        st.accountTypeCache.delete(apiKey);
      }
    }
    let lastErr = 'Unknown error';
    let lastWasNetwork = false;
    const BACKOFFS = [0.5, 1.0, 2.0, 4.0];
    const result = await _getKeyLock(apiKey).run(async () => {
      cached = st.accountTypeCache.get(apiKey);
      if (cached) {
        await _getKeyBucket(apiKey).acquire();
        const resp = await session.get_wallet_balance({ accountType: cached, coin: 'USDT' }).catch((e) => { throw asRequestsError(e); });
        if (pyGet(resp, 'retCode', -1) === 0) return resp;
      }
      for (const acctType of ['UNIFIED', 'CONTRACT']) {
        for (let attempt = 0; attempt < BACKOFFS.length; attempt++) {
          await _getKeyBucket(apiKey).acquire();
          try {
            const resp = await session.get_wallet_balance({ accountType: acctType, coin: 'USDT' });
            if (pyGet(resp, 'retCode', -1) === 0) {
              _cacheAccountType(apiKey, acctType);
              log.info(`Bybit account type detected: ${acctType} (key=${safeKeyId(apiKey)})`);
              return resp;
            }
            const retCode = pyGet(resp, 'retCode', 0);
            const retMsg = pyGet(resp, 'retMsg', 'Unknown error');
            lastErr = pyTruthy(retCode) ? `(ErrCode: ${pyStr(retCode)}) ${pyStr(retMsg)}` : pyStr(retMsg);
            lastWasNetwork = false;
            log.debug(`Bybit wallet balance ${acctType}: retCode=${pyStr(retCode)} ${pyStr(retMsg)}`);
            if (retCode === 10001 && pyStr(pyGet(resp, 'retMsg', '')).includes('UNIFIED')) {
              _cacheAccountType(apiKey, 'UNIFIED');
              throw Object.assign(new PyError('RuntimeError', `(ErrCode: ${pyStr(retCode)}) ${pyStr(pyGet(resp, 'retMsg'))} — переподключи API ключи через настройки бота.`), { _fromRetCode: true });
            }
            if (retCode === 10006 || retCode === 429) {
              await rt.sleep(BACKOFFS[Math.min(attempt, BACKOFFS.length - 1)]);
              continue;
            }
            break;
          } catch (e0) {
            const e = asRequestsError(e0);
            lastErr = errStr(e);
            const low = lastErr.toLowerCase();
            const isNet = WALLET_NETWORK_KWS.some((kw) => low.includes(kw));
            lastWasNetwork = isNet;
            if (isNet && attempt < BACKOFFS.length - 1) {
              const delay = BACKOFFS[attempt];
              log.debug(`Bybit wallet balance ${acctType}: network err (attempt ${attempt + 1}) — backoff ${delay}s: ${pySlice(lastErr, 100)}`);
              await rt.sleep(delay);
              continue;
            }
            log.debug(`Bybit wallet balance ${acctType}: ${pySlice(lastErr, 200)}`);
            break;
          }
        }
      }
      return null;
    });
    if (result !== null) return result;
    if (lastWasNetwork) {
      throw new PyError('RuntimeError', '⚠️ Временные сетевые проблемы с api.bybit.com (DNS/connection). Попробуй ещё раз через 1-2 минуты.');
    }
    throw new PyError('RuntimeError', `Auth failed after trying UNIFIED/CONTRACT. Last error: ${lastErr}`);
  }

  async function _getBalanceSync(apiKey, apiSecret, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    log.debug(`_get_balance_sync: endpoint=${session.endpoint} demo=${demo ? 'True' : 'False'} key=${safeKeyId(apiKey)}`);
    const resp = await _getWalletBalanceResp(session, apiKey);
    if (pyGet(resp, 'retCode', -1) !== 0) throw new PyError('RuntimeError', pyStr(pyGet(resp, 'retMsg', 'Balance error')));
    try {
      const accountData = pyIndex(pyIndex(pyIndex(resp, 'result'), 'list'), 0);
      const totalEquity = pyGet(accountData, 'totalEquity');
      if (pyTruthy(totalEquity)) {
        const v = tryFloat(totalEquity, null);
        if (v !== null && v > 0) return v;
      }
    } catch (e) {
      if (!(e && ['KeyError', 'IndexError', 'TypeError'].includes(e.pyType))) throw e;
    }
    const coins = pyIndex(pyIndex(pyIndex(pyIndex(resp, 'result'), 'list'), 0), 'coin');
    for (const coin of pyIter(coins)) {
      if (pyIndex(coin, 'coin') === 'USDT') {
        const val = pyOr(pyGet(coin, 'walletBalance'), pyGet(coin, 'equity'), pyGet(coin, 'availableBalance'), pyGet(coin, 'availableToWithdraw'), '0');
        return tryFloat(val, 0.0);
      }
    }
    return 0.0;
  }

  async function _getAvailableMarginSync(apiKey, apiSecret, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const resp = await _getWalletBalanceResp(session, apiKey);
    if (pyGet(resp, 'retCode', -1) !== 0) throw new PyError('RuntimeError', pyStr(pyGet(resp, 'retMsg', 'Balance error')));
    let coins;
    try {
      coins = pyIndex(pyIndex(pyIndex(pyIndex(resp, 'result'), 'list'), 0), 'coin');
    } catch (e) {
      if (e && ['KeyError', 'IndexError', 'TypeError'].includes(e.pyType)) return 0.0;
      throw e;
    }
    let acctTotalAvail = null;
    try {
      acctTotalAvail = pyGet(pyIndex(pyIndex(pyIndex(resp, 'result'), 'list'), 0), 'totalAvailableBalance');
    } catch (e) {
      if (!(e && ['KeyError', 'IndexError', 'TypeError'].includes(e.pyType))) throw e;
      acctTotalAvail = null;
    }
    for (const coin of pyIter(coins)) {
      if (pyGet(coin, 'coin') !== 'USDT') continue;
      let raw = pyOr(pyGet(coin, 'availableBalance'), pyGet(coin, 'availableToWithdraw'));
      if (!pyTruthy(raw)) raw = acctTotalAvail;
      if (!pyTruthy(raw)) raw = '0';
      return tryFloat(raw, 0.0);
    }
    return 0.0;
  }

  async function getBalance(apiKey, apiSecret, demo = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await _getBalanceSync(apiKey, apiSecret, demo);
      } catch (e0) {
        const e = asRequestsError(e0);
        const s = errStr(e).toLowerCase();
        if (attempt === 0 && (s.includes('494') || s.includes('10002') || s.includes('retryable'))) {
          st.timeSyncedAt = 0.0;
          await _getTimestamp();
          continue;
        }
        throw e;
      }
    }
    return 0.0;
  }

  // ── public tickers (aiohttp) ──
  async function _ticker(symbol) {
    const bb = toBybitSymbol(symbol);
    const resp = await rt.transport({
      method: 'GET', url: `https://api.bybit.com/v5/market/tickers?${aioQuery({ category: 'linear', symbol: bb })}`, headers: {}, timeoutMs: 5000,
    });
    const data = aiohttpJson(resp);
    return pyGet(pyGet(data, 'result', {}), 'list', []);
  }

  async function getLastPrice(apiKey, apiSecret, symbol) {
    try {
      const lst = await _ticker(symbol);
      if (pyTruthy(lst)) return pyFloat(pyOr(pyGet(lst[0], 'lastPrice', 0), 0));
    } catch (e) {
      log.debug(`get_last_price ${symbol}: ${errStr(e)}`);
    }
    return 0.0;
  }

  async function getSpreadPct(symbol) {
    try {
      const lst = await _ticker(symbol);
      if (pyTruthy(lst)) {
        const bid = pyFloat(pyOr(pyGet(lst[0], 'bid1Price', 0), 0));
        const ask = pyFloat(pyOr(pyGet(lst[0], 'ask1Price', 0), 0));
        if (bid > 0 && ask > 0) {
          const mid = (bid + ask) / 2;
          return (ask - bid) / mid * 100;
        }
      }
    } catch (e) {
      log.debug(`get_spread_pct ${symbol}: ${errStr(e)}`);
    }
    return 0.0;
  }

  async function getFundingRate(symbol) {
    try {
      const lst = await _ticker(symbol);
      if (pyTruthy(lst)) return pyFloat(pyOr(pyGet(lst[0], 'fundingRate', 0), 0));
    } catch (e) {
      log.debug(`get_funding_rate ${symbol}: ${errStr(e)}`);
    }
    return 0.0;
  }

  // ── test connection ──
  async function _testConnectionSingle(apiKey, apiSecret, demo = false) {
    const base = demo ? 'https://api-demo.bybit.com' : 'https://api.bybit.com';
    let serverMs = null;
    let connErr = null;
    const TIME_BACKOFFS = [0.5, 1.5, 3.0];
    for (let attempt = 0; attempt < TIME_BACKOFFS.length + 1; attempt++) {
      try {
        const r = await rt.transport({ method: 'GET', url: `${base}/v5/market/time`, headers: {}, timeoutMs: 8000 });
        if (r.status !== 200) {
          return {
            ok: false,
            error: `Bybit API недоступен (HTTP ${r.status}). Проверьте сетевое соединение или статус биржи на status.bybit.com`,
          };
        }
        const data = aiohttpJson(r);
        serverMs = pyInt(pyIndex(pyIndex(data, 'result'), 'timeSecond')) * 1000;
        break;
      } catch (e) {
        connErr = e;
        const es = errStr(e);
        const isNet = isNetworkError(es);
        log.warning(`test_connection [${demo ? 'DEMO' : 'LIVE'}] /v5/market/time attempt=${attempt + 1} err=${pySlice(es, 160)} net=${isNet ? 'True' : 'False'}`);
        if (attempt < TIME_BACKOFFS.length && isNet) {
          await rt.sleep(TIME_BACKOFFS[attempt]);
          continue;
        }
        break;
      }
    }
    if (serverMs === null) {
      return { ok: false, error: `Нет соединения с Bybit: ${errStr(connErr)}. Проверьте интернет-соединение сервера.` };
    }
    const localMs = Math.trunc(rt.now() * 1000);
    st.timeOffsetMs = serverMs - localMs;
    st.timeSyncedAt = rt.now();
    log.info(`test_connection: time offset=${st.timeOffsetMs}ms`);
    try {
      const recvWindow = '10000';
      const timestamp = String(serverMs);
      let lastErr = '';
      for (const acctType of ['UNIFIED', 'CONTRACT']) {
        const queryStr = `accountType=${acctType}&coin=USDT`;
        const signature = require('./bybitHttp').bybitSign(apiSecret, timestamp + apiKey + recvWindow + queryStr);
        const headers = {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-SIGN': signature,
          'X-BAPI-SIGN-TYPE': '2',
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
        };
        const resp = await rt.transport({
          method: 'GET', url: `${base}/v5/account/wallet-balance?${aioQuery({ accountType: acctType, coin: 'USDT' })}`, headers, timeoutMs: 10000,
        });
        const httpStatus = resp.status;
        const body = aiohttpJson(resp, { checkContentType: false });
        const retCode = pyGet(body, 'retCode', -1);
        const retMsg = pyGet(body, 'retMsg', '');
        log.info(`test_connection [${demo ? 'DEMO' : 'LIVE'}] acct=${acctType} → HTTP ${httpStatus} retCode=${pyStr(retCode)} retMsg=${pyStr(retMsg)} key=${safeKeyId(apiKey)}`);
        if (retCode === 0) {
          let balance = 0.0;
          try {
            const coins = pyIndex(pyIndex(pyIndex(pyIndex(body, 'result'), 'list'), 0), 'coin');
            for (const c of pyIter(coins)) {
              if (pyIndex(c, 'coin') === 'USDT') {
                balance = pyFloat(pyOr(pyGet(c, 'availableBalance'), pyGet(c, 'availableToWithdraw'), pyGet(c, 'walletBalance'), '0'));
                break;
              }
            }
          } catch (_e) {
            log.error('bybit_trader._test_connection_single() unhandled exception');
            balance = 0.0;
          }
          _cacheAccountType(apiKey, acctType);
          return { ok: true, balance };
        }
        lastErr = pyTruthy(retCode) ? `(ErrCode: ${pyStr(retCode)}) ${pyStr(retMsg)}` : pyStr(retMsg);
        if (httpStatus === 403) lastErr = `(ErrCode: 403) ${pyStr(pyOr(retMsg, 'IP restriction'))}`;
        else if (httpStatus === 401) lastErr = `(ErrCode: 401) ${pyStr(pyOr(retMsg, 'Unauthorized'))}`;
      }
      if (demo) {
        log.info('test_connection: direct HTTP failed for demo, trying pybit fallback...');
        try {
          const session = _getSession(apiKey, apiSecret, true);
          const resp = await bybitCall(session.get_wallet_balance, { accountType: 'UNIFIED', coin: 'USDT' }, { apiKey, fnName: 'get_wallet_balance' });
          if (pyGet(resp, 'retCode') === 0) {
            const coins = pyIndex(pyIndex(pyIndex(pyIndex(resp, 'result'), 'list'), 0), 'coin');
            let balance = 0.0;
            for (const c of pyIter(coins)) {
              if (pyIndex(c, 'coin') === 'USDT') { balance = pyFloat(pyOr(pyGet(c, 'walletBalance'), pyGet(c, 'availableBalance'), 0)); break; }
            }
            return { ok: true, balance };
          }
          const resp2 = await bybitCall(session.get_wallet_balance, { accountType: 'CONTRACT', coin: 'USDT' }, { apiKey, fnName: 'get_wallet_balance' });
          if (pyGet(resp2, 'retCode') === 0) {
            const coins = pyIndex(pyIndex(pyIndex(pyIndex(resp2, 'result'), 'list'), 0), 'coin');
            let balance = 0.0;
            for (const c of pyIter(coins)) {
              if (pyIndex(c, 'coin') === 'USDT') { balance = pyFloat(pyOr(pyGet(c, 'walletBalance'), pyGet(c, 'availableBalance'), 0)); break; }
            }
            return { ok: true, balance };
          }
          lastErr = `pybit: ${pyStr(pyGet(resp, 'retMsg', ''))} / ${pyStr(pyGet(resp2, 'retMsg', ''))}`;
        } catch (pybitErr) {
          lastErr = `pybit fallback: ${errStr(pybitErr)}`;
          log.warning(`test_connection pybit fallback failed: ${errStr(pybitErr)}`);
        }
      }
      log.warning(`test_connection failed: both UNIFIED and CONTRACT failed, last error: ${pyRepr(lastErr)} key=${safeKeyId(apiKey)}...`);
      return { ok: false, error: humanizeBybitError(lastErr) };
    } catch (e) {
      log.error(`test_connection direct request error: ${errStr(e)}`);
      return { ok: false, error: humanizeBybitError(errStr(e)) };
    }
  }

  async function testConnection(apiKey, apiSecret, demo = false) {
    const result = await _testConnectionSingle(apiKey, apiSecret, demo);
    if (pyTruthy(pyGet(result, 'ok'))) {
      result.endpoint = demo ? 'demo' : 'live';
      return result;
    }
    const altDemo = !demo;
    const altLabel = altDemo ? 'demo' : 'live';
    log.info(`test_connection: trying fallback endpoint (${altLabel})...`);
    const result2 = await _testConnectionSingle(apiKey, apiSecret, altDemo);
    if (pyTruthy(pyGet(result2, 'ok'))) {
      result2.endpoint = altLabel;
      result2._switched = true;
      return result2;
    }
    return result;
  }

  // ── TP orders ──
  async function _getCurrentPositionSize(session, bbSymbol, apiKey = '', posIdx = -1) {
    try {
      if (apiKey) await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_positions({ category: 'linear', symbol: bbSymbol });
      if (pyGet(resp, 'retCode', -1) !== 0) return 0.0;
      const rows = pyOr(pyGet(pyGet(resp, 'result', {}), 'list', []), []);
      const matching = pyIter(rows).filter((p) => pyGet(p, 'symbol') === bbSymbol);
      if (!matching.length) return 0.0;
      if (posIdx !== -1) {
        for (const p of pyIter(matching)) {
          if (pyInt(pyOr(pyGet(p, 'positionIdx', 0), 0)) === posIdx) return pyFloat(pyOr(pyGet(p, 'size', '0'), '0'));
        }
        return 0.0;
      }
      for (const p of pyIter(matching)) {
        const sz = pyFloat(pyOr(pyGet(p, 'size', '0'), '0'));
        if (sz > 0) return sz;
      }
      return pyFloat(pyOr(pyGet(matching[0], 'size', '0'), '0'));
    } catch (_e) {
      log.debug(`_get_current_position_size ${bbSymbol}: query error`);
    }
    return 0.0;
  }

  async function _placeTpOrdersViaSession(session, bbSymbol, side, qtyF, tp1, tp2, tp3, tickSize, qtyStep, posIdx,
    { apiKey = '', tradeId = '', userId = 0, skipTp1 = false } = {}) {
    const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
    let tpOrders = splitTpQtys(qtyF, tp1, tp2, tp3, qtyStep);
    if (skipTp1 && tpOrders.length) tpOrders = tpOrders.slice(1);
    let anyPlaced = Boolean(skipTp1);
    const POLL_MAX = pyInt(String(rt.env.BYBIT_POS_POLL_MAX_S || '30'));
    const POLL_INTERVAL = pyFloat(String(rt.env.BYBIT_POS_POLL_INTERVAL_S || '1.0'));
    let ready = false;
    for (let i = 0; i < POLL_MAX; i++) {
      try {
        if (apiKey) await _getKeyBucket(apiKey).acquire();
        const posResp = await session.get_positions({ category: 'linear', symbol: bbSymbol });
        if (pyGet(posResp, 'retCode', -1) === 0) {
          for (const p of pyIter(pyOr(pyGet(pyGet(posResp, 'result', {}), 'list', []), []))) {
            if (pyGet(p, 'symbol') !== bbSymbol) continue;
            if (pyInt(pyOr(pyGet(p, 'positionIdx', 0), 0)) !== posIdx) continue;
            if (pyFloat(pyOr(pyGet(p, 'size', '0'), '0')) > 0) { ready = true; break; }
          }
        }
        if (ready) break;
      } catch (e) {
        log.debug(`position poll ${bbSymbol}: ${errStr(asRequestsError(e))}`);
      }
      await rt.sleep(POLL_INTERVAL);
    }
    if (!ready) {
      log.warning(`TP placement ${bbSymbol}: position size=0 after ${POLL_MAX}s polls — skipping TP (reconcile loop will retry). Possible causes: limit order not filled yet, hedge mode mismatch, API lag.`);
      return false;
    }
    const fresh = await _getCurrentPositionSize(session, bbSymbol, apiKey, posIdx);
    if (fresh <= 0) {
      log.warning(`TP placement ${bbSymbol}: position disappeared between pre-poll and first place_order — skip all TPs (reconcile will handle)`);
      return false;
    }
    if (fresh < qtyF * 0.95) {
      log.warning(`TP placement ${bbSymbol}: fresh size ${pyFloatStr(fresh)} < planned ${pyFloatStr(qtyF)} (partial fill or external close) — rescaling TP qtys`);
      qtyF = fresh;
      tpOrders = splitTpQtys(qtyF, tp1, tp2, tp3, qtyStep);
    }
    let tpCids = [];
    if (tradeId) {
      const start = skipTp1 ? 2 : 1;
      for (let i = start; i < 4; i++) tpCids.push(computeClientOrderId(tradeId, userId, 'bybit', `tp${i}`));
    }
    for (let pos = 0; pos < tpOrders.length; pos++) {
      const [tpPrice, qtyTpStr] = tpOrders[pos];
      if (!pyTruthy(tpPrice) || tpPrice <= 0) continue;
      const qtyTpF = pyFloat(qtyTpStr);
      if (qtyTpF < qtyStep) {
        log.warning(`TP @${pyFloatStr(tpPrice)} ${bbSymbol}: qty=${qtyTpStr} < qtyStep ${pyFloatStr(qtyStep)} → would truncate to zero on exchange, skipping this TP level`);
        continue;
      }
      let tpOk = false;
      let lastErr = '';
      const cid = pos < tpCids.length ? tpCids[pos] : '';
      let tpParams = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await _getKeyBucket(apiKey).acquire();
          tpParams = {
            category: 'linear', symbol: bbSymbol, side: closeSide, orderType: 'Limit', qty: qtyTpStr,
            price: PP.roundPrice(tpPrice, tickSize), reduceOnly: true, timeInForce: 'GTC', positionIdx: posIdx,
          };
          if (cid) tpParams.orderLinkId = cid;
          const r = await session.place_order(tpParams);
          if (pyGet(r, 'retCode', -1) === 0) {
            anyPlaced = true;
            tpOk = true;
            await rt.sleep(0.3);
            break;
          }
          lastErr = `retCode=${pyStr(pyGet(r, 'retCode'))} ${pyStr(pyGet(r, 'retMsg', ''))}`;
          if (pyGet(r, 'retCode') === 110072 && cid) {
            log.info(`TP duplicate rejected (idempotency works): ${bbSymbol} cid=${cid} — assuming already placed`);
            anyPlaced = true;
            tpOk = true;
            break;
          }
          if (pyGet(r, 'retCode') === 110017 && attempt < 2) {
            let retryPos;
            try {
              retryPos = await _getCurrentPositionSize(session, bbSymbol, apiKey, posIdx);
            } catch (rpE) {
              log.debug(`110017 position recheck failed: ${errStr(rpE)}`);
              retryPos = -1.0;
            }
            if (retryPos === 0) {
              log.info(`TP @${pyFloatStr(tpPrice)} ${bbSymbol}: 110017 confirmed flash-close (position=0) — skip remaining retries`);
              lastErr = 'retCode=110017 (flash-closed, position=0)';
              break;
            }
            await rt.sleep(1.5);
            continue;
          }
          break;
        } catch (e0) {
          const e = asRequestsError(e0);
          const es = errStr(e);
          lastErr = pySlice(es, 120);
          if (e instanceof InvalidRequestError) {
            log.warning(`TP placement ${bbSymbol} qty=${pyStr(tpParams ? tpParams.qty : null)} price=${pyStr(tpParams ? tpParams.price : null)} attempt=${attempt + 1}/3: ${pySlice(es, 160)} — notional может быть ниже Bybit min (~$1-5 USDT), скипаем TP`);
          } else {
            log.error('bybit_trader._place_tp_orders_via_session() unhandled exception');
          }
          if (es.includes('110017') && attempt < 2) {
            await rt.sleep(1.5);
            continue;
          }
          break;
        }
      }
      if (!tpOk) {
        if (lastErr.includes('flash-closed')) log.info(`TP @${pyFloatStr(tpPrice)} ${bbSymbol}: position flash-closed (${lastErr}) — no TP needed`);
        else if (lastErr.includes('110017')) log.warning(`TP @${pyFloatStr(tpPrice)} ${bbSymbol}: position zero AFTER pre-poll success — check hedge mode / positionIdx`);
        else log.warning(`TP @${pyFloatStr(tpPrice)} ${bbSymbol} failed after 3 attempts: ${lastErr}`);
      }
    }
    return anyPlaced;
  }

  async function _placeTpOrdersSync(apiKey, apiSecret, symbol, direction, posSize, tp1, tp2, tp3, posIdx = 0, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    const side = direction === 'LONG' ? 'Buy' : 'Sell';
    const pmult = bybitPriceMultiplier(symbol);
    if (pmult !== 1.0) {
      tp1 *= pmult;
      if (pyTruthy(tp2)) tp2 *= pmult;
      if (pyTruthy(tp3)) tp3 *= pmult;
    }
    const [qtyStep, tickSize] = await _getInstrumentFilters(session, bb, apiKey);
    return _placeTpOrdersViaSession(session, bb, side, posSize, tp1, tp2, tp3, tickSize, qtyStep, posIdx, { apiKey });
  }

  async function placeTpOrders(apiKey, apiSecret, symbol, direction, posSize, tp1, tp2, tp3, posIdx = 0, demo = false) {
    const ok = await _placeTpOrdersSync(apiKey, apiSecret, symbol, direction, posSize, tp1, tp2, tp3, posIdx, demo);
    if (!ok) return false;
    try {
      await rt.sleep(2.0);
      const orders = await getOpenOrders(apiKey, apiSecret, demo);
      const bb = toBybitSymbol(symbol);
      const closeSide = direction === 'LONG' ? 'Sell' : 'Buy';
      const live = pyIter(orders).filter((o) => pyStr(pyGet(o, 'symbol', '')) === bb
        && pyGet(o, 'reduceOnly') === true
        && pyStr(pyGet(o, 'orderType', '')) === 'Limit'
        && pyStr(pyGet(o, 'side', '')) === closeSide).length;
      const expected = (!pyTruthy(tp2) && !pyTruthy(tp3)) ? 1 : ((pyTruthy(tp2) && pyTruthy(tp3)) ? 3 : 2);
      if (live < expected) {
        log.warning(`[TP-PHANTOM] Bybit ${bb}: expected ${expected} TP orders, only ${live} on exchange. Возможно биржа удалила — recovery через BE-monitor next cycle.`);
        return false;
      }
      log.debug(`[TP-VERIFIED] Bybit ${bb}: ${live}/${expected} TPs on exchange`);
    } catch (e) {
      log.debug(`TP verify ${symbol}: ${errStr(e)}`);
    }
    return true;
  }

  // ── place trade ──
  async function _placeTradeSync(apiKey, apiSecret, symbol, direction, entry, sl, tp1, riskPct, leverage, o = {}) {
    let { tp2 = 0.0, tp3 = 0.0 } = o;
    const {
      riskMode = 'risk', demo = false, orderType = 'Limit', tradeId = '', userId = 0, allowLowNotionalBoost = false,
    } = o;
    const session = _getSession(apiKey, apiSecret, demo);
    log.info(`place_trade: endpoint=${session.endpoint} demo=${demo ? 'True' : 'False'} sym=${symbol} key=${safeKeyId(apiKey)}`);
    const bbSymbol = toBybitSymbol(symbol);
    if (_isDelisted(bbSymbol)) return { ok: false, error: `${bbSymbol} делистнут на Bybit (cached).` };
    const side = direction === 'LONG' ? 'Buy' : 'Sell';
    const lev = Math.min(Math.max(1, leverage), MAX_LEVERAGE);
    const pmult = bybitPriceMultiplier(symbol);
    if (pmult !== 1.0) {
      entry *= pmult;
      sl *= pmult;
      tp1 *= pmult;
      if (pyTruthy(tp2)) tp2 *= pmult;
      if (pyTruthy(tp3)) tp3 *= pmult;
      log.debug(`Bybit 1000x price correction ${symbol}: ×${fmtFixed(pmult, 0)}`);
    }
    try {
      await _getKeyBucket(apiKey).acquire();
      await session.switch_margin_mode({ category: 'linear', symbol: bbSymbol, tradeMode: 1 });
    } catch (mmErr) {
      const s = errStr(asRequestsError(mmErr));
      if (!s.includes('110026')) log.debug(`switch_margin_mode ${bbSymbol}: ${s}`);
    }
    const levSet = await _trySetLeverage(session, bbSymbol, lev, apiKey);
    if (!pyTruthy(pyGet(levSet, 'ok'))) return { ok: false, error: levSet.error };
    const levDowngraded = pyTruthy(pyGet(levSet, 'downgraded_to'));
    const levApplied = pyInt(pyOr(pyGet(levSet, 'downgraded_to'), lev));

    const balance = await _getBalanceSync(apiKey, apiSecret, demo);
    if (balance < 1.0) {
      return { ok: false, error: `Недостаточно средств: $${fmtFixed(balance, 2)} USDT\nПополни счёт и попробуй снова.` };
    }
    const priceDiff = Math.abs(entry - sl);
    if (priceDiff <= 0) return { ok: false, error: 'Некорректные entry/SL' };
    let qtyRaw;
    let notional;
    if (riskMode === 'notional') {
      const target = balance * (riskPct / 100.0);
      qtyRaw = entry > 0 ? target / entry : 0;
      notional = target;
    } else if (riskMode === 'margin') {
      const target = balance * (riskPct / 100.0) * levApplied;
      qtyRaw = entry > 0 ? target / entry : 0;
      notional = target;
    } else {
      const riskAmount = balance * (riskPct / 100.0);
      qtyRaw = riskAmount / priceDiff;
      notional = qtyRaw * entry;
    }
    const minPos = Math.max(MIN_NOTIONAL, 10.0);
    let riskBoosted = false;
    if (notional < minPos) {
      if (!allowLowNotionalBoost) {
        const requiredBalance = riskPct > 0 ? minPos / (riskPct / 100.0) : 0.0;
        const minRiskForBalance = balance > 0 ? minPos / balance * 100.0 : 0.0;
        return {
          ok: false, order_id: '',
          low_notional_skip: true,
          required_balance: pyRound(requiredBalance, 2),
          requested_risk_pct: pyRound(riskPct, 2),
          min_risk_for_balance_pct: pyRound(minRiskForBalance, 2),
          error: `Баланс $${fmtFixed(balance, 2)} слишком мал для risk=${pyFloatStr(riskPct)}% `
            + `(минимум биржи $${fmtFixed(minPos, 0)} notional). `
            + `Пополни до $${fmtFixed(requiredBalance, 0)}+ или увеличь risk≥${fmtFixed(minRiskForBalance, 1)}%.`,
        };
      }
      qtyRaw = entry > 0 ? minPos / entry : 0;
      notional = qtyRaw * entry;
      riskBoosted = true;
      log.warning(`[AUDIT-FIX] ⚠️ Volume boosted to min ${bbSymbol} (user opt-in): qty=${fmtFixed(qtyRaw, 6)} notional=${fmtFixed(notional, 2)}`);
    }
    let realRiskPctForUser = 0.0;
    let expectedPctForUser = 0.0;
    if (riskMode === 'risk') {
      const realSlLoss = qtyRaw * Math.abs(entry - sl);
      const expectedLoss = balance * (riskPct / 100.0);
      if (expectedLoss > 0) {
        realRiskPctForUser = balance > 0 ? pyRound(realSlLoss / balance * 100, 2) : 0;
        expectedPctForUser = pyRound(riskPct, 2);
      }
      if (expectedLoss > 0 && realSlLoss > expectedLoss * 1.5) {
        const realPct = balance > 0 ? realSlLoss / balance * 100 : 0;
        log.warning(`[RISK-AUDIT] ${bbSymbol}: requested risk ${fmtFixed(riskPct, 2)}% (≈$${fmtFixed(expectedLoss, 2)}), but actual SL-loss = $${fmtFixed(realSlLoss, 2)} (${fmtFixed(realPct, 2)}% of balance) — boosted by min_position floor. qty=${fmtFixed(qtyRaw, 6)} notional=$${fmtFixed(notional, 2)} sl_dist=${fmtFixed(entry ? Math.abs(entry - sl) / entry * 100 : 0, 4)}%`);
      }
    }
    const [qtyStep, tickSize] = await _getInstrumentFilters(session, bbSymbol, apiKey);
    const qtyStr = PP.roundQty(qtyRaw, qtyStep);
    const slDistPct = entry > 0 ? priceDiff / entry * 100 : 999.0;
    const feePct = TAKER_FEE * 2 * 100;
    if (pyFloat(qtyStr) <= 0 || (qtyRaw > 0 && qtyRaw < qtyStep)) {
      if (slDistPct < feePct * 2) {
        const minSlPct = feePct * 3;
        return {
          ok: false,
          error: `❌ Стоп слишком близко: ${fmtFixed(slDistPct, 3)}% от входа.\n`
            + `Комиссия round-trip: ${fmtFixed(feePct, 3)}% — объём позиции уходит в ноль.\n\n`
            + 'Реши одно из двух:\n'
            + `▸ Увеличь risk (сейчас ${pyFloatStr(riskPct)}%) — например, до ${fmtFixed(riskPct * 2, 1)}%\n`
            + `▸ Расширь SL до ≥${fmtFixed(minSlPct, 2)}% от входа `
            + `(сейчас ${fmtFixed(slDistPct, 3)}%)`,
        };
      }
      return {
        ok: false,
        error: `Размер позиции слишком мал ($${fmtFixed(notional, 2)}). `
          + `Нужен депозит от $${fmtFixed(pyDiv(MIN_NOTIONAL, riskPct / 100), 0)} `
          + `при риске ${pyFloatStr(riskPct)}%. `
          + `Минимальный лот: ${pyFloatStr(qtyStep)} — расчётный: ${fmtFixed(qtyRaw, 6)}.`,
      };
    }
    const realNotional = pyFloat(qtyStr) * entry;
    const initialMargin = realNotional / levApplied;
    const feeCost = realNotional * MAKER_FEE * 2;
    const marginRequired = initialMargin + feeCost;
    if (marginRequired > balance * 0.85) {
      return {
        ok: false,
        error: 'Недостаточно маржи для открытия позиции.\n'
          + `Требуется: $${fmtFixed(marginRequired, 2)} USDT `
          + `(маржа $${fmtFixed(initialMargin, 2)} + комиссия ~$${fmtFixed(feeCost, 2)})\n`
          + `Доступно:  $${fmtFixed(balance, 2)} USDT\n`
          + `Уменьши риск (сейчас ${pyFloatStr(riskPct)}%) или пополни счёт.`,
      };
    }
    let available;
    try {
      available = await _getAvailableMarginSync(apiKey, apiSecret, demo);
    } catch (amE) {
      log.warning(`[MARGIN-PRECHECK] sym=${bbSymbol}: could not fetch available margin: ${errStr(asRequestsError(amE))} — skipping pre-check, proceeding to placement (Bybit will reject with 110007 if insufficient)`);
      available = null;
    }
    if (available !== null) {
      const totalRequired = (pyFloat(qtyStr) * entry) / Math.max(1, lev) * 1.05;
      const reqDisp = pyRound(totalRequired, 2);
      const availDisp = pyRound(available, 2);
      if (reqDisp > availDisp) {
        log.warning(`[MARGIN-PRECHECK] ${bbSymbol} insufficient: required=${fmtFixed(reqDisp, 2)} available=${fmtFixed(availDisp, 2)} (leverage=${lev}x, qty=${qtyStr}) — fail-fast with clear error instead of Bybit 110007`);
        return {
          ok: false,
          error: '❌ Недостаточно свободной маржи\n\n'
            + `Нужно: $${fmtFixed(reqDisp, 2)}\n`
            + `Доступно: $${fmtFixed(availDisp, 2)}\n\n`
            + '▸ Закрой часть открытых позиций\n'
            + `▸ Уменьши leverage (сейчас ×${lev})\n`
            + `▸ Уменьши risk (сейчас ${pyFloatStr(riskPct)}%)`,
          insufficient_margin: true,
        };
      }
    }
    const hedgeIdx = side === 'Buy' ? 1 : 2;
    const startIdx = _initialPosIdx(apiKey, side);
    const slStr = PP.roundPrice(sl, tickSize);
    const entryStr = PP.roundPrice(entry, tickSize);
    let isUnified = (st.accountTypeCache.has(apiKey) ? st.accountTypeCache.get(apiKey) : 'UNIFIED') === 'UNIFIED';
    const cidEntry = tradeId ? computeClientOrderId(tradeId, userId, 'bybit', 'entry') : '';
    const isMarket = String(orderType).toLowerCase() === 'market';
    let atomicTpsl = {};
    const qtyForAtomic = pyFloat(qtyStr);
    if (tp1 > 0 && sl > 0) {
      const tpSize = (pyTruthy(tp2) && tp2 > 0) ? PP.roundQty(qtyForAtomic * 0.5, qtyStep) : qtyStr;
      if (pyFloat(tpSize) >= qtyStep) {
        atomicTpsl = {
          takeProfit: PP.roundPrice(tp1, tickSize),
          stopLoss: slStr,
          tpslMode: 'Partial',
          tpOrderType: 'Limit',
          tpLimitPrice: PP.roundPrice(tp1, tickSize),
          tpSize,
          slSize: qtyStr,
          tpTriggerBy: 'LastPrice',
          slTriggerBy: 'MarkPrice',
          slOrderType: 'Market',
        };
      }
    }
    const hasAtomic = () => Object.keys(atomicTpsl).length > 0;
    const doPlace = async (positionIdx, atomic = true) => {
      await _getKeyBucket(apiKey).acquire();
      const params = {
        category: 'linear', symbol: bbSymbol, side,
        orderType: isMarket ? 'Market' : 'Limit',
        timeInForce: isMarket ? 'IOC' : 'GTC',
        qty: qtyStr, positionIdx,
      };
      if (!isMarket) params.price = entryStr;
      if (atomic && hasAtomic()) Object.assign(params, atomicTpsl);
      else if (isUnified) { params.stopLoss = slStr; params.slTriggerBy = 'MarkPrice'; }
      if (cidEntry) params.orderLinkId = cidEntry;
      return session.place_order(params);
    };
    let atomicTp1Placed = false;
    try {
      let resp = await doPlace(startIdx, hasAtomic());
      if (hasAtomic() && pyGet(resp, 'retCode') === 10001) {
        const lm = pyStr(pyGet(resp, 'retMsg', '')).toLowerCase();
        if (['takeprofit', 'tpslmode', 'tpsize', 'tplimitprice', 'tporder', 'slorder', 'slsize', 'trigger'].some((k) => lm.includes(k))) {
          log.warning(`[ATOMIC-FALLBACK] ${bbSymbol}: Bybit rejected atomic TP/SL (${pySlice(pyStr(pyGet(resp, 'retMsg', '')), 120)}) — retrying without atomic params (legacy flow)`);
          resp = await doPlace(startIdx, false);
          atomicTpsl = {};
        }
      }
      const retCode = pyGet(resp, 'retCode');
      const retMsgLower = pyStr(pyGet(resp, 'retMsg', '')).toLowerCase();
      const isDupLink = retCode === 110072
        || (retMsgLower.includes('order link') && retMsgLower.includes('exist'))
        || (retMsgLower.includes('orderlinkid') && retMsgLower.includes('duplicat'));
      if (isDupLink && cidEntry) {
        log.info(`Duplicate order rejected by exchange (idempotency works): ${bbSymbol} cid=${cidEntry} — will look up existing order`);
        try {
          await _getKeyBucket(apiKey).acquire();
          const pos = await session.get_positions({ category: 'linear', symbol: bbSymbol });
          const hasPos = pyIter(pyOr(pyGet(pyGet(pos, 'result', {}), 'list', []), []))
            .some((p) => pyFloat(pyOr(pyGet(p, 'size', '0'), '0')) > 0);
          if (hasPos) {
            return {
              ok: true, order_id: cidEntry, qty: qtyStr,
              notional: pyFloat(qtyStr) * entry, balance,
              symbol: bbSymbol, side, leverage: lev,
              pos_idx: startIdx, tp_placed: false,
              order_type: orderType, avg_price: 0.0,
              leverage_downgraded: levDowngraded,
              leverage_requested: lev,
              leverage_applied: levApplied,
              duplicate: true,
            };
          }
        } catch (ve) {
          log.debug(`dup-verify get_positions ${bbSymbol}: ${errStr(asRequestsError(ve))}`);
        }
        return { ok: false, error: 'Ордер уже существует на бирже (idempotency-protected duplicate).' };
      }
      if (retCode === 30228 || retCode === 110074) {
        _markDelisted(bbSymbol);
        return { ok: false, error: humanizeBybitError(pyStr(pyGet(resp, 'retMsg', ''))) };
      }
      if (retCode === 10001 || retCode === 170214) {
        recordSymbolFailure(symbol);
        return { ok: false, error: humanizeBybitError(pyStr(pyGet(resp, 'retMsg', ''))) };
      }
      let usedHedge;
      if (pyGet(resp, 'retCode') === 130125) {
        if (startIdx === 0) {
          _hedgeCapPop();
          _hedgeCacheSet(apiKey, true);
          log.info(`${bbSymbol}: Hedge Mode detected, switching to positionIdx=${hedgeIdx}`);
          resp = await doPlace(hedgeIdx);
          usedHedge = true;
        } else {
          _hedgeCapPop();
          _hedgeCacheSet(apiKey, false);
          log.info(`${bbSymbol}: One-Way Mode detected, switching to positionIdx=0`);
          resp = await doPlace(0);
          usedHedge = false;
        }
      } else {
        usedHedge = startIdx !== 0;
      }
      if (hasAtomic() && pyGet(resp, 'retCode', -1) === 0) atomicTp1Placed = true;

      if (pyGet(resp, 'retCode', -1) === 0) {
        const orderId = pyGet(pyIndex(resp, 'result'), 'orderId', '');
        const qtyF = pyFloat(qtyStr);
        const notionalReal = qtyF * entry;
        const finalPosIdx = usedHedge ? hedgeIdx : 0;
        let tpPlaced;
        if (!wantsTpOrders(tp1, tp2, tp3)) {
          tpPlaced = false;
        } else {
          tpPlaced = await _placeTpOrdersViaSession(session, bbSymbol, side, qtyF, tp1, tp2, tp3, tickSize, qtyStep, finalPosIdx,
            { apiKey, tradeId, userId, skipTp1: atomicTp1Placed });
        }
        let avgPrice = 0.0;
        if (isMarket) {
          try {
            await _getKeyBucket(apiKey).acquire();
            const ap = await session.get_positions({ category: 'linear', symbol: bbSymbol });
            for (const p of pyIter(pyOr(pyGet(pyGet(ap, 'result', {}), 'list', []), []))) {
              if (pyGet(p, 'symbol') === bbSymbol && pyFloat(pyOr(pyGet(p, 'size', '0'), '0')) > 0) {
                avgPrice = pyFloat(pyOr(pyGet(p, 'avgPrice', 0), 0));
                break;
              }
            }
          } catch (ape) {
            log.debug(`avg_price fetch ${bbSymbol}: ${errStr(asRequestsError(ape))}`);
          }
        }
        if (!isUnified) {
          let slPlacedNow = false;
          let slLastErr = '';
          if (tpPlaced) {
            for (let a = 0; a < 3; a++) {
              try {
                await _getKeyBucket(apiKey).acquire();
                const slResp = await session.set_trading_stop({
                  category: 'linear', symbol: bbSymbol, stopLoss: slStr, slTriggerBy: 'MarkPrice', positionIdx: finalPosIdx,
                });
                if (pyGet(slResp, 'retCode', -1) === 0) {
                  slPlacedNow = true;
                  log.info(`${bbSymbol}: CONTRACT SL placed (attempt ${a + 1}/3, no 60s BE-monitor wait)`);
                  break;
                }
                slLastErr = pySlice(pyStr(pyOr(pyGet(slResp, 'retMsg', ''), '')), 150);
                log.warning(`${bbSymbol}: CONTRACT SL attempt ${a + 1}/3 failed: ${slLastErr}`);
              } catch (slE) {
                slLastErr = pySlice(errStr(asRequestsError(slE)), 150);
                log.warning(`${bbSymbol}: CONTRACT SL attempt ${a + 1}/3 exception: ${slLastErr}`);
              }
              if (a < 2) await rt.sleep(0.3 * (2 ** a));
            }
          }
          if (!slPlacedNow) {
            tpPlaced = false;
            log.error(`[SL-RETRY-FAIL] ${bbSymbol}: CONTRACT SL ALL 3 RETRIES FAILED — last_err=${slLastErr} — attempting [SL-SAFETY-CLOSE] to prevent naked exposure`);
            let safetyClosed = false;
            try {
              const closeResp = await _closePositionSync(apiKey, apiSecret, bbSymbol, side, qtyStr, finalPosIdx, demo);
              if (pyTruthy(pyGet(closeResp, 'ok'))) {
                safetyClosed = true;
                log.error(`[SL-SAFETY-CLOSE-OK] ${bbSymbol}: position closed via emergency market order (qty=${qtyStr} side=${side}) — user saved from naked-position window`);
              } else {
                log.error(`[SL-SAFETY-CLOSE-FAIL] ${bbSymbol}: emergency close rejected: ${pyStr(pyGet(closeResp, 'error', 'unknown'))} — BE-monitor takes over`);
              }
            } catch (safetyE) {
              log.error(`[SL-SAFETY-CLOSE-EXC] ${bbSymbol}: emergency close exception: ${errStr(safetyE)} — BE-monitor takes over`);
            }
            if (!safetyClosed) log.error(`[SL-RETRY-FAIL] ${bbSymbol}: trade_anomaly_detector will emit missing_sl alert on next poll (≤60s)`);
          }
        }
        return {
          ok: true,
          order_id: orderId,
          qty: qtyStr,
          notional: notionalReal,
          balance,
          symbol: bbSymbol,
          side,
          leverage: lev,
          pos_idx: finalPosIdx,
          tp_placed: tpPlaced,
          order_type: orderType,
          avg_price: avgPrice,
          leverage_downgraded: levDowngraded,
          leverage_requested: lev,
          leverage_applied: levApplied,
          risk_boosted: riskBoosted,
          risk_requested_pct: expectedPctForUser,
          risk_actual_pct: realRiskPctForUser,
        };
      } else if (pyGet(resp, 'retCode') === 10001 && isUnified) {
        log.warning(`${bbSymbol}: retCode=10001 с stopLoss — retry через 1с (transient check)`);
        await rt.sleep(1.0);
        const respRetry = await doPlace(startIdx);
        if (pyGet(respRetry, 'retCode', -1) === 0) {
          log.info(`${bbSymbol}: retry успех (был transient)`);
          resp = respRetry;
          const usedH = startIdx !== 0;
          const orderId = pyGet(pyIndex(resp, 'result'), 'orderId', '');
          const qtyF = pyFloat(qtyStr);
          const finalPosIdx = usedH ? hedgeIdx : 0;
          const tpPlaced = await _placeTpOrdersViaSession(session, bbSymbol, side, qtyF, tp1, tp2, tp3, tickSize, qtyStep, finalPosIdx,
            { apiKey, tradeId, userId });
          return {
            ok: true, order_id: orderId, qty: qtyStr,
            notional: qtyF * entry, balance,
            symbol: bbSymbol, side, leverage: lev,
            pos_idx: finalPosIdx, tp_placed: tpPlaced,
            order_type: orderType, avg_price: 0.0,
            leverage_downgraded: levDowngraded,
            leverage_requested: lev,
            leverage_applied: levApplied,
          };
        }
        log.warning(`${bbSymbol}: retCode=10001 повторился — кэшируем как CONTRACT, SL через BE-монитор`);
        isUnified = false;
        _cacheAccountType(apiKey, 'CONTRACT');
        const doPlaceNoSl = async (positionIdx) => {
          await _getKeyBucket(apiKey).acquire();
          const p = {
            category: 'linear', symbol: bbSymbol, side,
            orderType: isMarket ? 'Market' : 'Limit',
            timeInForce: isMarket ? 'IOC' : 'GTC',
            qty: qtyStr, positionIdx,
          };
          if (!isMarket) p.price = entryStr;
          return session.place_order(p);
        };
        let resp2 = await doPlaceNoSl(startIdx);
        if (pyGet(resp2, 'retCode') === 130125) {
          const newIdx = startIdx === 0 ? hedgeIdx : 0;
          _hedgeCapPop();
          _hedgeCacheSet(apiKey, startIdx === 0);
          resp2 = await doPlaceNoSl(newIdx);
        }
        if (pyGet(resp2, 'retCode', -1) === 0) {
          const orderId = pyGet(pyIndex(resp2, 'result'), 'orderId', '');
          const qtyF = pyFloat(qtyStr);
          const finalPosIdx = (startIdx === 0 && pyGet(resp2, 'retCode') !== 130125) ? hedgeIdx : 0;
          log.warning(`⚠️ ${bbSymbol}: CONTRACT account — SL ОТЛОЖЕН на BE-монитор. Между fill и SL placement возможен gap 5-30с (риск flash crash). Рекомендуем переключить API ключ на UNIFIED.`);
          return {
            ok: true, order_id: orderId, qty: qtyStr,
            notional: qtyF * entry, balance,
            symbol: bbSymbol, side, leverage: lev,
            pos_idx: finalPosIdx, tp_placed: false,
            order_type: orderType, avg_price: 0.0,
            leverage_downgraded: levDowngraded,
            leverage_requested: lev,
            leverage_applied: levApplied,
            sl_pending: true,
            warning: 'SL placement отложен (CONTRACT account)',
          };
        }
        return { ok: false, error: pyGet(resp2, 'retMsg', pyGet(resp, 'retMsg', 'Ошибка Bybit')) };
      } else {
        return { ok: false, error: pyGet(resp, 'retMsg', 'Неизвестная ошибка Bybit') };
      }
    } catch (e0) {
      const e = asRequestsError(e0);
      const es = errStr(e);
      if (es.includes('30228') || es.includes('110074')) {
        try { _markDelisted(toBybitSymbol(symbol)); } catch (_x) { log.error('bybit_trader._do_place_no_sl() unhandled exception'); }
        log.warning(`place_order ${symbol}: delisted (cached) — ${pySlice(es, 120)}`);
        return { ok: false, error: humanizeBybitError(es) };
      }
      log.error(`place_order ${symbol}: ${es}`);
      return { ok: false, error: es };
    }
  }

  async function _placeTradeSplitSync(apiKey, apiSecret, symbol, direction, entryLo, entryHi, sl, tp1, riskPct, leverage, o = {}) {
    let { tp2 = 0.0, tp3 = 0.0 } = o;
    const { demo = false } = o;
    const session = _getSession(apiKey, apiSecret, demo);
    const bbSymbol = toBybitSymbol(symbol);
    const side = direction === 'LONG' ? 'Buy' : 'Sell';
    const lev = Math.min(Math.max(1, leverage), MAX_LEVERAGE);
    const pmult = bybitPriceMultiplier(symbol);
    if (pmult !== 1.0) {
      entryLo *= pmult;
      entryHi *= pmult;
      sl *= pmult;
      tp1 *= pmult;
      if (pyTruthy(tp2)) tp2 *= pmult;
      if (pyTruthy(tp3)) tp3 *= pmult;
      log.debug(`Bybit 1000x price correction ${symbol}: ×${fmtFixed(pmult, 0)}`);
    }
    try {
      await _getKeyBucket(apiKey).acquire();
      await session.switch_margin_mode({ category: 'linear', symbol: bbSymbol, tradeMode: 1 });
    } catch (mmErr) {
      const s = errStr(asRequestsError(mmErr));
      if (!s.includes('110026')) log.debug(`switch_margin_mode split ${bbSymbol}: ${s}`);
    }
    const levSet = await _trySetLeverage(session, bbSymbol, lev, apiKey);
    if (!pyTruthy(pyGet(levSet, 'ok'))) return { ok: false, error: levSet.error };
    const levDowngraded = pyTruthy(pyGet(levSet, 'downgraded_to'));
    const levApplied = pyInt(pyOr(pyGet(levSet, 'downgraded_to'), lev));
    const balance = await _getBalanceSync(apiKey, apiSecret, demo);
    if (balance < 1.0) {
      return { ok: false, error: `Недостаточно средств: $${fmtFixed(balance, 2)} USDT\nПополни счёт и попробуй снова.` };
    }
    const entryMid = (entryLo + entryHi) / 2;
    const priceDiff = Math.abs(entryMid - sl);
    if (priceDiff <= 0) return { ok: false, error: 'Некорректные entry/SL' };
    const riskAmount = balance * (riskPct / 100.0);
    let qtyRaw = riskAmount / priceDiff;
    let notional = qtyRaw * entryMid;
    if (notional < MIN_NOTIONAL) {
      qtyRaw = MIN_NOTIONAL / entryMid;
      notional = MIN_NOTIONAL;
    }
    const [qtyStep, tickSize] = await _getInstrumentFilters(session, bbSymbol, apiKey);
    const halfQtyF = qtyRaw / 2.0;
    const halfQty = PP.roundQty(halfQtyF, qtyStep);
    const slDistPct = entryMid > 0 ? priceDiff / entryMid * 100 : 999.0;
    const feePct = TAKER_FEE * 2 * 100;
    if (pyFloat(halfQty) <= 0 || (halfQtyF > 0 && halfQtyF < qtyStep / 2)) {
      if (slDistPct < feePct * 2) {
        const minSlPct = feePct * 3;
        return {
          ok: false,
          error: `❌ Стоп слишком близко: ${fmtFixed(slDistPct, 3)}% от входа.\n`
            + `Комиссия round-trip: ${fmtFixed(feePct, 3)}% — объём уходит в ноль.\n\n`
            + `▸ Увеличь risk (сейчас ${pyFloatStr(riskPct)}%) до ${fmtFixed(riskPct * 2, 1)}%\n`
            + `▸ Расширь SL до ≥${fmtFixed(minSlPct, 2)}% от входа`,
        };
      }
      return {
        ok: false,
        error: `Размер позиции слишком мал ($${fmtFixed(notional, 2)}). `
          + `Нужен депозит от $${fmtFixed(pyDiv(MIN_NOTIONAL, riskPct / 100), 0)} `
          + `при риске ${pyFloatStr(riskPct)}%. Мин. лот: ${pyFloatStr(qtyStep)}.`,
      };
    }
    const realNotional = pyFloat(halfQty) * 2 * entryMid;
    const initialMargin = realNotional / levApplied;
    const feeCost = realNotional * MAKER_FEE * 2;
    const marginRequired = initialMargin + feeCost;
    if (marginRequired > balance * 0.85) {
      return {
        ok: false,
        error: 'Недостаточно маржи для открытия позиции.\n'
          + `Требуется: $${fmtFixed(marginRequired, 2)} USDT `
          + `(маржа $${fmtFixed(initialMargin, 2)} + комиссия ~$${fmtFixed(feeCost, 2)})\n`
          + `Доступно:  $${fmtFixed(balance, 2)} USDT\n`
          + `Уменьши риск (сейчас ${pyFloatStr(riskPct)}%) или пополни счёт.`,
      };
    }
    let available;
    try {
      available = await _getAvailableMarginSync(apiKey, apiSecret, demo);
    } catch (amE) {
      log.warning(`[MARGIN-PRECHECK] split sym=${bbSymbol}: could not fetch available margin: ${errStr(asRequestsError(amE))} — skipping pre-check, proceeding to placement`);
      available = null;
    }
    if (available !== null) {
      const totalRequired = (pyFloat(halfQty) * 2 * entryMid) / Math.max(1, lev) * 1.05;
      const reqDisp = pyRound(totalRequired, 2);
      const availDisp = pyRound(available, 2);
      if (reqDisp > availDisp) {
        log.warning(`[MARGIN-PRECHECK] split ${bbSymbol} insufficient: required=${fmtFixed(reqDisp, 2)} available=${fmtFixed(availDisp, 2)} (leverage=${lev}x, qty=${halfQty}+${halfQty}) — fail-fast instead of opaque 'Не удалось выставить ни один из сплит-ордеров'`);
        return {
          ok: false,
          error: '❌ Недостаточно свободной маржи для split-входа\n\n'
            + `Нужно: $${fmtFixed(reqDisp, 2)}\n`
            + `Доступно: $${fmtFixed(availDisp, 2)}\n\n`
            + '▸ Закрой часть открытых позиций\n'
            + `▸ Уменьши leverage (сейчас ×${lev})\n`
            + `▸ Уменьши risk (сейчас ${pyFloatStr(riskPct)}%)`,
          insufficient_margin: true,
        };
      }
    }
    const slStr = PP.roundPrice(sl, tickSize);
    const loStr = PP.roundPrice(entryLo, tickSize);
    const hiStr = PP.roundPrice(entryHi, tickSize);
    const hedgeIdx = side === 'Buy' ? 1 : 2;
    const startIdx = _initialPosIdx(apiKey, side);
    const isUnifiedSplit = (st.accountTypeCache.has(apiKey) ? st.accountTypeCache.get(apiKey) : 'UNIFIED') === 'UNIFIED';
    const doPlaceAt = async (priceStr, positionIdx) => {
      await _getKeyBucket(apiKey).acquire();
      const params = {
        category: 'linear', symbol: bbSymbol, side, orderType: 'Limit', price: priceStr,
        timeInForce: 'GTC', qty: halfQty, positionIdx,
      };
      if (isUnifiedSplit) { params.stopLoss = slStr; params.slTriggerBy = 'MarkPrice'; }
      return session.place_order(params);
    };
    const placeWithModeDetect = async (priceStr, curStart) => {
      let resp = await doPlaceAt(priceStr, curStart);
      if (pyGet(resp, 'retCode') === 130125) {
        let newIdx;
        if (curStart === 0) {
          _hedgeCapPop();
          _hedgeCacheSet(apiKey, true);
          newIdx = hedgeIdx;
          log.info(`${bbSymbol}: Hedge Mode detected, switching to positionIdx=${newIdx}`);
        } else {
          _hedgeCapPop();
          _hedgeCacheSet(apiKey, false);
          newIdx = 0;
          log.info(`${bbSymbol}: One-Way Mode detected, switching to positionIdx=0`);
        }
        resp = await doPlaceAt(priceStr, newIdx);
        return [resp, newIdx];
      }
      return [resp, curStart];
    };
    let orderIdLo = '';
    let orderIdHi = '';
    let anyOk = false;
    let posIdx = startIdx;
    try {
      const [resp, pi] = await placeWithModeDetect(loStr, startIdx);
      posIdx = pi;
      if (pyGet(resp, 'retCode', -1) === 0) { orderIdLo = pyGet(pyIndex(resp, 'result'), 'orderId', ''); anyOk = true; } else {
        log.warning(`split entry_lo ${bbSymbol}: retCode=${pyStr(pyGet(resp, 'retCode'))} ${pyStr(pyGet(resp, 'retMsg', ''))}`);
      }
    } catch (e) {
      log.warning(`split entry_lo ${bbSymbol}: ${errStr(asRequestsError(e))}`);
    }
    try {
      const [resp, pi] = await placeWithModeDetect(hiStr, posIdx);
      posIdx = pi;
      if (pyGet(resp, 'retCode', -1) === 0) { orderIdHi = pyGet(pyIndex(resp, 'result'), 'orderId', ''); anyOk = true; } else {
        log.warning(`split entry_hi ${bbSymbol}: retCode=${pyStr(pyGet(resp, 'retCode'))} ${pyStr(pyGet(resp, 'retMsg', ''))}`);
      }
    } catch (e) {
      log.warning(`split entry_hi ${bbSymbol}: ${errStr(asRequestsError(e))}`);
    }
    if (!anyOk) return { ok: false, error: 'Не удалось выставить ни один из сплит-ордеров' };
    const fullQtyF = pyFloat(halfQty) * 2;
    const finalPosIdx = posIdx;
    const tpPlaced = await _placeTpOrdersViaSession(session, bbSymbol, side, fullQtyF, tp1, tp2, tp3, tickSize, qtyStep, finalPosIdx, { apiKey });
    const combined = [orderIdLo, orderIdHi].filter((x) => pyTruthy(x)).join(',');
    return {
      ok: true,
      order_id: combined,
      order_id_lo: orderIdLo,
      order_id_hi: orderIdHi,
      qty: fmtFixed(pyFloat(halfQty) * 2, PP.stepDecimals(qtyStep)),
      notional: pyFloat(halfQty) * 2 * entryMid,
      balance,
      symbol: bbSymbol,
      side,
      leverage: lev,
      pos_idx: finalPosIdx,
      tp_placed: tpPlaced,
      leverage_downgraded: levDowngraded,
      leverage_requested: lev,
      leverage_applied: levApplied,
      entry_lo: entryLo,
      entry_hi: entryHi,
    };
  }

  async function _warmHedgeCache(apiKey) {
    if (_hedgeCacheGet(apiKey) === null) {
      const raw = await rt.kv.get(`bybit_mode:${apiKeyHash(apiKey)}`);
      const stored = raw === null || raw === undefined ? null : Boolean(parseInt(raw, 10));
      if (stored !== null) {
        _hedgeCapPop();
        _hedgeCacheSet(apiKey, stored);
      }
    }
  }

  async function _saveHedgeMode(apiKey, isHedge) {
    await rt.kv.set(`bybit_mode:${apiKeyHash(apiKey)}`, isHedge ? '1' : '0');
  }

  async function placeTradeSplit(apiKey, apiSecret, symbol, direction, entryLo, entryHi, sl, tp1, riskPct, leverage = 10, o = {}) {
    const { tp2 = 0.0, tp3 = 0.0, demo = false, userId = 0 } = o;
    const t0 = rt.monotonic();
    const ks = await killswitchGate(rt, 'bybit_trader.place_trade_split');
    if (ks) return ks;
    const deny = await planGateDeny(rt, userId, symbol, 'bybit_split');
    if (deny) return deny;
    await _warmHedgeCache(apiKey);
    const before = st.hedgeModeCache.has(apiKey) ? st.hedgeModeCache.get(apiKey) : null;
    const result = await _placeTradeSplitSync(apiKey, apiSecret, symbol, direction, entryLo, entryHi, sl, tp1, riskPct, leverage, { tp2, tp3, demo });
    const after = st.hedgeModeCache.has(apiKey) ? st.hedgeModeCache.get(apiKey) : null;
    if (after !== null && after !== before) await _saveHedgeMode(apiKey, after);
    if (pyTruthy(pyGet(result, 'ok')) && pyTruthy(pyGet(result, 'order_id'))) {
      await recordPlaced(rt, { symbol, direction, exchange: 'bybit_split', t0, tpPlaced: pyTruthy(pyGet(result, 'tp_placed')) });
    }
    return result;
  }

  async function placeTrade(apiKey, apiSecret, symbol, direction, entry, sl, tp1, riskPct, leverage = 10, o = {}) {
    const {
      tp2 = 0.0, tp3 = 0.0, riskMode = 'risk', demo = false, orderType = 'Limit', tradeId = '', userId = 0,
      allowLowNotionalBoost = false,
    } = o;
    const t0 = rt.monotonic();
    const ks = await killswitchGate(rt, 'bybit_trader.place_trade');
    if (ks) return ks;
    const deny = await planGateDeny(rt, userId, symbol, 'bybit');
    if (deny) return deny;
    try {
      return await _placeTradeBody(apiKey, apiSecret, symbol, direction, entry, sl, tp1, riskPct, leverage, {
        tp2, tp3, riskMode, demo, orderType, tradeId, userId, allowLowNotionalBoost, t0,
      });
    } catch (e) {
      // `except asyncio.TimeoutError` around the whole body (aiohttp-side timeouts only)
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, error: 'Таймаут соединения с биржей. Попробуйте позже.' };
      throw e;
    }
  }

  async function _placeTradeBody(apiKey, apiSecret, symbol, direction, entry, sl, tp1, riskPct, leverage, o) {
    const { tp2, tp3, riskMode, demo, orderType, tradeId, userId, allowLowNotionalBoost, t0 } = o;
    await _warmHedgeCache(apiKey);
    await _getTimestamp();
    const before = st.hedgeModeCache.has(apiKey) ? st.hedgeModeCache.get(apiKey) : null;
    let result;
    let lastExc = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        result = await _placeTradeSync(apiKey, apiSecret, symbol, direction, entry, sl, tp1, riskPct, leverage, {
          tp2, tp3, riskMode, demo, orderType, tradeId, userId, allowLowNotionalBoost,
        });
        lastExc = null;
        break;
      } catch (e0) {
        const e = asRequestsError(e0);
        lastExc = e;
        const es = errStr(e).toLowerCase();
        if (attempt === 0 && (es.includes('retryable') || es.includes('10002') || es.includes('494'))) {
          // quirk: the bot assigns a *local* `_bybit_time_synced_at = 0.0` here, so this
          // resync is a no-op unless the last sync is older than 10 s.
          await _getTimestamp();
          log.debug(`place_trade: timestamp error ${pySlice(errStr(e), 80)} — resync and retry`);
          continue;
        }
        throw e;
      }
    }
    if (lastExc !== null) throw lastExc;
    const after = st.hedgeModeCache.has(apiKey) ? st.hedgeModeCache.get(apiKey) : null;
    if (after !== null && after !== before) await _saveHedgeMode(apiKey, after);
    if (tradeId) {
      try {
        rt.events.emit(tradeId, 'sl_attempt', { exchange: 'bybit', sl_price: sl, atomic: true });
        rt.events.emit(tradeId, 'sl_response', {
          exchange: 'bybit',
          ok: pyTruthy(pyGet(result, 'ok')) && pyTruthy(pyGet(result, 'tp_placed')),
          order_id: pyGet(result, 'order_id', ''),
          error: pySlice(pyStr(pyGet(result, 'error', '')), 200),
        });
      } catch (e) { log.debug(`emit bybit SL events: ${errStr(e)}`); }
    }
    if (!pyTruthy(pyGet(result, 'ok'))) {
      const err = pyStr(pyGet(result, 'error', ''));
      if (['10003', '10004'].some((c) => err.includes(c))) {
        log.warning(`Bybit auth error for key (uid unknown): ${err} — auto_trade будет сброшен`);
        try {
          const uids = await rt.onAuthReset('bybit', apiKey);
          for (const uid of uids || []) log.warning(`[BYBIT-AUTH-RESET] uid=${uid} auto_trade=0 (invalid API key)`);
        } catch (e) { log.warning(`reset auto_trade by key failed: ${errStr(e)}`); }
      }
    }
    if (pyTruthy(pyGet(result, 'ok')) && pyTruthy(pyGet(result, 'order_id'))) {
      await recordPlaced(rt, { symbol, direction, exchange: 'bybit', t0, tpPlaced: pyTruthy(pyGet(result, 'tp_placed')) });
    }
    return result;
  }

  // ── breakeven / trailing ──
  async function setBreakeven(apiKey, apiSecret, symbol, entry, direction, posIdx = 0, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    try {
      const [, tickSize] = await _getInstrumentFilters(session, bb, apiKey);
      await _getKeyBucket(apiKey).acquire();
      const pmult = bybitPriceMultiplier(symbol);
      const resp = await session.set_trading_stop({
        category: 'linear', symbol: bb, stopLoss: PP.roundPrice(entry * pmult, tickSize), slTriggerBy: 'MarkPrice', positionIdx: posIdx,
      });
      if (pyGet(resp, 'retCode', -1) === 0) return { ok: true };
      return { ok: false, error: pyGet(resp, 'retMsg', 'BE error') };
    } catch (e0) {
      const e = asRequestsError(e0);
      log.error(`set_breakeven ${symbol}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function setTrailingSl(apiKey, apiSecret, symbol, newSl, direction, posIdx = 0, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    try {
      const [, tickSize] = await _getInstrumentFilters(session, bb, apiKey);
      const pmult = bybitPriceMultiplier(symbol);
      try {
        await _getKeyBucket(apiKey).acquire();
        const ticker = await session.get_tickers({ category: 'linear', symbol: bb });
        const lst = pyGet(pyGet(ticker, 'result', {}), 'list', [{}]);
        const markRaw = pyFloat(pyOr(pyGet(pyIndex(lst, 0), 'markPrice', 0), 0));
        const mark = (markRaw > 0 && pyTruthy(pmult) && pmult !== 1.0) ? markRaw / pmult : markRaw;
        if (mark > 0) {
          const d = String(direction || '').toUpperCase();
          if (d === 'LONG' && newSl >= mark) return { ok: false, error: `new_sl ${pyFloatStr(newSl)} >= mark ${pyFloatStr(mark)} for LONG (would trigger immediate)` };
          if (d === 'SHORT' && newSl <= mark) return { ok: false, error: `new_sl ${pyFloatStr(newSl)} <= mark ${pyFloatStr(mark)} for SHORT (would trigger immediate)` };
        }
      } catch (vt) {
        log.debug(`set_trailing_sl pre-check ${bb}: ${errStr(asRequestsError(vt))}`);
      }
      let lastErr = '';
      for (let a = 0; a < 3; a++) {
        await _getKeyBucket(apiKey).acquire();
        let resp;
        try {
          resp = await session.set_trading_stop({
            category: 'linear', symbol: bb, stopLoss: PP.roundPrice(newSl * pmult, tickSize), slTriggerBy: 'MarkPrice', positionIdx: posIdx,
          });
        } catch (pe0) {
          const pe = asRequestsError(pe0);
          if (!(pe instanceof InvalidRequestError)) throw pe;
          const es = pe.message;
          const code = pe.status_code;
          if (es.includes('34040') || code === 34040) {
            log.debug(`set_trailing_sl ${bb}: already at target (34040 not modified)`);
            return { ok: true, already_at_target: true };
          }
          lastErr = es;
          if ((es.includes('110010') || code === 110010) && a < 2) {
            try {
              await _getKeyBucket(apiKey).acquire();
              const t2 = await session.get_tickers({ category: 'linear', symbol: bb });
              const m2Raw = pyFloat(pyOr(pyGet(pyIndex(pyGet(pyGet(t2, 'result', {}), 'list', [{}]), 0), 'markPrice', 0), 0));
              const m2 = (pyTruthy(pmult) && pmult !== 1.0) ? m2Raw / pmult : m2Raw;
              if (m2 > 0) {
                const d = String(direction || '').toUpperCase();
                if (d === 'LONG' && newSl >= m2) return { ok: false, error: `new_sl ${pyFloatStr(newSl)} >= re-fetched mark ${pyFloatStr(m2)} for LONG (price moved, abort retry)` };
                if (d === 'SHORT' && newSl <= m2) return { ok: false, error: `new_sl ${pyFloatStr(newSl)} <= re-fetched mark ${pyFloatStr(m2)} for SHORT (price moved, abort retry)` };
              }
            } catch (rf) {
              log.debug(`110010-retry mark re-fetch ${bb}: ${errStr(asRequestsError(rf))}`);
            }
            log.warning(`set_trailing_sl ${bb} 110010 attempt ${a + 1}/3 — retry after mark re-fetch`);
            await rt.sleep(0.2 * (2 ** a));
            continue;
          }
          log.warning(`set_trailing_sl ${bb} InvalidRequestError: ${pySlice(es, 200)}`);
          return { ok: false, error: es };
        }
        if (pyGet(resp, 'retCode', -1) === 0) {
          if (a > 0) log.info(`set_trailing_sl ${bb}: success on attempt ${a + 1}/3`);
          return { ok: true };
        }
        if (pyGet(resp, 'retCode') === 34040) {
          log.debug(`set_trailing_sl ${bb}: already at target (retCode=34040)`);
          return { ok: true, already_at_target: true };
        }
        return { ok: false, error: pyOr(pyGet(resp, 'retMsg', 'Trail SL error'), '') };
      }
      return { ok: false, error: `110010 after 3 retries: ${pySlice(lastErr, 200)}` };
    } catch (e0) {
      const e = asRequestsError(e0);
      const es = errStr(e);
      if (es.includes('34040') || es.toLowerCase().includes('not modified')) {
        log.debug(`set_trailing_sl ${bb}: already at target (benign: ${pySlice(es, 80)})`);
        return { ok: true, already_at_target: true };
      }
      log.error(`set_trailing_sl ${symbol}: ${es}`);
      return { ok: false, error: es };
    }
  }

  // ── positions / orders ──
  async function getPositions(apiKey, apiSecret, symbol = '', demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    try {
      const kwargs = { category: 'linear', settleCoin: 'USDT' };
      if (symbol) kwargs.symbol = toBybitSymbol(symbol);
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_positions(kwargs);
      if (pyGet(resp, 'retCode', -1) === 0) return pyGet(pyIndex(resp, 'result'), 'list', []);
    } catch (e) {
      log.debug(`get_positions: ${errStr(asRequestsError(e))}`);
    }
    return [];
  }

  async function _cancelAllOrdersSync(apiKey, apiSecret, symbol, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.cancel_all_orders({ category: 'linear', symbol: bb });
      if (pyGet(resp, 'retCode', -1) === 0) return { ok: true, cancelled: pyLen(pyGet(pyGet(resp, 'result', {}), 'list', [])) };
      return { ok: false, error: pyGet(resp, 'retMsg', 'cancel error') };
    } catch (e0) {
      const e = asRequestsError(e0);
      log.debug(`cancel_all_orders ${symbol}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function cancelAllOrders(apiKey, apiSecret, symbol, demo = false) {
    const _do = () => _cancelAllOrdersSync(apiKey, apiSecret, symbol, demo);
    return callWithRetry(_do, { maxAttempts: 3, baseBackoff: 0.3, opName: `bybit_cancel_all_${symbol}`, sleep: rt.sleep, random: rt.random, log });
  }

  async function getClosedPnl(apiKey, apiSecret, symbol, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_closed_pnl({ category: 'linear', symbol: bb, limit: 10 });
      const retCode = pyGet(resp, 'retCode', -1);
      if (retCode === 0) {
        const lst = pyGet(pyIndex(resp, 'result'), 'list', []);
        if (!pyTruthy(lst)) log.info(`[GET-CLOSED-PNL-EMPTY] sym=${symbol} bb=${bb} retCode=0 list=[] (API ok но records отсутствуют — может delay либо filter mismatch)`);
        return lst;
      }
      log.warning(`[GET-CLOSED-PNL-FAIL] sym=${symbol} bb=${bb} retCode=${pyStr(retCode)} retMsg=${pySlice(pyStr(pyOr(pyGet(resp, 'retMsg', ''), '')), 200)}`);
    } catch (e0) {
      const e = asRequestsError(e0);
      log.warning(`[GET-CLOSED-PNL-EXC] sym=${symbol} bb=${bb} exc_type=${e.pyType || e.name} err=${pySlice(errStr(e), 300)}`);
    }
    return [];
  }

  async function getAllClosedPnl(apiKey, apiSecret, limit = 50, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_closed_pnl({ category: 'linear', limit: pyInt(limit) });
      if (pyGet(resp, 'retCode', -1) === 0) return pyOr(pyGet(pyIndex(resp, 'result'), 'list', []), []);
    } catch (e) {
      log.debug(`get_all_closed_pnl: ${errStr(asRequestsError(e))}`);
    }
    return [];
  }

  async function getOpenOrders(apiKey, apiSecret, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_open_orders({ category: 'linear', settleCoin: 'USDT', limit: 50 });
      if (pyGet(resp, 'retCode', -1) === 0) return pyGet(pyIndex(resp, 'result'), 'list', []);
    } catch (e) {
      log.debug(`get_open_orders: ${errStr(asRequestsError(e))}`);
    }
    return [];
  }

  async function cancelOrder(apiKey, apiSecret, symbol, orderId, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.cancel_order({ category: 'linear', symbol: bb, orderId });
      if (pyGet(resp, 'retCode', -1) === 0) return { ok: true };
      const retCode = pyGet(resp, 'retCode', -1);
      const retMsg = pyGet(resp, 'retMsg', 'cancel error');
      if (retCode === 110001) log.debug(`cancel_order ${symbol} ${orderId}: already gone (${pyStr(retMsg)})`);
      else log.warning(`cancel_order ${symbol} ${orderId}: ${pyStr(retMsg)} (code=${pyStr(retCode)})`);
      return { ok: false, error: retMsg };
    } catch (e0) {
      const e = asRequestsError(e0);
      const es = errStr(e);
      if (es.includes('110001')) log.debug(`cancel_order ${symbol} ${orderId}: already gone (${es})`);
      else log.error(`cancel_order ${symbol} ${orderId}: ${es}`);
      return { ok: false, error: es };
    }
  }

  async function _closePositionSync(apiKey, apiSecret, symbol, side, size, posIdx = 0, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    const s = pyStr(side).trim().toUpperCase();
    let closeSide;
    if (s === 'LONG' || s === 'BUY') closeSide = 'Sell';
    else if (s === 'SHORT' || s === 'SELL') closeSide = 'Buy';
    else {
      log.error(`close_position ${symbol}: unknown side=${pyRepr(side)}`);
      return { ok: false, error: `unknown side: ${pyRepr(side)}` };
    }
    let roundedQty = pyStr(size);
    try {
      const [qtyStep] = await _getInstrumentFilters(session, bb, apiKey);
      if (pyTruthy(qtyStep) && qtyStep > 0) {
        const q = tryFloat(size, 0.0);
        if (q > 0) {
          roundedQty = PP.roundQty(q, qtyStep);
          if (pyFloat(roundedQty) <= 0) {
            log.warning(`close_position ${symbol}: qty=${pyStr(size)} rounded to 0 (step=${pyFloatStr(qtyStep)}) — skip (position smaller than minimum lot)`);
            return { ok: false, error: 'qty rounded to 0 (below lot step)', skipped: true };
          }
          if (roundedQty !== pyStr(size)) log.debug(`close_position ${symbol}: qty rounded ${pyStr(size)} → ${roundedQty} (step=${pyFloatStr(qtyStep)})`);
        }
      }
    } catch (eRound) {
      log.debug(`close_position ${symbol}: qty rounding failed (${errStr(eRound)}) — sending raw ${pyStr(size)}`);
    }
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.place_order({
        category: 'linear', symbol: bb, side: closeSide, orderType: 'Market', qty: roundedQty, reduceOnly: true, positionIdx: posIdx,
      });
      if (pyGet(resp, 'retCode', -1) === 0) return { ok: true, order_id: pyGet(pyIndex(resp, 'result'), 'orderId', '') };
      const retCode = pyGet(resp, 'retCode', -1);
      const retMsg = pyOr(pyGet(resp, 'retMsg', 'close error'), '');
      if (retCode === 10001 && pyStr(retMsg).toLowerCase().includes('qty invalid')) {
        log.warning(`close_position ${symbol}: ${pyStr(retMsg)} (code=${pyStr(retCode)}) — позиция вероятно уже закрыта (race)`);
        return { ok: false, error: retMsg, benign: true };
      }
      return { ok: false, error: retMsg };
    } catch (e0) {
      const e = asRequestsError(e0);
      const es = errStr(e);
      if (es.includes('10001') && es.toLowerCase().includes('qty invalid')) {
        log.warning(`close_position ${symbol}: qty=${roundedQty} rejected (10001 Qty invalid) — позиция вероятно уже закрыта (race)`);
        return { ok: false, error: es, benign: true };
      }
      log.error(`close_position ${symbol}: ${es}`);
      return { ok: false, error: es };
    }
  }

  async function closePosition(apiKey, apiSecret, symbol, side, size, posIdx = 0, demo = false) {
    return _closePositionSync(apiKey, apiSecret, symbol, side, size, posIdx, demo);
  }

  async function _summaryInto(session, apiKey, result, { reraiseIfNoPositions = null } = {}) {
    try {
      const resp = await _getWalletBalanceResp(session, apiKey);
      if (pyGet(resp, 'retCode', -1) === 0) {
        const acct = pyIndex(pyIndex(pyIndex(resp, 'result'), 'list'), 0);
        result.equity = pyFloat(pyOr(pyGet(acct, 'totalEquity'), 0));
        result.wallet_balance = pyFloat(pyOr(pyGet(acct, 'totalWalletBalance'), 0));
        result.unrealized_pnl = pyFloat(pyOr(pyGet(acct, 'totalUnrealisedPnl'), 0));
        for (const coin of pyIter(pyGet(acct, 'coin', []))) {
          if (pyIndex(coin, 'coin') === 'USDT') result.available = pyFloat(pyOr(pyGet(coin, 'availableToWithdraw'), pyGet(coin, 'availableBalance'), 0));
        }
      }
    } catch (e0) {
      const e = asRequestsError(e0);
      if (reraiseIfNoPositions !== null) {
        if (!reraiseIfNoPositions.length) throw e;
        log.warning(`dashboard wallet balance failed (showing positions without balance): ${errStr(e)}`);
      } else {
        log.debug(`account_summary wallet: ${errStr(e)}`);
      }
    }
    try {
      const startTs = Math.trunc((rt.now() - 86400) * 1000);
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_closed_pnl({ category: 'linear', startTime: startTs, limit: 50 });
      if (pyGet(resp, 'retCode', -1) === 0) {
        const records = pyGet(pyIndex(resp, 'result'), 'list', []);
        result.trades_24h = pyLen(records);
        for (const r of pyIter(records)) {
          const pnl = pyFloat(pyGet(r, 'closedPnl', 0));
          result.closed_pnl_24h += pnl;
          if (pnl > 0) result.wins_24h += 1;
        }
      }
    } catch (e) {
      log.debug(`${reraiseIfNoPositions !== null ? 'dashboard' : 'account_summary'} 24h: ${errStr(asRequestsError(e))}`);
    }
  }

  async function getAccountSummary(apiKey, apiSecret, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const result = {
      equity: 0.0, wallet_balance: 0.0, unrealized_pnl: 0.0, available: 0.0,
      closed_pnl_24h: 0.0, trades_24h: 0, wins_24h: 0,
    };
    await _summaryInto(session, apiKey, result);
    return result;
  }

  async function getDashboard(apiKey, apiSecret, demo = false) {
    await _getTimestamp();
    const session = _getSession(apiKey, apiSecret, demo);
    let positions = [];
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_positions({ category: 'linear', settleCoin: 'USDT' });
      if (pyGet(resp, 'retCode', -1) === 0) positions = pyIter(pyGet(pyIndex(resp, 'result'), 'list', [])).filter((p) => pyFloat(pyGet(p, 'size', 0)) > 0);
    } catch (e) {
      log.debug(`dashboard positions: ${errStr(asRequestsError(e))}`);
    }
    let orders = [];
    try {
      await _getKeyBucket(apiKey).acquire();
      const resp = await session.get_open_orders({ category: 'linear', settleCoin: 'USDT', limit: 50 });
      if (pyGet(resp, 'retCode', -1) === 0) orders = pyGet(pyIndex(resp, 'result'), 'list', []);
    } catch (e) {
      log.debug(`dashboard orders: ${errStr(asRequestsError(e))}`);
    }
    const summary = {
      equity: 0.0, wallet_balance: 0.0, unrealized_pnl: 0.0, available: 0.0,
      closed_pnl_24h: 0.0, trades_24h: 0, wins_24h: 0,
    };
    await _summaryInto(session, apiKey, summary, { reraiseIfNoPositions: positions });
    return [positions, orders, summary];
  }

  async function getExecutionExitPrice(apiKey, apiSecret, symbol, createdMs, demo = false) {
    const session = _getSession(apiKey, apiSecret, demo);
    const bb = toBybitSymbol(symbol);
    try {
      const resp = await session.get_executions({ category: 'linear', symbol: bb, limit: 50 });
      if (pyGet(resp, 'retCode', -1) !== 0) return null;
      const items = pyGet(pyGet(resp, 'result', {}), 'list', []);
      const prices = [];
      const qtys = [];
      for (const ex of pyIter(items)) {
        if (pyFloat(pyGet(ex, 'execTime', 0)) < createdMs) continue;
        const closedSize = pyFloat(pyOr(pyGet(ex, 'closedSize'), 0));
        if (closedSize <= 0) continue;
        const price = pyFloat(pyOr(pyGet(ex, 'execPrice'), 0));
        if (price > 0) { prices.push(price); qtys.push(closedSize); }
      }
      if (!prices.length) return null;
      const totalQty = pySum(qtys);
      if (totalQty <= 0) return null;
      const vwap = pySum(prices.map((p, i) => p * qtys[i])) / totalQty;
      return pyRound(vwap, 8);
    } catch (e) {
      log.debug(`get_execution_exit_price ${symbol}: ${errStr(asRequestsError(e))}`);
      return null;
    }
  }

  return {
    rt, _state: st,
    // public API (names follow the bot, camelCased)
    placeTrade, placeTradeSplit, placeTpOrders, setBreakeven, setTrailingSl, getPositions, cancelAllOrders,
    getClosedPnl, getAllClosedPnl, getOpenOrders, cancelOrder, closePosition, getAccountSummary, getDashboard,
    getExecutionExitPrice, getBalance, getLastPrice, getSpreadPct, getFundingRate, testConnection, syncTime,
    isSymbolDelisted, isDelisted, recordSymbolFailure, recordSymbolSuccess, invalidatePybitSession, closeAllPybitSessions,
    // internals (parity tests)
    _getTimestamp, _getInstrumentFilters, _trySetLeverage, _getWalletBalanceResp, _getBalanceSync, _getAvailableMarginSync,
    _placeTradeSync, _placeTradeSplitSync, _placeTpOrdersViaSession, _getCurrentPositionSize, _closePositionSync,
    _getSession, _hedgeCacheGet, _hedgeCacheSet, _markDelisted, _isDelisted, _warmHedgeCache, bybitCall,
  };
}

// ── message formatting (pure) ───────────────────────────────────────────────

function formatTradeResult(result, direction, symbol, entry, sl, tp1, riskPct, leverage, tp2 = 0.0, tp3 = 0.0) {
  const fp = PP.fmtPriceDisplay;
  if (pyTruthy(pyIndex(result, 'ok'))) {
    const bbSym = htmlEscape(pyStr(pyGet(result, 'symbol', toBybitSymbol(symbol))));
    const qty = htmlEscape(pyStr(pyGet(result, 'qty', '?')));
    const notional = pyGet(result, 'notional', 0.0);
    const balance = pyGet(result, 'balance', 0.0);
    const orderId = htmlEscape(pyStr(pyGet(result, 'order_id', '?')));
    const riskAmt = balance * riskPct / 100;
    const dirEm = direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    let tpLines = `🎯 TP1: <code>${fp(tp1)}</code>  (50% позиции)\n`;
    if (pyTruthy(tp2)) tpLines += `🎯 TP2: <code>${fp(tp2)}</code>  (25% позиции)\n`;
    if (pyTruthy(tp3)) tpLines += `🏆 TP3: <code>${fp(tp3)}</code>  (25% позиции)\n`;
    const beNote = pyTruthy(tp2) ? '\n♻️ <i>После TP1 — стоп автоматически перенесётся в БУ</i>' : '';
    const notionalPct = balance > 0 ? notional / balance * 100 : 0;
    const isMarket = pyStr(pyGet(result, 'order_type', 'Limit')).toLowerCase() === 'market';
    if (isMarket) {
      const avgRaw = pyOr(pyGet(result, 'avg_price', 0), 0);
      const avg = tryFloat(avgRaw, 0.0);
      const fill = avg > 0 ? avg : entry;
      const slipPct = entry ? (fill - entry) / entry * 100 : 0.0;
      const slipLine = (avg > 0 && entry) ? `📊 Slippage: <code>${fmtSigned(slipPct, 2)}%</code>` : '';
      const header = '✅ <b>ПОЗИЦИЯ ОТКРЫТА (Market) на Bybit</b>';
      const entryLine = `🎯 Вход: <code>${fp(fill)}</code> <i>(сигнал: ${fp(entry)})</i>`;
      const tpStatus = pyTruthy(pyGet(result, 'tp_placed')) ? '' : '\n⏳ <i>TP-ордера ставятся сразу после открытия позиции (≤1 цикл BE-монитора)</i>';
      return `${header}\n\n`
        + `💎 <b>${bbSym}</b>   ${dirEm}   x${leverage}\n\n`
        + `${entryLine}\n`
        + `🛑 Стоп:          <code>${fp(sl)}</code>\n`
        + (slipLine ? `${slipLine}\n` : '')
        + '\n'
        + `${tpLines}`
        + `${beNote}`
        + `${tpStatus}\n\n`
        + `📦 <b>Размер позиции:</b> <code>${qty}</code>  `
        + `(~$${fmtFixed(notional, 2)} = ${fmtFixed(notionalPct, 1)}% баланса)\n`
        + `⚠️ <b>Макс. убыток при SL:</b> <code>$${fmtFixed(riskAmt, 2)}</code> `
        + `(${pyFloatStr(riskPct)}% от $${fmtFixed(balance, 2)})\n`
        + '<i>💡 Размер ≠ риск. Размер — сумма позиции, риск — реальный $ убыток при SL.</i>\n\n'
        + `🆔 Order ID: <code>${orderId}</code>`;
    }
    const tpStatus = pyTruthy(pyGet(result, 'tp_placed')) ? '' : '\n⏳ <i>TP-ордера будут выставлены автоматически после исполнения входа</i>';
    return '✅ <b>ЛИМИТНЫЙ ОРДЕР ВЫСТАВЛЕН на Bybit</b>\n\n'
      + `💎 <b>${bbSym}</b>   ${dirEm}   x${leverage}\n\n`
      + `🎯 Лимитный вход: <code>${fp(entry)}</code>\n`
      + `🛑 Стоп:          <code>${fp(sl)}</code>\n\n`
      + `${tpLines}`
      + `${beNote}`
      + `${tpStatus}\n\n`
      + `📦 <b>Размер позиции:</b> <code>${qty}</code>  `
      + `(~$${fmtFixed(notional, 2)} = ${fmtFixed(notionalPct, 1)}% баланса)\n`
      + `⚠️ <b>Макс. убыток при SL:</b> <code>$${fmtFixed(riskAmt, 2)}</code> `
      + `(${pyFloatStr(riskPct)}% от $${fmtFixed(balance, 2)})\n`
      + '<i>💡 Размер ≠ риск. Размер — сумма позиции, риск — реальный $ убыток при SL.</i>\n\n'
      + `🆔 Order ID: <code>${orderId}</code>`;
  }
  const reason = htmlEscape(humanizeBybitError(pyGet(result, 'error', '')));
  return `❌ <b>Не удалось открыть сделку</b>\n\n⚠️ ${reason}`;
}

function formatTradeResultSplit(result, direction, symbol, entryLo, entryHi, sl, tp1, riskPct, leverage, tp2 = 0.0, tp3 = 0.0) {
  const fp = PP.fmtPriceDisplay;
  if (pyTruthy(pyIndex(result, 'ok'))) {
    const bbSym = htmlEscape(pyStr(pyGet(result, 'symbol', toBybitSymbol(symbol))));
    const qty = htmlEscape(pyStr(pyGet(result, 'qty', '?')));
    const notional = pyGet(result, 'notional', 0.0);
    const balance = pyGet(result, 'balance', 0.0);
    const orderId = htmlEscape(pyStr(pyGet(result, 'order_id', '?')));
    const riskAmt = balance * riskPct / 100;
    const dirEm = direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
    const idLo = pyGet(result, 'order_id_lo', '');
    const idHi = pyGet(result, 'order_id_hi', '');
    const ordersPlaced = [idLo, idHi].filter((x) => pyTruthy(x)).length;
    let tpLines = `🎯 TP1: <code>${fp(tp1)}</code>  (50% позиции)\n`;
    if (pyTruthy(tp2)) tpLines += `🎯 TP2: <code>${fp(tp2)}</code>  (25% позиции)\n`;
    if (pyTruthy(tp3)) tpLines += `🏆 TP3: <code>${fp(tp3)}</code>  (25% позиции)\n`;
    const beNote = pyTruthy(tp2) ? '\n♻️ <i>После TP1 — стоп автоматически перенесётся в БУ</i>' : '';
    const tpStatus = pyTruthy(pyGet(result, 'tp_placed')) ? '' : '\n⏳ <i>TP-ордера будут выставлены автоматически после исполнения входа</i>';
    const ordersNote = ordersPlaced < 2 ? `(${ordersPlaced}/2 ордеров выставлено)` : '';
    const notionalPct = balance > 0 ? notional / balance * 100 : 0;
    return `✅ <b>SMC СПЛИТ-ВХОД выставлен на Bybit</b> ${ordersNote}\n\n`
      + `💎 <b>${bbSym}</b>   ${dirEm}   x${leverage}\n\n`
      + `🎯 Лимит 1 (50%): <code>${fp(entryLo)}</code>\n`
      + `🎯 Лимит 2 (50%): <code>${fp(entryHi)}</code>\n`
      + `🛑 Стоп:          <code>${fp(sl)}</code>\n\n`
      + `${tpLines}`
      + `${beNote}`
      + `${tpStatus}\n\n`
      + `📦 <b>Размер позиции (суммарно):</b> <code>${qty}</code>  `
      + `(~$${fmtFixed(notional, 2)} = ${fmtFixed(notionalPct, 1)}% баланса)\n`
      + `⚠️ <b>Макс. убыток при SL:</b> <code>$${fmtFixed(riskAmt, 2)}</code> `
      + `(${pyFloatStr(riskPct)}% от $${fmtFixed(balance, 2)})\n`
      + '<i>💡 Размер ≠ риск. Размер — сумма позиции, риск — реальный $ убыток при SL.</i>\n\n'
      + `🆔 Order IDs: <code>${orderId}</code>`;
  }
  const reason = htmlEscape(humanizeBybitError(pyGet(result, 'error', '')));
  return `❌ <b>Не удалось открыть сделку</b>\n\n⚠️ ${reason}`;
}

let _default = null;
function defaultTrader() {
  if (!_default) _default = createBybitTrader();
  return _default;
}

module.exports = {
  createBybitTrader, defaultTrader,
  MIN_NOTIONAL, MAX_LEVERAGE, TAKER_FEE, MAKER_FEE, BYBIT_ERROR_MAP,
  toBybitSymbol, bybitPriceMultiplier, humanizeBybitError, splitTpQtys, wantsTpOrders, isNetworkError,
  formatTradeResult, formatTradeResultSplit, TokenBucket,
};
