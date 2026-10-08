/**
 * signalFreshness — the bot's signal_freshness.py on Python vectors
 * (fixtures/freshness.json, tools/gen_vectors.py `freshness`):
 *   compute_tolerance_pct over cycle EMAs × env overrides, the report_cycle_time EMA,
 *   and the is_signal_fresh table (LONG/SHORT × price ladder × with/without SL ×
 *   cycle EMA 0 / 130 / 1000 s) including the exact [SIGNAL-STALE-SL] / [SIGNAL-DRIFT] /
 *   [SIGNAL-EXPIRED] / [FRESHNESS-TOLERANCE] log lines.
 *
 *   Python: sf.get_current_price = fake; asyncio.run(sf.is_signal_fresh(symbol=..., direction=..., ...))
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const F = req('../../../services/engine/signalFreshness.js');
const { load, captureLog, frameOf } = req('./vectors.js');

const V = load('freshness');

describe('compute_tolerance_pct', () => {
  it.each(V.tolerance.map((c) => [JSON.stringify(c.env), c.ema, c]))('env=%s ema=%s', (_e, _m, c) => {
    expect(F.computeTolerancePct(c.ema, c.env)).toBe(c.tol);
  });
});

describe('report_cycle_time EMA', () => {
  it('replays the bot sequence', () => {
    const f = F.createFreshness({ env: {}, log: captureLog(), getCandles: () => null });
    for (const s of V.ema_steps) {
      f.reportCycleTime(s.strategy, s.seconds);
      for (const [k, v] of Object.entries(s.ema)) expect(f.getCycleEma(k), `${s.strategy} ${s.seconds} → ${k}`).toBe(v);
    }
  });
});

describe('is_signal_fresh table', () => {
  expect(F.createFreshness({ env: {} }).MAX_DRIFT_R).toBe(V.MAX_DRIFT_R);
  it.each(V.fresh.map((c, i) => [i, c.direction, c.current, c]))('#%i %s current=%s', (_i, _d, _c, c) => {
    const log = captureLog();
    const f = F.createFreshness({ env: {}, log, getCandles: () => null });
    if (c.ema) f.reportCycleTime('LEVELS', c.ema);
    const res = f.isSignalFresh({
      symbol: c.symbol, direction: c.direction, entry: c.entry, tp1: c.tp1, strategy: c.strategy, uid: c.uid, sl: c.sl,
    }, { current: c.current });
    expect(res).toBe(c.fresh);
    expect(log.lines.filter((l) => l[0] === 'INFO').map((l) => l[1])).toEqual(c.logs);
  });
});

describe('get_current_price', () => {
  it('first cached frame among 15m → 1H → 4H with a positive last close', () => {
    const frames = { '15m': frameOf([[1, 1, 1, 0, 1]]), '1H': frameOf([[1, 1, 1, 2.5, 1]]), '4H': frameOf([[1, 1, 1, 9, 1]]) };
    const f = F.createFreshness({ env: {}, getCandles: (_s, tf) => frames[tf] || null });
    expect(f.getCurrentPrice('X')).toBe(2.5);
    frames['1H'] = null;
    expect(f.getCurrentPrice('X')).toBe(9);
    frames['4H'] = frameOf([]);
    expect(f.getCurrentPrice('X')).toBe(null);
  });
});
