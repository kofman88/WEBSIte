'use strict';
/**
 * tradeDb.js — the bot's db/* helpers execute_auto_trade calls, on the site tables
 * (signal_trades = bot `trades`, trader_settings = bot `users`, engine_kv = bot `kv`).
 * SQL is the bot's verbatim; synchronous better-sqlite3 behind the async signatures.
 *
 *   getUser(uid)                          db_get_user — the raw row (ints for booleans), or null
 *   getUserLang(uid)                      db_get_user_lang ('ru' unless the row says ru/en)
 *   upsertUser(data)                      db_upsert_user (only known columns; updated_at; created_at on INSERT)
 *   updatePropPeak(uid, bal)              db_update_prop_peak (atomic UPDATE WHERE bal > peak)
 *   setAutoTrade(uid, on)                 db_set_auto_trade
 *   setTradeResult / setTradeState        db_set_trade_result / db_set_trade_state (signalTradesRepo)
 *   updateTradeBybit(tid, oid, posIdx, qty)  db_update_trade_bybit
 *   updateTradeExchange(tid, ex)          D17: signal_trades.exchange = where the order went (site)
 *   updateTradeTpPlaced(tid, v)           db_update_trade_tp_placed
 *   hasOpenTradeForSymbol(uid, sym)       db_has_open_trade_for_symbol
 *   countOpenTrades(uid, excludeTid, dir) db_count_open_trades (direction: [SAME-DIR-CAP 2026-10])
 *   getAllOpenTrades(uid)                 db_get_all_open_trades
 *   getRecentSlCount(uid, hours)          db_get_recent_sl_count
 *   getTodayLossRr(uid)                   db_get_today_loss_rr
 *   exec(sql, params)                     db_exec (UPDATE trades SET ai_filter_json=…)
 *   kvGet / kvSet / kvKeysWithPrefix / kvItemsWithPrefix   db/misc.py
 *   addTradeEvent(tid, type, payload)     db.trade_events.emit_bg (best effort)
 *
 * The M15 trade-ops loops' readers (bot HEAD 1a47ffc):
 *   getOpenTradesAll()                    db_get_open_trades_all — `result='' AND order_id!='' LIMIT 500`,
 *                                         no ORDER BY: the same partial index (idx_*_open_orders) gives the
 *                                         bot's row order (order_id, then rowid)
 *   getAllStaleOpenTrades(cutoff)         db_get_all_stale_open_trades (FIX-5) with the
 *                                         [GHOST-LIVE-TRADES 2026-10] filter: only rows without an order
 *   getUserWithKeys(uid)                  db_get_user — the raw trader_settings row + username + the nine
 *                                         decrypted key columns (<ex>_api_key/_api_secret, okx_passphrase)
 *   getAllUsersOrdered()                  db_get_all_users — every row, ORDER BY created_at DESC, + keys
 *   getActiveAutoTradeUsers()             user_manager.get_active_auto_trade_users — UNCACHED
 *                                         db_get_active_users (its 3-attempt retry) → _from_db → auto_trade
 *                                         and a key of trade_exchange (bingx/binance/okx, else bybit)
 *   computeFallbackPnlUsd                 db/trades.compute_fallback_pnl_usd (signalTradesRepo)
 *
 * Keys (the bot keeps them in users.<ex>_api_key / _api_secret / okx_passphrase): the site's
 * exchange_keys row of (user, exchange) — 'default' label first, then the newest, like
 * appSettingsService.exchangeKeys — each field decrypted on its own; a missing row, an empty or an
 * undecryptable field reads as '' with the bot's ERROR line (db/core._decrypt_key returns "" for a token
 * it cannot decrypt).
 * D5 (PLAN_M15 §1.6): an exchange outside AUTOTRADE_EXCHANGES reads as "no keys" (all '').
 * username = users.telegram_username ('' when unset — the bot's column default).
 */

const engineSchema = require('../../models/engineSchema');
const { createSignalTradesRepo, computeFallbackPnlUsd } = require('../engine/signalTradesRepo');
const { pyTruthy } = require('../exchanges/pyCompat');
const { pyUpper, pyStrip } = require('../../strategies/common/pyUnicode');
const { cancellableSleep } = require('./asyncio');   // asyncio.js requires only node:async_hooks (no cycle)

const TRADER_COLS = new Set(engineSchema.TRADER_SETTINGS_COLUMNS.map((c) => c[0]));
const KEY_EXCHANGES = Object.freeze(['bybit', 'bingx', 'binance', 'okx']);

