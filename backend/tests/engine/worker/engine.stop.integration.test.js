/**
 * Engine integration: the worker is stopped while the three REAL scanners are inside their cycles
 * of a 4h close (engineHarness: fake feed + golden candles → runWorker over a real MessageChannel
 * → main-thread delivery + the real notifier).
 *
 * bot.py's shutdown cancels every task: the running LEVELS / SMC / VOLUME cycles get a
 * CancelledError at their next await. The port's equivalent (scheduler.stop → the stop event /
 * the abort) must end every loop inside the 4 s window, leave no half-written state (a row is
 * either delivered — feed notification + signal_msg_id — or SKIP not_delivered, [NOT-DELIVERED]
 * ST-6), log no error, and nothing may run afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-m9b-engine-stop.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const req = createRequire(import.meta.url);
const { runEngine, T4 } = req('./engineHarness.js');

let R = null;

describe('engine worker integration — a stop in the middle of the 4h-close cycles of the three real scanners', () => {
  beforeAll(async () => { R = await runEngine({ vi, stopDuringT4: true }); }, 600_000);
  afterAll(() => { vi.useRealTimers(); });

  it('the stop came while the cycles were running (SMC had not finished its pass)', () => {
    expect(R.atT4.passes.smc).toBe(R.atT4.p4.smc);
    const lines = R.logs.filter(([t]) => t >= T4).map(([, , m]) => m);
    expect(lines.some((m) => m.startsWith('SMC scan: '))).toBe(true);
    expect(lines.some((m) => m.startsWith('🔍 Цикл #3'))).toBe(true);
  });

  it('every loop ended inside the 4 s stop window; the SMC cycle was cancelled like the bot\'s ("SMC Scanner stopped."), no error logged', () => {
    expect(R.fromWorker).toContain('stopped');
    expect(R.stopRes.pending).toBe(0);
    const after = R.logsAfterStop.map(([, m]) => m);
    expect(after[0]).toBe('🛑 Завершение — отменяем фоновые задачи...');
    expect(after).toContain('SMC Scanner stopped.');
    expect(after).toContain(`🛑 signal_registry persisted: ${R.stopRes.saved} записей`);
    expect(after.some((m) => m.startsWith('[SMC-VOL-GATE-SUMMARY]'))).toBe(false);   // the cancelled SMC pass never finished
    expect(after.some((m) => m.startsWith('SMC scan cycle error') || m.startsWith('Ошибка цикла') || m.startsWith('[VOLUME-CYCLE] error'))).toBe(false);
    expect(R.logs.filter(([, l]) => l === 'ERROR')).toEqual([]);
  });

  it('the LEVELS cycle of the close was cancelled at a checkpoint: no summary line, none of its rows (the full run writes 611 / 612 rows here)', () => {
    const lines = R.logs.filter(([t]) => t >= T4).map(([, , m]) => m);
    expect(lines.some((m) => m.startsWith('  ✅ '))).toBe(false);
    expect(lines.some((m) => m.startsWith('✅ LEVELS '))).toBe(false);
    expect(R.after.rowsFinal.filter((r) => r.strategy === 'LEVELS' && r.created_at >= T4)).toEqual([]);
  });

  it('nothing runs after the stop: no new row, no new pass over an hour of fake time', () => {
    expect(R.after.rows).toBe(0);
    expect(R.after.passes).toEqual(R.after.passesAtStop);
  });

  it('no half-written signal: every row is delivered (feed notification + signal_msg_id) or SKIP not_delivered', () => {
    const notes = new Map(R.notesFinal.map((n) => [n.id, n]));
    expect(R.after.rowsFinal.length).toBeGreaterThan(0);
    for (const r of R.after.rowsFinal) {
      if (r.result === 'SKIP') {
        expect(r.skip_reason, r.trade_id).toBe('not_delivered');
      } else {
        expect(r.result, r.trade_id).toBe('');
        expect(r.signal_msg_id, r.trade_id).toBeGreaterThan(0);
        expect(notes.get(r.signal_msg_id).type).toBe('signal');
      }
    }
  });
});
