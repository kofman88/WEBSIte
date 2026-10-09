'use strict';
/**
 * partialTp.js — port of partial_tp.py: the partial take-profit ladder placed right after an
 * auto-trade opens (and re-placed by the BE monitor, M15).
 *
 *   placePartialTpOrders(kw) → any order placed   (place_partial_tp_orders, bot kwargs snake_case:
 *       api_key, api_secret, symbol, entry, sl, direction, total_qty, user, strategy_name, exchange,
 *       bybit_demo, pos_idx, skip_tp1, skip_tp2, tp1_signal_price, tp2_signal_price, bot, passphrase)
 *   calculatePartialTpPrices(entry, sl, dir, tp1R, tp2R)  round(entry ± risk·r, 8)
 *   calculatePartialTpQty(total, tp1Pct, tp2Pct)           [PTP-PCT-CLAMP]
 *   buTargetPrice / shouldApplyBuAfterPartial               AUDIT-FIX-C74 (BE-monitor hooks, M15)
 *
 * Order placement goes through the trader instances' own request layer (Bybit pybit session +
 * bybit_call, BingX / Binance / OKX `_request`), exactly the bot's endpoints and bodies.
 * QUIRK (pinned): the avg-entry fetch and the final position check read `kwargs.get("bybit_demo")`,
 * which is never set (bybit_demo is a named parameter) → they always query the LIVE Bybit host.
 * QUIRK: `user` defaults — tp1_r 1.5 / tp1_pct 25 / tp2_r 2.0 / tp2_pct 25 — differ from the user
 * settings defaults (1.0 / 50 / 1.5 / 40); they only apply when the attribute is missing/falsy.
 */

const { waitFor, isCancelledError } = require('./asyncio');
const { isThreadCall } = require('./traders');
const { pf } = require('./pyfmt');
const { t } = require('./messages');
const { fitPartialSplit, getMinNotional } = require('../exchanges/tpLadderFit');
const PP = require('../exchanges/pricePrecision');
const { pyFloat, pyGet, pyOr, pyCmp, pySlice, pyFloatStr } = require('../exchanges/pyCompat');
const { pyRound } = require('../../strategies/common/pyround');
const { pyUpper } = require('../../strategies/common/pyUnicode');
const { toBingxSymbol, bingxPriceMultiplier } = require('../exchanges/bingxTrader');
const { toBinanceSymbol, binancePriceMultiplier } = require('../exchanges/binanceTrader');
const { toOkxSymbol, okxPriceMultiplier } = require('../exchanges/okxTrader');
const { toBybitSymbol, bybitPriceMultiplier } = require('../exchanges/bybitTrader');

const errText = (e) => (e && e.message !== undefined ? String(e.message) : String(e));
const own = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
const getattr = (o, k, d) => (own(o, k) && o[k] !== undefined ? o[k] : d);
const orNum = (v, d) => (v === null || v === undefined || v === false || v === 0 || v === '' ? d : v);

function buTargetPrice(entry, direction, feePct = 0.0015) {
  const buf = entry * Number(feePct);
  return pyUpper(direction) === 'LONG' ? entry + buf : entry - buf;
}

function shouldApplyBuAfterPartial({
  initialQty, posSizeNow, currentSl, entry, direction, beAlreadySet, threshold = 0.95,
  markPrice = 0.0, slDist = 0.0, minProgressionR = 1.8,
}) {
  if (beAlreadySet) return false;
  if (initialQty <= 0 || posSizeNow <= 0) return false;
  if (posSizeNow >= initialQty * threshold) return false;
  const d = pyUpper(direction);
  if (d === 'LONG') {
    if (!(currentSl <= 0 || currentSl < entry)) return false;
  } else if (d === 'SHORT') {
    if (!(currentSl <= 0 || currentSl > entry)) return false;
  } else {
    return false;
  }
  if (markPrice > 0 && slDist > 0 && minProgressionR > 0) {
    const prog = d === 'LONG' ? (markPrice - entry) / slDist : (entry - markPrice) / slDist;
    if (prog < minProgressionR) return false;
  }
  return true;
}

function calculatePartialTpPrices(entry, sl, direction, tp1R = 1.0, tp2R = 1.5) {
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return [entry, entry];
  let p1;
  let p2;
  if (pyUpper(direction) === 'LONG') { p1 = entry + risk * tp1R; p2 = entry + risk * tp2R; }
  else { p1 = entry - risk * tp1R; p2 = entry - risk * tp2R; }
  return [pyRound(p1, 8), pyRound(p2, 8)];
}

