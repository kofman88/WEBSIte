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

  // 2. Deep health
  const hd = await req('GET', '/api/health/deep').catch((e) => ({ status: 0, err: e.message }));
  check('GET /api/health/deep', hd.status === 200 || hd.status === 503, 'got ' + hd.status);
  check('  db subsystem ok', hd.body && hd.body.subsystems && hd.body.subsystems.database && hd.body.subsystems.database.ok);

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

  // 6. Create paper bot (no exchange key needed)
  const botBody = {
    name: 'smoke-' + Date.now(),
    exchange: 'bybit', symbols: ['BTCUSDT'],
    strategy: 'smc', timeframe: '1h',
    tradingMode: 'paper', autoTrade: false,
  };
  const bc = await req('POST', '/api/bots', { token: access, body: botBody });
  check('POST /api/bots (paper)', bc.status === 200 || bc.status === 201, JSON.stringify(bc.body || {}).slice(0, 200));
  const botId = bc.body && bc.body.id;

  // 7. List bots
  const bl = await req('GET', '/api/bots', { token: access });
  check('GET /api/bots', bl.status === 200 && bl.body && Array.isArray(bl.body.bots));

  // 8. Dashboard reads
  const analytics = await req('GET', '/api/analytics/summary', { token: access });
  check('GET /api/analytics/summary', analytics.status === 200);

  // 9. Signals (free-tier rate cap 30/min should pass a single call)
  const sig = await req('GET', '/api/signals?limit=5', { token: access });
  check('GET /api/signals', sig.status === 200 && sig.body && Array.isArray(sig.body.signals || sig.body));

  // 10. Cleanup — best-effort delete the bot so smoke rows don't pile up.
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
