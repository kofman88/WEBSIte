/**
 * Auto-trade executor — receives validated signals, opens virtual or real
 * positions with SL/TP orders, writes to `trades` + `trade_fills`.
 *
 *   Paper mode (default):
 *     — no exchange calls
 *     — price simulated via marketDataService.fetchCandles on next tick
 *     — partialTpManager watches and fills TPs/SL
 *
 *   Live mode:
 *     — exchangeService.getCcxtClient → client.createMarketOrder (entry)
 *     — then client.createOrder for SL (stop-market) + TP1/TP2/TP3 (reduce-only limits)
 *     — if SL placement fails → close entry immediately (never open naked)
 *     — order ids stored in trades.exchange_order_ids JSON
 *
 * PRINCIPLE: NEVER open a position without a stop-loss.
 */

const db = require('../models/database');
const logger = require('../utils/logger');
const plans = require('../config/plans');
const breaker = require('./circuitBreaker');

const PARTIAL_FRACTIONS = { tp1: 0.33, tp2: 0.33, tp3: 0.34 };

function _json(v) { try { return JSON.stringify(v); } catch { return null; } }
function _safeJson(s, fb) { if (!s) return fb; try { return JSON.parse(s); } catch { return fb; } }

// Per-bot serialiser — guards the open-trade flow so that two signals
// arriving within ms (e.g. multi-strategy combo on Elite, or scanner
// double-firing during a cycle) cannot both pass the max_open_trades
// check while one is still mid-await on exchange.balance / createOrder.
// Without this, on live mode a bot with max_open_trades=3 could end up
// with 4-5 simultaneous positions and break the user's risk plan.
const _botLocks = new Map();
function _withBotLock(botId, fn) {
  const prev = _botLocks.get(botId) || Promise.resolve();
  const next = prev.then(fn, fn).finally(() => {
    if (_botLocks.get(botId) === next) _botLocks.delete(botId);
  });
  _botLocks.set(botId, next);
  return next;
}

/**
 * Main entry. Called by server bridge when worker emits auto_trade_request.
 * @returns {Trade|null}
 */
async function executeSignal(signal, bot, opts = {}) {
  if (!signal || !bot) return null;
  // Serialise per-bot — see _withBotLock comment above.
  return _withBotLock(bot.id, () => _executeSignalInner(signal, bot, opts));
}

