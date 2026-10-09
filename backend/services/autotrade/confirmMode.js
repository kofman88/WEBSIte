'use strict';
/**
 * confirmMode — the bot's confirm-mode trade button (`auto_trade_mode = "confirm"`):
 * execute_auto_trade returns `show_trade_btn` (gate #33e), the scanner puts
 * «✅ Открыть сделку на Bybit» (callback `exec_trade_<trade_id>`) on the signal card, and
 * handlers/trading.py `exec_trade` opens the position when the user presses it. One to one:
 *
 *   per-trade lock (_exec_trade_locks)    locked → alert exec_trade_locked (always RU)
 *   check_access()                        → message sub_expired (the later, duplicate i18n key
 *                                           wins: «Подписка истекла!») + empty answer
 *   keys of user.trade_exchange           → message exec_api_not_setup (HTML) + empty answer
 *   card edit exec_opening
 *   db_get_trade                          missing → card exec_signal_stale (the text says "older
 *                                           than 4 hours"; nothing checks the age — quirk)
 *   result set                            → card exec_already_opened
 *   order_id set                          → card + alert exec_already_on_exchange
 *   max_trades_limit > 0 and open ≥ max   → card + alert exec_limit_reached (open counts rows
 *                                           with result='' AND order_id!='' except this one)
 *   open trade on the symbol              → card exec_dup_symbol
 *   answer(); message exec_placing_order (deleted at the end)
 *   bingx / binance / okx: place_trade(..., tp2, tp3[, passphrase]) → db_update_trade_bybit(oid, pos_idx)
 *   bybit + SMC with entry_lo/hi > 0: place_trade_split → db_update_trade_bybit + tp_placed
 *   bybit: place_trade → db_update_trade_bybit + tp_placed
 *   message = the trader's format_trade_result(_split) (HTML); any exception →
 *   "❌ Ошибка открытия сделки:\n{e}"
 *
 * Kept quirks (pinned by tests/autotrade/ops): no partial-TP zeroing, risk cap, adaptive /
 * context sizing, idempotency key, staleness / pre-flight checks; no trade_id / user_id to the
 * trader (no deterministic client order ids, plan gate fail-open on uid 0); Bybit is called
 * WITHOUT `demo` (a Bybit-demo user's confirm trades go to the live host); qty is not stored;
 * BingX / Binance / OKX never write tp_placed; the button says "Bybit" for every exchange.
 * D17 (site): the exchange of the placed order is written to signal_trades.exchange (the bot leaves it
 * empty, so its quick close reads 'bybit'); `deps.d17 = {recordExchange: false}` is the bot.
 *
 * Site additions (decision D16, docs/PORT_DECISIONS.md), applied by routes/appTrade.js before
 * this handler runs: the trade must belong to the JWT user and its delivered card must still
 * carry the `exec_trade_<id>` button (`cardOffers`) — the only way the bot lets a user reach
 * exec_trade; the bot's card edit removes the button, so a used / answered card cannot be pressed
 * again. Every exec runs through the trade-ops queue under the per-user lock
 * (workers/tradeOpsWorker.js) inside the per-trade lock.
 *
 * The handler reports what the bot's callback does to the chat as an ordered effect list
 * (`createEffects`): answer(text, show_alert) · edit(text) — the card · send(text, parse_mode,
 * keyboard) — a new message · delete(of) — a sent message removed. `applyEffects` turns them into
 * the site's channels: the card edit → signal_trades.signal_card_json + SSE `trade`, every message
 * that was not deleted → a `trade` notification (feed + SSE + mirrors).
 */

const { makeT } = require('../engine/cards/html');
const { bindValue, pyDumps } = require('../engine/signalTradesRepo');
const { withActionRoutes } = require('../engine/signalDelivery');
const exchanges = require('../exchanges');
const { pyFloat, pyGet, pyTruthy, pyCapitalize, errStr, isDict } = require('../exchanges/pyCompat');

