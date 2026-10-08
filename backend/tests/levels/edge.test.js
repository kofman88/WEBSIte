/**
 * edge.test.js — pinned unit tests for the LEVELS divergences found by the differential probe
 * (tests/golden/make_levels_probe.py → tests/levels/probe.test.js). Every expected value was
 * printed by the bot's own code in the pinned venv (the one-liner / script is quoted per test).
 */
import { describe, it, expect } from 'vitest';
import load from '../golden/load.js';
import { Frame } from '../../strategies/common/frame.js';
import L from '../../strategies/levels/index.js';

const H = 3_600_000;
const BASE = 1_767_225_600_000;
const flat = (ts) => Frame.fromColumns({ t: ts, o: ts.map(() => 1), h: ts.map(() => 1), l: ts.map(() => 1), c: ts.map(() => 1), v: ts.map(() => 1) });

describe('CooldownState.barsSinceSignal — Python round() is half-to-even', () => {
  // ind = CHMIndicator(_cfg_to_ind(TradeCfg())); ind.mark_signal("X", df(mark_h)); ind.bars_since_signal("X", df(prev_h, last_h))
  // with df(h...) = DataFrame indexed by BASE + h hours  →  [mark_h, prev_h, last_h, bars]
  const VECTORS = [[0, 3, 5, 2], [0, 5, 7, 4], [0, 1, 3, 2], [0, 6, 9, 3], [0, 9, 12, 4], [0, 4, 5, 5],
    [10, 3, 5, -2], [0, 2, 4, 2], [1, 3, 6, 2], [0, 13, 15, 8], [2, 8, 10, 4]];
  it.each(VECTORS)('mark %ih, last step %ih→%ih ⇒ %i bars', (markH, prevH, lastH, want) => {
    const cd = new L.CooldownState();
    cd.markSignal('X', flat([BASE + markH * H]));
    expect(cd.barsSinceSignal('X', flat([BASE + prevH * H, BASE + lastH * H]))).toBe(want);
  });
  it('a 3-bar cooldown is still active 5 h after the signal when the last step spans a missing bar (2.5 → 2)', () => {
    const cfg = L.cfgToInd(L.tradeCfg({ cooldown_bars: 3, ema_slow: 100 }));
    const n = 120;
    const ts = Array.from({ length: n }, (_, j) => BASE + j * H);
    ts[n - 1] = ts[n - 2] + 2 * H;                     // one missing bar before the last one
    const df = Frame.fromColumns({ t: ts, o: ts.map(() => 1), h: ts.map(() => 1.01), l: ts.map(() => 0.99), c: ts.map(() => 1), v: ts.map(() => 1) });
    const cd = new L.CooldownState();
    cd.map.set('X', ts[n - 1] - 5 * H);
    expect(cd.barsSinceSignal('X', df)).toBe(2);
    expect(L.analyze('X', df, null, null, null, cfg, { cooldown: cd }).stage).toBe('cooldown');
  });
  it('non-finite ratios fall back to 1_000_000 (Python round(nan) raises → except)', () => {
    const cd = new L.CooldownState();
    cd.map.set('X', NaN);
    expect(cd.barsSinceSignal('X', flat([BASE, BASE + H]))).toBe(1_000_000);
  });
});

describe('volume profile: one NaN / inf volume empties HVN and LVN (numpy 0·NaN propagation)', () => {
  // lo=[100+i*.5]; hi=lo+.4; vol=[1000+37i]; lo[7],hi[7]=100.01,100.02 (spans no bin centre)
  // vol[7]=nan → ind._volume_profile(df) → {"hvn": [], "lvn": [], "nan_bins": 50}; vol[7]=inf → the same
  const mk = () => {
    const lo = [], hi = [], vol = [];
    for (let i = 0; i < 20; i++) { lo.push(100 + i * 0.5); hi.push(100 + i * 0.5 + 0.4); vol.push(1000 + 37 * i); }
    lo[7] = 100.01; hi[7] = 100.02;
    return { lo, hi, vol };
  };
  it.each([[NaN], [Infinity]])('narrow bar volume %s', (bad) => {
    const { lo, hi, vol } = mk();
    vol[7] = bad;
    const vp = L.volumeProfileNp(lo, hi, vol, 50);
    expect([vp.hvn, vp.lvn]).toEqual([[], []]);
    expect([...vp.volumes].every((x) => Number.isNaN(x))).toBe(true);
  });
  it('finite volumes are untouched (same nodes as common/kde.volumeProfile)', () => {
    // vol[7]=1000.0 → hvn = [107.623, 107.821, …] (10 nodes), lvn = 12 nodes
    const { lo, hi, vol } = mk();
    vol[7] = 1000.0;
    const vp = L.volumeProfileNp(lo, hi, vol, 50);
    expect(vp.hvn.length).toBe(10);
    expect(vp.lvn.length).toBe(12);
    expect(vp.hvn[0]).toBe(107.623);
  });
  it('fewer than 10 bars / flat range: empty without touching the volumes', () => {
    expect(L.volumeProfileNp([1, 1], [1, 1], [NaN, 1], 50).hvn).toEqual([]);
  });
});

describe('createIndicator reject counters in relaxed mode (ATR-breakout fallback)', () => {
  // make_levels_probe.apply_env(case(relaxed=True)); md._last_breakout_alert.clear(); reset_analyze_stats()
  // CHMIndicator(_cfg_to_ind(TradeCfg())).analyze("SYNVL03-USDT-SWAP", df_1h.iloc[:i+1]) → "ATR Breakout" signal and
  // get_analyze_stats() == {"zones": 1} at i = 225 (LONG), {"signal": 1} at i = 380 (SHORT): _none_stat fired first
  it.each([[225, 'LONG', { zones: 1 }], [380, 'SHORT', { signal: 1 }]])('bar %i → %s breakout, stats %j', (i, dir, stats) => {
    const base = load.loadFrame('SYNVL03-USDT-SWAP', '1h');
    const ind = L.createIndicator(L.cfgToInd(L.tradeCfg({})), { relaxed: true, triggerReason: 'BTC pump +2.50% за 1H' });
    const res = ind.analyze('SYNVL03-USDT-SWAP', base.prefix(i), null, null, null, { nowSec: (base.t[i] + H) / 1000, breakoutState: new Map() });
    expect([res.signal && res.signal.breakout_type, res.signal && res.signal.direction]).toEqual(['ATR Breakout', dir]);
    expect(ind.getAnalyzeStats()).toEqual(stats);
  });
});
