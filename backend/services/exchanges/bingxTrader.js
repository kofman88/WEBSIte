'use strict';
/**
 * bingxTrader.js — one-to-one port of `bingx_trader.py` (BingX Perpetual Futures API v2).
 *
 * Auth (`_sign` / `_build_query`): every param (+ timestamp = now_ms + server offset,
 * recvWindow = 15000) sorted by key, each value `quote(str(v), safe='')`, joined `k=v&…`;
 * HMAC-SHA256(secret) hex appended as `&signature=`; header X-BX-APIKEY; the URL is sent
 * pre-encoded (yarl encoded=True) so the signed string IS the wire string.
 *
 * `_request`: rate penalty wait (30 s after a 429/503), Fernet-token guard (100413),
 * 3 attempts on connect errors (0.5 s / 1 s, then [BINGX-NET-RETRY] code -1 "network: …"),
 * timeout → code -1 "timeout", non-JSON body → code -1 "http=<status>; body=<300 chars>".
 *
 * place_trade (spec §14.2): symbol check (contracts cache 4 h), equity, leverage
 * (0/80014 → hedge, 109400 → side=BOTH one-way), sizing + low-notional skip/boost,
 * deterministic clientOrderIds, ATOMIC batchOrders (MARKET + STOP_MARKET + TP1..3; known to
 * fail server-side → [BINGX-ATOMIC-FALLBACK]) then the legacy flow: LIMIT only within
 * 0.3 % of the last price else MARKET (order_type ignored), 109400 → retry without
 * positionSide, duplicate (101204/101404) → ok, fill wait polling every 0.2 s (10 s LIMIT /
 * 3 s MARKET, [BINGX-LEGACY-GAP], [BINGX-GAP-WARN]), unfilled LIMIT → cancel + RU error,
 * SL ×5 (109400 drop positionSide, price msg → CONTRACT_PRICE) or cancel + emergency close
 * ([SL-SAFETY-CLOSE-BINGX*]), TPs ×5 with 110413/110414 adaptive re-pricing
 * ([TP-ADAPTIVE-SHIFT]), all-success rule, [TP-PHANTOM] verification + re-send.
 */

const { makeRuntime } = require('./runtime');
const { TransportError, aiohttpJson } = require('./transport');
const {
  PyError, errStr, pyGet, pyIndex, pyFloat, pyInt, pyStr, pyRepr, pyFloatStr, pyTruthy, pyOr, pyQuote,
  htmlEscape, pySlice, isDict,
  pyLen,
  pyIter,
} = require('./pyCompat');
const { fmtFixed, fmtComma, fmtG } = require('../../strategies/common/pyfmt');
const { pyRound } = require('../../strategies/common/pyround');
const { pySum } = require('../../strategies/common/series');
const { pyJsonDumps } = require('../engine/pyjson');
const PP = require('./pricePrecision');
const { computeClientOrderId } = require('./orderIdUtils');
const { callWithRetry } = require('./apiRetry');
const sym = require('../marketData/symbolMap');
const crypto = require('crypto');
const { safeKeyId, killswitchGate, planGateDeny, recordPlaced } = require('./traderCommon');
const { pyLower, pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods
const { pyRegExp } = require('../../strategies/common/pyre');
// The bot's `re` patterns with CPython 3.11 \d \s \b (common/pyre.js), not JS's ASCII classes.
const JSON_CODE_RE = pyRegExp(String.raw`"code"\s*:\s*(-?\d+)`);
const BARE_CODE_RE = pyRegExp(String.raw`\b(\d{5,6})\b`);
const JSON_MSG_RE = pyRegExp(String.raw`"msg"\s*:\s*"([^"]+)"`);

const BASE_URL = 'https://open-api.bingx.com';
const MIN_NOTIONAL = 5.0;
const MAX_LEVERAGE = 75;
const RECV_WINDOW = 15000;
const TAKER_FEE = 0.0005;
const MAKER_FEE = 0.0002;
const INSTRUMENT_FILTER_TTL_S = 4 * 3600;

const BINGX_ERROR_MAP = Object.freeze({
  100001: 'Неверная подпись. Проверьте API Secret.',
  100004: 'Недостаточно прав API. Включите разрешение на торговлю.',
  100413: 'Неверный API ключ.',
  100414: 'API ключ истёк. Перевыпустите ключ на BingX.',
  100500: 'Внутренняя ошибка BingX. Повторите попытку позже.',
  100503: 'Сервис BingX временно недоступен. Попробуйте позже.',
  101204: 'Недостаточно средств на счёте. Пополните баланс.',
  101400: 'Неверные параметры ордера или объём ниже минимального (5 USDT).',
  101401: 'Объём ордера превышает максимально допустимый.',
  101500: 'Инструмент не найден или недоступен для торговли.',
  101503: 'Торговля по данному инструменту приостановлена.',
  101508: 'Превышен максимальный лимит открытых ордеров.',
  101514: 'Позиция уже закрыта или не существует.',
  101515: 'Объём закрытия превышает размер открытой позиции.',
  109201: 'Превышен лимит открытых позиций или символ не найден.',
  110424: 'Размер ордера больше доступного (позиция мала для нового SL — оригинальный SL остаётся в силе).',
  80001: 'Неверный API ключ.',
  80002: 'Неверная подпись. Проверьте API Secret.',
  80003: 'Неверный timestamp.',
  80012: 'Недостаточно прав API.',
  80014: 'Плечо уже установлено на данное значение.',
});

/** _humanize_bingx_error — note the bot feeds it str(dict) (single-quoted repr). */
function humanizeBingxError(raw) {
  if (!pyTruthy(raw)) return 'Неизвестная ошибка BingX.';
  raw = String(raw);
  let code = null;
  let m = JSON_CODE_RE.exec(raw);
  if (!m) {
    m = BARE_CODE_RE.exec(raw);
    code = m ? pyInt(m[1]) : null;          // int() of Unicode digits too
  } else {
    code = pyInt(m[1]);
  }
  if (code && Object.prototype.hasOwnProperty.call(BINGX_ERROR_MAP, code)) return BINGX_ERROR_MAP[code];
  const mm = JSON_MSG_RE.exec(raw);
  if (mm) {
    const msg = mm[1];
    const first = String.fromCodePoint(msg.codePointAt(0));
    return pyUpper(first) + msg.slice(first.length) + (msg.endsWith('.') ? '' : '.');
  }
  return code ? `Ошибка BingX (код ${code}).` : 'Неизвестная ошибка BingX.';
}

const toBingxSymbol = sym.toBingxSymbol;
const bingxPriceMultiplier = sym.bingxPriceMultiplier;

/** _sign(params, secret) — sorted keys, quote(str(v), safe=''), HMAC-SHA256 hex. */
function bingxQueryString(params) {
  return Object.keys(params).sort().map((k) => `${k}=${pyQuote(pyStr(params[k]), '')}`).join('&');
}
function bingxSign(params, secret) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(Buffer.from(bingxQueryString(params), 'utf8')).digest('hex');
}

/** str() of a float value placed in a param (e.g. the TP-PHANTOM re-send stopPrice). */
const fstr = (x) => (typeof x === 'number' ? pyFloatStr(x) : pyStr(x));