// ── i18n.py (exec_trade callback) ─────────────────────────────────────────
const MESSAGES = Object.freeze({
  exec_api_not_setup: {
    ru: '❌ <b>{exch} API не настроен</b>\n\nПерейди в 💹 Авто-трейдинг → 🔑 Настроить {exch} API',
    en: '❌ <b>{exch} API not configured</b>\n\nGo to 💹 Auto-trading → 🔑 Set up {exch} API',
  },
  exec_opening: { ru: '⏳ Открываю сделку...', en: '⏳ Opening trade...' },
  exec_placing_order: { ru: '⏳ Выставляю ордер на {exch}...', en: '⏳ Placing order on {exch}...' },
  exec_signal_stale: {
    ru: '⚠️ Сигнал устарел (старше 4 часов). Сделка не открыта.',
    en: '⚠️ Signal is stale (older than 4 hours). Trade not opened.',
  },
  exec_already_opened: { ru: 'ℹ️ Сделка уже была открыта ранее.', en: 'ℹ️ This trade was already opened.' },
  exec_already_on_exchange: { ru: '⚠️ Сделка уже была открыта на бирже!', en: '⚠️ Trade was already opened on the exchange!' },
  exec_trade_locked: { ru: '⏳ Сделка уже открывается, подожди...', en: '⏳ Trade is already being opened, please wait...' },
  exec_limit_reached: {
    ru: '⛔ Лимит сделок достигнут ({open}/{max}). Дождись закрытия открытых позиций.',
    en: '⛔ Trade limit reached ({open}/{max}). Wait for open positions to close.',
  },
  exec_dup_symbol: {
    ru: '⚠️ <b>Сделка по {sym} уже открыта</b>\n\nДождись закрытия текущей позиции перед открытием новой.',
    en: '⚠️ <b>A trade on {sym} is already open</b>\n\nWait for the current position to close before opening a new one.',
  },
  // QUIRK: i18n.py defines "sub_expired" twice; the later literal wins
  sub_expired: { ru: 'Подписка истекла!', en: 'Subscription expired!' },
  signal_open_trade_btn: { ru: '✅ Открыть сделку на Bybit', en: '✅ Open trade on Bybit' },
});
const t = makeT(MESSAGES);

const EXCH_NAME = Object.freeze({ bybit: 'Bybit', bingx: 'BingX', binance: 'Binance' });            // exec_api_not_setup
const EXCH_LABEL = Object.freeze({ bybit: 'Bybit', bingx: 'BingX', binance: 'Binance', okx: 'OKX' });  // exec_placing_order
const label = (map, ex) => (Object.prototype.hasOwnProperty.call(map, ex) ? map[ex] : pyCapitalize(ex));

// ── effects (what the callback does to the chat) ──────────────────────────
function createEffects() {
  const list = [];
  return {
    list,
    /** cb.answer(text=None, show_alert=False) */
    answer(text = null, showAlert = false) { list.push({ op: 'answer', text, show_alert: Boolean(showAlert) }); },
    /** safe_edit(cb, text) → cb.message.edit_text(text, parse_mode="HTML", reply_markup=None) */
    edit(text, keyboard = null) { list.push({ op: 'edit', text, parse_mode: 'HTML', keyboard }); },
    /** cb.message.answer(text, parse_mode=…, reply_markup=…) → a handle with delete() */
    send(text, { parseMode = null, keyboard = null } = {}) {
      const idx = list.length;
      list.push({ op: 'send', text, parse_mode: parseMode, keyboard });
      return { delete() { list.push({ op: 'delete', of: idx }); } };
    },
  };
}

/** The user-facing summary of an effect list: the last message, the last alert, the card text. */
function summarize(effects) {
  const deleted = new Set(effects.filter((e) => e.op === 'delete').map((e) => e.of));
  let message = null;
  let alert = null;
  let card = null;
  effects.forEach((e, i) => {
    if (e.op === 'send' && !deleted.has(i)) message = e.text;
    else if (e.op === 'answer' && e.text) alert = { text: e.text, show_alert: e.show_alert };
    else if (e.op === 'edit') card = e.text;
  });
  return { message: message !== null ? message : (alert ? alert.text : card), alert, card };
}

// ── db/trades.py ──────────────────────────────────────────────────────────
function dbOf(deps) { return deps.db || require('../../models/database'); }

/** db_get_trade(trade_id) */
function getTrade(deps, tradeId) {
  return dbOf(deps).prepare('SELECT * FROM signal_trades WHERE trade_id=?').get(String(tradeId)) || null;
}

/** db_count_open_trades(user_id, exclude_trade_id) */
function countOpenTrades(deps, userId, excludeTradeId = '') {
  const d = dbOf(deps);
  if (excludeTradeId) {
    return d.prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE user_id=? AND result='' AND order_id!='' AND trade_id!=?")
      .get(bindValue(userId), String(excludeTradeId)).n;
  }
  return d.prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE user_id=? AND result='' AND order_id!=''").get(bindValue(userId)).n;
}

