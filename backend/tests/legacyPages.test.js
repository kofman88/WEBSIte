import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { fileURLToPath } from 'url';

// Follow-ups of the CSP audit on the legacy pages (frontend/*.html) and the sign-in redirect.
// What a browser has to show (menus opening, the widget fitting a phone) is checked in Chromium by
// tests/e2e/csp_pages_probe.mjs; this file pins the server side and the markup those checks rely on.

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FRONTEND, p), 'utf8');
const LEGACY = fs.readdirSync(FRONTEND).filter((n) => n.endsWith('.html')).sort();

// server.js serves ~/public_html (= frontend/): HOME points at a scratch home whose public_html is
// this checkout's frontend, so the requests below see the real pages.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chm-legacy-'));
fs.symlinkSync(FRONTEND, path.join(HOME, 'public_html'), 'dir');
process.env.HOME = HOME;
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(BACKEND, 'data', 'test-legacy-pages.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

let app;
beforeAll(async () => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  app = (await import('../server.js')).default;
});
afterAll(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

// ── /?login=1 → the web app's sign-in ─────────────────────────────────────
// The URL matrix both the Express route and the .htaccess rule are checked against.
const REDIRECTED = ['/?login=1', '/?login=1&next=/ops.html', '/?next=%2Fops.html&login=1', '/?a=b&login=1&c=d', '/index.html?login=1'];
const NOT_REDIRECTED = ['/', '/?data=empty', '/?login=0', '/?login=10', '/?xlogin=1', '/?login=1x', '/?login', '/?verify_email=1', '/about.html?login=1', '/pricing/?login=1', '/app/?login=1', '/app/'];

// mod_rewrite as frontend/.htaccess configures it (per-directory context: the path without its
// leading slash; %{QUERY_STRING} raw), evaluated with the file's own patterns.
function htaccessRule() {
  const text = read('.htaccess');
  const cond = /^RewriteCond %\{QUERY_STRING\} (\S+)$/m.exec(text);
  const rule = /^RewriteRule (\S+) (\S+) \[([^\]]+)\]$/m.exec(text);
  expect(cond, 'RewriteCond on the query string').not.toBeNull();
  expect(rule, 'RewriteRule').not.toBeNull();
  return { query: new RegExp(cond[1]), path: new RegExp(rule[1]), target: rule[2], flags: rule[3].split(',') };
}
function apacheRedirect(url) {
  const r = htaccessRule();
  const u = new URL(url, 'https://chmup.top');
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  if (!r.query.test(qs) || !r.path.test(u.pathname.slice(1))) return null;
  return r.target.endsWith('?') ? r.target.slice(0, -1) : r.target; // trailing "?" drops the query
}

