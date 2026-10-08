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

  // 2. Deep health — reports migration version + email outbox + SMTP.
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
  check('  email outbox sane', subs.emailOutbox && subs.emailOutbox.ok !== false, JSON.stringify(subs.emailOutbox));
  // SMTP is non-blocking — we warn but don't fail, since dev envs run
  // in log-only mode. Prod smoke should set SMOKE_STRICT=1 to fail here.
  if (subs.smtp && !subs.smtp.configured) {
    log('WARN', '  SMTP not configured — durable emails stuck in outbox');
    if (STRICT) { FAIL += 1; FAILURES.push('smtp not configured'); }
  } else {
    check('  SMTP configured', subs.smtp && subs.smtp.configured);
  }

  // 3. Auth flow — register (or reuse if override provided)
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

  // 4. /auth/me
  const me = await req('GET', '/api/auth/me', { token: access });
  check('GET /api/auth/me', me.status === 200 && me.body && me.body.user && me.body.user.email);

  // 5. Plan usage snapshot (powers the plan pill in the shell)
  const usage = await req('GET', '/api/subscriptions/usage', { token: access });
  check('GET /api/subscriptions/usage', usage.status === 200 && usage.body && usage.body.plan && usage.body.usage);

  // 6. Engine endpoints (/api/app/*) join the smoke suite from M7 onward.
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
