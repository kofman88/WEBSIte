import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-optimizer.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let db, optimizer, optService;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  optimizer = await import('../services/optimizer.js');
  optService = await import('../services/optimizationService.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM optimizations').run();
  db.prepare('DELETE FROM backtest_trades').run();
  db.prepare('DELETE FROM backtests').run();
  db.prepare('DELETE FROM candles_cache').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

function makeUser(plan = 'elite') {
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, is_active)
    VALUES (?, 'x', ?, 1)
  `).run(`opt-${Date.now()}-${Math.random()}@x.com`, 'R' + Math.random().toString(36).slice(2, 9).toUpperCase());
  db.prepare(`INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, 'active')`)
    .run(info.lastInsertRowid, plan);
  return info.lastInsertRowid;
}

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
      const p = basePrice + Math.sin(i / 8) * 4 + i * 0.02;
      const noise = p * 0.005;
      const o = i > 0 ? basePrice + Math.sin((i - 1) / 8) * 4 + (i - 1) * 0.02 : p;
      stmt.run(exchange, symbol, timeframe, t, o, Math.max(o, p) + noise, Math.min(o, p) - noise, p,
        100 + Math.random() * 50, t + tfMs - 1);
    }
  });
  tx();
}

describe('enumerateGrid', () => {
  it('cartesian product of int ranges', () => {
    const combos = optimizer.default.enumerateGrid({
      a: { type: 'int', min: 1, max: 3, step: 1 },
      b: { type: 'int', min: 10, max: 20, step: 5 },
    });
    expect(combos.length).toBe(9); // 3 × 3
    expect(combos).toContainEqual({ a: 1, b: 10 });
    expect(combos).toContainEqual({ a: 3, b: 20 });
  });

  it('choice type', () => {
    const combos = optimizer.default.enumerateGrid({
      strat: { type: 'choice', choices: ['levels', 'smc'] },
      n: { type: 'int', min: 5, max: 10, step: 5 },
    });
    expect(combos.length).toBe(4);
  });

  it('respects maxCombos cap', () => {
    const combos = optimizer.default.enumerateGrid({
      a: { type: 'int', min: 0, max: 100, step: 1 },
    }, 10);
    expect(combos.length).toBeLessThanOrEqual(10);
  });
});

describe('sampleRandom', () => {
  it('returns values within ranges', () => {
    const space = {
      a: { type: 'int', min: 1, max: 5 },
      b: { type: 'float', min: 0, max: 1 },
      c: { type: 'choice', choices: ['x', 'y', 'z'] },
    };
    for (let i = 0; i < 20; i++) {
      const s = optimizer.default.sampleRandom(space);
      expect(s.a).toBeGreaterThanOrEqual(1);
      expect(s.a).toBeLessThanOrEqual(5);
      expect(Number.isInteger(s.a)).toBe(true);
      expect(s.b).toBeGreaterThanOrEqual(0);
      expect(s.b).toBeLessThanOrEqual(1);
      expect(['x', 'y', 'z']).toContain(s.c);
    }
  });
});

describe('splitDates', () => {
  it('60/20/20 default split', () => {
    const s = optimizer.default.splitDates('2025-01-01', '2025-02-01');
    // 31 days → 60% ≈ day 19, 80% ≈ day 25
    expect(s.trainStart).toBe('2025-01-01');
    expect(s.testEnd).toBe('2025-02-01');
    expect(new Date(s.trainEnd).getTime()).toBeGreaterThan(new Date(s.trainStart).getTime());
    expect(new Date(s.valEnd).getTime()).toBeGreaterThan(new Date(s.trainEnd).getTime());
    expect(new Date(s.testEnd).getTime()).toBeGreaterThanOrEqual(new Date(s.valEnd).getTime());
  });
});

describe('gridSearch (real end-to-end on seeded candles)', () => {
  it('runs trials and returns best params', async () => {
    const uid = makeUser('elite');
    seedCandles('bybit', 'BTCUSDT', '1h', 300, 100);

    const result = await optimizer.default.gridSearch({
      baseConfig: {
        name: 'test', strategy: 'levels', exchange: 'bybit',
        symbols: ['BTCUSDT'], timeframe: '1h',
        startDate: new Date(Date.now() - 300 * 3600000).toISOString().slice(0, 10),
        endDate: new Date().toISOString().slice(0, 10),
        initialCapital: 10000,
      },
      paramSpace: {
        minQuality: { type: 'int', min: 3, max: 7, step: 2 },
      },
      objective: 'totalPnlPct',
      maxCombos: 3,
      userId: uid,
    });

    expect(result.method).toBe('grid');
    expect(result.trials).toBe(3);
    expect(result.allResults).toHaveLength(3);
    for (const r of result.allResults) {
      expect(r.params).toHaveProperty('minQuality');
    }
    // Ephemeral backtests cleaned up
    const btCount = db.prepare('SELECT COUNT(*) as n FROM backtests').get().n;
    expect(btCount).toBe(0);
  }, 60_000);
});

describe('optimizationService (gating)', () => {
  it('rejects non-elite plan', () => {
    const uid = makeUser('pro');
    expect(() => optService.default.createOptimization(uid, {
      baseConfig: {
        name: 'x', strategy: 'levels', exchange: 'bybit', symbols: ['BTCUSDT'],
        timeframe: '1h', startDate: '2025-01-01', endDate: '2025-01-10', initialCapital: 1000,
      },
      paramSpace: { minQuality: { type: 'int', min: 3, max: 7 } },
      objective: 'profitFactor',
      nTrials: 5,
    })).toThrowError(/Elite/);
  });

  it('elite plan gets queued', () => {
    const uid = makeUser('elite');
    const opt = optService.default.createOptimization(uid, {
      baseConfig: {
        name: 'x', strategy: 'levels', exchange: 'bybit', symbols: ['BTCUSDT'],
        timeframe: '1h', startDate: '2025-01-01', endDate: '2025-01-10', initialCapital: 1000,
      },
      paramSpace: { minQuality: { type: 'int', min: 3, max: 7 } },
      objective: 'profitFactor',
      nTrials: 2,
    });
    expect(opt.id).toBeGreaterThan(0);
    // Status may be 'pending' or already 'running' if the queue picked it up fast
    expect(['pending', 'running', 'completed', 'failed']).toContain(opt.status);
    expect(opt.objective).toBe('profitFactor');
    expect(opt.nTrials).toBe(2);
  });
});
