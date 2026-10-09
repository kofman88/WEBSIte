#!/usr/bin/env node
/**
 * Every static page of the site under the PRODUCTION Content-Security-Policy, in Chromium.
 *
 *   node backend/tests/e2e/csp_pages_probe.mjs [--chromium PATH] [--dir DIR] [--json FILE] [--shots DIR] [--only a,b]
 *
 * Server: tests/e2e/serve-app.js --admin — the real server.js with NODE_ENV=production (helmet CSP as
 * deployed) on a seeded scratch DB, frontend/ of this checkout as ~/public_html. Every page — the
 * landing (/ and /?data=empty), /pricing/, /app/, the SPA fallback and each legacy *.html — at
 * 1440×900 and 390×844 (the pages whose layout broke on a narrow phone also at 320×640), anonymous
 * and, where a page needs one, with a user / admin session.
 *
 * Recorded per page: `securitypolicyviolation` events (exposed binding, so they survive redirects),
 * console errors, page errors, failed requests and HTTP errors, plus functional checks of what the
 * policy used to break or could break (the landing font switch and the face Chromium renders, the
 * Metrika queue and channels — Session Replay on for public pages, off behind the sign-in —, the landing dialogs and on-demand support widget, the web app's
 * sign-in, settings tabs / toggles / modals and its /sw.js registration — service workers are on —,
 * the 2FA / checkout QR codes drawn by the server as data: URLs, the settings / subscriptions
 * hamburger, the support widget fitting the screen (also on a page wider than a phone), the ops
 * drawer actions, the legal pages' icons, logo and phone menu, no page wider than the screen,
 * /?login=1 → the web app's sign-in, the legacy pages' sign-in with next= and the way back, the
 * /auth/ page — reset / confirmation links from the account e-mails as serve-app.js queues them, the
 * old /?reset= / /?verify_email= / GET verify links: no counter, no other host, the token out of the
 * address bar and of every request —, ops → Impersonate (the session reaches the new tab without any
 * URL), the Telegram link out of Metrika's link tracking, the site icons).
 * Any violation, error or failed check → exit 1.
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
const { decodeQrDataUrl } = require('../common/qrDecode');
const { qrDataUrl } = require('../../utils/qr');
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
const RESET_EMAIL = 'reset@chm.local';     // serve-app.js --admin: verified, for the reset flows
const VERIFY_EMAIL = 'verify@chm.local';   // serve-app.js --admin: unconfirmed, for the confirmation flows
// narrow: a 320px phone, only for the scenarios marked `narrow` (the pages whose layout broke there)
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'narrow', width: 320, height: 640, mobile: true, narrowOnly: true },
];

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mailLink = null;   // set in main(): the link of a fresh account e-mail (serve-app.js mail-link)
let loginApi = null;   // set in main(): POST /api/auth/login
// a session whose access token has expired (signed with serve-app.js's scratch JWT secret) next to a
// fresh refresh token, put into the page's localStorage before it loads
async function expiredSession(c) {
  const jwt = require('jsonwebtoken');
  const s = await loginApi(RESET_EMAIL);
  const access = jwt.sign({ uid: s.user.id, exp: Math.floor(Date.now() / 1000) - 60 }, 'smoke_jwt_secret_that_is_at_least_32_chars_long', { algorithm: 'HS256' });
  await c.context.addInitScript((x) => {
    try {
      if (!sessionStorage.getItem('__probeSeeded')) {
        sessionStorage.setItem('__probeSeeded', '1');
        localStorage.setItem('chm_access', x.access);
        localStorage.setItem('chm_refresh', x.refresh);
        localStorage.setItem('chm_user', JSON.stringify(x.user));
      }
    } catch (_e) { /* opaque origin */ }
  }, { access, refresh: s.refreshToken, user: s.user });
  return '/settings.html';
}

