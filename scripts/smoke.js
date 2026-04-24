#!/usr/bin/env node
/**
 * End-to-end smoke test against a running CHM backend.
 *
 * Usage:
 *   node scripts/smoke.js                       # local (http://localhost:3000)
 *   SMOKE_URL=https://chmup.top node scripts/smoke.js
 *   SMOKE_URL=https://chmup.top SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/smoke.js
 *
 * When run without SMOKE_EMAIL, a throw-away user is registered on every
 * run (email = "smoke-<ts>-<rand>@example.com"). Doesn't clean up since
 * these rows are useful for the daily ops digest counts.
 *
 * Exits with code 0 on full pass; non-zero per failure count. Designed to
 * be wired into a 5-minute cron; pipe output to a logfile.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

const BASE = (process.env.SMOKE_URL || 'http://localhost:3000').replace(/\/$/, '');
const EMAIL_OVERRIDE = process.env.SMOKE_EMAIL;
const PASSWORD_OVERRIDE = process.env.SMOKE_PASSWORD;
const STRICT = process.env.SMOKE_STRICT === '1';

let PASS = 0, FAIL = 0;
const FAILURES = [];

function log(level, msg) { console.log('[' + new Date().toISOString() + '] ' + level + ' ' + msg); }

function check(name, cond, extra = '') {
  if (cond) { PASS += 1; log('OK ', name); return true; }
  FAIL += 1; FAILURES.push(name); log('ERR', name + (extra ? ' — ' + extra : ''));
  return false;
}

function req(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? JSON.stringify(body) : null;
    const r = lib.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      timeout: 10_000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch (_e) {}
        resolve({ status: res.statusCode, body: json, raw: buf });
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  log('---', 'smoke · BASE=' + BASE + ' · strict=' + STRICT);

  // 1. Health liveness
  const h = await req('GET', '/api/health').catch((e) => ({ status: 0, err: e.message }));
  check('GET /api/health', h.status === 200 && h.body && h.body.status === 'ok', 'got ' + h.status);

  // 2. Deep health — now reports migration version + backtest queue + outbox.
  const hd = await req('GET', '/api/health/deep').catch((e) => ({ status: 0, err: e.message }));
  check('GET /api/health/deep', hd.status === 200 || hd.status === 503, 'got ' + hd.status);
  const subs = (hd.body && hd.body.subsystems) || {};
  check('  db subsystem ok', subs.database && subs.database.ok);
  // Required migration level — bump this when a new migration lands that
  // the rest of the smoke suite depends on (e.g. email_outbox is v7).
  const MIN_MIG = 7;
  check(
    '  migrations at v' + MIN_MIG + '+',
    subs.migrations && subs.migrations.ok && subs.migrations.version >= MIN_MIG,
    'got v' + (subs.migrations && subs.migrations.version),
  );
  check('  backtest queue sane (<50 pending)', subs.backtestQueue && subs.backtestQueue.ok, JSON.stringify(subs.backtestQueue));
  check('  email outbox sane', subs.emailOutbox && subs.emailOutbox.ok !== false, JSON.stringify(subs.emailOutbox));
  // SMTP is non-blocking — we warn but don't fail, since dev envs run
  // in log-only mode. Prod smoke should set SMOKE_STRICT=1 to fail here.
  if (subs.smtp && !subs.smtp.configured) {
    log('WARN', '  SMTP not configured — durable emails stuck in outbox');
    if (STRICT) { FAIL += 1; FAILURES.push('smtp not configured'); }
  } else {
    check('  SMTP configured', subs.smtp && subs.smtp.configured);
  }

  // 3. Public leaderboard
  const lb = await req('GET', '/api/public/leaderboard?period=30d&sort=pnl&limit=5');
  check('GET /api/public/leaderboard', lb.status === 200 && Array.isArray(lb.body && lb.body.traders));

  // 4. Auth flow — register (or reuse if override provided)
  const email = EMAIL_OVERRIDE || 'smoke-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '@example.com';
  const password = PASSWORD_OVERRIDE || 'SmokePass123!';
  let access;
  if (EMAIL_OVERRIDE) {
    const lg = await req('POST', '/api/auth/login', { body: { email, password } });
    check('POST /api/auth/login (override)', lg.status === 200 && lg.body && lg.body.accessToken);
    access = lg.body && lg.body.accessToken;
  } else {
    const reg = await req('POST', '/api/auth/register', { body: { email, password } });
    check('POST /api/auth/register', reg.status === 200 || reg.status === 201, JSON.stringify(reg.body || {}).slice(0, 200));
    access = reg.body && reg.body.accessToken;
  }
  if (!access) { log('ERR', 'no access token — skipping authed checks'); return finish(); }

  // 5. /auth/me
  const me = await req('GET', '/api/auth/me', { token: access });
  check('GET /api/auth/me', me.status === 200 && me.body && me.body.user && me.body.user.email);

  // 6. Create paper bot (no exchange key needed). On a fresh user without
  // SMTP we won't be email-verified, and requireVerifiedEmail will block —
  // which is correct enforcement. Treat it as a skip, not a failure, and
  // surface the signal with a warning so the caller sets SMOKE_EMAIL to a
  // pre-verified account for full-coverage prod smoke.
  const botBody = {
    name: 'smoke-' + Date.now(),
    exchange: 'bybit', symbols: ['BTCUSDT'],
    strategy: 'smc', timeframe: '1h',
    tradingMode: 'paper', autoTrade: false,
  };
  const bc = await req('POST', '/api/bots', { token: access, body: botBody });
  let botId = null;
  if (bc.status === 403 && bc.body && bc.body.code === 'EMAIL_NOT_VERIFIED') {
    log('WARN', 'POST /api/bots skipped — user not email-verified (expected for fresh register). Set SMOKE_EMAIL to a pre-verified account for full coverage.');
  } else {
    check('POST /api/bots (paper)', bc.status === 200 || bc.status === 201, JSON.stringify(bc.body || {}).slice(0, 200));
    botId = bc.body && bc.body.id;
  }

  // 7. List bots
  const bl = await req('GET', '/api/bots', { token: access });
  check('GET /api/bots', bl.status === 200 && bl.body && Array.isArray(bl.body.bots));

  // 8. Dashboard reads
  const analytics = await req('GET', '/api/analytics/summary', { token: access });
  check('GET /api/analytics/summary', analytics.status === 200);

  // 9. Signals (free-tier rate cap 30/min should pass a single call)
  const sig = await req('GET', '/api/signals?limit=5', { token: access });
  check('GET /api/signals', sig.status === 200 && sig.body && Array.isArray(sig.body.signals || sig.body));

  // Phase 1/2 drawer endpoints — paper bot so no exchange keys required.
  if (botId) {
    const stats = await req('GET', '/api/bots/' + botId + '/stats', { token: access });
    check('GET /api/bots/:id/stats', stats.status === 200 && stats.body);

    const equity = await req('GET', '/api/bots/' + botId + '/equity', { token: access });
    check('GET /api/bots/:id/equity', equity.status === 200 && equity.body && Array.isArray(equity.body.points));

    // Phase 2: PATCH /:id should accept the drawer's subset of fields.
    const patch = await req('PATCH', '/api/bots/' + botId, {
      token: access,
      body: { riskPct: 1.5, leverage: 5, maxOpenTrades: 2, direction: 'long' },
    });
    check('PATCH /api/bots/:id (drawer settings)', patch.status === 200 && patch.body && patch.body.riskPct === 1.5);
  }

  // 11. Quick-backtest pipeline — enqueues a real backtest and polls for
  // completion. This is the flow the drawer's "Прогнать" button hits.
  // Free plan has 0 backtests/day — that's correct gating, not a bug, so
  // we skip the polling step when gated. Prod smoke should use SMOKE_EMAIL
  // pointed at a Pro+ account.
  const qbt = await req('POST', '/api/bots/quick-backtest', {
    token: access,
    body: { symbol: 'BTCUSDT', strategy: 'smc', timeframe: '1h', exchange: 'bybit', days: 14 },
  });
  if (qbt.status === 403 && qbt.body && qbt.body.code === 'BACKTEST_LIMIT_REACHED') {
    log('WARN', 'quick-backtest skipped — free plan is gated (0/day). Set SMOKE_EMAIL to a Pro+ account for full coverage.');
    return finish();
  }
  check('POST /api/bots/quick-backtest', qbt.status === 200 || qbt.status === 201, JSON.stringify(qbt.body || {}).slice(0, 200));
  const qbtId = qbt.body && qbt.body.id;
  if (qbtId) {
    let final = null;
    for (let i = 0; i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
      // eslint-disable-next-line no-await-in-loop
      const poll = await req('GET', '/api/backtests/' + qbtId, { token: access });
      if (poll.status !== 200) continue;
      if (poll.body && (poll.body.status === 'completed' || poll.body.status === 'failed')) {
        final = poll.body; break;
      }
    }
    check('backtest reached terminal state', final !== null, 'polling timed out');
    check('backtest completed (not failed)', final && final.status === 'completed', final && final.errorMessage);
    // Cleanup so ops dashboard count doesn't keep climbing
    await req('DELETE', '/api/backtests/' + qbtId, { token: access });
  }

  // 12. Cleanup — best-effort delete the bot so smoke rows don't pile up.
  if (botId) {
    const del = await req('DELETE', '/api/bots/' + botId, { token: access });
    check('DELETE /api/bots/:id', del.status === 200);
  }

  finish();
}

function finish() {
  const total = PASS + FAIL;
  log('---', 'done · ' + PASS + '/' + total + ' passed, ' + FAIL + ' failed');
  if (FAIL > 0) {
    log('ERR', 'failures: ' + FAILURES.join(', '));
    process.exit(STRICT ? Math.min(FAIL, 127) : 1);
  }
  process.exit(0);
}

main().catch((e) => { log('ERR', 'smoke crashed: ' + (e && e.stack || e)); process.exit(2); });
