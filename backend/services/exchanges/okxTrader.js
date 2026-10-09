'use strict';
/**
 * okxTrader.js — one-to-one port of `okx_trader.py` (OKX perpetual swaps, API v5).
 *
 * Auth: OK-ACCESS-SIGN = base64(HMAC-SHA256(secret, ts + METHOD + path(?query) + body)) with
 * OK-ACCESS-TIMESTAMP an ISO-8601 UTC string with milliseconds, computed ONCE per request from
 * datetime.now() + the sync_time() offset; plus OK-ACCESS-KEY / OK-ACCESS-PASSPHRASE.
 * GET queries are `urlencode(params)` signed as-is (the str URL is then requoted by yarl on the
 * wire, like aiohttp); POST bodies are `json.dumps(body)`. Responses are parsed with
 * `content_type=None` (no mimetype check). Codes are strings ("0" = success).
 *
 * place_trade (spec §14.3): instrument filters (cached forever, incl. ctVal — `sz` is in
 * CONTRACTS, `okx_sz` / `_to_contracts` convert from coins), totalEq balance, cross leverage,
 * sizing + low-notional skip/boost, ATOMIC entry with attachAlgoOrds SL + TP1
 * ([OKX-ATOMIC-OK]); 51000/51001 or "attachalgo" in the message → [OKX-ATOMIC-FALLBACK]:
 * plain market entry, SL algo ×3 (1.5 s) and [SL-SAFETY-CLOSE-OKX*] when it never lands
 * (the trade is still reported ok — bot behaviour); TP2/TP3 (and the legacy TP1) as
 * conditional algos ×3 (1.5 s); tp_placed only when every TP landed; `qty` is the STRING.
 * Errors from `_request` carry the passphrase redacted.
 *
 * Reproduced quirks: an error body with `"data": []` raises IndexError inside place_trade
 * (→ error "list index out of range"); set_trailing_sl adds a new SL algo without removing
 * the old one; get_dashboard passes the passphrase as the SYMBOL of get_positions and an empty
 * passphrase, and returns (summary, positions); several readers do not catch (a None/odd body
 * raises out of get_positions / close_position / set_trailing_sl, as in the bot).
 *
 * Addition (not in the bot, default off): `demo: true` sends `x-simulated-trading: 1`
 * (OKX demo trading) — an instance option, so live keys are never mixed with it.
 */

const crypto = require('crypto');
const { makeRuntime } = require('./runtime');
const { TransportError, aiohttpJson } = require('./transport');
const {
  errStr, pyGet, pyIndex, pyFloat, pyInt, pyStr, pyFloatStr, pyTruthy, pyOr, pyUrlencode, yarlUrl, htmlEscape, pySlice, isDict,
  pyIter, pyRepr,
  rethrowCancelled,
} = require('./pyCompat');
const { fmtFixed, fmtG } = require('../../strategies/common/pyfmt');
const { pyRound, pyRoundInt } = require('../../strategies/common/pyround');
const { pyJsonDumps } = require('../engine/pyjson');
const PP = require('./pricePrecision');
const { callWithRetry } = require('./apiRetry');
const { killswitchGate, planGateDeny, recordPlaced, aioQuery } = require('./traderCommon');
const { pyLower, pyUpper, pyStrip } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const BASE_URL = 'https://www.okx.com';
const MIN_NOTIONAL = 5.0;
const MAX_LEVERAGE = 125;
const TAKER_FEE = 0.0005;
const MAKER_FEE = 0.0002;

const OKX_ERROR_MAP = Object.freeze([
  ['50000', 'Ошибка параметров запроса.'],
  ['50001', 'Не удалось идентифицировать пользователя.'],
  ['50002', 'Неверный API ключ.'],
  ['50004', 'Неверная подпись.'],
  ['50005', 'Неверный passphrase.'],
  ['50011', 'Превышен лимит запросов.'],
  ['50013', 'Системная ошибка OKX. Повторите позже.'],
  ['51001', 'Инструмент не найден.'],
  ['51004', 'Недостаточно средств.'],
  ['51008', 'Ордер уже размещён.'],
  ['51010', 'Объём ниже минимального.'],
  ['51020', 'Объём выше максимального.'],
  ['51102', 'Неверный размер позиции.'],
]);

function humanizeOkxError(raw) {
  raw = String(raw);
  for (const [code, msg] of OKX_ERROR_MAP) if (raw.includes(code)) return msg;
  return pySlice(raw, 300);
}

/** to_okx_symbol: "-SWAP" kept; "...USDT" → base (every "USDT" removed) + "-USDT-SWAP". */
function toOkxSymbol(symbol) {
  symbol = String(symbol);
  if (symbol.endsWith('-SWAP')) return symbol;
  if (symbol.endsWith('USDT')) return `${symbol.split('USDT').join('')}-USDT-SWAP`;
  return symbol;
}

function okxPriceMultiplier(_symbol) { return 1.0; }

/** _sign: base64(HMAC-SHA256(secret, ts + METHOD + path + body)). */
function okxSign(timestamp, method, path, body, secret) {
  const msg = `${timestamp}${pyUpper(String(method))}${path}${body}`;
  return crypto.createHmac('sha256', Buffer.from(String(secret), 'utf8')).update(Buffer.from(msg, 'utf8')).digest('base64');
}

/**
 * _iso_timestamp for a time.time() value: datetime.fromtimestamp rounds the fraction to
 * microseconds half-even, + timedelta(milliseconds=offset), formatted "%Y-%m-%dT%H:%M:%S." + ms.
 */
function isoTimestamp(nowS, offsetMs = 0) {
  const secs = Math.floor(nowS);
  const us = pyRoundInt((nowS - secs) * 1e6);
  const total = secs * 1e6 + us + Math.trunc(offsetMs) * 1000;
  const s = Math.floor(total / 1e6);
  const rem = total - s * 1e6;
  return `${new Date(s * 1000).toISOString().slice(0, 19)}.${String(Math.floor(rem / 1000)).padStart(3, '0')}Z`;
}


const isPyErr = (e, types) => Boolean(e && types.includes(e.pyType));

