/**
 * notifier — the M10 additions are additive: engine types + defaults, `silent` (quiet hours
 * = in-app only), the in-app row id in the result (→ signal_trades.signal_msg_id), and the
 * SSE fan-out (`notification` + the type's own event). Existing callers keep working.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m10a-notifier.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db; let notifier; let sse; let emailService; let telegramService;

beforeAll(() => {
  freshDb();
  db = nodeRequire('../../../models/database.js');
  notifier = nodeRequire('../../../services/notifier.js');
  sse = nodeRequire('../../../services/sseService.js');
  emailService = nodeRequire('../../../services/emailService.js');
  telegramService = nodeRequire('../../../services/telegramService.js');
});

let emailSpy; let tgSpy;
beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM users').run();
  sse._resetForTests();
  emailSpy = vi.spyOn(emailService, 'send').mockResolvedValue({ ok: true });
  tgSpy = vi.spyOn(telegramService, 'send').mockResolvedValue({ sent: true });
});
afterEach(() => { vi.restoreAllMocks(); sse._resetForTests(); });

function makeUser({ verified = 1, active = 1 } = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return Number(db.prepare('INSERT INTO users (email, password_hash, referral_code, email_verified, is_active) VALUES (?, ?, ?, ?, ?)')
    .run(e, 'x', ref, verified, active).lastInsertRowid);
}

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = () => {};
  res.write = (c) => { res.chunks.push(c); return true; };
  res.end = () => {};
  return res;
}

describe('defaults and types', () => {
  it('engine types are listed and get defaults (progress: no e-mail; report/trend/trade: e-mail on)', () => {
    expect(notifier.ENGINE_TYPES).toEqual(['signal', 'progress', 'trend', 'report', 'trade']);
    const d = notifier.defaults();
    expect(d.email).toMatchObject({ signal: false, progress: false, trend: true, report: true, trade: true, payment: true });
    expect(d.telegram).toMatchObject({ signal: true, progress: true, trend: true, report: true, trade: true });
    // M17b retention (decision D20): feed + Telegram mirror, e-mail only after an opt-in
    expect(d.email).toMatchObject({ reminder: false, promo: false });
    expect(d.telegram).toMatchObject({ reminder: true, promo: true });
  });
});

describe('dispatch', () => {
  it('returns the in-app row id, fans out to e-mail + Telegram, pushes SSE notification + type event', async () => {
    const uid = makeUser();
    const res = fakeRes();
    sse.addClient(uid, res);
    const r = await notifier.dispatch(uid, { type: 'report', title: 'Итоги недели', body: '<b>x</b>', link: '/app/', tgText: '<b>x</b>' });
    expect(r).toEqual({ dispatched: true, notificationId: expect.any(Number), silent: false });
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(r.notificationId);
    expect(row).toMatchObject({ user_id: uid, type: 'report', title: 'Итоги недели', body: '<b>x</b>', link: '/app/' });
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(tgSpy).toHaveBeenCalledWith(uid, '<b>x</b>', { parseMode: 'HTML' });
    const events = res.chunks.filter((c) => c.startsWith('id:'));
    expect(events.map((c) => c.split('\n')[1])).toEqual(['event: notification', 'event: report']);
    expect(JSON.parse(events[0].split('\n')[2].slice(6))).toEqual({ id: r.notificationId, type: 'report', title: 'Итоги недели', body: '<b>x</b>', link: '/app/' });
  });

  it('silent: in-app row + SSE only — no e-mail, no Telegram, no push', async () => {
    const uid = makeUser();
    const res = fakeRes();
    sse.addClient(uid, res);
    const r = await notifier.dispatch(uid, { type: 'progress', title: 't', body: 'b', silent: true, data: { trade_id: 'x', stage: 'TP1' } });
    expect(r).toEqual({ dispatched: true, notificationId: expect.any(Number), silent: true });
    expect(emailSpy).not.toHaveBeenCalled();
    expect(tgSpy).not.toHaveBeenCalled();
    const ev = res.chunks.filter((c) => c.startsWith('id:'));
    expect(ev[1]).toContain('event: progress\ndata: {"trade_id":"x","stage":"TP1"}');
  });

  it('progress is not e-mailed by default; legacy types unchanged; unknown user → user_not_found', async () => {
    const uid = makeUser();
    await notifier.dispatch(uid, { type: 'progress', title: 't' });
    expect(emailSpy).not.toHaveBeenCalled();
    expect(tgSpy).toHaveBeenCalledTimes(1);
    await notifier.dispatch(uid, { type: 'security', title: 's', body: 'b' });
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(await notifier.dispatch(999999, { type: 'signal', title: 'x' })).toEqual({ error: 'user_not_found' });
    expect(await notifier.dispatch(makeUser({ active: 0 }), { type: 'signal', title: 'x' })).toEqual({ error: 'user_not_found' });
    expect(await notifier.dispatch(uid, { type: 'signal' })).toEqual({ error: 'invalid_args' });
  });
});