async function _executeSignalInner(signal, bot, { exchangeService = null, marketData = null } = {}) {

  // 1. Plan gating — only blocks LIVE auto-trade. Paper (Demo) is free
  //    on every plan so users can validate strategies on virtual $10k
  //    before paying for Pro. Mirrors the rule in botService.createBot /
  //    updateBot, which already prevents toggling live + autoTrade on
  //    sub-Pro plans.
  const plan = _getUserPlan(bot.user_id);
  if (bot.trading_mode === 'live' && !plans.canUseFeature(plan, 'autoTrade')) {
    logger.warn('auto_trade rejected: live mode requires Pro plan', { userId: bot.user_id, plan, botId: bot.id });
    return null;
  }

  // 2. Circuit breaker
  const cb = breaker.check(bot.user_id, { tradingMode: bot.trading_mode });
  if (!cb.allow) {
    logger.warn('auto_trade blocked: circuit breaker', { userId: bot.user_id, ...cb });
    return null;
  }

  // 2b. User-level risk limits — kill-switch / max-open-positions-global /
  //     daily-loss / blacklisted-symbol. Guards runaway losses across all
  //     bots an account owns.
  try {
    const riskLimits = require('./riskLimitsService');
    const guard = riskLimits.canOpenTrade(bot.user_id, { symbol: signal.symbol });
    if (!guard.allow) {
      logger.warn('auto_trade blocked: risk limit', { userId: bot.user_id, botId: bot.id, ...guard });
      return null;
    }
  } catch (e) { /* never break trading on a risk-check bug */ logger.warn('risk check error', { err: e.message }); }

  // 3. Max open trades check (per-bot)
  const openCount = db.prepare(`
    SELECT COUNT(*) as n FROM trades WHERE bot_id = ? AND status = 'open'
  `).get(bot.id).n;
  if (openCount >= (bot.max_open_trades || 3)) {
    logger.debug('auto_trade skip: max_open_trades reached', { botId: bot.id, openCount });
    return null;
  }

  // 4. Leverage respect (plan-capped)
  const maxLev = plans.getLimits(plan).maxLeverage || 5;
  const leverage = Math.min(bot.leverage || 1, maxLev);

  // 5. Balance + quantity computation
  const equity = await _getEquityForSizing(bot, { exchangeService });
  if (equity <= 0) {
    logger.warn('auto_trade skip: zero equity', { botId: bot.id });
    return null;
  }
  const qty = _computeQty(equity, signal.entry, signal.stopLoss, bot.risk_pct || 1, leverage);
  if (qty <= 0) {
    logger.warn('auto_trade skip: qty=0', { botId: bot.id, signal });
    return null;
  }

  // 5b. Re-check max_open_trades after the equity-fetch await — _withBotLock
  // serialises calls per bot so this should always equal the earlier read,
  // but be defensive in case an out-of-band trade was inserted (e.g. manual
  // trade through /api/bots/manual-trade attributed to this bot_id).
  const recheckOpen = db.prepare(
    `SELECT COUNT(*) as n FROM trades WHERE bot_id = ? AND status = 'open'`,
  ).get(bot.id).n;
  if (recheckOpen >= (bot.max_open_trades || 3)) {
    logger.debug('auto_trade skip: max_open_trades reached on recheck', { botId: bot.id, recheckOpen });
    return null;
  }

  // 6. Open position
  const trade = bot.trading_mode === 'live'
    ? await _openLive(signal, bot, qty, leverage, { exchangeService })
    : _openPaper(signal, bot, qty, leverage);

  // 7. Copy-trading: mirror the signal to all followers of this user (best-
  //    effort; never breaks the leader's own trade)
  try {
    const copy = require('./copyTradingService');
    copy.mirrorLeaderSignal(bot.user_id, signal);
  } catch (_e) { /* silent */ }

  return trade;
}

// Plan lookups get hit once per signal → once per trade. On a busy cycle
// that's 1000+ SELECTs against subscriptions. Cache with a 30s TTL (plans
// change rarely, and billing events invalidate via clearPlanCache()).
const _planCache = new Map(); // userId → { plan, at }
const PLAN_TTL_MS = 30_000;
function _getUserPlan(userId) {
  const hit = _planCache.get(userId);
  const now = Date.now();
  if (hit && now - hit.at < PLAN_TTL_MS) return hit.plan;
  const row = db.prepare('SELECT plan FROM subscriptions WHERE user_id = ?').get(userId);
  const plan = (row && row.plan) || 'free';
  _planCache.set(userId, { plan, at: now });
  return plan;
}
function clearPlanCache(userId) {
  if (userId == null) _planCache.clear();
  else _planCache.delete(userId);
}

async function _getEquityForSizing(bot, { exchangeService }) {
  if (bot.trading_mode === 'live' && bot.exchange_key_id && exchangeService) {
    try {
      const bal = await exchangeService.getBalance(bot.exchange_key_id, bot.user_id);
      const quote = bot.symbols ? _json_quote(bot.symbols) : 'USDT';
      return Number(bal.total[quote] || bal.total.USDT || 0);
    } catch (err) {
      logger.warn('live balance fetch failed, falling back to paper equity', {
        botId: bot.id, err: err.message,
      });
    }
  }
  // Paper equity: track per-bot virtual equity via system_kv, default 10k
  const key = 'paper_equity:bot:' + bot.id;
  const row = db.prepare('SELECT value FROM system_kv WHERE key = ?').get(key);
  if (row) { const v = parseFloat(row.value); if (Number.isFinite(v) && v > 0) return v; }
  const fallback = 10000;
  db.prepare(`INSERT OR REPLACE INTO system_kv (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`)
    .run(key, String(fallback));
  return fallback;
}

