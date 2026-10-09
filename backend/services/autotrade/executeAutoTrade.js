'use strict';
/**
 * executeAutoTrade.js — one-to-one port of auto_trade.execute_auto_trade (the bot's ordered gate
 * list, sizing pipeline, placement, timeout reconcile, partial-TP hand-off and notifications).
 * Spec: autotrade.md §2–§4. Every gate keeps the bot's order, skip reason, `[MARKER]` log line,
 * user message (ru/en via messages.js) and DB write.
 *
 *   createExecutor(deps).executeAutoTrade(kwargs) → result
 *     kwargs = the bot's keyword arguments (snake_case): user_id, symbol, direction, entry, sl, tp1,
 *       tp2, tp3, trade_id, api_key, api_secret, risk_pct, leverage, auto_trade_mode, max_trades,
 *       bot, strategy, exchange, entry_low, entry_high, bybit_demo, order_type, quality, trend_ctx
 *     result = {executed, show_trade_btn, limit_msg[, skip_reason, ctx_mult, regime_warning,
 *       cross_direction_msg, ai_filter_result]}; QUIRK (pinned): hour_of_day_levels / min_quality /
 *       trending_only REPLACE it with {ok:false, executed:false, skip}.
 *
 * Site decisions (docs/PORT_DECISIONS.md D6, `deps.d6`): (a) result.executed is false when the
 * exchange rejected the order (bot: true); (d) fixed_amount is a percent of the balance (bot:
 * divided by the balance as USD). `d6: {executedOnReject: true, fixedAmountPercent: false}`
 * reproduces the bot byte for byte (the differential tests run that way).
 *
 * Not ported, by decision: the ML signal_filter gate (D11 — no XGBoost models on the site: the
 * gate's `has_model` is always false); the WS staleness branch (dead in the bot: ws_feed has no
 * `_global_feed`, so the HTTP last-price path always runs).
 */

const { waitFor, isTimeoutError, isCancelledError, makeLock, currentTaskName } = require('./asyncio');
const { isThreadCall } = require('./traders');
const { pf, F } = require('./pyfmt');
const { t: i18n } = require('./messages');
const { isUserFacingError, isAuthFailure, ZERO_BAL_COOLDOWN_SEC } = require('./cooldowns');
const { resolveLimitUnfilledGrace } = require('./reconcile');
const { buildAiButtonKb, AGREE, NEUTRAL, AGAINST } = require('./aiFilter');
const { calculateRiskPreview, formatRiskPreviewLine } = require('./riskPreview');
const { adaptiveRisk, buildChallengeState } = require('./propPilot');
const { PLAN_FEATURES, normalizePlan } = require('../../config/planFeatures');
const { htmlEscape, pyFloat, pyGet, pyOr, pyStr, pySlice } = require('../exchanges/pyCompat');
const { pyRound } = require('../../strategies/common/pyround');
const { fmtFixed } = require('../../strategies/common/pyfmt');
const { pyLower, pyUpper, pyStrip, pyIsdigit } = require('../../strategies/common/pyUnicode');
const { pyInt: pyIntStrict } = require('../engine/pycoerce');
const { seriesMean } = require('../../strategies/common/series');

const PLACE_TRADE_TIMEOUT_BYBIT = 45;
const PLACE_TRADE_TIMEOUT_BINGX = 60;
const PLACE_TRADE_TIMEOUT_BINANCE = 45;
const ENTRY_IMPROVE_PCT = 0.0005;
const STRATEGY_FEATURE = Object.freeze({ SMC: 'smc', VOLUME: 'volume' });
const STRATEGY_MAX_SL_DEFAULTS = Object.freeze({ SMC: 5.0, LEVELS: 7.0 });
const DAYS_RU = Object.freeze({ 0: 'Пн', 1: 'Вт', 2: 'Ср', 3: 'Чт', 4: 'Пт', 5: 'Сб', 6: 'Вс' });

const own = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
/** dict.get(k, d) on the users row */
const rget = (row, k, d) => (own(row, k) ? row[k] : d);
/** Python truthiness of a row / result value */
function truthy(v) {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object' && v.constructor === Object) return Object.keys(v).length > 0;
  return true;
}
/** `a or b` */
const or = (a, b) => (truthy(a) ? a : b);
const errText = (e) => (e && e.message !== undefined ? String(e.message) : String(e));
const symShort = (s) => String(s || '').split('-USDT-SWAP').join('').split('-USDT').join('');
/** str() of a trader-returned scalar: Python floats print as repr (1.0), strings as is. */
const traderStr = (v) => (typeof v === 'number' ? pf('%s', F(v)) : pyStr(v === undefined ? null : v));
const exTypeName = (e) => (e && (e.pyType || e.name)) || 'Exception';

/** datetime.utcfromtimestamp(t): weekday (Mon=0), hour, toordinal() */
function utcParts(t) {
  const d = new Date(Math.floor(t * 1000));
  return {
    weekday: (d.getUTCDay() + 6) % 7,
    hour: d.getUTCHours(),
    ordinal: Math.floor(Math.floor(t * 1000) / 86400000) + 719163,
  };
}

