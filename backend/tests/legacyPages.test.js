import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { fileURLToPath } from 'url';
import vm from 'vm';

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

// ── the landing's old query URLs → /auth/, /app/ (server.js + frontend/.htaccess) ────────────
// The landing runs Metrika with Session Replay: /?reset=<token> (old password reset e-mails),
// /?verify_email=1 (the old e-mail check of app.js) and /?login=1 (the legacy pages' old sign-in
// redirect) never render it. One URL matrix — the Location expected, null = served as before — for
// both the Express route and the .htaccess rules (emulated below with the file's own patterns).
// (The whole matrix was also sent to a real Apache 2.4.58 (mod_rewrite, mod_headers) running the
// .htaccess rules: same Locations, and /auth/ answered with the headers of frontend/auth/.htaccess.)
const TOKEN = 'Abc_DEF-ghi0123456789jklMNOpqrSTUvwxYZ01234';
const MATRIX = [
  // /?login=1 → the web app's sign-in, query dropped (the pages now send /app/?next=<path> themselves)
  ...['/?login=1', '/?login=1&next=/ops.html', '/?next=%2Fops.html&login=1', '/?a=b&login=1&c=d', '/index.html?login=1',
    '/?login=1&return=/settings.html', '/?&login=1', '/?login=2&login=1'].map((u) => [u, '/app/']),
  // /?reset=<token> → /auth/#reset=<token>; any other reset= value → /auth/ without it
  [`/?reset=${TOKEN}`, `/auth/#reset=${TOKEN}`], [`/index.html?reset=${TOKEN}`, `/auth/#reset=${TOKEN}`],
  [`/?utm_source=mail&reset=${TOKEN}&x=1`, `/auth/#reset=${TOKEN}`], [`/?reset=${TOKEN}&login=1`, `/auth/#reset=${TOKEN}`],
  [`/?login=1&reset=${TOKEN}`, `/auth/#reset=${TOKEN}`], [`/?reset=bad&reset=${TOKEN}`, `/auth/#reset=${TOKEN}`],
  [`/?verify_email=1&reset=${TOKEN}`, `/auth/#reset=${TOKEN}`], [`/?reset=${'a'.repeat(256)}`, `/auth/#reset=${'a'.repeat(256)}`],
  ['/?reset=abc123', '/auth/'], ['/?reset=', '/auth/'], [`/?reset=${TOKEN}%3E`, '/auth/'], [`/?reset=${TOKEN}?x=1`, '/auth/'],
  [`/?reset=${'a'.repeat(257)}`, '/auth/'], ['/?reset=a%20b', '/auth/'], [`/?reset=${TOKEN};x`, '/auth/'], ['/?login=1&reset=x', '/auth/'],
  // /?verify_email=1 → /auth/?verify_email=1
  ['/?verify_email=1', '/auth/?verify_email=1'], ['/index.html?a=b&verify_email=1', '/auth/?verify_email=1'],
  ['/?verify_email=1&login=1', '/auth/?verify_email=1'], ['/?login=1&verify_email=1&next=/x', '/auth/?verify_email=1'],
  // served as before
  ...['/', '/?data=empty', '/?login=0', '/?login=10', '/?xlogin=1', '/?login=1x', '/?login', '/about.html?login=1', '/pricing/?login=1',
    '/app/?login=1', '/app/', '/?login=', '/?LOGIN=1', '/?login%3D1', '/?foo=login=1', '/?q=a%26login=1', '/?login=1;x=2',
    '/settings.html?login=1', '/?verify_email=0', '/?verify_email=10', '/?xverify_email=1', '/?xreset=abc', '/?RESET=abc',
    `/about.html?reset=${TOKEN}`, `/pricing/?reset=${TOKEN}`, `/app/?reset=${TOKEN}`, '/auth/?verify_email=1', '/?q=a%26reset=x'].map((u) => [u, null]),
];

