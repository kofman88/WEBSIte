import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-tv-webhook.db');
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
  db.prepare('DELETE FROM signals').run();
  db.prepare('DELETE FROM trading_bots').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

async function regAndBot(email = 'tv@x.com') {
  const u = (await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' })).body;
  // Create a fake exchange key first (validation.createBotSchema requires it)
  const cryptoUtil = (await import('../utils/crypto.js')).default || await import('../utils/crypto.js');
  const cfg = (await import('../config/index.js')).default;
  const keyInfo = db.prepare(`
    INSERT INTO exchange_keys (user_id, exchange, label, api_key_encrypted, api_secret_encrypted)
    VALUES (?, 'bybit', 'test', ?, ?)
  `).run(u.user.id, cryptoUtil.encrypt('fake-key', cfg.walletEncryptionKey), cryptoUtil.encrypt('fake-secret', cfg.walletEncryptionKey));

  const botRes = await request(app).post('/api/bots').set('Authorization', 'Bearer ' + u.accessToken).send({
    name: 'TV Bot', exchange: 'bybit', exchangeKeyId: keyInfo.lastInsertRowid,
    symbols: ['BTCUSDT'], strategy: 'levels', timeframe: '1h',
    direction: 'both', leverage: 5, riskPct: 1, maxOpenTrades: 3,
    autoTrade: false, tradingMode: 'paper',
  });
  if (!botRes.body || !botRes.body.id) {
    throw new Error('Bot creation failed: ' + botRes.status + ' ' + JSON.stringify(botRes.body));
  }
  const bot = botRes.body;
  db.prepare('UPDATE trading_bots SET is_active = 1 WHERE id = ?').run(bot.id);
  return { u, bot };
}

describe('TradingView webhook', () => {
  it('GET /bots/:id/tv-webhook initially returns null secret', async () => {
    const { u, bot } = await regAndBot();
    const res = await request(app).get('/api/bots/' + bot.id + '/tv-webhook')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/\/api\/webhooks\/tradingview\/\d+$/);
    expect(res.body.secret).toBeNull();
  });

  it('POST /bots/:id/tv-webhook/rotate generates + persists secret', async () => {
    const { u, bot } = await regAndBot();
    const res = await request(app).post('/api/bots/' + bot.id + '/tv-webhook/rotate')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.secret).toMatch(/^tvwh_/);
    // DB has it
    const row = db.prepare('SELECT tv_webhook_secret FROM trading_bots WHERE id = ?').get(bot.id);
    expect(row.tv_webhook_secret).toBe(res.body.secret);
  });

  it('webhook rejects missing/wrong secret with 401', async () => {
    const { u, bot } = await regAndBot();
    await request(app).post('/api/bots/' + bot.id + '/tv-webhook/rotate')
      .set('Authorization', 'Bearer ' + u.accessToken);

    const res = await request(app).post('/api/webhooks/tradingview/' + bot.id)
      .send({ secret: 'WRONG', symbol: 'BTCUSDT', side: 'long', price: 50000 });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_SIGNATURE');
  });

  it('webhook with correct secret creates a signal row', async () => {
    const { u, bot } = await regAndBot();
    const rot = await request(app).post('/api/bots/' + bot.id + '/tv-webhook/rotate')
      .set('Authorization', 'Bearer ' + u.accessToken);
    const secret = rot.body.secret;

    const res = await request(app).post('/api/webhooks/tradingview/' + bot.id)
      .send({ secret, symbol: 'BTCUSDT', side: 'long', price: 50000, stopLoss: 49000, tp1: 51000 });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.signalId).toBeTruthy();

    const sig = db.prepare('SELECT * FROM signals WHERE id = ?').get(res.body.signalId);
    expect(sig.strategy).toBe('tradingview');
    expect(sig.symbol).toBe('BTCUSDT');
    expect(sig.side).toBe('long');
    expect(sig.entry_price).toBe(50000);
    expect(sig.stop_loss).toBe(49000);
  });

  it('rejects invalid side / missing price', async () => {
    const { u, bot } = await regAndBot();
    const rot = await request(app).post('/api/bots/' + bot.id + '/tv-webhook/rotate')
      .set('Authorization', 'Bearer ' + u.accessToken);

    const res = await request(app).post('/api/webhooks/tradingview/' + bot.id)
      .send({ secret: rot.body.secret, symbol: 'BTCUSDT', side: 'sideways', price: 50000 });
    expect(res.status).toBe(400);
  });

  it('accepts buy/sell aliases for long/short', async () => {
    const { u, bot } = await regAndBot();
    const rot = await request(app).post('/api/bots/' + bot.id + '/tv-webhook/rotate')
      .set('Authorization', 'Bearer ' + u.accessToken);
    const res = await request(app).post('/api/webhooks/tradingview/' + bot.id)
      .send({ secret: rot.body.secret, symbol: 'BTCUSDT', side: 'buy', price: 50000, stopLoss: 49500 });
    expect(res.status).toBe(200);
    const sig = db.prepare('SELECT side FROM signals WHERE id = ?').get(res.body.signalId);
    expect(sig.side).toBe('long');
  });

  it('ignores alerts when bot is inactive', async () => {
    const { u, bot } = await regAndBot();
    await request(app).post('/api/bots/' + bot.id + '/tv-webhook/rotate')
      .set('Authorization', 'Bearer ' + u.accessToken);
    db.prepare('UPDATE trading_bots SET is_active = 0 WHERE id = ?').run(bot.id);
    const rot = db.prepare('SELECT tv_webhook_secret FROM trading_bots WHERE id = ?').get(bot.id);
    const res = await request(app).post('/api/webhooks/tradingview/' + bot.id)
      .send({ secret: rot.tv_webhook_secret, symbol: 'BTCUSDT', side: 'long', price: 50000, stopLoss: 49000 });
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.reason).toBe('bot_inactive');
  });
});
