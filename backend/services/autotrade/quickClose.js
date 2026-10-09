'use strict';
/**
 * quickClose — the bot's [QUICK-CLOSE] buttons under an auto-traded signal card
 * (quick_close.py + handlers/quick_close.py), one to one:
 *
 *   qc_half_<id>        cb_qc_half        quick_close_half: live size (get_positions, 10 s) → close
 *                                         size / 2 market reduce-only («✅ Закрыта половина: {q:.6g}»)
 *   qc_full_<id>        cb_qc_full        hold-lock (hold_lock_enabled and the 5m→15m cache PnL <
 *                                         hold_lock_min_rr) → the «⏸ Hold-Lock сработал» dialog with
 *                                         «❌ Всё равно закрыть» / «✅ Подождать»; else close 100 %
 *   qc_full_force_<id>  cb_qc_full_force  close 100 % without the hold-lock
 *   qc_holdlock_wait    cb_holdlock_wait  «✅ Хорошо. Дождись TP1 или SL.»
 *   qc_be_<id>          cb_qc_be          quick_move_sl_to_be: set_trailing_sl(entry) → be_set = 1
 *   qc_refresh_<id>     cb_qc_refresh     get_current_pnl + format_progress_text
 *
 * Kept quirks (pinned by tests/autotrade/ops): the trader and the keys come from the TRADE row's
 * `exchange` column (default 'bybit' — the SMC scanner never sets it), not from the user's
 * trade_exchange; OKX half-close raises `close_position() got an unexpected keyword argument
 * 'size'` (OKX close_position has no size) → «❌ Ошибка: …», nothing is closed; OKX full close
 * passes "Sell"/"Buy" as the direction, so a LONG closes posSide "short" (and the trader still
 * cancels every algo order of the symbol afterwards); the hold-lock lets the close through when
 * the cache has no price (fail-open); the progress sign follows the R, so "+-1.50%" happens when
 * there is no stop; progress is shown for a closed trade too; close / SL calls have no timeout.
 *
 * Site additions (D16, applied by routes/appTrade.js before these handlers): the trade must
 * belong to the JWT user, and the money actions need the button on the delivered card
 * (`qc_half_<id>` / `qc_full_<id>` / `qc_be_<id>`); every action runs under the per-user lock of
 * the trade-ops queue (two presses close 50 % then 25 %, never 50 % + 50 % at once).
 */

const exchanges = require('../exchanges');
const { createEffects } = require('./confirmMode');
const { bindValue } = require('../engine/signalTradesRepo');
const { fmtG, fmtFixed, fmtSigned } = require('../../strategies/common/pyfmt');
const { pyRound } = require('../../strategies/common/pyround');
const { pyLower, pyUpper } = require('../../strategies/common/pyUnicode');
const {
  PyError, pyFloat, pyInt, pyGet, pyTruthy, pyStr, pyFloatStr, pySlice, errStr, htmlEscape, AttributeError,
} = require('../exchanges/pyCompat');

const TRADERS = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);
const POSITIONS_TIMEOUT_S = 10.0;

const g = (o, k, d) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);

/** str.upper() of a trade field — AttributeError for None like `trade.get("direction", "").upper()`. */
function upperOf(v) {
  if (typeof v === 'string') return pyUpper(v);
  throw AttributeError(`'${v === null || v === undefined ? 'NoneType' : typeof v}' object has no attribute 'upper'`);
}

/** `_trader_for(exchange)` → [exchange name | null, exchange]. */
function traderFor(exchange) {
  const ex = pyLower(String(exchange || 'bybit'));
  return [TRADERS.includes(ex) ? ex : null, ex];
}

function waitFor(promise, timeoutS) {
  return require('../exchangeKeysService').waitFor(promise, timeoutS);
}

function logOf(deps) { return deps.log || require('../marketData/mdLog').log; }
const inst = (ex, deps) => exchanges.getTrader(ex, { registry: deps.registry }).instance({ demo: false });

