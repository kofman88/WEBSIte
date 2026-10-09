#!/usr/bin/env node
/**
 * Playwright smoke of the web app (frontend/app) against the REAL backend (tests/e2e/serve-app.js:
 * server.js in production mode on a seeded scratch DB, golden candles as the exchange, no network).
 *
 *   node backend/tests/e2e/app_real_smoke.mjs [--chromium /opt/pw-browsers/chromium] [--shots DIR] [--dir DIR]
 *
 * playwright-core is not a dependency of the backend: the script loads it from $PLAYWRIGHT_CORE
 * (default /opt/node-tools/node_modules/playwright-core) and drives an existing Chromium
 * ($CHROMIUM, default /opt/pw-browsers/chromium) — it never downloads a browser.
 *
 * Steps (390×844 phone viewport): login screen → wrong password → login (JWT) → Home → the SSE
 * stream GET /api/app/events opens with the Bearer token → Signals list → a new delivered signal
 * (serve-app `new-signal`) reaches the open list through SSE without a reload → Detail with the
 * server chart drawn on the canvas → browser Back → Analyze BTC (chart) → Profile.
 * Fails on any console error, page error, failed request or unexpected HTTP error. Requests to other
 * hosts (Google Fonts) are answered locally with an empty body, so nothing leaves the machine.
 */
import { createRequire } from 'module';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CHROMIUM = opt('chromium', process.env.CHROMIUM || '/opt/pw-browsers/chromium');
const DIR = path.resolve(opt('dir', path.join(os.tmpdir(), 'chm-app-real-smoke')));
const SHOTS = path.resolve(opt('shots', path.join(DIR, 'shots')));
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');

const EMAIL = 'smoke@chm.local';
const PASSWORD = 'smoke-pass-123';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