function createExecutor(deps) {
  const {
    db, traderFor, killswitch, cooldowns, idempotency, reconcile, partialTp, tasks,
    correlationCap, adaptiveSizing, tiltDetector, skipNotify, adminAlerts, aiFilter, balanceCache,
  } = deps;
  const log = deps.log || require('../marketData/mdLog').log;
  const now = deps.now || (() => Date.now() / 1000);
  const sleep = deps.sleep || ((s) => new Promise((r) => setTimeout(r, s * 1000)));
  const timers = deps.timers;
  const env = deps.env || process.env;
  const config = deps.config || require('./config').readConfig(env);
  const isAdmin = deps.isAdmin || (async () => false);
  const getUserRow = deps.getUserRow || ((uid) => db.getUser(uid));
  const sendMessage = deps.sendMessage;
  const enqueueCritical = deps.enqueueCritical || null;
  const exchangeSymbols = deps.exchangeSymbols || require('../exchanges/exchangeSymbols');
  const regime = deps.regime;
  const cache = deps.cache;
  const trend = deps.trend;
  const challengeGate = deps.challengeGate;
  const mlFilter = deps.mlFilter || { hasModel: () => false };
  const emitMutation = deps.emitMutation || (async () => {});
  const userLog = deps.userLog || { tradeBlocked: () => {}, tradeOpen: () => {} };
  const funnelTrackOnce = deps.funnelTrackOnce || (async () => {});
  const recordLeverageCap = deps.recordLeverageCap || (() => {});
  const sentryCapture = deps.sentryCapture || (() => {});
  const d6 = { executedOnReject: false, fixedAmountPercent: true, ...(deps.d6 || {}) };

  const tradeLocks = new Map();
  const disabledDaysNotified = new Map();   // `${uid}|${ordinal}` → true
  const lowNotionalNotifyTs = new Map();     // uid → ts
  let cbWarned = false;

  const send = (bot, uid, text, opts = {}) => sendMessage(bot, uid, text, { parseMode: 'HTML', siteType: 'trade', ...opts });
  /** asyncio.wait_for around one trader call — the Bybit pybit calls are thread-pool work (shield). */
  const call = (exchange, fn, timeoutS, thunk) => waitFor(thunk, timeoutS, { shield: isThreadCall(exchange, fn), timers });
  const spawn = (name, fn, onError) => tasks.create(name, fn, { onError });
  /**
   * db.trade_events.emit_bg: the bot appends the row from a task (evt_<type>_<tid16>) that
   * runs before any later event task (FIFO). The site's insert is a synchronous, never-throwing
   * better-sqlite3 write, so it is done in place: same rows, same order.
   */
  const emitEvt = (tid, evt, data, floatKeys = null) => {
    try {
      if (!tid || !evt) return;
      db.addTradeEvent(String(tid), evt, data, floatKeys ? { floatKeys } : {});
    } catch (e) {
      log.debug(pf('[EVT-EMIT-SKIP] %s: %s', evt, errText(e)));
    }
  };
  /** trade_result["qty"]: a Python float for BingX / Binance (a str for Bybit / OKX). */
  const qtyFloatKeys = (r) => (r !== null && typeof r === 'object' && typeof r.qty === 'number' ? ['qty'] : null);
  /**
   * _price_multiplier(exchange, symbol). QUIRK (pinned): bybit / okx / unknown read the trader
   * module's `bybit_price_multiplier` — okx_trader has none, so every OKX lookup logs the
   * "not found" warning and returns 1.0 (the OKX value anyway).
   */
  const priceMultiplier = (exchange, symbol) => {
    try {
      const h = traderFor(exchange);
      if (h.exchange === 'okx') {
        log.warning(pf('price_multiplier: %s.*_price_multiplier not found, pmult=1.0', exchange));
        return 1.0;
      }
      return pyFloat(h.priceMultiplier(symbol));
    } catch (e) {
      log.error(pf('_price_multiplier(%s, %s) failed, falling back to 1.0', exchange, symbol));
      return 1.0;
    }
  };

  async function safeSkipTrade(tradeId, reason = 'unknown') {
    if (!tradeId) return;
    try {
      await db.setTradeResult(tradeId, 'SKIP', 0.0, { skipReason: pySlice(String(reason || 'unknown'), 64) });
    } catch (e) {
      log.warning(pf("[SKIP-FAIL] db_set_trade_result SKIP failed tid=%s reason=%s: %s — zombie risk: trade stays in result='' until reconcile cleanup", tradeId, reason, errText(e)));
    }
  }

  // eslint-disable-next-line complexity
  async function executeAutoTrade(kw) {
    const userId = kw.user_id;
    const symbol = kw.symbol;
    const direction = kw.direction;
    let entry = kw.entry;
    const sl = kw.sl;
    const tp1 = kw.tp1;
    const tp2 = kw.tp2 === undefined ? 0.0 : kw.tp2;
    const tp3 = kw.tp3 === undefined ? 0.0 : kw.tp3;
    const tradeId = kw.trade_id;
    const apiKey = kw.api_key;
    const apiSecret = kw.api_secret;
    let riskPct = kw.risk_pct === undefined ? 1.0 : kw.risk_pct;
    const leverage = kw.leverage === undefined ? 10 : kw.leverage;
    const autoTradeMode = kw.auto_trade_mode === undefined ? 'auto' : kw.auto_trade_mode;
    const maxTrades = kw.max_trades === undefined ? 5 : kw.max_trades;
    const bot = kw.bot === undefined ? null : kw.bot;
    const strategy = kw.strategy === undefined ? '' : kw.strategy;
    const exchange = kw.exchange === undefined ? 'bybit' : kw.exchange;
    const entryLow = kw.entry_low === undefined ? null : kw.entry_low;
    const entryHigh = kw.entry_high === undefined ? null : kw.entry_high;
    const bybitDemo = kw.bybit_demo === undefined ? false : kw.bybit_demo;
    let orderType = kw.order_type === undefined ? 'Limit' : kw.order_type;
    const quality = kw.quality === undefined ? 0 : kw.quality;
    const trendCtx = kw.trend_ctx === undefined ? '' : kw.trend_ctx;

    let result = { executed: false, show_trade_btn: false, limit_msg: null };

    // [FORENSICS] event #2: signal_reached_auto_trade
    emitEvt(tradeId, 'signal_reached_auto_trade', {
      user_id: userId, symbol, direction, strategy, exchange,
      entry, sl, tp1, tp2, tp3, risk_pct: riskPct, leverage, mode: autoTradeMode,
    }, ['entry', 'sl', 'tp1', 'tp2', 'tp3', 'risk_pct']);

    // [CLOSURE-C] Killswitch gate
    try {
      await killswitch.requireActive('auto_trade.execute_auto_trade');
    } catch (ks) {
      if (!(ks && ks.killswitchHalted)) throw ks;
      log.info(pf('[KILLSWITCH] blocked execute_auto_trade uid=%s sym=%s reason=%s', userId, symbol, errText(ks)));
      result.limit_msg = `killswitch_halted: ${ks.state}`;
      emitEvt(tradeId, 'filter_block', { gate: 'killswitch', reason: errText(ks) });
      return result;
    }

    // [PLAN-GATE] fail-closed with admin bypass + DB retry
    const admin = await isAdmin(userId);
    if (!admin) {
      let uRow = null;
      let lastErr = null;
      let failed = true;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          uRow = await db.getUser(userId);
          failed = false;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await sleep(0.1);
        }
      }
      if (failed) {
        log.error(pf('[PLAN-GATE] DB error uid=%s after 3 retries — fail-CLOSED: %s', userId, errText(lastErr)));
        result.limit_msg = 'plan_gate: db_error_fail_closed';
        emitEvt(tradeId, 'plan_gate_block', { reason: 'db_error_fail_closed' });
        return result;
      }
      const plan = normalizePlan(rget(uRow || {}, 'sub_plan', null));
      const feat = PLAN_FEATURES[plan] || PLAN_FEATURES.free;
      if (!feat.auto_trade) {
        log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=plan_auto_trade reason=plan=%s disallows auto_trade', userId, symbol, strategy, plan));
        result.limit_msg = `plan_gate: ${plan}`;
        emitEvt(tradeId, 'plan_gate_block', { gate: 'plan_auto_trade', plan });
        return result;
      }
      const sf = STRATEGY_FEATURE[pyUpper(String(strategy || ''))];
      if (sf && !feat[sf]) {
        log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=plan_strategy reason=plan=%s disallows %s', userId, symbol, strategy, plan, sf));
        result.limit_msg = `plan_gate_strategy: ${plan}/${sf}`;
        emitEvt(tradeId, 'plan_gate_block', { gate: 'plan_strategy', plan, strategy, feature: sf });
        return result;
      }
    }

    let split = entryLow !== null && entryHigh !== null;

    let lang = 'ru';
    try {
      lang = await db.getUserLang(userId);
    } catch (e) {
      log.debug(`silent exc auto_trade.py:481: ${errText(e)}`);
    }
    const t = (key, l, kwargs) => i18n(key, l, kwargs);

    // ── [Stage 3A-1] symbol availability (strict) ──
    let excOk;
    try {
      excOk = exchangeSymbols.isSymbolAvailable(exchange, symbol, { strict: true });
    } catch (e) {
      log.debug(`symbol_availability check failed (fail-open): ${errText(e)}`);
      excOk = true;
    }
    if (!excOk) {
      try { exchangeSymbols.recordSkip(exchange, symbol); } catch (e) { log.debug(`silent exc auto_trade.py:record_skip: ${errText(e)}`); }
      log.info(pf('[SYMBOL-UNAVAILABLE] SKIP symbol_unavailable %s on %s (uid=%s strategy=%s) — not active on exchange', symbol, exchange, userId, strategy));
      await safeSkipTrade(tradeId, 'auto_trade.py:sym-skip');
      return result;
    }

    // ── user settings ──
    let row = {};
    try {
      row = (await getUserRow(userId)) || {};
    } catch (e) {
      log.debug(pf('execute_auto_trade db_get_user uid=%s: %s', userId, errText(e)));
    }

    // [SPRINT-1] LIMIT → MARKET opt-in
    try {
      if (pyLower(String(orderType || '')) === 'limit' && truthy(rget(row, 'prefer_market_entry', false))) {
        log.info(pf('[MARKET-FALLBACK] uid=%s sym=%s strategy=%s — user opted-in: LIMIT → MARKET', userId, symbol, strategy));
        orderType = 'Market';
      }
    } catch (e) {
      log.debug(pf('market fallback check uid=%s: %s', userId, errText(e)));
    }

    // AUDIT-FIX-C54.1 hard auto_trade guard
    const atDb = pyIntStrict(or(rget(row, 'auto_trade', 1), 0));
    if (atDb === 0) {
      log.info(pf('[AT-HARD-SKIP] uid=%s sym=%s %s: auto_trade=0 в БД — skip (scanner кеш был устаревшим)', userId, symbol, strategy));
      await safeSkipTrade(tradeId, 'auto_trade.py:517');
      return result;
    }

    // [W1.3 CORRELATION-CAP]
    if (truthy(rget(row, 'correlation_cap_enabled', false))) {
      try {
        const ccThr = pyFloat(or(rget(row, 'correlation_cap_threshold', 0.7), 0.7));
        const cc = await correlationCap.checkCorrelationCap({ userId, newSymbol: symbol, newDirection: direction, threshold: ccThr });
        if (cc.blocked) {
          log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=correlation_cap reason=corr_with_open_position value=%.3f threshold=%.2f with=%s',
            userId, symbol, strategy, cc.max_corr, ccThr, cc.with_symbol));
          await safeSkipTrade(tradeId, 'correlation_cap');
          if (bot) {
            try {
              const withLabel = symShort(cc.with_symbol || '');
              await send(bot, userId,
                `🔗 <b>Сигнал ${symShort(symbol)} ${direction} пропущен</b>\n\n`
                + 'Причина: высокая корреляция с открытым '
                + `<b>${withLabel}</b> (${fmtFixed(cc.max_corr, 2)} ≥ `
                + `${fmtFixed(ccThr, 2)}).\n\n`
                + 'Защита от двойного риска на одном движении.\n'
                + 'Настройка: /settings → 🛡 Risk Management');
            } catch (ne) {
              log.debug(pf('corr-cap notify uid=%s: %s', userId, errText(ne)));
            }
          }
          return result;
        }
      } catch (e) {
        if (isCancelledError(e)) throw e;
        log.debug(pf('correlation_cap check uid=%s: %s', userId, errText(e)));
      }
    }

    // AUDIT-FIX-C59 zero-balance cooldown
    const zbRemaining = cooldowns.checkZeroBalanceCooldown(userId, exchange);
    if (zbRemaining > 0) {
      log.info(pf('[ZB-COOLDOWN] uid=%s sym=%s exch=%s: skip (cooldown %.0fс)', userId, symbol, exchange, zbRemaining));
      await safeSkipTrade(tradeId, 'auto_trade.py:534');
      return result;
    }

    // [FIX-TRADE-PLACEMENT] commodity blocklist
    const cbRemaining = cooldowns.checkCommodityBlocklist(userId, symbol);
    if (cbRemaining > 0) {
      log.info(pf('[COMMODITY-BLOCK] uid=%s sym=%s: skip (cooldown %.0fс — требуется user-agreement на бирже)', userId, symbol, cbRemaining));
      await safeSkipTrade(tradeId, 'commodity_block');
      return result;
    }

    // Stage 3A kill-switch flag
    const filtersOff = truthy(rget(row, 'filters_all_off', 0));
    if (filtersOff) {
      log.debug(pf('auto_trade uid=%s: filters_all_off=1 → skipping strategic filters (regime / counter-trend / SL-streak / ML / disabled_days / btc-corr)', userId));
    }

    // Hard cap: max_risk_pct
    const requestedRiskPct = pyFloat(or(riskPct, 0.0));
    const maxRiskFromUser = pyFloat(or(rget(row, 'max_risk_pct', null), 0.0));
    let riskWasCapped = false;
    if (maxRiskFromUser > 0 && requestedRiskPct > maxRiskFromUser) {
      log.info(pf('[RISK-CAP] uid=%d sym=%s: trade_risk=%.2f%% capped to max_risk=%.2f%%', userId, symbol, requestedRiskPct, maxRiskFromUser));
      riskPct = maxRiskFromUser;
      riskWasCapped = true;
    }
    let appliedRiskPct = pyFloat(riskPct);

    // [W2 ADAPTIVE-SIZING]
    if (truthy(rget(row, 'adaptive_sizing_enabled', false))) {
      try {
        const mode = String(or(rget(row, 'adaptive_sizing_mode', 'all'), 'all'));
        const factors = await adaptiveSizing.calculateAdaptiveFactors({
          userId, symbol, mode, strategy: pyUpper(String(strategy || '')) || null,
        });
        const mul = pyFloat(factors.final);
        const newRisk = pyRound(riskPct * mul, 4);
        log.info(pf('[ADAPTIVE-SIZE] uid=%s sym=%s strat=%s mode=%s base=%.3f%% kelly=%.3f vol=%.3f dd=%.3f strat_mul=%.3f → final=%.3f → %.3f%%',
          userId, symbol, strategy, mode, riskPct, factors.kelly, factors.vol, factors.dd,
          factors.strategy === undefined ? 1.0 : factors.strategy, mul, newRisk));
        riskPct = newRisk;
        if (maxRiskFromUser > 0 && riskPct > maxRiskFromUser) {
          log.info(pf('[RISK-CAP-POST-ADAPTIVE] uid=%d sym=%s: %.2f%% capped to %.2f%%', userId, symbol, riskPct, maxRiskFromUser));
          riskPct = maxRiskFromUser;
          riskWasCapped = true;
        }
        appliedRiskPct = pyFloat(riskPct);
      } catch (e) {
        if (isCancelledError(e)) throw e;
        log.debug(pf('adaptive_sizing uid=%s: %s', userId, errText(e)));
      }
    }

    // ── [CTX-SIZING] ──
    let ctxMult = 1.0;
    try {
      ctxMult = pyFloat(trend.ctxRiskMult(trendCtx));
      if (ctxMult <= 0.0 && !filtersOff) {
        log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%s threshold=%s',
          userId, symbol, strategy, 'trend_ctx', `risk mult 0 for ${trendCtx}`, trendCtx, 'TREND_CTX_RISK'));
        if (bot) {
          try {
            await send(bot, userId,
              `⛔ <b>${htmlEscape(symShort(symbol))} ${direction}</b> — ${trend.ctxLabel(trendCtx)}\n`
              + '<i>Автотрейд пропустил сделку: против сильного тренда BTC. '
              + 'Сигнал остаётся, вход — только вручную.</i>');
          } catch (e) {
            log.debug(pf('ctx skip notify uid=%s: %s', userId, errText(e)));
          }
        }
        await safeSkipTrade(tradeId, 'trend_ctx_skip');
        result.skip_reason = 'trend_ctx_skip';
        return result;
      }
      if (ctxMult <= 0.0) ctxMult = 1.0;
      if (ctxMult !== 1.0) {
        const before = pyFloat(riskPct);
        riskPct = pyRound(pyFloat(riskPct) * ctxMult, 4);
        appliedRiskPct = pyFloat(riskPct);
        log.info(pf('[CTX-SIZING] uid=%s sym=%s ctx=%s risk %.3f%% × %.2f → %.3f%%', userId, symbol, trendCtx, before, ctxMult, riskPct));
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('ctx sizing uid=%s: %s', userId, errText(e)));
    }
    result.ctx_mult = ctxMult;

    // ── Filter 1: fixed_amount ──
    try {
      const fixed = pyFloat(or(rget(row, 'fixed_amount', null), 0));
      if (fixed > 0) {
        try {
          const tr = traderFor(exchange);
          const balance = await call(exchange, 'getBalance', 20.0, () => (exchange === 'bybit'
            ? tr.getBalance(apiKey, apiSecret, bybitDemo)
            : tr.getBalance(apiKey, apiSecret)));
          if (!truthy(balance) || balance <= 0) {
            log.warning(pf('[AUDIT-FIX] auto_trade uid=%s: balance=%.4f for fixed_amount=%.2f — skipping trade (zero/negative balance)', userId, pyFloat(or(balance, 0)), fixed));
            if (bot) {
              try {
                await send(bot, userId,
                  '💰 <b>Авто-трейд: баланс нулевой</b>\n'
                  + `${htmlEscape(symShort(symbol))} ${direction}\n`
                  + `<i>На бирже баланс $${fmtFixed(pyFloat(or(balance, 0)), 2)}, а fixed_amount = `
                  + `$${fmtFixed(fixed, 2)}. Пополни счёт или переключись на %-risk.</i>`);
              } catch (e) {
                log.debug(`silent exc auto_trade.py:601: ${errText(e)}`);
              }
            }
            await safeSkipTrade(tradeId, 'auto_trade.py:606');
            return result;
          }
          // D6(d): fixed_amount is a percent of the balance (the bot divides it by the balance as USD)
          riskPct = d6.fixedAmountPercent ? fixed : (fixed / balance) * 100;
          log.debug(pf('auto_trade uid=%s fixed_amount=%.2f balance=%.2f → risk_pct=%.4f%%', userId, fixed, balance, riskPct));
        } catch (eb) {
          if (isCancelledError(eb)) throw eb;
          log.warning(pf('auto_trade uid=%s get_balance for fixed_amount: %s', userId, errText(eb)));
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('auto_trade fixed_amount filter uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 2: disabled_days (KS) ──
    try {
      if (!filtersOff) {
        const raw = String(or(rget(row, 'autotrade_disabled_days', null), ''));
        if (pyStrip(raw)) {
          const parts = utcParts(now());
          const todayWd = parts.weekday;
          const disabled = new Set();
          for (const dd of raw.split(',')) if (pyIsdigit(pyStrip(dd))) disabled.add(pyIntStrict(pyStrip(dd)));
          if (disabled.has(todayWd)) {
            log.debug(pf('auto_trade uid=%s skip: weekday %d in disabled_days %s', userId, todayWd, raw));
            log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%s threshold=%s',
              userId, symbol, strategy, 'disabled_days', `weekday=${todayWd} in disabled=${raw}`, todayWd, raw));
            const dayKey = `${userId}|${utcParts(now()).ordinal}`;
            if (bot && !disabledDaysNotified.get(dayKey)) {
              disabledDaysNotified.set(dayKey, true);
              const todayOrd = utcParts(now()).ordinal;
              for (const k of Array.from(disabledDaysNotified.keys())) {
                if (Number(k.split('|')[1]) < todayOrd - 1) disabledDaysNotified.delete(k);
              }
              try {
                const name = Object.prototype.hasOwnProperty.call(DAYS_RU, todayWd) ? DAYS_RU[todayWd] : String(todayWd);
                await send(bot, userId,
                  `📅 <b>Сегодня торговля выключена</b> (${name})\n`
                  + '<i>В настройках «Дни без торговли» этот день отмечен. '
                  + 'Сигналы будут приходить, но авто-трейд не сработает.</i>');
              } catch (e) {
                log.debug(`silent exc auto_trade.py:653: ${errText(e)}`);
              }
            }
            await safeSkipTrade(tradeId, 'auto_trade.py:658');
            return result;
          }
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('auto_trade disabled_days filter uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 2.5: hour-of-day (SMC config, LEVELS env) (KS) ──
    try {
      if (!filtersOff) {
        const userHfOn = truthy(rget(row, 'hour_filter_enabled', true));
        let blocked = false;
        if (config.SMC_HOUR_FILTER_ENABLED && config.SMC_HOUR_FILTER_MODE !== 'off' && strategy === 'SMC' && userHfOn) {
          const badHours = (config.BAD_HOURS_UTC || {}).SMC || [];
          if (badHours.length) {
            const hourUtc = utcParts(now()).hour;
            if (badHours.includes(hourUtc)) {
              const hfMode = config.SMC_HOUR_FILTER_MODE;
              if (hfMode === 'shadow') {
                let regimeTag = 'unknown';
                try { regimeTag = String(or(await regime.getCachedRegime(), 'unknown')); } catch (e) { log.debug(`hour_filter regime tag unavailable: ${errText(e)}`); }
                log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%s threshold=%s market_regime=%s mode=shadow',
                  userId, symbol, strategy, 'hour_of_day', `hour_utc=${hourUtc} in bad_hours=${pf('%s', badHours)}`, hourUtc, badHours, regimeTag));
                try {
                  await emitMutation('hour_filter_shadow', {
                    actor: 'filter', target: symbol, before: 'pass', after: 'shadow_block',
                    context: { user_id: userId, strategy, hour_utc: hourUtc, bad_hours: badHours, regime: regimeTag, mode: 'shadow' },
                  });
                } catch (em) {
                  log.debug(`hour_filter_shadow emit_mutation: ${errText(em)}`);
                }
              } else {
                log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%s threshold=%s',
                  userId, symbol, strategy, 'hour_of_day', `hour_utc=${hourUtc} in bad_hours=${pf('%s', badHours)}`, hourUtc, badHours));
                try {
                  await emitMutation('hour_filter_block', {
                    actor: 'filter', target: symbol, before: 'pass', after: 'blocked',
                    context: { user_id: userId, strategy, hour_utc: hourUtc, bad_hours: badHours, mode: 'enforce' },
                  });
                } catch (em) {
                  log.debug(`hour_filter_block emit_mutation: ${errText(em)}`);
                }
                await skipNotify.notifySkipToUser(bot, userId, symbol, 'hour_of_day', lang);
                if (tradeId) await safeSkipTrade(tradeId, 'hour_of_day SKIP');
                blocked = true;
              }
            }
          }
        }
        if (blocked) return result;
        if ((env.LEVELS_HOUR_FILTER_ENABLED === undefined ? '0' : env.LEVELS_HOUR_FILTER_ENABLED) === '1' && strategy === 'LEVELS') {
          const lvlMode = pyLower(env.LEVELS_HOUR_FILTER_MODE === undefined ? 'shadow' : env.LEVELS_HOUR_FILTER_MODE);
          if (lvlMode === 'shadow' || lvlMode === 'enforce') {
            const badStr = env.LEVELS_BAD_HOURS_UTC === undefined ? '10,11,12,13,14,15,16,17,18,19,20' : env.LEVELS_BAD_HOURS_UTC;
            let lvlBad;
            try {
              lvlBad = badStr.split(',').filter((x) => pyStrip(x)).map((x) => pyIntStrict(pyStrip(x)));
            } catch (_e) {
              lvlBad = [];
            }
            const h = utcParts(now()).hour;
            if (lvlBad.length && lvlBad.includes(h)) {
              if (lvlMode === 'shadow') {
                log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=hour_of_day_levels reason=%r value=%s threshold=%s mode=shadow',
                  userId, symbol, strategy, `hour_utc=${h} in levels_bad_hours=${pf('%s', lvlBad)}`, h, lvlBad));
              } else {
                log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=hour_of_day_levels reason=%r value=%s threshold=%s mode=enforce',
                  userId, symbol, strategy, `hour_utc=${h} blocked`, h, lvlBad));
                result = { ok: false, executed: false, skip: 'hour_of_day_levels' };
                if (tradeId) await safeSkipTrade(tradeId, 'hour_of_day_levels SKIP');
                return result;
              }
            }
          }
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('auto_trade hour_of_day filter uid=%s: %s', userId, errText(e)));
    }

    // [PROFIT-MAX] min_signal_quality (KS)
    try {
      if (!filtersOff) {
        const minQ = pyIntStrict(or(rget(row, 'min_signal_quality', 3), 3));
        const sigQ = pyIntStrict(or(quality, 0));
        if (minQ > 3 && sigQ > 0 && sigQ < minQ) {
          log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=min_quality reason=below_threshold value=%d threshold=%d', userId, symbol, strategy, sigQ, minQ));
          result = { ok: false, executed: false, skip: 'min_quality_below_threshold' };
          if (tradeId) await safeSkipTrade(tradeId, 'min_quality_below_threshold SKIP');
          return result;
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('auto_trade min_quality filter uid=%s: %s', userId, errText(e)));
    }

    // [PROFIT-MAX] trending-only (KS)
    try {
      if (!filtersOff && truthy(rget(row, 'trade_trending_only', false))) {
        const regTo = or(await regime.getCachedRegime(), '');
        if (regTo && !String(regTo).startsWith('trending')) {
          log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=trending_only reason=regime_not_trending value=%s threshold=trending_up|trending_down', userId, symbol, strategy, regTo));
          result = { ok: false, executed: false, skip: 'trending_only_ranging_skip' };
          if (tradeId) await safeSkipTrade(tradeId, 'trending_only_ranging_skip SKIP');
          return result;
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('auto_trade trending_only filter uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 3: market regime / counter-trend (KS) ──
    try {
      if (!filtersOff) {
        let reg = await regime.getCachedRegime();
        if (reg === null || reg === undefined) {
          reg = null;
          let btcDf = null;
          try {
            btcDf = await cache.getCandles('BTC-USDT-SWAP', '1H');
          } catch (e) {
            log.debug(`silent exc auto_trade.py:675: ${errText(e)}`);
          }
          if (btcDf !== null && btcDf !== undefined && btcDf.length >= 60) reg = regime.detectRegime(btcDf);
        }
        if (reg !== null && !regime.regimeAllowsDirection(reg, direction)) {
          const allowCounter = truthy(rget(row, 'allow_counter_trend', 0));
          if (!allowCounter) {
            log.info(pf('auto_trade uid=%s regime=%s COUNTER-TREND %s %s → BLOCKED', userId, reg, symbol, direction));
            log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%s threshold=%s',
              userId, symbol, strategy, 'counter_trend', `regime=${reg} direction=${direction}`, direction, reg));
            if (bot) {
              try {
                const kb = [[{ id: 'enable_ct_inline', label: '✅ Разрешить контр-тренд (на свой риск)', action: 'enable_ct_inline', kind: 'callback' }]];
                await send(bot, userId,
                  '🚫 <b>Контр-тренд заблокирован</b>\n'
                  + `${htmlEscape(symShort(symbol))} ${direction}\n`
                  + `Режим рынка: <b>${reg}</b>\n`
                  + '<i>Сигнал пропущен — тренд против позиции</i>',
                  { replyMarkup: kb });
              } catch (e) {
                log.debug(`silent exc auto_trade.py:700: ${errText(e)}`);
              }
            }
            if (tradeId) await safeSkipTrade(tradeId, 'auto_trade.py:705');
            return result;
          }
          try {
            result.regime_warning = regime.regimeWarningText(reg, direction, lang);
          } catch (_e) {
            log.error('auto_trade._t() unhandled exception');
            result.regime_warning = `⚠️ ${t('counter_trend_label', lang)}: ${reg} / ${direction}`;
          }
          log.info(pf('auto_trade uid=%s regime=%s COUNTER-TREND %s %s (allowed by user)', userId, reg, symbol, direction));
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('auto_trade regime filter uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 3.3: BTC correlation block (KS) ──
    try {
      if (!filtersOff) {
        const isAlt = !pyUpper(symbol).includes('BTC') && !pyUpper(symbol).includes('ETH');
        if (isAlt && truthy(rget(row, 'btc_correlation_block', null))) {
          const btcRegime = await regime.getCachedRegime();
          if (btcRegime === 'trending_down' && direction === 'LONG') {
            log.info(pf('auto_trade uid=%s BTC DUMP BLOCK: %s LONG while BTC trending_down', userId, symbol));
            log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%s threshold=%s',
              userId, symbol, strategy, 'btc_correlation_block', 'alt LONG while BTC trending_down', 'LONG', 'trending_down'));
            await safeSkipTrade(tradeId, 'auto_trade.py:733');
            if (bot) {
              try {
                await send(bot, userId, `📉 <b>BTC в даунтренде</b> — ${htmlEscape(symShort(symbol))} LONG заблокирован\n<i>Альты падают вместе с BTC. Ждём разворот.</i>`);
              } catch (e) {
                log.debug(`silent exc auto_trade.py:744: ${errText(e)}`);
              }
            }
            return result;
          }
          if (btcRegime === 'trending_up' && direction === 'SHORT') {
            log.info(pf('auto_trade uid=%s BTC PUMP BLOCK: %s SHORT while BTC trending_up', userId, symbol));
            log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%s threshold=%s',
              userId, symbol, strategy, 'btc_correlation_block', 'alt SHORT while BTC trending_up', 'SHORT', 'trending_up'));
            await safeSkipTrade(tradeId, 'auto_trade.py:752');
            if (bot) {
              try {
                await send(bot, userId, `📈 <b>BTC в аптренде</b> — ${htmlEscape(symShort(symbol))} SHORT заблокирован\n<i>Альты растут с BTC. Ждём коррекцию.</i>`);
              } catch (e) {
                log.debug(`silent exc auto_trade.py:763: ${errText(e)}`);
              }
            }
            return result;
          }
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.debug(pf('auto_trade btc_correlation uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 3.5: funding rate gate — Bybit only (KS) ──
    try {
      if (!filtersOff && exchange === 'bybit') {
        const fr = await call('bybit', 'getFundingRate', 5.0, () => traderFor('bybit').getFundingRate(symbol));
        if (Math.abs(fr) >= 0.001) {
          const against = (fr > 0 && direction === 'LONG') || (fr < 0 && direction === 'SHORT');
          if (against) {
            log.info(pf('auto_trade uid=%s FUNDING GATE: %s funding=%.4f%% %s → SKIP', userId, symbol, fr * 100, direction));
            log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%.4f%% threshold=%s',
              userId, symbol, strategy, 'funding_rate_gate', `funding against ${direction}`, fr * 100, 'extreme'));
            if (bot) {
              try {
                await send(bot, userId, `💸 <b>Funding Rate ${pf('%+.3f', fr * 100)}%</b> — ${htmlEscape(symShort(symbol))} ${direction}\n<i>Сделка пропущена: фандинг против вас</i>`);
              } catch (e) {
                log.debug(`silent exc auto_trade.py:793: ${errText(e)}`);
              }
            }
            await safeSkipTrade(tradeId, 'auto_trade.py:798');
            return result;
          }
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      if (!isTimeoutError(e)) log.debug(pf('auto_trade funding gate uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 3.6: spread check — per-user toggle, Bybit only (KS) ──
    try {
      if (!filtersOff) {
        const spreadEnabled = truthy(rget(row, 'spread_check_enabled', 1));
        const maxSpread = pyFloat(or(rget(row, 'spread_max_pct', 0.3), 0.3));
        if (spreadEnabled && exchange === 'bybit') {
          const spread = await call('bybit', 'getSpreadPct', 5.0, () => traderFor('bybit').getSpreadPct(symbol));
          if (spread > maxSpread) {
            log.info(pf('auto_trade uid=%s SPREAD BLOCK: %s spread=%.3f%% > %.1f%% (user threshold)', userId, symbol, spread, maxSpread));
            log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%.3f%% threshold=%.1f%%',
              userId, symbol, strategy, 'spread_check', 'spread too wide', spread, maxSpread));
            if (bot) {
              try {
                await send(bot, userId,
                  `📊 <b>Широкий спред ${fmtFixed(spread, 2)}%</b> — `
                  + `${htmlEscape(symShort(symbol))} ${direction}\n`
                  + `<i>Сделка пропущена: спред > ${fmtFixed(maxSpread, 1)}% `
                  + '(цена входа может сильно отличаться от ожидаемой).</i>');
              } catch (e) {
                log.debug(`silent exc auto_trade.py:826: ${errText(e)}`);
              }
            }
            await safeSkipTrade(tradeId, 'auto_trade.py:831');
            return result;
          }
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      if (!isTimeoutError(e)) log.debug(pf('auto_trade spread check uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 4: ML signal_filter (KS) — D11: no models on the site, has_model is always false ──
    try {
      if (!filtersOff && truthy(rget(row, 'optimizer_enabled', null)) && mlFilter.hasModel(userId, strategy)) {
        log.debug(pf('auto_trade uid=%s ml filter: model present but not ported (D11)', userId));
      }
    } catch (e) {
      log.debug(pf('auto_trade ml filter uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 4.5: SL-streak guard (risk management — NOT behind the kill-switch; fail-OPEN) ──
    try {
      const slStreakEnabled = truthy(rget(row, 'sl_streak_enabled', true));
      if (slStreakEnabled) {
        const thr = pyIntStrict(or(rget(row, 'sl_streak_threshold', 3), 3));
        const recentSl = await db.getRecentSlCount(userId, 24);
        if (recentSl >= thr) {
          log.warning(pf('[C83] SL-STREAK GUARD uid=%s: %d SL за 24ч (порог=%d) — trade blocked', userId, recentSl, thr));
          log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%d threshold=%d',
            userId, symbol, strategy, 'sl_streak_guard', `${recentSl} SL in 24h`, recentSl, thr));
          try { userLog.tradeBlocked(userId, rget(row, 'username', null), symbol, direction, `SL-streak ${recentSl}/24h`); } catch (e) { log.debug(`user_log sl-streak: ${errText(e)}`); }
          try { await adminAlerts.alertSlStreak(bot, userId, rget(row, 'username', null), recentSl); } catch (e) { log.debug(`admin_alert sl-streak: ${errText(e)}`); }
          if (bot) {
            try {
              await send(bot, userId, t('sl_streak_notif', lang, { count: recentSl, symbol: symShort(symbol), direction }));
            } catch (e) {
              log.debug(pf('sl_streak notify uid=%s: %s', userId, errText(e)));
            }
          }
          await safeSkipTrade(tradeId, 'auto_trade.py:922');
          return result;
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.warning(pf('[GATE-ERROR] uid=%s sym=%s: sl_streak check failed (%s) — gate skipped', userId, symbol, errText(e)));
    }

    // ── Filter 5: circuit breaker — daily loss (risk management, fail-CLOSED) ──
    try {
      const cbUserEnabled = truthy(rget(row, 'circuit_breaker_enabled', false));
      const cbUserLimit = pyFloat(or(rget(row, 'circuit_breaker_threshold_r', 0.0), 0.0));
      const cbLimit = (cbUserEnabled && cbUserLimit > 0) ? cbUserLimit : config.DAILY_MAX_LOSS_R;
      if (cbLimit <= 0 && !cbWarned) {
        log.warning('⚠️  Circuit Breaker ОТКЛЮЧЁН (DAILY_MAX_LOSS_R=0). '
          + 'Суточный лимит убытка не ограничен. '
          + 'Задайте DAILY_MAX_LOSS_R=<число R> в переменных окружения '
          + 'для защиты от серии убытков.');
        cbWarned = true;
      }
      if (cbLimit > 0) {
        const todayLoss = await db.getTodayLossRr(userId);
        if (todayLoss <= -Math.abs(cbLimit)) {
          log.warning(pf('auto_trade CIRCUIT BREAKER uid=%s: today_loss=%.2fR >= limit=%.2fR — trade blocked', userId, todayLoss, cbLimit));
          log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%.2fR threshold=%.2fR',
            userId, symbol, strategy, 'circuit_breaker_daily_loss', 'today loss exceeds DAILY_MAX_LOSS_R', todayLoss, cbLimit));
          if (bot) {
            try {
              await send(bot, userId, t('circuit_breaker_notif', lang, { loss: F(todayLoss), limit: F(cbLimit), symbol: symShort(symbol), direction }));
            } catch (e) {
              log.debug(pf('circuit_breaker notify uid=%s: %s', userId, errText(e)));
            }
          }
          await safeSkipTrade(tradeId, 'auto_trade.py:963');
          return result;
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      let cbActive;
      try {
        cbActive = truthy(rget(row, 'circuit_breaker_enabled', null)) || pyFloat(or(config.DAILY_MAX_LOSS_R, 0)) > 0;
      } catch (_e) {
        cbActive = true;
      }
      if (cbActive) {
        log.warning(pf('[GATE-FAIL-CLOSED] uid=%s sym=%s: circuit_breaker check failed (%s) — trade blocked', userId, symbol, errText(e)));
        await safeSkipTrade(tradeId, 'circuit_breaker_gate_error');
        result.skip_reason = 'circuit_breaker_gate_error';
        return result;
      }
      log.debug(pf('auto_trade circuit_breaker filter uid=%s: %s', userId, errText(e)));
    }

    // ── Filter 6: Prop Autopilot (fail-CLOSED) ──
    let propBalance = 0;
    try {
      if (truthy(rget(row, 'prop_mode', null))) {
        propBalance = 0.0;
        let propErr = null;
        try {
          const tr = traderFor(exchange);
          propBalance = await call(exchange, 'getBalance', 10.0, () => {
            if (exchange === 'bybit') return tr.getBalance(apiKey, apiSecret, bybitDemo);
            if (exchange === 'okx') return tr.getBalance(apiKey, apiSecret, or(rget(row, 'okx_passphrase', ''), ''));
            return tr.getBalance(apiKey, apiSecret);
          });
        } catch (eb) {
          if (isCancelledError(eb)) throw eb;
          if (isTimeoutError(eb)) {
            propErr = 'timeout';
            log.warning(pf('[PROP-FAILSAFE] uid=%s sym=%s: get_balance timeout >10s — blocking trade for safety (cannot verify DD limits)', userId, symbol));
          } else {
            propErr = pySlice(errText(eb), 60);
            log.warning(pf('[PROP-FAILSAFE] uid=%s sym=%s: get_balance error %s — blocking trade for safety', userId, symbol, propErr));
          }
        }
        if (propErr !== null) {
          if (bot) {
            try {
              await send(bot, userId,
                '🏆 <b>Prop Autopilot</b>\n\n'
                + `🚫 Сделка <b>${symbol}</b> заблокирована:\n`
                + `<i>Не удалось получить баланс (${propErr}). `
                + 'Защита prop-аккаунта от превышения DD.</i>\n\n'
                + 'Попробуй ещё раз через минуту — если баланс доступен, '
                + 'сделка пройдёт.');
            } catch (_e) {
              log.debug(pf('PROP-FAILSAFE notify uid=%s failed', userId));
            }
          }
          await safeSkipTrade(tradeId, 'prop_balance_fetch_fail');
          return result;
        }
        if (propBalance === null || propBalance === undefined || (typeof propBalance !== 'number' && typeof propBalance !== 'boolean')) {
          // `_prop_balance <= 0` on a non-number raises TypeError → the fail-closed handler below
          const tn = propBalance === null || propBalance === undefined ? 'NoneType' : (typeof propBalance === 'string' ? 'str' : (Array.isArray(propBalance) ? 'list' : 'dict'));
          throw Object.assign(new TypeError(`'<=' not supported between instances of '${tn}' and 'int'`), { pyType: 'TypeError' });
        }
        if (propBalance <= 0) {
          log.warning(pf('[PROP-FAILSAFE] uid=%s sym=%s: get_balance вернул %.2f (без ошибки) — blocking trade (cannot verify DD limits)', userId, symbol, propBalance));
          if (bot) {
            try {
              await send(bot, userId,
                '🏆 <b>Prop Autopilot</b>\n\n'
                + `🚫 Сделка <b>${symbol}</b> заблокирована:\n`
                + '<i>Баланс prop-аккаунта прочитан как 0. '
                + 'Защита от превышения DD.</i>\n\n'
                + 'Проверь подключение биржи и баланс аккаунта.');
            } catch (_e) {
              log.debug(pf('PROP-FAILSAFE-ZERO notify uid=%s failed', userId));
            }
          }
          await safeSkipTrade(tradeId, 'prop_balance_zero');
          return result;
        }
        if (propBalance > 0) {
          try {
            await db.updatePropPeak(userId, propBalance);
            const storedPeak = pyFloat(or(rget(row, 'prop_peak_balance', 0), 0));
            if (propBalance > storedPeak) row.prop_peak_balance = propBalance;
          } catch (pe) {
            log.debug(pf('db_update_prop_peak uid=%s: %s', userId, errText(pe)));
          }
          const cs = buildChallengeState(row, propBalance);
          const propBase = pyFloat(or(rget(row, 'prop_base_risk', 1.0), 1.0));
          const [propRisk, propReason] = adaptiveRisk(cs, propBase);
          if (propRisk <= 0) {
            log.info(pf('PROP AUTOPILOT BLOCK uid=%s: %s', userId, propReason));
            if (bot) {
              try {
                await send(bot, userId, `🏆 <b>Prop Autopilot</b>\n\n🚫 Сделка <b>${symbol}</b> заблокирована:\n${propReason}`);
              } catch (e) {
                log.debug(`silent exc auto_trade.py:1007: ${errText(e)}`);
              }
            }
            await safeSkipTrade(tradeId, 'auto_trade.py:1012');
            return result;
          }
          riskPct = propRisk;
          log.debug(pf('PROP adaptive risk uid=%s: base=%.2f → %.2f | %s', userId, propBase, propRisk, propReason));
        }
      }
    } catch (e) {
      if (isCancelledError(e)) throw e;
      if (truthy(rget(row, 'prop_mode', null))) {
        log.warning(pf('[GATE-FAIL-CLOSED] uid=%s sym=%s: prop_pilot gate failed (%s) — trade blocked', userId, symbol, errText(e)));
        await safeSkipTrade(tradeId, 'prop_gate_error');
        result.skip_reason = 'prop_gate_error';
        return result;
      }
      log.debug(pf('auto_trade prop_pilot filter uid=%s: %s', userId, errText(e)));
    }

    // ── [CHALLENGE-GATE] discipline of the personal plan (fail-closed) ──
    let chReason;
    try {
      chReason = await challengeGate(userId);
    } catch (e) {
      if (isCancelledError(e)) throw e;
      log.warning(pf('[GATE-FAIL-CLOSED] uid=%s sym=%s: challenge gate failed (%s) — trade blocked', userId, symbol, errText(e)));
      await safeSkipTrade(tradeId, 'challenge_gate_error');
      result.skip_reason = 'challenge_gate_error';
      return result;
    }
    if (truthy(chReason)) {
      log.info(pf('[CHALLENGE-GATE] uid=%s sym=%s blocked: %s', userId, symbol, chReason));
      await safeSkipTrade(tradeId, `challenge_${chReason}`);
      result.skip_reason = `challenge_${chReason}`;
      return result;
    }

    // ── Guard: zero risk (entry ≈ sl) ──
    if (entry > 0 && Math.abs(entry - sl) / entry < 0.0001) {
      log.warning(pf('auto_trade uid=%s SKIP zero-risk: entry=%.6f sl=%.6f sym=%s', userId, entry, sl, symbol));
      if (bot) {
        try {
          await send(bot, userId,
            '⚠️ <b>Авто-трейд: нулевой риск</b>\n'
            + `${htmlEscape(symShort(symbol))} ${direction}\n`
            + `<i>Entry и SL слишком близко (entry=${pf('%.6g', entry)}, sl=${pf('%.6g', sl)}). `
            + 'Невозможно рассчитать размер позиции.</i>');
        } catch (e) {
          log.debug(`silent exc auto_trade.py:1040: ${errText(e)}`);
        }
      }
      await safeSkipTrade(tradeId, 'auto_trade.py:1045');
      return result;
    }

    if (!tradeLocks.has(userId)) tradeLocks.set(userId, makeLock());
    const lock = tradeLocks.get(userId);
    return lock.run(async () => {
      // 1. duplicate symbol
      if (await db.hasOpenTradeForSymbol(userId, symbol)) {
        log.debug(`${strategy} auto_trade skip duplicate: ${symbol} uid=${userId}`);
        await safeSkipTrade(tradeId, 'auto_trade.py:1060');
        return result;
      }
      // 2. open-trade limit
      const openCount = await db.countOpenTrades(userId, tradeId);
      log.info(pf('auto_trade LIMIT CHECK uid=%s: open=%d max=%d sym=%s → %s', userId, openCount, maxTrades, symbol, openCount < maxTrades ? 'PASS' : 'BLOCK'));
      if (maxTrades > 0 && openCount >= maxTrades) {
        log.info(`${strategy} auto_trade BLOCKED by limit (${openCount}/${maxTrades}): ${symbol} uid=${userId}`);
        result.limit_msg = t('auto_trade_limit', lang, { open: openCount, max: maxTrades, symbol, direction });
        await safeSkipTrade(tradeId, 'auto_trade.py:1081');
        return result;
      }
      // 2.5 cross-direction
      try {
        const allOpen = await db.getAllOpenTrades(userId);
        const opposite = pyUpper(direction) === 'LONG' ? 'SHORT' : 'LONG';
        for (const tr of allOpen) {
          const trSym = String(rget(tr, 'symbol', ''));
          const trDir = pyUpper(String(rget(tr, 'direction', '')));
          const trId = String(rget(tr, 'trade_id', ''));
          if (trSym === symbol && trDir === opposite && trId !== String(tradeId)) {
            log.warning(pf('CROSS-DIRECTION BLOCK uid=%s %s: already open %s (trade_id=%s) → skip %s', userId, symbol, opposite, trId, direction));
            result.cross_direction_msg = t('auto_trade_cross_direction', lang, { symbol, direction, opposite });
            await safeSkipTrade(tradeId, 'auto_trade.py:1109');
            return result;
          }
        }
      } catch (e) {
        if (isCancelledError(e)) throw e;
        log.debug(pf('cross_direction check uid=%s %s: %s', userId, symbol, errText(e)));
      }
      // 2.6 max SL distance (KS guard)
      if (!filtersOff) {
        const userMaxSl = pyFloat(or(rget(row, 'smc_max_sl_pct', 0.0), 0));
        let maxSl = userMaxSl > 0 ? userMaxSl : (Object.prototype.hasOwnProperty.call(STRATEGY_MAX_SL_DEFAULTS, strategy) ? STRATEGY_MAX_SL_DEFAULTS[strategy] : 5.0);
        let lev;
        try {
          lev = Math.max(pyIntStrict(or(leverage, 1)), 1);
        } catch (_e) {
          lev = 1;
        }
        const levCap = 80.0 / lev;
        if (levCap < maxSl) {
          log.info(pf('[LEVERAGE-CAP] uid=%s %s strategy=%s lev=%dx: tightening max_sl %.2f%% → %.2f%%', userId, symbol, strategy, lev, maxSl, levCap));
          maxSl = levCap;
          try { recordLeverageCap(); } catch (e) { log.debug(`sl_protection_counters record_leverage_cap: ${errText(e)}`); }
        }
        if (maxSl > 0 && entry > 0 && sl > 0) {
          let gateRef = entry;
          if (entryLow !== null && entryHigh !== null && entryLow > 0 && entryHigh > 0) gateRef = (entryLow + entryHigh) / 2;
          const slDistPct = Math.abs(gateRef - sl) / gateRef * 100;
          if (slDistPct > maxSl) {
            log.warning(pf('[F-008-MAX-SL] uid=%s %s %s strategy=%s: SL distance %.2f%% > max %.1f%% (leverage protection) → SKIP', userId, symbol, direction, strategy, slDistPct, maxSl));
            log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%.2f%% threshold=%.1f%%',
              userId, symbol, strategy, 'max_sl_pct', `${strategy} SL distance too wide`, slDistPct, maxSl));
            try { userLog.tradeBlocked(userId, rget(row, 'username', null), symbol, direction, `${strategy}-max-SL ${fmtFixed(slDistPct, 1)}% > ${fmtFixed(maxSl, 1)}%`); } catch (e) { log.debug(`user_log max-sl: ${errText(e)}`); }
            if (bot) {
              try {
                await send(bot, userId, t('smc_sl_too_wide', lang, { symbol: symShort(symbol), sl_pct: fmtFixed(slDistPct, 2), max_pct: fmtFixed(maxSl, 1) }));
              } catch (e) {
                log.debug(pf('max_sl msg uid=%s: %s', userId, errText(e)));
              }
            }
            await safeSkipTrade(tradeId, 'max_sl_too_wide');
            return result;
          }
        }
      }

      // 3. open
      log.info(pf('auto_trade MODE uid=%s sym=%s: mode=%s → %s', userId, symbol, autoTradeMode, autoTradeMode === 'auto' ? 'OPENING' : 'CONFIRM BUTTON'));
      if (autoTradeMode !== 'auto') {
        // confirm mode: the card gets the manual "open" button (services/autotrade/confirmMode.js executes it)
        result.show_trade_btn = true;
        if (typeof deps.onConfirmPending === 'function') {
          try { await deps.onConfirmPending({ userId, tradeId, symbol, direction, strategy, exchange }); } catch (e) { log.debug(`confirm hand-off uid=${userId}: ${errText(e)}`); }
        }
        return result;
      }
      return placeAuto();
    });

    // ════════════════════════════════════════════════════════════════════
    // placement (auto mode) — runs inside the per-user lock
    // ════════════════════════════════════════════════════════════════════
    // eslint-disable-next-line complexity
    async function placeAuto() {
      let tradeResult = null;
      let fmtFn = null;
      let fmtArgs = null;
      let ptpEnabled = false;
      try {
        // entry improvement
        if (entry > 0) entry = direction === 'LONG' ? entry * (1 - ENTRY_IMPROVE_PCT) : entry * (1 + ENTRY_IMPROVE_PCT);

        // staleness check (the WS branch is dead in the bot — no ws_feed._global_feed)
        let staleRef = entry;
        if (entryLow !== null && entryHigh !== null && entryLow > 0 && entryHigh > 0) staleRef = (entryLow + entryHigh) / 2;
        const wsActive = Boolean(deps.wsFeed && deps.wsFeed.active && deps.wsFeed.active());
        let wsPrice = 0.0;
        if (wsActive) {
          try { wsPrice = deps.wsFeed.getLastPrice(symbol) || 0.0; } catch (e) { log.debug(`silent exc auto_trade.py:1181: ${errText(e)}`); }
        }
        let staleThr = 2.0;
        try {
          const sdf = await cache.getCandles(symbol, '1H');
          if (sdf !== null && sdf !== undefined && sdf.length >= 20) {
            const n = sdf.length;
            const hl = [];
            for (let i = Math.max(0, n - 14); i < n; i++) hl.push(sdf.h[i] - sdf.l[i]);
            const avgAtr = seriesMean(hl);
            const lastPrice = sdf.c[n - 1];
            if (lastPrice > 0) {
              const atrPct = avgAtr / lastPrice * 100;
              staleThr = Math.max(1.5, atrPct * 2.5);
            }
          }
        } catch (e) {
          log.debug(`silent exc auto_trade.py:1197: ${errText(e)}`);
        }
        staleThr = Math.min(staleThr, 6.0);
        log.debug(pf('[AUDIT-FIX] staleness threshold=%.1f%% strategy=%s ws=%s ws_price=%.6f ref_price=%.6f', staleThr, strategy, wsActive, wsPrice, staleRef));
        if (wsActive && wsPrice > 0 && staleRef > 0) {
          const drift = Math.abs(wsPrice - staleRef) / staleRef * 100;
          if (drift > staleThr) {
            log.info(pf('auto_trade SKIP stale (WS): %s entry=%.5f ws=%.5f drift=%.2f%% uid=%s', symbol, entry, wsPrice, drift, userId));
            if (bot) {
              try {
                await send(bot, userId, t('signal_skipped_stale', lang, { symbol: symShort(symbol), drift_pct: fmtFixed(drift, 1), threshold: fmtFixed(staleThr, 1) }));
              } catch (e) {
                log.debug(`silent exc auto_trade.py:1221: ${errText(e)}`);
              }
            }
            await safeSkipTrade(tradeId, 'auto_trade.py:1226');
            return result;
          }
        }
        if (!wsActive) {
          try {
            const st = traderFor(exchange);
            let currentPrice = await call(exchange, 'getLastPrice', 5.0, () => st.getLastPrice(apiKey, apiSecret, symbol));
            const pm = priceMultiplier(exchange, symbol);
            if (truthy(currentPrice) && truthy(pm) && pm !== 1.0) currentPrice = currentPrice / pm;
            if (truthy(currentPrice) && currentPrice > 0 && staleRef > 0) {
              const drift = Math.abs(currentPrice - staleRef) / staleRef * 100;
              if (drift > staleThr) {
                await db.setTradeResult(tradeId, 'SKIP', 0.0);
                log.info(pf('auto_trade SKIP stale signal: %s entry=%.5f current=%.5f drift=%.2f%% > %.1f%% uid=%s', symbol, entry, currentPrice, drift, staleThr, userId));
                try {
                  let langAt = 'ru';
                  try {
                    const u = await db.getUser(userId);
                    langAt = or(rget(u || {}, 'lang', 'ru'), 'ru');
                  } catch (e) {
                    log.debug(`silent exc auto_trade.py:1270: ${errText(e)}`);
                  }
                  await send(bot, userId, t('signal_skipped_stale', langAt, { symbol: symShort(symbol), drift_pct: fmtFixed(drift, 1), threshold: pf('%s', F(staleThr)) }));
                } catch (e) {
                  log.debug(`silent exc auto_trade.py:1281: ${errText(e)}`);
                }
                return result;
              }
            }
          } catch (e) {
            if (isCancelledError(e)) throw e;
            if (isTimeoutError(e)) log.warning(pf('staleness check timeout %s uid=%s — proceeding anyway', symbol, userId));
            else log.debug(pf('auto_trade staleness check %s: %s — proceeding', symbol, errText(e)));
          }
        }

        // partial TP on → no main TP on the entry order
        ptpEnabled = truthy(rget(row, 'partial_tp_enabled', false));
        const tp1Order = ptpEnabled ? 0.0 : tp1;
        const tp2Order = ptpEnabled ? 0.0 : tp2;
        const tp3Order = ptpEnabled ? 0.0 : tp3;
        if (ptpEnabled) log.debug(pf('auto_trade uid=%s: partial_tp ON → skip main TP', userId));

        // FIX-B4: split entry is Bybit-only
        if (split && (exchange === 'bingx' || exchange === 'binance' || exchange === 'okx')) {
          log.warning(pf('auto_trade: split-entry не поддерживается %s (uid=%s sym=%s) — используем midpoint', pyUpper(exchange), userId, symbol));
          split = false;
          entry = (entryLow + entryHigh) / 2;
        }
        if (split) {
          emitEvt(tradeId, 'order_placement_attempt', { attempt: 1, exchange: 'bybit_split', entry_lo: entryLow, entry_hi: entryHigh }, ['entry_lo', 'entry_hi']);
          const idemKeySplit = idempotency.makeIdempotencyKey(userId, symbol, now());
          idempotency.setIdempotency(idemKeySplit, 'pending');
          const by = traderFor('bybit');
          tradeResult = await call('bybit', 'placeTradeSplit', exchange === 'bingx' ? PLACE_TRADE_TIMEOUT_BINGX : PLACE_TRADE_TIMEOUT_BYBIT,
            () => by.placeTradeSplit(apiKey, apiSecret, symbol, direction, entryLow, entryHigh, sl, tp1Order, riskPct, leverage, {
              tp2: tp2Order, tp3: tp3Order, demo: bybitDemo, userId,
            }));
          idempotency.setIdempotency(idemKeySplit, truthy(pyGet(tradeResult || {}, 'ok', null)) ? 'done' : 'failed', pyStr(or(pyGet(tradeResult || {}, 'order_id', ''), '')));
          emitEvt(tradeId, 'order_api_response', {
            exchange: 'bybit_split',
            ok: truthy(pyGet(tradeResult, 'ok', null)),
            order_id: pySlice(pyStr(or(pyGet(tradeResult, 'order_id', ''), '')), 128),
            error: pySlice(pyStr(or(pyGet(tradeResult, 'error', ''), '')), 300),
            insufficient_margin: truthy(pyGet(tradeResult, 'insufficient_margin', null)),
          });
          fmtFn = by.formatTradeResultSplit;
          fmtArgs = [tradeResult, direction, symbol, entryLow, entryHigh, sl, tp1, riskPct, leverage];
        } else {
          const trader = traderFor(exchange);
          let timeoutS;
          if (exchange === 'bingx') timeoutS = PLACE_TRADE_TIMEOUT_BINGX;
          else if (exchange === 'binance') timeoutS = PLACE_TRADE_TIMEOUT_BINANCE;
          else if (exchange === 'okx') {
            timeoutS = PLACE_TRADE_TIMEOUT_BINANCE;
            if (!truthy(rget(row, 'okx_passphrase', null))) {
              log.warning(pf('auto_trade uid=%s OKX: passphrase missing — trade blocked', userId));
              if (bot) {
                try {
                  await send(bot, userId, '⚠️ <b>OKX passphrase не настроен</b>\nНастрой OKX API с passphrase в меню бота.');
                } catch (e) {
                  log.debug(`silent exc auto_trade.py:1345: ${errText(e)}`);
                }
              }
              await safeSkipTrade(tradeId, 'auto_trade.py:1350');
              return result;
            }
          } else {
            timeoutS = PLACE_TRADE_TIMEOUT_BYBIT;
          }
          const riskMode = String(or(rget(row, 'risk_mode', 'risk'), 'risk'));

          // AUDIT-FIX-C3: last pre-flight price check (2 s)
          let preflightReturn = false;
          try {
            const pre = traderFor(exchange);
            let prePrice = await call(exchange, 'getLastPrice', 2.0, () => pre.getLastPrice(apiKey, apiSecret, symbol));
            const pm = priceMultiplier(exchange, symbol);
            if (truthy(prePrice) && truthy(pm) && pm !== 1.0) prePrice = prePrice / pm;
            if (truthy(prePrice) && prePrice > 0) {
              const breached = (direction === 'LONG' && prePrice <= sl) || (direction === 'SHORT' && prePrice >= sl);
              const slDist = Math.abs(entry - sl);
              let prox = 0.0;
              if (slDist > 0) {
                const remaining = direction === 'LONG' ? prePrice - sl : sl - prePrice;
                prox = remaining / slDist * 100;
              }
              const near = prox > 0 && prox < 10.0 && !breached;
              if (near) {
                log.warning(pf('[C79-PROX] auto_trade SKIP: %s %s SL близко (price=%.6g, sl=%.6g, remaining=%.1f%% от SL dist) uid=%s', symbol, direction, prePrice, sl, prox, userId));
                if (tradeId) await db.setTradeResult(tradeId, 'SKIP', 0.0);
                preflightReturn = true;
              } else if (breached) {
                log.warning(pf('auto_trade C3 SKIP: %s %s SL уже пробит (price=%.6g, sl=%.6g) — отмена сделки uid=%s', symbol, direction, prePrice, sl, userId));
                if (bot) {
                  try {
                    await send(bot, userId,
                      `🚫 <b>${htmlEscape(symShort(symbol))} ${direction}: SL уже пробит</b>\n`
                      + `Цена ${pf('%.6g', prePrice)} прошла стоп ${pf('%.6g', sl)} `
                      + 'пока сигнал доходил.\n'
                      + '<i>Сделка отменена для защиты от мгновенного убытка.</i>');
                  } catch (e) {
                    log.debug(`silent exc auto_trade.py:1431: ${errText(e)}`);
                  }
                }
                if (tradeId) await db.setTradeResult(tradeId, 'SKIP', 0.0);
                preflightReturn = true;
              }
            }
          } catch (e) {
            if (isCancelledError(e)) throw e;
            log.debug(pf('C3 pre-flight check %s: %s', symbol, errText(e)));
          }
          if (preflightReturn) return result;

          // [AI-FILTER] information only since [AI-NO-BLOCK Phase 2]
          await runAiFilter();

          // idempotency + PENDING → PLACING
          const idemKey = idempotency.makeIdempotencyKey(userId, symbol, now());
          idempotency.setIdempotency(idemKey, 'pending');
          try {
            await db.setTradeState(tradeId, 'PLACING', { bumpAttempts: true });
          } catch (e) {
            log.debug(pf('state PLACING uid=%s %s: %s', userId, symbol, errText(e)));
          }
          tradeResult = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            emitEvt(tradeId, 'order_placement_attempt', { attempt: attempt + 1, exchange, order_type: orderType, timeout: timeoutS, idem_key: idemKey.slice(0, 32) });
            try {
              const o = {
                tp2: tp2Order, tp3: tp3Order, riskMode, orderType, tradeId, userId,
                allowLowNotionalBoost: truthy(rget(row, 'allow_low_notional_boost', false)),
              };
              if (exchange === 'bybit') o.demo = bybitDemo;
              else if (exchange === 'okx') o.passphrase = rget(row, 'okx_passphrase', '');
              tradeResult = await call(exchange, 'placeTrade', timeoutS,
                () => trader.placeTrade(apiKey, apiSecret, symbol, direction, entry, sl, tp1Order, riskPct, leverage, o));
              idempotency.setIdempotency(idemKey, truthy(pyGet(tradeResult, 'ok', null)) ? 'done' : 'failed', pyGet(tradeResult, 'order_id', ''));
              emitEvt(tradeId, 'order_api_response', {
                attempt: attempt + 1,
                ok: truthy(pyGet(tradeResult, 'ok', null)),
                order_id: pySlice(pyStr(or(pyGet(tradeResult, 'order_id', ''), '')), 64),
                error: pySlice(pyStr(or(pyGet(tradeResult, 'error', ''), '')), 300),
                low_notional_skip: truthy(pyGet(tradeResult, 'low_notional_skip', null)),
                insufficient_margin: truthy(pyGet(tradeResult, 'insufficient_margin', null)),
                qty: pyGet(tradeResult, 'qty', 0),
              }, qtyFloatKeys(tradeResult));
              break;
            } catch (e) {
              if (!isTimeoutError(e)) throw e;
              if (attempt === 0 && ['bingx', 'binance', 'bybit', 'okx'].includes(exchange)) {
                log.warning(pf('[C78-IDEM] %s timeout %s (idem=%s), double-check before retry...', pyUpper(exchange), symbol, idemKey));
                let alreadyPlaced = false;
                try {
                  const positions = await call(exchange, 'getPositions', 10.0, () => {
                    if (exchange === 'bybit') return trader.getPositions(apiKey, apiSecret, symbol, bybitDemo);
                    if (exchange === 'okx') return trader.getPositions(apiKey, apiSecret, symbol, rget(row, 'okx_passphrase', ''));
                    return trader.getPositions(apiKey, apiSecret, symbol);
                  });
                  if ((positions || []).some((p) => pyFloat(or(pyGet(p, 'size', 0), 0)) !== 0)) {
                    log.warning(pf('[C78-IDEM] Позиция уже ОТКРЫТА по %s — skip retry', symbol));
                    alreadyPlaced = true;
                  }
                } catch (pe) {
                  if (isCancelledError(pe)) throw pe;
                  log.debug(pf('[C78-IDEM] get_positions %s: %s', symbol, errText(pe)));
                }
                if (!alreadyPlaced) {
                  try {
                    const openOrders = await call(exchange, 'getOpenOrders', 10.0, () => {
                      if (exchange === 'bybit') return trader.getOpenOrders(apiKey, apiSecret, bybitDemo);
                      if (exchange === 'okx') return trader.getOpenOrders(apiKey, apiSecret, rget(row, 'okx_passphrase', ''));
                      return trader.getOpenOrders(apiKey, apiSecret);
                    });
                    const symNorm = symShort(symbol);
                    for (const oo of (openOrders || [])) {
                      const ooSym = pyUpper(pyStr(pyGet(oo, 'symbol', '')));
                      if (ooSym.includes(pyUpper(symNorm))) {
                        log.warning(pf('[C78-IDEM] Лимит ордер УЖЕ в стакане %s (oid=%s) — skip retry', symbol, pyGet(oo, 'orderId', '?')));
                        alreadyPlaced = true;
                        break;
                      }
                    }
                  } catch (oe) {
                    if (isCancelledError(oe)) throw oe;
                    log.debug(pf('[C78-IDEM] get_open_orders %s: %s', symbol, errText(oe)));
                  }
                }
                if (alreadyPlaced) {
                  idempotency.setIdempotency(idemKey, 'done');
                  log.warning(pf('[TIMEOUT-FIRST-ATTEMPT] uid=%s %s: order found on exchange after first-attempt timeout — handing over to timeout reconcile', userId, symbol));
                  throw e;
                }
                log.warning(pf('[C78-IDEM] %s: no existing order — retry in 5s', symbol));
                await sleep(5);
                continue;
              }
              idempotency.setIdempotency(idemKey, 'failed');
              throw e;
            }
          }
          fmtFn = trader.formatTradeResult;
          fmtArgs = [tradeResult, direction, symbol, entry, sl, tp1, riskPct, leverage];
        }

        // Bug #5 P1: risk-cap status
        if (tradeResult !== null && typeof tradeResult === 'object' && !Array.isArray(tradeResult)) {
          if (!own(tradeResult, 'risk_capped')) tradeResult.risk_capped = riskWasCapped;
          if (!own(tradeResult, 'risk_requested_pct')) tradeResult.risk_requested_pct = requestedRiskPct;
          if (!own(tradeResult, 'risk_applied_pct')) tradeResult.risk_applied_pct = appliedRiskPct;
        }

        if (truthy(pyGet(tradeResult, 'ok', null))) {
          await onSuccess();
        } else {
          await onFailure();
        }

        // QUIRK (D6(a) decides): the bot sets executed=True even when the exchange rejected the order
        result.executed = d6.executedOnReject ? true : truthy(pyGet(tradeResult, 'ok', null));

        if (truthy(pyGet(tradeResult, 'ok', null))) scheduleBackground();

        if (bot) {
          let tradeMsg = fmtFn(...fmtArgs, tp2, tp3);
          if (truthy(result.regime_warning)) tradeMsg += '\n\n' + result.regime_warning;
          if (truthy(rget(row, 'show_risk_preview', true))) {
            try {
              const qtyForPreview = (tradeResult !== null && typeof tradeResult === 'object') ? pyFloat(or(pyGet(tradeResult, 'qty', 0), 0)) : 0.0;
              const bal = await balanceCache.getCachedBalance({ user_id: userId }, exchange);
              if (qtyForPreview > 0 && truthy(bal) && bal > 0 && entry > 0 && sl > 0) {
                const pm = or(priceMultiplier(exchange, symbol), 1.0);
                const prev = calculateRiskPreview({ entry, sl, qty: qtyForPreview, balanceUsd: pyFloat(bal), pmult: pyFloat(pm) });
                const line = formatRiskPreviewLine(prev, lang);
                if (line) tradeMsg += '\n\n' + line;
              }
            } catch (e) {
              if (isCancelledError(e)) throw e;
              log.debug(pf('risk_preview uid=%s: %s', userId, errText(e)));
            }
          }
          await send(bot, userId, tradeMsg);
        }
        return result;
      } catch (e) {
        if (isTimeoutError(e)) {
          await onTimeout();
          return result;
        }
        if (isCancelledError(e)) throw e;
        await onError(e);
        return result;
      }

      // ── the AI filter (information only) ──
      async function runAiFilter() {
        try {
          const aiUser = {
            user_id: rget(row, 'user_id', null),
            ai_filter_settings: (() => {
              const v = rget(row, 'ai_filter_settings', null);
              if (typeof v === 'string') {
                try { return v ? JSON.parse(v) : {}; } catch (_e) { return {}; }
              }
              return v;
            })(),
            can(featureKey) {
              try {
                const plan = or(rget(row, 'sub_plan', null), 'free');
                const feat = own(PLAN_FEATURES, plan) ? PLAN_FEATURES[plan] : {};
                return Boolean(own(feat, featureKey) ? feat[featureKey] : false);
              } catch (_e) {
                return false;
              }
            },
          };
          const aiSig = { direction, symbol, quality: 0, strategy, timeframe: '' };
          const aiCtx = { hour_utc: utcParts(now()).hour, current_price: pyFloat(or(entry, 0)) };
          const ai = await aiFilter.evaluateSignal(aiSig, aiUser, aiCtx);
          try {
            const snapshot = {
              active_layers: ai.layers.map((r) => r.layer_name),
              results: ai.layers.map((r) => ({
                name: r.layer_name, verdict: r.verdict, confidence: F(r.confidence), reason: r.reason,
                data: r.data !== null && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {},
                available_at_tier: r.available_at_tier === undefined ? 'pro' : r.available_at_tier,
              })),
              agree_count: ai.layers.filter((r) => r.verdict === AGREE).length,
              neutral_count: ai.layers.filter((r) => r.verdict === NEUTRAL).length,
              against_count: ai.layers.filter((r) => r.verdict === AGAINST).length,
              total_layers: ai.layers.length,
              confidence_score: F(ai.confidence_score),
              preset_name: ai.preset_name,
              evaluated_at: F(now()),
              signal: {
                symbol: String(symbol), direction: String(direction), strategy: String(strategy || ''),
                entry: F(or(entry, 0)), sl: F(or(sl, 0)), tp1: F(or(tp1, 0)),
              },
            };
            emitEvt(tradeId, 'ai_evaluation_snapshot', unwrapFloats(snapshot), floatKeyList(snapshot));
            log.debug(pf('[AI-INSIGHTS] snapshot stored uid=%s tid=%s layers=%d', userId, tradeId, ai.layers.length));
          } catch (se) {
            log.warning(pf('[AI-INSIGHTS] snapshot save failed uid=%s: %s', userId, errText(se)));
          }
          if (!ai.passed) {
            const blocking = ai.blocking_layers.join(',');
            const agreeN = ai.layers.filter((r) => r.verdict === AGREE).length;
            log.info(pf('[AI-FILTER-INFO] uid=%s sym=%s strategy=%s blocking=%s agree=%d/%d (информационно — trade продолжается)', userId, symbol, strategy, blocking, agreeN, ai.layers.length));
            // QUIRK (pinned): the bot persists the verdict with `db.db_exec("UPDATE trades SET
            // ai_filter_json=...")`, but `database` has no db_exec (AttributeError, swallowed at
            // DEBUG): ai_filter_json is never written. The site leaves the column untouched too.
            log.debug("ai_filter_json persist: module 'database' has no attribute 'db_exec'");
          }
          result.ai_filter_result = ai;
          try {
            if (bot !== null && bot !== undefined && ai.layers.length) {
              const plan = or(row ? rget(row, 'sub_plan', null) : null, 'free');
              const kb = buildAiButtonKb(ai, String(plan), String(tradeId));
              if (kb !== null) {
                const agreeT = ai.layers.filter((r) => r.verdict === AGREE).length;
                await send(bot, userId, `🧠 <b>AI оценил сигнал</b> (${agreeT}/${ai.layers.length} слоёв согласны)`, { replyMarkup: kb });
              }
            }
          } catch (be) {
            log.debug(pf('[AI-INSIGHTS] follow-up button send failed uid=%s: %s', userId, errText(be)));
          }
        } catch (ae) {
          if (isCancelledError(ae)) throw ae;
          log.warning(pf('[AI-FILTER] evaluate failed uid=%s sym=%s: %s — passing through', userId, symbol, errText(ae)));
        }
      }

      // ── trade_result["ok"] ──
      async function onSuccess() {
        await db.updateTradeBybit(tradeId, pyGet(tradeResult, 'order_id', ''), pyGet(tradeResult, 'pos_idx', 0), pyFloat(or(pyGet(tradeResult, 'qty', 0), 0)));
        const tpVal = truthy(pyGet(tradeResult, 'tp_placed', null)) ? 1 : 0;
        await db.updateTradeTpPlaced(tradeId, tpVal);
        emitEvt(tradeId, 'fill_confirmed', {
          exchange, order_id: pySlice(pyStr(or(pyGet(tradeResult, 'order_id', ''), '')), 128),
          pos_idx: pyGet(tradeResult, 'pos_idx', 0), qty: pyGet(tradeResult, 'qty', 0),
        }, qtyFloatKeys(tradeResult));
        if (tpVal) emitEvt(tradeId, 'tp_placement', { source: 'atomic', tp_placed: true, tp1, tp2, tp3 }, ['tp1', 'tp2', 'tp3']);
        try {
          await db.setTradeState(tradeId, 'OPEN');
        } catch (e) {
          log.debug(pf('state OPEN uid=%s %s: %s', userId, symbol, errText(e)));
        }
        cooldowns.resetZeroBalanceCooldown(userId, exchange);
        cooldowns.resetAuthFailures(userId, exchange);
        log.info(pf('✅ %s TRADE OPENED uid=%s %s %s | entry=%.6g sl=%.6g tp=%.6g risk=%.2f%% lev=×%d | qty=%s oid=%s | %s%s',
          strategy, userId, symbol, direction, entry, sl, tp1, riskPct, leverage,
          traderStr(own(tradeResult, 'qty') ? tradeResult.qty : '?'),
          pySlice(pyStr(own(tradeResult, 'order_id') ? tradeResult.order_id : '?'), 12),
          pyUpper(exchange), bybitDemo ? ' DEMO' : ''));
        try {
          userLog.tradeOpen(userId, rget(row, 'username', null), symbol, direction, {
            entry: pf('%.6g', entry), sl: pf('%.6g', sl), tp1: pf('%.6g', tp1), qty: traderStr(pyGet(tradeResult, 'qty', '')), exchange, strategy,
          });
        } catch (e) {
          log.debug(`user_log trade_open: ${errText(e)}`);
        }
        try {
          await funnelTrackOnce('funnel_first_trade', userId, { strategy, exchange });
        } catch (e) {
          log.debug(pf('funnel first_trade uid=%s: %s', userId, errText(e)));
        }
        if (truthy(rget(row, 'tilt_detector_enabled', true)) && bot) {
          try {
            spawn(`tilt_detect_${userId}`, () => tiltDetector.detectAndNotify(bot, userId));
          } catch (e) {
            log.debug(pf('tilt_detector uid=%s: %s', userId, errText(e)));
          }
        }
        if (bot && truthy(pyGet(tradeResult, 'risk_boosted', null))
          && pyFloat(or(pyGet(tradeResult, 'risk_actual_pct', null), 0)) > pyFloat(or(pyGet(tradeResult, 'risk_requested_pct', null), 0)) * 1.1) {
          try {
            const langRb = rget(row, 'lang', 'ru');
            await send(bot, userId, t('risk_boosted_warning', langRb, {
              symbol: symShort(symbol || ''), req: F(pyGet(tradeResult, 'risk_requested_pct', 0)), act: F(pyGet(tradeResult, 'risk_actual_pct', 0)),
            }));
          } catch (e) {
            log.debug(pf('risk_boost notify uid=%s: %s', userId, errText(e)));
          }
        }
        if (bot && truthy(pyGet(tradeResult, 'risk_capped', null))) {
          try {
            const langRc = rget(row, 'lang', 'ru');
            const req = pyFloat(or(pyGet(tradeResult, 'risk_requested_pct', null), 0));
            const app = pyFloat(or(pyGet(tradeResult, 'risk_applied_pct', null), 0));
            await send(bot, userId, t('risk_capped_warning', langRc, { symbol: symShort(symbol || ''), req: fmtFixed(req, 1), act: fmtFixed(app, 1) }));
          } catch (e) {
            log.debug(pf('risk_cap notify uid=%s: %s', userId, errText(e)));
          }
        }
        if (bot && truthy(pyGet(tradeResult, 'leverage_downgraded', null))) {
          try {
            const langLd = rget(row, 'lang', 'ru');
            await send(bot, userId, t('leverage_downgrade_warning', langLd, {
              symbol: symShort(symbol || ''),
              requested: pyIntStrict(or(pyGet(tradeResult, 'leverage_requested', null), 0)),
              applied: pyIntStrict(or(pyGet(tradeResult, 'leverage_applied', null), 0)),
            }));
          } catch (e) {
            log.debug(pf('leverage_downgrade notify uid=%s: %s', userId, errText(e)));
          }
        }
        if (truthy(rget(row, 'prop_mode', null))) {
          try {
            const todayOrd = utcParts(now()).ordinal;
            const lastDay = pyIntStrict(or(rget(row, 'prop_last_trade_day', 0), 0));
            if (lastDay !== todayOrd) {
              const newDays = pyIntStrict(or(rget(row, 'prop_trading_days', 0), 0)) + 1;
              const snap = or(propBalance, 0);
              const updates = { user_id: userId, prop_last_trade_day: todayOrd, prop_trading_days: newDays };
              if (snap > 0) updates.prop_day_start_balance = snap;
              await db.upsertUser(updates);
              log.info(pf('PROP day-start uid=%s: trading_days=%d day_start_balance=%.2f (new day)', userId, newDays, snap));
            }
          } catch (e) {
            log.debug(pf('PROP bookkeeping uid=%s: %s', userId, errText(e)));
          }
        }
      }

      // ── ok=False ──
      async function onFailure() {
        await db.setTradeResult(tradeId, 'SKIP', 0.0);
        const errTxt = pyStr(or(pyGet(tradeResult, 'error', ''), ''));
        log.warning(`${strategy} auto_trade ${symbol} failed: ${errTxt}`);
        if (truthy(pyGet(tradeResult, 'low_notional_skip', null)) && bot) {
          const langLn = rget(row, 'lang', 'ru');
          const reqRisk = own(tradeResult, 'requested_risk_pct') ? tradeResult.requested_risk_pct : riskPct;
          // the trader's requested_risk_pct / risk_pct are Python floats; required_balance is round(x, 2)
          // when present, the int 0 default otherwise
          const reqRiskV = typeof reqRisk === 'number' ? F(reqRisk) : reqRisk;
          const reqBal = own(tradeResult, 'required_balance') ? tradeResult.required_balance : 0;
          const strat = pyUpper(String(or(strategy, '?')));
          const lnNow = now();
          const lnLast = lowNotionalNotifyTs.has(Math.trunc(userId)) ? lowNotionalNotifyTs.get(Math.trunc(userId)) : 0.0;
          if (lnNow - lnLast >= 86400) {
            lowNotionalNotifyTs.set(Math.trunc(userId), lnNow);
            try {
              await send(bot, userId, t('low_notional_skip_notif', langLn, {
                symbol: symShort(symbol || ''), strategy: strat, requested_risk: reqRiskV, required_balance: pyIntStrict(reqBal),
              }));
            } catch (e) {
              log.debug(pf('low_notional notif uid=%s: %s', userId, errText(e)));
            }
          } else {
            log.debug(pf('[LOW-NOTIONAL-THROTTLE] uid=%s skip notif (last sent %.0fs ago)', userId, lnNow - lnLast));
          }
          log.info(pf('[FILTER-BLOCK] uid=%s sym=%s strategy=%s gate=%s reason=%r value=%.2f threshold=%s',
            userId, symbol, strategy, 'low_notional_skip', `notional<$10, requested_risk=${pf('%s', reqRiskV)}%`, reqRisk,
            own(tradeResult, 'required_balance') ? F(reqBal) : reqBal));
        }
        const lower = pyLower(errTxt);
        const isZeroBalance = lower.includes('недостаточно средств') || lower.includes('insufficient') || errTxt.includes('$0.00');
        const isLowNotional = truthy(pyGet(tradeResult, 'low_notional_skip', null));
        const isInsufficientMargin = truthy(pyGet(tradeResult, 'insufficient_margin', null));
        if (errTxt.includes('110125')) {
          cooldowns.setCommodityBlocklist(userId, symbol);
          log.info(pf('[COMMODITY-BLOCK] uid=%s sym=%s: set 24h block (ErrCode 110125 — user-agreement required)', userId, symbol));
        }
        if (isZeroBalance || isLowNotional || isInsufficientMargin) {
          const cdReason = isZeroBalance ? 'zero_balance' : (isLowNotional ? 'low_notional' : 'insufficient_margin');
          cooldowns.setZeroBalanceCooldown(userId, exchange);
          log.info(pf('[ZB-COOLDOWN] uid=%s exch=%s reason=%s → skip 30мин', userId, exchange, cdReason));
          if (bot && isZeroBalance) {
            try {
              await send(bot, userId, t('zb_cooldown_set_notif', rget(row, 'lang', 'ru'), {
                symbol: symShort(symbol || ''), exchange: pyUpper(exchange || ''), minutes: Math.trunc(ZERO_BAL_COOLDOWN_SEC / 60),
              }));
            } catch (e) {
              log.debug(pf('zb_cooldown notif uid=%s: %s', userId, errText(e)));
            }
          }
        }
      }

      // ── partial TP (+ main-TP fallback) and the LIMIT-unfilled guard ──
      function scheduleBackground() {
        try {
          const qty = pyFloat(or(pyGet(tradeResult, 'qty', 0), 0));
          if (!(qty > 0)) return;
          const posIdx = pyIntStrict(or(pyGet(tradeResult, 'pos_idx', 0), 0));
          const okxPp = or(rget(row, 'okx_passphrase', ''), '');
          const ptpTask = async () => {
            let partialOk = false;
            try {
              partialOk = await partialTp.placePartialTpOrders({
                api_key: apiKey, api_secret: apiSecret, symbol, entry, sl, direction, total_qty: qty, user: row,
                strategy_name: strategy, exchange, bybit_demo: bybitDemo, pos_idx: posIdx,
                tp1_signal_price: pyFloat(or(tp1, 0)), tp2_signal_price: pyFloat(or(tp2, 0)), bot,
              });
            } catch (pe) {
              if (isCancelledError(pe)) throw pe;
              log.warning(pf('[C79-PTP-FAIL] uid=%s %s: partial_tp exception: %s — falling back to main TP', userId, symbol, errText(pe)));
            }
            emitEvt(tradeId, 'partial_tp_placed', { ok: Boolean(partialOk), strategy, exchange, qty }, ['qty']);
            if (!partialOk && ptpEnabled) {
              let fbShouldRun = true;
              try {
                const reco = await reconcile.reconcileTimeoutPosition({ exchange, apiKey, apiSecret, symbol, direction, bybitDemo, okxPassphrase: okxPp });
                const live = pyFloat(or((reco || {}).size, 0));
                if (live <= 0) {
                  fbShouldRun = false;
                  log.info(pf('[C79-PTP-FB-SKIP] uid=%s %s: position size=0 — entry not filled or already closed; LIMIT-UNFILLED guard / orphan sweeper will reconcile', userId, symbol));
                }
              } catch (ge) {
                if (isCancelledError(ge)) throw ge;
                log.debug(pf('[C79-PTP-FB-GATE] uid=%s %s reconcile check failed (fail-open): %s', userId, symbol, errText(ge)));
              }
              if (!fbShouldRun) return;
              try {
                let fbOk;
                if (exchange === 'bybit') {
                  fbOk = await traderFor('bybit').placeTpOrders(apiKey, apiSecret, symbol, direction, qty, tp1, tp2, tp3, posIdx, bybitDemo);
                } else if (exchange === 'bingx' || exchange === 'binance') {
                  const fbRes = await traderFor(exchange).placeSlTpForPosition(apiKey, apiSecret, symbol, direction, qty, sl, tp1, tp2, tp3);
                  fbOk = truthy(pyGet(fbRes, 'tp_placed', false));
                } else if (exchange === 'okx') {
                  const fbRes = await traderFor('okx').placeSlTpForPosition(apiKey, apiSecret, symbol, direction, qty, sl, tp1, tp2, tp3, okxPp);
                  fbOk = truthy(pyGet(fbRes, 'tp_placed', false));
                } else {
                  fbOk = false;
                }
                if (fbOk) {
                  log.info(pf('[C79-PTP-FB] uid=%s %s: main TP placed as fallback', userId, symbol));
                } else {
                  log.warning(pf('[C79-PTP-FB-FAIL] uid=%s %s: main TP fallback ALSO failed — BE-monitor will retry', userId, symbol));
                  if (bot) await notifyTpFailed('tp_placement_failed');
                }
              } catch (fe) {
                if (isCancelledError(fe)) throw fe;
                log.warning(pf('[C79-PTP-FB] uid=%s %s exception: %s', userId, symbol, errText(fe)));
                if (bot) await notifyTpFailed('tp_placement_failed_exc');
              }
            }
          };
          spawn(`partial_tp_${userId}_${symbol}`, ptpTask, (err) => log.warning(pf('partial_tp task error: %s', errText(err))));

          const graceS = resolveLimitUnfilledGrace(strategy || '');
          const lugTask = async () => {
            let triggered;
            try {
              triggered = await reconcile.limitUnfilledGuard({ exchange, apiKey, apiSecret, symbol, direction, bybitDemo, okxPassphrase: okxPp, graceS });
            } catch (le) {
              if (isCancelledError(le)) throw le;
              log.debug(pf('limit_unfilled_guard %s: %s', symbol, errText(le)));
              return;
            }
            if (triggered && bot) {
              try {
                await send(bot, userId, t('auto_trade_limit_unfilled', lang, { symbol }));
              } catch (ne) {
                log.debug(pf('limit_unfilled notify uid=%s: %s', userId, errText(ne)));
              }
              try {
                await skipNotify.recordUnfilled(bot, userId, symbol);
              } catch (se) {
                log.debug(pf('skip_notify uid=%s: %s', userId, errText(se)));
              }
            }
          };
          spawn(`limit_unfilled_guard_${userId}_${symbol}`, lugTask, (err) => log.warning(pf('limit_unfilled_guard task error: %s', errText(err))));
        } catch (e) {
          log.debug(`partial_tp: ${errText(e)}`);
        }
      }

      async function notifyTpFailed(reason) {
        try {
          const msg = t('tp_placement_failed', lang, { symbol: symShort(symbol) });
          const ok = await send(bot, userId, msg);
          if (!ok && enqueueCritical) await enqueueCritical(bot, userId, msg, { parseMode: 'HTML', reason });
        } catch (ne) {
          log.debug(pf('tp-fail notify uid=%s: %s', userId, errText(ne)));
        }
      }

      // ── asyncio.TimeoutError escaped the placement ──
      async function onTimeout() {
        const to = exchange === 'bingx' ? PLACE_TRADE_TIMEOUT_BINGX : (exchange === 'binance' ? PLACE_TRADE_TIMEOUT_BINANCE : PLACE_TRADE_TIMEOUT_BYBIT);
        log.warning(pf('%s auto_trade %s uid=%s: timeout %ds — reconciling…', strategy, symbol, userId, to));
        const okxPp = or(rget(row, 'okx_passphrase', ''), '');
        const reco = await reconcile.reconcileTimeoutPosition({ exchange, apiKey, apiSecret, symbol, direction, bybitDemo, okxPassphrase: okxPp });
        if (reco && reco.size > 0) {
          const recoSize = pyFloat(reco.size);
          log.info(pf('[TIMEOUT-RECONCILE] %s uid=%s %s: trade succeeded despite timeout — size=%.4g side=%s order_id=%s',
            strategy, userId, symbol, recoSize, reco.side === undefined ? '?' : reco.side, pySlice(reco.order_id, 20)));
          try {
            await db.updateTradeBybit(tradeId, reco.order_id, 0, recoSize);
          } catch (de) {
            log.debug(`reconcile update_trade: ${errText(de)}`);
          }
          const recoSl = pyFloat(or(reco.stopLoss, 0));
          if (recoSl === 0 && sl > 0) {
            log.warning(pf('[TIMEOUT-RECONCILE-SL] uid=%s %s: position open with NO SL on exchange — scheduling set_trailing_sl(%.6g) fallback', userId, symbol, sl));
            spawn(`reconcile_sl_${userId}_${symbol}`, async () => {
              try {
                const tr = traderFor(exchange);
                let res;
                if (exchange === 'bingx' || exchange === 'binance') res = await tr.setTrailingSl(apiKey, apiSecret, symbol, sl, direction, 0);
                else if (exchange === 'okx') res = await tr.setTrailingSl(apiKey, apiSecret, symbol, sl, direction, 0, okxPp);
                else res = await traderFor('bybit').setTrailingSl(apiKey, apiSecret, symbol, sl, direction, 0, bybitDemo);
                if (res && truthy(pyGet(res, 'ok', null))) {
                  log.info(pf('[TIMEOUT-RECONCILE-SL] uid=%s %s: SL placed at %.6g after reconcile', userId, symbol, sl));
                } else {
                  log.warning(pf('[TIMEOUT-RECONCILE-SL] uid=%s %s: fallback SL failed: %s', userId, symbol, pyGet(res || {}, 'error', '?')));
                }
              } catch (se) {
                if (isCancelledError(se)) throw se;
                log.warning(pf('[TIMEOUT-RECONCILE-SL] uid=%s %s exception: %s', userId, symbol, errText(se)));
              }
            });
          }
          try {
            spawn(`reconcile_ptp_${userId}_${symbol}`, async () => {
              try {
                await partialTp.placePartialTpOrders({
                  api_key: apiKey, api_secret: apiSecret, symbol, entry, sl, direction, total_qty: recoSize, user: row,
                  strategy_name: strategy, exchange, bybit_demo: bybitDemo, pos_idx: 0,
                  tp1_signal_price: pyFloat(or(tp1, 0)), tp2_signal_price: pyFloat(or(tp2, 0)), bot,
                });
                log.info(pf('[TIMEOUT-RECONCILE-PTP] uid=%s %s: partial TP placed on reconciled pos', userId, symbol));
              } catch (pe) {
                if (isCancelledError(pe)) throw pe;
                log.warning(pf('[TIMEOUT-RECONCILE-PTP] uid=%s %s failed: %s — BE-monitor will retry SL/TP', userId, symbol, errText(pe)));
              }
            });
          } catch (pe0) {
            log.debug(`reconcile ptp schedule: ${errText(pe0)}`);
          }
          if (bot) {
            try {
              await send(bot, userId, t('auto_trade_timeout_reconciled', lang, { symbol }));
            } catch (se) {
              log.debug(`reconcile notify: ${errText(se)}`);
            }
          }
        } else {
          const cancelled = await reconcile.cancelPendingAfterTimeout({ exchange, apiKey, apiSecret, symbol, bybitDemo, okxPassphrase: okxPp });
          log.error(pf('%s auto_trade %s uid=%s: timeout %ds, no position found on exchange — SKIP (cancelled %d pending order(s))', strategy, symbol, userId, to, cancelled));
          await db.setTradeResult(tradeId, 'SKIP', 0.0);
          if (bot) await send(bot, userId, t('auto_trade_timeout', lang, { symbol }));
        }
      }

      // ── any other exception ──
      async function onError(e) {
        if (isUserFacingError(e)) {
          log.warning(pf('%s auto_trade %s uid=%s user-facing error: %s', strategy, symbol, userId, errText(e)));
          if (isAuthFailure(e)) await cooldowns.handleAuthFailure(userId, exchange, bot);
        } else {
          log.error(pf('%s auto_trade %s uid=%s SERVER error', strategy, symbol, userId));
          try { sentryCapture(e); } catch (se) { log.debug(`sentry capture failed: ${errText(se)}`); }
          if (bot) {
            try {
              await adminAlerts.sendAdminAlert(bot, 'Auto-trade server error',
                `<b>uid</b>=${userId} <b>sym</b>=${htmlEscape(symbol)} `
                + `<b>ex</b>=${exchange} <b>dir</b>=${direction}\n`
                + `<b>strategy</b>=${strategy}\n`
                + `<code>${htmlEscape(exTypeName(e))}: `
                + `${htmlEscape(pySlice(errText(e), 250))}</code>`,
                `at_err_${userId}_${exchange}_${exTypeName(e)}`, 'auto_trade_error');
            } catch (ae) {
              log.debug(`admin_alert send failed: ${errText(ae)}`);
            }
          }
        }
        await db.setTradeResult(tradeId, 'SKIP', 0.0);
        if (bot) await send(bot, userId, t('auto_trade_error', lang, { symbol, error: htmlEscape(errText(e)) }));
      }
    }
  }

  return {
    executeAutoTrade,
    safeSkipTrade,
    _tradeLocks: tradeLocks,
    _disabledDaysNotified: disabledDaysNotified,
    _lowNotionalNotifyTs: lowNotionalNotifyTs,
    gcTradeLocks() {
      let n = 0;
      for (const [k, lk] of Array.from(tradeLocks.entries())) if (!lk.locked()) { tradeLocks.delete(k); n += 1; }
      return n;
    },
    currentTaskName,
  };
}

/** Replace F() wrappers by numbers (for the event payload) — the float keys keep their ".0". */
function unwrapFloats(v) {
  if (v && typeof v === 'object' && typeof v.valueOf === 'function' && v.constructor && v.constructor.name === 'PyFloat') return v.v;
  if (Array.isArray(v)) return v.map(unwrapFloats);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = unwrapFloats(v[k]);
    return out;
  }
  return v;
}
function floatKeyList(v, acc = new Set()) {
  if (Array.isArray(v)) { v.forEach((x) => floatKeyList(x, acc)); return Array.from(acc); }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (x && typeof x === 'object' && x.constructor && x.constructor.name === 'PyFloat') acc.add(k);
      else floatKeyList(x, acc);
    }
  }
  return Array.from(acc);
}

module.exports = {
  createExecutor, utcParts, PLACE_TRADE_TIMEOUT_BYBIT, PLACE_TRADE_TIMEOUT_BINGX, PLACE_TRADE_TIMEOUT_BINANCE,
  ENTRY_IMPROVE_PCT, STRATEGY_MAX_SL_DEFAULTS,
};