describe('/?login=1 (where app.js / ops.js send a visitor without a session) opens the web app sign-in', () => {
  it.each(REDIRECTED)('%s → 302 /app/ (query dropped, not cached)', async (url) => {
    const r = await request(app).get(url).redirects(0);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/app/');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it.each(NOT_REDIRECTED)('%s is served as before', async (url) => {
    const r = await request(app).get(url).redirects(0);
    expect(r.status === 302 && r.headers.location === '/app/').toBe(false);
    expect([200, 301]).toContain(r.status);
  });

  it('the target is the web app with its sign-in screen; the landing at / stays the landing', async () => {
    const appPage = await request(app).get('/app/');
    expect(appPage.status).toBe(200);
    expect(appPage.text).toBe(read('app/index.html'));
    expect(read('app/app.js')).toContain('function showLogin(');
    const landing = await request(app).get('/');
    expect(landing.text).toBe(read('index.html'));
  });

  it('every sign-in redirect of the legacy pages is a URL the rule catches', () => {
    const found = [];
    for (const f of ['app.js', 'ops.js', ...LEGACY]) {
      for (const m of read(f).matchAll(/['"](\/\?[^'"]*\blogin=[^'"]*)['"]/g)) found.push(m[1]);
    }
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const url of found) expect(apacheRedirect(url), url).toBe('/app/');
  });

  it('frontend/.htaccess: the Passenger block untouched, the same redirect for when Apache serves / itself', () => {
    const text = read('.htaccess');
    expect(text.split('\n').slice(0, 5)).toEqual([
      'PassengerAppRoot "/home/chmtop/chmup_backend"',
      'PassengerBaseURI "/"',
      'PassengerNodejs "/home/chmtop/nodevenv/chmup_backend/20/bin/node"',
      'PassengerAppType node',
      'PassengerStartupFile server.js',
    ]);
    // guarded (no 500 without mod_rewrite), one rule, an external 302 that ends rewriting
    expect(text).toMatch(/<IfModule mod_rewrite\.c>\nRewriteEngine On\nRewriteCond [^\n]+\nRewriteRule [^\n]+\n<\/IfModule>/);
    expect(text.match(/^Rewrite(Cond|Rule)\b/gm)).toHaveLength(2);
    const r = htaccessRule();
    expect(r.flags.sort()).toEqual(['L', 'R=302']);
    expect(r.target).toBe('/app/?');
  });

  it.each([...REDIRECTED, ...NOT_REDIRECTED])('%s: .htaccess and server.js agree', async (url) => {
    const r = await request(app).get(url).redirects(0);
    const express = r.status === 302 ? r.headers.location : null;
    // /pricing/ and /app/ are directories Apache serves without the rule (it only matches / and index.html)
    expect(apacheRedirect(url), url).toBe(express === '/app/' ? '/app/' : null);
  });
});

// ── the legal pages' phone menu ───────────────────────────────────────────
describe('terms / privacy / risk: the burger opens a menu that exists', () => {
  it.each(['terms.html', 'privacy.html', 'risk.html'])('%s', (page) => {
    const html = read(page);
    expect(html).toContain('<button class="burger" id="burger" type="button" aria-label="Меню" aria-expanded="false" aria-controls="mobileMenu">');
    const menu = /<div class="mobile-menu" id="mobileMenu">([\s\S]*?)<\/div>/.exec(html);
    expect(menu, 'the #mobileMenu the burger controls').not.toBeNull();
    // what the hidden desktop nav offers: the landing sections, Telegram, the app
    const links = [...menu[1].matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual(['/#showcase', '/#how', '/#pricing', 'https://t.me/crypto_chm', '/app/']);
    // the menu shows only when open and only where the burger is shown (≤ 768px)
    expect(html).toMatch(/\n\.mobile-menu\{display:none\}\n/);
    expect(html).toMatch(/@media\(max-width:768px\)\{\n {2}\.nav-links,\.nav-cta\{display:none\}\n {2}\.burger\{display:flex\}\n {2}\.mobile-menu\.open\{display:flex;/);
    expect(html).toContain("burger.addEventListener('click', () => setMenu(!mobileMenu.classList.contains('open')));");
    // the landing anchors exist
    const landing = read('index.html');
    for (const id of ['showcase', 'how', 'pricing']) expect(landing).toContain(`id="${id}"`);
  });
});

// ── images ────────────────────────────────────────────────────────────────
describe('every local <img> of the pages exists', () => {
  it('no reference to the missing /assets/img/chm-logo.jpg; each local <img src> is a file', () => {
    const bad = [];
    for (const f of LEGACY) {
      const html = read(f);
      if (html.includes('chm-logo.jpg')) bad.push(`${f}: chm-logo.jpg`);
      for (const m of html.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/g)) {
        const src = m[1];
        if (/^(https?:|data:)/.test(src)) continue;
        const file = path.join(FRONTEND, src.startsWith('/') ? src.slice(1) : src);
        if (!fs.existsSync(file)) bad.push(`${f}: ${src}`);
      }
    }
    expect(bad).toEqual([]);
    for (const page of ['terms.html', 'privacy.html', 'risk.html']) expect(read(page)).toContain('<img src="/logo.png" alt="CHM" width="34" height="34"');
  });
});

// ── settings.html ─────────────────────────────────────────────────────────
describe('settings.html: the phone hamburger and the icons', () => {
  it('the hamburger controls #sidebar and app.js (loaded by the page) toggles it', () => {
    for (const page of ['settings.html', 'subscriptions.html']) {
      const html = read(page);
      expect(html, page).toContain('<button id="sidebar-toggle" type="button" class="lg:hidden" aria-label="Меню" aria-controls="sidebar" aria-expanded="false" ');
      expect(html, page).toContain('<aside class="sidebar" id="sidebar">');
      expect(html, page).toMatch(/<script src="app\.js\?v=[\w.-]+"><\/script>/);
    }
    const js = read('app.js');
    expect(js).toContain("if (t.closest('#sidebar-toggle')) { setOpen(!isOpen()); return; }");
    // styles.css: off-canvas below 1024px, .open slides it in
    expect(read('styles.css')).toMatch(/@media \(max-width: 1024px\) \{\n {2}\.sidebar \{ transform: translateX\(-100%\); \}\n {2}\.sidebar\.open \{ transform: translateX\(0\); \}/);
  });

  it('no <iconify-icon> (nothing loads the iconify CDN, the CSP allows none): inline SVG icons', () => {
    const hits = LEGACY.filter((f) => /iconify/i.test(read(f)));
    expect(hits).toEqual([]);
    const html = read('settings.html');
    // the seven former iconify icons: Telegram, push, e-mail, 2 × wallet, 2 × chevron
    expect(html.match(/<svg aria-hidden="true" viewBox="0 0 24 24" width="\d+" height="\d+" fill="none" stroke="currentColor"[^>]*>/g)).toHaveLength(7);
  });
});