/** `_get_position_size(user, trader, symbol, exchange)` → abs(size) of the first non-zero position, 0.0 otherwise. */
async function getPositionSize(user, ex, symbol, deps) {
  try {
    const [key, secret, pp] = deps.keysOf(user.user_id, ex);
    const t = inst(ex, deps);
    const call = () => {
      if (ex === 'bybit') return t.getPositions(key || '', secret || '', symbol, Boolean(g(user, 'bybit_demo', false)));
      if (ex === 'okx') return t.getPositions(key || '', secret || '', symbol, pp || '');
      return t.getPositions(key || '', secret || '', symbol);
    };
    const positions = await waitFor(call, deps.positionsTimeoutS === undefined || deps.positionsTimeoutS === null ? POSITIONS_TIMEOUT_S : deps.positionsTimeoutS);
    for (const p of (pyTruthy(positions) ? positions : [])) {
      const sz = pyFloat(pyTruthy(pyGet(p, 'size', 0)) ? pyGet(p, 'size', 0) : 0);
      if (sz !== 0) return Math.abs(sz);
    }
  } catch (e) {
    logOf(deps).debug(`get_position_size ${ex} ${symbol}: ${errStr(e)}`);
  }
  return 0.0;
}

/** The shared head of quick_close_half / quick_close_full. */
function closeHead(trade) {
  const symbol = g(trade, 'symbol', '');
  const direction = upperOf(g(trade, 'direction', ''));
  const exchange0 = pyLower(String(pyTruthy(g(trade, 'exchange', '')) ? g(trade, 'exchange', '') : 'bybit'));
  const posIdx = pyInt(g(trade, 'pos_idx', 0));
  return { symbol, direction, exchange0, posIdx };
}

async function closeWith(user, trade, deps, half) {
  const L = logOf(deps);
  try {
    const { symbol, direction, exchange0, posIdx } = closeHead(trade);
    const [trader, exchange] = traderFor(exchange0);
    if (trader === null) return { ok: false, msg: `Exchange ${exchange} не поддержан` };
    const [apiKey, apiSecret, pp] = deps.keysOf(user.user_id, exchange);
    if (!apiKey || !apiSecret) return { ok: false, msg: 'API-ключи не настроены' };
    const posSize = await getPositionSize(user, exchange, symbol, deps);
    if (posSize <= 0) return { ok: false, msg: 'Позиция уже закрыта' };
    const closeSide = direction === 'LONG' ? 'Sell' : 'Buy';
    const qty = half ? posSize / 2.0 : posSize;
    const t = inst(exchange, deps);
    let res;
    if (exchange === 'bybit') {
      res = await t.closePosition(apiKey, apiSecret, symbol, closeSide, pyFloatStr(qty), posIdx, Boolean(g(user, 'bybit_demo', false)));
    } else if (exchange === 'okx') {
      // OKX close-position не принимает size: the bot's half call raises TypeError before any request
      if (half) throw new PyError('TypeError', "close_position() got an unexpected keyword argument 'size'");
      res = await t.closePosition(apiKey, apiSecret, symbol, closeSide, pp || '');
    } else {
      res = await t.closePosition(apiKey, apiSecret, symbol, closeSide, qty, posIdx);
    }
    const ok = pyTruthy(pyGet(res, 'ok', false));
    L.info(`[${half ? 'QC-50' : 'QC-100'}] uid=${user.user_id} sym=${pyStr(symbol)} dir=${direction} qty=${fmtG(qty, 6)} → ok=${ok ? 'True' : 'False'}`);
    if (ok) {
      return half
        ? { ok: true, msg: `✅ Закрыта половина: ${fmtG(qty, 6)}`, qty_closed: qty }
        : { ok: true, msg: '✅ Позиция закрыта полностью', qty_closed: qty };
    }
    return { ok: false, msg: `❌ Биржа отказала: ${pySlice(pyStr(pyGet(res, 'error', '')), 120)}` };
  } catch (e) {
    L.warning(`${half ? 'quick_close_half' : 'quick_close_full'} uid=${g(user, 'user_id', '?')}: ${errStr(e)}`);
    return { ok: false, msg: `❌ Ошибка: ${pySlice(errStr(e), 120)}` };
  }
}

/** quick_close_half(user, trade) → {ok, msg[, qty_closed]} */
const quickCloseHalf = (user, trade, deps = {}) => closeWith(user, trade, deps, true);
/** quick_close_full(user, trade) → {ok, msg[, qty_closed]} */
const quickCloseFull = (user, trade, deps = {}) => closeWith(user, trade, deps, false);