function _json_quote(symbolsJson) {
  try {
    const arr = JSON.parse(symbolsJson);
    if (Array.isArray(arr) && arr.length) {
      const s = arr[0];
      const m = /([A-Z]{2,10})$/.exec(s.replace(/[\/\-]/g, ''));
      return m ? m[1] : 'USDT';
    }
  } catch (_e) { /* */ }
  return 'USDT';
}

function _computeQty(equity, entry, stopLoss, riskPct, leverage = 1) {
  if (!Number.isFinite(entry) || !Number.isFinite(stopLoss) || entry <= 0) return 0;
  const riskUsd = equity * (riskPct / 100);
  const slDist = Math.abs(entry - stopLoss);
  if (slDist === 0) return 0;
  const base = riskUsd / slDist;
  // Leverage amplifies margin efficiency, not risk — position size scales up
  return base * Math.max(1, leverage);
}

function _openPaper(signal, bot, qty, leverage) {
  const result = db.prepare(`
    INSERT INTO trades
      (user_id, bot_id, signal_id, exchange, symbol, side, strategy, timeframe,
       entry_price, quantity, leverage, margin_used,
       stop_loss, take_profit_1, take_profit_2, take_profit_3,
       status, trading_mode, exchange_order_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'paper', ?)
  `).run(
    bot.user_id, bot.id, signal.id || null,
    bot.exchange, signal.symbol || _firstSymbol(bot), signal.side,
    signal.strategy || bot.strategy, bot.timeframe,
    signal.entry, qty, leverage, (signal.entry * qty) / Math.max(1, leverage),
    signal.stopLoss, signal.tp1 || null, signal.tp2 || null, signal.tp3 || null,
    _json({ paper: true })
  );
  const tradeId = result.lastInsertRowid;

  db.prepare(`
    INSERT INTO trade_fills (trade_id, event_type, price, quantity)
    VALUES (?, 'entry', ?, ?)
  `).run(tradeId, signal.entry, qty);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'auto_trade.paper.open', 'trade', ?, ?)
  `).run(bot.user_id, tradeId, _json({ botId: bot.id, signalId: signal.id, qty, side: signal.side }));

  logger.info('paper trade opened', {
    tradeId, botId: bot.id, side: signal.side, qty: round(qty), entry: round(signal.entry),
  });
  try {
    const notifier = require('./notifier');
    notifier.dispatch(bot.user_id, {
      type: 'trade_opened',
      title: `${signal.symbol || ''} · ${signal.side.toUpperCase()}`,
      body: `Бот «${bot.name}» открыл paper-сделку @ ${round(signal.entry)}, SL ${round(signal.stopLoss)}`,
      link: '/dashboard.html',
    });
  } catch (e) {
    // Notifier failures must not break trade execution, but we need to
    // know they happen (e.g. email DNS issue → investigate).
    logger.warn('trade notifier dispatch failed', {
      userId: bot.user_id, tradeId, err: e.message,
    });
  }
  return _getTrade(tradeId);
}

async function _openLive(signal, bot, qty, leverage, { exchangeService }) {
  if (!exchangeService) throw new Error('live mode requires exchangeService');
  const client = exchangeService.getCcxtClient(bot.exchange_key_id, bot.user_id);
  const symbol = signal.symbol || _firstSymbol(bot);
  const side = signal.side; // 'long' | 'short'
  const ccxtSide = side === 'long' ? 'buy' : 'sell';
  const oppositeSide = side === 'long' ? 'sell' : 'buy';

  const orderIds = {};
  let entryOrder = null;

  try {
    // Set leverage (best-effort — some exchanges reject duplicate setLeverage)
    try { if (client.setLeverage) await client.setLeverage(leverage, symbol); } catch (_e) { /* */ }

    // 1. Market entry
    entryOrder = await client.createMarketOrder(symbol, ccxtSide, qty);
    orderIds.entry = entryOrder.id;

    // 2. Stop loss (stop-market, reduce-only)
    try {
      const slOrder = await client.createOrder(symbol, 'stop_market', oppositeSide, qty, undefined, {
        stopPrice: signal.stopLoss, reduceOnly: true,
      });
      orderIds.sl = slOrder.id;
    } catch (slErr) {
      // CRITICAL: couldn't set SL → close entry immediately. Track every
      // outcome in audit_log + DB so a naked position is never silent.
      logger.error('SL placement failed — closing entry', { err: slErr.message, botId: bot.id });
      let emergencyClosed = false;
      try {
        await client.createMarketOrder(symbol, oppositeSide, qty, undefined, { reduceOnly: true });
        emergencyClosed = true;
      } catch (e2) {
        logger.error('emergency close also failed — NAKED POSITION', { err: e2.message, botId: bot.id });
      }
      if (!emergencyClosed) {
        // Naked position on the exchange. Insert a tracking row so
        // slVerifier + admin dashboard see it and the user gets alerted,
        // instead of throwing and losing the only record of this trade.
        try {
          db.prepare(`
            INSERT INTO trades
              (user_id, bot_id, signal_id, exchange, symbol, side, strategy, timeframe,
               entry_price, quantity, leverage, margin_used,
               stop_loss, status, trading_mode, exchange_order_ids, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'live', ?, ?)
          `).run(
            bot.user_id, bot.id, signal.id || null,
            bot.exchange, symbol, side,
            signal.strategy || bot.strategy, bot.timeframe,
            Number(entryOrder.average || entryOrder.price || signal.entry),
            qty, leverage, (Number(entryOrder.average || signal.entry) * qty) / Math.max(1, leverage),
            signal.stopLoss, _json(orderIds),
            'NAKED_POSITION: SL placement and emergency close both failed — manual intervention required',
          );
        } catch (dbErr) {
          logger.error('failed to insert naked-position tracking row', { err: dbErr.message, botId: bot.id });
        }
        // Loud alert to user so they don't discover this from a margin call
        try {
          const notifier = require('./notifier');
          notifier.dispatch(bot.user_id, {
            type: 'security',
            title: '🚨 Открытая позиция без SL — закройте вручную',
            body: `${symbol} ${side.toUpperCase()} qty=${qty}: не удалось поставить SL и закрыть позицию автоматически. Зайдите на ${bot.exchange} и закройте вручную.`,
            link: '/dashboard.html',
          });
        } catch (_n) {}
      }
      throw slErr;
    }

    // 3. Take profits (reduce-only limit)
    const tpPrices = [signal.tp1, signal.tp2, signal.tp3].filter((p) => Number.isFinite(p) && p > 0);
    const tpQtys = [qty * PARTIAL_FRACTIONS.tp1, qty * PARTIAL_FRACTIONS.tp2, qty * PARTIAL_FRACTIONS.tp3];
    for (let i = 0; i < tpPrices.length; i++) {
      try {
        const o = await client.createOrder(symbol, 'limit', oppositeSide, tpQtys[i], tpPrices[i], { reduceOnly: true });
        orderIds['tp' + (i + 1)] = o.id;
      } catch (tpErr) {
        logger.warn('TP placement failed (non-fatal)', { i: i + 1, err: tpErr.message, botId: bot.id });
      }
    }
  } catch (err) {
    // Differentiate CCXT error classes — without this, every error from
    // any exchange API just bubbles up the same way and the bot keeps
    // taking signals against a broken connection. We also need to
    // pause the bot for 401 / InsufficientFunds so the user gets a
    // clear "fix your key / top up margin" prompt instead of a silent
    // stream of failed trades in audit_log.
    let ccxt = null; try { ccxt = require('ccxt'); } catch (_e) {}
    let action = 'auto_trade.live.error';
    let pauseBot = false;
    let alertTitle = null;
    if (ccxt && err) {
      if (ccxt.AuthenticationError && err instanceof ccxt.AuthenticationError) {
        action = 'auto_trade.live.auth_error'; pauseBot = true;
        alertTitle = '🔑 Биржа отклонила ключ';
      } else if (ccxt.InsufficientFunds && err instanceof ccxt.InsufficientFunds) {
        action = 'auto_trade.live.insufficient_funds'; pauseBot = true;
        alertTitle = '💸 Недостаточно маржи на бирже';
      } else if (ccxt.RateLimitExceeded && err instanceof ccxt.RateLimitExceeded) {
        action = 'auto_trade.live.rate_limited';
      } else if (ccxt.InvalidOrder && err instanceof ccxt.InvalidOrder) {
        action = 'auto_trade.live.invalid_order';
        alertTitle = '⚠️ Биржа отклонила параметры ордера';
      }
    }
    db.prepare(`
      INSERT INTO audit_log (user_id, action, entity_type, metadata)
      VALUES (?, ?, 'bot', ?)
    `).run(bot.user_id, action, _json({ botId: bot.id, err: err.message, orderIds }));
    // Pause the bot for fatal-class errors so we don't fire 100 more
    // identical-failing requests against the exchange in the next minute.
    if (pauseBot) {
      try {
        db.prepare('UPDATE trading_bots SET is_active = 0 WHERE id = ?').run(bot.id);
        const notifier = require('./notifier');
        notifier.dispatch(bot.user_id, {
          type: 'security',
          title: alertTitle || '⚠️ Бот остановлен',
          body: `Бот «${bot.name}» автоматически остановлен: ${err.message}. Зайдите в Settings и проверьте API-ключ / баланс на бирже.`,
          link: '/settings.html',
        });
      } catch (_e) { /* best-effort */ }
    }
    throw err;
  }

  const actualEntry = Number(entryOrder.average || entryOrder.price || signal.entry);
  const result = db.prepare(`
    INSERT INTO trades
      (user_id, bot_id, signal_id, exchange, symbol, side, strategy, timeframe,
       entry_price, quantity, leverage, margin_used,
       stop_loss, take_profit_1, take_profit_2, take_profit_3,
       status, trading_mode, exchange_order_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 'live', ?)
  `).run(
    bot.user_id, bot.id, signal.id || null,
    bot.exchange, symbol, side,
    signal.strategy || bot.strategy, bot.timeframe,
    actualEntry, qty, leverage, (actualEntry * qty) / Math.max(1, leverage),
    signal.stopLoss, signal.tp1 || null, signal.tp2 || null, signal.tp3 || null,
    _json(orderIds)
  );
  const tradeId = result.lastInsertRowid;

  db.prepare(`
    INSERT INTO trade_fills (trade_id, event_type, price, quantity, exchange_order_id)
    VALUES (?, 'entry', ?, ?, ?)
  `).run(tradeId, actualEntry, qty, orderIds.entry);

  db.prepare(`
    INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata)
    VALUES (?, 'auto_trade.live.open', 'trade', ?, ?)
  `).run(bot.user_id, tradeId, _json({ botId: bot.id, signalId: signal.id, orderIds, qty, side }));

  logger.info('live trade opened', {
    tradeId, botId: bot.id, side, symbol, qty: round(qty), entry: round(actualEntry),
  });
  try {
    const notifier = require('./notifier');
    notifier.dispatch(bot.user_id, {
      type: 'trade_opened',
      title: `🔴 LIVE · ${symbol} · ${side.toUpperCase()}`,
      body: `Бот «${bot.name}» открыл live-сделку @ ${round(actualEntry)}, SL ${round(signal.stopLoss)}`,
      link: '/dashboard.html',
    });
  } catch (e) {
    logger.warn('live trade notifier dispatch failed', {
      userId: bot.user_id, tradeId, err: e.message,
    });
  }
  return _getTrade(tradeId);
}

function _firstSymbol(bot) {
  try {
    const arr = JSON.parse(bot.symbols || '[]');
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  } catch { return null; }
}

function _getTrade(id) {
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
}

function round(x, d = 8) {
  if (!Number.isFinite(x)) return x;
  const p = Math.pow(10, d);
  return Math.round(x * p) / p;
}

module.exports = {
  executeSignal,
  _computeQty,
  clearPlanCache,
  PARTIAL_FRACTIONS,
};
