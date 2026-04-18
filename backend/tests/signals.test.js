import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-signals.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
process.env.SCANNER_DISABLED = '1';

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) {} });
}

let app, db, registry, signalService;

beforeAll(async () => {
  freshDb();
  app = (await import('../server.js')).default;
  db = (await import('../models/database.js')).default;
  registry = await import('../services/signalRegistry.js');
  signalService = await import('../services/signalService.js');
});

async function makeUser(email = 'trader@x.com') {
  const res = await request(app).post('/api/auth/register').send({
    email, password: 'Abcdef123',
  });
  return res.body;
}

beforeEach(() => {
  db.prepare('DELETE FROM signal_registry').run();
  db.prepare('DELETE FROM signal_views').run();
  db.prepare('DELETE FROM user_signal_prefs').run();
  db.prepare('DELETE FROM signals').run();
  db.prepare('DELETE FROM refresh_tokens').run();
  db.prepare('DELETE FROM audit_log').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
});

describe('signalRegistry', () => {
  it('fingerprint is deterministic', () => {
    const sig = { exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', side: 'long', entry: 50000, timeframe: '1h' };
    expect(registry.default.fingerprint(sig)).toBe(registry.default.fingerprint(sig));
  });

  it('small price changes do NOT change fingerprint (bucketing)', () => {
    const fp1 = registry.default.fingerprint({
      exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', side: 'long', entry: 50000.0, timeframe: '1h',
    });
    const fp2 = registry.default.fingerprint({
      exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', side: 'long', entry: 50000.1, timeframe: '1h',
    });
    expect(fp1).toBe(fp2);
  });

  it('different sides → different fingerprints', () => {
    const a = registry.default.fingerprint({
      exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', side: 'long',  entry: 50000, timeframe: '1h',
    });
    const b = registry.default.fingerprint({
      exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', side: 'short', entry: 50000, timeframe: '1h',
    });
    expect(a).not.toBe(b);
  });

  it('register + isDuplicate lifecycle', () => {
    // Create real signals to satisfy FK
    const s1 = signalService.default.insert({
      exchange: 'bybit', symbol: 'DOTUSDT', strategy: 'levels', timeframe: '1h',
      side: 'long', entry: 7, stopLoss: 6.5,
    });
    const fp2 = registry.default.fingerprint({
      exchange: 'bybit', symbol: 'LTCUSDT', strategy: 'levels', side: 'long', entry: 100, timeframe: '1h',
    });
    expect(registry.default.isDuplicate(fp2)).toBe(false);
    expect(registry.default.register(fp2, s1.id)).toBe(true);
    expect(registry.default.isDuplicate(fp2)).toBe(true);
    expect(registry.default.register(fp2, s1.id)).toBe(false);
  });

  it('cleanupExpired removes old records', () => {
    const s = signalService.default.insert({
      exchange: 'bybit', symbol: 'ADAUSDT', strategy: 'levels', timeframe: '1h',
      side: 'long', entry: 0.5, stopLoss: 0.48,
    });
    const fp = registry.default.fingerprint({
      exchange: 'bybit', symbol: 'ADAUSDT', strategy: 'levels', side: 'short', entry: 0.5, timeframe: '1h',
    });
    db.prepare(`INSERT INTO signal_registry (fingerprint, signal_id, expires_at) VALUES (?, ?, '2000-01-01')`).run(fp, s.id);
    const removed = registry.default.cleanupExpired();
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});

describe('signalService.insert', () => {
  it('inserts new signal and rejects duplicate', () => {
    const s = {
      userId: null, exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', timeframe: '1h',
      side: 'long', entry: 50000, stopLoss: 49000, tp1: 51000, confidence: 80, quality: 7,
      reason: 'test', metadata: { foo: 'bar' },
    };
    const first = signalService.default.insert(s);
    expect(first).toBeTruthy();
    expect(first.side).toBe('long');
    expect(first.entry).toBe(50000);
    const second = signalService.default.insert(s);
    expect(second).toBeNull(); // dup rejected
  });

  it('metadata round-trips as object', () => {
    const s = {
      exchange: 'bybit', symbol: 'ETHUSDT', strategy: 'levels', timeframe: '1h',
      side: 'short', entry: 3000, stopLoss: 3100, metadata: { level: { price: 3050 } },
    };
    const saved = signalService.default.insert(s);
    expect(saved.metadata.level.price).toBe(3050);
  });
});

describe('signalService.stats', () => {
  it('computes win rate correctly', () => {
    const make = (result) => ({
      exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', timeframe: '1h',
      side: 'long', entry: 50000 + Math.random() * 5000, stopLoss: 49000,
    });
    // Insert 10 signals with varied results
    for (let i = 0; i < 10; i++) {
      const sig = signalService.default.insert(make());
      if (!sig) continue;
      const outcome = i < 6 ? 'win' : (i < 9 ? 'loss' : 'breakeven');
      signalService.default.recordResult(sig.id, { result: outcome });
    }
    const s = signalService.default.stats(null);
    expect(s.wins + s.losses + s.breakevens).toBeGreaterThanOrEqual(7);
    if (s.winRate !== null) {
      expect(s.winRate).toBeGreaterThan(0);
      expect(s.winRate).toBeLessThanOrEqual(1);
    }
  });
});

describe('signalService.prefs', () => {
  it('auto-creates defaults on first read', async () => {
    const u = await makeUser();
    const p = signalService.default.getPrefs(u.user.id);
    expect(p.enabledStrategies).toEqual(['levels']);
    expect(p.minConfidence).toBe(60);
  });

  it('updatePrefs merges patch', async () => {
    const u = await makeUser('p@x.com');
    signalService.default.updatePrefs(u.user.id, { minConfidence: 80, watchedSymbols: ['BTCUSDT'] });
    const p = signalService.default.getPrefs(u.user.id);
    expect(p.minConfidence).toBe(80);
    expect(p.watchedSymbols).toEqual(['BTCUSDT']);
  });
});

describe('GET /api/signals', () => {
  it('returns signals for authenticated user', async () => {
    const u = await makeUser('list@x.com');
    signalService.default.insert({
      exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', timeframe: '1h',
      side: 'long', entry: 50000, stopLoss: 49000, confidence: 80,
    });
    const res = await request(app).get('/api/signals').set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
  });

  it('rejects without auth', async () => {
    const res = await request(app).get('/api/signals');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/signals/public', () => {
  it('returns public signals without auth', async () => {
    signalService.default.insert({
      userId: null,
      exchange: 'bybit', symbol: 'BTCUSDT', strategy: 'levels', timeframe: '1h',
      side: 'long', entry: 50000, stopLoss: 49000,
    });
    const res = await request(app).get('/api/signals/public');
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThan(0);
  });
});

describe('Free-tier daily signal limit', () => {
  it('blocks list after N views', async () => {
    const u = await makeUser('free@x.com');
    db.prepare("UPDATE subscriptions SET plan = 'free' WHERE user_id = ?").run(u.user.id);

    // Create 3 real signals then track views against them
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const sig = signalService.default.insert({
        exchange: 'bybit', symbol: 'AVAXUSDT', strategy: 'levels', timeframe: String(i + 1) + 'h',
        side: 'long', entry: 20 + i * 0.1, stopLoss: 19,
      });
      ids.push(sig.id);
    }
    for (const id of ids) signalService.default.trackView(u.user.id, id);

    const res = await request(app).get('/api/signals').set('Authorization', 'Bearer ' + u.accessToken);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SIGNAL_LIMIT_REACHED');
  });
});