/** db_has_open_trade_for_symbol(user_id, symbol) */
function hasOpenTradeForSymbol(deps, userId, symbol) {
  return Boolean(dbOf(deps).prepare("SELECT 1 FROM signal_trades WHERE user_id=? AND symbol=? AND result='' AND order_id != '' LIMIT 1")
    .get(bindValue(userId), bindValue(symbol)));
}

/** db_update_trade_bybit(trade_id, order_id, pos_idx, qty=None) */
function updateTradeBybit(deps, tradeId, orderId, posIdx, qty = null) {
  const d = dbOf(deps);
  if (qty !== null && qty !== undefined && qty > 0) {
    d.prepare('UPDATE signal_trades SET order_id=?, pos_idx=?, qty=? WHERE trade_id=?')
      .run(bindValue(orderId), bindValue(posIdx), bindValue(qty), bindValue(tradeId));
  } else {
    d.prepare('UPDATE signal_trades SET order_id=?, pos_idx=? WHERE trade_id=?').run(bindValue(orderId), bindValue(posIdx), bindValue(tradeId));
  }
}

/** D17 (site): signal_trades.exchange = the exchange the order went to (the quick-close / SL→BE buttons read it). */
function updateTradeExchange(deps, tradeId, exchange) {
  if (deps.d17 && deps.d17.recordExchange === false) return;
  try {
    dbOf(deps).prepare('UPDATE signal_trades SET exchange=? WHERE trade_id=?').run(String(exchange), bindValue(tradeId));
  } catch (_e) { /* best effort: the order is placed either way */ }
}

/** db_update_trade_tp_placed(trade_id, value=1) */
function updateTradeTpPlaced(deps, tradeId, value = 1) {
  dbOf(deps).prepare('UPDATE signal_trades SET tp_placed=? WHERE trade_id=?').run(bindValue(value), bindValue(tradeId));
}

// ── the card's buttons (D16) ──────────────────────────────────────────────
/** The delivered card (signal_card_json actions) of `row` still offers the callback `action`. */
function cardOffers(row, action) {
  if (!row || !row.signal_card_json) return false;
  let card;
  try { card = JSON.parse(String(row.signal_card_json)); } catch (_e) { return false; }
  const rows = card && Array.isArray(card.actions) ? card.actions : [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    for (const b of r) if (b && b.kind !== 'url' && b.action === action) return true;
  }
  return false;
}

// ── asyncio.Lock per trade id ─────────────────────────────────────────────
const _execTradeLocks = new Map();

function tradeLock(tradeId) {
  let l = _execTradeLocks.get(tradeId);
  if (!l) {
    l = { held: false };
    _execTradeLocks.set(tradeId, l);
  }
  return l;
}

// ── the handler ───────────────────────────────────────────────────────────
const g = (o, k, d) => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

/**
 * exec_trade(cb) for `tradeId` pressed by `user` (a trader_settings user).
 * deps: { db, registry, keysOf(uid, ex) → [key, secret, passphrase], checkAccess(user) → [ok, why],
 *         userLock(uid) → { run(fn) }, log }
 * → { outcome, effects, result }   outcome: locked | sub_expired | api_not_setup | stale |
 *   already_opened | already_on_exchange | limit | dup_symbol | opened | failed | error
 */
async function execTrade(user, tradeId, deps = {}) {
  const fx = createEffects();
  const log = deps.log || require('../marketData/mdLog').log;
  const lock = tradeLock(tradeId);
  if (lock.held) {
    fx.answer(t('exec_trade_locked', 'ru'), true);
    return { outcome: 'locked', effects: fx.list, result: null };
  }
  lock.held = true;
  try {
    const body = () => execTradeLocked(user, tradeId, fx, deps, log);
    if (deps.userLock) return await deps.userLock(user.user_id).run(body);
    return await body();
  } catch (e) {
    // the handler raised outside its own try (a DB error): what it already did to the chat stays done
    if (e && typeof e === 'object') e.effects = fx.list.slice();
    throw e;
  } finally {
    lock.held = false;
    _execTradeLocks.delete(tradeId);
  }
}

