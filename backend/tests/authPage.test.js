import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import vm from 'vm';
import request from 'supertest';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// The password reset / e-mail confirmation page (frontend/auth/) and the ways into it: the account
// e-mails link there with the token in the URL fragment, the landing's old /?reset=<token> and
// /?verify_email=1 addresses are redirected there by the server before any page (the landing runs
// Yandex Metrika with Session Replay), and the page itself takes the token out of the address bar
// before anything else runs. In Chromium: tests/e2e/csp_pages_probe.mjs (auth-* scenarios).

const require = createRequire(import.meta.url);
const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.resolve(BACKEND, '..', 'frontend');
const PAGE = fs.readFileSync(path.join(FRONTEND, 'auth', 'index.html'), 'utf8');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chm-authpage-'));
fs.symlinkSync(FRONTEND, path.join(HOME, 'public_html'), 'dir');
process.env.HOME = HOME;
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(BACKEND, 'data', 'test-auth-page.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.APP_URL = 'https://chmup.top';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;

let app, db, authService, emailService, logger;
beforeAll(async () => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
  authService = require('../services/authService');
  emailService = require('../services/emailService');
  logger = require('../utils/logger');
});
afterAll(() => { fs.rmSync(HOME, { recursive: true, force: true }); });
beforeEach(() => {
  for (const t of ['email_outbox', 'password_resets', 'email_verifications', 'refresh_tokens', 'audit_log', 'subscriptions', 'users']) db.prepare(`DELETE FROM ${t}`).run();
});

// every log line (debug and up) while fn runs
async function captureLogs(fn) {
  const Transport = require('winston-transport');
  const lines = [];
  class Capture extends Transport { log(info, cb) { lines.push(JSON.stringify(info)); cb(); } }
  const t = new Capture({ level: 'debug' });
  const raw = logger._raw;
  const level = raw.level;
  raw.level = 'debug';
  raw.add(t);
  try { await fn(); } finally { raw.remove(t); raw.level = level; }
  return lines.join('\n');
}
const TOKEN = 'Abc_DEF-ghi0123456789jklMNOpqrSTUvwxYZ01234';   // the shape of emailService.randomToken()

// ── the landing's old addresses → /auth/ (server.js; frontend/.htaccess: tests/legacyPages.test.js) ──
describe('old landing addresses never render the landing', () => {
  it.each([
    [`/?reset=${TOKEN}`, `/auth/#reset=${TOKEN}`],
    [`/index.html?reset=${TOKEN}`, `/auth/#reset=${TOKEN}`],
    [`/?utm_source=mail&reset=${TOKEN}&x=1`, `/auth/#reset=${TOKEN}`],
    [`/?reset=${TOKEN}&login=1`, `/auth/#reset=${TOKEN}`],
    ['/?reset=short', '/auth/'],
    ['/?reset=', '/auth/'],
    [`/?reset=${TOKEN}%22%3E`, '/auth/'],
    [`/?reset=${TOKEN}?x`, '/auth/'],
    ['/?verify_email=1', '/auth/?verify_email=1'],
    ['/index.html?a=b&verify_email=1', '/auth/?verify_email=1'],
    ['/?login=1', '/app/'],
  ])('%s → 302 %s, not cached, no Referer', async (url, to) => {
    const r = await request(app).get(url).redirects(0);
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(to);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.text).not.toContain('yandex-metrika');
  });

  it('the token lands in the fragment (never sent to a server again), never in a query', async () => {
    const r = await request(app).get(`/?reset=${TOKEN}`).redirects(0);
    const u = new URL(r.headers.location, 'https://chmup.top');
    expect(u.pathname).toBe('/auth/');
    expect(u.search).toBe('');
    expect(u.hash).toBe(`#reset=${TOKEN}`);
  });

  it.each(['/', '/?verify_email=0', '/?resetx=1', '/?xreset=abc', '/about.html?reset=' + TOKEN])('%s is not redirected', async (url) => {
    const r = await request(app).get(url).redirects(0);
    expect(r.status).toBe(200);
  });
});

