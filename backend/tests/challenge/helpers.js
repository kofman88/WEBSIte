/**
 * Shared setup for the DB-backed challenge tests: a fresh SQLite file per test file,
 * site users with the bot's ids (signal_trades / trader_settings reference users.id) and the
 * seeded signal_trades rows of the Python generator.
 */
import fs from 'fs';
import path from 'path';

export const FIXTURE = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'challenge', 'fixtures', 'challenge_vectors.json'), 'utf8'));

/** Must run before the first require of models/database. */
export function setupEnv(name) {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
  process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.DATABASE_PATH = path.join(process.cwd(), 'data', `test-challenge-${name}.db`);
  process.env.DB_QUIET = '1';
  process.env.LOG_LEVEL = 'error';
  process.env.VITEST = 'true';
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* absent */ } });
}

export function insertUser(db, id, { isAdmin = 0, locale = 'ru' } = {}) {
  db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, referral_code, is_admin, locale) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `u${id}@x.test`, 'x', `R${id}`, isAdmin, locale);
}

let _seq = 0;
/** INSERT a bot `trades` row into signal_trades (columns = the row's keys, like the generator). */
export function insertTrade(db, row) {
  const r = { ...row };
  if (!r.trade_id) { _seq += 1; r.trade_id = `js${_seq}`; }
  const cols = Object.keys(r).sort();
  db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map((c) => (typeof r[c] === 'boolean' ? (r[c] ? 1 : 0) : r[c])));
}

export const quietLog = { info() {}, warn() {}, debug() {}, error() {} };

/** Collects log lines (for the marker assertions). */
export function captureLog() {
  const lines = [];
  const rec = (lvl) => (m) => lines.push(`${lvl} ${m}`);
  return { lines, info: rec('info'), warn: rec('warn'), debug: rec('debug'), error: rec('error') };
}

export const BASE = Object.freeze({
  deposit: 1000, goal_kind: 'pct', goal_value: 25, term: '1m', risk_pct: 1, leverage: 5, max_trades_day: 3,
  daily_loss_pct: 3, topup_monthly: 0, strategies: ['LEVELS'], mode: 'signals',
});

export const USER_FIELDS = Object.freeze(['trade_risk_pct', 'trade_leverage', 'auto_trade', 'strategy', 'extra_strategies',
  'long_active', 'short_active', 'smc_long_active', 'smc_short_active', 'vol_long_active', 'vol_short_active',
  'active', 'scan_mode']);

export const pickFields = (u) => Object.fromEntries(USER_FIELDS.map((k) => [k, u[k]]));
export const norm = (x) => JSON.parse(JSON.stringify(x));
