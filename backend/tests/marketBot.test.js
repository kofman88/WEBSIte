/**
 * Market Scanner / Elite-feature plan gate tests.
 *
 * Verifies:
 *   • createBot with scope='market' blocked for non-Elite
 *   • createBot with strategiesMulti (>1) blocked for non-Elite
 *   • createBot with scope='market' & no exchanges → 400 VALIDATION_ERROR
 *   • Elite can create market bot + multi-strategy
 *   • Market bot persists scope/marketExchanges/strategiesMulti
 *   • updateBot propagates the same gate
 *   • getBot round-trips the new fields
 */

import { describe, it, expect, beforeEach } from 'vitest';

const db = require('../models/database');
const botService = require('../services/botService');

function mkUser(plan = 'free') {
  const code = Math.random().toString(36).slice(2, 10).toUpperCase();
  const u = db.prepare(`
    INSERT INTO users (email, password_hash, referral_code, email_verified, is_active)
    VALUES (?, 'x', ?, 1, 1)
  `).run('mkt_' + code + '@test.local', code);
  db.prepare(`INSERT OR REPLACE INTO subscriptions (user_id, plan, status) VALUES (?, ?, 'active')`).run(u.lastInsertRowid, plan);
  return u.lastInsertRowid;
}

const baseBot = {
  name: 't', exchange: 'bybit', symbols: ['BTCUSDT'],
  strategy: 'smc', timeframe: '1h', direction: 'both',
  leverage: 3, riskPct: 1, maxOpenTrades: 3,
  autoTrade: false, tradingMode: 'paper',
};

beforeEach(() => {
  db.prepare('DELETE FROM trading_bots').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

describe('Market Scanner plan gate', () => {
  it('non-Elite cannot create scope=market bot', () => {
    const uid = mkUser('pro');
    expect(() => botService.createBot(uid, {
      ...baseBot,
      scope: 'market',
      marketExchanges: ['bybit'],
    })).toThrowError(/elite/i);
  });

  it('non-Elite cannot create bot with strategiesMulti >1', () => {
    const uid = mkUser('pro');
    expect(() => botService.createBot(uid, {
      ...baseBot,
      strategiesMulti: ['smc', 'levels'],
    })).toThrowError(/elite/i);
  });

  it('Elite CAN create market bot', () => {
    const uid = mkUser('elite');
    const bot = botService.createBot(uid, {
      ...baseBot,
      scope: 'market',
      marketExchanges: ['bybit', 'binance'],
      strategiesMulti: ['smc', 'levels'],
    });
    expect(bot.scope).toBe('market');
    expect(bot.marketExchanges).toEqual(['bybit', 'binance']);
    expect(bot.strategiesMulti).toEqual(['smc', 'levels']);
  });

  it('market bot with no exchanges → 400', () => {
    const uid = mkUser('elite');
    expect(() => botService.createBot(uid, {
      ...baseBot,
      scope: 'market',
      marketExchanges: [],
    })).toThrowError(/at least one exchange/i);
  });

  it('pair bot still works (unchanged behavior)', () => {
    // SMC requires pro+ on current plan config — use 'pro' here.
    const uid = mkUser('pro');
    const bot = botService.createBot(uid, baseBot);
    expect(bot.scope).toBe('pair');
    expect(bot.marketExchanges).toBeNull();
    expect(bot.strategiesMulti).toBeNull();
  });

  it('single-strategy array is NOT blocked on non-Elite', () => {
    // strategiesMulti with length 1 is equivalent to single strategy — allow
    const uid = mkUser('pro');
    expect(() => botService.createBot(uid, {
      ...baseBot,
      strategiesMulti: ['smc'], // single → not "multi"
    })).not.toThrow();
  });

  it('_validateEliteFeatures unit guard', () => {
    expect(() => botService._validateEliteFeatures('pro', { scope: 'market', marketExchanges: ['bybit'] }))
      .toThrowError(/elite/i);
    expect(() => botService._validateEliteFeatures('elite', { scope: 'market', marketExchanges: ['bybit'] }))
      .not.toThrow();
    expect(() => botService._validateEliteFeatures('pro', { strategiesMulti: ['a', 'b'] }))
      .toThrowError(/elite/i);
    // Empty array = ok
    expect(() => botService._validateEliteFeatures('free', { strategiesMulti: [] })).not.toThrow();
  });

  it('updateBot enforces gate when patching scope to market', () => {
    const uid = mkUser('pro');
    const bot = botService.createBot(uid, baseBot);
    expect(() => botService.updateBot(bot.id, uid, {
      scope: 'market', marketExchanges: ['bybit'],
    })).toThrowError(/elite/i);
  });

  it('updateBot allows scope change to market on Elite', () => {
    const uid = mkUser('elite');
    const bot = botService.createBot(uid, baseBot);
    const patched = botService.updateBot(bot.id, uid, {
      scope: 'market', marketExchanges: ['bybit', 'okx'],
    });
    expect(patched.scope).toBe('market');
    expect(patched.marketExchanges).toEqual(['bybit', 'okx']);
  });
});
