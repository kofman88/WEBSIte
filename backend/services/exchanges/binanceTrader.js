'use strict';
/**
 * binanceTrader.js — one-to-one port of `binance_trader.py` (Binance USDⓈ-M Futures, fapi).
 *
 * Auth: `urlencode(params + timestamp + recvWindow=5000)` → HMAC-SHA256 hex → `&signature=`,
 * header X-MBX-APIKEY. The URL is a plain str handed to aiohttp, so yarl REQUOTES the query
 * on the wire (%3A → ':', %2C → ',' …) — e.g. the batchOrders JSON reaches Binance in a
 * different form than the one that was signed. Reproduced (pyCompat.yarlUrl).
 * Errors are dicts with a negative `code`; successes are raw objects / lists.
 *
 * place_trade (spec §14.3): exchangeInfo filters (4 h cache), USDT balance, dual-side
 * position mode (`-4059`/`-4061` + "existing" → one-way, positionSide omitted), leverage
 * with halving on -4028/-4060 (≤ 3 tries), sizing + low-notional skip/boost, deterministic
 * newClientOrderIds, ATOMIC batchOrders with [BINANCE-ATOMIC-OK|FALLBACK], legacy flow:
 * LIMIT within 0.3 % of last price else MARKET (order_type ignored, no fill wait),
 * duplicate -4015 → ok, SL by orderId check ×3 then cancel + [SL-SAFETY-CLOSE-BINANCE*],
 * TPs ×5 with -2021 adaptive re-pricing, all-TP-success rule.
 * `BASE_URL` starts at fapi.binance.com; `findWorkingBinanceUrl()` probes fapi1..4.
 * `baseUrl` option (not in the bot) points a trader instance at the futures testnet.
 */

const { makeRuntime } = require('./runtime');
const { TransportError, aiohttpJson } = require('./transport');
const {
  errStr, pyGet, pyIndex, pyFloat, pyInt, pyStr, pyRepr, pyFloatStr, pyTruthy, pyOr, pyUrlencode, yarlUrl,
  htmlEscape, pySlice, isDict,
  pyIter,
  pyCmp,
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
const { safeKeyId, killswitchGate, planGateDeny, recordPlaced, aioQuery } = require('./traderCommon');

const FALLBACK_URLS = Object.freeze([
  'https://fapi.binance.com',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://fapi3.binance.com',
  'https://fapi4.binance.com',
]);
const MIN_NOTIONAL = 5.0;
const MAX_LEVERAGE = 125;
const RECV_WINDOW = 5000;
const TAKER_FEE = 0.0004;
const MAKER_FEE = 0.0002;
const INSTRUMENT_FILTER_TTL_S = 4 * 3600;

const BINANCE_ERROR_MAP = Object.freeze({
  '-1000': 'Непредвиденная ошибка Binance.',
  '-1001': 'Внутренняя ошибка. Повторите попытку.',
  '-1003': 'Превышен лимит запросов. Подождите и повторите.',
  '-1013': 'Объём ордера ниже минимального (5 USDT).',
  '-1021': 'Неверный timestamp. Проверьте синхронизацию времени.',
  '-1022': 'Неверная подпись. Проверьте API Secret.',
  '-1100': 'Недопустимые параметры ордера.',
  '-1102': 'Обязательный параметр отсутствует.',
  '-1111': 'Неверная точность цены или объёма.',
  '-1121': 'Символ не найден на Binance Futures.',
  '-2010': 'Недостаточно средств на счёте.',
  '-2011': 'Ордер не найден или уже отменён.',
  '-2013': 'Позиция не существует.',
  '-2014': 'Неверный API ключ.',
  '-2015': 'Неверный API ключ или IP не в белом списке.',
  '-3005': 'Недостаточно маржи. Пополните баланс.',
  '-4003': 'Плечо не может быть меньше 1.',
  '-4028': 'Превышен максимальный лимит плеча для данного символа.',
  '-4059': 'Позиция с данным positionSide не найдена.',
  '-4061': 'Режим позиций конфликтует. Убедитесь что включён Hedge Mode.',
});

/** _humanize_binance_error — fed str(dict) by the bot, so the "code" regex rarely matches. */
function humanizeBinanceError(raw) {
  if (!pyTruthy(raw)) return 'Неизвестная ошибка Binance.';
  raw = String(raw);
  const m = /"code"\s*:\s*(-?\d+)/.exec(raw);
  const code = m ? parseInt(m[1], 10) : null;
  if (code && Object.prototype.hasOwnProperty.call(BINANCE_ERROR_MAP, String(code))) return BINANCE_ERROR_MAP[String(code)];
  const mm = /"msg"\s*:\s*"([^"]+)"/.exec(raw);
  if (mm) {
    const msg = mm[1];
    const first = String.fromCodePoint(msg.codePointAt(0));
    return first.toUpperCase() + msg.slice(first.length) + (msg.endsWith('.') ? '' : '.');
  }
  return code ? `Ошибка Binance (код ${code}).` : 'Неизвестная ошибка Binance.';
}

const toBinanceSymbol = sym.toBinanceSymbol;
const binancePriceMultiplier = sym.binancePriceMultiplier;

function binanceSign(queryString, secret) {
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(Buffer.from(queryString, 'utf8')).digest('hex');
}

const EMPTY_SUMMARY = () => ({ equity: 0.0, unrealized_pnl: 0.0, available: 0.0, closed_pnl_24h: 0.0, trades_24h: 0, wins_24h: 0 });

