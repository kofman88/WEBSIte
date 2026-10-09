#!/usr/bin/env node
/**
 * Every static page of the site under the PRODUCTION Content-Security-Policy, in Chromium.
 *
 *   node backend/tests/e2e/csp_pages_probe.mjs [--chromium PATH] [--dir DIR] [--json FILE] [--shots DIR] [--only a,b]
 *
 * Server: tests/e2e/serve-app.js --admin — the real server.js with NODE_ENV=production (helmet CSP as
 * deployed) on a seeded scratch DB, frontend/ of this checkout as ~/public_html. Every page — the
 * landing (/ and /?data=empty), /pricing/, /app/, the SPA fallback and each legacy *.html — at
 * 1440×900 and 390×844, anonymous and, where a page needs one, with a user / admin session.
 *
 * Recorded per page: `securitypolicyviolation` events (exposed binding, so they survive redirects),
 * console errors, page errors, failed requests and HTTP errors, plus functional checks of what the
 * policy used to break (the landing font switch, Metrika, settings tabs / toggles / modals, the ops
 * drawer actions, the legal pages' icons). Any violation, error or failed check → exit 1.
 *
 * No request leaves the machine: Google Fonts, mc.yandex.ru / mc.yandex.com / yastatic.net are
 * answered by Playwright routes. The CSP decision itself is the browser's — a request the policy
 * blocks never reaches a route and fires a violation. The tag.js stub drives the channels Yandex
 * documents for its counter (script, img, connect, frames incl. blob:, a blob: worker) so the policy
 * is checked against them, not only against the snippet's own <script>.
 *
 * playwright-core and Chromium are not backend dependencies: $PLAYWRIGHT_CORE (default
 * /opt/node-tools/node_modules/playwright-core) and $CHROMIUM (default /opt/pw-browsers/chromium).
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
const DIR = path.resolve(opt('dir', path.join(os.tmpdir(), 'chm-csp-probe')));
const JSON_OUT = opt('json', '');
const SHOTS = opt('shots', '');
const ONLY = opt('only', '') ? new Set(opt('only', '').split(',')) : null;
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/opt/node-tools/node_modules/playwright-core');

const PASSWORD = 'smoke-pass-123';
const USER_EMAIL = 'smoke@chm.local';
const ADMIN_EMAIL = 'admin@chm.local';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
];

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── stubs for the hosts outside the machine ─────────────────────────────
function findFont() {
  for (const root of ['/usr/share/fonts', '/usr/local/share/fonts']) {
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_e) { continue; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (/\.ttf$/i.test(e.name) && fs.statSync(p).size < 2_000_000) return p;
      }
    }
  }
  return null;
}
const FONT = findFont();
const FONT_BYTES = FONT ? fs.readFileSync(FONT) : null;
const FAMILIES = ['Inter', 'JetBrains Mono', 'Oswald'];
const FONT_CSS = FONT_BYTES
  ? FAMILIES.map((f) => `@font-face{font-family:'${f}';font-style:normal;font-weight:100 900;font-display:swap;src:url(https://fonts.gstatic.com/s/stub/${f.replace(/ /g, '')}.ttf) format('truetype');}`).join('\n')
  : '/* no local font to stand in for Google Fonts */';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// tag.js stand-in: the channels of the Metrika docs' CSP page (script / img / connect / frame-src
// blob: + mc.yandex.* / child-src blob: workers) and a second script from each allowed origin.
const TAG_JS = `(function(){
  var r = window.__ymStub = { tag: true, img: null, fetch: null, frame: null, blobFrame: null, worker: null };
  var u = 'https://mc.yandex.ru';
  var im = new Image(); im.onload = function(){ r.img = 'ok'; }; im.onerror = function(){ r.img = 'error'; }; im.src = u + '/watch/108973987?stub=img';
  try { fetch(u + '/watch/108973987?stub=fetch', { method: 'POST', body: 'x', mode: 'no-cors', credentials: 'include' }).then(function(){ r.fetch = 'ok'; }, function(){ r.fetch = 'error'; }); } catch (e) { r.fetch = 'throw'; }
  // a blocked frame still fires load (with an error page): the same-origin blob: frame must show its own text
  function frame(src, key, text){ var f = document.createElement('iframe'); f.style.display = 'none'; f.onload = function(){
    if (!text) { r[key] = 'ok'; return; }
    var t = null; try { t = f.contentDocument && f.contentDocument.body && f.contentDocument.body.textContent; } catch (e) { t = 'no access'; }
    r[key] = t === text ? 'ok' : 'blocked (' + t + ')';
  }; f.src = src; (document.body || document.documentElement).appendChild(f); }
  frame(u + '/metrika/metrika_match.html', 'frame');
  frame(URL.createObjectURL(new Blob(['<!doctype html><p>wv</p>'], { type: 'text/html' })), 'blobFrame', 'wv');
  try { var w = new Worker(URL.createObjectURL(new Blob(['postMessage(1)'], { type: 'text/javascript' }))); w.onmessage = function(){ r.worker = 'ok'; w.terminate(); }; w.onerror = function(){ r.worker = 'error'; }; } catch (e) { r.worker = 'throw'; }
  ['https://mc.yandex.com/metrika/stub.js', 'https://yastatic.net/s3/metrika/stub.js'].forEach(function(src){ var s = document.createElement('script'); s.async = true; s.src = src; document.head.appendChild(s); });
})();`;

async function stubRoute(route) {
  const u = new URL(route.request().url());
  const h = u.hostname;
  const ok = (contentType, body) => route.fulfill({ status: 200, contentType, body, headers: { 'Access-Control-Allow-Origin': '*' } });
  if (h === 'fonts.googleapis.com') return ok('text/css', FONT_CSS);
  if (h === 'fonts.gstatic.com') return FONT_BYTES ? ok('font/ttf', FONT_BYTES) : route.fulfill({ status: 404, body: '' });
  if (h === 'mc.yandex.ru' || h === 'mc.yandex.com' || h === 'yastatic.net') {
    if (u.pathname === '/metrika/tag.js') return ok('application/javascript', TAG_JS);
    if (/\.js$/.test(u.pathname)) return ok('application/javascript', `window.__ymStub && (window.__ymStub[${JSON.stringify(h)}] = 'ok');`);
    if (/\.html$/.test(u.pathname)) return ok('text/html', '<!doctype html><title>match</title>');
    return ok('image/gif', GIF);
  }
  if (h === 'api.qrserver.com') return ok('image/gif', GIF);
  return route.fulfill({ status: 404, contentType: 'text/plain', body: `probe: no stub for ${h}` });
}

// ── scenarios ────────────────────────────────────────────────────────────
// `check(page, ctx)` returns a list of failure strings (empty = ok).
const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; const cs = getComputedStyle(e); return cs.display !== 'none' && cs.visibility !== 'hidden'; }, sel);

