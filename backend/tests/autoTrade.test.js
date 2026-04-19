import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-autotrade.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let db, autoTrade, partialTp, breaker;

beforeAll(async () => {
  freshDb();
  db = (await import('../models/database.js')).default;
  autoTrade = await import('../services/autoTradeService.js');
  partialTp = await import('../services/partialTpManager.js');
  breaker = await import('../services/circuitBreaker.js');
});

beforeEach(() => {
  db.prepare('DELETE FROM trade_fills').run();
  db.prepare('DELETE FROM trades').run();
  db.prepare('DELETE FROM trading_bots').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM system_kv').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  db.prepare('DELETE FROM candles_cache').run();
});

function makeUser(plan = 'pro') {
  const info = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, is_active)
    VALUES (?, 'x', ?, 1)
  `).run(`at-${Date.now()}-${Math.random()}@x.com`, 'R' + Math.random().toString(36).slice(2, 9).toUpperCase());
  db.prepare(`INSERT INTO subscriptions (user_id, plan, status) VALUES (?, ?, 'active')`)
    .run(info.lastInsertRowid, plan);
  return info.lastInsertRowid;
}

function makeBot(userId, overrides = {}) {
  const d = {
    name: 'test', exchange: 'bybit', symbols: JSON.stringify(['BTCUSDT']),
    strategy: 'levels', timeframe: '1h', direction: 'both',
    leverage: 1, risk_pct: 1, max_open_trades: 3,
    auto_trade: 1, trading_mode: 'paper', is_active: 1,
    ...overrides,
  };
  const info = db.prepare(`
    INSERT INTO trading_bots
      (user_id, name, exchange, symbols, strategy, timeframe, direction,
       leverage, risk_pct, max_open_trades, auto_trade, trading_mode, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, d.name, d.exchange, d.symbols, d.strategy, d.timeframe, d.direction,
    d.leverage, d.risk_pct, d.max_open_trades, d.auto_trade, d.trading_mode, d.is_active);
  return db.prepare('SELECT * FROM trading_bots WHERE id = ?').get(info.lastInsertRowid);
}

function mockSignal(overrides = {}) {
  return {
    id: null,
    strategy: 'levels',
    symbol: 'BTCUSDT',
    side: 'long',
    entry: 100,
    stopLoss: 95,
    tp1: 105, tp2: 110, tp3: 115,
    confidence: 80, quality: 7,
    reason: 'test',
    ...overrides,
  };
}

// ── autoTradeService.executeSignal ──────────────────────────────────────
describe('autoTradeService: paper mode', () => {
  it('opens a paper trade successfully', async () => {
    const uid = makeUser('pro');
    const bot = makeBot(uid);
    const trade = await autoTrade.default.executeSignal(mockSignal(), bot);
    expect(trade).toBeTruthy();
    expect(trade.trading_mode).toBe('paper');
    expect(trade.status).toBe('open');
    expect(trade.side).toBe('long');
    expect(trade.entry_price).toBe(100);
    expect(trade.stop_loss).toBe(95);
    // quantity = equity * risk% / sl_dist = 10000 * 0.01 / 5 = 20
    expect(trade.quantity).toBeCloseTo(20, 1);

    const fills = db.prepare('SELECT * FROM trade_fills WHERE trade_id = ?').all(trade.id);
    expect(fills).toHaveLength(1);
    expect(fills[0].event_type).toBe('entry');
  });

  it('rejects when plan lacks autoTrade', async () => {
    const uid = makeUser('starter');
    const bot = makeBot(uid);
    const trade = await autoTrade.default.executeSignal(mockSignal(), bot);
    expect(trade).toBeNull();
  });

  it('rejects when max_open_trades reached', async () => {
    const uid = makeUser('pro');
    const bot = makeBot(uid, { max_open_trades: 1 });
    await autoTrade.default.executeSignal(mockSignal({ entry: 100 }), bot);
    // Second signal with different entry
    const trade2 = await autoTrade.default.executeSignal(mockSignal({ entry: 101 }), bot);
    expect(trade2).toBeNull();
  });

  it('rejects when qty would be zero (SL = entry)', async () => {
    const uid = makeUser('pro');
    const bot = makeBot(uid);
    const trade = await autoTrade.default.executeSignal(
      mockSignal({ entry: 100, stopLoss: 100 }), bot
    );
    expect(trade).toBeNull();
  });
});