// mod_rewrite as frontend/.htaccess configures it: per-directory context (the path without its
// leading slash), %{QUERY_STRING} raw, each RewriteRule with the RewriteConds right above it (all
// must match, %N = the last one's groups), rules in order, [L] ends. A substitution with "?" replaces
// the query (a trailing "?" drops it), QSD drops it, otherwise it is appended; without NE a "#" is
// escaped to %23.
function htaccessRules() {
  const rules = [];
  let conds = [];
  for (const line of read('.htaccess').split('\n')) {
    let m = /^RewriteCond %\{QUERY_STRING\} (\S+)$/.exec(line);
    if (m) { conds.push(new RegExp(m[1])); continue; }
    m = /^RewriteRule (\S+) (\S+) \[([^\]]+)\]$/.exec(line);
    if (m) { rules.push({ conds, path: new RegExp(m[1]), target: m[2], flags: m[3].split(',') }); conds = []; continue; }
    expect(line, 'a rewrite line this emulation does not know').not.toMatch(/^Rewrite(?!Engine On$)/);
  }
  expect(conds, 'RewriteCond without a rule').toEqual([]);
  return rules;
}
function apacheRedirect(url) {
  const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
  const p = new URL(url, 'https://chmup.top').pathname.slice(1);
  for (const r of htaccessRules()) {
    let last = null;
    if (!r.conds.every((c) => (last = c.exec(qs)))) continue;
    if (!r.path.test(p)) continue;
    let target = r.target.replace(/%(\d)/g, (_m, n) => (last && last[Number(n)]) || '');
    if (!r.flags.includes('NE')) target = target.replace(/#/g, '%23');
    if (target.includes('?')) target = target.endsWith('?') ? target.slice(0, -1) : target;
    else if (!r.flags.includes('QSD') && qs) target += '?' + qs;
    expect(r.flags).toContain('R=302');
    expect(r.flags).toContain('L');
    return target;
  }
  return null;
}

describe('the landing\'s old query URLs (reset links, e-mail check, sign-in) never render it', () => {
  it.each(MATRIX)('%s → %s', async (url, to) => {
    const r = await request(app).get(url).redirects(0);
    if (to === null) {
      expect(r.status === 302 && /^\/(app|auth)\//.test(r.headers.location || '')).toBe(false);
      expect([200, 301]).toContain(r.status);
      return;
    }
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(to);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });

  it.each(MATRIX)('%s: .htaccess and server.js agree', (url, to) => {
    // /pricing/, /app/, /auth/ and other files are served without the rules (they only match / and index.html)
    expect(apacheRedirect(url), url).toBe(to);
  });

  it('the targets are the web app with its sign-in screen and the auth page; the landing at / stays the landing', async () => {
    const appPage = await request(app).get('/app/');
    expect(appPage.status).toBe(200);
    expect(appPage.text).toBe(read('app/index.html'));
    expect(read('app/app.js')).toContain('function showLogin(');
    const auth = await request(app).get('/auth/');
    expect(auth.text).toBe(read('auth/index.html'));
    const landing = await request(app).get('/');
    expect(landing.text).toBe(read('index.html'));
  });

  it('the legacy pages send a visitor without a session to the sign-in with next=, no longer through /?login=1', () => {
    const found = [];
    for (const f of ['app.js', 'ops.js', ...LEGACY]) {
      for (const m of read(f).matchAll(/['"](\/\?[^'"]*\b(?:login|reset|verify_email)=[^'"]*)['"]/g)) found.push(`${f}: ${m[1]}`);
    }
    expect(found).toEqual([]);
    expect(read('app.js')).toContain("location.href = '/app/?next=' + encodeURIComponent(location.pathname);");
    expect(read('ops.js').match(/location\.replace\('\/app\/\?next=' \+ encodeURIComponent\('\/ops\.html'\)\)/g)).toHaveLength(2);
  });

  it('frontend/.htaccess: the Passenger block untouched, the same redirects for when Apache serves / itself', () => {
    const text = read('.htaccess');
    expect(text.split('\n').slice(0, 5)).toEqual([
      'PassengerAppRoot "/home/chmtop/chmup_backend"',
      'PassengerBaseURI "/"',
      'PassengerNodejs "/home/chmtop/nodevenv/chmup_backend/20/bin/node"',
      'PassengerAppType node',
      'PassengerStartupFile server.js',
    ]);
    // guarded (no 500 without mod_rewrite), four rules, each an external 302 that ends rewriting
    expect(text).toMatch(/<IfModule mod_rewrite\.c>\nRewriteEngine On\n(RewriteCond [^\n]+\nRewriteRule [^\n]+\n){4}<\/IfModule>/);
    const rules = htaccessRules();
    expect(rules.map((r) => [r.target, r.flags.slice().sort().join(',')])).toEqual([
      ['/auth/#reset=%1', 'L,NE,QSD,R=302'],
      ['/auth/?', 'L,R=302'],
      ['/auth/?verify_email=1', 'L,R=302'],
      ['/app/?', 'L,R=302'],
    ]);
    for (const r of rules) expect(r.path.source).toBe('^(index\\.html)?$');
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

// ── Metrika Session Replay (Webvisor) off behind the sign-in ─────────────
// Webvisor records the text of the page and sends it to Yandex. settings.html shows the TOTP secret,
// its otpauth QR and the recovery codes during 2FA setup and the deposit address at checkout; ops /
// admin list every user's e-mail and IPs. Those pages load the counter as /yandex-metrika.js?webvisor=0
// (also a URL of its own, so a browser holding the old file in its 30-day cache fetches this one).
const METRIKA_TAG = /<script src="(\/yandex-metrika\.js[^"]*)" async><\/script>/;
const SIGNED_IN = ['admin.html', 'ops.html', 'settings.html', 'subscriptions.html'];

function metrikaInit(scriptSrcs) {
  const scripts = scriptSrcs.map((src) => ({ src, parentNode: { insertBefore() {} } }));
  const document = {
    scripts,
    querySelector(sel) {
      const m = /^script\[src\*="([^"]+)"\]$/.exec(sel);
      if (!m) throw new Error(`unexpected selector ${sel}`);
      return scripts.find((s) => s.src.includes(m[1])) || null;
    },
    createElement: () => ({}),
    getElementsByTagName: () => scripts,
    addEventListener() {},
  };
  const sandbox = { document, Date };
  sandbox.window = sandbox;
  vm.runInNewContext(read('yandex-metrika.js'), sandbox);
  return sandbox.ym.a.filter((a) => a[1] === 'init').map((a) => a[2]);
}

describe('Metrika: no Session Replay on the pages behind the sign-in', () => {
  it('the auth-gated pages (and only they) load /yandex-metrika.js?webvisor=0', () => {
    const gated = LEGACY.filter((f) => /Auth\.requireAuth\(\)|src="ops\.js|location\.replace\('\/ops\.html'/.test(read(f)));
    expect(gated).toEqual(SIGNED_IN);
    for (const f of [...LEGACY, 'pricing/index.html']) {
      const m = METRIKA_TAG.exec(read(f));
      if (!m) continue;                                 // the search-console verification stubs carry no counter
      expect(m[1], f).toBe(SIGNED_IN.includes(f) ? '/yandex-metrika.js?webvisor=0' : '/yandex-metrika.js');
    }
    // what must not be recorded is on those pages
    const settings = read('settings.html');
    for (const id of ['tfaSecret', 'tfaRecoveryList', 'tfaQr', 'coAddr', 'coQr']) expect(settings).toContain(`id="${id}"`);
  });

  it('yandex-metrika.js: webvisor off when loaded as ?webvisor=0, on otherwise (landing / public pages)', () => {
    const priv = metrikaInit(['https://example.test/yandex-metrika.js?webvisor=0']);
    const pub = metrikaInit(['https://example.test/yandex-metrika.js']);
    expect(priv).toHaveLength(1);
    expect(pub).toHaveLength(1);
    expect(priv[0].webvisor).toBe(false);
    expect(pub[0].webvisor).toBe(true);
    // the rest of the counter's options are the same on both
    expect({ ...priv[0], webvisor: null }).toEqual({ ...pub[0], webvisor: null });
  });
});

// ── narrow phones (320px): nothing makes the page wider than the screen ──
// A page wider than the screen widens the layout viewport position:fixed boxes are placed in: the
// legal pages' burger (at the nav's right edge) and the checkout modal of settings went off-screen at
// 320px. Chromium checks the widths (tests/e2e/csp_pages_probe.mjs, 320 / 390 / 1440); these pin the CSS.
describe('narrow phones: the legal lists, headings and the settings rows wrap', () => {
  it.each(['terms.html', 'privacy.html', 'risk.html'])('%s: one block per list item (a flex <li> split it into columns), headings break', (page) => {
    const html = read(page);
    expect(html).toContain('.legal-section ul li{position:relative;padding-left:25px}');
    expect(html).toContain(".legal-section ul li::before{content:'→';color:var(--gold);position:absolute;left:0;top:2px}");
    expect(html).not.toMatch(/\.legal-section ul li\{display:flex/);
    expect(html).toContain('.legal-hero h1{font-size:clamp(2rem,4vw,3.2rem);margin-bottom:12px;overflow-wrap:break-word}');
    expect(html).toContain('.footer-bottom-links{display:flex;flex-wrap:wrap;gap:8px 20px}');
  });

  it('privacy.html: the long word of the heading may break (with a hyphen) on a narrow phone', () => {
    expect(read('privacy.html')).toContain('<h1>Политика конфиденци&shy;альности</h1>');
  });

  it('settings.html: the promo-code input may shrink, the 2FA code row wraps its button', () => {
    const html = read('settings.html');
    expect(html).toContain('<input placeholder="Введите промо-код" class="flex-1 bg-slate-800/50 border border-slate-700 rounded-xl px-4 py-3 text-white outline-none" style="min-width:0"/>');
    expect(html).toMatch(/<div class="flex flex-wrap gap-2 mb-4">\s*<input id="tfaCode" /);
  });
});