// ── the e-mails link to /auth/ ─────────────────────────────────────────────
describe('account e-mails link to /auth/ with the token in the fragment', () => {
  const outbox = (to) => db.prepare('SELECT html, text FROM email_outbox WHERE to_addr = ? ORDER BY id DESC LIMIT 1').get(to);

  it('password reset: /auth/#reset=<token>, in the button and as text; the token is the stored one', async () => {
    await authService.register({ email: 'reset-mail@x.com', password: 'Abcdef123' });
    authService.requestPasswordReset({ email: 'reset-mail@x.com' });
    const mail = outbox('reset-mail@x.com');
    const m = /href="https:\/\/chmup\.top\/auth\/#reset=([A-Za-z0-9_-]+)"/.exec(mail.html);
    expect(m, 'reset link').not.toBeNull();
    expect(mail.text).toContain(`https://chmup.top/auth/#reset=${m[1]}`);   // plain-text clients get it too
    expect(mail.html + mail.text).not.toMatch(/\/\?reset=/);
    const row = db.prepare('SELECT token_hash FROM password_resets WHERE used_at IS NULL').get();
    expect(emailService.hashToken(m[1])).toBe(row.token_hash);
    // and it works on the page's endpoint
    const ok = await request(app).post('/api/auth/password-reset/confirm').send({ token: m[1], newPassword: 'Newpass123' });
    expect(ok.status).toBe(200);
  });

  it('e-mail confirmation: /auth/#verify=<token>; POST /verify-email/confirm completes it', async () => {
    const reg = await authService.register({ email: 'verify-mail@x.com', password: 'Abcdef123' });
    await new Promise((r) => setTimeout(r, 20));
    const mail = outbox('verify-mail@x.com');
    const m = /href="https:\/\/chmup\.top\/auth\/#verify=([A-Za-z0-9_-]+)"/.exec(mail.html);
    expect(m, 'verify link').not.toBeNull();
    expect(mail.html + mail.text).not.toMatch(/\/api\/auth\/verify-email\//);
    const ok = await request(app).post('/api/auth/verify-email/confirm').send({ token: m[1] });
    expect(ok.body).toMatchObject({ verified: true });
    expect(db.prepare('SELECT email_verified FROM users WHERE id = ?').get(reg.user.id).email_verified).toBe(1);
  });

  it('the old GET link still confirms, and lands on /auth/, never on the landing', async () => {
    const reg = await authService.register({ email: 'old-link@x.com', password: 'Abcdef123' });
    const token = emailService.randomToken();
    db.prepare('UPDATE email_verifications SET token_hash = ? WHERE user_id = ?').run(emailService.hashToken(token), reg.user.id);
    const r = await request(app).get('/api/auth/verify-email/' + token).redirects(0);
    expect([r.status, r.headers.location, r.headers['cache-control']]).toEqual([302, '/auth/?verified=1', 'no-store']);
    const bad = await request(app).get('/api/auth/verify-email/' + 'x'.repeat(40)).redirects(0);
    expect([bad.status, bad.headers.location]).toEqual([302, '/auth/?verified=0&code=INVALID_VERIFY_TOKEN']);
    const short = await request(app).get('/api/auth/verify-email/abc').redirects(0);
    expect(short.headers.location).toBe('/auth/?verified=0&code=INVALID_VERIFY_TOKEN');
  });

  it('no token reaches a log: the dry-run mail preview and the request log of the old GET link', async () => {
    await authService.register({ email: 'nolog@x.com', password: 'Abcdef123' });
    const tokens = [];
    const logs = await captureLogs(async () => {
      authService.requestPasswordReset({ email: 'nolog@x.com' });
      await emailService._tickOnce();
      const t = 'Q'.repeat(43);
      tokens.push(t);
      await request(app).get('/api/auth/verify-email/' + t).redirects(0);
    });
    const reset = /#reset=([A-Za-z0-9_-]+)/.exec(outbox('nolog@x.com').html)[1];
    tokens.push(reset);
    expect(logs).toContain('[email-dryrun]');
    expect(logs).toContain('/api/auth/verify-email/[redacted]');
    for (const t of tokens) expect(logs).not.toContain(t);
    expect(emailService.redactLinks(`a https://x/auth/#reset=${TOKEN} b /?reset=${TOKEN}&c /api/auth/verify-email/${TOKEN} #verify=${TOKEN}`))
      .toBe('a https://x/auth/#reset=[redacted] b /?reset=[redacted]&c /api/auth/verify-email/[redacted] #verify=[redacted]');
  });
});

// ── the page ───────────────────────────────────────────────────────────────
describe('frontend/auth/: no counter, no Referer, the token out of the address bar first', () => {
  it('served with Referrer-Policy no-referrer and no-store (and the same headers from .htaccess for Apache)', async () => {
    const r = await request(app).get('/auth/');
    expect(r.status).toBe(200);
    expect(r.text).toBe(PAGE);
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cache-control']).toBe('no-store');
    const ht = fs.readFileSync(path.join(FRONTEND, 'auth', '.htaccess'), 'utf8');
    expect(ht).toContain('Header always set Referrer-Policy "no-referrer"');
    expect(ht).toContain('Header always set Cache-Control "no-store"');
  });

  it('nothing on the page talks to a third party: no Metrika, no external URL, no inline handlers', () => {
    expect(PAGE).not.toMatch(/yandex|metrika|mc\.yandex|ym\(/i);
    expect(PAGE.match(/https?:\/\/[^\s"'<>)]+/g) || []).toEqual([]);
    expect(PAGE).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    expect(PAGE).toContain('<meta name="referrer" content="no-referrer"/>');
    expect(PAGE).toContain('<meta name="robots" content="noindex,nofollow"/>');
    expect(PAGE).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg"/>');
  });

  it('the first thing in <head> (right after the charset) is the script that cleans the address bar', () => {
    const head = PAGE.slice(PAGE.indexOf('<head>') + 6, PAGE.indexOf('</head>'));
    const first = head.trim().split('\n').slice(0, 2);
    expect(first).toEqual(['<meta charset="UTF-8"/>', '<script>']);
    const script = head.slice(head.indexOf('<script>'), head.indexOf('</script>'));
    expect(script.indexOf('history.replaceState')).toBeGreaterThan(0);
    expect(script.indexOf('history.replaceState')).toBeLessThan(script.indexOf('fetch('));
    // one <script> on the page, no external one
    expect(PAGE.match(/<script\b/g)).toHaveLength(1);
  });

  // The head script in a minimal fake browser: what happens before any DOM exists.
  function runHead({ hash = '', search = '' } = {}) {
    const script = PAGE.slice(PAGE.indexOf('<script>') + 8, PAGE.indexOf('</script>'));
    const calls = [];
    const loc = { hash, search, pathname: '/auth/' };
    const store = () => ({ getItem: () => null, setItem: (k) => calls.push(['setItem', k]), removeItem: () => {} });
    const ctx = {
      location: loc,
      history: { replaceState: (_s, _t, url) => { calls.push(['replaceState', url]); loc.hash = ''; loc.search = ''; } },
      document: { readyState: 'loading', addEventListener: (ev) => calls.push(['listen', ev]) },
      navigator: { language: 'ru-RU', languages: ['ru-RU'] },
      localStorage: store(), sessionStorage: store(),
      fetch: (u) => { calls.push(['fetch', u]); return new Promise(() => {}); },
      JSON, Object, String, Array, Error, Promise,
    };
    vm.runInNewContext(script, ctx);
    return { calls, loc, ctx };
  }

  it.each([
    [{ hash: `#reset=${TOKEN}` }],
    [{ hash: `#verify=${TOKEN}` }],
    [{ search: `?reset=${TOKEN}` }],
    [{ search: '?verified=1' }],
    [{ search: '?verify_email=1&x=2', hash: '#y' }],
  ])('%j: the address is cleaned at once, before any request, and the token is stored nowhere', (addr) => {
    const { calls, loc, ctx } = runHead(addr);
    expect(calls[0]).toEqual(['replaceState', '/auth/']);
    expect(calls.filter((c) => c[0] === 'fetch' || c[0] === 'setItem')).toEqual([]);
    expect(loc.hash + loc.search).toBe('');
    expect(JSON.stringify(Object.keys(ctx))).not.toContain(TOKEN);   // no global keeps it
  });

  it('a clean address is left alone', () => {
    const { calls } = runHead();
    expect(calls.filter((c) => c[0] === 'replaceState')).toEqual([]);
  });

  it('ru / en: the same set of texts in both languages; the API calls it makes are the auth routes', () => {
    const keys = (lang) => {
      const m = new RegExp(`\\n {4}${lang}: \\{\\n([\\s\\S]*?)\\n {4}\\}`).exec(PAGE);
      expect(m, lang).not.toBeNull();
      return [...m[1].matchAll(/(?:^|[\s,])([a-zA-Z0-9]+): '/g)].map((x) => x[1]).sort();
    };
    expect(keys('ru').length).toBeGreaterThan(40);
    expect(keys('en')).toEqual(keys('ru'));
    const calls = [...PAGE.matchAll(/api\('([^']+)'/g)].map((m) => m[1]).sort();
    expect(calls).toEqual(['password-reset/confirm', 'password-reset/request', 'verify-email/confirm', 'verify-email/request']);
    const routes = fs.readFileSync(path.join(BACKEND, 'routes', 'auth.js'), 'utf8');
    for (const c of calls) expect(routes).toContain(`router.post('/${c}'`);
  });
});

// ── the legacy pages send unconfirmed sessions to /auth/, not to the landing ──────
describe('frontend/app.js: the e-mail check goes to /auth/', () => {
  it('no redirect to /?verify_email=1 is left', () => {
    const js = fs.readFileSync(path.join(FRONTEND, 'app.js'), 'utf8');
    expect(js).not.toContain("'/?verify_email=1'");
    expect(js.match(/location\.href = '\/auth\/\?verify_email=1'/g)).toHaveLength(2);
  });

  it('settings.html shows its «e-mail not confirmed» card only for an unconfirmed account (GET /auth/me answers { user })', () => {
    const html = fs.readFileSync(path.join(FRONTEND, 'settings.html'), 'utf8');
    expect(html).toContain('const u = me && (me.user || me);');
    expect(html).toContain("if (u && u.emailVerified === false) verifyCard.style.display = 'block';");
    expect(html).not.toContain('!me.emailVerified');
  });
});