// ── stubs for the hosts outside the machine ─────────────────────────────
// A stand-in for the Google Fonts files: a font with Latin + Cyrillic glyphs (the pages are Russian),
// so the rendered-face check below can tell the web font from the local fallbacks. Any other .ttf
// (e.g. a symbol font) still lets the font switch be checked, not the rendering.
const TEXT_FONTS = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/crosextra/Carlito-Regular.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
];
function findFont() {
  const text = TEXT_FONTS.find((p) => fs.existsSync(p));
  if (text) return text;
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
const FONT_HAS_TEXT = TEXT_FONTS.includes(FONT);
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
  if (FONT_HAS_TEXT) fails.push(...await renderedWithWebFont(page));
  return fails;
}
// The face Chromium actually used (CDP CSS.getPlatformFontsForNode) for a visible text element of
// each family: a web font (isCustomFont), not the local "… Fallback" faces.
async function renderedWithWebFont(page) {
  const fails = [];
  const marked = await page.evaluate((families) => families.filter((fam) => {
    const el = [...document.querySelectorAll('h1,h2,h3,p,span,b,a,button,li,div')].find((e) => e.offsetParent
      && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 3)
      && getComputedStyle(e).fontFamily.replace(/["']/g, '').startsWith(fam));
    if (el) el.setAttribute('data-probe-font', fam);
    return !!el;
  }), FAMILIES);
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    for (const fam of FAMILIES) {
      if (!marked.includes(fam)) { fails.push(`no visible text styled with ${fam}`); continue; }
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-probe-font="${fam}"]` });
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      if (!fonts.some((f) => f.isCustomFont)) fails.push(`${fam} text rendered with local fonts only: ${fonts.map((f) => f.familyName).join(', ')}`);
    }
  } finally { await cdp.detach().catch(() => {}); }
  return fails;
}
async function checkMetrika(page) {
  await page.waitForFunction(() => window.__ymStub && window.__ymStub.img && window.__ymStub.fetch && window.__ymStub.frame && window.__ymStub.blobFrame && window.__ymStub.worker, null, { timeout: 5000 }).catch(() => {});
  const r = await page.evaluate(() => window.__ymStub || null);
  if (!r) return ['Metrika tag.js never ran (window.__ymStub missing)'];
  const fails = [];
  // yandex-metrika.js: the ym() queue holds the init of the counter, tag.js is requested once
  const q = await metrikaQueue(page);
  if (q.ym !== 'function' || q.inits.length !== 1) fails.push(`Metrika queue not initialised (ym ${q.ym}, ${q.inits.length} init)`);
  if (q.tags !== 1) fails.push(`tag.js <script> count ${q.tags}`);
  // public pages keep Session Replay (Webvisor); the signed-in ones turn it off (metrikaPrivate)
  if (q.inits.length && q.inits[0].webvisor !== true) fails.push(`Webvisor off on a public page (${JSON.stringify(q.inits[0].webvisor)})`);
  for (const k of ['img', 'fetch', 'frame', 'blobFrame', 'worker', 'mc.yandex.com', 'yastatic.net']) if (r[k] !== 'ok') fails.push(`Metrika channel ${k}: ${r[k]}`);
  return fails;
}
const metrikaQueue = (page) => page.evaluate(() => ({
  ym: typeof window.ym,
  inits: (window.ym && window.ym.a || []).filter((a) => a[0] === 108973987 && a[1] === 'init').map((a) => a[2]),
  tags: [...document.scripts].filter((s) => s.src.startsWith('https://mc.yandex.ru/metrika/tag.js')).length,
  src: [...document.scripts].map((s) => s.getAttribute('src') || '').filter((s) => s.startsWith('/yandex-metrika.js')),
}));
// Signed-in pages (2FA secret / recovery codes / deposit address on settings, users' e-mails on ops):
// the counter runs without Session Replay, which would send the page's text to Yandex
async function metrikaPrivate(page) {
  const q = await metrikaQueue(page);
  const fails = [];
  if (q.src.join() !== '/yandex-metrika.js?webvisor=0') fails.push(`Metrika loaded as ${JSON.stringify(q.src)}`);
  if (q.inits.length !== 1 || q.inits[0].webvisor !== false) fails.push(`Webvisor not off: ${JSON.stringify(q.inits.map((i) => i.webvisor))}`);
  return fails;
}
async function checkIcons(page) {
  const r = await page.evaluate(() => ({ left: document.querySelectorAll('i[data-lucide]').length, svg: document.querySelectorAll('svg[data-lucide]').length,
    logo: (() => { const i = document.querySelector('.nav-logo img'); return i ? { src: i.getAttribute('src'), w: i.naturalWidth, display: getComputedStyle(i).display } : null; })() }));
  const fails = [];
  if (r.left || !r.svg) fails.push(`lucide icons not rendered (${r.left} <i> left, ${r.svg} svg)`);
  if (!r.logo || r.logo.src !== '/logo.png' || !r.logo.w || r.logo.display === 'none') fails.push(`nav logo not shown: ${JSON.stringify(r.logo)}`);
  return fails;
}
// the legal pages' burger (≤ 768px): opens #mobileMenu inside the screen, closes on a second tap and
// on Escape; above 768px neither shows
async function legalMenu(page) {
  const fails = [];
  const st = () => page.evaluate(() => {
    const m = document.getElementById('mobileMenu');
    const b = document.getElementById('burger');
    const r = m.getBoundingClientRect();
    return { burger: getComputedStyle(b).display !== 'none', menu: getComputedStyle(m).display !== 'none', expanded: b.getAttribute('aria-expanded'),
      inside: r.left >= 0 && r.right <= document.documentElement.clientWidth + 0.5, links: [...m.querySelectorAll('a')].filter((a) => a.getBoundingClientRect().height > 0).length };
  });
  const s0 = await st();
  if (page.viewportSize().width > 768) {
    if (s0.burger || s0.menu) fails.push(`desktop: burger ${s0.burger}, menu ${s0.menu} (both should be hidden)`);
    return fails;
  }
  if (!s0.burger || s0.menu) fails.push(`phone before tap: burger ${s0.burger}, menu ${s0.menu}`);
  await page.click('#burger');
  const s1 = await st();
  if (!s1.menu || s1.expanded !== 'true' || !s1.inside || s1.links !== 5) fails.push(`burger did not open the menu: ${JSON.stringify(s1)}`);
  await page.click('#burger');
  const s2 = await st();
  if (s2.menu || s2.expanded !== 'false') fails.push(`second tap did not close the menu: ${JSON.stringify(s2)}`);
  await page.click('#burger');
  await page.keyboard.press('Escape');
  if ((await st()).menu) fails.push('Escape did not close the menu');
  return fails;
}
// no horizontal scrolling at the probe's widths (a wider page also widens what position:fixed uses)
async function noHScroll(page) {
  const r = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const wide = [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > W + 0.5 && getComputedStyle(e).position !== 'fixed')
      .slice(0, 4).map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.classList.length ? '.' + [...e.classList].join('.') : ''}→${Math.round(e.getBoundingClientRect().right)}`);
    return { scroll: document.documentElement.scrollWidth, client: W, wide };
  });
  return r.scroll > r.client ? [`page wider than the screen: scrollWidth ${r.scroll} > ${r.client} (${r.wide.join(', ')})`] : [];
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
    // a toast can sit over the modal's × at phone width for a moment: then dispatch (the check is the wiring)
    await page.locator(sel).click({ timeout: 2000 }).catch(() => page.locator(sel).dispatchEvent('click').catch((e) => fails.push(`checkout close ${sel}: ${e.message.split('\n')[0]}`)));
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
// settings / subscriptions at ≤ 1024px: the topbar hamburger slides the off-canvas sidebar in (app.js);
// a tap outside it and Escape close it. Wider, the sidebar is always there and the hamburger hidden.
async function sidebarToggle(page) {
  const fails = [];
  const st = () => page.evaluate(() => {
    const sb = document.getElementById('sidebar');
    const b = document.getElementById('sidebar-toggle');
    const r = sb.getBoundingClientRect();
    return { toggle: getComputedStyle(b).display !== 'none', onScreen: r.left > -1 && r.right > 1, open: sb.classList.contains('open'), expanded: b.getAttribute('aria-expanded') };
  });
  const s0 = await st();
  if (page.viewportSize().width > 1024) {
    if (s0.toggle || !s0.onScreen) fails.push(`desktop: hamburger ${s0.toggle ? 'shown' : 'hidden'}, sidebar ${s0.onScreen ? 'shown' : 'hidden'}`);
    return fails;
  }
  if (!s0.toggle || s0.onScreen) fails.push(`phone before tap: ${JSON.stringify(s0)}`);
  await page.click('#sidebar-toggle');
  await sleep(450); // the transform transition
  const s1 = await st();
  if (!s1.open || !s1.onScreen || s1.expanded !== 'true') fails.push(`hamburger did not open the sidebar: ${JSON.stringify(s1)}`);
  // a tap on the page next to the open sidebar (dispatched on the content: nothing there is clicked)
  await page.evaluate(() => (document.querySelector('.main-content') || document.body).dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await sleep(450);
  const s2 = await st();
  if (s2.open || s2.onScreen || s2.expanded !== 'false') fails.push(`tap outside did not close the sidebar: ${JSON.stringify(s2)}`);
  await page.click('#sidebar-toggle');
  await page.keyboard.press('Escape');
  await sleep(450);
  if ((await st()).open) fails.push('Escape did not close the sidebar');
  return fails;
}
// settings.html: the 2FA and checkout QR codes are PNG data: URLs drawn by the server (utils/qr.js),
// shown under img-src data:, and read back as what they encode. The probe server has no deposit
// addresses configured, so the checkout answer is the route's shape with a QR from utils/qr.js.
async function settingsQr(page) {
  const fails = [];
  const shown = (sel) => page.waitForFunction((s) => { const i = document.querySelector(s); return !!(i && i.complete && i.naturalWidth > 0 && i.src.startsWith('data:')); }, sel, { timeout: 6000 }).catch(() => {});
  const img = (sel) => page.evaluate((s) => { const i = document.querySelector(s); return { src: i.getAttribute('src') || '', w: i.naturalWidth }; }, sel);
  await page.click('.stab[data-stab="security"]');
  await page.waitForFunction(() => document.getElementById('tfaBtn')?.textContent.trim() === 'Включить', null, { timeout: 6000 }).catch(() => fails.push('2FA button not ready'));
  await page.click('#tfaBtn');
  await shown('#tfaQr');
  const t = await img('#tfaQr');
  const secret = await page.evaluate(() => document.getElementById('tfaSecret').textContent.trim());
  if (!t.src.startsWith('data:image/png;base64,') || !t.w) fails.push(`2FA QR not a shown local PNG (${t.src.slice(0, 30)}…, ${t.w}px)`);
  else {
    const uri = decodeQrDataUrl(t.src) || '';
    if (!uri.startsWith('otpauth://totp/') || !secret || !uri.includes(`secret=${secret}&`)) fails.push(`2FA QR does not read back as the otpauth URI with the printed secret (${uri.slice(0, 15)}…)`);
  }
  // the code field and its button stay on the screen (at 320px the row wraps the button)
  const row = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return b.left >= 0 && b.right <= W + 0.5; };
    return { code: r('tfaCode'), button: r('tfaConfirmBtn'), sw: document.documentElement.scrollWidth, W };
  });
  if (!row.code || !row.button || row.sw > row.W) fails.push(`2FA code row off-screen: ${JSON.stringify(row)}`);
  const address = '0x00000000000000000000000000000000c5f0be01';
  const invoice = { paymentId: 1, network: 'bep20', address, amountUsdt: 69.42, expiresAt: new Date(Date.now() + 3600_000).toISOString(), plan: 'pro', billingCycle: 'monthly', qrUrl: await qrDataUrl(address) };
  await page.route('**/api/payments/crypto/create', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(invoice) }));
  await page.click('.stab[data-stab="subscription"]');
  await page.evaluate(() => { if (typeof window.openCheckout === 'function') window.openCheckout(); else document.getElementById('upgradeBtn').click(); });
  await page.locator('.co-method[data-method="usdt_bep20"]').click({ timeout: 3000 }).catch(() => page.locator('.co-method[data-method="usdt_bep20"]').dispatchEvent('click'));
  await shown('#coQr');
  const c = await img('#coQr');
  if (!c.src.startsWith('data:image/png;base64,') || !c.w) fails.push(`checkout QR not a shown local PNG (${c.src.slice(0, 30)}…, ${c.w}px)`);
  else if (decodeQrDataUrl(c.src) !== address) fails.push('checkout QR does not read back as the deposit address');
  if ((await page.textContent('#coAddr')) !== address) fails.push('checkout address not shown');
  await page.evaluate(() => { document.getElementById('checkoutModal').style.display = 'none'; });
  await page.unroute('**/api/payments/crypto/create');
  return fails;
}
// settings.html: every tab and the open checkout fit the screen. A wider page widens the layout
// viewport the fixed checkout modal is placed in (at 320px the promo-code row did, and the modal's
// right side with the address's copy button went off-screen).
async function settingsFits(page) {
  const fails = [];
  const width = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, W: document.documentElement.clientWidth }));
  for (const t of ['subscription', 'trading', 'notifications', 'security', 'support', 'profile']) {
    await page.evaluate((x) => window.stab && window.stab(x), t);
    await sleep(250);
    const w = await width();
    if (w.sw > w.W) fails.push(`tab ${t}: page ${w.sw}px wide on a ${w.W}px screen`);
  }
  await page.evaluate(() => window.stab && window.stab('subscription'));
  await page.evaluate(() => { if (typeof window.openCheckout === 'function') window.openCheckout(); else document.getElementById('upgradeBtn').click(); });
  await sleep(250);
  const card = await page.evaluate(() => { const c = document.querySelector('#checkoutModal > .card').getBoundingClientRect(); return { l: c.left, r: c.right, W: document.documentElement.clientWidth }; });
  if (card.l < 0 || card.r > card.W + 0.5) fails.push(`checkout card off-screen: ${JSON.stringify(card)}`);
  await page.evaluate(() => { document.getElementById('checkoutModal').style.display = 'none'; });
  return fails;
}
// /?login=1 (old sign-in links: the server's 302 drops the query) and the auth-gated legacy pages
// opened without a session (they send /app/?next=<their path>): the web app with its sign-in form
const signInShown = (search) => async function appSignInShown(page) {
  const fails = [];
  // the server-side /?login=1 redirect drops the query (the app's own switches, demo= / api=, must not ride along)
  const u = new URL(page.url());
  if (u.pathname !== '/app/' || u.search !== search) fails.push(`not on /app/${search}: ${page.url()}`);
  await page.waitForSelector('form.login-form', { timeout: 8000 }).catch(() => fails.push('web app sign-in form not shown'));
  return fails;
};
// …and after signing in there the visitor is back on the page that sent them (the app's ?next=)
const signInReturns = (email, wantPath, readySel) => async function signInReturnsTo(page) {
  const fails = [];
  await page.waitForSelector('form.login-form input[name=email]', { timeout: 8000 }).catch(() => fails.push('sign-in form not shown'));
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => u.pathname === wantPath, { timeout: 10000 }).catch(() => fails.push(`sign-in did not return to ${wantPath} (${page.url()})`)),
    page.click('form.login-form button[type=submit]'),
  ]);
  await page.waitForSelector(readySel, { state: 'visible', timeout: 10000 }).catch(() => fails.push(`${wantPath} not rendered after the sign-in (${readySel})`));
  return fails;
};
// a legacy page whose access token ran out (refresh token still good): requireAuth() → /app/?next=,
// the app refreshes the session and goes straight back
async function expiredReturns(page, ctx) {
  const fails = [];
  await page.waitForURL((u) => u.pathname === '/settings.html', { timeout: 10000 }).catch(() => fails.push(`not back on /settings.html (${page.url()})`));
  await page.waitForSelector('.stab[data-stab="security"]', { state: 'visible', timeout: 10000 }).catch(() => fails.push('settings not rendered'));
  if (!ctx.navigations.some((u) => u.endsWith('/app/?next=%2Fsettings.html'))) fails.push(`never went through /app/?next= (${ctx.navigations.join(' → ')})`);
  const live = await page.evaluate(() => { try { return JSON.parse(atob(localStorage.getItem('chm_access').split('.')[1])).exp * 1000 > Date.now(); } catch (_e) { return false; } });
  if (!live) fails.push('the session was not refreshed');
  return fails;
}
// a next= that is not one of the app's site paths is ignored: the sign-in opens the app itself
async function appNextHostile(page) {
  const fails = [];
  await page.waitForSelector('form.login-form input[name=email]', { timeout: 8000 }).catch(() => fails.push('sign-in form not shown'));
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.fill('input[name=email]', RESET_EMAIL);
  await page.fill('input[name=password]', PASSWORD);
  await page.click('form.login-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('form.login-form') && !document.getElementById('tabbar').hidden, null, { timeout: 10000 }).catch(() => fails.push('sign-in did not open the app'));
  await sleep(500);
  const u = new URL(page.url());
  if (u.hostname !== '127.0.0.1' || u.pathname !== '/app/') fails.push(`left the app for ${page.url()}`);
  return fails;
}

// ── /auth/ (password reset, e-mail confirmation) ───────────────────────────
// The page with a one-time token: no counter, no request to any other host, no Referer, the address
// bar clean, the token in no request URL (but the old link's own first request), the landing never
// loaded on the way.
const sanitize = (s) => String(s).replace(/((?:reset|verify)=|verify-email\/)[A-Za-z0-9_-]{16,}/g, '$1<token>');
async function authClean(page, ctx) {
  const fails = [];
  const st = await page.evaluate(() => ({
    hash: location.hash, search: location.search, path: location.pathname, ym: typeof window.ym, stub: typeof window.__ymStub,
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean), referrer: (document.querySelector('meta[name="referrer"]') || {}).content,
  }));
  if (st.path !== '/auth/' || st.hash || st.search) fails.push(`address not clean: ${sanitize(st.path + st.search + st.hash)}`);
  if (st.ym !== 'undefined' || st.stub !== 'undefined' || st.scripts.length) fails.push(`a counter / external script on /auth/: ${st.ym} ${st.stub} ${st.scripts.join(',')}`);
  if (st.referrer !== 'no-referrer') fails.push(`meta referrer ${st.referrer}`);
  const foreign = ctx.requests.filter((u) => new URL(u).hostname !== '127.0.0.1');
  if (foreign.length) fails.push(`requests to other hosts: ${foreign.map(sanitize).join(', ')}`);
  const landing = ctx.requests.filter((u) => /\/landing\/|yandex-metrika\.js|\/index\.html$/.test(new URL(u).pathname));
  if (landing.length) fails.push(`the landing was loaded on the way: ${landing.map(sanitize).join(', ')}`);
  if (ctx.token) {
    const leaked = ctx.requests.slice(ctx.firstRequestMayCarryToken ? 1 : 0).filter((u) => u.includes(ctx.token));
    if (leaked.length) fails.push(`the token in request URLs: ${leaked.map(sanitize).join(', ')}`);
  }
  const r = await fetch(ctx.base + '/auth/');
  if (r.headers.get('referrer-policy') !== 'no-referrer' || r.headers.get('cache-control') !== 'no-store') fails.push(`/auth/ headers: ${r.headers.get('referrer-policy')} ${r.headers.get('cache-control')}`);
  return fails;
}
const authView = (page) => page.evaluate(() => document.getElementById('main').getAttribute('data-view'));
const waitView = (page, view, fails) => page.waitForFunction((v) => document.getElementById('main').getAttribute('data-view') === v, view, { timeout: 8000 })
  .catch(async () => fails.push(`view ${view} not shown (${await authView(page).catch(() => '?')})`));
