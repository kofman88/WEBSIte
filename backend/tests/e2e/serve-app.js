#!/usr/bin/env node
'use strict';
/**
 * The REAL site (backend/server.js) on a seeded scratch DB, for the Playwright smoke of the web app
 * (tests/e2e/app_real_smoke.mjs) and for manual QA — unlike serve-stub.js, every /api/app answer here
 * comes from the production routes, services and DB code.
 *
 *   node backend/tests/e2e/serve-app.js --port 3198 --dir /tmp/chm-smoke
 *     → http://127.0.0.1:3198/app/   login smoke@chm.local / smoke-pass-123
 *
 * Mode: NODE_ENV=production (helmet CSP, the /api limiter, audit triggers as deployed),
 * ENGINE_WORKER=0, maintenance / security monitor off, a fresh SQLite file in --dir, the frontend
 * served from this checkout (HOME=<dir>/home with public_html → frontend/). No network: the market
 * reads of the app routes (REST candles, 24 h tickers) are answered from the golden candles
 * (tests/golden/candles) cut at MARKET_CUT (a close where AUTO analysis finds a BTC / ETH setup)
 * and shifted by whole days to the last such close before now, so every run sees the same market.
 *
 * Seed: one Pro user (LEVELS long + short, SMC long) with four delivered signals (BTC open, ETH at
 * TP1, BTC stopped, ETH TP3) whose cards are notification rows, like the engine leaves them.
 * --admin (the CSP page probe, tests/e2e/csp_pages_probe.mjs) also seeds admin@chm.local (same
 * password, is_admin) and marks both e-mails verified, so the legacy pages (settings / admin / ops)
 * render instead of redirecting to the e-mail check.
 *
 * stdin commands (one per line), answered on stdout:
 *   new-signal   a new delivered BTC signal (row + `signal` notification → SSE `notification` + `signal`)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const PORT = Number(arg('port', '3198'));
const DIR = path.resolve(arg('dir', path.join(os.tmpdir(), 'chm-app-smoke')));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const EMAIL = 'smoke@chm.local';
const PASSWORD = 'smoke-pass-123';
const ADMIN_EMAIL = 'admin@chm.local';
const WITH_ADMIN = args.includes('--admin');

// ── environment (before anything reads config / the DB) ──────────────────
fs.mkdirSync(path.join(DIR, 'home'), { recursive: true });
const pub = path.join(DIR, 'home', 'public_html');
try { fs.rmSync(pub, { force: true, recursive: false }); } catch (_e) { /* absent */ }
fs.symlinkSync(path.join(ROOT, 'frontend'), pub, 'dir');
const dbPath = path.join(DIR, 'smoke.db');
for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + ext); } catch (_e) { /* absent */ } }
Object.assign(process.env, {
  NODE_ENV: 'production',
  PORT: String(PORT),
  HOME: path.join(DIR, 'home'),
  DATABASE_PATH: dbPath,
  JWT_SECRET: 'smoke_jwt_secret_that_is_at_least_32_chars_long',
  JWT_REFRESH_SECRET: 'smoke_refresh_secret_that_is_at_least_32_chars',
  WALLET_ENCRYPTION_KEY: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  CORS_ORIGIN: `http://127.0.0.1:${PORT}`,
  ENGINE_WORKER: '0',
  MAINTENANCE_DISABLED: '1',
  SECURITY_MONITOR_DISABLED: '1',
  LOG_LEVEL: process.env.SMOKE_LOG_LEVEL || 'warn',
  DB_QUIET: '1',
});
delete process.env.VITEST;
for (const k of ['SMTP_HOST', 'SMTP_USER', 'TELEGRAM_BOT_TOKEN', 'SENTRY_DSN', 'STRIPE_SECRET_KEY', 'PUBLIC_TRACK_USER_IDS']) delete process.env[k];

// ── golden candles as the exchange (shifted by whole days to end at the latest close) ──
const { Frame } = require('../../strategies/common/frame');
const TF_FILE = { '15m': '15m', '1h': '1h', '1H': '1h', '4h': '4h', '4H': '4h', '1d': '1d', '1D': '1d' };
const TF_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const DAY = 86_400_000;
const golden = {};
for (const sym of ['BTC-USDT-SWAP', 'ETH-USDT-SWAP']) {
  golden[sym] = {};
  for (const f of ['15m', '1h', '4h', '1d']) {
    golden[sym][f] = JSON.parse(fs.readFileSync(path.join(ROOT, 'backend', 'tests', 'golden', 'candles', `${sym}_${f}.json`), 'utf8')).bars;
  }
}
// the market stands still at this golden close (2025-12-30 12:00 UTC: AUTO analysis gives BTC and ETH setups)
const MARKET_CUT = Date.parse('2025-12-30T12:00:00Z');
const SHIFT = Math.floor((Date.now() - MARKET_CUT) / DAY) * DAY;
const MARKET_NOW = (MARKET_CUT + SHIFT) / 1000;            // the last close the fake exchange has (≤ now)
const shifted = (sym, f) => golden[sym][f].filter((b) => b[0] + TF_MS[f] <= MARKET_CUT).map((b) => [b[0] + SHIFT, b[1], b[2], b[3], b[4], b[5]]);
function symOf(s) {
  const u = String(s || '').toUpperCase();
  if (u.startsWith('BTC')) return 'BTC-USDT-SWAP';
  if (u.startsWith('ETH')) return 'ETH-USDT-SWAP';
  return null;
}
const rest = {
  async getCandles(symbol, tf, limit = 300) {
    const sym = symOf(symbol);
    const f = TF_FILE[tf];
    if (!sym || !f) return null;
    const bars = shifted(sym, f).slice(-Math.max(1, Number(limit) || 300));
    return bars.length ? Frame.fromBars(bars) : null;
  },
  async get24hChange(symbol) {
    const sym = symOf(symbol);
    if (!sym) return null;
    const b = shifted(sym, '1h');
    const last = b[b.length - 1][4];
    const prev = b[b.length - 25][4];
    return { last, change_pct: ((last - prev) / prev) * 100 };
  },
};
/** close of the 1h bar that closed at or before t (unix s). */
function closeAt(sym, t) {
  const b = shifted(sym, '1h').filter((x) => x[0] + 3_600_000 <= t * 1000);
  return b[b.length - 1][4];
}

