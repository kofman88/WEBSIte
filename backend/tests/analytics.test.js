import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-analytics.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let app, db, analytics;
beforeAll(async () => {
  freshDb();
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
  analytics = (await import('../services/analyticsService.js')).default;
});
beforeEach(() => {
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM trading_bots').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

async function registerUser(email = 'a@x.com') {
  const r = await request(app).post('/api/auth/register').send({ email, password: 'Abcdef123' });
  return r.body;
}

function mkTrade(userId, overrides = {}) {
  const t = {
    user_id: userId, bot_id: null, signal_id: null,
    exchange: 'bybit', symbol: 'BTC/USDT', side: 'long', strategy: 'smc',
    timeframe: '1h', entry_price: 50000, exit_price: null,
    quantity: 0.01, leverage: 1, margin_used: 500,
    stop_loss: 49000, take_profit_1: 51000, take_profit_2: 52000, take_profit_3: 53000,
    realized_pnl: 0, realized_pnl_pct: 0, fees_paid: 0,
    status: 'open', close_reason: null, trading_mode: 'paper',
    opened_at: new Date().toISOString(), closed_at: null, ...overrides,
  };
  return db.prepare(`
    INSERT INTO trades (user_id, bot_id, signal_id, exchange, symbol, side, strategy, timeframe,
      entry_price, exit_price, quantity, leverage, margin_used, stop_loss,
      take_profit_1, take_profit_2, take_profit_3, realized_pnl, realized_pnl_pct, fees_paid,
      status, close_reason, trading_mode, opened_at, closed_at)
    VALUES (@user_id, @bot_id, @signal_id, @exchange, @symbol, @side, @strategy, @timeframe,
      @entry_price, @exit_price, @quantity, @leverage, @margin_used, @stop_loss,
      @take_profit_1, @take_profit_2, @take_profit_3, @realized_pnl, @realized_pnl_pct, @fees_paid,
      @status, @close_reason, @trading_mode, @opened_at, @closed_at)
  `).run(t).lastInsertRowid;
}

describe('analytics.totals', () => {
  it('aggregates wins/losses/pnl/winRate', async () => {
    const u = await registerUser();
    const uid = u.user.id;
    mkTrade(uid, { status: 'closed', realized_pnl: 100 });
    mkTrade(uid, { status: 'closed', realized_pnl: 50 });
    mkTrade(uid, { status: 'closed', realized_pnl: -30 });
    mkTrade(uid, { status: 'open' });
    const t = analytics.totals(uid);
    expect(t.totalTrades).toBe(4);
    expect(t.closedTrades).toBe(3);
    expect(t.openTrades).toBe(1);
    expect(t.wins).toBe(2);
    expect(t.losses).toBe(1);
    expect(t.totalPnl).toBe(120);
    expect(t.winRate).toBeCloseTo(2 / 3);
    expect(t.profitFactor).toBeCloseTo(150 / 30);
  });

  it('empty user → zeros', async () => {
    const u = await registerUser('empty@x.com');
    const t = analytics.totals(u.user.id);
    expect(t.totalTrades).toBe(0);
    expect(t.totalPnl).toBe(0);
    expect(t.winRate).toBeNull();
  });
});

describe('analytics breakdowns', () => {
  it('bySymbol groups correctly', async () => {
    const u = await registerUser();
    const uid = u.user.id;
    mkTrade(uid, { symbol: 'BTC/USDT', status: 'closed', realized_pnl: 100 });
    mkTrade(uid, { symbol: 'BTC/USDT', status: 'closed', realized_pnl: -20 });
    mkTrade(uid, { symbol: 'ETH/USDT', status: 'closed', realized_pnl: 50 });
    const rows = analytics.bySymbol(uid);
    expect(rows).toHaveLength(2);
    const btc = rows.find((r) => r.symbol === 'BTC/USDT');
    expect(btc.pnl).toBe(80);
    expect(btc.trades).toBe(2);
    expect(btc.wins).toBe(1);
  });

  it('byStrategy groups correctly', async () => {
    const u = await registerUser();
    const uid = u.user.id;
    mkTrade(uid, { strategy: 'smc', status: 'closed', realized_pnl: 100 });
    mkTrade(uid, { strategy: 'scalping', status: 'closed', realized_pnl: 50 });
    mkTrade(uid, { strategy: 'smc', status: 'closed', realized_pnl: -30 });
    const rows = analytics.byStrategy(uid);
    expect(rows.find((r) => r.strategy === 'smc').pnl).toBe(70);
    expect(rows.find((r) => r.strategy === 'scalping').pnl).toBe(50);
  });

  it('byMonth groups by YYYY-MM', async () => {
    const u = await registerUser();
    const uid = u.user.id;
    mkTrade(uid, { opened_at: '2026-01-15T10:00:00Z', status: 'closed', realized_pnl: 100 });
    mkTrade(uid, { opened_at: '2026-01-20T10:00:00Z', status: 'closed', realized_pnl: 50 });
    mkTrade(uid, { opened_at: '2026-02-01T10:00:00Z', status: 'closed', realized_pnl: -20 });
    const rows = analytics.byMonth(uid);
    expect(rows.find((r) => r.month === '2026-01').pnl).toBe(150);
    expect(rows.find((r) => r.month === '2026-02').pnl).toBe(-20);
  });
});

describe('analytics.equityCurve', () => {
  it('running cumulative sum of closed PnL', async () => {
    const u = await registerUser();
    const uid = u.user.id;
    const now = Date.now();
    mkTrade(uid, { status: 'closed', realized_pnl: 100, closed_at: new Date(now - 2 * 86400000).toISOString() });
    mkTrade(uid, { status: 'closed', realized_pnl: -30, closed_at: new Date(now - 1 * 86400000).toISOString() });
    mkTrade(uid, { status: 'closed', realized_pnl: 50,  closed_at: new Date(now).toISOString() });
    const pts = analytics.equityCurve(uid, { days: 90 });
    expect(pts).toHaveLength(3);
    expect(pts[0].equity).toBe(100);
    expect(pts[1].equity).toBe(70);
    expect(pts[2].equity).toBe(120);
  });
});

describe('API: /analytics/summary', () => {
  it('returns totals + byStrategy for auth user', async () => {
    const u = await registerUser('api@x.com');
    mkTrade(u.user.id, { strategy: 'smc', status: 'closed', realized_pnl: 100 });
    const res = await request(app).get('/api/analytics/summary')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.totals.totalPnl).toBe(100);
    expect(res.body.byStrategy[0].strategy).toBe('smc');
  });

  it('401 without auth', async () => {
    const res = await request(app).get('/api/analytics/summary');
    expect(res.status).toBe(401);
  });
});

describe('API: /analytics/trades + note PATCH', () => {
  it('list with filters + PATCH note', async () => {
    const u = await registerUser();
    const tradeId = mkTrade(u.user.id, { status: 'closed', realized_pnl: 42 });

    const list = await request(app).get('/api/analytics/trades?status=closed')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.trades[0].id).toBe(tradeId);

    const patch = await request(app).patch('/api/analytics/trades/' + tradeId + '/note')
      .set('Authorization', 'Bearer ' + u.accessToken)
      .send({ note: 'Good setup, tighter SL next time' });
    expect(patch.status).toBe(200);

    const list2 = await request(app).get('/api/analytics/trades?status=closed')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(list2.body.trades[0].note).toBe('Good setup, tighter SL next time');
  });

  it('PATCH other user\'s trade → 404', async () => {
    const u1 = await registerUser('t1@x.com');
    const u2 = await registerUser('t2@x.com');
    const tradeId = mkTrade(u1.user.id);
    const res = await request(app).patch('/api/analytics/trades/' + tradeId + '/note')
      .set('Authorization', 'Bearer ' + u2.accessToken).send({ note: 'hack' });
    expect(res.status).toBe(404);
  });
});

describe('API: /analytics/trades/export.csv', () => {
  it('streams a CSV with UTF-8 BOM + header row + data', async () => {
    const u = await registerUser('csv@x.com');
    mkTrade(u.user.id, { status: 'closed', realized_pnl: 12.34, symbol: 'SOL/USDT' });
    const res = await request(app).get('/api/analytics/trades/export.csv')
      .set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    // body starts with BOM (\uFEFF = EF BB BF in utf-8)
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    const lines = res.text.split('\n');
    expect(lines[0]).toContain('ID,Opened At');
    expect(lines[1]).toContain('SOL/USDT');
    expect(lines[1]).toContain('12.34');
  });
});