// db/trades.py db_get_open_trades_all / db_get_all_stale_open_trades (the bot's SQL on signal_trades)
const OPEN_TRADES_ALL_SQL = "SELECT * FROM signal_trades WHERE result='' AND order_id!='' LIMIT 500";
const STALE_OPEN_TRADES_SQL = "SELECT * FROM signal_trades WHERE (result = '' OR result IS NULL) AND created_at < ? "
  // [GHOST-LIVE-TRADES 2026-10] FIX-5 (72 h, BE monitor) — only rows without an exchange order
  + "  AND (order_id = '' OR order_id IS NULL)";
// db/users.py db_get_all_users / db_get_active_users (users → trader_settings)
const ALL_USERS_SQL = 'SELECT * FROM trader_settings ORDER BY created_at DESC';
const ACTIVE_USERS_SQL = `SELECT * FROM trader_settings
                       WHERE (sub_plan='free'
                              OR (sub_status IN ('trial','active')
                                  AND sub_expires > ?))
                       AND (active=1 OR long_active=1 OR short_active=1
                            OR smc_long_active=1 OR smc_short_active=1
                            OR vol_long_active=1 OR vol_short_active=1)`;
const KEY_ROW_SQL = `SELECT api_key_encrypted, api_secret_encrypted, passphrase_encrypted FROM exchange_keys
  WHERE user_id = ? AND exchange = ?
  ORDER BY CASE WHEN label = 'default' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`;

const realSleep = (s) => new Promise((r) => { const h = setTimeout(r, Math.max(0, Number(s) || 0) * 1000); if (h && h.unref) h.unref(); });

// db/core._decrypt_key's ERROR for a token it cannot decrypt (verbatim; D23 keeps the bot's texts)
const DECRYPT_FAILED_LOG = '🔴 _decrypt_key: не удалось расшифровать Fernet-токен — '
  + 'BYBIT_FERNET_KEY мог смениться или повреждён. '
  + 'Пользователь должен заново ввести ключи через 🔑 Настроить Bybit API.';

/**
 * The exchange_keys reader of the M15 loops: (uid, ex) → [key, secret, passphrase (okx only)], each
 * field decrypted on its own — an undecryptable field reads as '' with the bot's ERROR line, an empty
 * one as '' — and no row → ['', '', ''].
 */
function exchangeKeysReader(dbOf, { encryptionKey = null, log = null } = {}) {
  const keyHex = () => (encryptionKey !== null ? encryptionKey : require('../../config').walletEncryptionKey);
  const logger = () => log || require('../marketData/mdLog').log;
  const dec = (v) => {
    if (!v) return '';
    try {
      return String(require('../../utils/crypto').decrypt(String(v), keyHex()));
    } catch (_e) {
      logger().error(DECRYPT_FAILED_LOG);
      return '';
    }
  };
  return (uid, ex) => {
    const row = dbOf().prepare(KEY_ROW_SQL).get(Number(uid), String(ex));
    if (!row) return ['', '', ''];
    return [dec(row.api_key_encrypted), dec(row.api_secret_encrypted), ex === 'okx' ? dec(row.passphrase_encrypted) : ''];
  };
}

/**
 * deps (all optional):
 *   exchanges       the D5 set the key columns are read for (default: AUTOTRADE_EXCHANGES of `env`)
 *   env             process.env by default
 *   keyReader       (uid, ex) → [key, secret, passphrase]  (default: exchangeKeysReader on this db)
 *   fromDb          user_manager._from_db (default: traderSettingsService.fromDb)
 *   sleep           asyncio.sleep(s) of db_get_active_users' retry — always wrapped in cancellableSleep
 *                   (injected or not): the back-off is a cancellation point like the bot's
 *                   `await asyncio.sleep(1 + attempt)` — a wait_for timeout / runInScope abort during it
 *                   raises at once and no further query runs (PLAN_M15 §1.4 / §1.5)
 */