/** quick_move_sl_to_be(user, trade) → {ok, msg}; be_set = 1 on success. */
async function quickMoveSlToBe(user, trade, deps = {}) {
  const L = logOf(deps);
  try {
    const symbol = g(trade, 'symbol', '');
    const direction = upperOf(g(trade, 'direction', ''));
    const entry = pyFloat(pyTruthy(g(trade, 'entry', 0)) ? g(trade, 'entry', 0) : 0);
    const exchange0 = pyLower(String(pyTruthy(g(trade, 'exchange', '')) ? g(trade, 'exchange', '') : 'bybit'));
    const posIdx = pyInt(g(trade, 'pos_idx', 0));
    const oldSl = pyFloat(pyTruthy(g(trade, 'sl', 0)) ? g(trade, 'sl', 0) : 0);
    if (entry <= 0) return { ok: false, msg: 'Entry неизвестен' };
    const [trader, exchange] = traderFor(exchange0);
    if (trader === null) return { ok: false, msg: `Exchange ${exchange} не поддержан` };
    const [apiKey, apiSecret, pp] = deps.keysOf(user.user_id, exchange);
    if (!apiKey || !apiSecret) return { ok: false, msg: 'API-ключи не настроены' };
    const t = inst(exchange, deps);
    let res;
    if (exchange === 'bybit') res = await t.setTrailingSl(apiKey, apiSecret, symbol, entry, direction, posIdx, Boolean(g(user, 'bybit_demo', false)));
    else if (exchange === 'okx') res = await t.setTrailingSl(apiKey, apiSecret, symbol, entry, direction, posIdx, pp || '');
    else res = await t.setTrailingSl(apiKey, apiSecret, symbol, entry, direction, posIdx);
    const ok = pyTruthy(pyGet(res, 'ok', false));
    if (ok) {
      try {
        (deps.db || require('../../models/database')).prepare('UPDATE signal_trades SET be_set=1 WHERE trade_id=?').run(bindValue(trade.trade_id));
      } catch (de) {
        L.debug(`update be_set uid=${user.user_id}: ${errStr(de)}`);
      }
    }
    L.info(`[QC-BE] uid=${user.user_id} sym=${pyStr(symbol)} dir=${direction} sl=${fmtG(oldSl, 6)}→entry=${fmtG(entry, 6)} → ok=${ok ? 'True' : 'False'}`);
    if (ok) return { ok: true, msg: `🛡 SL → entry (${fmtG(entry, 6)}). Позиция в безубытке.` };
    return { ok: false, msg: `❌ Биржа отказала: ${pySlice(pyStr(pyGet(res, 'error', '')), 120)}` };
  } catch (e) {
    L.warning(`quick_move_sl_to_be uid=${g(user, 'user_id', '?')}: ${errStr(e)}`);
    return { ok: false, msg: `❌ Ошибка: ${pySlice(errStr(e), 120)}` };
  }
}

/** The last close of a cached candle frame (Frame or bars) — df["close"].iloc[-1]. */
function lastClose(df) {
  if (Array.isArray(df)) return df.length ? pyFloat(df[df.length - 1][4]) : null;
  if (df && df.c && df.length > 0) return pyFloat(df.c[df.length - 1]);
  return null;
}
const frameLen = (df) => (df === null || df === undefined ? 0 : (Array.isArray(df) ? df.length : (df.length || 0)));

/**
 * get_current_pnl(user, trade) → {price, pnl_pct, pnl_r, dist_to_tp1_pct, dist_to_sl_pct, minutes_open} | null.
 * deps.candles(symbol, tf) → the engine cache frame (cache.get_candles); deps.now() → time.time().
 */