// default view: «forgot password» → the request → «check your inbox»; RU ⇄ EN
async function authForgot(page, ctx) {
  const fails = [...await authClean(page, ctx)];
  await waitView(page, 'forgot', fails);
  const h1 = () => page.textContent('#main h1');
  if ((await h1()) !== 'Восстановление пароля') fails.push(`ru heading: ${await h1()}`);
  await page.click('#lang');
  if ((await h1()) !== 'Reset your password' || (await page.getAttribute('html', 'lang')) !== 'en') fails.push(`en heading: ${await h1()}`);
  await page.click('#lang');
  await page.fill('#forgot-form input[name=email]', 'not-a-mail');
  await page.click('#forgot-form button[type=submit]');
  if (!(await page.isVisible('#forgot-form .msg.err'))) fails.push('invalid e-mail: no error shown');
  await page.fill('#forgot-form input[name=email]', 'nobody@chm.local');
  await page.click('#forgot-form button[type=submit]');
  await waitView(page, 'sent', fails);
  if (!(await page.textContent('#main')).includes('nobody@chm.local')) fails.push('sent view without the address');
  fails.push(...await noHScroll(page));
  return fails;
}
// the e-mail's link: the reset form, a new password, then the new password signs in
async function authReset(page, ctx) {
  const fails = [...await authClean(page, ctx)];
  await waitView(page, 'reset', fails);
  await page.fill('#pw1', 'short1');
  await page.fill('#pw2', 'short1');
  await page.click('#reset-form button[type=submit]');
  if (!(await page.isVisible('#reset-form .msg.err'))) fails.push('a short password: no error shown');
  await page.click('#reset-form .eye');
  if ((await page.getAttribute('#pw1', 'type')) !== 'text') fails.push('show-password toggle dead');
  await page.fill('#pw1', PASSWORD);
  await page.fill('#pw2', PASSWORD);
  await page.click('#reset-form button[type=submit]');
  await waitView(page, 'done', fails);
  const login = await fetch(ctx.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: RESET_EMAIL, password: PASSWORD }) });
  if (login.status !== 200) fails.push(`sign-in with the new password: ${login.status}`);
  fails.push(...await authClean(page, ctx));
  fails.push(...await noHScroll(page));
  return fails;
}
// the old /?reset=<token> link: the server's 302 goes straight to /auth/ with the token in the fragment
async function authResetLegacy(page, ctx) {
  const fails = [...await authClean(page, ctx)];
  await waitView(page, 'reset', fails);
  const first = ctx.requests[0] ? new URL(ctx.requests[0]) : null;
  if (!first || first.pathname !== '/' || !first.search.startsWith('?reset=')) fails.push(`first request not the old link: ${sanitize(ctx.requests[0])}`);
  return fails;
}
async function authVerify(page, ctx) {
  const fails = [...await authClean(page, ctx)];
  await waitView(page, 'verified', fails);
  const login = await fetch(ctx.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: VERIFY_EMAIL, password: PASSWORD }) });
  const j = await login.json().catch(() => ({}));
  if (!(j.user && j.user.emailVerified === true)) fails.push(`e-mail not confirmed after the link (${login.status})`);
  return fails;
}
// the old GET link (/api/auth/verify-email/<token>): confirmed by the server, the result on /auth/
async function authVerifyOld(page, ctx) {
  const fails = [...await authClean(page, ctx)];
  await waitView(page, 'verified', fails);
  return fails;
}
// /?verify_email=1 (the old app.js e-mail check) → /auth/: «confirm your e-mail»; without a session a sign-in link
async function authVerifyNeeded(page, ctx) {
  const fails = [...await authClean(page, ctx)];
  await waitView(page, 'verify-needed', fails);
  if (!(await page.isVisible('#main a[href="/app/"]'))) fails.push('no sign-in link without a session');
  return fails;
}
// …with a session of an unconfirmed account: «send again» → POST /auth/verify-email/request
async function authVerifyResend(page, ctx) {
  const fails = [...await authClean(page, ctx)];
  await waitView(page, 'verify-needed', fails);
  if (!(await page.textContent('#main')).includes(VERIFY_EMAIL)) fails.push('the account address not shown');
  await page.click('#resend-btn');
  await page.waitForFunction(() => { const m = document.querySelector('#main .msg'); return m && !m.hidden && /Письмо отправлено/.test(m.textContent); }, null, { timeout: 6000 })
    .catch(() => fails.push('resend: no confirmation shown'));
  return fails;
}

