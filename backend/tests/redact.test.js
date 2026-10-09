import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

// No secret in a log line or a Sentry event: e-mail link tokens, OAuth / impersonation hand-off
// codes, Telegram link codes, the bot token in a Bot API URL (an outgoing-request breadcrumb or
// span), Authorization / Cookie headers. utils/redact.js + utils/sentry.js scrubEvent / scrubBreadcrumb.

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-redact.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const TOK = 'Abc_DEF-ghi0123456789jklMNOpqrSTUvwxYZ01234';
const BOT = '123456789:AAFakeBotToken_abc-XYZ';
let app, redact, redactDeep, sentry, logger, authService;
beforeAll(async () => {
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* absent */ } }
  app = (await import('../server.js')).default;
  ({ redact, redactDeep } = require('../utils/redact'));
  sentry = require('../utils/sentry');
  logger = require('../utils/logger');
  authService = require('../services/authService');
});
afterEach(() => { vi.restoreAllMocks(); });

describe('utils/redact', () => {
  it.each([
    [`/api/auth/verify-email/${TOK}`, '/api/auth/verify-email/[redacted]'],
    [`https://chmup.top/auth/#reset=${TOK}`, 'https://chmup.top/auth/#reset=[redacted]'],
    [`/?utm=1&reset=${TOK}&x=2`, '/?utm=1&reset=[redacted]&x=2'],
    [`/auth/#verify=${TOK}`, '/auth/#verify=[redacted]'],
    [`/auth/#oauth=${TOK}`, '/auth/#oauth=[redacted]'],
    [`/api/auth/oauth/google/callback?code=4/0Ab${TOK}&state=a.1.b`, '/api/auth/oauth/google/callback?code=[redacted]&state=[redacted]'],
    [`https://t.me/chm_signals_bot?start=${TOK.slice(0, 11)}`, 'https://t.me/chm_signals_bot?start=[redacted]'],
    [`https://api.telegram.org/bot${BOT}/sendMessage`, 'https://api.telegram.org/bot[redacted]/sendMessage'],
    [`/settings.html#impersonate=0123456789abcdef`, '/settings.html#impersonate=[redacted]'],
    [`/x?access_token=eyJa.b.c&refresh_token=r1`, '/x?access_token=[redacted]&refresh_token=[redacted]'],
    ['/api/health', '/api/health'], ['/settings.html?upgrade=pro&cycle=yearly', '/settings.html?upgrade=pro&cycle=yearly'],
  ])('%s', (input, want) => {
    expect(redact(input)).toBe(want);
  });

  it('deep: every string of an object, other values untouched', () => {
    expect(redactDeep({ a: [`/verify-email/${TOK}`, 3], b: { c: `x?reset=${TOK}` }, d: null, e: true }))
      .toEqual({ a: ['/verify-email/[redacted]', 3], b: { c: 'x?reset=[redacted]' }, d: null, e: true });
  });
});

describe('utils/sentry: what an event / breadcrumb carries out', () => {
  it('an error event: URL, query, headers, body, breadcrumbs, spans, messages', () => {
    const ev = sentry.scrubEvent({
      message: `failed at /api/auth/verify-email/${TOK}`,
      transaction: `GET /api/auth/verify-email/${TOK}`,
      request: {
        url: `https://chmup.top/api/auth/verify-email/${TOK}?x=1`,
        query_string: `reset=${TOK}&a=b`,
        headers: { authorization: 'Bearer eyJsecret', Cookie: 'oauth_state=s', 'x-forwarded-for': '1.2.3.4', referer: `https://chmup.top/?reset=${TOK}`, 'user-agent': 'UA' },
        cookies: { oauth_state: 's' },
        data: { token: TOK, newPassword: 'pw', nested: { code: '123456' } },
      },
      extra: { path: `/api/auth/verify-email/${TOK}`, handoffCode: TOK },
      breadcrumbs: [
        { category: 'http', data: { url: `https://api.telegram.org/bot${BOT}/sendMessage`, method: 'POST' } },
        { category: 'console', message: `link https://t.me/b?start=${TOK.slice(0, 11)}` },
      ],
      spans: [{ description: `POST https://api.telegram.org/bot${BOT}/sendMessage`, data: { 'url.full': `https://api.telegram.org/bot${BOT}/sendMessage` } }],
      exception: { values: [{ value: `ENOENT /api/auth/verify-email/${TOK}`, stacktrace: { frames: [{ filename: '/home/chmtop/app/x.js' }] } }] },
    });
    const s = JSON.stringify(ev);
    for (const secret of [TOK, BOT, TOK.slice(0, 11), 'eyJsecret', 'oauth_state=s', '1.2.3.4', '"pw"', '123456']) expect(s, secret).not.toContain(secret);
    expect(ev.request.headers['user-agent']).toBe('UA');
    expect(ev.request.url).toBe('https://chmup.top/api/auth/verify-email/[redacted]?x=1');
    expect(ev.request.query_string).toBe('reset=[redacted]&a=b');
    expect(ev.breadcrumbs[0].data).toEqual({ url: 'https://api.telegram.org/bot[redacted]/sendMessage', method: 'POST' });
    expect(ev.exception.values[0].stacktrace.frames[0].filename).toBe('~/app/x.js');
  });

  it('breadcrumbs before they are kept (beforeBreadcrumb), the SDK\'s { values } form too', () => {
    expect(sentry.scrubBreadcrumb({ data: { url: `https://api.telegram.org/bot${BOT}/getMe` } }).data.url).toBe('https://api.telegram.org/bot[redacted]/getMe');
    const ev = sentry.scrubEvent({ breadcrumbs: { values: [{ message: `GET /api/auth/verify-email/${TOK}` }] } });
    expect(ev.breadcrumbs.values[0].message).toBe('GET /api/auth/verify-email/[redacted]');
  });

  it('Sentry.init gets the scrubbers for errors, transactions and breadcrumbs', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'utils', 'sentry.js'), 'utf8');
    expect(src).toContain('beforeSend: scrubEvent,');
    expect(src).toContain('beforeSendTransaction: scrubEvent,');
    expect(src).toContain('beforeBreadcrumb: scrubBreadcrumb,');
  });
});

describe('server.js: an unhandled error on a token URL logs the path without the token', () => {
  it('GET /api/auth/verify-email/<token> failing inside → 500, the log line redacted', async () => {
    vi.spyOn(authService, 'verifyEmail').mockImplementation(() => { throw new Error(`db locked while reading /api/auth/verify-email/${TOK}`); });
    const Transport = require('winston-transport');
    const lines = [];
    class Capture extends Transport { log(info, cb) { lines.push(JSON.stringify(info)); cb(); } }
    const t = new Capture({ level: 'debug' });
    const raw = logger._raw;
    const level = raw.level;
    raw.level = 'debug';
    raw.add(t);
    let r;
    try { r = await request(app).get('/api/auth/verify-email/' + TOK).redirects(0); } finally { raw.remove(t); raw.level = level; }
    expect(r.status).toBe(500);
    const log = lines.join('\n');
    expect(log).toContain('unhandled server error');
    expect(log).toContain('/api/auth/verify-email/[redacted]');
    expect(log).not.toContain(TOK);
  });
});