async function checkFonts(page) {
  const fails = [];
  const st = await page.evaluate(async () => {
    await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]);
    const links = [...document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"]')];
    return {
      printLeft: links.filter((l) => l.media === 'print').length,
      loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/["']/g, '')),
    };
  });
  if (st.printLeft) fails.push(`font stylesheet still media=print (${st.printLeft}) — the onload switch did not run`);
  if (FONT_BYTES && !st.loaded.includes('Oswald')) fails.push(`landing fonts not applied (loaded: ${st.loaded.join(', ') || 'none'})`);
  return fails;
}
async function checkMetrika(page) {
  await page.waitForFunction(() => window.__ymStub && window.__ymStub.img && window.__ymStub.fetch && window.__ymStub.frame && window.__ymStub.blobFrame && window.__ymStub.worker, null, { timeout: 5000 }).catch(() => {});
  const r = await page.evaluate(() => window.__ymStub || null);
  if (!r) return ['Metrika tag.js never ran (window.__ymStub missing)'];
  const fails = [];
  for (const k of ['img', 'fetch', 'frame', 'blobFrame', 'worker', 'mc.yandex.com', 'yastatic.net']) if (r[k] !== 'ok') fails.push(`Metrika channel ${k}: ${r[k]}`);
  return fails;
}
async function checkIcons(page) {
  const r = await page.evaluate(() => ({ left: document.querySelectorAll('i[data-lucide]').length, svg: document.querySelectorAll('svg[data-lucide]').length,
    logo: (() => { const i = document.querySelector('.nav-logo img'); return i ? getComputedStyle(i).display : 'absent'; })() }));
  const fails = [];
  if (r.left || !r.svg) fails.push(`lucide icons not rendered (${r.left} <i> left, ${r.svg} svg)`);
  if (r.logo !== 'none') fails.push(`broken nav logo not hidden (display ${r.logo})`);
  return fails;
}

