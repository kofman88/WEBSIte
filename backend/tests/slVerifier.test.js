import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-slverifier.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let db, slVerifier;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  slVerifier = await import('../services/slVerifier.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM trading_bots').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM users').run();
});

function makeUser() {
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, is_active)
    VALUES (?, 'x', ?, 1)
  `).run(`u-${Math.random()}@x.com`, 'R' + Math.random().toString(36).slice(2, 8));
  return info.lastInsertRowid;
}

function makeTrade(userId, { orderIds = { sl: 'sl-123' }, tradingMode = 'live' } = {}) {
  const info = db.prepare(`
    INSERT INTO trades
      (user_id, exchange, symbol, side, entry_price, quantity, status, trading_mode, exchange_order_ids)
    VALUES (?, 'bybit', 'BTC/USDT', 'long', 50000, 0.001, 'open', ?, ?)
  `).run(userId, tradingMode, JSON.stringify(orderIds));
  return info.lastInsertRowid;
}

describe('slVerifier.verifyOpenTrades', () => {
  it('reports ok when SL order is still open', async () => {
    const u = makeUser();
    makeTrade(u, { orderIds: { sl: 'sl-123' } });
    const report = await slVerifier.verifyOpenTrades({
      clientResolver: () => ({
        fetchOrder: async () => ({ id: 'sl-123', status: 'open' }),
      }),
    });
    expect(report.checked).toBe(1);
    expect(report.ok).toBe(1);
    expect(report.missing).toBe(0);
  });

  it('flags missing SL when order is cancelled', async () => {
    const u = makeUser();
    const tid = makeTrade(u, { orderIds: { sl: 'sl-gone' } });
    const report = await slVerifier.verifyOpenTrades({
      clientResolver: () => ({
        fetchOrder: async () => ({ id: 'sl-gone', status: 'canceled' }),
      }),
    });
    expect(report.missing).toBe(1);
    expect(report.ok).toBe(0);
    const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'sl_verifier.missing' AND entity_id = ?").get(tid);
    expect(audit).toBeTruthy();
    const meta = JSON.parse(audit.metadata);
    expect(meta.reason).toBe('sl_canceled');
  });

  it('flags missing SL when fetchOrder returns null', async () => {
    const u = makeUser();
    makeTrade(u);
    const report = await slVerifier.verifyOpenTrades({
      clientResolver: () => ({ fetchOrder: async () => null }),
    });
    expect(report.missing).toBe(1);
  });

  it('flags trades with no stored sl id', async () => {
    const u = makeUser();
    const tid = makeTrade(u, { orderIds: { entry: 'e1' } });
    const report = await slVerifier.verifyOpenTrades({
      clientResolver: () => ({ fetchOrder: async () => ({ status: 'open' }) }),
    });
    expect(report.missing).toBe(1);
    const audit = db.prepare("SELECT * FROM audit_log WHERE action = 'sl_verifier.missing' AND entity_id = ?").get(tid);
    expect(JSON.parse(audit.metadata).reason).toBe('no_sl_id_stored');
  });

  it('increments errors and continues on fetchOrder exception', async () => {
    const u = makeUser();
    makeTrade(u);
    makeTrade(u, { orderIds: { sl: 'sl-b' } });
    let calls = 0;
    const report = await slVerifier.verifyOpenTrades({
      clientResolver: () => ({
        fetchOrder: async () => {
          calls++;
          if (calls === 1) throw new Error('network down');
          return { status: 'open' };
        },
      }),
    });
    expect(report.errors).toBe(1);
    expect(report.ok).toBe(1);
    expect(report.checked).toBe(2);
  });

  it('ignores paper-mode trades', async () => {
    const u = makeUser();
    makeTrade(u, { tradingMode: 'paper' });
    const report = await slVerifier.verifyOpenTrades({
      clientResolver: () => ({ fetchOrder: async () => ({ status: 'open' }) }),
    });
    expect(report.checked).toBe(0);
  });

  it('counts errors when no client available for live trade', async () => {
    const u = makeUser();
    makeTrade(u);
    const report = await slVerifier.verifyOpenTrades({
      clientResolver: () => null,
    });
    expect(report.errors).toBe(1);
    expect(report.ok).toBe(0);
  });
});
