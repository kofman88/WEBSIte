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
 *   updateTradeTpPlaced(tid, v)           db_update_trade_tp_placed
 *   hasOpenTradeForSymbol(uid, sym)       db_has_open_trade_for_symbol
 *   countOpenTrades(uid, excludeTid)      db_count_open_trades
 *   getAllOpenTrades(uid)                 db_get_all_open_trades
 *   getRecentSlCount(uid, hours)          db_get_recent_sl_count
 *   getTodayLossRr(uid)                   db_get_today_loss_rr
 *   exec(sql, params)                     db_exec (UPDATE trades SET ai_filter_json=…)
 *   kvGet / kvSet / kvKeysWithPrefix / kvItemsWithPrefix   db/misc.py
 *   addTradeEvent(tid, type, payload)     db.trade_events.emit_bg (best effort)
 */

const engineSchema = require('../../models/engineSchema');
const { createSignalTradesRepo } = require('../engine/signalTradesRepo');

const TRADER_COLS = new Set(engineSchema.TRADER_SETTINGS_COLUMNS.map((c) => c[0]));

function createTradeDb({ db = null, now = () => Date.now() / 1000, log = null, repo = null, invalidateUserCache = null } = {}) {
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

  const api = {
    trades,

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

    async updateTradeTpPlaced(tid, value = 1) {
      dbOf().prepare('UPDATE signal_trades SET tp_placed=? WHERE trade_id=?').run(value, String(tid));
    },

    async hasOpenTradeForSymbol(uid, symbol) {
      return Boolean(dbOf().prepare("SELECT 1 FROM signal_trades WHERE user_id=? AND symbol=? AND result='' AND order_id != '' LIMIT 1")
        .get(Number(uid), symbol));
    },

    async countOpenTrades(uid, excludeTradeId = '') {
      const row = excludeTradeId
        ? dbOf().prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE user_id=? AND result='' AND order_id!='' AND trade_id!=?").get(Number(uid), String(excludeTradeId))
        : dbOf().prepare("SELECT COUNT(*) AS n FROM signal_trades WHERE user_id=? AND result='' AND order_id!=''").get(Number(uid));
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

module.exports = { createTradeDb };