// ── ops → Impersonate: the session reaches the new tab without any URL ────────
async function opsImpersonate(page, ctx) {
  const fails = [];
  await page.click('.ops-tab[data-tab="users"]');
  const row = page.locator(`#usersTb tr[data-uid="${ctx.userId}"]`);
  await row.waitFor({ timeout: 5000 }).catch(() => fails.push('user row not listed'));
  await row.click();
  await page.waitForSelector('#drawerBody [data-ops="impersonate"]', { timeout: 5000 }).catch(() => fails.push('impersonate action missing'));
  const adminSession = await page.evaluate(() => localStorage.getItem('chm_access'));
  ctx.dialogAnswer = 'CSP probe: support check';
  const popupP = page.context().waitForEvent('page', { timeout: 8000 });
  await page.click('#drawerBody [data-ops="impersonate"]');
  const popup = await popupP.catch(() => null);
  ctx.dialogAnswer = null;
  if (!popup) return [...fails, 'no tab opened'];
  ctx.watch(popup, { holdsPage: true });
  const urls = [popup.url()];
  popup.on('framenavigated', (f) => { if (f === popup.mainFrame()) urls.push(f.url()); });
  await popup.waitForSelector('#impBanner', { timeout: 10000 }).catch(() => fails.push('impersonation banner not shown'));
  await popup.waitForLoadState('networkidle').catch(() => {});
  const st = await popup.evaluate(async () => {
    const tok = sessionStorage.getItem('chm_imp_access');
    const me = tok ? await fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + tok } }).then((r) => r.json()).catch(() => null) : null;
    return { href: location.href, banner: (document.getElementById('impBanner') || {}).textContent || '', me: me && me.user && me.user.email,
      handoffs: Object.keys(localStorage).filter((k) => k.startsWith('chm_imp_handoff:')), admin: localStorage.getItem('chm_access') };
  });
  if (st.me !== USER_EMAIL) fails.push(`the tab's session is ${st.me}, not ${USER_EMAIL}`);
  if (!st.banner.includes(USER_EMAIL)) fails.push(`banner: ${st.banner}`);
  if (st.handoffs.length) fails.push(`hand-off left in storage: ${st.handoffs.length}`);
  if (st.admin !== adminSession) fails.push('the admin session in localStorage changed');
  for (const u of [...urls, st.href]) {
    const x = new URL(u);
    if (x.pathname !== '/settings.html' || x.search || !(x.hash === '' || /^#impersonate=[a-f0-9]{32}$/.test(x.hash))) fails.push(`the tab's address carried more than a slot key: ${x.pathname}${x.search}${x.hash.slice(0, 14)}…`);
  }
  if (urls.some((u) => /eyJ|code=|imp=/.test(u))) fails.push('a token / code in the tab URL');
  const redeem = ctx.requests.filter((u) => u.includes('/api/auth/impersonation/redeem'));
  if (redeem.length !== 1 || redeem[0] !== ctx.base + '/api/auth/impersonation/redeem') fails.push(`redeem requests: ${redeem.length}`);
  await popup.close().catch(() => {});
  return fails;
}

// settings: the Telegram link (t.me/<bot>?start=<one-time code>) is out of Metrika's link tracking;
// the «e-mail not confirmed» card stays hidden for a confirmed account (it showed for everyone)
async function tgLinkExcluded(page) {
  const fails = [];
  const ok = await page.evaluate(() => { const a = document.getElementById('tgLinkUrl'); return !!a && a.classList.contains('ym-disable-tracklink'); });
  if (!ok) fails.push('#tgLinkUrl without ym-disable-tracklink');
  await page.evaluate(() => window.stab && window.stab('security'));
  await page.waitForFunction(() => document.getElementById('tfaBtn')?.textContent.trim() === 'Включить', null, { timeout: 6000 }).catch(() => {});
  if (await visible(page, '#emailVerifyCard')) fails.push('«e-mail not confirmed» card shown for a confirmed account');
  await page.evaluate(() => window.stab && window.stab('profile'));
  return fails;
}
// the icons the pages and sw.js name are served as images (no SPA-fallback HTML)
async function iconsServed(page) {
  const r = await page.evaluate(async () => {
    const out = {};
    for (const p of ['/favicon.svg', '/favicon-32.png', '/assets/img/icon-192.png', '/assets/img/badge.png', '/apple-touch-icon.png']) {
      const res = await fetch(p);
      out[p] = `${res.status} ${res.headers.get('content-type')}`;
    }
    return out;
  });
  return Object.entries(r).filter(([, v]) => !/^200 image\/(png|svg\+xml)/.test(v)).map(([k, v]) => `${k}: ${v}`);
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
// support-widget.js: opens, renders its three tabs, closes (anonymous: the e-mail contact form)
async function supportWidget(page, ctx, { fromLanding = false } = {}) {
  const fails = [];
  if (fromLanding) {
    // the landing loads the widget on demand from the FAQ's "no results" link
    await page.fill('#faq-q', 'zzzz-no-such-question');
    await page.click('#faq-empty [data-support]').catch((e) => fails.push(`faq support link: ${e.message.split('\n')[0]}`));
  } else {
    await page.waitForSelector('#chmSupBtn', { state: 'attached', timeout: 5000 }).catch(() => fails.push('support button missing'));
    await page.evaluate(() => document.getElementById('chmSupBtn')?.click());
  }
  await page.waitForSelector('#chmSupPanel.open', { timeout: 5000 }).catch(() => fails.push('support panel did not open'));
  for (const t of ['chat', 'help', 'home']) {
    await page.evaluate((x) => document.querySelector(`.chm-sup-tab[data-tab="${x}"]`)?.click(), t);
    await sleep(400);
    if (!(await page.evaluate(() => document.getElementById('chmSupBody')?.children.length > 0))) fails.push(`support tab ${t} empty`);
  }
  await page.evaluate(() => document.querySelector('.chm-sup-tab[data-tab="chat"]')?.click());
  if (!ctx.auth) await page.waitForSelector('#chmSupGuestEmail', { timeout: 3000 }).catch(() => fails.push('guest contact form missing'));
  await page.waitForSelector('#chmSupInput', { timeout: 5000 }).catch(() => fails.push('chat compose box missing'));
  fails.push(...await widgetGeometry(page));
  await page.evaluate(() => document.getElementById('chmSupClose')?.click());
  if (await page.evaluate(() => document.getElementById('chmSupPanel')?.classList.contains('open'))) fails.push('support panel did not close');
  return fails;
}
// The open widget on the chat tab: panel, compose box and bubble inside the screen, the textarea left of
// the send button. Desktop keeps its look: a 380px panel and the 56px bubble 22px from the right edge.
async function widgetGeometry(page) {
  const g = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
    // the screen: the visual viewport (the layout viewport fixed boxes are placed in can be larger)
    return { W: document.documentElement.clientWidth, H: window.visualViewport ? window.visualViewport.height : innerHeight, panel: r('#chmSupPanel'), ta: r('#chmSupInput'), send: r('#chmSupSend'), btn: r('#chmSupBtn') };
  });
  const fails = [];
  if (!g.panel || !g.ta || !g.send || !g.btn) return [`widget parts missing: ${JSON.stringify(g)}`];
  const near = (a, b) => Math.abs(a - b) < 1;
  for (const [k, e] of [['panel', g.panel], ['textarea', g.ta], ['send button', g.send], ['bubble', g.btn]]) {
    if (e.l < -0.5 || e.r > g.W + 0.5 || e.t < -0.5 || e.b > g.H + 0.5) fails.push(`widget ${k} outside the screen (x ${Math.round(e.l)}..${Math.round(e.r)} of ${g.W}, y ${Math.round(e.t)}..${Math.round(e.b)} of ${Math.round(g.H)})`);
  }
  if (g.ta.r > g.send.l + 0.5) fails.push(`textarea runs over the send button (textarea ends ${Math.round(g.ta.r)}, button starts ${Math.round(g.send.l)})`);
  if (g.ta.w < 120) fails.push(`textarea squeezed to ${Math.round(g.ta.w)}px`);
  if (g.W > 480) {
    if (!near(g.panel.w, 380) || !near(g.W - g.panel.r, 22) || !near(g.btn.w, 56) || !near(g.W - g.btn.r, 22) || !near(g.H - g.btn.b, 22)) fails.push(`desktop widget moved: ${JSON.stringify({ W: g.W, panel: g.panel, btn: g.btn })}`);
  } else if (!near(g.panel.l, 10) || !near(g.W - g.panel.r, 10) || !near(g.H - g.panel.b, 80) || !near(g.W - g.btn.r, 14) || !near(g.H - g.btn.b, 14)) {
    fails.push(`phone widget not at its place on the screen: ${JSON.stringify({ W: g.W, H: g.H, panel: g.panel, btn: g.btn })}`);
  }
  return fails;
}
// the same on a page wider than the screen: content wider than the phone widens the layout viewport
// position:fixed is placed in; the widget must still sit on the screen
async function supportWidgetWidePage(page, ctx) {
  if (page.viewportSize().width > 480) return [];
  await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<div id="probe-wide" style="width:640px;height:4px"></div>'));
  await sleep(300);
  const w = await page.evaluate(() => ({ inner: innerWidth, client: document.documentElement.clientWidth }));
  const fails = w.inner > w.client ? [] : [`a 640px element did not widen the layout viewport (${JSON.stringify(w)}): case not exercised`];
  fails.push(...(await supportWidget(page, ctx)).map((f) => `wide page: ${f}`));
  await page.evaluate(() => document.getElementById('probe-wide')?.remove());
  return fails;
}
// the landing's dialogs (data-dlg / data-close) and the on-demand support widget
async function landingUi(page, ctx) {
  const fails = [];
  for (const d of ['dlg-arch', 'dlg-method']) {
    await page.click(`[data-dlg="${d}"]`).catch((e) => fails.push(`${d}: ${e.message.split('\n')[0]}`));
    if (!(await page.evaluate((x) => document.getElementById(x)?.open, d))) { fails.push(`${d} did not open`); continue; }
    await page.click(`#${d} [data-close]`);
    if (await page.evaluate((x) => document.getElementById(x).open, d)) fails.push(`${d} did not close`);
  }
  fails.push(...await supportWidget(page, ctx, { fromLanding: true }));
  return fails;
}
// the web app's login screen: password toggle, register mode, a wrong password (401), then sign-in
async function appLogin(page, ctx) {
  const fails = [];
  await page.waitForSelector('form.login-form', { timeout: 8000 }).catch(() => fails.push('login form not shown'));
  await page.click('form.login-form .icon-btn');
  if ((await page.getAttribute('form.login-form input[name=password]', 'type')) !== 'text') fails.push('show-password toggle dead');
  await page.click('#login-alt button >> nth=0');            // → register
  await page.waitForSelector('form.login-form input[autocomplete="new-password"]', { timeout: 3000 }).catch(() => fails.push('register mode not shown'));
  await page.click('#login-alt button >> nth=0');            // ← back to sign-in
  await page.waitForSelector('form.login-form input[autocomplete="current-password"]', { timeout: 3000 }).catch(() => fails.push('sign-in mode not shown'));
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.fill('input[name=email]', USER_EMAIL);
  await page.fill('input[name=password]', 'wrong-password-1');
  if ((await page.inputValue('input[name=email]')) !== USER_EMAIL) fails.push('e-mail not typed');
  ctx.expect401 = true;
  await page.click('form.login-form button[type=submit]');
  await page.waitForSelector('.login-err', { timeout: 6000 }).catch(() => fails.push('wrong password: no error shown'));
  await page.fill('input[name=password]', PASSWORD);
  if ((await page.inputValue('input[name=email]')) !== USER_EMAIL) await page.fill('input[name=email]', USER_EMAIL);
  await page.click('form.login-form button[type=submit]');
  await page.waitForFunction(() => !document.querySelector('form.login-form') && !document.getElementById('tabbar').hidden, null, { timeout: 10000 }).catch(() => fails.push('sign-in did not open the app'));
  return fails;
}
// settings.html registers /sw.js for web push: worker-src falls back to child-src 'self'
async function serviceWorker(page) {
  const r = await page.evaluate(async () => {
    try { const reg = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; return { ok: !!reg.active || !!reg.installing || !!reg.waiting }; } catch (e) { return { ok: false, err: String(e) }; }
  });
  return r.ok ? [] : [`sw.js registration failed: ${r.err}`];
}
async function appHome(page) {
  const fails = [];
  await page.waitForFunction(() => !document.querySelector('.login-screen, #login') || document.querySelector('[data-tab], .tabbar, nav'), null, { timeout: 8000 }).catch(() => fails.push('app did not render'));
  return fails;
}