async function execTradeLocked(user, tradeId, fx, deps, log) {
  const out = (outcome, result = null) => ({ outcome, effects: fx.list, result });
  const [has] = deps.checkAccess(user);
  if (!has) {
    fx.send(t('sub_expired', g(user, 'lang', 'ru')));
    fx.answer();
    return out('sub_expired');
  }
  const exchange = g(user, 'trade_exchange', 'bybit');
  const keyEx = ['bingx', 'binance', 'okx'].includes(exchange) ? exchange : 'bybit';
  const [apiKey, apiSecret, passphrase] = deps.keysOf(user.user_id, keyEx);
  const ul = g(user, 'lang', 'ru');
  if (!apiKey || !apiSecret) {
    fx.send(t('exec_api_not_setup', ul, { exch: label(EXCH_NAME, String(exchange)) }), { parseMode: 'HTML' });
    fx.answer();
    return out('api_not_setup');
  }
  fx.edit(t('exec_opening', ul));                                     // C86
  const trade = getTrade(deps, tradeId);
  if (!trade) {
    fx.edit(t('exec_signal_stale', ul));
    fx.answer();
    return out('stale');
  }
  if (pyTruthy(g(trade, 'result', ''))) {
    fx.edit(t('exec_already_opened', ul));
    fx.answer();
    return out('already_opened');
  }
  if (pyTruthy(g(trade, 'order_id', ''))) {
    fx.edit(t('exec_already_on_exchange', ul));
    fx.answer(t('exec_already_on_exchange', ul), true);
    return out('already_on_exchange');
  }
  const maxTrades = g(user, 'max_trades_limit', 5);
  const openCount = countOpenTrades(deps, user.user_id, tradeId);
  if (maxTrades > 0 && openCount >= maxTrades) {
    const limTxt = t('exec_limit_reached', ul, { open: openCount, max: maxTrades });
    fx.edit(limTxt);
    fx.answer(limTxt, true);
    return out('limit');
  }
  if (hasOpenTradeForSymbol(deps, user.user_id, trade.symbol)) {
    const symLabel = String(trade.symbol).split('-USDT-SWAP').join('').split('-USDT').join('');
    fx.edit(t('exec_dup_symbol', ul, { sym: symLabel }));
    fx.answer();
    return out('dup_symbol');
  }
  fx.answer();                                                         // [AUDIT B-4] the one ACK of the long path
  const wait = fx.send(t('exec_placing_order', ul, { exch: label(EXCH_LABEL, String(exchange)) }));
  let text;
  let result = null;
  let failed = false;
  try {
    const riskPct = g(user, 'trade_risk_pct', 1.0);
    const leverage = g(user, 'trade_leverage', 10);
    const isSmc = g(trade, 'breakout_type', '') === 'SMC';
    const entryLo = pyFloat(pyTruthy(trade.entry_lo) ? trade.entry_lo : 0);
    const entryHi = pyFloat(pyTruthy(trade.entry_hi) ? trade.entry_hi : 0);
    // float(trade.get("tp2") or 0) / tp3 — evaluated where Python evaluates them (after entry / sl / tp1)
    const tp2 = () => pyFloat(pyTruthy(trade.tp2) ? trade.tp2 : 0);
    const tp3 = () => pyFloat(pyTruthy(trade.tp3) ? trade.tp3 : 0);
    const reg = { registry: deps.registry };
    if (['bingx', 'binance', 'okx'].includes(exchange)) {
      // BingX/Binance/OKX: split-entry не поддерживается — всегда place_trade
      const trader = exchanges.getTrader(exchange, reg);
      const inst = trader.instance({ demo: false });
      const args = [apiKey, apiSecret, trade.symbol, trade.direction, pyFloat(trade.entry), pyFloat(trade.sl), pyFloat(trade.tp1), riskPct, leverage];
      const kw = { tp2: tp2(), tp3: tp3() };
      if (exchange === 'okx') kw.passphrase = passphrase;
      result = await inst.placeTrade(...args, kw);
      if (pyTruthy(pyGet(result, 'ok'))) {
        updateTradeBybit(deps, tradeId, pyGet(result, 'order_id', ''), pyGet(result, 'pos_idx', 0));
        updateTradeExchange(deps, tradeId, exchange);
      }
      text = trader.formatTradeResult(result, trade.direction, trade.symbol, pyFloat(trade.entry), pyFloat(trade.sl), pyFloat(trade.tp1),
        riskPct, leverage, tp2(), tp3());
    } else if (isSmc && entryLo > 0 && entryHi > 0) {
      const inst = exchanges.getTrader('bybit', reg).instance({ demo: false });
      result = await inst.placeTradeSplit(apiKey, apiSecret, trade.symbol, trade.direction, entryLo, entryHi, pyFloat(trade.sl), pyFloat(trade.tp1),
        riskPct, leverage, { tp2: tp2(), tp3: tp3() });
      if (pyTruthy(pyGet(result, 'ok'))) {
        updateTradeBybit(deps, tradeId, pyGet(result, 'order_id', ''), pyGet(result, 'pos_idx', 0));
        updateTradeTpPlaced(deps, tradeId, pyTruthy(pyGet(result, 'tp_placed')) ? 1 : 0);
        updateTradeExchange(deps, tradeId, 'bybit');
      }
      text = exchanges.bybit.formatTradeResultSplit(result, trade.direction, trade.symbol, entryLo, entryHi, pyFloat(trade.sl), pyFloat(trade.tp1),
        riskPct, leverage, tp2(), tp3());
    } else {
      const inst = exchanges.getTrader('bybit', reg).instance({ demo: false });
      result = await inst.placeTrade(apiKey, apiSecret, trade.symbol, trade.direction, pyFloat(trade.entry), pyFloat(trade.sl), pyFloat(trade.tp1),
        riskPct, leverage, { tp2: tp2(), tp3: tp3() });
      if (pyTruthy(pyGet(result, 'ok'))) {
        updateTradeBybit(deps, tradeId, pyGet(result, 'order_id', ''), pyGet(result, 'pos_idx', 0));
        updateTradeTpPlaced(deps, tradeId, pyTruthy(pyGet(result, 'tp_placed')) ? 1 : 0);
        updateTradeExchange(deps, tradeId, 'bybit');
      }
      text = exchanges.bybit.formatTradeResult(result, trade.direction, trade.symbol, pyFloat(trade.entry), pyFloat(trade.sl), pyFloat(trade.tp1),
        riskPct, leverage, tp2(), tp3());
    }
  } catch (e) {
    log.error(`exec_trade ${tradeId}: ${errStr(e)}`);
    text = `❌ Ошибка открытия сделки:\n${errStr(e)}`;
    failed = true;
  }
  wait.delete();
  fx.send(text, { parseMode: 'HTML' });
  if (failed) return out('error', result);
  return out(isDict(result) && pyTruthy(pyGet(result, 'ok')) ? 'opened' : 'failed', result);
}