function createOkxTrader(overrides = {}) {
  const rt = makeRuntime(overrides);
  const log = rt.log;
  const demo = Boolean(overrides.demo);
  const st = { timeOffsetMs: 0, instrumentCache: new Map() };

  const isoTs = () => isoTimestamp(rt.now(), st.timeOffsetMs);

  async function syncTime() {
    try {
      const resp = await rt.transport({ method: 'GET', url: 'https://www.okx.com/api/v5/public/time', headers: {}, timeoutMs: 5000 });
      const data = aiohttpJson(resp);
      if (pyGet(data, 'code') === '0') {
        const serverMs = pyInt(pyIndex(pyIndex(pyIndex(data, 'data'), 0), 'ts'));
        const localMs = Math.trunc(rt.now() * 1000);
        st.timeOffsetMs = serverMs - localMs;
        log.info(`OKX time offset = ${st.timeOffsetMs}ms`);
        return st.timeOffsetMs;
      }
    } catch (e) {
      rethrowCancelled(e);
      log.debug(`OKX sync_time: ${errStr(e)}`);
    }
    return 0;
  }

  async function _request(method, path, apiKey, secret, passphrase, params = null, body = null) {
    const ts = isoTs();
    let url = BASE_URL + path;
    const bodyStr = pyTruthy(body) ? pyJsonDumps(body) : '';
    let pathWithQs;
    if (method === 'GET' && pyTruthy(params)) {
      pathWithQs = `${path}?${pyUrlencode(params)}`;
      url = BASE_URL + pathWithQs;
    } else {
      pathWithQs = path;
    }
    const headers = {
      'OK-ACCESS-KEY': apiKey,
      'OK-ACCESS-SIGN': okxSign(ts, method, pathWithQs, bodyStr, secret),
      'OK-ACCESS-TIMESTAMP': ts,
      'OK-ACCESS-PASSPHRASE': passphrase,
      'Content-Type': 'application/json',
    };
    if (demo) headers['x-simulated-trading'] = '1';
    try {
      if (method === 'GET') {
        const resp = await rt.transport({ method: 'GET', url: yarlUrl(url), headers, timeoutMs: 15000 });
        return aiohttpJson(resp, { checkContentType: false });
      }
      if (method === 'POST') {
        const resp = await rt.transport({ method: 'POST', url: yarlUrl(url), headers, body: bodyStr, timeoutMs: 15000 });
        return aiohttpJson(resp, { checkContentType: false });
      }
      return null;
    } catch (e) {
      rethrowCancelled(e);
      if (e instanceof TransportError && e.kind === 'timeout') return { code: '-1', msg: 'timeout' };
      log.error('okx_trader._request() unhandled exception');
      let err = errStr(e);
      if (pyTruthy(passphrase) && String(passphrase).length > 2) err = err.split(String(passphrase)).join('<PASSPHRASE_REDACTED>');
      return { code: '-1', msg: err };
    }
  }

  async function _getInstrumentFilters(instId) {
    if (st.instrumentCache.has(instId)) {
      const c = st.instrumentCache.get(instId);
      return [c.lot, c.tick, true, c.lev];
    }
    try {
      const resp = await rt.transport({
        method: 'GET', url: `${BASE_URL}/api/v5/public/instruments?${aioQuery({ instType: 'SWAP', instId })}`, headers: {}, timeoutMs: 15000,
      });
      const data = aiohttpJson(resp, { checkContentType: false });
      const instruments = pyGet(data, 'data', []);
      if (pyTruthy(instruments)) {
        const inst = pyIndex(instruments, 0);
        const lot = pyFloat(pyGet(inst, 'lotSz', 1));
        const tick = pyFloat(pyGet(inst, 'tickSz', 0.01));
        const lev = pyInt(pyFloat(pyGet(inst, 'lever', 125)));
        let ctVal;
        try {
          ctVal = pyOr(pyFloat(pyOr(pyGet(inst, 'ctVal'), 1.0)), 1.0);
        } catch (e) {
          rethrowCancelled(e);
          if (!isPyErr(e, ['TypeError', 'ValueError'])) throw e;
          ctVal = 1.0;
        }
        // [OKX-LOT-CONTRACTS 2026-10] minSz — the minimum order size in contracts
        let minSz;
        try {
          minSz = pyFloat(pyOr(pyGet(inst, 'minSz'), lot));
        } catch (e) {
          rethrowCancelled(e);
          if (!isPyErr(e, ['TypeError', 'ValueError'])) throw e;
          minSz = lot;
        }
        st.instrumentCache.set(instId, { lot, tick, lev, ctVal, minSz });
        return [lot, tick, true, lev];
      }
    } catch (_e) {
      rethrowCancelled(_e);
      log.error('okx_trader._get_instrument_filters() unhandled exception');
    }
    return [1.0, 0.01, false, 125];
  }

  function okxCtVal(instId) {
    const c = st.instrumentCache.get(instId) || {};
    let v;
    try {
      v = pyFloat(pyOr(c.ctVal === undefined ? 1.0 : c.ctVal, 1.0));
    } catch (e) {
      rethrowCancelled(e);
      if (!isPyErr(e, ['TypeError', 'ValueError'])) throw e;
      v = 1.0;
    }
    return v > 0 ? v : 1.0;
  }

  /** [OKX-LOT-CONTRACTS] okx_min_sz: the instrument's minSz in contracts (lotSz when unknown). */
  function okxMinSz(instId, lot) {
    const c = st.instrumentCache.get(instId) || {};
    let v;
    try {
      v = pyFloat(pyOr(c.minSz === undefined ? lot : c.minSz, lot));
    } catch (e) {
      rethrowCancelled(e);
      if (!isPyErr(e, ['TypeError', 'ValueError'])) throw e;
      v = lot;
    }
    return v > 0 ? v : lot;
  }

  /** [OKX-LOT-CONTRACTS] _lots_sz: sz = n lots × lotSz with the decimals of lotSz. */
  const _lotsSz = (nLots, lot) => fmtFixed(nLots * lot, PP.stepDecimals(lot));

  /**
   * [OKX-LOT-CONTRACTS] _floor_lots: whole lots ≤ contracts; the quotient is rounded to 1e-9 of a
   * lot first (0.29 / 0.01 = 28.999999999999996 used to give 28 lots instead of 29).
   */
  function _floorLots(contracts, lot) {
    if (lot <= 0 || contracts <= 0) return 0;
    return Math.floor(pyRound(contracts / lot, 9));
  }

  function _toContracts(instId, qtyCoins, qtyStep) {
    if (qtyStep <= 0) return PP.roundQty(pyFloat(qtyCoins) / okxCtVal(instId), qtyStep);
    return _lotsSz(_floorLots(pyFloat(qtyCoins) / okxCtVal(instId), qtyStep), qtyStep);
  }

  /** okx_sz: coins → `sz` string in contracts (loads the instrument filters first). */
  async function okxSz(symbolOrInst, qtyCoins) {
    const instId = String(symbolOrInst).endsWith('-SWAP') ? String(symbolOrInst) : toOkxSymbol(symbolOrInst);
    const [qtyStep] = await _getInstrumentFilters(instId);
    return _toContracts(instId, qtyCoins, qtyStep);
  }

  async function getBalance(apiKey, secret, passphrase = '') {
    const data = await _request('GET', '/api/v5/account/balance', apiKey, secret, passphrase, { ccy: 'USDT' });
    try {
      const totalEq = pyGet(pyIndex(pyIndex(data, 'data'), 0), 'totalEq');
      if (pyTruthy(totalEq)) {
        const v = pyFloat(totalEq);
        if (v > 0) return v;
      }
    } catch (e) {
      rethrowCancelled(e);
      if (!isPyErr(e, ['KeyError', 'IndexError', 'ValueError', 'TypeError'])) throw e;
    }
    try {
      const details = pyIndex(pyIndex(pyIndex(data, 'data'), 0), 'details');
      for (const d of pyIter(details)) {
        if (pyIndex(d, 'ccy') === 'USDT') {
          const v = pyOr(pyGet(d, 'eq'), pyGet(d, 'cashBal'), pyGet(d, 'availBal'), 0);
          return pyFloat(pyOr(v, 0));
        }
      }
    } catch (_e) {
      rethrowCancelled(_e);
      log.error('okx_trader.get_balance() unhandled exception');
    }
    return 0.0;
  }

  async function getLastPrice(apiKey, secret, symbol, passphrase = '') {
    const instId = toOkxSymbol(symbol);
    try {
      const resp = await rt.transport({ method: 'GET', url: `${BASE_URL}/api/v5/market/ticker?${aioQuery({ instId })}`, headers: {}, timeoutMs: 15000 });
      const data = aiohttpJson(resp, { checkContentType: false });
      return pyFloat(pyIndex(pyIndex(pyIndex(data, 'data'), 0), 'last'));
    } catch (_e) {
      rethrowCancelled(_e);
      log.error('okx_trader.get_last_price() unhandled exception');
      return 0.0;
    }
  }

  async function testConnection(apiKey, secret, passphrase = '') {
    try {
      const balance = await getBalance(apiKey, secret, passphrase);
      if (balance >= 0) return { ok: true, balance };
      return { ok: false, error: 'Не удалось получить баланс OKX.' };
    } catch (e) {
      rethrowCancelled(e);
      log.error('okx_trader.test_connection() unhandled exception');
      return { ok: false, error: humanizeOkxError(errStr(e)) };
    }
  }

  const firstData = (resp) => pyIndex(pyGet(resp, 'data', [{}]), 0);

  async function placeTrade(apiKey, secret, symbol, direction, entry, sl, tp1, riskPct, leverage, o = {}) {
    const {
      tp2 = 0.0, tp3 = 0.0, riskMode = 'risk', passphrase = '', allowLowNotionalBoost = false, userId = 0, tradeId = null,
    } = o;
    const t0 = rt.monotonic();
    const ks = await killswitchGate(rt, 'okx_trader.place_trade');
    if (ks) return ks;
    const deny = await planGateDeny(rt, userId, symbol, 'okx');
    if (deny) return deny;
    try {
      const instId = toOkxSymbol(symbol);
      const side = ['LONG', 'BUY'].includes(pyUpper(String(direction))) ? 'buy' : 'sell';
      const posSide = side === 'buy' ? 'long' : 'short';
      const [qtyStep, tickSize, found, maxLev] = await _getInstrumentFilters(instId);
      if (!found) return { ok: false, order_id: '', error: `Инструмент ${instId} не найден на OKX.` };
      const equity = await getBalance(apiKey, secret, passphrase);
      if (equity <= 0) return { ok: false, order_id: '', error: 'Нулевой баланс OKX.' };

      const lev = Math.min(leverage, MAX_LEVERAGE, maxLev);
      try {
        const levResp = await _request('POST', '/api/v5/account/set-leverage', apiKey, secret, passphrase, null,
          { instId, lever: pyStr(lev), mgnMode: 'cross' });
        const levCode = pyGet(levResp, 'code', '-1');
        if (pyStr(levCode) !== '0') log.warning(`OKX set-leverage ${instId} ×${Math.trunc(lev)} FAILED: ${pyStr(pyGet(levResp, 'msg', ''))}`);
      } catch (le) {
        rethrowCancelled(le);
        log.warning(`OKX set-leverage ${instId} ×${Math.trunc(lev)} ERROR: ${errStr(le)}`);
      }

      const riskUsd = equity * (riskPct / 100.0);
      const slDist = Math.abs(entry - sl);
      if (slDist < 1e-10) return { ok: false, order_id: '', error: 'SL совпадает с ценой входа.' };
      let qtyRaw;
      if (riskMode === 'notional') qtyRaw = entry > 0 ? riskUsd / entry : 0;
      else if (riskMode === 'margin') qtyRaw = entry > 0 ? (equity * (riskPct / 100.0) * lev) / entry : 0;
      else qtyRaw = riskUsd / slDist;
      // [OKX-LOT-CONTRACTS 2026-10] lotSz / minSz of an OKX swap are in CONTRACTS (1 contract =
      // ctVal coins): the size is computed in contracts; below minSz there is no position (no
      // bump without the opt-in), qty = sz × ctVal (the coins actually sent)
      const ctVal = okxCtVal(instId);
      const minSz = okxMinSz(instId, qtyStep);
      const szFor = (coins) => {
        const n = _floorLots(coins / ctVal, qtyStep);
        if (n * qtyStep < minSz || n <= 0) return [_lotsSz(0, qtyStep), 0.0];
        return [_lotsSz(n, qtyStep), n * qtyStep * ctVal];
      };
      const coinDec = PP.stepDecimals(qtyStep * ctVal);
      let [szStr, qtyFloat] = szFor(qtyRaw);
      let qtyStr = fmtFixed(qtyFloat, coinDec);
      let notional = qtyFloat * entry;
      const minPos = Math.max(MIN_NOTIONAL, 10.0, minSz * ctVal * entry);
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
        [szStr, qtyFloat] = szFor(qtyRaw);
        if (qtyFloat <= 0) {
          // [OKX-LOT-CONTRACTS] opt-in: at least the exchange's minimum order
          const nMin = Math.max(1, Math.ceil(pyRound(minSz / qtyStep, 9)));
          szStr = _lotsSz(nMin, qtyStep);
          qtyFloat = nMin * qtyStep * ctVal;
        }
        qtyStr = fmtFixed(qtyFloat, coinDec);
        notional = qtyFloat * entry;
        if (notional < MIN_NOTIONAL) return { ok: false, order_id: '', error: `Объём слишком мал (${fmtFixed(notional, 2)} USDT).` };
        log.warning(`[AUDIT-FIX] ⚠️ Volume boosted to min (OKX user opt-in) ${instId}: qty=${qtyStr} notional=${fmtFixed(notional, 2)}`);
      }

      const slStr = PP.roundPrice(sl, tickSize);
      const closeSide = side === 'buy' ? 'sell' : 'buy';
      // [OKX-LOT-CONTRACTS] the TP shares in whole lots; a leg below minSz goes to TP1
      const nTotal = _floorLots(pyFloat(szStr), qtyStep);
      let nTp1;
      let nTp2;
      let nTp3;
      if (pyTruthy(tp2) && tp2 > 0) {
        nTp2 = Math.trunc(nTotal * 0.25);
        nTp3 = pyTruthy(tp3) ? Math.trunc(nTotal * 0.25) : 0;
        if (nTp2 * qtyStep < minSz) nTp2 = 0;
        if (nTp3 * qtyStep < minSz) nTp3 = 0;
        nTp1 = nTotal - nTp2 - nTp3;
      } else {
        nTp1 = nTotal;
        nTp2 = 0;
        nTp3 = 0;
      }
      const szTp = { 1: _lotsSz(nTp1, qtyStep), 2: _lotsSz(nTp2, qtyStep), 3: _lotsSz(nTp3, qtyStep) };
      const tidShort = pySlice(pyStr(pyTruthy(tradeId) ? tradeId : `t${Math.trunc(rt.now() * 1000) % 1e10}`), 10);
      const attach = [{
        attachAlgoClOrdId: `sl_${tidShort}`,
        slTriggerPx: slStr,
        slOrdPx: '-1',
        triggerPxType: 'mark',
        sz: szStr,
      }];
      if (pyTruthy(tp1) && tp1 > 0 && nTp1 > 0) {
        attach.push({
          attachAlgoClOrdId: `tp1_${tidShort}`,
          tpTriggerPx: PP.roundPrice(tp1, tickSize),
          tpOrdPx: '-1',
          triggerPxType: 'mark',
          sz: szTp[1],
        });
      }
      const entryBody = {
        instId, tdMode: 'cross', side, posSide, ordType: 'market', sz: szStr, attachAlgoOrds: attach,
      };
      let resp = await _request('POST', '/api/v5/trade/order', apiKey, secret, passphrase, null, entryBody);
      const respCode = pyStr(pyGet(resp, 'code', ''));
      const respMsg = pyOr(pyGet(firstData(resp), 'sMsg', ''), pyGet(resp, 'msg', ''));
      const atomicOk = respCode === '0';
      const attachUnsupported = !atomicOk && (respCode === '51000' || respCode === '51001' || pyLower(pyStr(pyOr(respMsg, ''))).includes('attachalgo'));

      let orderId;
      let atomicTp1Placed;
      if (atomicOk) {
        orderId = pyGet(firstData(resp), 'ordId', '');
        atomicTp1Placed = Boolean(pyTruthy(tp1) && tp1 > 0 && nTp1 > 0);
        log.info(`[OKX-ATOMIC-OK] ${instId}: entry+SL${atomicTp1Placed ? '+TP1' : ''} in single request`);
      } else {
        if (!attachUnsupported) return { ok: false, order_id: '', error: humanizeOkxError(pyOr(respMsg, 'unknown error')) };
        log.warning(`[OKX-ATOMIC-FALLBACK] ${instId}: attachAlgoOrds не поддерживается (${pySlice(respMsg, 120)}) — legacy flow`);
        const legacyBody = {};
        for (const k of Object.keys(entryBody)) if (k !== 'attachAlgoOrds') legacyBody[k] = entryBody[k];
        resp = await _request('POST', '/api/v5/trade/order', apiKey, secret, passphrase, null, legacyBody);
        if (pyGet(resp, 'code') !== '0') {
          const err = pyOr(pyGet(firstData(resp), 'sMsg', ''), pyGet(resp, 'msg', ''));
          return { ok: false, order_id: '', error: humanizeOkxError(err) };
        }
        orderId = pyGet(firstData(resp), 'ordId', '');
        const slBody = {
          instId, tdMode: 'cross', side: closeSide, posSide, ordType: 'conditional',
          sz: szStr, slTriggerPx: slStr, slOrdPx: '-1', triggerPxType: 'mark',
        };
        let slPlaced = false;
        let slLast = '';
        for (let a = 0; a < 3; a++) {
          const slResp = await _request('POST', '/api/v5/trade/order-algo', apiKey, secret, passphrase, null, slBody);
          if (pyGet(slResp, 'code') === '0') { slPlaced = true; break; }
          slLast = pySlice(pyStr(slResp), 200);
          await rt.sleep(1.5);
        }
        if (!slPlaced) {
          log.error(`OKX SL failed 3x ${instId}: ${slLast}`);
          try {
            const positions = await getPositions(apiKey, secret, symbol, passphrase);
            let liveSize = 0.0;
            for (const p of pyIter(pyOr(positions, []))) {
              const ps = pyFloat(pyOr(pyGet(p, 'pos', 0), pyGet(p, 'size', 0), 0));
              if (Math.abs(ps) > 0) { liveSize = Math.abs(ps); break; }
            }
            if (liveSize > 0) {
              log.error(`[SL-SAFETY-CLOSE-OKX] ${instId}: position alive size=${pyFloatStr(liveSize)} without SL — emergency reduceOnly close`);
              const cl = await closePosition(apiKey, secret, symbol, direction, passphrase);
              if (pyTruthy(pyGet(cl, 'ok'))) log.error(`[SL-SAFETY-CLOSE-OKX-OK] ${instId}: closed via market (qty=${pyFloatStr(liveSize)}) — user saved from naked exposure`);
              else log.error(`[SL-SAFETY-CLOSE-OKX-FAIL] ${instId}: ${pyStr(pyGet(cl, 'error', 'unknown'))} — BE-monitor takes over`);
            }
          } catch (se) {
            rethrowCancelled(se);
            log.error(`[SL-SAFETY-CLOSE-OKX-EXC] ${instId}: ${errStr(se)} — BE-monitor takes over`);
          }
        }
        atomicTp1Placed = false;
      }

      let tpList = [];
      if (pyTruthy(tp2) && tp2 > 0) {
        if (!atomicTp1Placed) tpList.push([tp1, nTp1, szTp[1]]);
        tpList.push([tp2, nTp2, szTp[2]]);
        if (pyTruthy(tp3) && nTp3 > 0) tpList.push([tp3, nTp3, szTp[3]]);
      } else {
        tpList = atomicTp1Placed ? [] : [[tp1, nTp1, szTp[1]]];
      }
      let tpCountOk = atomicTp1Placed ? 1 : 0;
      let tpCountExpected = atomicTp1Placed ? 1 : 0;
      for (const [tpPrice, tpLots, tpSz] of tpList) {
        if (tpLots <= 0 || tpPrice <= 0) continue;
        tpCountExpected += 1;
        const tpBody = {
          instId, tdMode: 'cross', side: closeSide, posSide, ordType: 'conditional',
          sz: tpSz, tpTriggerPx: PP.roundPrice(tpPrice, tickSize), tpOrdPx: '-1', triggerPxType: 'mark',
        };
        let tpOk = false;
        let tpLast = '';
        for (let a = 0; a < 3; a++) {
          const tpResp = await _request('POST', '/api/v5/trade/order-algo', apiKey, secret, passphrase, null, tpBody);
          if (pyGet(tpResp, 'code') === '0') { tpOk = true; tpCountOk += 1; break; }
          tpLast = pySlice(pyStr(tpResp), 200);
          await rt.sleep(1.5);
        }
        if (!tpOk) log.warning(`OKX TP@${fmtG(tpPrice, 6)} failed 3x [${instId}]: ${tpLast}`);
      }
      const tpPlaced = tpCountExpected > 0 && tpCountOk === tpCountExpected;
      if (tpCountExpected > 0 && tpCountOk < tpCountExpected) log.warning(`OKX TP partial fail [${instId}]: ${tpCountOk}/${tpCountExpected} placed`);
      await recordPlaced(rt, { symbol, direction, exchange: 'okx', t0, tpPlaced });
      return { ok: true, order_id: orderId, error: '', tp_placed: tpPlaced, qty: qtyStr, symbol: instId };
    } catch (e) {
      rethrowCancelled(e);
      if (e instanceof TransportError && e.kind === 'timeout') return { ok: false, order_id: '', error: 'Таймаут OKX.' };
      log.error(`OKX place_trade ${pyStr(symbol)}: ${errStr(e)}`);
      return { ok: false, order_id: '', error: errStr(e) };
    }
  }

  async function getPositions(apiKey, secret, symbol = null, passphrase = '') {
    const params = { instType: 'SWAP' };
    if (pyTruthy(symbol)) params.instId = toOkxSymbol(symbol);
    const data = await _request('GET', '/api/v5/account/positions', apiKey, secret, passphrase, params);
    const positions = [];
    for (const p of pyIter(pyGet(data, 'data', []))) {
      const pos = pyFloat(pyOr(pyGet(p, 'pos', 0), 0));
      if (pos === 0) continue;
      const inst = pyStr(pyOr(pyGet(p, 'instId', ''), ''));
      try { await _getInstrumentFilters(inst); } catch (_e) { rethrowCancelled(_e); /* pass */ }
      positions.push({
        symbol: inst,
        side: pyGet(p, 'posSide', ''),
        size: Math.abs(pos) * okxCtVal(inst),
        size_contracts: Math.abs(pos),
        entryPrice: pyFloat(pyOr(pyGet(p, 'avgPx', 0), 0)),
        markPrice: pyFloat(pyOr(pyGet(p, 'markPx', 0), 0)),
        unrealisedPnl: pyFloat(pyOr(pyGet(p, 'upl', 0), 0)),
        leverage: pyGet(p, 'lever', '1'),
        liqPrice: pyFloat(pyOr(pyGet(p, 'liqPx', 0), 0)),
        stopLoss: 0,
        positionIdx: 0,
      });
    }
    return positions;
  }

  async function getOpenOrders(apiKey, secret, passphrase = '') {
    const data = await _request('GET', '/api/v5/trade/orders-pending', apiKey, secret, passphrase, { instType: 'SWAP' });
    return pyIter(pyGet(data, 'data', [])).map((x) => ({
      orderId: pyGet(x, 'ordId', ''), symbol: pyGet(x, 'instId', ''), side: pyGet(x, 'side', ''), type: pyGet(x, 'ordType', ''),
    }));
  }

  async function _cancelOrderInner(apiKey, secret, symbol, orderId, passphrase = '') {
    const instId = toOkxSymbol(symbol);
    const resp = await _request('POST', '/api/v5/trade/cancel-order', apiKey, secret, passphrase, null, { instId, ordId: orderId });
    return { ok: pyGet(resp, 'code') === '0', error: pyGet(resp, 'msg', '') };
  }

  async function cancelOrder(apiKey, secret, symbol, orderId, passphrase = '') {
    return callWithRetry(_cancelOrderInner, {
      args: [apiKey, secret, symbol, orderId, passphrase], maxAttempts: 3, baseBackoff: 0.3,
      opName: `okx_cancel_order_${pyStr(symbol)}`, sleep: rt.sleep, random: rt.random, log,
    });
  }

  async function cancelAllOrders(apiKey, secret, symbol, passphrase = '') {
    const instId = toOkxSymbol(symbol);
    let cancelled = 0;
    const orders = await getOpenOrders(apiKey, secret, passphrase);
    for (const x of pyIter(orders)) {
      if (pyGet(x, 'symbol') === instId) {
        const r = await cancelOrder(apiKey, secret, symbol, pyIndex(x, 'orderId'), passphrase);
        if (pyTruthy(pyGet(r, 'ok'))) cancelled += 1;
      }
    }
    try {
      const algoResp = await _request('GET', '/api/v5/trade/orders-algo-pending', apiKey, secret, passphrase,
        { instType: 'SWAP', instId, ordType: 'conditional' });
      if (pyGet(algoResp, 'code') === '0') {
        const algos = pyOr(pyGet(algoResp, 'data', []), []);
        const payload = pyIter(algos).filter((a) => pyTruthy(pyGet(a, 'algoId'))).map((a) => ({ algoId: pyGet(a, 'algoId'), instId }));
        if (payload.length) {
          const r = await _request('POST', '/api/v5/trade/cancel-algos', apiKey, secret, passphrase, null, payload);
          if (pyGet(r, 'code') === '0') cancelled += payload.length;
          else log.debug(`OKX cancel-algos non-OK: ${pyStr(pyGet(r, 'msg', ''))}`);
        }
      }
    } catch (ae) {
      rethrowCancelled(ae);
      log.debug(`OKX cancel_all_orders algo: ${errStr(ae)}`);
    }
    return { ok: true, cancelled };
  }

  async function placeSlTpForPosition(apiKey, secret, symbol, direction, posSize, sl, tp1, tp2 = 0.0, tp3 = 0.0, passphrase = '') {
    try {
      const instId = toOkxSymbol(symbol);
      const [qtyStep, tickSize] = await _getInstrumentFilters(instId);
      const isLong = pyUpper(String(direction)) === 'LONG';
      const closeSide = isLong ? 'sell' : 'buy';
      const posSide = isLong ? 'long' : 'short';
      let slPlaced = false;
      let tpPlaced = false;
      try {
        const pending = await _request('GET', '/api/v5/trade/orders-algo-pending', apiKey, secret, passphrase, { instType: 'SWAP', instId });
        if (pyGet(pending, 'code') === '0') {
          const algos = pyOr(pyGet(pending, 'data', []), []);
          const payload = pyIter(algos).filter((a) => pyTruthy(pyGet(a, 'algoId'))).map((a) => ({ algoId: pyGet(a, 'algoId', ''), instId }));
          if (payload.length) await _request('POST', '/api/v5/trade/cancel-algos', apiKey, secret, passphrase, null, payload);
        }
      } catch (ce) {
        rethrowCancelled(ce);
        log.debug(`OKX cancel-algos ${instId}: ${errStr(ce)}`);
      }
      if (pyTruthy(sl) && sl > 0) {
        const slBody = {
          instId, tdMode: 'cross', side: closeSide, posSide, ordType: 'conditional', sz: '0',
          slTriggerPx: PP.roundPrice(sl, tickSize), slOrdPx: '-1', triggerPxType: 'mark',
        };
        for (let a = 0; a < 3; a++) {
          const r = await _request('POST', '/api/v5/trade/order-algo', apiKey, secret, passphrase, null, slBody);
          if (pyGet(r, 'code') === '0') { slPlaced = true; break; }
          await rt.sleep(1.0);
        }
        if (!slPlaced) log.warning(`OKX place_sl_tp_for_position SL ${instId} failed 3x`);
      }
      if (pyTruthy(tp1) && tp1 > 0 && posSize > 0) {
        let tpList = [];
        if (pyTruthy(tp2) && tp2 > 0) {
          const q2 = posSize * 0.25;
          const q3 = (pyTruthy(tp3) && tp3 > 0) ? posSize * 0.25 : 0.0;
          const q1 = Math.max(posSize - q2 - q3, 0.0);
          tpList.push([tp1, q1], [tp2, q2]);
          if (q3 > 0) tpList.push([tp3, q3]);
        } else {
          tpList = [[tp1, posSize]];
        }
        let expected = 0;
        let okCount = 0;
        for (const [tpPrice, tpQty] of tpList) {
          if (tpQty <= 0 || tpPrice <= 0) continue;
          const tpSz = _toContracts(instId, tpQty, qtyStep);
          if (pyFloat(tpSz) <= 0) {
            // [OKX-LOT-CONTRACTS] a share below one lot — no sz "0" is sent
            log.info(`[OKX-TP-SKIP-LOT] ${instId} TP@${pyFloatStr(tpPrice)} qty=${pyFloatStr(tpQty)} < 1 lot — skipped`);
            continue;
          }
          expected += 1;
          const tpBody = {
            instId, tdMode: 'cross', side: closeSide, posSide, ordType: 'conditional',
            sz: tpSz, tpTriggerPx: PP.roundPrice(tpPrice, tickSize), tpOrdPx: '-1', triggerPxType: 'mark',
          };
          let tpOk = false;
          for (let a = 0; a < 3; a++) {
            const r = await _request('POST', '/api/v5/trade/order-algo', apiKey, secret, passphrase, null, tpBody);
            if (pyGet(r, 'code') === '0') { okCount += 1; tpOk = true; break; }
            await rt.sleep(1.0);
          }
          if (!tpOk) log.warning(`OKX place_sl_tp_for_position TP@${fmtG(tpPrice, 6)} [${instId}] failed 3x`);
        }
        tpPlaced = expected > 0 && okCount === expected;
      }
      return { sl_placed: slPlaced, tp_placed: tpPlaced, error: (slPlaced && tpPlaced) ? '' : 'partial failure' };
    } catch (e) {
      rethrowCancelled(e);
      if (e instanceof TransportError && e.kind === 'timeout') return { sl_placed: false, tp_placed: false, error: 'OKX timeout' };
      log.error(`OKX place_sl_tp_for_position ${pyStr(symbol)}: ${errStr(e)}`);
      return { sl_placed: false, tp_placed: false, error: errStr(e) };
    }
  }

  /** posSide of the open positions of an instrument (Set), null when OKX did not answer (okx_trader._live_pos_sides). */
  async function _livePosSides(apiKey, secret, instId, passphrase = '') {
    const data = await _request('GET', '/api/v5/account/positions', apiKey, secret, passphrase, { instType: 'SWAP', instId });
    if (pyStr(pyGet(data, 'code', '')) !== '0') return null;
    const sides = new Set();
    for (const p of pyIter(pyOr(pyGet(data, 'data', []), []))) {
      let pos;
      try { pos = pyFloat(pyOr(pyGet(p, 'pos', 0), 0)); } catch (_e) { continue; }
      if (pos !== 0) sides.add(pyLower(pyStr(pyOr(pyGet(p, 'posSide', ''), 'net'))));
    }
    return sides;
  }

  /**
   * [OKX-CLOSE-CLEANUP 2026-10] (okx_trader._cleanup_side_orders): the closed side's leftovers. With
   * a live position of the other side (hedge long / short) its SL / TP stay: only this posSide's
   * orders and algo orders go; otherwise everything of the symbol, as before (cancelAllOrders).
   */
  async function _cleanupSideOrders(apiKey, secret, symbol, posSide, passphrase = '') {
    const instId = toOkxSymbol(symbol);
    const sides = await _livePosSides(apiKey, secret, instId, passphrase);
    const other = posSide === 'long' ? 'short' : 'long';
    if (sides !== null && !sides.has(other)) {
      const r = await cancelAllOrders(apiKey, secret, symbol, passphrase);
      return pyInt(pyOr(pyGet(r, 'cancelled', 0), 0));
    }
    let cancelled = 0;
    const orders = await _request('GET', '/api/v5/trade/orders-pending', apiKey, secret, passphrase, { instType: 'SWAP', instId });
    if (pyStr(pyGet(orders, 'code', '')) === '0') {
      for (const o of pyIter(pyOr(pyGet(orders, 'data', []), []))) {
        if (pyTruthy(pyGet(o, 'ordId')) && pyLower(pyStr(pyOr(pyGet(o, 'posSide', ''), ''))) === posSide) {
          const r = await cancelOrder(apiKey, secret, symbol, pyGet(o, 'ordId'), passphrase);
          if (pyTruthy(pyGet(r, 'ok'))) cancelled += 1;
        }
      }
    }
    const algoResp = await _request('GET', '/api/v5/trade/orders-algo-pending', apiKey, secret, passphrase,
      { instType: 'SWAP', instId, ordType: 'conditional' });
    if (pyStr(pyGet(algoResp, 'code', '')) !== '0') return cancelled;
    const payload = pyIter(pyOr(pyGet(algoResp, 'data', []), []))
      .filter((a) => pyTruthy(pyGet(a, 'algoId')) && pyLower(pyStr(pyOr(pyGet(a, 'posSide', ''), ''))) === posSide)
      .map((a) => ({ algoId: pyGet(a, 'algoId'), instId }));
    if (!payload.length) return cancelled;
    const r = await _request('POST', '/api/v5/trade/cancel-algos', apiKey, secret, passphrase, null, payload);
    return cancelled + (pyStr(pyGet(r, 'code', '')) === '0' ? payload.length : 0);
  }

  /**
   * close_position(direction): the whole position of "LONG" / "SHORT" ("Buy" / "Sell" as position
   * sides too). [OKX-CLOSE-CLEANUP 2026-10] the leftovers (SL / TP algos) go only when the close
   * went through or OKX confirms the position of this side is gone; an unknown state keeps them —
   * the bot used to cancel them after a failed close too, leaving the position without its stop.
   */
  async function closePosition(apiKey, secret, symbol, direction, passphrase = '') {
    const instId = toOkxSymbol(symbol);
    const d = pyUpper(pyStrip(pyStr(pyOr(direction, ''))));
    let posSide;
    if (d === 'LONG' || d === 'BUY') posSide = 'long';
    else if (d === 'SHORT' || d === 'SELL') posSide = 'short';
    else return { ok: false, error: `unknown direction: ${pyRepr(direction)}` };
    const resp = await _request('POST', '/api/v5/trade/close-position', apiKey, secret, passphrase, null, { instId, mgnMode: 'cross', posSide });
    const ok = pyStr(pyGet(resp, 'code', '')) === '0';
    let cleanup = ok;
    if (!ok) {
      try {
        const sides = await _livePosSides(apiKey, secret, instId, passphrase);
        cleanup = sides !== null && !sides.has(posSide);
        if (cleanup) log.info(`[OKX-CLOSE-CLEANUP] ${instId} ${posSide}: close failed (${pyStr(pyGet(resp, 'msg', ''))}) but the position is gone — removing residual orders`);
        else log.warning(`[OKX-CLOSE-CLEANUP] ${instId} ${posSide}: close failed (${pyStr(pyGet(resp, 'msg', ''))}) — SL/TP kept (position alive or unknown)`);
      } catch (pe) {
        rethrowCancelled(pe);
        cleanup = false;
        log.debug(`OKX close_position position check: ${errStr(pe)}`);
      }
    }
    if (cleanup) {
      try {
        await _cleanupSideOrders(apiKey, secret, symbol, posSide, passphrase);
      } catch (ce) {
        rethrowCancelled(ce);
        log.debug(`OKX close_position algo cleanup: ${errStr(ce)}`);
      }
    }
    return { ok, error: pyGet(resp, 'msg', '') };
  }

  /**
   * [QC-SIDE-FIX 2026-10] close_position_partial: part of a position with a market order of the
   * opposite side on the same posSide (OKX close-position closes only the whole). qty in coins,
   * sz in contracts rounded down to lotSz; 0 after rounding → nothing is sent.
   */
  async function closePositionPartial(apiKey, secret, symbol, direction, qtyCoins, passphrase = '') {
    const d = pyUpper(pyStrip(pyStr(pyOr(direction, ''))));
    if (d !== 'LONG' && d !== 'SHORT') return { ok: false, error: `unknown direction: ${pyRepr(direction)}` };
    const instId = toOkxSymbol(symbol);
    const sz = await okxSz(instId, pyFloat(pyOr(qtyCoins, 0)));
    if (pyFloat(sz) <= 0) return { ok: false, error: 'qty rounded to 0 (below lot size)', skipped: true };
    const body = { instId, tdMode: 'cross', side: d === 'LONG' ? 'sell' : 'buy', posSide: d === 'LONG' ? 'long' : 'short', ordType: 'market', sz };
    const resp = await _request('POST', '/api/v5/trade/order', apiKey, secret, passphrase, null, body);
    const ok = pyStr(pyGet(resp, 'code', '')) === '0';
    const data = pyGet(resp, 'data');
    const row = Array.isArray(data) && data.length ? data[0] : {};
    const err = ok ? '' : (pyTruthy(pyGet(row, 'sMsg')) ? pyGet(row, 'sMsg') : pyGet(resp, 'msg', ''));
    return { ok, order_id: pyStr(pyOr(pyGet(row, 'ordId', ''), '')), error: err };
  }

  async function getClosedPnl(apiKey, secret, symbol, passphrase = '') {
    const instId = toOkxSymbol(symbol);
    try {
      const data = await _request('GET', '/api/v5/account/positions-history', apiKey, secret, passphrase, { instType: 'SWAP', instId, limit: '20' });
      const out = [];
      for (const rec of pyIter(pyGet(data, 'data', []))) {
        const okxSide = pyOr(pyLower(pyStr(pyGet(rec, 'direction', ''))), pyLower(pyStr(pyGet(rec, 'posSide', ''))));
        let normSide;
        if (okxSide === 'long') normSide = 'Buy';
        else if (okxSide === 'short') normSide = 'Sell';
        else continue;
        let utime;
        let cp;
        let ep;
        let sz;
        let pnl;
        try {
          utime = pyFloat(pyOr(pyGet(rec, 'uTime', 0), 0));
          cp = pyFloat(pyOr(pyGet(rec, 'closeAvgPx', 0), 0));
          ep = pyFloat(pyOr(pyGet(rec, 'openAvgPx', 0), 0));
          sz = pyFloat(pyOr(pyGet(rec, 'closeTotalPos', 0), 0));
          pnl = pyFloat(pyOr(pyGet(rec, 'realizedPnl', 0), 0));
        } catch (_e) {
          rethrowCancelled(_e);
          log.error('okx_trader.get_closed_pnl() unhandled exception');
          continue;
        }
        if (cp <= 0) continue;
        out.push({
          side: normSide, updatedTime: utime, avgExitPrice: cp, avgEntryPrice: ep, closedSize: sz,
          pnl, closedPnl: pnl, orderLinkId: pyStr(pyOr(pyGet(rec, 'clOrdId', ''), '')),
        });
      }
      return out;
    } catch (e) {
      rethrowCancelled(e);
      log.debug(`OKX get_closed_pnl ${instId}: ${errStr(e)}`);
      return [];
    }
  }

  async function setTrailingSl(apiKey, secret, symbol, slPrice, direction, posIdx = 0, passphrase = '') {
    const instId = toOkxSymbol(symbol);
    const isLong = pyUpper(String(direction)) === 'LONG';
    const [, tick] = await _getInstrumentFilters(instId);
    const slBody = {
      instId, tdMode: 'cross', side: isLong ? 'sell' : 'buy', posSide: isLong ? 'long' : 'short', ordType: 'conditional',
      sz: '0', slTriggerPx: PP.roundPrice(slPrice, tick), slOrdPx: '-1', triggerPxType: 'mark',
    };
    const resp = await _request('POST', '/api/v5/trade/order-algo', apiKey, secret, passphrase, null, slBody);
    return { ok: pyGet(resp, 'code') === '0', error: pyGet(resp, 'msg', '') };
  }

  async function setBreakeven(apiKey, secret, symbol, entryPrice, direction, posIdx = 0, passphrase = '') {
    return setTrailingSl(apiKey, secret, symbol, entryPrice, direction, posIdx, passphrase);
  }

  async function getAccountSummary(apiKey, secret, passphrase = '') {
    const data = await _request('GET', '/api/v5/account/balance', apiKey, secret, passphrase);
    try {
      const acct = pyIndex(pyIndex(data, 'data'), 0);
      return {
        equity: pyFloat(pyGet(acct, 'totalEq', 0)),
        available: pyFloat(pyGet(pyIndex(pyGet(acct, 'details', [{}]), 0), 'availBal', 0)),
        unrealised_pnl: pyFloat(pyOr(pyGet(acct, 'upl', 0), 0)),
      };
    } catch (_e) {
      rethrowCancelled(_e);
      log.error('okx_trader.get_account_summary() unhandled exception');
      return { equity: 0, available: 0, unrealised_pnl: 0 };
    }
  }

  /** Bot quirk kept: the passphrase lands in get_positions' SYMBOL slot. Returns [summary, positions]. */
  async function getDashboard(apiKey, secret, passphrase = '') {
    const summary = await getAccountSummary(apiKey, secret, passphrase);
    const positions = await getPositions(apiKey, secret, passphrase);
    return [summary, positions];
  }

  return {
    rt, _state: st,
    placeTrade, getPositions, getOpenOrders, closePosition, closePositionPartial, cancelOrder, cancelAllOrders, placeSlTpForPosition,
    setTrailingSl, setBreakeven, getClosedPnl, getAccountSummary, getDashboard, getBalance, getLastPrice, testConnection,
    syncTime, okxSz, okxCtVal, okxMinSz,
    _request, _getInstrumentFilters, _toContracts, _cancelOrderInner, _isoTimestamp: isoTs, _livePosSides, _cleanupSideOrders,
  };
}