const failures = [];
let passed = 0;
const ok = (cond, what) => { if (cond) passed += 1; else { failures.push(what); console.error(`FAIL: ${what}`); } };

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, [path.join(HERE, 'serve-app.js'), '--port', String(port), '--dir', DIR], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const lines = [];
  srv.stdout.on('data', (c) => { out += c; lines.push(...String(c).split('\n').filter(Boolean)); });
  srv.stderr.on('data', (c) => { out += c; });
  const waitLine = (re, ms = 20000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const l = lines.find((x) => re.test(x));
      if (l) return resolve(l);
      if (srv.exitCode !== null) return reject(new Error(`serve-app exited: ${out}`));
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${re}: ${out}`));
      setTimeout(tick, 50);
    };
    tick();
  });
  let browser = null;
  try {
    await waitLine(/^serve-app ready/);
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ru-RU', deviceScaleFactor: 2 });
    // nothing leaves the machine: other hosts (Google Fonts) get an empty local answer
    await ctx.route((url) => url.hostname !== '127.0.0.1', (route) => {
      const u = route.request().url();
      route.fulfill({ status: 200, contentType: /\.css|css2/.test(u) ? 'text/css' : 'application/octet-stream', body: '' });
    });
    const page = await ctx.newPage();
    const errors = [];
    const apiCalls = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // the wrong-password round trip is an expected 401 ("Failed to load resource … 401")
    page.on('console', (m) => { if (m.type() === 'error' && !(/Failed to load resource/.test(m.text()) && /401/.test(m.text()))) errors.push(`console.${m.type()}: ${m.text()}`); });
    page.on('requestfailed', (r) => {
      const f = r.failure() ? r.failure().errorText : '';
      if (!(r.url().endsWith('/api/app/events') && /ERR_ABORTED/.test(f))) errors.push(`requestfailed: ${r.url()} ${f}`);
    });
    page.on('response', (r) => {
      const u = r.url();
      if (u.includes('/api/')) apiCalls.push([r.request().method(), u.replace(base, ''), r.status()]);
      if (r.status() >= 400 && !(u.endsWith('/api/auth/login') && r.status() === 401)) errors.push(`http ${r.status()}: ${r.request().method()} ${u}`);
    });
    const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

    // 1. no session → login screen
    await page.goto(`${base}/app/?splash=off`);
    await page.waitForSelector('form.login-form', { timeout: 15000 });
    ok(await page.locator('.h1', { hasText: 'Вход' }).count() === 1, 'login heading');
    ok(await page.locator('#tabbar').isHidden(), 'tab bar hidden on the login screen');
    await page.fill('input[name=email]', EMAIL);
    await page.fill('input[name=password]', 'wrong-password-1');
    await page.click('form.login-form button[type=submit]');
    await page.waitForSelector('.login-err', { timeout: 8000 });
    ok((await page.innerText('.login-err')).includes('Неверный email или пароль'), 'wrong password text');
    await shot('01-login');

    // 2. login → Home (+ the SSE stream with the Bearer token)
    const events = page.waitForResponse((r) => r.url().endsWith('/api/app/events'), { timeout: 15000 });
    await page.fill('input[name=password]', PASSWORD);
    await page.click('form.login-form button[type=submit]');
    await page.waitForSelector('.stats .stat', { timeout: 15000 });
    ok(await page.locator('#tabbar').isVisible(), 'tab bar after login');
    ok((await page.innerText('#plan-badge')).trim() === 'PRO', 'plan badge PRO');
    ok(await page.locator('.h2', { hasText: 'Последние сигналы' }).count() === 1, 'recent signals block');
    const ev = await events;
    ok(ev.status() === 200, 'GET /api/app/events 200');
    ok(/^text\/event-stream/.test(ev.headers()['content-type'] || ''), 'events content-type');
    ok(/^Bearer /.test((await ev.request().allHeaders()).authorization || ''), 'events request carries the Bearer token');
    ok(Boolean(await page.evaluate(() => localStorage.getItem('chm_access'))), 'access token stored');
    await shot('02-home');

    // 3. Signals → a new delivered signal arrives through SSE and the open list refreshes itself
    await page.click('#tabbar .tab[data-tab=signals]');
    await page.waitForSelector('.sig-list .sig', { timeout: 10000 });
    const before = await page.locator('.sig-list .sig').count();
    ok(before === 4, `signals list has the 4 seeded signals (got ${before})`);
    const sigReq = page.waitForRequest((r) => r.url().includes('/api/app/signals?'), { timeout: 15000 });
    srv.stdin.write('new-signal\n');
    await waitLine(/^new-signal ok/);
    await sigReq;
    await page.waitForFunction((n) => document.querySelectorAll('.sig-list .sig').length === n + 1, before, { timeout: 15000 });
    ok(true, 'SSE `signal` event refreshed the list without a reload');
    await shot('03-signals');

    // 4. Detail with the server chart (candles + overlays drawn by chart.js)
    const n0 = await page.evaluate(() => history.length);
    const chartResp = page.waitForResponse((r) => /\/api\/app\/signals\/[^/]+\/chart$/.test(r.url()), { timeout: 15000 });
    await page.locator('.sig-list .sig').first().click();
    await page.waitForSelector('#detail .detail-title', { timeout: 8000 });
    const cr = await chartResp;
    const cj = await cr.json();
    ok(cr.status() === 200 && cj.ok === true && Array.isArray(cj.candles) && cj.candles.length >= 80, 'chart route: candles');
    ok(cj.overlays && typeof cj.overlays.entry === 'number' && Array.isArray(cj.overlays.tps), 'chart route: overlays');
    await page.waitForSelector('#detail canvas.chm-chart', { timeout: 10000 });
    ok(await page.locator('#detail .timeline').count() === 1, 'detail timeline');
    ok(await page.locator('#detail .manual').count() === 1, 'manual result card');
    ok(await page.evaluate(() => history.length) === n0 + 1, 'detail pushed a history entry');
    await shot('04-detail');
    await page.goBack();
    await page.waitForSelector('#detail', { state: 'hidden', timeout: 8000 });
    ok(await page.locator('.sig-list .sig').count() === before + 1, 'Back closed the detail, list restored');

    // 5. Analyze
    await page.click('#tabbar .tab[data-tab=analyze]');
    await page.waitForSelector('.an-form input', { timeout: 8000 });
    await page.fill('.an-form input', 'btc');
    await page.click('.an-form button.btn-red');
    await page.waitForSelector('.result .coin-head', { timeout: 30000 });
    ok((await page.innerText('.result .coin-head')).includes('BTC'), 'analyze result head');
    ok(await page.locator('.result canvas.chm-chart').count() === 1, 'analyze chart canvas');
    await shot('05-analyze');

    // 6. Profile
    await page.click('#tabbar .tab[data-tab=profile]');
    await page.waitForSelector('.user-card', { timeout: 8000 });
    ok(await page.locator('button', { hasText: 'Выйти' }).count() === 1, 'logout button');
    ok(await page.locator('a', { hasText: 'Аккаунт и безопасность' }).count() === 1, 'account link');
    await page.waitForTimeout(1500);   // late requests of the screen (genome, challenge) land before the error check
    await shot('06-profile');

    ok(errors.length === 0, `0 console / page / request errors (got ${errors.length})`);
    for (const e of errors) console.error(`  ${e}`);
    console.log(JSON.stringify({ passed, failed: failures.length, errors: errors.length, api: apiCalls.length, shots: SHOTS }));
    console.log(apiCalls.map((c) => c.join(' ')).join('\n'));
  } finally {
    if (browser) await browser.close();
    srv.stdin.end();
    srv.kill('SIGTERM');
  }
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`);
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