// ── Circuit breaker ─────────────────────────────────────────────────────
describe('circuitBreaker', () => {
  it('allows when no recent losses', () => {
    const uid = makeUser('pro');
    const result = breaker.default.check(uid);
    expect(result.allow).toBe(true);
  });

  it('trips when daily loss exceeds threshold', () => {
    const uid = makeUser('pro');
    // Insert losing trades totaling > 10% of default 10k ref balance
    db.prepare(`
      INSERT INTO trades (user_id, exchange, symbol, side, entry_price, quantity,
        realized_pnl, status, closed_at, trading_mode, stop_loss)
      VALUES (?, 'bybit', 'BTCUSDT', 'long', 100, 10, -1500, 'closed', datetime('now', '-1 hour'), 'live', 95)
    `).run(uid);

    const result = breaker.default.check(uid, { referenceBalance: 10000, dailyLossPct: 10 });
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('CIRCUIT_BREAKER_TRIPPED');
  });

  it('tripped state pauses active bots', () => {
    const uid = makeUser('pro');
    makeBot(uid, { is_active: 1 });
    makeBot(uid, { is_active: 1 });
    breaker.default.trip(uid, { dailyPnl: -2000, threshold: -1000, reason: 'test' });
    const active = db.prepare(`SELECT COUNT(*) as n FROM trading_bots WHERE user_id = ? AND is_active = 1`).get(uid).n;
    expect(active).toBe(0);
  });

  it('reset() clears the flag', () => {
    const uid = makeUser('pro');
    breaker.default.trip(uid, { dailyPnl: -2000, threshold: -1000 });
    expect(breaker.default.getBreakerState(uid)).toBeTruthy();
    breaker.default.reset(uid);
    expect(breaker.default.getBreakerState(uid)).toBeNull();
  });

  it('auto-trade blocked when breaker tripped', async () => {
    const uid = makeUser('pro');
    const bot = makeBot(uid);
    breaker.default.trip(uid, { dailyPnl: -2000, threshold: -1000 });
    // Re-activate bot manually (breaker paused it)
    db.prepare(`UPDATE trading_bots SET is_active = 1 WHERE id = ?`).run(bot.id);
    const trade = await autoTrade.default.executeSignal(mockSignal(), bot);
    expect(trade).toBeNull();
  });
});

// ── partialTpManager (paper end-to-end) ─────────────────────────────────
describe('partialTpManager (paper simulation)', () => {
  // Mock marketDataService by providing candles in candles_cache
  function seedCandles(exchange, symbol, timeframe, candles) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO candles_cache (exchange, symbol, timeframe, open_time, open, high, low, close, volume, close_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const c of candles) {
        stmt.run(exchange, symbol, timeframe, c[0], c[1], c[2], c[3], c[4], c[5] || 100, c[6] || c[0] + 3599999);
      }
    });
    tx();
  }

  it('SL hit closes the position with sl close_reason', async () => {
    const uid = makeUser('pro');
    const bot = makeBot(uid);
    const trade = await autoTrade.default.executeSignal(mockSignal({
      entry: 100, stopLoss: 95, tp1: 105, tp2: 110, tp3: 115,
    }), bot);
    expect(trade).toBeTruthy();

    // Manually adjust opened_at back by 2h so future candles count as fresh
    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    db.prepare(`UPDATE trades SET opened_at = ? WHERE id = ?`).run(past, trade.id);

    // Seed a candle AFTER the trade's entry time that breaks SL
    const future = Math.floor(Date.now() / 60000) * 60000 - 3600_000;
    seedCandles('bybit', 'BTCUSDT', '1h', [
      [future, 99, 99, 94, 95, 100, future + 3599999],
    ]);

    // init partialTp with a real marketData service from the project
    const marketData = (await import('../services/marketDataService.js')).default || await import('../services/marketDataService.js');
    partialTp.default.init({ marketData });

    await partialTp.default.tickOpen();

    const after = db.prepare('SELECT * FROM trades WHERE id = ?').get(trade.id);
    expect(after.status).toBe('closed');
    expect(after.close_reason).toBe('sl');
  });

  it('TP1 partial close moves SL to breakeven', async () => {
    const uid = makeUser('pro');
    const bot = makeBot(uid);
    const trade = await autoTrade.default.executeSignal(mockSignal({
      entry: 100, stopLoss: 95, tp1: 105, tp2: 110, tp3: 115,
    }), bot);

    const past = new Date(Date.now() - 2 * 3600_000).toISOString();
    db.prepare(`UPDATE trades SET opened_at = ? WHERE id = ?`).run(past, trade.id);

    // Candle that hits TP1 but not TP2
    const future = Math.floor(Date.now() / 60000) * 60000 - 3600_000;
    seedCandles('bybit', 'BTCUSDT', '1h', [
      [future, 100, 106, 99, 105.5, 100, future + 3599999],
    ]);

    const marketData = await import('../services/marketDataService.js');
    partialTp.default.init({ marketData: marketData.default || marketData });

    await partialTp.default.tickOpen();

    const after = db.prepare('SELECT * FROM trades WHERE id = ?').get(trade.id);
    // SL should have moved to entry price
    expect(after.stop_loss).toBeCloseTo(100, 4);
    // TP1 fill recorded
    const fills = db.prepare(`SELECT * FROM trade_fills WHERE trade_id = ?`).all(trade.id);
    const tp1Fill = fills.find((f) => f.event_type === 'tp1');
    expect(tp1Fill).toBeTruthy();
  });
});

// ── qty sizing ──────────────────────────────────────────────────────────
describe('_computeQty', () => {
  it('scales linearly with leverage', () => {
    const q1 = autoTrade.default._computeQty(10000, 100, 95, 1, 1);
    const q5 = autoTrade.default._computeQty(10000, 100, 95, 1, 5);
    expect(q5).toBeCloseTo(q1 * 5);
  });
});