function createBingxTrader(overrides = {}) {
  const rt = makeRuntime(overrides);
  const log = rt.log;
  const st = {
    timeOffsetMs: 0,
    timeSyncedAt: 0.0,
    ratePenaltyUntil: 0.0,
    rateSleepS: 0.0,
    instrumentFilterCache: new Map(),
  };

  async function _getServerTime() {
    try {
      const r = await rt.transport({ method: 'GET', url: `${BASE_URL}/openApi/server/v1/time`, headers: {}, timeoutMs: 5000 });
      const data = aiohttpJson(r);
      if (!isDict(data)) {
        log.warning(`BingX server_time: non-dict response (${data === null ? 'NoneType' : Array.isArray(data) ? 'list' : typeof data}) — using local time`);
        return Math.trunc(rt.now() * 1000);
      }
      const inner = pyGet(data, 'data');
      if (!isDict(inner)) {
        log.warning(`BingX server_time: missing 'data' field (code=${pyStr(pyGet(data, 'code', '?'))} msg=${pySlice(pyStr(pyGet(data, 'msg', '')), 80)}) — using local time`);
        return Math.trunc(rt.now() * 1000);
      }
      const serverTime = pyGet(inner, 'serverTime');
      if (serverTime === null) {
        log.warning(`BingX server_time: missing 'serverTime' field (keys=${pyRepr(Object.keys(inner).slice(0, 5))}) — using local time`);
        return Math.trunc(rt.now() * 1000);
      }
      return pyInt(serverTime);
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') log.warning('BingX server_time: timeout 5s — using local time');
      else if (e instanceof TransportError || (e && e.pyType === 'ContentTypeError')) log.warning(`BingX server_time: network error (${e.pyType || e.name}) — using local time`);
      else log.warning(`BingX server_time: unexpected error ${e && (e.pyType || e.name)}: ${pySlice(errStr(e), 100)} — using local time`);
      return Math.trunc(rt.now() * 1000);
    }
  }

  async function syncTime() {
    try {
      const localMs = Math.trunc(rt.now() * 1000);
      const serverMs = await _getServerTime();
      st.timeOffsetMs = serverMs - localMs;
      st.timeSyncedAt = rt.now();
      log.info(`BingX time sync: offset=${st.timeOffsetMs}ms`);
    } catch (e) {
      log.warning(`BingX time sync failed (используем offset=${st.timeOffsetMs}ms): ${errStr(e)}`);
    }
    return st.timeOffsetMs;
  }

  function _buildQuery(apiKey, secret, extra) {
    const params = { ...extra };
    params.timestamp = String(Math.trunc(rt.now() * 1000) + st.timeOffsetMs);
    params.recvWindow = String(RECV_WINDOW);
    const signature = bingxSign(params, secret);
    const fullQs = `${bingxQueryString(params)}&signature=${signature}`;
    return [fullQs, { 'X-BX-APIKEY': apiKey }];
  }

  async function _request(method, path, apiKey, secret, params = null, timeout = 15) {
    if (st.ratePenaltyUntil > 0 && rt.now() < st.ratePenaltyUntil) {
      const wait = Math.min(st.ratePenaltyUntil - rt.now(), 30.0);
      log.debug(`[AUDIT-FIX] BingX rate penalty: waiting ${wait.toFixed(1)}s`);
      await rt.sleep(wait);
    }
    if (String(apiKey).startsWith('gAAAAA') || String(secret).startsWith('gAAAAA')) {
      return {
        code: 100413,
        msg: 'API ключ повреждён: в БД хранится зашифрованный токен вместо реального ключа. Переустанови ключи через 🔑 Настроить BingX API.',
      };
    }
    const extra = pyTruthy(params) ? params : {};
    const [qs, headers] = _buildQuery(apiKey, secret, extra);
    const url = `${BASE_URL}${path}?${qs}`;
    let lastNetErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') continue;
        const resp = await rt.transport({ method, url, headers, timeoutMs: timeout * 1000 });
        try {
          return aiohttpJson(resp);
        } catch (_je) {
          log.error('bingx_trader._request() unhandled exception');
          return { code: -1, msg: `http=${resp.status}; body=${pySlice(resp.text || '', 300)}` };
        }
      } catch (e) {
        if (e instanceof TransportError && e.kind === 'connect') {
          lastNetErr = e;
          if (attempt < 2) {
            await rt.sleep(0.5 * (2 ** attempt));
            continue;
          }
          log.warning(`[BINGX-NET-RETRY] ${method} ${path} failed after 3 retries: ${e.message}`);
          return { code: -1, msg: `network: ${e.message}` };
        }
        if (e instanceof TransportError && e.kind === 'timeout') return { code: -1, msg: 'timeout' };
        const es = errStr(e);
        const low = pyLower(es);
        if (low.includes('429') || low.includes('503') || low.includes('too many')) {
          st.ratePenaltyUntil = rt.now() + 30.0;
          st.rateSleepS = Math.min(st.rateSleepS + 1.0, 10.0);
          log.warning(`[AUDIT-FIX] BingX 429/503 detected — penalty 30s, sleep=${st.rateSleepS.toFixed(1)}s`);
        }
        return { code: -1, msg: es };
      }
    }
    return { code: -1, msg: `network: ${lastNetErr ? lastNetErr.message : 'None'}` };
  }

  async function _getInstrumentFilters(symbol) {
    const now = rt.now();
    const hit = st.instrumentFilterCache.get(symbol);
    if (hit !== undefined && (now - hit[0]) < INSTRUMENT_FILTER_TTL_S) return hit[1];
    try {
      const resp = await rt.transport({ method: 'GET', url: `${BASE_URL}/openApi/swap/v2/quote/contracts`, headers: {}, timeoutMs: 30000 });
      const data = aiohttpJson(resp);
      if (pyGet(data, 'code') === 0) {
        for (const item of pyIter(pyGet(data, 'data', []))) {
          if (pyGet(item, 'symbol') === symbol) {
            const qtyStep = pyFloat(pyOr(pyGet(item, 'tradeMinQuantity', 0.001), 0.001));
            const p = pyInt(pyFloat(pyGet(item, 'pricePrecision', 4)));
            const tickSize = p === 0 ? 1 : (p > 0 ? 1 / (10 ** p) : 10 ** (-p));
            const maxLev = pyInt(pyOr(pyGet(item, 'maxLeverage', MAX_LEVERAGE), MAX_LEVERAGE));
            const val = [qtyStep, tickSize, true, maxLev];
            st.instrumentFilterCache.set(symbol, [now, val]);
            return val;
          }
        }
      }
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') log.warning(`BingX get_instrument_filters ${symbol}: timeout 30s — using defaults`);
      else log.debug(`BingX get_instrument_filters ${symbol}: ${errStr(e)}`);
    }
    return [0.001, 0.0001, false, MAX_LEVERAGE];
  }

  async function testConnection(apiKey, secret) {
    try {
      let lastErr = '';
      for (const path of ['/openApi/swap/v2/user/balance', '/openApi/swap/v1/user/balance']) {
        const data = await _request('GET', path, apiKey, secret);
        if (pyGet(data, 'code') === 0) {
          const payload = pyGet(data, 'data', {});
          let bal = pyGet(payload, 'balance', payload);
          if (Array.isArray(bal) && bal.length) bal = bal[0];
          const equityRaw = pyOr(isDict(bal) ? pyGet(bal, 'equity') : null, isDict(bal) ? pyGet(bal, 'balance') : null, 0);
          const equity = pyFloat(pyOr(equityRaw, 0));
          return { ok: true, balance: equity, error: '' };
        }
        lastErr = humanizeBingxError(pyStr(data));
        log.warning(`BingX test_connection: path=${path} code=${pyStr(pyGet(data, 'code'))} key=${safeKeyId(apiKey)}`);
      }
      return { ok: false, balance: 0.0, error: pyOr(lastErr, 'Не удалось получить баланс BingX.') };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, balance: 0.0, error: 'Таймаут соединения с BingX. Попробуйте позже.' };
      log.error(`BingX test_connection: ${errStr(e)}`);
      return { ok: false, balance: 0.0, error: errStr(e) };
    }
  }

  async function placeTrade(apiKey, secret, symbol, direction, entry, sl, tp1, riskPct, leverage, o = {}) {
    let { tp2 = 0.0, tp3 = 0.0 } = o;
    const { riskMode = 'risk', tradeId = '', userId = 0, allowLowNotionalBoost = false } = o;
    const t0 = rt.monotonic();
    const ks = await killswitchGate(rt, 'bingx_trader.place_trade');
    if (ks) return ks;
    const deny = await planGateDeny(rt, userId, symbol, 'bingx');
    if (deny) return deny;
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const side = ['LONG', 'BUY'].includes(pyUpper(String(direction))) ? 'BUY' : 'SELL';
      const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const pmult = bingxPriceMultiplier(symbol);
      if (pmult !== 1.0) {
        entry *= pmult;
        sl *= pmult;
        tp1 *= pmult;
        if (pyTruthy(tp2)) tp2 *= pmult;
        if (pyTruthy(tp3)) tp3 *= pmult;
        log.debug(`BingX 1000x price correction ${symbol}: ×${fmtFixed(pmult, 0)}`);
      }
      const [qtyStep, tickSize, symFound, symMaxLev] = await _getInstrumentFilters(bingxSymbol);
      if (!symFound) {
        log.warning(`BingX place_trade ${symbol}: символ ${bingxSymbol} не найден в контрактах BingX`);
        return { ok: false, order_id: '', error: `Символ ${bingxSymbol} недоступен на BingX Futures.` };
      }
      const balData = await _request('GET', '/openApi/swap/v2/user/balance', apiKey, secret);
      if (pyGet(balData, 'code') !== 0) {
        const err = humanizeBingxError(pyStr(balData));
        log.error(`BingX place_trade ${symbol}: баланс-ошибка code=${pyStr(pyGet(balData, 'code'))} key=${safeKeyId(apiKey)} → ${err}`);
        return { ok: false, order_id: '', error: err };
      }
      const equity = pyFloat(pyOr(pyGet(pyIndex(pyIndex(balData, 'data'), 'balance'), 'equity', 0), 0));
      if (equity <= 0) return { ok: false, order_id: '', error: 'Нулевой баланс BingX.' };

      const lev = Math.min(leverage, MAX_LEVERAGE, symMaxLev);
      const levData = await _request('POST', '/openApi/swap/v2/trade/leverage', apiKey, secret, { symbol: bingxSymbol, side: posSide, leverage: String(lev) });
      let hedgeMode;
      const levCode = pyGet(levData, 'code');
      if (levCode === 0 || levCode === 80014) {
        hedgeMode = true;
      } else if (levCode === 109400) {
        const levData2 = await _request('POST', '/openApi/swap/v2/trade/leverage', apiKey, secret, { symbol: bingxSymbol, side: 'BOTH', leverage: String(lev) });
        hedgeMode = false;
        const c2 = pyGet(levData2, 'code');
        if (!(c2 === 0 || c2 === 80014)) log.warning(`BingX set leverage (one-way): ${pyStr(levData2)}`);
      } else {
        hedgeMode = true;
        log.warning(`BingX set leverage: ${pyStr(levData)}`);
      }

      const riskUsd = equity * (riskPct / 100.0);
      const slDist = Math.abs(entry - sl);
      if (slDist < 1e-10) return { ok: false, order_id: '', error: 'SL совпадает с ценой входа.' };
      let qtyRaw;
      if (riskMode === 'notional') qtyRaw = entry > 0 ? riskUsd / entry : 0;
      else if (riskMode === 'margin') qtyRaw = entry > 0 ? (equity * (riskPct / 100.0) * lev) / entry : 0;
      else qtyRaw = riskUsd / slDist;
      let qtyStr = PP.roundQty(qtyRaw, qtyStep);
      let qtyFloat = pyFloat(qtyStr);
      if (qtyFloat <= 0 && qtyStep > 0) {
        qtyFloat = qtyStep;
        qtyStr = PP.roundQty(qtyStep, qtyStep);
      }
      let notional = qtyFloat * entry;
      const minPos = Math.max(MIN_NOTIONAL, 10.0);
      if (notional < minPos) {
        if (!allowLowNotionalBoost) {
          const requiredBalance = riskPct > 0 ? minPos / (riskPct / 100.0) : 0.0;
          const minRiskForBalance = equity > 0 ? minPos / equity * 100.0 : 0.0;
          return {
            ok: false, order_id: '',
            low_notional_skip: true,
            required_balance: pyRound(requiredBalance, 2),
            requested_risk_pct: pyRound(riskPct, 2),
            min_risk_for_balance_pct: pyRound(minRiskForBalance, 2),
            error: `Баланс $${fmtFixed(equity, 2)} слишком мал для risk=${pyFloatStr(riskPct)}% `
              + `(минимум биржи $${fmtFixed(minPos, 0)} notional). `
              + `Пополни до $${fmtFixed(requiredBalance, 0)}+ или risk≥${fmtFixed(minRiskForBalance, 1)}%.`,
          };
        }
        qtyRaw = entry > 0 ? minPos / entry : 0;
        qtyStr = PP.roundQty(qtyRaw, qtyStep);
        qtyFloat = pyFloat(qtyStr);
        notional = qtyFloat * entry;
        if (notional < MIN_NOTIONAL) {
          return { ok: false, order_id: '', error: `Объём позиции слишком мал (${fmtFixed(notional, 2)} USDT < ${pyFloatStr(MIN_NOTIONAL)} USDT минимум).` };
        }
        log.warning(`[AUDIT-FIX] ⚠️ Volume boosted to min ${bingxSymbol} (user opt-in): qty=${qtyStr} notional=${fmtFixed(notional, 2)}`);
      }

      let cidEntry = '';
      let cidSl = '';
      const cidTp = [];
      if (tradeId) {
        cidEntry = computeClientOrderId(tradeId, userId, 'bingx', 'entry');
        cidSl = computeClientOrderId(tradeId, userId, 'bingx', 'sl');
        for (let i = 1; i < 4; i++) cidTp.push(computeClientOrderId(tradeId, userId, 'bingx', `tp${i}`));
      }

      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      let atomicOk = false;
      let atomicOrderId = '';
      let atomicTpPlaced = false;
      if (cidEntry && cidSl && tp1 > 0 && sl > 0) {
        try {
          let qTp1;
          let qTp2;
          let qTp3;
          if (pyTruthy(tp2) && tp2 > 0) {
            qTp2 = PP.roundQty(qtyFloat * 0.25, qtyStep);
            qTp3 = (pyTruthy(tp3) && tp3 > 0) ? PP.roundQty(qtyFloat * 0.25, qtyStep) : '0';
            const qTp1F = qtyFloat - pyFloat(qTp2) - pyFloat(qTp3);
            qTp1 = PP.roundQty(Math.max(qTp1F, qtyStep), qtyStep);
          } else {
            qTp1 = qtyStr;
            qTp2 = '0';
            qTp3 = '0';
          }
          const slStrAtomic = PP.roundPriceSl(sl, tickSize, direction);
          const tp1StrAtomic = PP.roundPriceTp(tp1, tickSize, direction);
          const posSideAtomic = hedgeMode ? posSide : 'BOTH';
          const batch = [
            { symbol: bingxSymbol, side, type: 'MARKET', quantity: qtyStr, positionSide: posSideAtomic, clientOrderId: cidEntry },
            {
              symbol: bingxSymbol, side: closeSide, type: 'STOP_MARKET', quantity: qtyStr,
              stopPrice: slStrAtomic, workingType: 'MARK_PRICE', positionSide: posSideAtomic, clientOrderId: cidSl,
            },
            {
              symbol: bingxSymbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', quantity: qTp1,
              stopPrice: tp1StrAtomic, workingType: 'MARK_PRICE', positionSide: posSideAtomic,
              clientOrderId: cidTp.length >= 1 ? cidTp[0] : '',
            },
          ];
          if (pyTruthy(tp2) && tp2 > 0 && pyFloat(qTp2) > 0) {
            batch.push({
              symbol: bingxSymbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', quantity: qTp2,
              stopPrice: PP.roundPriceTp(tp2, tickSize, direction), workingType: 'MARK_PRICE', positionSide: posSideAtomic,
              clientOrderId: cidTp.length >= 2 ? cidTp[1] : '',
            });
          }
          if (pyTruthy(tp3) && tp3 > 0 && pyFloat(qTp3) > 0) {
            batch.push({
              symbol: bingxSymbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', quantity: qTp3,
              stopPrice: PP.roundPriceTp(tp3, tickSize, direction), workingType: 'MARK_PRICE', positionSide: posSideAtomic,
              clientOrderId: cidTp.length >= 3 ? cidTp[2] : '',
            });
          }
          const batchResp = await _request('POST', '/openApi/swap/v2/trade/batchOrders', apiKey, secret, { batchOrders: pyJsonDumps(batch) });
          const bcode = pyGet(batchResp, 'code', -1);
          const bmsg = pyLower(pyStr(pyGet(batchResp, 'msg', '')));
          const endpointMissing = bcode === -1 || bcode === 101400 || bcode === 100404
            || bmsg.includes('not found') || bmsg.includes('not support') || bmsg.includes('404');
          if (endpointMissing) {
            log.warning(`[BINGX-ATOMIC-FALLBACK] ${bingxSymbol}: batch endpoint unavailable (code=${pyStr(bcode)} msg=${pySlice(pyStr(pyGet(batchResp, 'msg', '')), 100)}) — legacy flow`);
          } else if (bcode !== 0) {
            log.warning(`[BINGX-ATOMIC-FALLBACK] ${bingxSymbol}: batch non-zero code=${pyStr(bcode)} — legacy flow`);
          } else {
            const bData = pyOr(pyGet(batchResp, 'data'), {});
            let bResults = [];
            if (Array.isArray(bData)) bResults = bData;
            else if (isDict(bData)) bResults = pyOr(pyGet(bData, 'orders', []), pyGet(bData, 'orderList', []), []);
            if (bResults.length >= 2) {
              const entryR = bResults[0];
              const slR = bResults[1];
              const entryOk = pyTruthy(
                (isDict(entryR) && pyOr(pyGet(entryR, 'orderId'), pyGet(pyGet(entryR, 'order', {}), 'orderId')))
                || (isDict(entryR) && pyGet(entryR, 'code', 0) === 0),
              );
              const slOk = pyTruthy(isDict(slR) && pyOr(pyGet(slR, 'orderId'), pyGet(pyGet(slR, 'order', {}), 'orderId')));
              if (entryOk && slOk) {
                atomicOk = true;
                atomicOrderId = pyStr(pyOr(isDict(entryR) ? pyGet(entryR, 'orderId') : '', pyGet(pyGet(entryR, 'order', {}), 'orderId', cidEntry)));
                for (const tpR of pyIter(bResults.slice(2))) {
                  if (isDict(tpR) && (pyTruthy(pyGet(tpR, 'orderId')) || pyGet(tpR, 'code', -1) === 0)) { atomicTpPlaced = true; break; }
                }
                const n = bResults.slice(2).filter((r) => isDict(r) && pyTruthy(pyGet(r, 'orderId'))).length;
                log.info(`[BINGX-ATOMIC-OK] ${bingxSymbol}: batch placed entry+SL+${n} TP orders`);
              } else {
                log.warning(`[BINGX-ATOMIC-FALLBACK] ${bingxSymbol}: batch partial (entry_ok=${entryOk ? 'True' : 'False'} sl_ok=${slOk ? 'True' : 'False'}) — legacy retry (idempotent via Fix #2)`);
              }
            } else {
              log.warning(`[BINGX-ATOMIC-FALLBACK] ${bingxSymbol}: batch returned ${bResults.length} results — legacy flow`);
            }
          }
        } catch (be) {
          log.warning(`[BINGX-ATOMIC-FALLBACK] ${bingxSymbol}: batch exception (${errStr(be)}) — legacy flow`);
        }
      }
      if (atomicOk) {
        return { ok: true, order_id: pyOr(atomicOrderId, cidEntry), error: '', tp_placed: atomicTpPlaced, atomic: true, qty: pyFloat(qtyStr) };
      }

      const orderParams = { symbol: bingxSymbol, side, quantity: qtyStr };
      if (cidEntry) orderParams.clientOrderId = cidEntry;
      try {
        const tickerData = await _request('GET', '/openApi/swap/v2/quote/price', apiKey, secret, { symbol: bingxSymbol });
        const currentPrice = pyFloat(pyOr(pyGet(pyGet(tickerData, 'data', {}), 'price', 0), 0));
        const priceDiffPct = entry > 0 ? Math.abs(currentPrice - entry) / entry * 100 : 999;
        if (currentPrice > 0 && priceDiffPct < 0.3) {
          orderParams.type = 'LIMIT';
          orderParams.price = PP.roundPrice(entry, tickSize);
          orderParams.timeInForce = 'GTC';
          log.debug(`BingX LIMIT entry ${bingxSymbol}: diff=${fmtFixed(priceDiffPct, 3)}%`);
        } else {
          orderParams.type = 'MARKET';
        }
      } catch (pe) {
        log.debug(`BingX price check failed (${errStr(pe)}), using MARKET`);
        orderParams.type = 'MARKET';
      }
      orderParams.positionSide = hedgeMode ? posSide : 'BOTH';
      let resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, orderParams);
      if (pyGet(resp, 'code') === 109400) {
        log.warning(`BingX order 109400 (positionSide=${pyStr(pyGet(orderParams, 'positionSide'))}), retry без positionSide: ${pyStr(resp)}`);
        delete orderParams.positionSide;
        resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, orderParams);
      }
      const respCode = pyGet(resp, 'code');
      const respMsgL = pyLower(pyStr(pyGet(resp, 'msg', '')));
      const isDup = cidEntry && (respCode === 101204 || respCode === 101404 || respMsgL.includes('duplicate')
        || (respMsgL.includes('clientorder') && respMsgL.includes('exist')));
      if (isDup) {
        log.info(`Duplicate order rejected by exchange (idempotency works): ${bingxSymbol} cid=${cidEntry} — assuming prior attempt succeeded`);
        return { ok: true, order_id: cidEntry, error: '', tp_placed: false, duplicate: true, qty: pyFloat(qtyStr) };
      }
      if (pyGet(resp, 'code') !== 0) {
        log.error(`BingX order failed ${bingxSymbol}: code=${pyStr(pyGet(resp, 'code'))} msg=${pyRepr(pyGet(resp, 'msg', ''))} params=${pyRepr(orderParams)}`);
        return { ok: false, order_id: '', error: humanizeBingxError(pyStr(resp)) };
      }
      const data = pyGet(resp, 'data');
      if (!pyTruthy(data) || !isDict(data)) {
        log.error(`BingX order OK but data is empty: ${pyStr(resp)}`);
        return { ok: false, order_id: '', error: 'BingX returned empty data' };
      }
      const orderId = pyStr(pyGet(pyOr(pyGet(data, 'order'), {}), 'orderId', ''));
      if (!orderId) {
        log.error(`BingX order OK but orderId missing: ${pyStr(resp)}`);
        return { ok: false, order_id: '', error: 'BingX returned no orderId' };
      }

      const isLimit = pyGet(orderParams, 'type') === 'LIMIT';
      const waitBudget = isLimit ? 10 : 3;
      let posReady = false;
      const tStart = rt.now();
      while (rt.now() - tStart < waitBudget) {
        try {
          const posData = await _request('GET', '/openApi/swap/v2/user/positions', apiKey, secret, { symbol: bingxSymbol });
          if (pyGet(posData, 'code') === 0) {
            for (const p of pyIter(pyOr(pyGet(posData, 'data', []), []))) {
              if (pyFloat(pyOr(pyGet(p, 'positionAmt', 0), 0)) !== 0) { posReady = true; break; }
            }
          }
          if (posReady) break;
        } catch (pe) {
          log.debug(`BingX pos-check ${bingxSymbol}: ${errStr(pe)}`);
        }
        await rt.sleep(0.2);
      }
      const fillDetectS = rt.now() - tStart;
      log.info(`[BINGX-LEGACY-GAP] ${bingxSymbol} entry_type=${pyStr(pyGet(orderParams, 'type'))} fill_detected_in=${fmtFixed(fillDetectS, 2)}s (budget=${waitBudget}s, ready=${posReady ? 'True' : 'False'})`);
      if (posReady && fillDetectS > 2.0) {
        log.warning(`[BINGX-GAP-WARN] ${bingxSymbol} entry_type=${pyStr(pyGet(orderParams, 'type'))} gap=${fmtFixed(fillDetectS, 2)}s > 2s — naked exposure window. batchOrders endpoint broken server-side; monitoring frequency for escalation.`);
      }
      if (!posReady && isLimit) {
        log.warning(`BingX LIMIT ${bingxSymbol} не исполнился за ${waitBudget}с — отменяем ордер ${orderId}`);
        try { await cancelAllOrders(apiKey, secret, symbol); } catch (_e) { log.error('bingx_trader.place_trade() unhandled exception'); }
        return {
          ok: false,
          error: `Лимитный ордер на ${bingxSymbol} не исполнился за 10 сек (цена ушла). Ордер отменён. Попробуйте ещё раз.`,
        };
      }

      const slStr = PP.roundPriceSl(sl, tickSize, direction);
      const slParams = {
        symbol: bingxSymbol, side: closeSide, type: 'STOP_MARKET', quantity: qtyStr, stopPrice: slStr, workingType: 'MARK_PRICE',
      };
      slParams.positionSide = hedgeMode ? posSide : 'BOTH';
      if (cidSl) slParams.clientOrderId = cidSl;
      let slPlaced = false;
      let lastSlErr = '';
      for (let a = 0; a < 5; a++) {
        const slResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, slParams);
        if (pyGet(slResp, 'code') === 0) { slPlaced = true; break; }
        lastSlErr = pyStr(slResp);
        const code = pyGet(slResp, 'code');
        const msg = pyLower(pyStr(pyGet(slResp, 'msg', '')));
        if (code === 109400) {
          log.warning(`[BINGX-SL-DEBUG] ${bingxSymbol} qty=${pyRepr(pyGet(slParams, 'quantity'))} sl=${pyRepr(pyGet(slParams, 'stopPrice'))} side=${pyStr(pyGet(slParams, 'side'))} posSide=${pyStr(pyGet(slParams, 'positionSide'))} type=${pyStr(pyGet(slParams, 'type'))} wt=${pyStr(pyGet(slParams, 'workingType'))} attempt=${a + 1}`);
        }
        if (cidSl && (code === 101204 || code === 101404 || msg.includes('duplicate'))) {
          log.info(`SL duplicate rejected (idempotency works): ${bingxSymbol} cid=${cidSl} — assuming already placed`);
          slPlaced = true;
          break;
        }
        if (code === 109400 && a === 0) { delete slParams.positionSide; continue; }
        if (a === 1 && (msg.includes('price') || msg.includes('trigger') || msg.includes('stopprice'))) {
          slParams.workingType = 'CONTRACT_PRICE';
          log.debug('BingX SL fallback workingType=CONTRACT_PRICE');
          continue;
        }
        log.warning(`BingX SL attempt ${a + 1}/5 ${bingxSymbol}: code=${pyStr(code)} msg=${pyRepr(pyGet(slResp, 'msg', ''))}`);
        await rt.sleep(2.0);
      }
      if (!slPlaced) {
        log.error(`BingX SL final err: ${pySlice(lastSlErr, 300)}`);
        log.error(`BingX SL FAILED after 3 attempts: ${bingxSymbol} — отменяем ордер ${orderId} чтобы не оставлять позицию без стоп-лосса.`);
        try {
          await cancelAllOrders(apiKey, secret, symbol);
          log.info(`FIX-AUDIT-38: BingX ордер ${orderId} отменён после провала SL.`);
        } catch (ce) {
          log.error(`FIX-AUDIT-38: не удалось отменить BingX ордер ${orderId}: ${errStr(ce)} — пользователь должен закрыть позицию вручную!`);
        }
        try {
          const positions = await getPositions(apiKey, secret, symbol);
          let liveSize = 0.0;
          for (const p of pyIter(pyOr(positions, []))) {
            const ps = pyFloat(pyOr(pyGet(p, 'positionAmt', 0), pyGet(p, 'size', 0), 0));
            if (Math.abs(ps) > 0) { liveSize = Math.abs(ps); break; }
          }
          if (liveSize > 0) {
            log.error(`[SL-SAFETY-CLOSE-BINGX] ${bingxSymbol}: position alive size=${pyFloatStr(liveSize)} without SL — emergency reduceOnly close`);
            const clResp = await closePosition(apiKey, secret, symbol, direction, liveSize);
            if (pyTruthy(pyGet(clResp, 'ok'))) log.error(`[SL-SAFETY-CLOSE-BINGX-OK] ${bingxSymbol}: closed via market (qty=${pyFloatStr(liveSize)}) — user saved from naked exposure`);
            else log.error(`[SL-SAFETY-CLOSE-BINGX-FAIL] ${bingxSymbol}: emergency close rejected: ${pyStr(pyGet(clResp, 'error', 'unknown'))} — BE-monitor takes over`);
          }
        } catch (se) {
          log.error(`[SL-SAFETY-CLOSE-BINGX-EXC] ${bingxSymbol}: ${errStr(se)} — BE-monitor takes over`);
        }
        return {
          ok: false,
          error: `SL-ордер не выставлен после 3 попыток. Ордер на ${bingxSymbol} отменён для безопасности. Попробуйте ещё раз.`,
        };
      }

      let tpCountOk = 0;
      let tpCountExpected = 0;
      const tpExpected = [];
      let tpList;
      if (pyTruthy(tp2) && tp2 > 0) {
        const qtyTp2F = qtyFloat * 0.25;
        const qtyTp3F = (pyTruthy(tp3) && tp3 > 0) ? qtyFloat * 0.25 : 0.0;
        const qtyTp2S = PP.roundQty(qtyTp2F, qtyStep);
        const qtyTp3S = qtyTp3F > 0 ? PP.roundQty(qtyTp3F, qtyStep) : '0';
        const qtyTp1F = qtyFloat - pyFloat(qtyTp2S) - pyFloat(qtyTp3S);
        const qtyTp1S = PP.roundQty(Math.max(qtyTp1F, qtyStep), qtyStep);
        tpList = [[tp1, qtyTp1S, '50%'], [tp2, qtyTp2S, '25%']];
        if (pyTruthy(tp3) && tp3 > 0 && pyFloat(qtyTp3S) > 0) tpList.push([tp3, qtyTp3S, '25%']);
      } else {
        tpList = [[tp1, qtyStr, '100%']];
      }
      for (let pos = 0; pos < tpList.length; pos++) {
        const [tpPrice, tpQtyS, pct] = tpList[pos];
        if (!pyTruthy(tpPrice) || tpPrice <= 0 || pyFloat(tpQtyS) <= 0) continue;
        tpCountExpected += 1;
        const tpParams = {
          symbol: bingxSymbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', quantity: tpQtyS,
          stopPrice: PP.roundPriceTp(tpPrice, tickSize, direction), workingType: 'MARK_PRICE',
        };
        tpParams.positionSide = hedgeMode ? posSide : 'BOTH';
        const tpCid = pos < cidTp.length ? cidTp[pos] : '';
        if (tpCid) tpParams.clientOrderId = tpCid;
        let tpOk = false;
        let lastTpErr = '';
        let a = 0;
        for (a = 0; a < 5; a++) {
          let tpResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, tpParams);
          if (pyGet(tpResp, 'code') === 109400) {
            delete tpParams.positionSide;
            tpResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, tpParams);
          }
          if (pyGet(tpResp, 'code') === 0) { tpOk = true; break; }
          lastTpErr = pyStr(tpResp);
          const code = pyGet(tpResp, 'code');
          const tpMsgL = pyLower(pyStr(pyGet(tpResp, 'msg', '')));
          if (code === 109400 || code === 110424) {
            log.warning(`[BINGX-TP-DEBUG] ${bingxSymbol} qty=${pyRepr(pyGet(tpParams, 'quantity'))} sl=${pyRepr(pyGet(tpParams, 'stopPrice'))} side=${pyStr(pyGet(tpParams, 'side'))} posSide=${pyStr(pyGet(tpParams, 'positionSide'))} code=${pyStr(code)} msg=${pyRepr(pyGet(tpResp, 'msg'))} attempt=${a + 1}`);
          }
          if (tpCid && (code === 101204 || code === 101404 || tpMsgL.includes('duplicate'))) {
            log.info(`TP duplicate rejected (idempotency works): ${bingxSymbol} cid=${tpCid}`);
            tpOk = true;
            break;
          }
          if ((code === 110413 || code === 110414) && a < 3) {
            let newTp = null;
            try {
              const cur = await getLastPrice(apiKey, secret, symbol);
              if (pyTruthy(cur) && cur > 0) {
                const gap = 0.015;
                newTp = code === 110413 ? cur * (1 + gap) : cur * (1 - gap);
                log.info(`[TP-ADAPTIVE-SHIFT] BingX ${bingxSymbol} code=${pyStr(code)} tp=${pyStr(tpParams.stopPrice)} → ${fmtG(newTp, 6)} (current=${fmtG(cur, 6)}, gap=1.5%)`);
              }
            } catch (ge) {
              log.debug(`BingX adaptive TP fetch price: ${errStr(ge)}`);
            }
            if (newTp === null) {
              const adjPct = 0.005 * (a + 1);
              const adj = code === 110413 ? (1 + adjPct) : (1 - adjPct);
              newTp = pyFloat(tpParams.stopPrice) * adj;
            }
            tpParams.stopPrice = PP.roundPrice(newTp, tickSize);
            log.debug(`BingX TP@${pyFloatStr(tpPrice)} adjusted to ${tpParams.stopPrice} (${pyStr(code)} retry ${a + 1})`);
            continue;
          }
          await rt.sleep(2.0);
        }
        if (tpOk) {
          tpCountOk += 1;
          log.info(`BingX TP placed: ${bingxSymbol} @${pyStr(pyGet(tpParams, 'stopPrice'))} (${pct}) attempts=${a + 1}`);
          tpExpected.push([closeSide, pyFloat(tpParams.stopPrice), pct]);
        } else {
          log.warning(`BingX TP@${pyFloatStr(tpPrice)} (${pct}) ${bingxSymbol} failed after 5 attempts: ${pySlice(lastTpErr, 200)}`);
        }
      }
      const tpPlaced = tpCountExpected > 0 && tpCountOk === tpCountExpected;
      if (tpCountExpected > 0 && tpCountOk < tpCountExpected) log.warning(`BingX TP partial fail [${bingxSymbol}]: ${tpCountOk}/${tpCountExpected} placed`);

      if (tpPlaced && tpExpected.length) {
        try {
          await rt.sleep(2.0);
          const verifyData = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, { symbol: bingxSymbol });
          const liveOrders = pyGet(verifyData, 'code') === 0 ? pyGet(pyGet(verifyData, 'data', {}), 'orders', []) : [];
          const liveTp = pyIter(liveOrders).filter((x) => pyGet(x, 'type') === 'TAKE_PROFIT_MARKET' && pyUpper(pyStr(pyGet(x, 'side', ''))) === closeSide).length;
          const missing = tpExpected.length - liveTp;
          if (missing > 0) {
            log.warning(`[TP-PHANTOM] BingX ${bingxSymbol}: expected ${tpExpected.length} TP orders, only ${liveTp} on exchange — retrying missing ${missing}`);
            for (const [s, stopPrice, lbl] of tpExpected.slice(-missing)) {
              const rtParams = {
                symbol: bingxSymbol, side: s, type: 'TAKE_PROFIT_MARKET', quantity: qtyStr, stopPrice: fstr(stopPrice), workingType: 'MARK_PRICE',
              };
              rtParams.positionSide = hedgeMode ? posSide : 'BOTH';
              const rtResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, rtParams);
              if (pyGet(rtResp, 'code') === 0) log.info(`[TP-RETRY] BingX ${bingxSymbol} @${pyFloatStr(stopPrice)} (${lbl}): recovered`);
              else log.warning(`[TP-RETRY] BingX ${bingxSymbol} @${pyFloatStr(stopPrice)} fail: ${pyStr(rtResp)}`);
            }
          } else {
            log.debug(`[TP-VERIFIED] BingX ${bingxSymbol}: ${liveTp}/${tpExpected.length} TPs on exchange`);
          }
        } catch (ve) {
          log.debug(`TP verify ${bingxSymbol}: ${errStr(ve)}`);
        }
      }
      await recordPlaced(rt, { symbol, direction, exchange: 'bingx', t0, tpPlaced });
      return { ok: true, order_id: orderId, error: '', tp_placed: tpPlaced, qty: pyFloat(qtyStr) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, order_id: '', error: 'Таймаут соединения с BingX. Попробуйте позже.' };
      log.error(`BingX place_trade ${symbol}: ${errStr(e)}`);
      return { ok: false, order_id: '', error: errStr(e) };
    }
  }

  async function getPositions(apiKey, secret, symbol = null) {
    try {
      const params = {};
      if (pyTruthy(symbol)) params.symbol = toBingxSymbol(symbol);
      const data = await _request('GET', '/openApi/swap/v2/user/positions', apiKey, secret, params);
      if (pyGet(data, 'code') !== 0) {
        log.warning(`BingX get_positions: ${pyStr(data)}`);
        return [];
      }
      const positions = [];
      for (const p of pyIter(pyGet(data, 'data', []))) {
        const size = pyFloat(pyOr(pyGet(p, 'positionAmt', 0), 0));
        if (size === 0) continue;
        positions.push({
          symbol: pyGet(p, 'symbol', ''),
          side: pyGet(p, 'positionSide', 'LONG'),
          size: Math.abs(size),
          entryPrice: pyFloat(pyOr(pyGet(p, 'avgPrice', 0), 0)),
          markPrice: pyFloat(pyOr(pyGet(p, 'markPrice', 0), 0)),
          unrealisedPnl: pyFloat(pyOr(pyGet(p, 'unrealizedProfit', 0), 0)),
          leverage: pyInt(pyOr(pyGet(p, 'leverage', 1), 1)),
          stopLoss: pyFloat(pyOr(pyGet(p, 'stopLoss', 0), 0)),
          positionIdx: 0,
        });
      }
      return positions;
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') { log.warning('BingX get_positions: таймаут'); return []; }
      log.error(`BingX get_positions: ${errStr(e)}`);
      return [];
    }
  }

  const EMPTY_SUMMARY = () => ({ equity: 0.0, unrealized_pnl: 0.0, available: 0.0, closed_pnl_24h: 0.0, trades_24h: 0, wins_24h: 0 });

  async function getDashboard(apiKey, secret) {
    try {
      const positions = await getPositions(apiKey, secret);
      const ordData = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, {});
      const orders = [];
      if (pyGet(ordData, 'code') === 0) {
        for (const o of pyIter(pyGet(pyGet(ordData, 'data', {}), 'orders', []))) {
          orders.push({
            orderId: pyStr(pyGet(o, 'orderId', '')),
            symbol: pyGet(o, 'symbol', ''),
            side: pyGet(o, 'side', ''),
            type: pyGet(o, 'type', ''),
            price: pyFloat(pyOr(pyGet(o, 'price', 0), 0)),
            origQty: pyFloat(pyOr(pyGet(o, 'origQty', 0), 0)),
            stopPrice: pyFloat(pyOr(pyGet(o, 'stopPrice', 0), 0)),
          });
        }
      }
      const balData = await _request('GET', '/openApi/swap/v2/user/balance', apiKey, secret);
      const summary = EMPTY_SUMMARY();
      if (pyGet(balData, 'code') === 0) {
        const b = pyIndex(pyIndex(balData, 'data'), 'balance');
        summary.equity = pyFloat(pyOr(pyGet(b, 'equity', 0), 0));
        summary.unrealized_pnl = pyFloat(pyOr(pyGet(b, 'unrealizedProfit', 0), 0));
        summary.available = pyFloat(pyOr(pyGet(b, 'availableMargin', 0), 0));
      }
      const ts24h = Math.trunc((rt.now() - 86400) * 1000);
      const histData = await _request('GET', '/openApi/swap/v2/trade/allFillOrders', apiKey, secret, {
        startTs: String(ts24h), endTs: String(Math.trunc(rt.now() * 1000)), limit: '100',
      });
      if (pyGet(histData, 'code') === 0) {
        const fills = pyOr(pyGet(pyGet(histData, 'data', {}), 'fill_orders', []), []);
        const pnls = pyIter(fills).map((f) => pyFloat(pyOr(pyGet(f, 'profit', 0), 0)));
        summary.closed_pnl_24h = pySum(pnls);
        summary.trades_24h = pnls.length;
        summary.wins_24h = pnls.filter((p) => p > 0).length;
      }
      return [positions, orders, summary];
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') { log.warning('BingX get_dashboard: таймаут'); return [[], [], EMPTY_SUMMARY()]; }
      log.error(`BingX get_dashboard: ${errStr(e)}`);
      return [[], [], EMPTY_SUMMARY()];
    }
  }

  async function closePosition(apiKey, secret, symbol, side, size, posIdx = 0) {
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const closeSide = pyUpper(pyStr(side)) === 'LONG' ? 'SELL' : 'BUY';
      const posSide = pyUpper(pyStr(side));
      let roundedQty = fstr(size);
      try {
        const [qtyStep] = await _getInstrumentFilters(bingxSymbol);
        if (pyTruthy(qtyStep) && qtyStep > 0) {
          const q = pyTruthy(size) ? pyFloat(size) : 0.0;
          if (q > 0) {
            roundedQty = PP.roundQty(q, qtyStep);
            if (pyFloat(roundedQty) <= 0) {
              log.warning(`BingX close_position ${symbol}: qty=${fstr(size)} rounded to 0 (step=${pyFloatStr(qtyStep)}) — skip (position smaller than min lot)`);
              return { ok: false, order_id: '', error: 'qty rounded to 0 (below lot step)', skipped: true };
            }
            if (roundedQty !== fstr(size)) log.debug(`BingX close_position ${symbol}: qty rounded ${fstr(size)} → ${roundedQty} (step=${pyFloatStr(qtyStep)})`);
          }
        }
      } catch (er) {
        log.debug(`BingX close_position ${symbol}: qty rounding failed (${errStr(er)}) — sending raw ${fstr(size)}`);
      }
      const params = { symbol: bingxSymbol, side: closeSide, type: 'MARKET', quantity: roundedQty, positionSide: posSide };
      let resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, params);
      if (pyGet(resp, 'code') === 109400) {
        params.positionSide = 'BOTH';
        params.reduceOnly = 'true';
        resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, params);
      }
      if (pyGet(resp, 'code') === 0) {
        return { ok: true, order_id: pyStr(pyGet(pyGet(pyGet(resp, 'data', {}), 'order', {}), 'orderId', '')) };
      }
      return { ok: false, order_id: '', error: humanizeBingxError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, order_id: '', error: 'Таймаут соединения с BingX.' };
      log.error(`BingX close_position: ${errStr(e)}`);
      return { ok: false, order_id: '', error: errStr(e) };
    }
  }

  async function getOpenOrders(apiKey, secret) {
    try {
      const data = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, {});
      if (pyGet(data, 'code') === 0) return pyOr(pyGet(pyGet(data, 'data', {}), 'orders', []), []);
    } catch (e) {
      log.error(`BingX get_open_orders: ${errStr(e)}`);
    }
    return [];
  }

  async function cancelOrder(apiKey, secret, symbol, orderId) {
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const resp = await _request('DELETE', '/openApi/swap/v2/trade/order', apiKey, secret, { symbol: bingxSymbol, orderId: pyStr(orderId) });
      if (pyGet(resp, 'code') === 0) return { ok: true };
      return { ok: false, error: humanizeBingxError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, error: 'Таймаут соединения с BingX.' };
      log.error(`BingX cancel_order ${symbol} ${pyStr(orderId)}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function _cancelAllOrdersInner(apiKey, secret, symbol) {
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const resp = await _request('DELETE', '/openApi/swap/v2/trade/allOpenOrders', apiKey, secret, { symbol: bingxSymbol });
      if (pyGet(resp, 'code') === 0) return { ok: true, cancelled: pyLen(pyOr(pyGet(pyGet(resp, 'data', {}), 'orders', []), [])) };
      return { ok: false, cancelled: 0, error: humanizeBingxError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, cancelled: 0, error: 'Таймаут соединения с BingX.' };
      log.error(`BingX cancel_all_orders: ${errStr(e)}`);
      return { ok: false, cancelled: 0, error: errStr(e) };
    }
  }

  async function cancelAllOrders(apiKey, secret, symbol) {
    return callWithRetry(_cancelAllOrdersInner, {
      args: [apiKey, secret, symbol], maxAttempts: 3, baseBackoff: 0.3, opName: `bingx_cancel_all_${symbol}`, sleep: rt.sleep, random: rt.random, log,
    });
  }

  async function cancelTpOrdersOnly(apiKey, secret, symbol) {
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const resp = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, { symbol: bingxSymbol });
      if (pyGet(resp, 'code') !== 0) return { ok: false, cancelled: 0, error: humanizeBingxError(pyStr(resp)) };
      const orders = pyOr(pyGet(pyGet(resp, 'data', {}), 'orders', []), []);
      const tpOrders = pyIter(orders).filter((x) => pyUpper(pyStr(pyGet(x, 'type', ''))) === 'TAKE_PROFIT_MARKET');
      let cancelled = 0;
      const errors = [];
      for (const x of pyIter(tpOrders)) {
        const oid = pyStr(pyOr(pyGet(x, 'orderId', ''), ''));
        if (!oid) continue;
        const cr = await cancelOrder(apiKey, secret, symbol, oid);
        if (pyTruthy(pyGet(cr, 'ok'))) cancelled += 1;
        else errors.push(pyGet(cr, 'error', '?'));
      }
      return { ok: true, cancelled, total_tp: tpOrders.length, errors };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, cancelled: 0, error: 'Таймаут соединения с BingX.' };
      log.error(`BingX cancel_tp_orders_only: ${errStr(e)}`);
      return { ok: false, cancelled: 0, error: errStr(e) };
    }
  }

  async function setBreakeven(apiKey, secret, symbol, entry, direction, posIdx = 0) {
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const posSide = direction === 'LONG' ? 'LONG' : 'SHORT';
      const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const [qtyStep, tickSize] = await _getInstrumentFilters(bingxSymbol);
      const ordData = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, { symbol: bingxSymbol });
      if (pyGet(ordData, 'code') === 0) {
        for (const x of pyIter(pyGet(pyGet(ordData, 'data', {}), 'orders', []))) {
          if (pyGet(x, 'type') === 'STOP_MARKET' && pyUpper(pyStr(pyGet(x, 'side', ''))) === closeSide) {
            await _request('DELETE', '/openApi/swap/v2/trade/order', apiKey, secret, { symbol: bingxSymbol, orderId: pyStr(pyGet(x, 'orderId', '')) });
          }
        }
      }
      const positions = await getPositions(apiKey, secret, symbol);
      const pos = positions.find((p) => [posSide, 'BOTH'].includes(pyUpper(pyStr(p.side)))) || null;
      if (!pos) return { ok: true };
      const posSizeS = PP.roundQty(pos.size, qtyStep);
      if (pyFloat(posSizeS) <= 0) {
        log.info(`BingX set_breakeven ${bingxSymbol}: qty rounded to 0 (pos_size=${pyFloatStr(pos.size)} qty_step=${pyFloatStr(qtyStep)}) — skip; original SL остаётся действовать`);
        return { ok: false, error: 'position smaller than minimum step (BE skipped)', skipped: true };
      }
      const actualPosSide = pyUpper(pyStr(pos.side)) === 'BOTH' ? pyUpper(pyStr(pos.side)) : posSide;
      const pmult = bingxPriceMultiplier(symbol);
      const slParams = {
        symbol: bingxSymbol, side: closeSide, type: 'STOP_MARKET', quantity: posSizeS,
        stopPrice: PP.roundPrice(entry * pmult, tickSize), workingType: 'MARK_PRICE', positionSide: actualPosSide,
      };
      let resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, slParams);
      if (pyGet(resp, 'code') === 109400) {
        slParams.positionSide = 'BOTH';
        resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, slParams);
      }
      if (pyGet(resp, 'code') === 0) return { ok: true };
      log.warning(`BingX set_breakeven ${bingxSymbol}: ${pyStr(resp)}`);
      return { ok: false, error: humanizeBingxError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, error: 'Таймаут соединения с BingX.' };
      log.error(`BingX set_breakeven ${symbol}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function setTrailingSl(apiKey, secret, symbol, newSl, direction, posIdx = 0) {
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const posSide = direction === 'LONG' ? 'LONG' : 'SHORT';
      const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const [qtyStep, tickSize] = await _getInstrumentFilters(bingxSymbol);
      let pos = null;
      let posLastErr = '';
      for (let i = 0; i < 3; i++) {
        try {
          const positions = await getPositions(apiKey, secret, symbol);
          pos = positions.find((p) => [posSide, 'BOTH'].includes(pyUpper(pyStr(p.side)))) || null;
          if (pos) break;
          posLastErr = 'empty positions';
        } catch (e) {
          log.error('bingx_trader.set_trailing_sl() unhandled exception');
          posLastErr = pySlice(errStr(e), 100);
        }
        await rt.sleep(2.0);
      }
      if (!pos) {
        log.warning(`BingX set_trailing_sl ${bingxSymbol}: не нашли позицию (${posLastErr}) — SL НЕ переставлен, retry next cycle`);
        return { ok: false, error: 'position not confirmed' };
      }
      const posSizeS = PP.roundQty(pos.size, qtyStep);
      const actualPosSide = pyUpper(pyStr(pos.side)) === 'BOTH' ? pyUpper(pyStr(pos.side)) : posSide;
      const pmult = bingxPriceMultiplier(symbol);
      let posSizeFloat;
      try { posSizeFloat = pyFloat(posSizeS); } catch (_e) { posSizeFloat = 0.0; }
      if (posSizeFloat <= 0) {
        log.debug(`BingX set_trailing_sl ${bingxSymbol}: qty rounded to 0 (pos_size=${pyFloatStr(pos.size)} qty_step=${pyFloatStr(qtyStep)}) — trail update skipped; оригинальный SL со стороны биржи продолжает действовать`);
        return { ok: false, error: 'position smaller than minimum step (trail skipped)', skipped: true };
      }
      const slParams = {
        symbol: bingxSymbol, side: closeSide, type: 'STOP_MARKET', quantity: posSizeS,
        stopPrice: PP.roundPriceSl(newSl * pmult, tickSize, direction), workingType: 'MARK_PRICE', positionSide: actualPosSide,
      };
      let newSlId = '';
      let newErr = '';
      let lastCode = 0;
      for (let i = 0; i < 3; i++) {
        let resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, slParams);
        if (pyGet(resp, 'code') === 109400) {
          slParams.positionSide = 'BOTH';
          resp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, slParams);
        }
        if (pyGet(resp, 'code') === 0) {
          newSlId = pyStr(pyGet(pyGet(pyOr(pyGet(resp, 'data'), {}), 'order', {}), 'orderId', ''));
          break;
        }
        newErr = pySlice(pyStr(resp), 200);
        try { lastCode = pyInt(pyOr(pyGet(resp, 'code'), 0)); } catch (_e) { lastCode = 0; }
        if (lastCode === 110424) break;
        if (lastCode === 109500) { await rt.sleep(3.0); continue; }
        await rt.sleep(1.5);
      }
      if (!newSlId) {
        if (lastCode === 110424) log.info(`BingX set_trailing_sl ${bingxSymbol}: skip trail (110424 order size > available — original SL remains in effect)`);
        else log.warning(`BingX set_trailing_sl ${bingxSymbol} failed 3x: ${newErr}`);
        return { ok: false, error: humanizeBingxError(newErr), code: lastCode };
      }
      try {
        const ordData = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, { symbol: bingxSymbol });
        if (pyGet(ordData, 'code') === 0) {
          for (const x of pyIter(pyGet(pyGet(ordData, 'data', {}), 'orders', []))) {
            const oid = pyStr(pyGet(x, 'orderId', ''));
            if (pyGet(x, 'type') === 'STOP_MARKET' && pyUpper(pyStr(pyGet(x, 'side', ''))) === closeSide && oid !== newSlId) {
              try {
                const delResp = await _request('DELETE', '/openApi/swap/v2/trade/order', apiKey, secret, { symbol: bingxSymbol, orderId: oid });
                const delCode = pyGet(delResp, 'code');
                if (delCode === 109400) log.debug(`BingX set_trailing_sl ${bingxSymbol}: old SL id=${oid} already gone (109400 'order not exist') — benign race, treating as success`);
                else if (!(delCode === 0 || delCode === null)) log.warning(`BingX set_trailing_sl ${bingxSymbol}: cancel old SL id=${oid} failed: ${pyStr(delResp)}`);
              } catch (de) {
                log.warning(`BingX set_trailing_sl ${bingxSymbol}: cancel old SL id=${oid}: ${errStr(de)}`);
              }
            }
          }
        }
      } catch (ce) {
        log.warning(`BingX set_trailing_sl ${bingxSymbol}: list openOrders: ${errStr(ce)}`);
      }
      return { ok: true };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, error: 'Таймаут соединения с BingX.' };
      log.error(`BingX set_trailing_sl ${symbol}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function placeSlTpForPosition(apiKey, secret, symbol, direction, posSize, sl, tp1, tp2 = 0.0, tp3 = 0.0) {
    try {
      const bingxSymbol = toBingxSymbol(symbol);
      const posSide = direction === 'LONG' ? 'LONG' : 'SHORT';
      const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const [qtyStep, tickSize] = await _getInstrumentFilters(bingxSymbol);
      const qtyStr = PP.roundQty(posSize, qtyStep);
      let slPlaced = false;
      let tpPlaced = false;
      const pmult = bingxPriceMultiplier(symbol);
      let newSlId = '';
      if (sl > 0) {
        const slParams = {
          symbol: bingxSymbol, side: closeSide, type: 'STOP_MARKET', quantity: qtyStr,
          stopPrice: PP.roundPriceSl(sl * pmult, tickSize, direction), workingType: 'MARK_PRICE', positionSide: posSide,
        };
        let slResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, slParams);
        if (pyGet(slResp, 'code') === 109400) {
          slParams.positionSide = 'BOTH';
          slResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, slParams);
        }
        if (pyGet(slResp, 'code') === 0) {
          slPlaced = true;
          newSlId = pyStr(pyGet(pyGet(pyGet(slResp, 'data', {}), 'order', {}), 'orderId', ''));
        } else {
          log.warning(`BingX place_sl_tp_for_position SL ${bingxSymbol}: ${pyStr(slResp)}`);
        }
      }
      try {
        const ordData = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, { symbol: bingxSymbol });
        if (pyGet(ordData, 'code') === 0) {
          for (const x of pyIter(pyGet(pyGet(ordData, 'data', {}), 'orders', []))) {
            if (pyUpper(pyStr(pyGet(x, 'side', ''))) !== closeSide) continue;
            if (!['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(pyGet(x, 'type'))) continue;
            const oid = pyStr(pyGet(x, 'orderId', ''));
            if (newSlId && oid === newSlId) continue;
            try {
              await _request('DELETE', '/openApi/swap/v2/trade/order', apiKey, secret, { symbol: bingxSymbol, orderId: oid });
            } catch (de) {
              log.warning(`BingX cancel old SL/TP ${bingxSymbol} id=${oid}: ${errStr(de)}`);
            }
          }
        }
      } catch (le) {
        log.warning(`BingX list open orders ${bingxSymbol}: ${errStr(le)}`);
      }
      let tpList;
      if (pyTruthy(tp2) && tp2 > 0) {
        const q2 = PP.roundQty(posSize * 0.25, qtyStep);
        const q3 = (pyTruthy(tp3) && tp3 > 0) ? PP.roundQty(posSize * 0.25, qtyStep) : '0';
        const q1f = posSize - pyFloat(q2) - pyFloat(q3);
        tpList = [[tp1, PP.roundQty(Math.max(q1f, qtyStep), qtyStep)], [tp2, q2]];
        if (pyTruthy(tp3) && tp3 > 0 && pyFloat(q3) > 0) tpList.push([tp3, q3]);
      } else {
        tpList = [[tp1, qtyStr]];
      }
      let tpExpectedCount = 0;
      for (const [tpPrice, tpQtyS] of tpList) {
        if (!pyTruthy(tpPrice) || tpPrice <= 0 || pyFloat(tpQtyS) <= 0) continue;
        const tpParams = {
          symbol: bingxSymbol, side: closeSide, type: 'TAKE_PROFIT_MARKET', quantity: tpQtyS,
          stopPrice: PP.roundPriceTp(tpPrice * pmult, tickSize, direction), workingType: 'MARK_PRICE', positionSide: posSide,
        };
        let tpOk = false;
        let lastErr = '';
        for (let a = 0; a < 3; a++) {
          let tpResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, tpParams);
          if (pyGet(tpResp, 'code') === 109400) {
            tpParams.positionSide = 'BOTH';
            tpResp = await _request('POST', '/openApi/swap/v2/trade/order', apiKey, secret, tpParams);
          }
          if (pyGet(tpResp, 'code') === 0) { tpOk = true; break; }
          lastErr = pyStr(tpResp);
          const code = pyGet(tpResp, 'code');
          if (code === 109420) break;
          if (code === 110413 && a < 2) {
            const adj = closeSide === 'SELL' ? 1.0015 : 0.9985;
            tpParams.stopPrice = PP.roundPrice(pyFloat(tpParams.stopPrice) * adj, tickSize);
            continue;
          }
          await rt.sleep(1.5);
        }
        if (tpOk) { tpPlaced = true; tpExpectedCount += 1; } else {
          log.warning(`BingX place_sl_tp_for_position TP@${pyFloatStr(tpPrice)} ${bingxSymbol}: ${pySlice(lastErr, 200)}`);
        }
      }
      if (tpPlaced && tpExpectedCount > 0) {
        try {
          await rt.sleep(2.0);
          const vd = await _request('GET', '/openApi/swap/v2/trade/openOrders', apiKey, secret, { symbol: bingxSymbol });
          const liveO = pyGet(vd, 'code') === 0 ? pyGet(pyGet(vd, 'data', {}), 'orders', []) : [];
          const liveTp = pyIter(liveO).filter((x) => pyGet(x, 'type') === 'TAKE_PROFIT_MARKET' && pyUpper(pyStr(pyGet(x, 'side', ''))) === closeSide).length;
          if (liveTp < tpExpectedCount) {
            log.warning(`[TP-PHANTOM] BingX ${bingxSymbol} (post-fill): expected ${tpExpectedCount} TP, only ${liveTp} on exchange`);
            tpPlaced = false;
          } else {
            log.debug(`[TP-VERIFIED] BingX ${bingxSymbol} (post-fill): ${liveTp}/${tpExpectedCount}`);
          }
        } catch (ve) {
          log.debug(`BingX post-fill TP verify ${bingxSymbol}: ${errStr(ve)}`);
        }
      }
      return { sl_placed: slPlaced, tp_placed: tpPlaced };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') { log.warning(`BingX place_sl_tp_for_position ${symbol}: таймаут`); return { sl_placed: false, tp_placed: false }; }
      log.error(`BingX place_sl_tp_for_position ${symbol}: ${errStr(e)}`);
      return { sl_placed: false, tp_placed: false };
    }
  }

  async function getBalance(apiKey, secret) {
    try {
      const data = await _request('GET', '/openApi/swap/v2/user/balance', apiKey, secret);
      if (pyGet(data, 'code') === 0) {
        const b = pyIndex(pyIndex(data, 'data'), 'balance');
        return pyFloat(pyOr(pyGet(b, 'equity', 0), 0));
      }
      log.warning(`BingX get_balance: ${pyStr(data)}`);
      return 0.0;
    } catch (e) {
      log.error(`BingX get_balance: ${errStr(e)}`);
      return 0.0;
    }
  }

  async function getLastPrice(apiKey, secret, symbol) {
    try {
      const data = await _request('GET', '/openApi/swap/v2/quote/price', apiKey, secret, { symbol: toBingxSymbol(symbol) });
      return pyFloat(pyOr(pyGet(pyGet(data, 'data', {}), 'price', 0), 0));
    } catch (e) {
      log.debug(`get_last_price BingX ${symbol}: ${errStr(e)}`);
    }
    return 0.0;
  }

  async function getClosedPnl(apiKey, secret, symbol) {
    try {
      const data = await _request('GET', '/openApi/swap/v2/trade/allOrders', apiKey, secret, { symbol: toBingxSymbol(symbol), limit: '20' });
      const orders = pyOr(pyGet(pyGet(data, 'data', {}), 'orders', []), []);
      const result = [];
      for (const o of pyIter(orders)) {
        const side = pyGet(o, 'side', '');
        const avgPrice = pyFloat(pyOr(pyGet(o, 'avgPrice'), pyGet(o, 'price'), 0));
        const updatedTime = pyFloat(pyOr(pyGet(o, 'updateTime'), pyGet(o, 'time'), 0));
        if (avgPrice <= 0) continue;
        const profitRaw = pyGet(o, 'profit');
        let profit;
        try { profit = (profitRaw === null || profitRaw === '') ? null : pyFloat(profitRaw); } catch (e) {
          if (e && (e.pyType === 'TypeError' || e.pyType === 'ValueError')) profit = null; else throw e;
        }
        result.push({
          side: pyUpper(pyStr(side)).includes('BUY') ? 'Buy' : 'Sell',
          avgExitPrice: avgPrice,
          updatedTime,
          closedPnl: profit,
          orderLinkId: pyStr(pyOr(pyGet(o, 'clientOrderId', ''), '')),
        });
      }
      return result;
    } catch (e) {
      log.debug(`get_closed_pnl BingX ${symbol}: ${errStr(e)}`);
    }
    return [];
  }

  return {
    rt, _state: st,
    placeTrade, getPositions, getDashboard, closePosition, getOpenOrders, cancelOrder, cancelAllOrders, cancelTpOrdersOnly,
    setBreakeven, setTrailingSl, placeSlTpForPosition, getBalance, getLastPrice, getClosedPnl, testConnection, syncTime,
    _request, _buildQuery, _getInstrumentFilters, _getServerTime, _cancelAllOrdersInner,
  };
}

function formatTradeResult(result, direction, symbol, entry, sl, tp1, riskPct, leverage, tp2 = 0.0, tp3 = 0.0) {
  const fp = PP.fmtPriceDisplay;
  const dirEmoji = ['LONG', 'BUY'].includes(pyUpper(String(direction))) ? '🟢 LONG' : '🔴 SHORT';
  const bingxSym = toBingxSymbol(symbol);
  if (pyTruthy(pyGet(result, 'ok'))) {
    const orderId = htmlEscape(pyStr(pyGet(result, 'order_id', '—')));
    let tp1Line;
    let tp2Line;
    let tp3Line;
    let beNote;
    if (pyTruthy(tp2)) {
      tp1Line = `\n🎯 TP1: <code>${fp(tp1)}</code>  (50% позиции)`;
      tp2Line = `\n🎯 TP2: <code>${fp(tp2)}</code>  (25% позиции)`;
      tp3Line = pyTruthy(tp3) ? `\n🏆 TP3: <code>${fp(tp3)}</code>  (25% позиции)` : '';
      beNote = '\n♻️ <i>После TP1 — стоп перенесётся в БУ</i>';
    } else {
      tp1Line = `\n🎯 TP1: <code>${fp(tp1)}</code>`;
      tp2Line = '';
      tp3Line = '';
      beNote = '';
    }
    const qtyV = pyGet(result, 'qty', '?');
    const qty = typeof qtyV === 'number' ? pyFloatStr(qtyV) : pyStr(qtyV);
    const notional = pyFloat(pyOr(pyGet(result, 'qty', 0), 0)) * entry;
    const notionalStr = notional > 0 ? `~$${fmtComma(notional, 2)}` : '';
    return '✅ <b>BingX: сделка открыта</b>\n'
      + '━━━━━━━━━━━━━━━━━━━━━━\n'
      + `${dirEmoji}  <b>${bingxSym}</b>  x${leverage}\n`
      + `💵 Вход: <code>${fp(entry)}</code>\n`
      + `🛑 SL:   <code>${fp(sl)}</code>`
      + `${tp1Line}${tp2Line}${tp3Line}`
      + `${beNote}\n`
      + `📊 Qty: ${qty}  (${notionalStr})\n`
      + `⚖️ Риск: ${pyFloatStr(riskPct)}%\n`
      + `🆔 <code>${orderId}</code>`;
  }
  const error = htmlEscape(pyStr(pyGet(result, 'error', 'Неизвестная ошибка')));
  return `❌ <b>BingX: ошибка открытия сделки</b>\n${dirEmoji}  <b>${bingxSym}</b>\n⚠️ ${error}`;
}

let _default = null;
function defaultTrader() {
  if (!_default) _default = createBingxTrader();
  return _default;
}

module.exports = {
  createBingxTrader, defaultTrader, BASE_URL, MIN_NOTIONAL, MAX_LEVERAGE, RECV_WINDOW, TAKER_FEE, MAKER_FEE, BINGX_ERROR_MAP,
  humanizeBingxError, toBingxSymbol, bingxPriceMultiplier, bingxSign, bingxQueryString, formatTradeResult, PyError,
};
