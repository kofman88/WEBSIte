/**
 * ghostCleanup.js vs the bot: db_cleanup_ghost_trades(uid, 30), db_cleanup_ghost_trades_all(3)
 * and the cache_gc trades GC run on the bot-schema SQLite seeded by gen/gen_stats_vectors.py
 * (after all its reads); the same rows here → same changed rows, counts and survivors.
 *   python: await db.trades.db_cleanup_ghost_trades_all(max_age_days=3)  → (4, 198)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const GC = nodeRequire('../../../services/engine/ghostCleanup.js');
const SO = nodeRequire('../../../services/engine/signalOutcome.js');
const { engineDb, seedUsers, seedTrades } = nodeRequire('./helpers.js');

const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures', 'stats_vectors.json'), 'utf8'));
const NOW = V.now;

function seeded() {
  const db = engineDb();
  seedUsers(db, V.users);
  seedTrades(db, V.trades, V.insert_cols);
  return db;
}
const snap = (db) => db.prepare('SELECT trade_id, result, state, skip_reason, state_changed_at FROM signal_trades ORDER BY trade_id').all();

afterEach(() => { vi.useRealTimers(); });

describe('ghost cleanup — same rows as the bot', () => {
  it('per user (30 d), then all users (3 d), then the 30-day SKIP/ORPHAN GC', () => {
    const db = seeded();
    const g = V.ghost;
    expect(GC.cleanupGhostTrades(db, 103, { maxAgeDays: 30, now: NOW })).toEqual(g.one_user);
    expect(snap(db)).toEqual(g.after_one_user);
    expect(GC.cleanupGhostTradesAll(db, { maxAgeDays: 3, now: NOW })).toEqual(g.all);
    expect(snap(db)).toEqual(g.after_all);
    expect(GC.purgeOldSkips(db, { now: NOW })).toBe(g.gc_deleted);
    expect(db.prepare('SELECT trade_id FROM signal_trades ORDER BY trade_id').all().map((r) => r.trade_id)).toEqual(g.after_gc);
  });

  it('branch (a) never touches a delivered card; branch (b) is age-only like the bot (status stays by stage / expired)', () => {
    const db = seeded();
    const before = new Map(db.prepare('SELECT * FROM signal_trades').all().map((r) => [r.trade_id, r]));
    const [a] = GC.cleanupGhostTradesAll(db, { maxAgeDays: 100000, now: NOW });     // (b) off: only (a) applies
    expect(a).toBe(V.ghost.all[0]);
    const after = db.prepare('SELECT * FROM signal_trades').all();
    for (const r of after) {
      const b = before.get(r.trade_id);
      if (r.result !== b.result) {
        expect(Number(b.signal_msg_id || 0)).toBe(0);
        expect(b.order_id || '').toBe('');
        expect([r.result, r.state, r.skip_reason]).toEqual(['SKIP', 'FAILED', 'ghost']);
      }
    }
    // (b): a delivered card older than the window becomes SKIP/ghost, but stays an outcome-less
    // countable signal resolved by its stage — never the ghost "skip" status
    const delivered = after.filter((r) => Number(r.signal_msg_id) > 0 && r.result === '' && r.created_at < NOW - 3 * 86400);
    expect(delivered.length).toBeGreaterThan(0);
    GC.cleanupGhostTradesAll(db, { maxAgeDays: 3, now: NOW });
    for (const d of delivered) {
      const r = db.prepare('SELECT * FROM signal_trades WHERE trade_id=?').get(d.trade_id);
      expect(r.result).toBe('SKIP');
      expect(SO.signalStatus(r, NOW)).not.toBe('skip');
      expect(SO.signalStatus(r, NOW)).toBe(SO.signalStatus(d, NOW));
    }
  });

  it('opt-in protectDelivered: no row with signal_msg_id > 0 is rewritten by either branch', () => {
    const db = seeded();
    const before = new Map(db.prepare('SELECT * FROM signal_trades').all().map((r) => [r.trade_id, r]));
    const [a, b] = GC.cleanupGhostTradesAll(db, { maxAgeDays: 3, now: NOW, protectDelivered: true });
    expect(a).toBe(V.ghost.all[0]);
    expect(b).toBeLessThan(V.ghost.all[1]);
    for (const r of db.prepare('SELECT * FROM signal_trades').all()) {
      const was = before.get(r.trade_id);
      if (Number(was.signal_msg_id || 0) > 0) expect([r.result, r.state, r.skip_reason]).toEqual([was.result, was.state, was.skip_reason]);
    }
  });

  it('runGhostCleanup / runTradesGc log lines; the loop runs after 300 s, then every 6 h', () => {
    const db = seeded();
    const lines = [];
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(`W ${m}`), debug: () => {} };
    // fresh DB: the 11 rows the per-user pass took above are still '' here, so they land in (b)
    const want = [V.ghost.all[0] + V.ghost.one_user[0], V.ghost.all[1] + V.ghost.one_user[1]];
    expect(GC.runGhostCleanup(db, { log, now: NOW })).toEqual(want);
    expect(lines).toEqual([`ghost_cleanup: SKIP'd ${want[0]} no-order + ${want[1]} old trades`]);
    expect(GC.runGhostCleanup(db, { log, now: NOW })).toEqual([0, 0]);
    expect(lines.length).toBe(1);
    const n = GC.runTradesGc(db, { log, now: NOW });
    expect(n).toBeGreaterThan(0);
    expect(lines[1]).toBe(`🧹 Trades GC: удалено ${n} старых SKIP/ORPHAN записей`);
    const broken = { transaction: () => { throw new Error('locked'); } };
    expect(GC.runGhostCleanup(broken, { log })).toEqual([0, 0]);
    expect(lines[2]).toBe('W _ghost_cleanup_loop: locked');

    vi.useFakeTimers();
    let calls = 0;
    const counting = { transaction: (fn) => () => { calls++; return [0, 0]; }, prepare: () => ({ run: () => ({ changes: 0 }) }) };
    const h = GC.startGhostCleanupLoop(counting, { log });
    vi.advanceTimersByTime(299_999);
    expect(calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(6 * 3600 * 1000);
    expect(calls).toBe(2);
    h.stop();
    vi.advanceTimersByTime(12 * 3600 * 1000);
    expect(calls).toBe(2);
  });
});