async function getCurrentPnl(user, trade, deps = {}) {
  try {
    const symbol = g(trade, 'symbol', '');
    const direction = upperOf(g(trade, 'direction', ''));
    const f0 = (k) => pyFloat(pyTruthy(g(trade, k, 0)) ? g(trade, k, 0) : 0);
    const entry = f0('entry');
    const sl = f0('sl');
    const tp1 = f0('tp1');
    const createdAt = f0('created_at');
    if (entry <= 0) return null;
    let current;
    try {
      let df = await deps.candles(symbol, '5m');
      if (df === null || df === undefined || frameLen(df) === 0) df = await deps.candles(symbol, '15m');
      if (df === null || df === undefined || frameLen(df) === 0) return null;
      current = lastClose(df);
      if (current === null) return null;
    } catch (_e) {
      return null;
    }
    if (current <= 0) return null;
    const pnlPct = direction === 'LONG' ? (current - entry) / entry * 100.0 : (entry - current) / entry * 100.0;
    const riskDist = sl > 0 ? Math.abs(entry - sl) : 0;
    let pnlR = 0.0;
    if (riskDist > 0) pnlR = direction === 'LONG' ? (current - entry) / riskDist : (entry - current) / riskDist;
    let distTp1 = 0.0;
    if (tp1 > 0) distTp1 = direction === 'LONG' ? (tp1 - current) / current * 100.0 : (current - tp1) / current * 100.0;
    let distSl = 0.0;
    if (sl > 0) distSl = direction === 'LONG' ? (current - sl) / current * 100.0 : (sl - current) / current * 100.0;
    const now = deps.now ? deps.now() : Date.now() / 1000;
    const minutesOpen = createdAt > 0 ? (Math.trunc((now - createdAt) / 60) || 0) : 0;
    return {
      price: current,
      pnl_pct: pyRound(pnlPct, 2),
      pnl_r: pyRound(pnlR, 2),
      dist_to_tp1_pct: pyRound(distTp1, 2),
      dist_to_sl_pct: pyRound(distSl, 2),
      minutes_open: minutesOpen,
    };
  } catch (e) {
    logOf(deps).debug(`get_current_pnl uid=${g(user, 'user_id', '?')}: ${errStr(e)}`);
    return null;
  }
}

/** str.replace on a trade field — AttributeError for a non-str like the bot. */
function strField(trade, k) {
  const v = g(trade, k, '');
  if (typeof v !== 'string') throw AttributeError(`'${v === null || v === undefined ? 'NoneType' : typeof v}' object has no attribute 'replace'`);
  return v;
}

/** format_progress_text(trade, pnl) — the HTML progress card. */
function formatProgressText(trade, pnl) {
  const symbol = htmlEscape(strField(trade, 'symbol').split('-USDT-SWAP').join('').split('-USDT').join(''));
  const dirRaw = g(trade, 'direction', '');
  const direction = htmlEscape(typeof dirRaw === 'string' ? dirRaw : pyStr(dirRaw));
  const f0 = (k) => pyFloat(pyTruthy(g(trade, k, 0)) ? g(trade, k, 0) : 0);
  const entry = f0('entry');
  const sl = f0('sl');
  const tp1 = f0('tp1');
  const { price, pnl_r: pnlR, pnl_pct: pnlPct, dist_to_tp1_pct: distTp1, dist_to_sl_pct: distSl, minutes_open: mins } = pnl;
  let statusEmoji;
  if (pnlR > 0.5) statusEmoji = '🟢';
  else if (pnlR > 0) statusEmoji = '🟡';
  else if (pnlR > -0.5) statusEmoji = '🟠';
  else statusEmoji = '🔴';
  const sign = pnlR >= 0 ? '+' : '';
  let timeStr;
  if (mins < 60) timeStr = `${mins} мин`;
  else timeStr = `${Math.floor(mins / 60)}ч ${mins % 60}мин`;
  return [
    `📊 <b>${symbol} ${direction}</b> — прогресс`,
    '',
    `📍 Entry: <code>${fmtG(entry, 6)}</code>`,
    `💹 Сейчас: <code>${fmtG(price, 6)}</code> (${sign}${fmtFixed(pnlPct, 2)}%)`,
    `${statusEmoji} <b>PnL: ${sign}${fmtFixed(pnlR, 2)}R</b> (${sign}${fmtFixed(pnlPct, 2)}%)`,
    '',
    `🎯 TP1: <code>${fmtG(tp1, 6)}</code> — осталось ${fmtSigned(distTp1, 2)}%`,
    `🛑 SL: <code>${fmtG(sl, 6)}</code> — расстояние ${fmtSigned(distSl, 2)}%`,
    '',
    `⏱ Открыто ${timeStr} назад`,
  ].join('\n');
}

