import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-backtest.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let db, engine, service;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  engine = await import('../services/backtestEngine.js');
  service = await import('../services/backtestService.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM backtest_trades').run();
  db.prepare('DELETE FROM backtests').run();
  db.prepare('DELETE FROM candles_cache').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

function makeUser(plan = 'pro') {
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, is_active)
    VALUES (?, 'x', ?, 1)
  `).run(`test-${Date.now()}-${Math.random()}@x.com`, 'R' + Math.random().toString(36).slice(2, 9).toUpperCase());
  db.prepare(`INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, 'active')`)
    .run(info.lastInsertRowid, plan);
  return info.lastInsertRowid;
}

// Seed candles_cache so engine doesn't need network
function seedCandles(exchange, symbol, timeframe, count = 300, basePrice = 100) {
  const tfMs = { '1h': 3600000, '15m': 900000, '1d': 86400000 }[timeframe] || 3600000;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO candles_cache (exchange, symbol, timeframe, open_time, open, high, low, close, volume, close_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const t = now - (count - i) * tfMs;
      // Wave that creates pivots + gentle uptrend
      const p = basePrice + Math.sin(i / 8) * 4 + i * 0.02;
      const noise = p * 0.005;
      const o = i > 0 ? basePrice + Math.sin((i - 1) / 8) * 4 + (i - 1) * 0.02 : p;
      stmt.run(exchange, symbol, timeframe, t,
        o, Math.max(o, p) + noise, Math.min(o, p) - noise, p,
        100 + Math.random() * 50, t + tfMs - 1);
    }
  });
  tx();
}

describe('_computeQty', () => {
  it('returns risk-adjusted quantity', () => {
    const qty = engine._computeQty(10000, 100, 98, 1);
    // risk = 10000 * 0.01 = 100, sl_dist = 2, qty = 50
    expect(qty).toBe(50);
  });
  it('returns 0 when SL equals entry', () => {
    expect(engine._computeQty(10000, 100, 100, 1)).toBe(0);
  });
});

describe('_simulateBarExit (LONG)', () => {
  const pos = () => ({
    symbol: 'BTCUSDT', side: 'long', entry: 100, stopLoss: 95,
    tp1: 105, tp2: 110, tp3: 115,
    qty: 10, qtyRemaining: 10, tp1Hit: false, tp2Hit: false,
    entryTime: 0, entryIndex: 0,
  });
  const cfg = { feePct: 0, slippagePct: 0 };

  it('closes at SL when low touches it', () => {
    const p = pos();
    const bar = [1000, 100, 101, 94, 96, 100, 0]; // low=94 < SL=95
    const r = engine._simulateBarExit(p, bar, cfg);
    expect(r.closed).toBe(true);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0].closeReason).toBe('sl');
    expect(r.fills[0].pnl).toBeCloseTo((95 - 100) * 10); // -50
  });

  it('fires TP1 + moves SL to BE', () => {
    const p = pos();
    const bar = [1000, 100, 106, 99, 105, 100, 0];
    const r = engine._simulateBarExit(p, bar, cfg);
    expect(r.closed).toBe(false);
    expect(r.fills[0].closeReason).toBe('tp1');
    expect(p.tp1Hit).toBe(true);
    expect(p.stopLoss).toBe(100); // BE
  });

  it('fires TP1+TP2 in one bar, trails SL to TP1', () => {
    const p = pos();
    const bar = [1000, 100, 112, 99, 110, 100, 0];
    const r = engine._simulateBarExit(p, bar, cfg);
    expect(r.fills.some((f) => f.closeReason === 'tp1')).toBe(true);
    expect(r.fills.some((f) => f.closeReason === 'tp2')).toBe(true);
    expect(p.stopLoss).toBe(105);
  });

  it('full trip tp1+tp2+tp3 closes position', () => {
    const p = pos();
    const bar = [1000, 100, 116, 99, 115, 100, 0];
    const r = engine._simulateBarExit(p, bar, cfg);
    expect(r.closed).toBe(true);
    expect(r.fills.filter((f) => f.closeReason === 'tp3')).toHaveLength(1);
  });
});

describe('_simulateBarExit (SHORT)', () => {
  const pos = () => ({
    symbol: 'BTCUSDT', side: 'short', entry: 100, stopLoss: 105,
    tp1: 95, tp2: 90, tp3: 85,
    qty: 10, qtyRemaining: 10, tp1Hit: false, tp2Hit: false,
    entryTime: 0,
  });
  const cfg = { feePct: 0, slippagePct: 0 };

  it('closes at SL when high touches', () => {
    const bar = [1000, 100, 106, 99, 103, 100, 0];
    const r = engine._simulateBarExit(pos(), bar, cfg);
    expect(r.closed).toBe(true);
    expect(r.fills[0].closeReason).toBe('sl');
  });

  it('fires TP1 and trails SL to entry', () => {
    const p = pos();
    const bar = [1000, 100, 101, 94, 95, 100, 0];
    const r = engine._simulateBarExit(p, bar, cfg);
    expect(r.fills[0].closeReason).toBe('tp1');
    expect(p.stopLoss).toBe(100);
  });
});

describe('_buildMetrics', () => {
  it('computes winRate, profitFactor, drawdown', () => {
    const trades = [
      { pnl:  100, pnlPct: 1,  exitTime: Date.UTC(2025, 0, 1), entryTime: Date.UTC(2025, 0, 1) - 3600000 },
      { pnl:  100, pnlPct: 1,  exitTime: Date.UTC(2025, 0, 2), entryTime: Date.UTC(2025, 0, 2) - 3600000 },
      { pnl: -50,  pnlPct: -0.5, exitTime: Date.UTC(2025, 0, 3), entryTime: Date.UTC(2025, 0, 3) - 3600000 },
      { pnl:  200, pnlPct: 2,  exitTime: Date.UTC(2025, 0, 4), entryTime: Date.UTC(2025, 0, 4) - 3600000 },
    ];
    const m = engine._buildMetrics({
      capital: 10000,
      equity: 10350,
      equityCurve: [
        [Date.UTC(2025, 0, 1), 10000], [Date.UTC(2025, 0, 1, 12), 10100],
        [Date.UTC(2025, 0, 2), 10200], [Date.UTC(2025, 0, 3), 10150],
        [Date.UTC(2025, 0, 4), 10350],
      ],
      allTrades: trades,
      perSymbol: { BTCUSDT: { trades: 4, wins: 3, pnl: 350 } },
      maxDrawdownPct: 0.5, maxDrawdownUsd: 50,
    });
    expect(m.totalTrades).toBe(4);
    expect(m.winningTrades).toBe(3);
    expect(m.losingTrades).toBe(1);
    expect(m.winRatePct).toBe(75);
    expect(m.totalPnlUsd).toBe(350);
    expect(m.profitFactor).toBeCloseTo(400 / 50);
    expect(m.maxConsecutiveWins).toBe(2);
  });
});

describe('backtestService gating', () => {
  it('free plan: 0 backtests/day → 403', () => {
    const uid = makeUser('free');
    expect(() => service.default.createBacktest(uid, {
      name: 'x', strategy: 'levels', exchange: 'bybit', symbols: ['BTCUSDT'],
      timeframe: '1h', startDate: '2025-01-01', endDate: '2025-01-10',
      initialCapital: 1000,
    })).toThrowError(/BACKTEST_LIMIT_REACHED|plan allows/);
  });

  it('plan does not grant strategy → 403', () => {
    const uid = makeUser('free');
    expect(() => service.default.createBacktest(uid, {
      name: 'x', strategy: 'scalping', exchange: 'bybit', symbols: ['BTCUSDT'],
      timeframe: '1h', startDate: '2025-01-01', endDate: '2025-01-10',
      initialCapital: 1000,
    })).toThrowError();
  });
});

describe('End-to-end: run a real backtest', () => {
  it('creates pending → runs → persists results', async () => {
    const uid = makeUser('pro');
    seedCandles('bybit', 'BTCUSDT', '1h', 400, 100);

    // Create bt directly in DB (bypass service queue so we can inspect synchronously)
    const ins = db.prepare(`
      INSERT INTO backtests
        (user_id, name, strategy, exchange, symbols, timeframe,
         start_date, end_date, initial_capital, status, progress_pct)
      VALUES (?, 'e2e', 'levels', 'bybit', ?, '1h', ?, ?, 10000, 'pending', 0)
    `).run(uid, JSON.stringify(['BTCUSDT']),
      new Date(Date.now() - 400 * 3600000).toISOString().slice(0, 10),
      new Date().toISOString().slice(0, 10));
    const btId = ins.lastInsertRowid;

    // Run engine directly
    const metrics = await engine.runBacktest(btId);
    expect(metrics).toBeTruthy();
    expect(metrics.totalTrades).toBeGreaterThanOrEqual(0);
    expect(metrics.equityCurve.length).toBeGreaterThan(1);

    // Check DB final state
    const row = db.prepare('SELECT * FROM backtests WHERE id = ?').get(btId);
    expect(row.status).toBe('completed');
    expect(row.progress_pct).toBe(100);
    expect(row.duration_ms).toBeGreaterThan(0);

    // If trades happened they're persisted
    const tradeCount = db.prepare('SELECT COUNT(*) as n FROM backtest_trades WHERE backtest_id = ?').get(btId).n;
    expect(tradeCount).toBe(metrics.totalTrades);
  });

  it('unknown strategy → status=failed', async () => {
    const uid = makeUser('elite');
    const ins = db.prepare(`
      INSERT INTO backtests
        (user_id, name, strategy, exchange, symbols, timeframe,
         start_date, end_date, initial_capital, status, progress_pct)
      VALUES (?, 'bad', 'nosuchstrat', 'bybit', ?, '1h', '2025-01-01', '2025-01-10', 10000, 'pending', 0)
    `).run(uid, JSON.stringify(['BTCUSDT']));
    const btId = ins.lastInsertRowid;

    await expect(engine.runBacktest(btId)).rejects.toThrow();

    const row = db.prepare('SELECT status, error_message FROM backtests WHERE id = ?').get(btId);
    expect(row.status).toBe('failed');
    expect(row.error_message).toContain('Unknown strategy');
  });
});