function createPartialTp({ traderFor, log = null, sleep = null, sendMessage = null, enqueueCritical = null, adminAlert = null, timers = undefined } = {}) {
  const logger = log || require('../marketData/mdLog').log;
  const asleep = sleep || ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  const call = (exchange, fn, timeoutS, thunk) => waitFor(thunk, timeoutS, { shield: isThreadCall(exchange, fn), timers });

  function calculatePartialTpQty(totalQty, tp1Pct = 40.0, tp2Pct = 30.0) {
    let p2 = tp2Pct;
    if (tp1Pct + tp2Pct > 100.0) {
      const np = Math.max(0.0, 100.0 - tp1Pct);
      logger.warning(pf('[PTP-PCT-CLAMP] tp1=%.1f%% + tp2=%.1f%% > 100%% — clamping tp2 to %.1f%% to prevent over-close', tp1Pct, tp2Pct, np));
      p2 = np;
    }
    const qty1 = totalQty * tp1Pct / 100.0;
    const qty2 = totalQty * p2 / 100.0;
    return [qty1, qty2, Math.max(totalQty - qty1 - qty2, 0.0)];
  }

  async function fetchActualAvgEntry({ exchange, apiKey, apiSecret, symbol, user, bybitDemo = false }) {
    let positions;
    try {
      const tr = traderFor(exchange);
      if (exchange === 'bingx' || exchange === 'binance') {
        positions = await call(exchange, 'getPositions', 8, () => tr.getPositions(apiKey, apiSecret, symbol));
      } else if (exchange === 'okx') {
        positions = await call(exchange, 'getPositions', 8, () => tr.getPositions(apiKey, apiSecret, symbol, getattr(user, 'okx_passphrase', '') || ''));
      } else {
        positions = await call('bybit', 'getPositions', 8, () => traderFor('bybit').getPositions(apiKey, apiSecret, symbol, bybitDemo));
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      logger.debug(pf('[_fetch_actual_avg_entry] %s/%s: %s', exchange, symbol, errText(e)));
      return 0.0;
    }
    for (const p of (positions || [])) {
      try {
        const size = pyFloat(pyOr(pyGet(p, 'size', 0), pyGet(p, 'pos', 0), 0));
        if (size <= 0) continue;
        const avg = pyOr(pyGet(p, 'avgPrice'), pyGet(p, 'entryPrice'), pyGet(p, 'avgPx'), pyGet(p, 'avg_price'), 0);
        const avgF = pyFloat(pyOr(avg, 0));
        if (avgF <= 0) {
          logger.debug(`[FETCH-AVG-FALLBACK] ${exchange}/${symbol}: avg fields all empty`);
          return avgF;
        }
        try {
          let pmult = 1.0;
          if (exchange === 'bybit') pmult = Number(orNum(bybitPriceMultiplier(symbol), 1.0));
          else if (exchange === 'bingx') pmult = Number(orNum(bingxPriceMultiplier(symbol), 1.0));
          else if (exchange === 'binance') pmult = Number(orNum(binancePriceMultiplier(symbol), 1.0));
          else if (exchange === 'okx') pmult = Number(orNum(okxPriceMultiplier(symbol), 1.0));
          if (pmult && pmult !== 1.0) {
            const norm = avgF / pmult;
            logger.info(pf('[FETCH-AVG-PMULT] %s/%s: avg %.8g / pmult=%g → %.8g (exchange-format → OKX-format normalization)', exchange, symbol, avgF, pmult, norm));
            return norm;
          }
        } catch (pe) {
          logger.warning(pf('[FETCH-AVG-PMULT] %s/%s: pmult lookup failed: %s — returning raw avg (slip recalc may misbehave on memcoins)', exchange, symbol, errText(pe)));
        }
        return avgF;
      } catch (_e) {
        logger.warning('_fetch_actual_avg_entry: position parse error');
      }
    }
    return 0.0;
  }

  async function notifyLadderDowngrade(bot, user, symbol, fit) {
    if (!bot || !user || !fit.downgrade_reason) return;
    try {
      const uid = Math.trunc(Number(orNum(getattr(user, 'user_id', 0), 0)));
      if (uid <= 0) return;
      const lang = orNum(getattr(user, 'lang', 'ru'), 'ru');
      const n = Math.trunc(Number(orNum(fit.n_levels_fit, 0)));
      const minN = Number(orNum(fit.min_notional, 5.0));
      const fullMin = pyRound(minN / 0.30, 2);
      const totalApprox = Number(orNum(fit.tp1_qty, 0)) + Number(orNum(fit.tp2_qty, 0)) + Number(orNum(fit.main_tp_qty, 0));
      const symClean = String(symbol).split('-USDT-SWAP').join('').split('-USDT').join('');
      const pluralRu = n === 1 ? '' : ([2, 3, 4].includes(n) ? 'я' : 'ей');
      const pluralEn = n === 1 ? '' : 's';
      const text = t('tp_ladder_downgrade', lang, {
        symbol: symClean,
        notional_usd: pf('%.4g', totalApprox),
        n_levels: n,
        plural: lang === 'ru' ? pluralRu : pluralEn,
        full_min_usd: pf('%.0f', fullMin),
        min_notional: pf('%.0f', minN),
      });
      const ok = await sendMessage(bot, uid, text, { parseMode: 'HTML' });
      if (!ok) {
        try {
          if (enqueueCritical) await enqueueCritical(bot, uid, text, { parseMode: 'HTML', reason: `tp_ladder_downgrade_${fit.downgrade_reason || ''}` });
        } catch (qe) {
          logger.debug(pf('ladder-downgrade enqueue uid=%s: %s', uid, errText(qe)));
        }
      }
    } catch (e) {
      logger.debug(`notify ladder downgrade exc: ${errText(e)}`);
    }
  }

  function applyFit(strategyName, symbol, exchangeLabel, fit, qty1, qty2) {
    if (fit.downgrade_reason) {
      logger.info(pf('[TP-LADDER-FIT] %s %s %s: reason=%s n_levels=%d qty1=%.6g qty2=%.6g (was %.6g/%.6g)',
        strategyName, symbol, exchangeLabel, fit.downgrade_reason, fit.n_levels_fit, fit.tp1_qty, fit.tp2_qty, qty1, qty2));
    }
  }

  async function placePartialTpOrders(kw) {
    const {
      api_key: apiKey, api_secret: apiSecret, symbol, entry, sl, direction, total_qty: totalQty, user,
      strategy_name: strategyName = '', exchange = 'bybit', bybit_demo: bybitDemo = false, pos_idx: posIdx = 0,
      skip_tp1: skipTp1 = false, skip_tp2: skipTp2 = false, tp1_signal_price: tp1Sig = 0.0, tp2_signal_price: tp2Sig = 0.0,
    } = kw;
    const kwargs = {};
    for (const k of Object.keys(kw)) {
      if (!['api_key', 'api_secret', 'symbol', 'entry', 'sl', 'direction', 'total_qty', 'user', 'strategy_name', 'exchange',
        'bybit_demo', 'pos_idx', 'skip_tp1', 'skip_tp2', 'tp1_signal_price', 'tp2_signal_price'].includes(k)) kwargs[k] = kw[k];
    }
    const bot = kwargs.bot === undefined ? null : kwargs.bot;
    if (!truthyPy(getattr(user, 'partial_tp_enabled', false))) return false;
    const tp1R = Number(orNum(getattr(user, 'partial_tp1_r', 1.5), 1.5));
    const tp1Pct = Number(orNum(getattr(user, 'partial_tp1_pct', 25.0), 25.0));
    const tp2R = Number(orNum(getattr(user, 'partial_tp2_r', 2.0), 2.0));
    const tp2Pct = Number(orNum(getattr(user, 'partial_tp2_pct', 25.0), 25.0));
    if (totalQty <= 0 || entry <= 0 || sl <= 0) return false;
    const dCheck = pyUpper(direction);

    let usedSig = false;
    let tp1Price = 0.0;
    let tp2Price = 0.0;
    if (tp1Sig > 0 || tp2Sig > 0) {
      let valid = true;
      if (!skipTp1) {
        if (tp1Sig <= 0) valid = false;
        else if (dCheck === 'LONG' && tp1Sig <= entry) valid = false;
        else if (dCheck === 'SHORT' && tp1Sig >= entry) valid = false;
      }
      if (valid && !skipTp2) {
        if (tp2Sig <= 0) valid = false;
        else if (dCheck === 'LONG' && tp2Sig <= entry) valid = false;
        else if (dCheck === 'SHORT' && tp2Sig >= entry) valid = false;
      }
      if (valid && !skipTp1 && !skipTp2) {
        if (dCheck === 'LONG' && tp2Sig <= tp1Sig) valid = false;
        else if (dCheck === 'SHORT' && tp2Sig >= tp1Sig) valid = false;
      }
      if (valid) {
        tp1Price = !skipTp1 ? tp1Sig : 0.0;
        tp2Price = !skipTp2 ? tp2Sig : 0.0;
        usedSig = true;
        logger.info(pf('[PTP-SIG-PRICES] %s %s %s: using signal tp1=%.6g tp2=%.6g (strategy-computed, bypass R-multiples + slip-recalc)',
          strategyName, symbol, direction, tp1Price, tp2Price));
      } else {
        logger.warning(pf('[PTP-SIG-PRICES-INVALID] %s %s %s: signal prices tp1=%.6g tp2=%.6g vs entry=%.6g failed direction/order check (skip_tp1=%s skip_tp2=%s) — falling back to R-multiples + slip-recalc',
          strategyName, symbol, direction, tp1Sig, tp2Sig, entry, Boolean(skipTp1), Boolean(skipTp2)));
      }
    }

    // QUIRK: kwargs.get("bybit_demo", False) — never set → live Bybit host
    const actualAvg = await fetchActualAvgEntry({ exchange, apiKey, apiSecret, symbol, user, bybitDemo: Boolean(kwargs.bybit_demo) });

    if (!usedSig) {
      let entryForTp = entry;
      if (actualAvg > 0 && entry > 0) {
        const slipPct = Math.abs(actualAvg - entry) / entry * 100.0;
        if (slipPct >= 0.3) {
          logger.warning(pf('[PTP-SLIP-RECALC] %s %s %s: planned_entry=%.6g actual_avg=%.6g slip=%.2f%% — recalculating TP from actual fill',
            strategyName, symbol, direction, entry, actualAvg, slipPct));
          entryForTp = actualAvg;
        }
      }
      [tp1Price, tp2Price] = calculatePartialTpPrices(entryForTp, sl, direction, tp1R, tp2R);
    }

    if (actualAvg > 0 && !skipTp1) {
      if (dCheck === 'LONG' && tp1Price <= actualAvg) {
        logger.warning(pf('[PTP-SAFETY-GUARD] %s %s LONG: tp1=%.6g <= avg=%.6g (would fire as exit-at-loss) — SKIPPING partial TP, BE-monitor will retry', strategyName, symbol, tp1Price, actualAvg));
        return false;
      }
      if (dCheck === 'SHORT' && tp1Price >= actualAvg) {
        logger.warning(pf('[PTP-SAFETY-GUARD] %s %s SHORT: tp1=%.6g >= avg=%.6g (would fire as exit-at-loss) — SKIPPING partial TP, BE-monitor will retry', strategyName, symbol, tp1Price, actualAvg));
        return false;
      }
    }
    if (actualAvg > 0 && !skipTp2 && tp2Price > 0) {
      if (dCheck === 'LONG' && tp2Price <= actualAvg) {
        logger.warning(pf('[PTP-SAFETY-GUARD] %s %s LONG: tp2=%.6g <= avg=%.6g (would fire as exit-at-loss) — SKIPPING partial TP', strategyName, symbol, tp2Price, actualAvg));
        return false;
      }
      if (dCheck === 'SHORT' && tp2Price >= actualAvg) {
        logger.warning(pf('[PTP-SAFETY-GUARD] %s %s SHORT: tp2=%.6g >= avg=%.6g (would fire as exit-at-loss) — SKIPPING partial TP', strategyName, symbol, tp2Price, actualAvg));
        return false;
      }
    }

    let [qty1, qty2] = calculatePartialTpQty(totalQty, tp1Pct, tp2Pct);
    if (skipTp1) qty1 = 0.0;
    if (skipTp2) qty2 = 0.0;
    if (qty1 <= 0 && qty2 <= 0) return false;

    let anyPlaced = false;
    let race110017 = 0;
    let failedAttempts = 0;
    const d = pyUpper(direction);

    if (exchange === 'bingx') {
      const bx = traderFor('bingx');
      const side = d === 'LONG' ? 'Sell' : 'Buy';
      const bingxSym = toBingxSymbol(symbol);
      const [bxStep, bxTick] = await bx.inst._getInstrumentFilters(bingxSym);
      const bxPmult = bingxPriceMultiplier(symbol);
      try {
        const fit = fitPartialSplit({ total_qty: totalQty, price: tp1Price, qty_step: bxStep, pmult: bxPmult, exchange: 'bingx', desired_tp1_pct: tp1Pct, desired_tp2_pct: tp2Pct });
        applyFit(strategyName, symbol, 'bingx', fit, qty1, qty2);
        if (fit.downgrade_reason) await notifyLadderDowngrade(bot, user, symbol, fit);
        qty1 = fit.tp1_qty;
        qty2 = fit.tp2_qty;
      } catch (fe) {
        logger.debug(`ladder-fit bingx fallback: ${errText(fe)}`);
      }
      for (const [label, qty, price] of [['TP1', qty1, tp1Price], ['TP2', qty2, tp2Price]]) {
        if (qty <= 0) continue;
        try {
          const qtyStr = PP.roundQty(qty, bxStep);
          if (pyFloat(qtyStr) < bxStep) {
            logger.warning(pf('[PTP-SKIP-MIN] Partial %s skipped [%s %s]: qty %.6g < stepSize %.6g', label, strategyName, symbol, qty, bxStep));
            continue;
          }
          const bxPrice = bxPmult !== 1.0 ? price * bxPmult : price;
          if (pyFloat(qtyStr) * bxPrice < 5.0) {
            logger.warning(pf('[PTP-SKIP-MIN] Partial %s skipped [%s %s]: notional %.2f < MIN_NOTIONAL', label, strategyName, symbol, pyFloat(qtyStr) * bxPrice));
            continue;
          }
          const priceStr = PP.roundPrice(price * bxPmult, bxTick);
          const body = { symbol: bingxSym, side, type: 'TAKE_PROFIT_MARKET', quantity: qtyStr, stopPrice: priceStr, workingType: 'MARK_PRICE' };
          let ok = false;
          let last = {};
          for (let attempt = 0; attempt < 3; attempt++) {
            const result = await bx.inst._request('POST', '/openApi/swap/v2/trade/order', apiKey, apiSecret, body);
            if (pyGet(result, 'code') === 0) { ok = true; break; }
            last = result;
            const code = pyGet(result, 'code');
            if ((code === 110413 || code === 110414) && attempt < 2) {
              let newTp = null;
              try {
                const cur = await bx.getLastPrice(apiKey, apiSecret, symbol);
                if (cur && cur > 0) newTp = code === 110413 ? cur * (1 + 0.015) : cur * (1 - 0.015);
              } catch (_e) { /* fallback below */ }
              if (newTp === null) {
                const adjPct = 0.005 * (attempt + 1);
                const adj = code === 110413 ? (1 + adjPct) : (1 - adjPct);
                newTp = pyFloat(body.stopPrice) * adj;
              }
              body.stopPrice = PP.roundPrice(newTp, bxTick);
              continue;
            }
            break;
          }
          if (ok) anyPlaced = true;
          else logger.warning(pf('Partial %s failed [%s %s] after 3 attempts: %s', label, strategyName, symbol, last));
        } catch (e) {
          if (isCancelledError(e)) throw e;
          logger.warning(pf('Partial %s failed [%s %s]: %s', label, strategyName, symbol, errText(e)));
        }
      }
    } else if (exchange === 'binance') {
      const bn = traderFor('binance');
      const closeSide = d === 'LONG' ? 'SELL' : 'BUY';
      const posSide = d === 'LONG' ? 'LONG' : 'SHORT';
      const bnSym = toBinanceSymbol(symbol);
      const [bnStep, bnTick] = await bn.inst._getInstrumentFilters(bnSym);
      const pmult = binancePriceMultiplier(symbol);
      try {
        const fit = fitPartialSplit({ total_qty: totalQty, price: tp1Price, qty_step: bnStep, pmult, exchange: 'binance', desired_tp1_pct: tp1Pct, desired_tp2_pct: tp2Pct });
        applyFit(strategyName, symbol, 'binance', fit, qty1, qty2);
        if (fit.downgrade_reason) await notifyLadderDowngrade(bot, user, symbol, fit);
        qty1 = fit.tp1_qty;
        qty2 = fit.tp2_qty;
      } catch (fe) {
        logger.debug(`ladder-fit binance fallback: ${errText(fe)}`);
      }
      for (const [label, qty, price] of [['TP1', qty1, tp1Price], ['TP2', qty2, tp2Price]]) {
        if (qty <= 0) continue;
        try {
          const qtyStr = PP.roundQty(qty, bnStep);
          if (pyFloat(qtyStr) < bnStep) {
            logger.warning(pf('[PTP-SKIP-MIN] Partial %s skipped [%s %s]: qty %.6g < stepSize %.6g', label, strategyName, symbol, qty, bnStep));
            continue;
          }
          const bnPrice = pmult !== 1.0 ? price * pmult : price;
          if (pyFloat(qtyStr) * bnPrice < 5.0) {
            logger.warning(pf('[PTP-SKIP-MIN] Partial %s skipped [%s %s]: notional %.2f < MIN_NOTIONAL', label, strategyName, symbol, pyFloat(qtyStr) * bnPrice));
            continue;
          }
          const priceStr = PP.roundPrice(price * pmult, bnTick);
          const params = {
            symbol: bnSym, side: closeSide, positionSide: posSide, type: 'TAKE_PROFIT_MARKET', quantity: qtyStr,
            stopPrice: priceStr, workingType: 'MARK_PRICE', timeInForce: 'GTC',
          };
          const resp = await bn.inst._request('POST', '/fapi/v1/order', apiKey, apiSecret, params);
          if (pyCmp(pyGet(resp, 'code', 0), '>=', 0)) anyPlaced = true;
          else logger.warning(pf('Partial %s failed [%s %s]: %s', label, strategyName, symbol, resp));
        } catch (e) {
          if (isCancelledError(e)) throw e;
          logger.warning(pf('Partial %s failed [%s %s]: %s', label, strategyName, symbol, errText(e)));
        }
      }
    } else if (exchange === 'okx') {
      const ok = traderFor('okx');
      const closeSide = d === 'LONG' ? 'sell' : 'buy';
      const okxSym = toOkxSymbol(symbol);
      const pp = (kwargs.passphrase ? String(kwargs.passphrase) : String(getattr(user, 'okx_passphrase', '') || ''));
      const RETRIES = 3;
      try {
        const okxPmult = okxPriceMultiplier(symbol);
        const fit = fitPartialSplit({ total_qty: totalQty, price: tp1Price, qty_step: 1e-5, pmult: okxPmult, exchange: 'okx', desired_tp1_pct: tp1Pct, desired_tp2_pct: tp2Pct });
        applyFit(strategyName, symbol, 'okx', fit, qty1, qty2);
        if (fit.downgrade_reason) await notifyLadderDowngrade(bot, user, symbol, fit);
        qty1 = fit.tp1_qty;
        qty2 = fit.tp2_qty;
      } catch (fe) {
        logger.debug(`ladder-fit okx fallback: ${errText(fe)}`);
      }
      for (const [label, qty, price] of [['TP1', qty1, tp1Price], ['TP2', qty2, tp2Price]]) {
        if (qty <= 0) continue;
        let placed = false;
        let lastErr = null;
        for (let attempt = 0; attempt < RETRIES; attempt++) {
          try {
            const sz = await ok.inst.okxSz(okxSym, qty);
            const resp = await ok.inst._request('POST', '/api/v5/trade/order', apiKey, apiSecret, pp, null, {
              instId: okxSym, tdMode: 'cross', side: closeSide, ordType: 'limit', sz, px: pyFloatStr(pyRound(price, 8)), reduceOnly: true,
            });
            if (pyGet(resp, 'code') === '0') { anyPlaced = true; placed = true; break; }
            lastErr = pf('%s', resp);
            logger.info(pf('[OKX-PTP-RETRY] %s [%s %s] attempt %d/%d failed: %s', label, strategyName, symbol, attempt + 1, RETRIES, resp));
          } catch (e) {
            if (isCancelledError(e)) throw e;
            lastErr = errText(e);
            logger.info(pf('[OKX-PTP-RETRY] %s [%s %s] attempt %d/%d exception: %s', label, strategyName, symbol, attempt + 1, RETRIES, errText(e)));
          }
          if (attempt < RETRIES - 1) await asleep(1.0);
        }
        if (!placed) logger.warning(pf('Partial %s failed [%s %s] after %d retries: %s', label, strategyName, symbol, RETRIES, lastErr));
      }
    } else {
      const by = traderFor('bybit');
      const closeSide = d === 'LONG' ? 'Sell' : 'Buy';
      const bbSym = toBybitSymbol(symbol);
      let session = by.inst._getSession(apiKey, apiSecret, bybitDemo);
      const [qtyStep, tickSize] = await by.inst._getInstrumentFilters(session, bbSym, apiKey);
      const bbPmult = bybitPriceMultiplier(symbol);
      try {
        const fit = fitPartialSplit({ total_qty: totalQty, price: tp1Price, qty_step: qtyStep, pmult: bbPmult, exchange: 'bybit', desired_tp1_pct: tp1Pct, desired_tp2_pct: tp2Pct });
        applyFit(strategyName, symbol, 'bybit', fit, qty1, qty2);
        if (fit.downgrade_reason) await notifyLadderDowngrade(bot, user, symbol, fit);
        qty1 = fit.tp1_qty;
        qty2 = fit.tp2_qty;
      } catch (fe) {
        logger.warning(pf('[LADDER-FIT-FALLBACK-BYBIT] %s: %s — using legacy qty1=%.4g qty2=%.4g (notional may be below MIN — defensive guard below will downgrade)', symbol, errText(fe), qty1, qty2));
      }
      try {
        const minNotional = getMinNotional('bybit');
        const effTp1 = Number(tp1Price) * Number(orNum(bbPmult, 1.0));
        const effTp2 = Number(tp2Price) * Number(orNum(bbPmult, 1.0));
        const n1 = qty1 > 0 ? qty1 * effTp1 : 0;
        const n2 = qty2 > 0 ? qty2 * effTp2 : 0;
        if ((qty1 > 0 && n1 < minNotional) || (qty2 > 0 && n2 < minNotional)) {
          const totalNotional = totalQty * (Number(tp1Price) * Number(orNum(bbPmult, 1.0)));
          if (totalNotional >= minNotional) {
            logger.warning(pf('[PTP-NOTIONAL-GUARD-BYBIT] %s %s: split notional tp1=$%.2f tp2=$%.2f below MIN=$%.2f — consolidating to single TP1 qty=%.4g (total $%.2f)',
              strategyName, symbol, n1, n2, minNotional, totalQty, totalNotional));
            qty1 = totalQty;
            qty2 = 0.0;
          } else {
            logger.warning(pf('[PTP-NOTIONAL-GUARD-BYBIT] %s %s: total notional $%.2f < MIN=$%.2f — SKIPPING partial TP entirely (BE-monitor will handle main TP)',
              strategyName, symbol, totalNotional, minNotional));
            return false;
          }
        }
      } catch (ng) {
        logger.debug(`notional-guard bybit fallback: ${errText(ng)}`);
      }
      try {
        const posSize = await by.inst._getCurrentPositionSize(session, bbSym, apiKey, posIdx);
        if (posSize <= 0) {
          logger.info(pf('Partial TP skipped [%s %s]: position already closed (size=0) — likely SL triggered or manual close before TP placement', strategyName, symbol));
          return false;
        }
      } catch (pc) {
        if (isCancelledError(pc)) throw pc;
        logger.debug(`partial_tp pre-check exception (fail-open): ${errText(pc)}`);
      }
      for (const [label, qty, price] of [['TP1', qty1, tp1Price], ['TP2', qty2, tp2Price]]) {
        if (qty <= 0) continue;
        try {
          let qtyStr = PP.roundQty(qty, qtyStep);
          if (pyFloat(qtyStr) < qtyStep) {
            logger.warning(pf('[PTP-SKIP-MIN] Partial %s skipped [%s %s]: qty %.6g < stepSize %.6g', label, strategyName, symbol, qty, qtyStep));
            continue;
          }
          try {
            const live = await by.inst._getCurrentPositionSize(session, bbSym, apiKey, posIdx);
            if (live <= 0) {
              logger.info(pf('[PRE-FLIGHT-SKIP] %s %s %s: position closed (size=0) before TP submit — skipping (was race → 110017 before L5.6)', strategyName, symbol, label));
              continue;
            }
            if (pyFloat(qtyStr) > live) {
              const clamped = PP.roundQty(live, qtyStep);
              if (pyFloat(clamped) < qtyStep) {
                logger.info(pf('[PRE-FLIGHT-SKIP] %s %s %s: remaining pos %.6g < qty_step %.6g — skipping', strategyName, symbol, label, live, qtyStep));
                continue;
              }
              logger.info(pf('[PRE-FLIGHT-CLAMP] %s %s %s: qty %s → %s (remaining pos %.6g)', strategyName, symbol, label, qtyStr, clamped, live));
              qtyStr = clamped;
            }
          } catch (vex) {
            if (isCancelledError(vex)) throw vex;
            logger.debug(`partial_tp L5.6 pre-flight verify ${symbol} ${label}: ${errText(vex)}`);
          }
          const priceStr = PP.roundPrice(price * bbPmult, tickSize);
          session = by.inst._getSession(apiKey, apiSecret, bybitDemo);
          let tpOk = false;
          let lastMsg = '';
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const sess = session;
              const r = await waitFor(() => by.inst.bybitCall((k) => sess.place_order(k), {
                category: 'linear', symbol: bbSym, side: closeSide, orderType: 'Limit', qty: qtyStr, price: priceStr,
                reduceOnly: true, timeInForce: 'GTC', positionIdx: posIdx,
              }, { apiKey, fnName: 'place_order' }), 8.0, { shield: true, timers }).catch((e) => {
                if (e && e.pyType === 'TimeoutError') logger.error(pf('bybit_call %s hard timeout=%.1fs', 'place_order', 8.0));
                throw e;
              });
              if (pyGet(r, 'retCode', -1) === 0) { anyPlaced = true; tpOk = true; break; }
              lastMsg = `retCode=${pf('%s', pyGet(r, 'retCode'))} ${pf('%s', pyGet(r, 'retMsg', ''))}`;
              if (pyGet(r, 'retCode') === 110017 && attempt < 2) {
                await asleep(1.0);
                continue;
              }
              break;
            } catch (inner) {
              if (isCancelledError(inner)) throw inner;
              lastMsg = pySlice(errText(inner), 200);
              const isTruncate = lastMsg.includes('truncated to zero');
              if (lastMsg.includes('110017') && !isTruncate) {
                logger.info(pf('[PARTIAL-TP-RACE] %s %s %s attempt %d/3: position closed before TP placement (110017)', strategyName, symbol, label, attempt + 1));
                if (attempt < 2) {
                  await asleep(1.0);
                  continue;
                }
                break;
              }
              if (isTruncate) {
                logger.warning(pf("[PARTIAL-TP-NOTIONAL] %s %s %s: qty=%s price=%s notional=$%.2f → 110017 'truncated to zero' (Bybit MIN_NOTIONAL not satisfied). NOT a race — retry won't help. Skipping remaining attempts.",
                  strategyName, symbol, label, qtyStr, priceStr, pyFloat(qtyStr) * pyFloat(priceStr)));
                break;
              }
              logger.error('partial_tp.place_partial_tp_orders() unhandled exception');
              break;
            }
          }
          if (!tpOk) {
            failedAttempts += 1;
            const truncSummary = lastMsg.includes('truncated to zero');
            const realRace = (lastMsg.includes('110017') || lastMsg.includes('current position is zero')) && !truncSummary;
            if (realRace) {
              race110017 += 1;
              logger.info(pf('Partial %s race [%s %s pos_idx=%s]: position closed before TP placement (110017)', label, strategyName, symbol, posIdx));
            } else if (truncSummary) {
              logger.warning(pf('Partial %s NOTIONAL FAIL [%s %s pos_idx=%s]: Bybit MIN_NOTIONAL not satisfied (qty×price too small). Position remains open without partial TP — BE-monitor will set main TP via fallback path.', label, strategyName, symbol, posIdx));
            } else {
              logger.warning(pf('Partial %s failed [%s %s pos_idx=%s]: %s', label, strategyName, symbol, posIdx, lastMsg));
            }
          }
        } catch (e) {
          if (isCancelledError(e)) throw e;
          logger.warning(pf('Partial %s failed [%s %s]: %s', label, strategyName, symbol, errText(e)));
        }
      }
    }

    if (anyPlaced) {
      logger.info(pf('Partial TP placed [%s %s]: tp1=%.6g(%.0f%%) tp2=%.6g(%.0f%%)', strategyName, symbol, tp1Price, tp1Pct, tp2Price, tp2Pct));
    } else if (qty1 > 0 || qty2 > 0) {
      if (failedAttempts > 0 && race110017 === failedAttempts) {
        logger.info(pf('Partial TP [%s %s %s]: ALL attempts hit 110017 race (%d/%d) — position transitioned during placement, no manual review needed; entry=%.6g sl=%.6g qty=%.6g pos_idx=%s',
          strategyName, symbol, direction, race110017, failedAttempts, entry, sl, totalQty, posIdx));
        return anyPlaced;
      }
      let stillOpen = true;
      const demoFinal = Boolean(kwargs.bybit_demo);   // QUIRK: never set
      try {
        const tr = traderFor(exchange);
        let positions;
        if (exchange === 'bingx' || exchange === 'binance') {
          positions = await call(exchange, 'getPositions', 10, () => tr.getPositions(apiKey, apiSecret, symbol));
        } else if (exchange === 'okx') {
          positions = await call(exchange, 'getPositions', 10, () => tr.getPositions(apiKey, apiSecret, symbol, getattr(user, 'okx_passphrase', '') || ''));
        } else {
          positions = await call('bybit', 'getPositions', 10, () => traderFor('bybit').getPositions(apiKey, apiSecret, symbol, demoFinal));
        }
        let sizeNow = 0.0;
        for (const p of (positions || [])) {
          try { sizeNow += pyFloat(pyOr(pyGet(p, 'size', 0), pyGet(p, 'pos', 0), 0)); } catch (_e) { /* pass */ }
        }
        stillOpen = sizeNow > 0;
      } catch (pe) {
        if (isCancelledError(pe)) throw pe;
        logger.debug(`partial_tp verify position check: ${errText(pe)}`);
      }
      if (!stillOpen) {
        logger.info(pf('Partial TP [%s %s %s]: position CLOSED before TP placement (flash close on exchange, no manual review needed) — entry=%.6g sl=%.6g qty=%.6g pos_idx=%s',
          strategyName, symbol, direction, entry, sl, totalQty, posIdx));
        return anyPlaced;
      }
      logger.error(pf('Partial TP ALL FAILED [%s %s %s]: exchange=%s entry=%.6g sl=%.6g qty=%.6g pos_idx=%s — position open without partial TP, manual review required',
        strategyName, symbol, direction, exchange, entry, sl, totalQty, posIdx));
      if (bot !== null && bot !== undefined) {
        try {
          if (adminAlert) {
            await adminAlert(bot, 'Partial TP failure — manual review',
              `<b>uid</b>=${pf('%s', getattr(user, 'user_id', '?'))} `
              + `<b>sym</b>=${symbol} <b>ex</b>=${exchange}\n`
              + `<b>strategy</b>=${strategyName} <b>dir</b>=${direction}\n`
              + `<b>entry</b>=${pf('%.6g', entry)} <b>sl</b>=${pf('%.6g', sl)} `
              + `<b>qty</b>=${pf('%.6g', totalQty)}\n`
              + 'Все partial-TP ордера отклонены биржей. Позиция открыта, '
              + 'partial-TP не выставлен. Разбор — вручную.',
              `ptp_fail_${pf('%s', getattr(user, 'user_id', 0))}_${exchange}_${symbol}`, 'partial_tp_failure');
          }
        } catch (ae) {
          logger.debug(`admin_alert partial-tp-failure send failed: ${errText(ae)}`);
        }
      }
    }
    return anyPlaced;
  }

  return { placePartialTpOrders, calculatePartialTpQty, fetchActualAvgEntry, notifyLadderDowngrade };
}

/** Python truthiness of a users-row value. */
function truthyPy(v) {
  if (v === null || v === undefined || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

module.exports = { buTargetPrice, shouldApplyBuAfterPartial, calculatePartialTpPrices, createPartialTp };