async function settingsActions(page, ctx) {
  const fails = [];
  for (const t of ['subscription', 'trading', 'notifications', 'security', 'support', 'profile']) {
    await page.click(`.stab[data-stab="${t}"]`).catch((e) => fails.push(`tab ${t}: ${e.message.split('\n')[0]}`));
    const st = await page.evaluate((x) => ({ pane: document.getElementById('stab-' + x)?.classList.contains('active'), btn: document.querySelector(`.stab[data-stab="${x}"]`)?.classList.contains('active') }), t);
    if (!st.pane || !st.btn) fails.push(`tab ${t} did not activate (pane ${st.pane}, button ${st.btn})`);
  }
  await page.click('.stab[data-stab="trading"]');
  const tg = page.locator('#stab-trading .toggle').first();
  const before = await tg.evaluate((e) => e.classList.contains('on'));
  await tg.click();
  if ((await tg.evaluate((e) => e.classList.contains('on'))) === before) fails.push('trading toggle did not switch');
  await page.locator('#stab-trading input[type=range]').first().evaluate((e) => { e.value = '25'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  if ((await page.textContent('#levVal')) !== '25x') fails.push(`leverage label not updated (${await page.textContent('#levVal')})`);
  await page.locator('#stab-trading input[type=range]').nth(1).evaluate((e) => { e.value = '3.5'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  if ((await page.textContent('#riskVal')) !== '3.5%') fails.push(`risk label not updated (${await page.textContent('#riskVal')})`);
  await page.click('#stab-trading [data-toast]');
  await page.waitForFunction(() => document.body.innerText.includes('Настройки сохранены'), null, { timeout: 3000 }).catch(() => fails.push('save toast not shown'));
  // subscription: checkout modal opens and both close buttons close it
  await page.click('.stab[data-stab="subscription"]');
  for (const sel of ['#checkoutModal [data-close-checkout] >> nth=0', '#checkoutModal [data-close-checkout] >> nth=1']) {
    await page.evaluate(() => { if (typeof window.openCheckout === 'function') window.openCheckout(); else document.getElementById('upgradeBtn').click(); });
    if (!(await visible(page, '#checkoutModal'))) { fails.push('checkout modal did not open'); break; }
    await page.evaluate(() => { document.getElementById('coStep2')?.classList.remove('hidden'); });
    await page.locator(sel).click().catch((e) => fails.push(`checkout close ${sel}: ${e.message.split('\n')[0]}`));
    if (await visible(page, '#checkoutModal')) fails.push(`checkout modal not closed by ${sel}`);
  }
  // support: new-ticket modal + the seeded ticket's detail modal
  await page.click('.stab[data-stab="support"]');
  await page.click('#newTicketBtn');
  if (!(await visible(page, '#newTicketModal'))) fails.push('new-ticket modal did not open');
  await page.click('#newTicketModal [data-close-ticket-modal]').catch((e) => fails.push(`ticket modal close: ${e.message.split('\n')[0]}`));
  if (await visible(page, '#newTicketModal')) fails.push('new-ticket modal not closed');
  const tk = page.locator(`#ticketsList [data-ticket="${ctx.ticketId}"]`);
  await tk.waitFor({ timeout: 5000 }).catch(() => fails.push('seeded ticket not listed'));
  if (await tk.count()) {
    await tk.click();
    await page.waitForFunction(() => document.getElementById('tdSubject')?.textContent === 'CSP probe ticket', null, { timeout: 5000 }).catch(() => fails.push('ticket detail did not load'));
    await page.click('#ticketDetailModal [data-close-ticket-detail]').catch((e) => fails.push(`ticket detail close: ${e.message.split('\n')[0]}`));
    if (await visible(page, '#ticketDetailModal')) fails.push('ticket detail not closed');
  }
  fails.push(...await logoutOnly(page));
  return fails;
}
// the sign-out button sits in the sidebar, which is off-canvas at phone width: dispatch the click
// there (the check is the data-logout wiring, not the layout)
async function clickLogout(page) {
  const btn = page.locator('.sidebar-footer [data-logout]');
  try { await btn.click({ timeout: 1500 }); } catch (_e) { await btn.dispatchEvent('click'); }
}
async function logoutOnly(page) {
  const fails = [];
  await Promise.all([page.waitForURL((u) => u.pathname === '/', { timeout: 5000 }).catch(() => fails.push('logout did not go to /')), clickLogout(page)]);
  return fails;
}
// admin.html is a redirect stub (meta refresh + location.replace) to the ops console
async function adminRedirect(page) {
  const fails = [];
  await page.waitForURL((u) => u.pathname === '/ops.html', { timeout: 5000 }).catch(() => fails.push(`admin.html did not redirect to /ops.html (${page.url()})`));
  await page.waitForSelector('#opsApp', { state: 'visible', timeout: 8000 }).catch(() => fails.push('ops app not shown after the redirect'));
  return fails;
}
async function opsActions(page, ctx) {
  const fails = [];
  await page.waitForSelector('#opsApp', { state: 'visible', timeout: 8000 }).catch(() => fails.push('ops app not shown'));
  for (const tab of await page.$$eval('.ops-tab', (bs) => bs.map((b) => b.dataset.tab))) {
    await page.click(`.ops-tab[data-tab="${tab}"]`);
    await sleep(250);
  }
  await page.click('.ops-tab[data-tab="users"]');
  const row = page.locator(`#usersTb tr[data-uid="${ctx.userId}"]`);
  await row.waitFor({ timeout: 5000 }).catch(() => fails.push('user row not listed'));
  if (!(await row.count())) return fails;
  await row.click();
  await page.waitForSelector('#drawerBody [data-ops]', { timeout: 5000 }).catch(() => fails.push('drawer actions not rendered'));
  for (const b of await page.$$('#drawerBody [data-ops]')) {
    const name = await b.getAttribute('data-ops');
    const n = ctx.dialogs.length;
    await b.click();
    await sleep(150);
    if (ctx.dialogs.length === n) fails.push(`ops action ${name} did not run (no dialog)`);
    if (name === 'impersonate' && !(ctx.dialogs[n] || '').includes(USER_EMAIL)) fails.push(`impersonate prompt without the e-mail: ${ctx.dialogs[n]}`);
  }
  await page.click('#drawer [data-close-drawer]');
  if (await page.evaluate(() => document.getElementById('drawer').classList.contains('open'))) fails.push('drawer ✕ did not close');
  await row.click();
  await page.waitForSelector('#drawer.open', { timeout: 3000 }).catch(() => {});
  await page.mouse.click(5, (page.viewportSize().height / 2) | 0);
  if (await page.evaluate(() => document.getElementById('drawer').classList.contains('open'))) fails.push('drawer backdrop did not close');
  await page.click('.ops-tab[data-tab="flags"]');
  const flag = page.locator('#flTb [data-ops="toggleFlag"]').first();
  await flag.waitFor({ timeout: 5000 }).catch(() => fails.push('flags not listed'));
  if (await flag.count()) {
    const key = JSON.parse(await flag.getAttribute('data-ops-args'))[0];
    const n = ctx.dialogs.length;
    await flag.click();
    await sleep(150);
    if (!(ctx.dialogs[n] || '').includes(key)) fails.push(`toggleFlag dialog without the key ${key}: ${ctx.dialogs[n]}`);
  }
  return fails;
}
async function appHome(page) {
  const fails = [];
  await page.waitForFunction(() => !document.querySelector('.login-screen, #login') || document.querySelector('[data-tab], .tabbar, nav'), null, { timeout: 8000 }).catch(() => fails.push('app did not render'));
  return fails;
}

const SCENARIOS = [
  { name: 'landing', path: '/', checks: [checkFonts, checkMetrika] },
  { name: 'landing-empty', path: '/?data=empty', checks: [checkFonts, checkMetrika] },
  { name: 'pricing', path: '/pricing/', checks: [checkFonts, checkMetrika] },
  { name: 'spa-fallback', path: '/no/such/page', checks: [checkFonts] },
  { name: 'app-login', path: '/app/' },
  { name: 'app', path: '/app/', auth: 'user', checks: [appHome], settle: 2500 },
  { name: 'about', path: '/about.html', checks: [checkMetrika] },
  { name: 'api-docs', path: '/api-docs.html' },
  { name: 'status', path: '/status.html' },
  { name: 'terms', path: '/terms.html', checks: [checkIcons, checkMetrika] },
  { name: 'privacy', path: '/privacy.html', checks: [checkIcons] },
  { name: 'risk', path: '/risk.html', checks: [checkIcons] },
  { name: 'subscriptions-anon', path: '/subscriptions.html', anonRedirect: '/?login=1' },
  { name: 'subscriptions', path: '/subscriptions.html', auth: 'user', checks: [logoutOnly] },
  { name: 'settings-anon', path: '/settings.html', anonRedirect: '/?login=1' },
  { name: 'settings', path: '/settings.html', auth: 'user', checks: [settingsActions] },
  { name: 'admin-anon', path: '/admin.html', anonRedirect: '/?login=1' },
  { name: 'admin', path: '/admin.html', auth: 'admin', checks: [adminRedirect] },
  { name: 'ops-anon', path: '/ops.html', anonRedirect: '/?login=1' },
  { name: 'ops', path: '/ops.html', auth: 'admin', checks: [opsActions] },
  { name: 'google-verify', path: '/google42f82fe571b31093.html' },
  { name: 'yandex-verify', path: '/yandex_dad10d6013fe454c.html' },
];

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const srv = spawn(process.execPath, [path.join(HERE, 'serve-app.js'), '--port', String(port), '--dir', DIR, '--admin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (c) => { out += c; });
  srv.stderr.on('data', (c) => { out += c; });
  const t0 = Date.now();
  while (!/serve-app ready/.test(out)) {
    if (srv.exitCode !== null) throw new Error(`serve-app exited: ${out}`);
    if (Date.now() - t0 > 30000) throw new Error(`serve-app timeout: ${out}`);
    await sleep(50);
  }
  const results = [];
  let browser = null;
  try {
    const csp = (await fetch(base + '/')).headers.get('content-security-policy');
    const login = async (email) => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
      if (!r.ok) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const sessions = { user: await login(USER_EMAIL), admin: await login(ADMIN_EMAIL) };
    const tr = await fetch(base + '/api/support/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessions.user.accessToken}` }, body: JSON.stringify({ subject: 'CSP probe ticket', body: 'hello from the CSP probe' }) });
    const tj = await tr.json();
    const ticketId = (tj.ticket && tj.ticket.id) || tj.id;
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const vp of VIEWPORTS) {
      for (const sc of SCENARIOS) {
        if (ONLY && !ONLY.has(sc.name)) continue;
        const ctxOpts = { viewport: { width: vp.width, height: vp.height }, locale: 'ru-RU', serviceWorkers: 'block' };
        if (vp.name === 'phone') Object.assign(ctxOpts, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        const ctx = await browser.newContext(ctxOpts);
        await ctx.route((url) => url.hostname !== '127.0.0.1', stubRoute);
        const violations = [];
        const errors = [];
        const dialogs = [];
        const notes = [];
        await ctx.exposeBinding('__cspViolation', (_src, v) => { violations.push(v); });
        await ctx.addInitScript(() => {
          document.addEventListener('securitypolicyviolation', (e) => {
            window.__cspViolation({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, source: e.sourceFile, line: e.lineNumber, page: location.pathname + location.search, disposition: e.disposition });
          }, true);
        });
        if (sc.auth) {
          const s = sessions[sc.auth];
          await ctx.addInitScript((x) => {
            try {
              if (!sessionStorage.getItem('__probeSeeded')) {
                sessionStorage.setItem('__probeSeeded', '1');
                localStorage.setItem('chm_access', x.accessToken);
                localStorage.setItem('chm_refresh', x.refreshToken);
                localStorage.setItem('chm_user', JSON.stringify(x.user));
              }
            } catch (_e) { /* opaque origin */ }
          }, s);
        }
        const page = await ctx.newPage();
        page.setDefaultTimeout(5000);
        page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
        page.on('console', (m) => {
          if (m.type() !== 'error') return;
          // Chrome's user-activation intervention for the web app's haptics (frontend/app, not the CSP)
          if (/^Blocked call to navigator\.vibrate/.test(m.text())) { notes.push(`console: ${m.text().slice(0, 90)}`); return; }
          errors.push(`console: ${m.text()}`);
        });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('requestfailed', (r) => {
          const f = (r.failure() && r.failure().errorText) || '';
          // navigation (redirect stubs, logout) / context close abort in-flight loads and SSE streams;
          // a request the CSP blocks fails with "csp", never ERR_ABORTED
          if (/ERR_ABORTED/.test(f)) return;
          errors.push(`requestfailed: ${r.url()} ${f}`);
        });
        page.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`); });
        const fails = [];
        let finalUrl = '';
        try {
          await page.goto(base + sc.path, { waitUntil: 'load', timeout: 20000 });
          await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), sleep(sc.settle || 4000)]);
          await sleep(400);
          if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `${sc.name}-${vp.name}.png`), fullPage: false });
          }
          for (const c of sc.checks || []) fails.push(...await c(page, { ticketId, userId: sessions.user.user.id, dialogs }));
          await sleep(300);
          finalUrl = page.url().replace(base, '');
        } catch (e) {
          fails.push(`scenario error: ${e.message.split('\n').slice(0, 2).join(' | ')}`);
        }
        if (sc.anonRedirect) {
          // an auth-gated legacy page opened without a session: requireAuth() sends it to the login
          // and its inline script stops with `throw new Error('noauth')`; calls already in flight get a 401,
          // and a blob: frame the Metrika stub opened in the page being left can lose its blob mid-load
          if (!finalUrl.startsWith(sc.anonRedirect)) fails.push(`expected a redirect to ${sc.anonRedirect}, got ${finalUrl}`);
          for (let i = errors.length - 1; i >= 0; i -= 1) {
            if (/^(pageerror: noauth|http 401: GET .*\/api\/|console: Failed to load resource: the server responded with a status of 401|requestfailed: blob:\S+ net::ERR_BLOCKED_BY_RESPONSE)/.test(errors[i])) notes.push(errors.splice(i, 1)[0]);
          }
        }
        await ctx.close();
        const uniq = (a) => [...new Set(a)];
        const vs = uniq(violations.map((v) => `${v.directive} ${v.blocked || ''} ${v.sample ? JSON.stringify(v.sample) : ''} @${v.page}`.replace(/\s+/g, ' ').trim()));
        const res = { page: sc.name, path: sc.path, auth: sc.auth || '', viewport: vp.name, finalUrl, violations: vs, errors: uniq(errors), fails, notes: uniq(notes) };
        results.push(res);
        const okLine = !vs.length && !res.errors.length && !fails.length;
        console.log(`${okLine ? 'ok  ' : 'FAIL'} ${vp.name.padEnd(7)} ${sc.name.padEnd(20)} violations ${vs.length} errors ${res.errors.length} checks-failed ${fails.length}${finalUrl && finalUrl !== sc.path ? ` → ${finalUrl}` : ''}`);
        for (const v of vs) console.log(`       csp: ${v}`);
        for (const e of res.errors) console.log(`       err: ${e}`);
        for (const f of fails) console.log(`       chk: ${f}`);
        for (const n of res.notes) console.log(`       note (not counted): ${n}`);
      }
    }
    const total = results.reduce((a, r) => ({ v: a.v + r.violations.length, e: a.e + r.errors.length, f: a.f + r.fails.length }), { v: 0, e: 0, f: 0 });
    const summary = { csp, font: FONT, pages: results.length, violations: total.v, errors: total.e, checksFailed: total.f, results };
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ pages: results.length, violations: total.v, errors: total.e, checksFailed: total.f }));
    process.exitCode = total.v || total.e || total.f ? 1 : 0;
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.stdin.end();
    srv.kill('SIGTERM');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