function createBinanceTrader(overrides = {}) {
  const rt = makeRuntime(overrides);
  const log = rt.log;
  const disabled = ['1', 'true', 'yes'].includes(String(rt.env.DISABLE_BINANCE || '').trim());
  const st = {
    baseUrl: overrides.baseUrl || FALLBACK_URLS[0],
    activeBaseUrl: overrides.baseUrl || FALLBACK_URLS[0],
    timeOffsetMs: 0,
    timeSyncedAt: 0.0,
    syncWarnAt: 0.0,
    instrumentFilterCache: new Map(),
  };

  async function findWorkingBinanceUrl() {
    for (const url of FALLBACK_URLS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let resp;
        try {
          resp = await rt.transport({ method: 'GET', url: `${url}/fapi/v1/ping`, headers: {}, timeoutMs: 5000 });
        } catch (e) {
          if (e instanceof TransportError && e.kind === 'connect') {
            if (attempt < 2) { await rt.sleep(1.0 * (2 ** attempt)); continue; }
            log.warning(`⚠️ Binance DNS/connect ${url} failed after 3 retries: ${e.message}`);
            break;
          }
          if (e instanceof TransportError && e.kind === 'timeout') { log.warning(`⚠️ Binance timeout: ${url}`); break; }
          log.error(`binance_trader._find_working_binance_url() unknown error on ${url}: ${errStr(e)}`);
          break;
        }
        if (resp.status === 200) {
          st.activeBaseUrl = url;
          st.baseUrl = url;
          log.info(`✅ Binance active URL: ${url}`);
          return url;
        }
        break;
      }
    }
    log.warning('⚠️ Binance: все endpoints недоступны');
    return st.activeBaseUrl;
  }

  async function syncTime() {
    if (disabled) return st.timeOffsetMs;
    try {
      const localMs = Math.trunc(rt.now() * 1000);
      const r = await rt.transport({ method: 'GET', url: `${st.baseUrl}/fapi/v1/time`, headers: {}, timeoutMs: 5000 });
      const data = aiohttpJson(r);
      const serverMs = pyInt(pyIndex(data, 'serverTime'));
      st.timeOffsetMs = serverMs - localMs;
      st.timeSyncedAt = rt.now();
      log.info(`Binance time sync: offset=${st.timeOffsetMs}ms`);
    } catch (e) {
      const now = rt.now();
      if (now - st.syncWarnAt >= 3600) {
        st.syncWarnAt = now;
        log.warning(`Binance time sync failed (offset=${st.timeOffsetMs}ms): ${errStr(e)}. Если это геоблок VPS — поставь DISABLE_BINANCE=1.`);
      } else {
        log.debug(`Binance time sync failed: ${errStr(e)}`);
      }
    }
    return st.timeOffsetMs;
  }

  function _buildQuery(apiKey, secret, extra) {
    const params = { ...extra };
    params.timestamp = String(Math.trunc(rt.now() * 1000) + st.timeOffsetMs);
    params.recvWindow = String(RECV_WINDOW);
    const qs = pyUrlencode(params);
    const signature = binanceSign(qs, secret);
    return [`${qs}&signature=${signature}`, { 'X-MBX-APIKEY': apiKey }];
  }

  async function _request(method, path, apiKey, secret, params = null, timeout = 15) {
    if (String(apiKey).startsWith('gAAAAA') || String(secret).startsWith('gAAAAA')) {
      return {
        code: -2014,
        msg: 'API ключ повреждён: в БД хранится зашифрованный токен вместо реального ключа. Переустанови ключи через 🔑 Настроить Binance API.',
      };
    }
    const extra = pyTruthy(params) ? params : {};
    const [qs, headers] = _buildQuery(apiKey, secret, extra);
    const url = yarlUrl(`${st.baseUrl}${path}?${qs}`);
    try {
      if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return null;
      const resp = await rt.transport({ method, url, headers, timeoutMs: timeout * 1000 });
      try {
        return aiohttpJson(resp);
      } catch (_je) {
        log.error('binance_trader._request() unhandled exception');
        return { code: -1, msg: `http=${resp.status}; body=${pySlice(resp.text || '', 300)}` };
      }
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { code: -1, msg: 'timeout' };
      log.error('binance_trader._request() unhandled exception');
      return { code: -1, msg: errStr(e) };
    }
  }

  async function _getInstrumentFilters(symbol) {
    const now = rt.now();
    const hit = st.instrumentFilterCache.get(symbol);
    if (hit !== undefined && (now - hit[0]) < INSTRUMENT_FILTER_TTL_S) return hit[1];
    try {
      const resp = await rt.transport({ method: 'GET', url: `${st.baseUrl}/fapi/v1/exchangeInfo`, headers: {}, timeoutMs: 10000 });
      const data = aiohttpJson(resp);
      for (const item of pyIter(pyGet(data, 'symbols', []))) {
        if (pyGet(item, 'symbol') === symbol && pyGet(item, 'status') === 'TRADING') {
          let qtyStep = 0.001;
          let tickSize = 0.0001;
          for (const f of pyIter(pyGet(item, 'filters', []))) {
            const ft = pyGet(f, 'filterType', '');
            if (ft === 'LOT_SIZE') qtyStep = pyFloat(pyOr(pyGet(f, 'stepSize', 0.001), 0.001));
            else if (ft === 'PRICE_FILTER') tickSize = pyFloat(pyOr(pyGet(f, 'tickSize', 0.0001), 0.0001));
          }
          const lb = pyGet(item, 'leverageBracket');
          const maxLev = pyInt(pyTruthy(lb) ? pyGet(pyIndex(pyGet(item, 'leverageBracket', [{}]), 0), 'initialLeverage', MAX_LEVERAGE) : MAX_LEVERAGE);
          const val = [qtyStep, tickSize, true, maxLev];
          st.instrumentFilterCache.set(symbol, [now, val]);
          return val;
        }
      }
    } catch (e) {
      log.debug(`Binance _get_instrument_filters ${symbol}: ${errStr(e)}`);
    }
    return [0.001, 0.0001, false, MAX_LEVERAGE];
  }

  async function getBalance(apiKey, secret) {
    try {
      const data = await _request('GET', '/fapi/v2/balance', apiKey, secret);
      if (Array.isArray(data)) {
        for (const asset of pyIter(data)) if (pyGet(asset, 'asset') === 'USDT') return pyFloat(pyOr(pyGet(asset, 'balance', 0), 0));
      }
      log.warning(`Binance get_balance unexpected: ${pyStr(data)}`);
      return 0.0;
    } catch (e) {
      log.error(`Binance get_balance: ${errStr(e)}`);
      return 0.0;
    }
  }

  async function getLastPrice(apiKey, secret, symbol) {
    try {
      const bs = toBinanceSymbol(symbol);
      const resp = await rt.transport({ method: 'GET', url: `${st.baseUrl}/fapi/v1/ticker/price?${aioQuery({ symbol: bs })}`, headers: {}, timeoutMs: 5000 });
      const data = aiohttpJson(resp);
      return pyFloat(pyOr(pyGet(data, 'price', 0), 0));
    } catch (e) {
      log.debug(`Binance get_last_price ${symbol}: ${errStr(e)}`);
    }
    return 0.0;
  }

  async function testConnection(apiKey, secret) {
    try {
      const data = await _request('GET', '/fapi/v2/balance', apiKey, secret);
      if (Array.isArray(data)) {
        const usdt = data.find((a) => pyGet(a, 'asset') === 'USDT') || null;
        return { ok: true, balance: pyFloat(pyOr(pyGet(pyOr(usdt, {}), 'balance', 0), 0)), error: '' };
      }
      const code = pyGet(data, 'code', 0);
      if (pyTruthy(code) && pyCmp(code, '<', 0)) {
        const err = humanizeBinanceError(pyStr(data));
        log.warning(`Binance test_connection code=${pyStr(code)} key=${safeKeyId(apiKey)}`);
        return { ok: false, balance: 0.0, error: err };
      }
      return { ok: false, balance: 0.0, error: 'Не удалось получить баланс Binance.' };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, balance: 0.0, error: 'Таймаут соединения с Binance. Попробуйте позже.' };
      log.error(`Binance test_connection: ${errStr(e)}`);
      return { ok: false, balance: 0.0, error: errStr(e) };
    }
  }

  async function placeTrade(apiKey, secret, symbol, direction, entry, sl, tp1, riskPct, leverage, o = {}) {
    let { tp2 = 0.0, tp3 = 0.0 } = o;
    const { riskMode = 'risk', tradeId = '', userId = 0, allowLowNotionalBoost = false } = o;
    const t0 = rt.monotonic();
    const ks = await killswitchGate(rt, 'binance_trader.place_trade');
    if (ks) return ks;
    const deny = await planGateDeny(rt, userId, symbol, 'binance');
    if (deny) return deny;
    try {
      const bs = toBinanceSymbol(symbol);
      const side = ['LONG', 'BUY'].includes(String(direction).toUpperCase()) ? 'BUY' : 'SELL';
      const posSide = side === 'BUY' ? 'LONG' : 'SHORT';
      const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
      const pmult = binancePriceMultiplier(symbol);
      if (pmult !== 1.0) {
        entry *= pmult;
        sl *= pmult;
        tp1 *= pmult;
        if (pyTruthy(tp2)) tp2 *= pmult;
        if (pyTruthy(tp3)) tp3 *= pmult;
        log.debug(`Binance 1000x price correction ${symbol}: ×${fmtFixed(pmult, 0)}`);
      }
      const [qtyStep, tickSize, symFound, symMaxLev] = await _getInstrumentFilters(bs);
      if (!symFound) {
        log.warning(`Binance place_trade ${symbol}: символ ${bs} не найден`);
        return { ok: false, order_id: '', error: `Символ ${bs} недоступен на Binance Futures.` };
      }
      const balData = await _request('GET', '/fapi/v2/balance', apiKey, secret);
      let equity = 0.0;
      if (Array.isArray(balData)) {
        const usdt = balData.find((a) => pyGet(a, 'asset') === 'USDT') || null;
        equity = pyFloat(pyOr(pyGet(pyOr(usdt, {}), 'balance', 0), 0));
      }
      if (equity <= 0) return { ok: false, order_id: '', error: 'Нулевой баланс Binance.' };

      let hedgeMode = true;
      const dualResp = await _request('POST', '/fapi/v1/positionSide/dual', apiKey, secret, { dualSidePosition: 'true' });
      if (pyGet(dualResp, 'code') === -4059 || pyGet(dualResp, 'code') === -4061) {
        const ml = pyStr(pyGet(dualResp, 'msg', '')).toLowerCase();
        if (ml.includes('existing') || ml.includes('position side cannot be changed')) {
          hedgeMode = false;
          log.info('Binance hedge mode unavailable (existing positions) — using one-way');
        }
      }
      let lev = Math.min(leverage, MAX_LEVERAGE, symMaxLev);
      for (let a = 0; a < 3; a++) {
        const levData = await _request('POST', '/fapi/v1/leverage', apiKey, secret, { symbol: bs, leverage: String(lev) });
        if (pyCmp(pyGet(levData, 'code', 0), '>=', 0) || pyGet(levData, 'leverage') !== null) break;
        const levCode = pyGet(levData, 'code', 0);
        if ((levCode === -4028 || levCode === -4060) && lev > 1) {
          const newLev = Math.max(1, Math.floor(lev / 2));
          log.warning(`Binance leverage ${lev} rejected (${pyStr(levCode)}) — retry with ${newLev}`);
          lev = newLev;
          continue;
        }
        log.warning(`Binance set leverage ${bs}: ${pyStr(levData)}`);
        break;
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
        log.warning(`[AUDIT-FIX] ⚠️ Volume boosted to min ${bs} (user opt-in): qty=${qtyStr} notional=${fmtFixed(notional, 2)}`);
      }

      let cidEntry = '';
      let cidSl = '';
      const cidTp = [];
      if (tradeId) {
        cidEntry = computeClientOrderId(tradeId, userId, 'binance', 'entry');
        cidSl = computeClientOrderId(tradeId, userId, 'binance', 'sl');
        for (let i = 1; i < 4; i++) cidTp.push(computeClientOrderId(tradeId, userId, 'binance', `tp${i}`));
      }

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
            const f = qtyFloat - pyFloat(qTp2) - pyFloat(qTp3);
            qTp1 = PP.roundQty(Math.max(f, qtyStep), qtyStep);
          } else {
            qTp1 = qtyStr;
            qTp2 = '0';
            qTp3 = '0';
          }
          const slAtom = PP.roundPrice(sl, tickSize);
          const tp1Atom = PP.roundPrice(tp1, tickSize);
          const cs = side === 'BUY' ? 'SELL' : 'BUY';
          const batch = [
            { symbol: bs, side, positionSide: posSide, type: 'MARKET', quantity: qtyStr, newClientOrderId: cidEntry },
            {
              symbol: bs, side: cs, positionSide: posSide, type: 'STOP_MARKET', stopPrice: slAtom, quantity: qtyStr,
              workingType: 'MARK_PRICE', timeInForce: 'GTC', newClientOrderId: cidSl,
            },
            {
              symbol: bs, side: cs, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: tp1Atom, quantity: qTp1,
              workingType: 'MARK_PRICE', timeInForce: 'GTC', newClientOrderId: cidTp.length >= 1 ? cidTp[0] : '',
            },
          ];
          if (pyTruthy(tp2) && tp2 > 0 && pyFloat(qTp2) > 0) {
            batch.push({
              symbol: bs, side: cs, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: PP.roundPrice(tp2, tickSize), quantity: qTp2,
              workingType: 'MARK_PRICE', timeInForce: 'GTC', newClientOrderId: cidTp.length >= 2 ? cidTp[1] : '',
            });
          }
          if (pyTruthy(tp3) && tp3 > 0 && pyFloat(qTp3) > 0) {
            batch.push({
              symbol: bs, side: cs, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', stopPrice: PP.roundPrice(tp3, tickSize), quantity: qTp3,
              workingType: 'MARK_PRICE', timeInForce: 'GTC', newClientOrderId: cidTp.length >= 3 ? cidTp[2] : '',
            });
          }
          const batchResp = await _request('POST', '/fapi/v1/batchOrders', apiKey, secret, { batchOrders: pyJsonDumps(batch) });
          if (Array.isArray(batchResp)) {
            const results = batchResp;
            const first = results.length ? results[0] : {};
            const entryOk = Boolean(isDict(first) && pyTruthy(pyGet(first, 'orderId')));
            const slR = results.length >= 2 ? results[1] : {};
            const slOk = Boolean(isDict(slR) && pyTruthy(pyGet(slR, 'orderId')));
            if (entryOk && slOk) {
              atomicOk = true;
              atomicOrderId = pyStr(pyGet(first, 'orderId', cidEntry));
              for (const r of pyIter(results.slice(2))) if (isDict(r) && pyTruthy(pyGet(r, 'orderId'))) { atomicTpPlaced = true; break; }
              const n = results.slice(2).filter((r) => isDict(r) && pyTruthy(pyGet(r, 'orderId'))).length;
              log.info(`[BINANCE-ATOMIC-OK] ${bs}: batch placed entry+SL+${n} TP orders`);
            } else {
              log.warning(`[BINANCE-ATOMIC-FALLBACK] ${bs}: batch partial (entry_ok=${entryOk ? 'True' : 'False'} sl_ok=${slOk ? 'True' : 'False'}) — legacy retry (idempotent via Fix #2)`);
            }
          } else if (isDict(batchResp)) {
            const bcode = pyGet(batchResp, 'code', 0);
            if (pyCmp(bcode, '<', 0)) log.warning(`[BINANCE-ATOMIC-FALLBACK] ${bs}: batch endpoint error (code=${pyStr(bcode)} msg=${pySlice(pyStr(pyGet(batchResp, 'msg', '')), 100)}) — legacy flow`);
            else log.warning(`[BINANCE-ATOMIC-FALLBACK] ${bs}: batch response not a list (got dict ${pySlice(pyStr(batchResp), 100)}) — legacy flow`);
          } else {
            log.warning(`[BINANCE-ATOMIC-FALLBACK] ${bs}: batch unexpected response type=${batchResp === null ? 'NoneType' : typeof batchResp} — legacy flow`);
          }
        } catch (be) {
          log.warning(`[BINANCE-ATOMIC-FALLBACK] ${bs}: batch exception (${errStr(be)}) — legacy flow`);
        }
      }
      if (atomicOk) return { ok: true, order_id: pyOr(atomicOrderId, cidEntry), error: '', tp_placed: atomicTpPlaced, atomic: true, qty: pyFloat(qtyStr) };

      const orderParams = { symbol: bs, side, quantity: qtyStr };
      if (hedgeMode) orderParams.positionSide = posSide;
      if (cidEntry) orderParams.newClientOrderId = cidEntry;
      try {
        const currentPrice = await getLastPrice(apiKey, secret, symbol);
        const diffPct = entry > 0 ? Math.abs(currentPrice - entry) / entry * 100 : 999;
        if (currentPrice > 0 && diffPct < 0.3) {
          orderParams.type = 'LIMIT';
          orderParams.price = PP.roundPrice(entry, tickSize);
          orderParams.timeInForce = 'GTC';
          log.debug(`Binance LIMIT entry ${bs}: diff=${fmtFixed(diffPct, 3)}%`);
        } else {
          orderParams.type = 'MARKET';
        }
      } catch (pe) {
        log.debug(`Binance price check failed (${errStr(pe)}), using MARKET`);
        orderParams.type = 'MARKET';
      }
      const resp = await _request('POST', '/fapi/v1/order', apiKey, secret, orderParams);
      const respCode = pyGet(resp, 'code', 0);
      const respMsgL = pyStr(pyGet(resp, 'msg', '')).toLowerCase();
      const isDup = cidEntry && (respCode === -4015 || (respMsgL.includes('client order id') && (respMsgL.includes('already') || respMsgL.includes('exists'))));
      if (isDup) {
        log.info(`Duplicate order rejected by exchange (idempotency works): ${bs} cid=${cidEntry} — assuming prior attempt succeeded`);
        return { ok: true, order_id: cidEntry, error: '', tp_placed: false, duplicate: true, qty: pyFloat(qtyStr) };
      }
      if (pyCmp(pyGet(resp, 'code', 0), '<', 0)) {
        log.error(`Binance order failed ${bs}: ${pyStr(resp)} params=${pyRepr(orderParams)}`);
        return { ok: false, order_id: '', error: humanizeBinanceError(pyStr(resp)) };
      }
      const orderId = pyStr(pyGet(resp, 'orderId', ''));

      const slStr = PP.roundPrice(sl, tickSize);
      const slParams = {
        symbol: bs, side: closeSide, type: 'STOP_MARKET', quantity: qtyStr, stopPrice: slStr, workingType: 'MARK_PRICE', timeInForce: 'GTC',
      };
      if (hedgeMode) slParams.positionSide = posSide;
      if (cidSl) slParams.newClientOrderId = cidSl;
      let slPlaced = false;
      for (let a = 0; a < 3; a++) {
        const slResp = await _request('POST', '/fapi/v1/order', apiKey, secret, slParams);
        if (pyTruthy(pyGet(slResp, 'orderId'))) { slPlaced = true; break; }
        const slCode = pyGet(slResp, 'code', 0);
        const slMsgL = pyStr(pyGet(slResp, 'msg', '')).toLowerCase();
        if (cidSl && (slCode === -4015 || (slMsgL.includes('client order id') && slMsgL.includes('already')))) {
          log.info(`SL duplicate rejected (idempotency works): ${bs} cid=${cidSl}`);
          slPlaced = true;
          break;
        }
        log.warning(`Binance SL attempt ${a + 1}: ${pyStr(slResp)}`);
        await rt.sleep(1);
      }
      if (!slPlaced) {
        log.error(`Binance SL FAILED after 3 attempts: ${bs} — отменяем ордер ${orderId}.`);
        try {
          await cancelAllOrders(apiKey, secret, symbol);
          log.info(`FIX-AUDIT-38: Binance ордер ${orderId} отменён после провала SL.`);
        } catch (ce) {
          log.error(`FIX-AUDIT-38: не удалось отменить Binance ордер ${orderId}: ${errStr(ce)} — пользователь должен закрыть позицию вручную!`);
        }
        try {
          const positions = await getPositions(apiKey, secret, symbol);
          let liveSize = 0.0;
          for (const p of pyIter(pyOr(positions, []))) {
            const ps = pyFloat(pyOr(pyGet(p, 'positionAmt', 0), pyGet(p, 'size', 0), 0));
            if (Math.abs(ps) > 0) { liveSize = Math.abs(ps); break; }
          }
          if (liveSize > 0) {
            log.error(`[SL-SAFETY-CLOSE-BINANCE] ${bs}: position alive size=${pyFloatStr(liveSize)} without SL — emergency reduceOnly close`);
            const clResp = await closePosition(apiKey, secret, symbol, direction, liveSize);
            if (pyTruthy(pyGet(clResp, 'ok'))) log.error(`[SL-SAFETY-CLOSE-BINANCE-OK] ${bs}: closed via market (qty=${pyFloatStr(liveSize)}) — user saved from naked exposure`);
            else log.error(`[SL-SAFETY-CLOSE-BINANCE-FAIL] ${bs}: emergency close rejected: ${pyStr(pyGet(clResp, 'error', 'unknown'))} — BE-monitor takes over`);
          }
        } catch (se) {
          log.error(`[SL-SAFETY-CLOSE-BINANCE-EXC] ${bs}: ${errStr(se)} — BE-monitor takes over`);
        }
        return {
          ok: false,
          error: `SL-ордер не выставлен после 3 попыток. Ордер на ${bs} отменён для безопасности. Попробуйте ещё раз.`,
        };
      }

      let tpCountOk = 0;
      let tpCountExpected = 0;
      let tpList;
      if (pyTruthy(tp2) && tp2 > 0) {
        const q2 = PP.roundQty(qtyFloat * 0.25, qtyStep);
        const q3 = (pyTruthy(tp3) && tp3 > 0) ? PP.roundQty(qtyFloat * 0.25, qtyStep) : '0';
        const q1f = qtyFloat - pyFloat(q2) - pyFloat(q3);
        tpList = [[tp1, PP.roundQty(Math.max(q1f, qtyStep), qtyStep), '50%'], [tp2, q2, '25%']];
        if (pyTruthy(tp3) && tp3 > 0 && pyFloat(q3) > 0) tpList.push([tp3, q3, '25%']);
      } else {
        tpList = [[tp1, qtyStr, '100%']];
      }
      for (let pos = 0; pos < tpList.length; pos++) {
        const [tpPrice, tpQtyS, pct] = tpList[pos];
        if (!pyTruthy(tpPrice) || tpPrice <= 0 || pyFloat(tpQtyS) <= 0) continue;
        tpCountExpected += 1;
        const tpParams = {
          symbol: bs, side: closeSide, type: 'TAKE_PROFIT_MARKET', quantity: tpQtyS,
          stopPrice: PP.roundPrice(tpPrice, tickSize), workingType: 'MARK_PRICE', timeInForce: 'GTC',
        };
        if (hedgeMode) tpParams.positionSide = posSide;
        const tpCid = pos < cidTp.length ? cidTp[pos] : '';
        if (tpCid) tpParams.newClientOrderId = tpCid;
        let tpOk = false;
        let lastTpErr = '';
        for (let a = 0; a < 5; a++) {
          const tpResp = await _request('POST', '/fapi/v1/order', apiKey, secret, tpParams);
          if (pyTruthy(pyGet(tpResp, 'orderId'))) { tpOk = true; break; }
          lastTpErr = pySlice(pyStr(tpResp), 200);
          const code = pyGet(tpResp, 'code', 0);
          const tpMsgL = pyStr(pyGet(tpResp, 'msg', '')).toLowerCase();
          if (tpCid && (code === -4015 || (tpMsgL.includes('client order id') && tpMsgL.includes('already')))) {
            log.info(`TP duplicate rejected (idempotency works): ${bs} cid=${tpCid}`);
            tpOk = true;
            break;
          }
          if (code === -2021 && a < 3) {
            let nw = null;
            try {
              const cur = await getLastPrice(apiKey, secret, symbol);
              if (pyTruthy(cur) && cur > 0) {
                const gap = 0.015;
                nw = closeSide === 'SELL' ? cur * (1 + gap) : cur * (1 - gap);
                log.info(`[TP-ADAPTIVE-SHIFT] Binance ${bs} tp=${pyStr(tpParams.stopPrice)} → ${fmtG(nw, 6)} (current=${fmtG(cur, 6)}, gap=1.5%)`);
              }
            } catch (ge) {
              log.debug(`Binance adaptive TP fetch: ${errStr(ge)}`);
            }
            if (nw === null) {
              const adjPct = 0.005 * (a + 1);
              const adj = closeSide === 'SELL' ? (1 + adjPct) : (1 - adjPct);
              nw = pyFloat(tpParams.stopPrice) * adj;
            }
            tpParams.stopPrice = PP.roundPrice(nw, tickSize);
            continue;
          }
          await rt.sleep(2.0);
        }
        if (tpOk) tpCountOk += 1;
        else log.warning(`Binance TP@${pyFloatStr(tpPrice)} (${pct}) failed after 5 attempts: ${lastTpErr}`);
      }
      const tpPlaced = tpCountExpected > 0 && tpCountOk === tpCountExpected;
      if (tpCountExpected > 0 && tpCountOk < tpCountExpected) log.warning(`Binance TP partial fail [${bs}]: ${tpCountOk}/${tpCountExpected} placed`);
      await recordPlaced(rt, { symbol, direction, exchange: 'binance', t0, tpPlaced });
      return { ok: true, order_id: orderId, error: '', tp_placed: tpPlaced, qty: pyFloat(qtyStr) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, order_id: '', error: 'Таймаут соединения с Binance. Попробуйте позже.' };
      log.error(`Binance place_trade ${symbol}: ${errStr(e)}`);
      return { ok: false, order_id: '', error: errStr(e) };
    }
  }

  async function getPositions(apiKey, secret, symbol = null) {
    try {
      const params = {};
      if (pyTruthy(symbol)) params.symbol = toBinanceSymbol(symbol);
      const data = await _request('GET', '/fapi/v2/positionRisk', apiKey, secret, params);
      if (!Array.isArray(data)) {
        log.warning(`Binance get_positions unexpected: ${pyStr(data)}`);
        return [];
      }
      const positions = [];
      for (const p of pyIter(data)) {
        const size = pyFloat(pyOr(pyGet(p, 'positionAmt', 0), 0));
        if (size === 0) continue;
        let ps = pyGet(p, 'positionSide', 'BOTH');
        if (ps === 'BOTH') ps = size > 0 ? 'LONG' : 'SHORT';
        positions.push({
          symbol: pyGet(p, 'symbol', ''),
          side: ps,
          size: Math.abs(size),
          entryPrice: pyFloat(pyOr(pyGet(p, 'entryPrice', 0), 0)),
          markPrice: pyFloat(pyOr(pyGet(p, 'markPrice', 0), 0)),
          unrealisedPnl: pyFloat(pyOr(pyGet(p, 'unRealizedProfit', 0), 0)),
          leverage: pyInt(pyFloat(pyOr(pyGet(p, 'leverage', 1), 1))),
          stopLoss: 0.0,
          positionIdx: 0,
        });
      }
      return positions;
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') { log.warning('Binance get_positions: таймаут'); return []; }
      log.error(`Binance get_positions: ${errStr(e)}`);
      return [];
    }
  }

  async function getOpenOrders(apiKey, secret) {
    try {
      const data = await _request('GET', '/fapi/v1/openOrders', apiKey, secret, {});
      if (Array.isArray(data)) return data;
      log.warning(`Binance get_open_orders unexpected: ${pyStr(data)}`);
    } catch (e) {
      log.error(`Binance get_open_orders: ${errStr(e)}`);
    }
    return [];
  }

  async function closePosition(apiKey, secret, symbol, side, size, posIdx = 0) {
    try {
      const bs = toBinanceSymbol(symbol);
      const closeSide = pyStr(side).toUpperCase() === 'LONG' ? 'SELL' : 'BUY';
      const posSide = pyStr(side).toUpperCase();
      const [qtyStep] = await _getInstrumentFilters(bs);
      const qtyStr = PP.roundQty(size, qtyStep);
      if (pyFloat(qtyStr) <= 0) {
        log.warning(`Binance close_position ${symbol}: qty=${typeof size === 'number' ? pyFloatStr(size) : pyStr(size)} rounded to 0 (step=${pyFloatStr(qtyStep)}) — skip (position smaller than minimum lot)`);
        return { ok: false, order_id: '', error: 'qty rounded to 0 (below lot step)', skipped: true };
      }
      const params = { symbol: bs, side: closeSide, positionSide: posSide, type: 'MARKET', quantity: qtyStr };
      const resp = await _request('POST', '/fapi/v1/order', apiKey, secret, params);
      if (pyTruthy(pyGet(resp, 'orderId'))) return { ok: true, order_id: pyStr(pyIndex(resp, 'orderId')) };
      if (pyTruthy(pyGet(resp, 'code')) && pyInt(pyIndex(resp, 'code')) < 0) return { ok: false, order_id: '', error: humanizeBinanceError(pyStr(resp)) };
      return { ok: true, order_id: pyStr(pyGet(resp, 'orderId', '')) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, order_id: '', error: 'Таймаут соединения с Binance.' };
      log.error(`Binance close_position: ${errStr(e)}`);
      return { ok: false, order_id: '', error: errStr(e) };
    }
  }

  async function cancelOrder(apiKey, secret, symbol, orderId) {
    try {
      const bs = toBinanceSymbol(symbol);
      const resp = await _request('DELETE', '/fapi/v1/order', apiKey, secret, { symbol: bs, orderId: pyStr(orderId) });
      if (pyCmp(pyGet(resp, 'code', 0), '>=', 0)) return { ok: true };
      return { ok: false, error: humanizeBinanceError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, error: 'Таймаут соединения с Binance.' };
      log.error(`Binance cancel_order ${symbol} ${pyStr(orderId)}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function _cancelAllOrdersInner(apiKey, secret, symbol) {
    try {
      const bs = toBinanceSymbol(symbol);
      const resp = await _request('DELETE', '/fapi/v1/allOpenOrders', apiKey, secret, { symbol: bs });
      const c = pyGet(resp, 'code', 0);
      if (c === 200 || c === 0 || pyCmp(pyGet(resp, 'code', -1), '>=', 0)) return { ok: true, cancelled: 0 };
      return { ok: false, cancelled: 0, error: humanizeBinanceError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, cancelled: 0, error: 'Таймаут соединения с Binance.' };
      log.error(`Binance cancel_all_orders: ${errStr(e)}`);
      return { ok: false, cancelled: 0, error: errStr(e) };
    }
  }

  async function cancelAllOrders(apiKey, secret, symbol) {
    return callWithRetry(_cancelAllOrdersInner, {
      args: [apiKey, secret, symbol], maxAttempts: 3, baseBackoff: 0.3, opName: `binance_cancel_all_${symbol}`, sleep: rt.sleep, random: rt.random, log,
    });
  }

  async function cancelTpOrdersOnly(apiKey, secret, symbol) {
    try {
      const bs = toBinanceSymbol(symbol);
      const resp = await _request('GET', '/fapi/v1/openOrders', apiKey, secret, { symbol: bs });
      const ordersRaw = isDict(resp) ? pyGet(resp, 'data', resp) : resp;
      if (!Array.isArray(ordersRaw)) return { ok: true, cancelled: 0, total_tp: 0 };
      const tpOrders = pyIter(ordersRaw).filter((x) => pyStr(pyGet(x, 'type', '')).toUpperCase() === 'TAKE_PROFIT_MARKET');
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
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, cancelled: 0, error: 'Таймаут соединения с Binance.' };
      log.error(`Binance cancel_tp_orders_only: ${errStr(e)}`);
      return { ok: false, cancelled: 0, error: errStr(e) };
    }
  }

  async function _cancelSlOrders(apiKey, secret, bs, closeSide) {
    const ordData = await _request('GET', '/fapi/v1/openOrders', apiKey, secret, { symbol: bs });
    if (!Array.isArray(ordData)) return;
    for (const x of pyIter(ordData)) {
      if (pyGet(x, 'type') === 'STOP_MARKET' && pyStr(pyGet(x, 'side', '')).toUpperCase() === closeSide.toUpperCase()) {
        await _request('DELETE', '/fapi/v1/order', apiKey, secret, { symbol: bs, orderId: pyStr(pyGet(x, 'orderId', '')) });
      }
    }
  }

  async function setTrailingSl(apiKey, secret, symbol, newSl, direction, posIdx = 0) {
    try {
      const bs = toBinanceSymbol(symbol);
      const posSide = direction === 'LONG' ? 'LONG' : 'SHORT';
      const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const [qtyStep, tickSize] = await _getInstrumentFilters(bs);
      await _cancelSlOrders(apiKey, secret, bs, closeSide);
      const positions = await getPositions(apiKey, secret, symbol);
      const pos = positions.find((p) => pyStr(p.side).toUpperCase() === posSide) || null;
      if (!pos) return { ok: true };
      const qtyStr = PP.roundQty(pos.size, qtyStep);
      if (pyFloat(qtyStr) <= 0) {
        log.info(`Binance set_trailing_sl ${bs}: qty rounded to 0 (pos_size=${pyFloatStr(pos.size)} qty_step=${pyFloatStr(qtyStep)}) — skip; original SL stays`);
        return { ok: false, error: 'position smaller than minimum step (trail skipped)', skipped: true };
      }
      const pmult = binancePriceMultiplier(symbol);
      const slParams = {
        symbol: bs, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', quantity: qtyStr,
        stopPrice: PP.roundPrice(newSl * pmult, tickSize), workingType: 'MARK_PRICE', timeInForce: 'GTC',
      };
      const postSl = () => _request('POST', '/fapi/v1/order', apiKey, secret, slParams);
      const resp = await callWithRetry(postSl, {
        maxAttempts: 3, baseBackoff: 0.3, opName: `binance_set_trailing_sl_${bs}`, sleep: rt.sleep, random: rt.random, log,
      });
      if (pyCmp(pyGet(resp, 'code', 0), '>=', 0)) return { ok: true };
      log.warning(`Binance set_trailing_sl ${bs}: ${pyStr(resp)}`);
      return { ok: false, error: humanizeBinanceError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, error: 'Таймаут соединения с Binance.' };
      log.error(`Binance set_trailing_sl ${symbol}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function setBreakeven(apiKey, secret, symbol, entry, direction, posIdx = 0) {
    try {
      const bs = toBinanceSymbol(symbol);
      const posSide = direction === 'LONG' ? 'LONG' : 'SHORT';
      const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const [qtyStep, tickSize] = await _getInstrumentFilters(bs);
      await _cancelSlOrders(apiKey, secret, bs, closeSide);
      const positions = await getPositions(apiKey, secret, symbol);
      const pos = positions.find((p) => pyStr(p.side).toUpperCase() === posSide) || null;
      if (!pos) return { ok: true };
      const qtyStr = PP.roundQty(pos.size, qtyStep);
      if (pyFloat(qtyStr) <= 0) {
        log.info(`Binance set_breakeven ${bs}: qty rounded to 0 (pos_size=${pyFloatStr(pos.size)} qty_step=${pyFloatStr(qtyStep)}) — skip; original SL stays`);
        return { ok: false, error: 'position smaller than minimum step (BE skipped)', skipped: true };
      }
      const pmult = binancePriceMultiplier(symbol);
      const slParams = {
        symbol: bs, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', quantity: qtyStr,
        stopPrice: PP.roundPrice(entry * pmult, tickSize), workingType: 'MARK_PRICE', timeInForce: 'GTC',
      };
      const resp = await _request('POST', '/fapi/v1/order', apiKey, secret, slParams);
      if (pyCmp(pyGet(resp, 'code', 0), '>=', 0)) return { ok: true };
      log.warning(`Binance set_breakeven ${bs}: ${pyStr(resp)}`);
      return { ok: false, error: humanizeBinanceError(pyStr(resp)) };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, error: 'Таймаут соединения с Binance.' };
      log.error(`Binance set_breakeven ${symbol}: ${errStr(e)}`);
      return { ok: false, error: errStr(e) };
    }
  }

  async function placeSlTpForPosition(apiKey, secret, symbol, direction, posSize, sl, tp1, tp2 = 0.0, tp3 = 0.0) {
    try {
      const bs = toBinanceSymbol(symbol);
      const posSide = direction === 'LONG' ? 'LONG' : 'SHORT';
      const closeSide = direction === 'LONG' ? 'SELL' : 'BUY';
      const [qtyStep, tickSize] = await _getInstrumentFilters(bs);
      const qtyStr = PP.roundQty(posSize, qtyStep);
      let slPlaced = false;
      let tpPlaced = false;
      const pmult = binancePriceMultiplier(symbol);
      let slResp = null;
      if (sl > 0) {
        const slParams = {
          symbol: bs, side: closeSide, positionSide: posSide, type: 'STOP_MARKET', quantity: qtyStr,
          stopPrice: PP.roundPrice(sl * pmult, tickSize), workingType: 'MARK_PRICE', timeInForce: 'GTC',
        };
        let slLast = '';
        for (let a = 0; a < 3; a++) {
          slResp = await _request('POST', '/fapi/v1/order', apiKey, secret, slParams);
          if (pyTruthy(pyGet(slResp, 'orderId'))) { slPlaced = true; break; }
          slLast = pySlice(pyStr(slResp), 200);
          if (pyGet(slResp, 'code') === -4131) break;
          await rt.sleep(1.5);
        }
        if (!slPlaced) log.warning(`Binance place_sl_tp_for_position SL ${bs} failed 3x: ${slLast}`);
      }
      try {
        const ordData = await _request('GET', '/fapi/v1/openOrders', apiKey, secret, { symbol: bs });
        if (Array.isArray(ordData)) {
          for (const x of pyIter(ordData)) {
            if (pyStr(pyGet(x, 'side', '')).toUpperCase() !== closeSide) continue;
            if (!['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(pyGet(x, 'type'))) continue;
            const oid = pyStr(pyGet(x, 'orderId', ''));
            if (slPlaced && oid === pyStr(pyGet(slResp, 'orderId', ''))) continue;
            try {
              await _request('DELETE', '/fapi/v1/order', apiKey, secret, { symbol: bs, orderId: oid });
            } catch (de) {
              log.debug(`Binance cancel old SL/TP ${oid}: ${errStr(de)}`);
            }
          }
        }
      } catch (le) {
        log.debug(`Binance list open orders ${bs}: ${errStr(le)}`);
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
      let tpExpected = 0;
      for (const [tpPrice, tpQtyS] of tpList) {
        if (!pyTruthy(tpPrice) || tpPrice <= 0 || pyFloat(tpQtyS) <= 0) continue;
        const tpParams = {
          symbol: bs, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', quantity: tpQtyS,
          stopPrice: PP.roundPrice(tpPrice * pmult, tickSize), workingType: 'MARK_PRICE', timeInForce: 'GTC',
        };
        let tpOk = false;
        let tpLast = '';
        for (let a = 0; a < 3; a++) {
          const tpResp = await _request('POST', '/fapi/v1/order', apiKey, secret, tpParams);
          if (pyTruthy(pyGet(tpResp, 'orderId'))) { tpOk = true; break; }
          tpLast = pySlice(pyStr(tpResp), 200);
          const code = pyGet(tpResp, 'code');
          if (code === -4131) break;
          if (code === -2021 && a < 2) {
            const adj = closeSide === 'SELL' ? 1.0015 : 0.9985;
            tpParams.stopPrice = PP.roundPrice(pyFloat(tpParams.stopPrice) * adj, tickSize);
            continue;
          }
          await rt.sleep(1.5);
        }
        if (tpOk) { tpPlaced = true; tpExpected += 1; } else {
          log.warning(`Binance place_sl_tp_for_position TP@${pyFloatStr(tpPrice)} ${bs} failed 3x: ${tpLast}`);
        }
      }
      if (tpPlaced && tpExpected > 0) {
        try {
          await rt.sleep(2.0);
          const od = await _request('GET', '/fapi/v1/openOrders', apiKey, secret, { symbol: bs });
          let liveTp = 0;
          if (Array.isArray(od)) {
            for (const x of pyIter(od)) {
              if (pyStr(pyGet(x, 'type', '')) === 'TAKE_PROFIT_MARKET' && pyStr(pyGet(x, 'side', '')).toUpperCase() === closeSide
                && pyStr(pyGet(x, 'positionSide', '')).toUpperCase() === posSide) liveTp += 1;
            }
          }
          if (liveTp < tpExpected) {
            log.warning(`[TP-PHANTOM] Binance ${bs}: expected ${tpExpected} TP, only ${liveTp} on exchange`);
            tpPlaced = false;
          } else {
            log.debug(`[TP-VERIFIED] Binance ${bs}: ${liveTp}/${tpExpected} TPs on exchange`);
          }
        } catch (ve) {
          log.debug(`Binance TP verify ${bs}: ${errStr(ve)}`);
        }
      }
      return { sl_placed: slPlaced, tp_placed: tpPlaced };
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') { log.warning(`Binance place_sl_tp_for_position ${symbol}: таймаут`); return { sl_placed: false, tp_placed: false }; }
      log.error(`Binance place_sl_tp_for_position ${symbol}: ${errStr(e)}`);
      return { sl_placed: false, tp_placed: false };
    }
  }

  async function getClosedPnl(apiKey, secret, symbol) {
    try {
      const bs = toBinanceSymbol(symbol);
      const data = await _request('GET', '/fapi/v1/userTrades', apiKey, secret, { symbol: bs, limit: '20' });
      if (!Array.isArray(data)) {
        log.debug(`Binance get_closed_pnl ${symbol}: ${pyStr(data)}`);
        return [];
      }
      const result = [];
      for (const t of pyIter(data)) {
        const price = pyFloat(pyOr(pyGet(t, 'price'), 0));
        const qty = pyFloat(pyOr(pyGet(t, 'qty'), 0));
        const side = pyGet(t, 'side', '');
        const ts = pyFloat(pyOr(pyGet(t, 'time'), 0));
        if (price <= 0 || qty <= 0) continue;
        const raw = pyGet(t, 'realizedPnl');
        let realized;
        try { realized = (raw === null || raw === '') ? null : pyFloat(raw); } catch (e) {
          if (e && (e.pyType === 'TypeError' || e.pyType === 'ValueError')) realized = null; else throw e;
        }
        result.push({
          side: pyStr(side).toUpperCase() === 'BUY' ? 'Buy' : 'Sell',
          avgExitPrice: price,
          updatedTime: ts,
          closedPnl: realized,
          orderLinkId: pyStr(pyOr(pyGet(t, 'orderId', ''), '')),
        });
      }
      return result;
    } catch (e) {
      log.debug(`Binance get_closed_pnl ${symbol}: ${errStr(e)}`);
    }
    return [];
  }

  async function getDashboard(apiKey, secret) {
    try {
      const positions = await getPositions(apiKey, secret);
      const ordData = await _request('GET', '/fapi/v1/openOrders', apiKey, secret, {});
      const orders = [];
      if (Array.isArray(ordData)) {
        for (const x of pyIter(ordData)) {
          orders.push({
            orderId: pyStr(pyGet(x, 'orderId', '')),
            symbol: pyGet(x, 'symbol', ''),
            side: pyGet(x, 'side', ''),
            type: pyGet(x, 'type', ''),
            price: pyFloat(pyOr(pyGet(x, 'price', 0), 0)),
            origQty: pyFloat(pyOr(pyGet(x, 'origQty', 0), 0)),
            stopPrice: pyFloat(pyOr(pyGet(x, 'stopPrice', 0), 0)),
          });
        }
      }
      const summary = EMPTY_SUMMARY();
      const balData = await _request('GET', '/fapi/v2/balance', apiKey, secret);
      if (Array.isArray(balData)) {
        const usdt = balData.find((a) => pyGet(a, 'asset') === 'USDT') || null;
        if (pyTruthy(usdt)) {
          summary.equity = pyFloat(pyOr(pyGet(usdt, 'balance', 0), 0));
          summary.available = pyFloat(pyOr(pyGet(usdt, 'availableBalance', 0), 0));
          summary.unrealized_pnl = pyFloat(pyOr(pyGet(usdt, 'crossUnPnl', 0), 0));
        }
      }
      const ts24h = Math.trunc((rt.now() - 86400) * 1000);
      const incomeData = await _request('GET', '/fapi/v1/income', apiKey, secret, { incomeType: 'REALIZED_PNL', startTime: String(ts24h), limit: '100' });
      if (Array.isArray(incomeData)) {
        const pnls = pyIter(incomeData).map((i) => pyFloat(pyOr(pyGet(i, 'income', 0), 0)));
        summary.closed_pnl_24h = pySum(pnls);
        summary.trades_24h = pnls.length;
        summary.wins_24h = pnls.filter((p) => p > 0).length;
      }
      return [positions, orders, summary];
    } catch (e) {
      if (e instanceof TransportError && e.kind === 'timeout') { log.warning('Binance get_dashboard: таймаут'); return [[], [], EMPTY_SUMMARY()]; }
      log.error(`Binance get_dashboard: ${errStr(e)}`);
      return [[], [], EMPTY_SUMMARY()];
    }
  }

  return {
    rt, _state: st,
    placeTrade, getPositions, getOpenOrders, closePosition, cancelOrder, cancelAllOrders, cancelTpOrdersOnly,
    setTrailingSl, setBreakeven, placeSlTpForPosition, getClosedPnl, getDashboard, getBalance, getLastPrice,
    testConnection, syncTime, findWorkingBinanceUrl,
    _request, _buildQuery, _getInstrumentFilters, _cancelAllOrdersInner,
  };
}

function formatTradeResult(result, direction, symbol, entry, sl, tp1, riskPct, leverage, tp2 = 0.0, tp3 = 0.0) {
  const fp = PP.fmtPriceDisplay;
  const dirEmoji = ['LONG', 'BUY'].includes(String(direction).toUpperCase()) ? '🟢 LONG' : '🔴 SHORT';
  const bs = toBinanceSymbol(symbol);
  if (pyTruthy(pyGet(result, 'ok'))) {
    const orderId = htmlEscape(pyStr(pyGet(result, 'order_id', '—')));
    let tp1Line;
    let tp2Line = '';
    let tp3Line = '';
    let beNote = '';
    if (pyTruthy(tp2)) {
      tp1Line = `\n🎯 TP1: <code>${fp(tp1)}</code>  (50% позиции)`;
      tp2Line = `\n🎯 TP2: <code>${fp(tp2)}</code>  (25% позиции)`;
      tp3Line = pyTruthy(tp3) ? `\n🏆 TP3: <code>${fp(tp3)}</code>  (25% позиции)` : '';
      beNote = '\n♻️ <i>После TP1 — стоп перенесётся в БУ</i>';
    } else {
      tp1Line = `\n🎯 TP1: <code>${fp(tp1)}</code>`;
    }
    const qtyV = pyGet(result, 'qty', '?');
    const qty = typeof qtyV === 'number' ? pyFloatStr(qtyV) : pyStr(qtyV);
    const notional = pyFloat(pyOr(pyGet(result, 'qty', 0), 0)) * entry;
    const notionalStr = notional > 0 ? `~$${fmtComma(notional, 2)}` : '';
    return '✅ <b>Binance: сделка открыта</b>\n'
      + '━━━━━━━━━━━━━━━━━━━━━━\n'
      + `${dirEmoji}  <b>${bs}</b>  x${leverage}\n`
      + `💵 Вход: <code>${fp(entry)}</code>\n`
      + `🛑 SL:   <code>${fp(sl)}</code>`
      + `${tp1Line}${tp2Line}${tp3Line}`
      + `${beNote}\n`
      + `📊 Qty: ${qty}  (${notionalStr})\n`
      + `⚖️ Риск: ${pyFloatStr(riskPct)}%\n`
      + `🆔 <code>${orderId}</code>`;
  }
  const error = htmlEscape(pyStr(pyGet(result, 'error', 'Неизвестная ошибка')));
  return `❌ <b>Binance: ошибка открытия сделки</b>\n${dirEmoji}  <b>${bs}</b>\n⚠️ ${error}`;
}

let _default = null;
function defaultTrader() {
  if (!_default) _default = createBinanceTrader();
  return _default;
}

module.exports = {
  createBinanceTrader, defaultTrader, FALLBACK_URLS, MIN_NOTIONAL, MAX_LEVERAGE, RECV_WINDOW, TAKER_FEE, MAKER_FEE, BINANCE_ERROR_MAP,
  humanizeBinanceError, toBinanceSymbol, binancePriceMultiplier, binanceSign, formatTradeResult,
};
