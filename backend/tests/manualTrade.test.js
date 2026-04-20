import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-manual-trade.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let app, db;
beforeAll(async () => {
  freshDb();
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
});
beforeEach(() => {
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

async function reg(email = 'm@x.com') {
  const r = await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' });
  return r.body;
}

describe('POST /api/bots/manual-trade', () => {
  it('creates a paper trade in open status', async () => {
    const u = await reg();
    const res = await request(app).post('/api/bots/manual-trade')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({
        symbol: 'BTC/USDT', side: 'long', quantity: 0.01,
        entryPrice: 50000, stopLoss: 49000, takeProfit1: 51000,
        leverage: 5, tradingMode: 'paper',
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(res.body.strategy).toBe('manual');
    expect(res.body.trading_mode).toBe('paper');
  });

  it('rejects invalid long SL (above entry)', async () => {
    const u = await reg();
    const res = await request(app).post('/api/bots/manual-trade')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({
        symbol: 'BTC/USDT', side: 'long', quantity: 0.01,
        entryPrice: 50000, stopLoss: 51000,    // wrong — above entry
        tradingMode: 'paper',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/below entry/);
  });

  it('live-mode returns 503 until testnet-validated', async () => {
    const u = await reg();
    const res = await request(app).post('/api/bots/manual-trade')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({
        symbol: 'ETH/USDT', side: 'short', quantity: 0.5,
        entryPrice: 3000, stopLoss: 3100, tradingMode: 'live',
      });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('LIVE_MANUAL_NOT_ENABLED');
  });
});