function formatTradeResult(result, direction, symbol, entry, sl, tp1, riskPct, leverage, tp2 = 0.0, tp3 = 0.0) {
  const fp = PP.fmtPriceDisplay;
  const sym = htmlEscape(String(symbol).split('-USDT-SWAP').join('').split('-USDT').join(''));
  if (!pyTruthy(pyGet(result, 'ok'))) {
    const err = htmlEscape(pySlice(pyStr(pyGet(result, 'error', 'Unknown')), 200));
    return `❌ <b>OKX ордер не выполнен</b>\n${sym} ${direction}\n\n<code>${err}</code>`;
  }
  const oid = pyStr(pyGet(result, 'order_id', '—'));
  const qty = pyStr(pyGet(result, 'qty', '?'));
  const dirEm = direction === 'LONG' ? '📈' : '📉';
  let tpLine = `🎯 TP1: <code>${fp(tp1)}</code>`;
  if (pyTruthy(tp2)) tpLine += `  |  TP2: <code>${fp(tp2)}</code>`;
  if (pyTruthy(tp3)) tpLine += `  |  TP3: <code>${fp(tp3)}</code>`;
  return `${dirEm} <b>OKX ${direction}</b>  ${sym}  ×${leverage}\n\n`
    + `💰 Entry: <code>${fp(entry)}</code>\n`
    + `🛑 SL: <code>${fp(sl)}</code>\n`
    + `${tpLine}\n`
    + `📊 Qty: ${qty}  |  Risk: ${fmtFixed(riskPct, 2)}%\n`
    + `🆔 <code>${oid}</code>`;
}

let _default = null;
function defaultTrader() {
  if (!_default) _default = createOkxTrader();
  return _default;
}

module.exports = {
  createOkxTrader, defaultTrader, BASE_URL, MIN_NOTIONAL, MAX_LEVERAGE, TAKER_FEE, MAKER_FEE, OKX_ERROR_MAP,
  humanizeOkxError, toOkxSymbol, okxPriceMultiplier, okxSign, isoTimestamp, formatTradeResult,
};