// ── seed ─────────────────────────────────────────────────────────────────
async function seed() {
  const db = require('../../models/database');
  const authService = require('../../services/authService');
  const planService = require('../../services/planService');
  const ts = require('../../services/traderSettingsService');
  const notifier = require('../../services/notifier');
  const reg = await authService.register({ email: EMAIL, password: PASSWORD, displayName: 'Smoke Trader' });
  const uid = Number((reg && reg.user && reg.user.id) || db.prepare('SELECT id FROM users WHERE email = ?').get(EMAIL).id);
  planService.grantAccess(uid, 30, { plan: 'pro', actor: 'smoke', reason: 'Playwright smoke' });
  const u = ts.getOrCreate(uid);
  Object.assign(u, { strategy: 'LEVELS', active: true, long_active: true, short_active: true, smc_long_active: true, onboarding_done: true });
  ts.save(u);
  if (WITH_ADMIN) {
    await authService.register({ email: ADMIN_EMAIL, password: PASSWORD, displayName: 'Smoke Admin' });
    db.prepare("UPDATE users SET is_admin = 1, admin_role = 'superadmin' WHERE email = ?").run(ADMIN_EMAIL);
    db.prepare('UPDATE users SET email_verified = 1 WHERE email IN (?, ?)').run(EMAIL, ADMIN_EMAIL);
  }

  const top = MARKET_NOW;
  let n = 0;
  async function deliver({ sym, dir, ageH, stage = '', result = '', resultRr = null, strategy = 'LEVELS', tf = '1h' }) {
    n += 1;
    const created = ageH > 0 ? top - ageH * 3600 + 7 : Math.floor(Date.now() / 1000) - 5;
    const entry = closeAt(sym, created);
    const k = dir === 'LONG' ? 1 : -1;
    const row = {
      trade_id: `${uid}_${Math.round(created * 1000)}_${100 + n}`, user_id: uid, symbol: sym, direction: dir,
      entry, sl: entry * (1 - 0.01 * k), original_sl: entry * (1 - 0.01 * k),
      tp1: entry * (1 + 0.015 * k), tp2: entry * (1 + 0.03 * k), tp3: entry * (1 + 0.045 * k),
      tp1_rr: 1.5, tp2_rr: 3.0, tp3_rr: 4.5, created_at: created, strategy, timeframe: tf, quality: 7,
      progress_stage: stage, progress_ts: stage ? created + 3 * 3600 : 0, result, result_rr: resultRr,
    };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]));
    const base = sym.split('-')[0];
    const html = `<b>${base} ${dir}</b>\nВход ${entry}`;
    const d = await notifier.dispatch(uid, { type: 'signal', title: `${base} ${dir}`, body: html, link: `/app/?tab=signals&id=${encodeURIComponent(row.trade_id)}` });
    db.prepare('UPDATE signal_trades SET signal_msg_id = ?, signal_card_json = ? WHERE trade_id = ?')
      .run(d.notificationId, JSON.stringify({ html, actions: [], lang: 'ru' }), row.trade_id);
    return row.trade_id;
  }
  await deliver({ sym: 'ETH-USDT-SWAP', dir: 'LONG', ageH: 50, stage: 'TP3', result: 'TP3', resultRr: 4.5 });
  await deliver({ sym: 'BTC-USDT-SWAP', dir: 'SHORT', ageH: 30, stage: 'SL', result: 'SL', resultRr: -1 });
  await deliver({ sym: 'ETH-USDT-SWAP', dir: 'SHORT', ageH: 10, stage: 'TP1' });
  await deliver({ sym: 'BTC-USDT-SWAP', dir: 'LONG', ageH: 2 });
  return { uid, deliver };
}

(async () => {
  const S = await seed();
  require('../../routes/appData').configure({ rest });
  require('../../server');                     // listens on PORT (production mode, not a test env)
  process.stdout.write(`serve-app ready http://127.0.0.1:${PORT}/app/ uid=${S.uid}\n`);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (cmd === 'new-signal') {
        const id = await S.deliver({ sym: 'BTC-USDT-SWAP', dir: 'SHORT', ageH: 0 });
        process.stdout.write(`new-signal ok ${id}\n`);
      } else if (cmd) {
        process.stdout.write(`unknown ${cmd}\n`);
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
})().catch((e) => {
  process.stderr.write(`serve-app failed: ${e && e.stack}\n`);
  process.exit(1);
});
