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

describe('live zone cache (`_zone_cache`, TTL by TIMEFRAME, pre-filter) of a persistent indicator', () => {
  // scratchpad chk_cache2.py: Config.LEVELS_REGIME_GATE="off"; indicator.time = fake clock; ic = _cfg_to_ind(TradeCfg(**LOOSE, max_dist_pct=md))
  // ind = CHMIndicator(ic); clock=0: ind.analyze(sym, df_1h[:i0+1]); clock=1799: cached = ind.analyze(sym, df_1h[:j+1])
  // fresh = CHMIndicator(ic).analyze(sym, df_1h[:j+1])   (LOOSE = make_levels_probe.LOOSE)
  const LOOSE = { max_dist_pct: 3.0, zone_pct: 0.3, vol_mult: 0.7, use_volume: false, use_rsi: false, max_risk_pct: 3.0, min_rr: 1.0 };
  const ENV_OFF = { ...L.LEVELS_ENV, LEVELS_REGIME_GATE: 'off' };
  const VECTORS = [
    ['SYNRG05-USDT-SWAP', 3.0, 280, 318, 'zones', 'SIG SHORT SFP (Ложный пробой вверх) q=5'],
    ['SYNRG05-USDT-SWAP', 3.0, 230, 238, 'rr', 'signal'],
    ['SYNRG05-USDT-SWAP', 0.5, 230, 254, 'signal', 'zones'],
    ['SYNLV06-USDT-SWAP', 3.0, 230, 250, 'SIG SHORT Ретест пробитой поддержки q=7', 'SIG SHORT Ретест пробитой поддержки q=9'],
    ['SYNLV06-USDT-SWAP', 3.0, 330, 335, 'SIG LONG Отскок от поддержки q=0', 'SIG LONG Отскок от поддержки q=1'],
  ];
  const fmt = (r) => (r.signal ? `SIG ${r.signal.direction} ${r.signal.breakout_type} q=${r.signal.quality}` : r.rejectReason);
  it.each(VECTORS)('%s max_dist %s: zones of bar %i reused at bar %i → %s (fresh: %s)', (sym, md, i0, j, cached, fresh) => {
    const cfg = L.cfgToInd(L.tradeCfg({ ...LOOSE, max_dist_pct: md }), false, ENV_OFF);
    const base = load.loadFrame(sym, '1h');
    let now = 0;
    const ind = L.createIndicator(cfg, { env: ENV_OFF, clock: () => now });
    ind.analyze(sym, base.prefix(i0));
    now = 1799;                                                  // TTL "1h" = 1800 s: still fresh
    expect(fmt(ind.analyze(sym, base.prefix(j)))).toBe(cached);
    expect(fmt(L.analyze(sym, base.prefix(j), null, null, null, cfg, { env: ENV_OFF }))).toBe(fresh);
    now = 1800;                                                  // entry stored at 0: 1800 − 0 is not < 1800 → stale
    expect(fmt(ind.analyze(sym, base.prefix(j)))).toBe(fresh);   // recomputed = the fresh result
  });
  it('the pre-filter rejects from the cache with "zones" when every cached zone is > 2·MAX_DIST_PCT away', () => {
    const Z = L.zones;
    const z = (price) => ({ price });
    expect(Z.preFilterSkip([z(100)], [z(110)], 103.1, 1.5)).toBe(true);    // 3.1 % > 3 %
    expect(Z.preFilterSkip([z(100)], [z(110)], 102.9, 1.5)).toBe(false);
    expect(Z.preFilterSkip([], [], 100, 1.5)).toBe(false);
    expect(Z.zoneCacheTtl('15m')).toBe(600);
    expect(Z.zoneCacheTtl('4H')).toBe(900);                      // unknown key → 900 (only lowercase keys in _TF_TTL_MAP)
  });
  it('eviction over _ZONE_CACHE_MAX: TTL-expired entries first, then the oldest', () => {
    // scratchpad chk_evict.py: ind = CHMIndicator(_cfg_to_ind(TradeCfg())); ind._ZONE_CACHE_MAX = 2; clock = t;
    // ind.analyze(sym, df_1h[:300]) → list(ind._zone_cache) after each call
    const STEPS = [['A', 0, ['A']], ['B', 100, ['A', 'B']], ['C', 2000, ['C']], ['D', 2100, ['C', 'D']],
      ['B', 2200, ['D', 'B']], ['E', 2300, ['B', 'E']], ['F', 5000, ['F']]];
    const df = load.loadFrame('SYNRG05-USDT-SWAP', '1h').slice(0, 300);
    let now = 0;
    const ind = L.createIndicator(L.cfgToInd(L.tradeCfg({})), { clock: () => now, cacheMax: 2 });
    for (const [sym, t, keys] of STEPS) {
      now = t;
      ind.analyze(sym, df);
      expect([sym, t, [...ind.zoneCache.map.keys()]]).toEqual([sym, t, keys]);
    }
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

describe('short frames: pandas IndexError ↔ a JS throw (re-check: lattice + short-frame fuzz)', () => {
  // The bars of make_levels_probe --suite short / the re-check's short_frames.py, hourly from BASE.
  const BARS7 = [[102.8, 102.9, 102.4, 102.5, 11.0], [102.5, 102.6, 102.2, 102.3, 10.0], [102.3, 102.4, 101.9, 102.0, 9.0],
    [102.0, 102.1, 101.5, 101.6, 8.0], [101.6, 101.7, 101.1, 101.2, 7.0], [101.2, 101.3, 100.5, 100.6, 6.0],
    [100.05, 100.12, 99.95, 100.1, 5.0]];
  const fr = (bars) => Frame.fromBars(bars.map((b, i) => [BASE + i * H, ...b]));
  const rolling3 = (v) => Float64Array.from(v, (_, i) => (i < 2 ? NaN : (v[i - 2] + v[i - 1] + v[i]) / 3));

  it('_assess_approach_quality: 6 bars pass the < 6 guard and reach df.iloc[-7] → IndexError; 7 bars → a verdict', () => {
    // df = pd.DataFrame(BARS7[-k:], columns=["open", "high", "low", "close", "volume"])
    // CHMIndicator(_cfg_to_ind(TradeCfg()))._assess_approach_quality(df, 100.0, 0.1, df["volume"].rolling(3).mean(), "PINBAR_AT_LEVEL")
    //   → k=6: IndexError("single positional indexer is out-of-bounds"); k=7: (True, "✅ Снижение объёма на подходе")
    const df6 = fr(BARS7.slice(1));
    const df7 = fr(BARS7);
    expect(() => L.assessApproachQuality(df6, 100.0, 0.1, rolling3(df6.v), 'PINBAR_AT_LEVEL')).toThrow(L.PyIndexError);
    expect(L.assessApproachQuality(df7, 100.0, 0.1, rolling3(df7.v), 'PINBAR_AT_LEVEL'))
      .toEqual({ ok: true, reason: '✅ Снижение объёма на подходе' });
  });

  // ind = CHMIndicator(_cfg_to_ind(TradeCfg(use_volume=False, use_rsi=False, zone_pct=0.1)))
  // ind._do_analyze("X-USDT-SWAP", df, None, None, None, None, _precomputed_zones=([zone(p) for p in sup], [zone(p) for p in res]))
  // with zone(p) = {"price": p, "hits": 2, "eff_hits": 2, "age_bars": 10, "class": 2, "is_psychological": False,
  //                 "layers": 1, "has_hvn": False, "has_lvn_to_tp": False}
  const ONE = [[100.0, 100.4, 99.8, 100.2, 10.0]];
  const TWO = [[100.0, 100.4, 99.8, 100.1, 10.0], [100.1, 100.5, 99.9, 100.2, 10.0]];
  const VECTORS = [
    ['1 bar, resistance 100.3: retest misses, breakout reads close[-2]', ONE, [], [100.3], 'IndexError'],
    ['1 bar, support 100.1: SFP fires before any [-2] read', ONE, [100.1], [], 'SFP (Захват ликвидности)'],
    ['1 bar, support 99.9: no setup', ONE, [99.9], [], 'reject signal'],
    ['2 bars, resistance 100.3', TWO, [], [100.3], 'SFP (Ложный пробой вверх)'],
    ['6 bars, pin-bar bounce at 100.0: approach reads iloc[-7]', BARS7.slice(1), [100.0], [], 'IndexError'],
    ['7 bars, pin-bar bounce at 100.0', BARS7, [100.0], [], 'Отскок от поддержки'],
  ];
  const zone = (price) => ({ price, hits: 2, eff_hits: 2, age_bars: 10, class: 2, is_psychological: false, layers: 1, has_hvn: false, has_lvn_to_tp: false });
  it.each(VECTORS)('%s → %s', (_name, bars, sup, res, want) => {
    const cfg = L.cfgToInd(L.tradeCfg({ use_volume: false, use_rsi: false, zone_pct: 0.1 }));
    let got;
    try {
      const r = L.doAnalyze('X-USDT-SWAP', fr(bars), null, null, null, cfg, { precomputedZones: { sup: sup.map(zone), res: res.map(zone) } });
      got = r.signal ? r.signal.breakout_type : `reject ${r.rejectReason}`;
    } catch (e) {
      got = e.name;
    }
    expect(got).toBe(want);
  });
});