const SCENARIOS = [
  { name: 'landing', path: '/', checks: [checkFonts, checkMetrika, landingUi] },
  { name: 'login-redirect', path: '/?login=1&next=/ops.html', checks: [signInShown('')] },
  { name: 'login-return', path: '/?return=%2Fsettings.html&login=1', checks: [signInShown('')], narrow: true },
  { name: 'landing-empty', path: '/?data=empty', checks: [checkFonts, checkMetrika] },
  { name: 'pricing', path: '/pricing/', checks: [checkFonts, checkMetrika] },
  { name: 'spa-fallback', path: '/no/such/page', checks: [checkFonts] },
  { name: 'app-login', path: '/app/', checks: [appLogin] },
  { name: 'app', path: '/app/', auth: 'user', checks: [appHome], settle: 2500 },
  { name: 'app-next-hostile', path: '/app/?next=https%3A%2F%2Fevil.example%2F', checks: [appNextHostile] },
  { name: 'settings-expired', label: '/settings.html (access token expired, refresh token good)', path: expiredSession, checks: [expiredReturns], settle: 3000, leaves: true },
  // /auth/: the default view, the e-mails' links (queued by the site, read from the outbox) and the old addresses
  { name: 'auth-forgot', path: '/auth/', checks: [authForgot], narrow: true },
  { name: 'auth-reset', label: '/auth/#reset=<token> (e-mail)', path: (c) => mailLink(c, 'reset', RESET_EMAIL), checks: [authReset], narrow: true },
  { name: 'auth-reset-old', label: '/?reset=<token> (old e-mail)', path: async (c) => { await mailLink(c, 'reset', RESET_EMAIL); c.firstRequestMayCarryToken = true; return '/?reset=' + c.token; }, checks: [authResetLegacy] },
  { name: 'auth-verify', label: '/auth/#verify=<token> (e-mail)', path: (c) => mailLink(c, 'verify', VERIFY_EMAIL), checks: [authVerify], narrow: true },
  { name: 'auth-verify-old', label: '/api/auth/verify-email/<token> (old e-mail)', path: async (c) => { await mailLink(c, 'verify', VERIFY_EMAIL); c.firstRequestMayCarryToken = true; return '/api/auth/verify-email/' + c.token; }, checks: [authVerifyOld] },
  { name: 'auth-verify-needed', path: '/?verify_email=1', checks: [authVerifyNeeded] },
  { name: 'auth-verify-resend', label: '/?verify_email=1 (unconfirmed session)', path: async (c) => { await mailLink(c, 'verify', VERIFY_EMAIL); c.token = null; return '/?verify_email=1'; }, auth: 'verify', checks: [authVerifyResend] },
  { name: 'about', path: '/about.html', checks: [checkMetrika, noHScroll, iconsServed, supportWidget, supportWidgetWidePage] },
  { name: 'api-docs', path: '/api-docs.html', checks: [noHScroll, supportWidget], narrow: true },
  { name: 'status', path: '/status.html', checks: [noHScroll, supportWidget] },
  // the legal pages at 320px too: a flex <li> (one column per text run / <strong>) and a long heading
  // word made them wider than the screen, and the burger at the nav's right edge went off-screen
  { name: 'terms', path: '/terms.html', checks: [checkIcons, checkMetrika, noHScroll, legalMenu, supportWidget], narrow: true },
  { name: 'privacy', path: '/privacy.html', checks: [checkIcons, noHScroll, legalMenu], narrow: true },
  { name: 'risk', path: '/risk.html', checks: [checkIcons, noHScroll, legalMenu], narrow: true },
  { name: 'subscriptions-anon', path: '/subscriptions.html', anonRedirect: '/app/', checks: [signInShown('?next=%2Fsubscriptions.html')] },
  { name: 'subscriptions', path: '/subscriptions.html', auth: 'user', checks: [metrikaPrivate, sidebarToggle, supportWidget, logoutOnly] },
  { name: 'settings-anon', path: '/settings.html', anonRedirect: '/app/', checks: [signInShown('?next=%2Fsettings.html'), signInReturns(USER_EMAIL, '/settings.html', '.stab[data-stab="security"]')] },
  { name: 'settings', path: '/settings.html', auth: 'user', checks: [metrikaPrivate, tgLinkExcluded, serviceWorker, sidebarToggle, settingsQr, settingsFits, settingsActions], narrow: true },
  // admin.html is a redirect stub to the ops console, whose gate sends the visitor to the sign-in for /ops.html
  { name: 'admin-anon', path: '/admin.html', anonRedirect: '/app/', checks: [signInShown('?next=%2Fops.html')] },
  { name: 'admin', path: '/admin.html', auth: 'admin', checks: [adminRedirect] },
  { name: 'ops-anon', path: '/ops.html', anonRedirect: '/app/', checks: [signInShown('?next=%2Fops.html'), signInReturns(ADMIN_EMAIL, '/ops.html', '#opsApp')] },
  { name: 'ops', path: '/ops.html', auth: 'admin', checks: [metrikaPrivate, opsActions, opsImpersonate] },
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
  // serve-app.js stdin commands (mail-link …): one at a time, answered by a line on its stdout
  let srvQueue = Promise.resolve();
  const serve = (cmd, re) => (srvQueue = srvQueue.then(async () => {
    const from = out.length;
    srv.stdin.write(cmd + '\n');
    const t = Date.now();
    for (;;) {
      const m = re.exec(out.slice(from));
      if (m) return m;
      if (Date.now() - t > 10000) throw new Error(`serve-app: no answer to ${cmd.split(' ')[0]}`);
      await sleep(20);
    }
  }));
  // the link of the account e-mail the site queues (reset / verify), read from serve-app's private file
  mailLink = async (c, kind, email) => {
    const m = await serve(`mail-link ${kind} ${email}`, /mail-link (ok (\S+)|failed .*)\n/);
    if (!m[2]) throw new Error(`mail-link ${kind}: ${m[1]}`);
    const link = fs.readFileSync(m[2], 'utf8').trim();
    fs.unlinkSync(m[2]);
    const u = new URL(link);
    if (u.origin !== base) throw new Error(`e-mail link to another origin: ${u.origin}`);
    c.token = u.hash.split('=')[1] || null;
    return u.pathname + u.search + u.hash;
  };
  const results = [];
  let browser = null;
  try {
    const csp = (await fetch(base + '/')).headers.get('content-security-policy');
    const login = async (email) => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
      if (!r.ok) throw new Error(`login ${email}: ${r.status} ${await r.text()}`);
      return r.json();
    };
    const sessions = { user: await login(USER_EMAIL), admin: await login(ADMIN_EMAIL), verify: await login(VERIFY_EMAIL) };
    loginApi = login;
    const tr = await fetch(base + '/api/support/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessions.user.accessToken}` }, body: JSON.stringify({ subject: 'CSP probe ticket', body: 'hello from the CSP probe' }) });
    const tj = await tr.json();
    const ticketId = (tj.ticket && tj.ticket.id) || tj.id;
    browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    for (const vp of VIEWPORTS) {
      for (const sc of SCENARIOS) {
        if (ONLY && !ONLY.has(sc.name)) continue;
        if (vp.narrowOnly && !sc.narrow) continue;
        // service workers allowed: settings registers /sw.js (it has no fetch handler, so the routes still see every request)
        const ctxOpts = { viewport: { width: vp.width, height: vp.height }, locale: 'ru-RU' };
        if (vp.mobile) Object.assign(ctxOpts, { deviceScaleFactor: 2, isMobile: true, hasTouch: true });
        const ctx = await browser.newContext(ctxOpts);
        await ctx.route((url) => url.hostname !== '127.0.0.1', stubRoute);
        // each scenario × viewport is its own visitor (server.js trusts one proxy hop, so X-Forwarded-For
        // is the client address): the per-IP /api limiter as deployed (300 per 15 min) would otherwise
        // count the whole probe as one visitor. Same-origin requests only (no CORS effect elsewhere).
        const clientIp = `10.${VIEWPORTS.indexOf(vp) + 1}.${SCENARIOS.indexOf(sc) + 1}.7`;
        await ctx.route((url) => url.hostname === '127.0.0.1', (route) => route.continue({ headers: { ...route.request().headers(), 'x-forwarded-for': clientIp } }));
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
        const requests = [];
        ctx.on('request', (r) => requests.push(r.url()));
        const navigations = [];
        const cctx = { ticketId, userId: sessions.user.user.id, dialogs, auth: sc.auth || '', expect401: false, base, requests, navigations, context: ctx, token: null, firstRequestMayCarryToken: false, dialogAnswer: null };
        // console errors, page errors, failed requests and HTTP errors of a page (also a tab a check opens)
        cctx.watch = (p, { holdsPage = false } = {}) => {
          p.on('console', (m) => {
            if (m.type() !== 'error') return;
            // Chrome's user-activation intervention for the web app's haptics (frontend/app, not the CSP)
            if (/^Blocked call to navigator\.vibrate/.test(m.text())) { notes.push(`console: ${m.text().slice(0, 90)}`); return; }
            errors.push(`console: ${m.text()}`);
          });
          p.on('pageerror', (e) => {
            // the impersonation tab: requireAuth() holds settings.html until the hand-off reloads it
            // (its inline script stops with `throw new Error('noauth')`, as without a session)
            if (holdsPage && e.message === 'noauth') { notes.push(`pageerror: ${e.message} (impersonation tab, before its reload)`); return; }
            errors.push(`pageerror: ${e.message}`);
          });
          p.on('requestfailed', (r) => {
            const f = (r.failure() && r.failure().errorText) || '';
            // navigation (redirect stubs, logout) / context close abort in-flight loads and SSE streams;
            // a request the CSP blocks fails with "csp", never ERR_ABORTED
            if (/ERR_ABORTED/.test(f)) return;
            errors.push(`requestfailed: ${r.url()} ${f}`);
          });
          p.on('response', (r) => { if (r.status() >= 400) errors.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`); });
        };
        const page = await ctx.newPage();
        page.setDefaultTimeout(5000);
        page.on('framenavigated', (f) => { if (f === page.mainFrame()) navigations.push(sanitize(f.url().replace(base, ''))); });
        page.on('dialog', (d) => { dialogs.push(d.message()); (cctx.dialogAnswer != null ? d.accept(cctx.dialogAnswer) : d.dismiss()).catch(() => {}); });
        cctx.watch(page);
        const fails = [];
        let finalUrl = '';
        let landedUrl = '';
        try {
          const target = typeof sc.path === 'function' ? await sc.path(cctx) : sc.path;
          await page.goto(base + target, { waitUntil: 'load', timeout: 20000 });
          await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), sleep(sc.settle || 4000)]);
          await sleep(400);
          landedUrl = page.url().replace(base, '');
          if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await page.screenshot({ path: path.join(SHOTS, `${sc.name}-${vp.name}.png`), fullPage: false });
          }
          for (const c of sc.checks || []) fails.push(...await c(page, cctx));
          await sleep(300);
          finalUrl = page.url().replace(base, '');
        } catch (e) {
          fails.push(`scenario error: ${e.message.split('\n').slice(0, 2).join(' | ')}`);
        }
        if (cctx.expect401) {
          // appLogin's deliberate wrong-password attempt
          for (let i = errors.length - 1; i >= 0; i -= 1) {
            if (/^(http 401: POST .*\/api\/auth\/login$|console: Failed to load resource: the server responded with a status of 401)/.test(errors[i])) notes.push(errors.splice(i, 1)[0]);
          }
        }
        if (sc.anonRedirect || sc.leaves) {
          // an auth-gated legacy page opened without a (live) session: requireAuth() sends it to the login
          // and its inline script stops with `throw new Error('noauth')`; calls already in flight get a 401,
          // and a blob: frame the Metrika stub opened in the page being left can lose its blob mid-load
          if (sc.anonRedirect && !landedUrl.startsWith(sc.anonRedirect)) fails.push(`expected a redirect to ${sc.anonRedirect}, got ${landedUrl}`);
          for (let i = errors.length - 1; i >= 0; i -= 1) {
            if (/^(pageerror: noauth|http 401: GET .*\/api\/|console: Failed to load resource: the server responded with a status of 401|requestfailed: blob:\S+ net::ERR_BLOCKED_BY_RESPONSE)/.test(errors[i])) notes.push(errors.splice(i, 1)[0]);
          }
        }
        await ctx.close();
        const uniq = (a) => [...new Set(a)];
        const vs = uniq(violations.map((v) => `${v.directive} ${v.blocked || ''} ${v.sample ? JSON.stringify(v.sample) : ''} @${v.page}`.replace(/\s+/g, ' ').trim()));
        // no token of the e-mail links in what the probe prints or writes
        const res = { page: sc.name, path: sc.label || sc.path, auth: sc.auth || '', viewport: vp.name, finalUrl: sanitize(finalUrl), violations: vs.map(sanitize), errors: uniq(errors).map(sanitize), fails: fails.map(sanitize), notes: uniq(notes).map(sanitize) };
        results.push(res);
        const okLine = !vs.length && !res.errors.length && !fails.length;
        console.log(`${okLine ? 'ok  ' : 'FAIL'} ${vp.name.padEnd(7)} ${sc.name.padEnd(20)} violations ${vs.length} errors ${res.errors.length} checks-failed ${fails.length}${res.finalUrl && res.finalUrl !== sc.path ? ` → ${res.finalUrl}` : ''}`);
        for (const v of res.violations) console.log(`       csp: ${v}`);
        for (const e of res.errors) console.log(`       err: ${e}`);
        for (const f of res.fails) console.log(`       chk: ${f}`);
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