// ── handlers/quick_close.py ───────────────────────────────────────────────
function getTrade(deps, tradeId) {
  return (deps.db || require('../../models/database')).prepare('SELECT * FROM signal_trades WHERE trade_id=?').get(String(tradeId)) || null;
}
const isOwner = (trade, user) => Number(g(trade, 'user_id', null)) === Number(user.user_id) && g(trade, 'user_id', null) !== null;
const userLocked = (deps, user, fn) => (deps.userLock ? deps.userLock(user.user_id).run(fn) : fn());

/** The common prologue of cb_qc_half / cb_qc_full / cb_qc_be (missing / foreign / closed). */
function prologue(fx, trade, user) {
  if (!trade) {
    fx.answer('Сделка не найдена', true);
    return 'not_found';
  }
  if (!isOwner(trade, user)) {
    fx.answer('⛔ Не твоя сделка', true);
    return 'foreign';
  }
  if (pyTruthy(g(trade, 'result', null))) {
    fx.answer(`Сделка уже закрыта: ${pyStr(g(trade, 'result', null))}`, true);
    return 'closed';
  }
  return null;
}

/** A handler body with the bot's `except Exception: log.warning(...); cb.answer("❌ Ошибка", show_alert=True)`. */
async function guarded(name, fx, user, tradeId, deps, fn, { answerOnError = true } = {}) {
  try {
    return await fn();
  } catch (e) {
    logOf(deps).warning(`${name} uid=${user.user_id}${tradeId === null ? '' : ` tid=${tradeId}`}: ${errStr(e)}`);
    if (answerOnError) fx.answer('❌ Ошибка', true);
    return { outcome: 'error', effects: fx.list };
  }
}

/** cb_qc_half */
function cbQcHalf(user, tradeId, deps = {}) {
  const fx = createEffects();
  return userLocked(deps, user, () => guarded('cb_qc_half', fx, user, tradeId, deps, async () => {
    const trade = getTrade(deps, tradeId);
    const stop = prologue(fx, trade, user);
    if (stop) return { outcome: stop, effects: fx.list };
    fx.answer('⏳ Закрываю 50%...', false);
    const res = await quickCloseHalf(user, trade, deps);
    fx.send(res.msg, { parseMode: 'HTML' });
    return { outcome: res.ok ? 'closed_half' : 'failed', effects: fx.list, res };
  }));
}

const HOLD_LOCK_KEYBOARD = (tradeId) => [[
  { id: 'qc_full_force', label: '❌ Всё равно закрыть', action: `qc_full_force_${tradeId}`, kind: 'callback' },
  { id: 'qc_holdlock_wait', label: '✅ Подождать', action: 'qc_holdlock_wait', kind: 'callback' },
]];

/** cb_qc_full (with the [W3 HOLD-LOCK] dialog) */
function cbQcFull(user, tradeId, deps = {}) {
  const fx = createEffects();
  return userLocked(deps, user, () => guarded('cb_qc_full', fx, user, tradeId, deps, async () => {
    const trade = getTrade(deps, tradeId);
    const stop = prologue(fx, trade, user);
    if (stop) return { outcome: stop, effects: fx.list };
    if (pyTruthy(g(user, 'hold_lock_enabled', false))) {
      try {
        const pnl = await getCurrentPnl(user, trade, deps);
        const mr = g(user, 'hold_lock_min_rr', 0.5);
        const minRr = pyFloat(pyTruthy(mr) ? mr : 0.5);
        if (pnl !== null && pnl.pnl_r < minRr) {
          fx.answer(`⏸ HOLD-LOCK: PnL = ${fmtFixed(pnl.pnl_r, 2)}R, min для закрытия = ${fmtFixed(minRr, 2)}R`, false);
          fx.send(
            '⏸ <b>Hold-Lock сработал</b>\n\n'
            + `Текущий PnL: <b>${fmtFixed(pnl.pnl_r, 2)}R</b>\n`
            + `Минимум для закрытия: <b>${fmtFixed(minRr, 2)}R</b>\n\n`
            + 'Эта защита включена тобой в /settings — '
            + 'блокирует ранне-закрытие по эмоции.\n'
            + '3+ закрытия в плюс &lt;0.3R съедают edge стратегии.\n\n'
            + '<i>Что делать:</i>',
            { parseMode: 'HTML', keyboard: HOLD_LOCK_KEYBOARD(tradeId) },
          );
          return { outcome: 'hold_lock', effects: fx.list, pnl };
        }
      } catch (hle) {
        logOf(deps).debug(`hold_lock check uid=${user.user_id}: ${errStr(hle)}`);
      }
    }
    fx.answer('⏳ Закрываю позицию...', false);
    const res = await quickCloseFull(user, trade, deps);
    fx.send(res.msg, { parseMode: 'HTML' });
    return { outcome: res.ok ? 'closed' : 'failed', effects: fx.list, res };
  }));
}

