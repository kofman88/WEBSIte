'use strict';
/**
 * Test helpers for the public track: an in-memory engine DB (tests/engine/stats/helpers.js),
 * signal_trades rows as the scanners write them, a service instance on a fake clock.
 */

const { engineDb, seedUsers } = require('../engine/stats/helpers');
const { createPublicTrack } = require('../../services/publicTrack');

const T0 = 1_760_000_000;          // 2025-10-09 08:53:20 UTC
const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

function makeDb(users = [[7, 'pro'], [8, 'pro'], [9, 'free']]) {
  const db = engineDb();
  seedUsers(db, users);
  return db;
}

let _n = 0;
/** One delivered paper signal (LONG 100 → SL 98 → TP 103 / 105 / 108 unless overridden). */
function insertSignal(db, over = {}) {
  _n += 1;
  const row = {
    trade_id: `${over.user_id || 7}_${(over.created_at || T0) * 1000}_${100 + (_n % 900)}`,
    user_id: 7, symbol: 'BTC-USDT-SWAP', direction: 'LONG', entry: 100, sl: 98, original_sl: 98,
    tp1: 103, tp2: 105, tp3: 108, timeframe: '1h', strategy: 'LEVELS', created_at: T0,
    signal_msg_id: 1000 + _n, progress_stage: '', progress_ts: 0, order_id: '', result: '', expire_rr: null,
    exchange: 'bybit', quality: 7,
    ...over,
  };
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
  return row;
}

function setStage(db, tradeId, stage, ts, extra = {}) {
  const sets = { progress_stage: stage, progress_ts: ts, ...extra };
  const cols = Object.keys(sets);
  db.prepare(`UPDATE signal_trades SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE trade_id = ?`).run(...cols.map((c) => sets[c]), tradeId);
}

/** A track on `db` whose clock is clock.t (unix s). */
function makeTrack(db, clock, env = {}) {
  return createPublicTrack({
    db, now: () => clock.t, log: quietLog,
    env: { PUBLIC_TRACK_USER_IDS: '7,8:alts', JWT_SECRET: 'test-secret-for-public-ids-0123456789', ...env },
    trend: { compute: async () => ({ empty: true, reason: 'test' }) },
  });
}

const body = (packed) => JSON.parse(packed.body);

module.exports = { T0, quietLog, makeDb, insertSignal, setStage, makeTrack, body };
