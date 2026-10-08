'use strict';
/**
 * Test helpers: an in-memory SQLite with the site's engine schema (users stub +
 * trader_settings + signal_trades + engine_kv + notifications stub), seeded with the rows
 * the Python generators inserted into the bot's `users` / `trades`.
 */

const Database = require('better-sqlite3');
const schema = require('../../../models/engineSchema');

function engineDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT, is_active INTEGER DEFAULT 1,
                        locale TEXT DEFAULT 'ru', is_admin INTEGER DEFAULT 0);
    CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, type TEXT NOT NULL,
                                title TEXT NOT NULL, body TEXT, link TEXT, read_at DATETIME,
                                created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  `);
  db.exec(schema.traderSettingsDDL());
  db.exec(schema.signalTradesDDL());
  db.exec(schema.ENGINE_KV_DDL);
  return db;
}

/** users [[uid, plan], …] → users + trader_settings rows. */
function seedUsers(db, users, extra = {}) {
  const insU = db.prepare('INSERT OR IGNORE INTO users (id, email) VALUES (?, ?)');
  for (const [uid, plan] of users) {
    insU.run(uid, `u${uid}@x`);
    const cols = { user_id: uid, sub_plan: plan, ...(extra[uid] || {}) };
    const names = Object.keys(cols);
    db.prepare(`INSERT OR REPLACE INTO trader_settings (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...names.map((n) => (typeof cols[n] === 'boolean' ? (cols[n] ? 1 : 0) : cols[n])));
  }
}

/** trades (the generator's dicts, in its insertion order) → signal_trades. */
function seedTrades(db, trades, cols) {
  const stmt = db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const r of trades) stmt.run(...cols.map((c) => (r[c] === undefined ? null : r[c])));
}

module.exports = { engineDb, seedUsers, seedTrades };