// ── the site's channels for the effects ───────────────────────────────────
/**
 * applyEffects(effects, {userId, tradeId, lang, delivery, db}) — the card edit(s) → the trade's card
 * snapshot (html, no buttons: the bot's edit_text without reply_markup) + SSE `trade`; every message
 * that was not deleted → delivery.sendText(type 'trade', link to the signal).
 */
async function applyEffects(effects, { userId, tradeId, lang = 'ru', delivery = null, db = null, log = null } = {}) {
  const L = log || require('../marketData/mdLog').log;
  const deleted = new Set(effects.filter((e) => e.op === 'delete').map((e) => e.of));
  const dl = delivery || defaultDelivery();
  for (let i = 0; i < effects.length; i++) {
    const e = effects[i];
    try {
      if (e.op === 'edit' && tradeId) {
        // the card_snapshot shape of the scanners ({"html", "actions", "lang"}, json.dumps): no buttons left
        const card = pyDumps({ html: e.text, actions: e.keyboard || null, lang });
        (db || require('../../models/database')).prepare('UPDATE signal_trades SET signal_card_json=? WHERE trade_id=? AND user_id=?')
          .run(card, String(tradeId), bindValue(userId));
        const bc = dl && (typeof dl.broadcast === 'function' ? dl.broadcast.bind(dl) : (dl.sse && dl.sse.broadcast));
        if (bc) bc(userId, 'trade', { kind: 'card', trade_id: tradeId, html: e.text, actions: withActionRoutes(e.keyboard || null, tradeId) });
      } else if (e.op === 'send' && !deleted.has(i) && dl) {
        await dl.sendText(userId, e.text, {
          type: 'trade', kind: 'trade', link: tradeId ? `/app/?tab=signals&id=${encodeURIComponent(tradeId)}` : null, keyboard: e.keyboard || null, lang,
          tradeId: tradeId || null,
        });
      }
    } catch (err) {
      L.debug(`[TRADE-OPS] effect ${e.op} uid=${userId}: ${err && err.message}`);
    }
  }
}

let _delivery = null;
function defaultDelivery() {
  if (!_delivery) {
    const SD = require('../engine/signalDelivery');
    _delivery = SD.localFacade(SD.createSignalDelivery());
  }
  return _delivery;
}

module.exports = {
  MESSAGES, t, createEffects, summarize, cardOffers, execTrade, applyEffects,
  getTrade, countOpenTrades, hasOpenTradeForSymbol, updateTradeBybit, updateTradeTpPlaced, updateTradeExchange,
  _execTradeLocks,
};