/** cb_qc_full_force (its except only logs — no answer) */
function cbQcFullForce(user, tradeId, deps = {}) {
  const fx = createEffects();
  return userLocked(deps, user, () => guarded('cb_qc_full_force', fx, user, null, deps, async () => {
    const trade = getTrade(deps, tradeId);
    if (!trade || !isOwner(trade, user)) {
      fx.answer('⛔', true);
      return { outcome: trade ? 'foreign' : 'not_found', effects: fx.list };
    }
    if (pyTruthy(g(trade, 'result', null))) {
      fx.answer('Сделка уже закрыта', true);
      return { outcome: 'closed', effects: fx.list };
    }
    fx.answer('⏳ Закрываю...', false);
    const res = await quickCloseFull(user, trade, deps);
    fx.send(res.msg, { parseMode: 'HTML' });
    return { outcome: res.ok ? 'closed' : 'failed', effects: fx.list, res };
  }, { answerOnError: false }));
}

/** cb_holdlock_wait */
async function cbHoldlockWait() {
  const fx = createEffects();
  fx.answer('✅ Хорошо. Дождись TP1 или SL.', true);
  return { outcome: 'wait', effects: fx.list };
}

/** cb_qc_be */
function cbQcBe(user, tradeId, deps = {}) {
  const fx = createEffects();
  return userLocked(deps, user, () => guarded('cb_qc_be', fx, user, tradeId, deps, async () => {
    const trade = getTrade(deps, tradeId);
    const stop = prologue(fx, trade, user);
    if (stop) return { outcome: stop, effects: fx.list };
    fx.answer('⏳ Перемещаю SL на entry...', false);
    const res = await quickMoveSlToBe(user, trade, deps);
    fx.send(res.msg, { parseMode: 'HTML' });
    return { outcome: res.ok ? 'be_set' : 'failed', effects: fx.list, res };
  }));
}

/** cb_qc_refresh (no `result` check: a closed trade shows its progress too) */
async function cbQcRefresh(user, tradeId, deps = {}) {
  const fx = createEffects();
  return guarded('cb_qc_refresh', fx, user, tradeId, deps, async () => {
    const trade = getTrade(deps, tradeId);
    if (!trade) {
      fx.answer('Сделка не найдена', true);
      return { outcome: 'not_found', effects: fx.list };
    }
    if (!isOwner(trade, user)) {
      fx.answer('⛔ Не твоя сделка', true);
      return { outcome: 'foreign', effects: fx.list };
    }
    const pnl = await getCurrentPnl(user, trade, deps);
    if (pnl === null) {
      fx.answer('Нет данных о текущей цене', true);
      return { outcome: 'no_data', effects: fx.list };
    }
    const text = formatProgressText(trade, pnl);
    fx.answer();
    fx.send(text, { parseMode: 'HTML' });
    logOf(deps).info(`[QC-PROGRESS] uid=${user.user_id} sym=${pyStr(g(trade, 'symbol', ''))} pnl=${fmtFixed(pnl.pnl_r, 2)}R`);
    return { outcome: 'progress', effects: fx.list, pnl, text };
  });
}

module.exports = {
  POSITIONS_TIMEOUT_S, HOLD_LOCK_KEYBOARD,
  traderFor, getPositionSize, quickCloseHalf, quickCloseFull, quickMoveSlToBe, getCurrentPnl, formatProgressText,
  cbQcHalf, cbQcFull, cbQcFullForce, cbHoldlockWait, cbQcBe, cbQcRefresh,
};