function createTradeDb({
  db = null, now = () => Date.now() / 1000, log = null, repo = null, invalidateUserCache = null,
  exchanges = null, env = null, keyReader = null, fromDb = null, sleep = null,
} = {}) {
  /** the scanners' settings cache (traderSettingsService) after a users-row write */
  const invalidate = () => {
    try {
      if (invalidateUserCache) invalidateUserCache();
      else require('../traderSettingsService').invalidateCache();
    } catch (_e) { /* best effort */ }
  };
  const dbOf = () => (db ? db : require('../../models/database'));
  const logger = log || require('../marketData/mdLog').log;
  const trades = repo || createSignalTradesRepo({ db: db || undefined, now, log: logger });
  const pause = cancellableSleep(sleep || realSleep);

  // ── M15: keys / username / UserSettings of the loops' user reads ──
  let keyExSet = null;
  const keyExchanges = () => {
    if (!keyExSet) keyExSet = new Set(exchanges ? Array.from(exchanges) : Array.from(require('./index').enabledExchanges(env || process.env)));
    return keyExSet;
  };
  const readKeys = keyReader || exchangeKeysReader(dbOf, { log: logger });
  const userFromDb = (row) => (fromDb || require('../traderSettingsService').fromDb)(row);
  const usernameOf = (uid) => {
    try {
      const r = dbOf().prepare('SELECT telegram_username FROM users WHERE id = ?').get(Number(uid));
      return r && r.telegram_username !== null && r.telegram_username !== undefined ? String(r.telegram_username) : '';
    } catch (_e) {
      return '';
    }
  };
  /** The bot's users row: the trader_settings row + username + the nine decrypted key columns (D5-gated). */
  const withKeys = (row) => {
    const d = { ...row, username: usernameOf(row.user_id) };
    const enabled = keyExchanges();
    for (const ex of KEY_EXCHANGES) {
      const [k, sec, pp] = enabled.has(ex) ? readKeys(row.user_id, ex) : ['', '', ''];
      d[`${ex}_api_key`] = k || '';
      d[`${ex}_api_secret`] = sec || '';
      if (ex === 'okx') d.okx_passphrase = pp || '';
    }
    return d;
  };
  const USER_EXTRA = ['username', ...KEY_EXCHANGES.flatMap((ex) => [`${ex}_api_key`, `${ex}_api_secret`]), 'okx_passphrase'];
  /** _from_db(row) of a row with keys: the UserSettings coercions + the str fields kept outside trader_settings. */
  const settingsOf = (d) => {
    const u = userFromDb(d);
    for (const k of USER_EXTRA) u[k] = d[k] === null || d[k] === undefined ? '' : d[k];
    return u;
  };

  const api = {
    trades,
    computeFallbackPnlUsd,

    // ── M15 readers ────────────────────────────────────────────────────
    /** db_get_open_trades_all: every open exchange trade (≤ 500), in the partial index's order. */
    async getOpenTradesAll() {
      return dbOf().prepare(OPEN_TRADES_ALL_SQL).all();
    },

    /** db_get_all_stale_open_trades(cutoff_ts) — FIX-5, rows without an order only ([GHOST-LIVE-TRADES]). */
    async getAllStaleOpenTrades(cutoffTs) {
      return dbOf().prepare(STALE_OPEN_TRADES_SQL).all(cutoffTs);
    },

    /** db_get_user(uid) with the decrypted keys (D5-gated) and username; null without a row. */
    async getUserWithKeys(uid) {
      const row = dbOf().prepare('SELECT * FROM trader_settings WHERE user_id=?').get(Number(uid));
      return row ? withKeys(row) : null;
    },

    /** db_get_all_users: raw rows ORDER BY created_at DESC, each with its keys and username. */
    async getAllUsersOrdered() {
      return dbOf().prepare(ALL_USERS_SQL).all().map(withKeys);
    },

    /**
     * user_manager.get_active_auto_trade_users — the uncached db_get_active_users (3 attempts,
     * WARNING `db_get_active_users retry n/3: <e>` + sleep 1 + n between them, the 3rd error raises; the
     * sleep honours the cancel scope: CancelledError / the waitFor TimeoutError there, no further query),
     * _from_db, then `auto_trade and <key of trade_exchange>` (bingx / binance / okx, anything else bybit).
     */
    async getActiveAutoTradeUsers() {
      const t = now();
      let rows = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rows = dbOf().prepare(ACTIVE_USERS_SQL).all(t).map(withKeys);
          break;
        } catch (e) {
          if (attempt === 2) throw e;
          logger.warning(`db_get_active_users retry ${attempt + 1}/3: ${e && e.message !== undefined ? e.message : e}`);
          await pause(1 + attempt);
        }
      }
      const out = [];
      for (const r of rows) {
        const u = settingsOf(r);
        const exchange = u.trade_exchange === undefined ? 'bybit' : u.trade_exchange;
        let hasApi;
        if (exchange === 'bingx') hasApi = u.bingx_api_key;
        else if (exchange === 'binance') hasApi = u.binance_api_key;
        else if (exchange === 'okx') hasApi = u.okx_api_key;
        else hasApi = u.bybit_api_key;
        if (pyTruthy(u.auto_trade === undefined ? false : u.auto_trade) && pyTruthy(hasApi)) out.push(u);
      }
      return out;
    },

    async getUser(uid) {
      return dbOf().prepare('SELECT * FROM trader_settings WHERE user_id=?').get(Number(uid)) || null;
    },

    async getUserLang(uid) {
      try {
        const row = dbOf().prepare('SELECT lang FROM trader_settings WHERE user_id=?').get(Number(uid));
        if (row && (row.lang === 'ru' || row.lang === 'en')) return row.lang;
      } catch (e) {
        logger.debug(`db_get_user_lang uid=${uid}: ${e && e.message}`);
      }
      return 'ru';
    },

    /** db_upsert_user(data): INSERT … ON CONFLICT(user_id) DO UPDATE (bot SQL, site table). */
    async upsertUser(data) {
      const d = { ...data, updated_at: now() };
      if (d.created_at === undefined) d.created_at = now();
      const cols = Object.keys(d).filter((c) => c === 'user_id' || TRADER_COLS.has(c));
      const vals = cols.map((c) => (typeof d[c] === 'boolean' ? (d[c] ? 1 : 0) : d[c]));
      const updates = cols.filter((c) => c !== 'user_id' && c !== 'created_at').map((c) => `${c}=excluded.${c}`).join(', ');
      const sql = `INSERT INTO trader_settings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) `
        + `ON CONFLICT(user_id) DO UPDATE SET ${updates}`;
      dbOf().prepare(sql).run(...vals);
      invalidate();
    },

    async updatePropPeak(uid, currentBalance) {
      if (!(currentBalance > 0)) return;
      try {
        dbOf().prepare('UPDATE trader_settings SET prop_peak_balance = ? WHERE user_id = ? AND ? > COALESCE(prop_peak_balance, 0)')
          .run(currentBalance, Number(uid), currentBalance);
      } catch (e) {
        logger.debug(`db_update_prop_peak uid=${uid}: ${e && e.message}`);
      }
    },

    async setAutoTrade(uid, enabled) {
      dbOf().prepare('UPDATE trader_settings SET auto_trade=? WHERE user_id=?').run(enabled ? 1 : 0, Number(uid));
      invalidate();
    },

    async setTradeResult(tid, result, rr, opts = {}) {
      return trades.setTradeResult(tid, result, rr, opts);
    },

    async setTradeState(tid, state, opts = {}) {
      return trades.setTradeState(tid, state, opts);
    },

    /** db_update_trade_bybit: qty written only when given and > 0. */
    async updateTradeBybit(tid, orderId, posIdx, qty = null) {
      if (qty !== null && qty !== undefined && qty > 0) {
        dbOf().prepare('UPDATE signal_trades SET order_id=?, pos_idx=?, qty=? WHERE trade_id=?').run(orderId, posIdx, qty, String(tid));
      } else {
        dbOf().prepare('UPDATE signal_trades SET order_id=?, pos_idx=? WHERE trade_id=?').run(orderId, posIdx, String(tid));
      }
    },

    /** D17 (site): the exchange the order went to (the bot leaves trades.exchange empty → quick close reads bybit). */
    async updateTradeExchange(tid, exchange) {
      dbOf().prepare('UPDATE signal_trades SET exchange=? WHERE trade_id=?').run(String(exchange), String(tid));
    },

    async updateTradeTpPlaced(tid, value = 1) {
      dbOf().prepare('UPDATE signal_trades SET tp_placed=? WHERE trade_id=?').run(value, String(tid));
    },

    async hasOpenTradeForSymbol(uid, symbol) {
      return Boolean(dbOf().prepare("SELECT 1 FROM signal_trades WHERE user_id=? AND symbol=? AND result='' AND order_id != '' LIMIT 1")
        .get(Number(uid), symbol));
    },

    /**
     * D18 (site): the newest unresolved placement of (uid, symbol) since `sinceTs` — state PLACING,
     * no order id, result '' — other than `excludeTradeId` (→ its trade_id, else null). Only a process
     * that died mid-placement (or a failed SKIP write) leaves one; its order may be on the exchange.
     */
    async inflightPlacementForSymbol(uid, symbol, sinceTs, excludeTradeId = '') {
      const r = dbOf().prepare("SELECT trade_id FROM signal_trades WHERE user_id=? AND symbol=? AND result='' AND order_id='' "
        + "AND state='PLACING' AND state_changed_at >= ? AND trade_id != ? ORDER BY state_changed_at DESC LIMIT 1")
        .get(Number(uid), symbol, Number(sinceTs), String(excludeTradeId || ''));
      return r ? String(r.trade_id) : null;
    },

    /** D18: the row of `tid` already carries an exchange order id (it was placed). */
    async tradeHasOrder(tid) {
      const r = dbOf().prepare('SELECT order_id FROM signal_trades WHERE trade_id=?').get(String(tid));
      return Boolean(r && r.order_id);
    },

    /**
     * db_count_open_trades(user_id, exclude_trade_id="", direction=""): rows with an exchange order
     * and no result, without `excludeTradeId`; [SAME-DIR-CAP 2026-10] `direction` (LONG / SHORT, any
     * case) counts only that side — without it the SQL is the old one.
     */
    async countOpenTrades(uid, excludeTradeId = '', direction = '') {
      let sql = "SELECT COUNT(*) AS n FROM signal_trades WHERE user_id=? AND result='' AND order_id!=''";
      const params = [Number(uid)];
      if (excludeTradeId) {
        sql += ' AND trade_id!=?';
        params.push(String(excludeTradeId));
      }
      if (direction) {
        sql += " AND UPPER(COALESCE(direction, ''))=?";
        params.push(pyUpper(pyStrip(String(direction))));
      }
      const row = dbOf().prepare(sql).get(...params);
      return row ? row.n : 0;
    },

    async getAllOpenTrades(uid) {
      return dbOf().prepare("SELECT * FROM signal_trades WHERE user_id=? AND result=''").all(Number(uid));
    },

    async getRecentSlCount(uid, hours = 24) {
      const cutoff = now() - Number(hours) * 3600.0;
      try {
        const row = dbOf().prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE user_id = ? AND result = 'SL' AND created_at >= ?").get(Number(uid), cutoff);
        return row ? row.n : 0;
      } catch (e) {
        logger.debug(`db_get_recent_sl_count uid=${uid}: ${e && e.message}`);
        return 0;
      }
    },

    /** Sum of negative result_rr since the UTC midnight of now() (calendar.timegm of utcnow's date). */
    async getTodayLossRr(uid) {
      const t = now();
      const d = new Date(Math.floor(t * 1000));
      const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000;
      try {
        const row = dbOf().prepare(`
          SELECT COALESCE(SUM(result_rr), 0.0) AS s
          FROM signal_trades
          WHERE user_id = ?
            AND result NOT IN ('', 'SKIP')
            AND result_rr < 0
            AND created_at >= ?
        `).get(Number(uid), midnight);
        return row ? Number(row.s) : 0.0;
      } catch (e) {
        logger.debug(`db_get_today_loss_rr uid=${uid}: ${e && e.message}`);
        return 0.0;
      }
    },

    async exec(sql, params = []) {
      dbOf().prepare(sql).run(...params);
    },

    // ── kv (engine_kv) ─────────────────────────────────────────────────
    async kvGet(key) {
      const row = dbOf().prepare('SELECT value FROM engine_kv WHERE key = ?').get(String(key));
      return row ? row.value : null;
    },
    async kvSet(key, value) {
      dbOf().prepare(`INSERT INTO engine_kv (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(String(key), String(value), now());
    },
    async kvKeysWithPrefix(prefix) {
      if (!prefix) return [];
      return dbOf().prepare('SELECT key FROM engine_kv WHERE key LIKE ?').all(prefix + '%').map((r) => r.key).filter(Boolean);
    },
    async kvItemsWithPrefix(prefix) {
      if (!prefix) return [];
      return dbOf().prepare('SELECT key, value FROM engine_kv WHERE key LIKE ?').all(prefix + '%').filter((r) => r.key).map((r) => [r.key, r.value]);
    },

    /** db.trade_events.emit_bg — never raises. */
    addTradeEvent(tid, type, payload, opts = {}) {
      try {
        return trades.addTradeEvent(tid, type, payload, opts);
      } catch (e) {
        logger.debug(`[EVT-EMIT-SKIP] ${type}: ${e && e.message}`);
        return false;
      }
    },
  };
  return api;
}

module.exports = {
  createTradeDb, exchangeKeysReader, computeFallbackPnlUsd, KEY_EXCHANGES, DECRYPT_FAILED_LOG,
  OPEN_TRADES_ALL_SQL, STALE_OPEN_TRADES_SQL, ALL_USERS_SQL, ACTIVE_USERS_SQL,
};
