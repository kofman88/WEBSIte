/**
 * setups.test.js — the LEVELS setup search and part-1 gates (M5) against the bot:
 *
 *  1. Crafted + random scenarios (fixtures/frames.json → fixtures/expected.json): the
 *     bot's `_do_analyze(..., _precomputed_zones=)` ran with hooks that captured the
 *     search locals (signal, s_level, s_type, is_counter, patterns, prologue scalars),
 *     the institutional pattern, approach verdict, test count and the reject bucket.
 *     `analyzePart1` must reproduce every captured value and the bucket.
 *  2. Partial golden sweep over all 42 fixtures × 3 variants (expected/levels.json): for
 *     every bar rejected in `zones` / `volume` / `signal` / `rsi` the JS returns the same
 *     bucket; for every later-stage reject or signal bar it passes part 1, and on signal
 *     bars the setup fields of the recorded SignalResult (direction, breakout_type,
 *     level_class, test_count, pattern, is_counter_trend, trend_local, session, rsi,
 *     volume_ratio) are identical.
 *
 * Env knobs of the golden harness apply to part 2: GOLDEN_SYMBOLS, GOLDEN_VARIANTS, GOLDEN_STEP.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import load from '../golden/load.js';
import compare from '../golden/compare.js';
import { Frame } from '../../strategies/common/frame.js';
import C from '../../strategies/levels/config.js';
import L from '../../strategies/levels/setups.js';
import { marketSession, prologue, SESSION, TREND, SETUP } from '../../strategies/levels/setups.js';

const FIX = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures');
const FX = JSON.parse(fs.readFileSync(path.join(FIX, 'frames.json'), 'utf8'));
const EXP = JSON.parse(fs.readFileSync(path.join(FIX, 'expected.json'), 'utf8'));
const { loadExpected, loadFrames, listSymbols, sweepIndices, barInputs, VARIANTS } = load;
const { numbersClose } = compare;

const PART1_BUCKETS = new Set(['zones', 'volume', 'signal', 'rsi']);
const envList = (name) => (process.env[name] ? process.env[name].split(',').map((s) => s.trim()).filter(Boolean) : null);
const STEP = Math.max(1, parseInt(process.env.GOLDEN_STEP || '1', 10) || 1);

/** Zone objects exactly like the Python oracle's `mk()` (precomputed, no lvn_checker). */
function mkZones(zs) {
  const mk = (z) => ({ price: z.price, hits: z.hits, eff_hits: z.hits, age_bars: 10, class: z.class, is_psychological: false, layers: 1, has_hvn: false, has_lvn_to_tp: false });
  return { sup: zs.sup.map(mk), res: zs.res.map(mk) };
}

/** Flatten a part-1 result (pass or reject) into the oracle's field names. */
function flatten(res) {
  const s = res.reject === null ? res : (res.setup || {});
  const pro = res.pro || {};
  return {
    signal: s.signal ?? null, s_level: s.sLevel ?? null, s_type: s.sType ?? null, is_counter: s.isCounter ?? null,
    s_hits: s.sHits ?? null, s_class: s.sClass ?? null,
    s_zone: s.sZone ? { price: s.sZone.price, hits: s.sZone.hits, class: s.sZone.class } : null,
    c_now: pro.cNow, atr_now: pro.atrNow, rsi_now: pro.rsiNow, vol_ratio: pro.volRatio, vol_avg: pro.volAvg,
    bull_local: pro.bullLocal, bear_local: pro.bearLocal, trend_local: pro.trendLocal,
    session: pro.session, is_dead_session: pro.isDeadSession,
    dist_pct: res.distPct, _sig_dist_pct: res.sigDistPct, zone_buf: res.zoneBuf,
  };
}

describe('setup search scenarios vs indicator._do_analyze (hooked, precomputed zones)', () => {
  const scenarios = FX.setup_scenarios;

  it('every scenario reproduces the bucket and every captured intermediate', () => {
    const buckets = new Set();
    const types = new Set();
    for (const scn of scenarios) {
      const want = EXP.setups[scn.name];
      const df = Frame.fromBars(FX.frames[scn.frame]);
      const cfg = C.cfgToInd(C.tradeCfg(scn.cfg), Boolean(scn.high_wr));
      const res = L.analyzePart1(scn.name, df, null, cfg, { relax: scn.relax, precomputedZones: mkZones(scn.zones), skipGuard: true });
      const tag = `scenario ${scn.name}`;
      if (PART1_BUCKETS.has(want.bucket)) expect(res.reject, tag).toBe(want.bucket);
      else expect(res.reject, `${tag} (python bucket ${want.bucket})`).toBeNull();
      buckets.add(want.bucket);
      if (want.search) {
        const got = flatten(res);
        types.add(want.search.s_type);
        for (const [k, v] of Object.entries(want.search)) {
          if (k === 'bull_pat' || k === 'bear_pat') continue;
          if (typeof v === 'number') {
            expect(got[k], `${tag}.${k}`).toBe(v);  // bit-for-bit: same pandas primitives
          } else {
            expect(got[k], `${tag}.${k}`).toEqual(v);
          }
        }
        const pats = res.reject === null ? [res.bullPat, res.bearPat] : null;
        if (pats) expect(pats, `${tag}.patterns`).toEqual([want.search.bull_pat, want.search.bear_pat]);
      } else {
        // no setup locals captured: an earlier gate fired, or the search found nothing (the hook
        // sits after the signal-level distance check, so a 'zones' reject may still carry a setup)
        const reasons = { zones: ['no_zones', 'nearest_too_far', 'signal_level_too_far'], volume: ['vol_ratio'], signal: ['no_setup'] };
        expect(reasons[want.bucket], tag).toContain(res.reason);
      }
      if (want.inst) {
        expect([res.instPattern, res.patternBonus], `${tag}.inst`).toEqual(want.inst);
      }
      if (want.approach) {
        const ok = res.reject === null ? res.approachOk : res.reason !== 'approach';
        expect([ok, res.approachReason], `${tag}.approach`).toEqual(want.approach);
      }
      if (want.test_count !== null && want.test_count !== undefined) {
        expect(res.testCount, `${tag}.test_count`).toBe(want.test_count);
      }
      if (want.signal) {
        // a full SignalResult came back from Python: the part-1 fields it carries must agree
        expect(res.reject, tag).toBeNull();
        expect(res.signal).toBe(want.signal.direction);
        expect(res.sType).toBe(want.signal.breakout_type);
        expect(res.sClass).toBe(want.signal.level_class);
        expect(res.instPattern).toBe(want.signal.pattern);
        expect(res.testCount).toBe(want.signal.test_count);
        expect(res.isCounter).toBe(want.signal.is_counter_trend);
        expect(res.pro.trendLocal).toBe(want.signal.trend_local);
        expect(res.pro.session).toBe(want.signal.session);
      }
    }
    // the scenario table exercises every part-1 bucket, a later-stage one, and every setup type
    for (const b of ['zones', 'volume', 'signal', 'rsi', 'none']) expect(buckets.has(b), b).toBe(true);
    for (const t of Object.values(SETUP)) expect(types.has(t), t).toBe(true);
  });

  it('readable pins of the search order (spec §9.3, §25.2)', () => {
    const run = (name) => {
      const scn = scenarios.find((s) => s.name === name);
      const cfg = C.cfgToInd(C.tradeCfg(scn.cfg), false);
      return L.analyzePart1(name, Frame.fromBars(FX.frames[scn.frame]), null, cfg, { relax: scn.relax, precomputedZones: mkZones(scn.zones), skipGuard: true });
    };
    const setupOf = (r) => (r.reject === null ? r : r.setup);
    // A: SFP is checked before Fakeout on the same zone, and block A (LONG) beats a SHORT in block C
    let r = run('A_sfp_beats_fakeout_and_short');
    expect([r.signal, r.sType, r.sLevel]).toEqual(['LONG', SETUP.SFP_LONG, 100]);
    expect(run('A_fakeout').sType).toBe(SETUP.FAKEOUT);
    expect(run('A_sfp_no_volume').sType).toBe(SETUP.FAKEOUT);          // vol_ratio ≤ 1.2 → not SFP
    expect(run('A_bounce_pin').sType).toBe(SETUP.BOUNCE_SUP);
    expect(run('A_bounce_close_below_zone').reject).toBe('signal');     // close < lvl − zone_buf → no bounce
    expect(run('A_highest_first').sLevel).toBe(100);                    // reversed(sup_zones): highest first
    expect(run('A_proximity_skip').sLevel).toBe(99);                    // 102.5 is outside 3×zone_buf
    // B: retest before honest breakout
    expect(run('B_retest').sType).toBe(SETUP.RETEST_RES);
    expect(run('B_breakout').sType).toBe(SETUP.BREAKOUT);
    expect(run('B_retest_before_breakout').sType).toBe(SETUP.RETEST_RES);
    // C / D mirrors
    expect(run('C_sfp').sType).toBe(SETUP.SFP_SHORT);
    expect(run('C_fakeout').sType).toBe(SETUP.FAKEOUT);
    expect(run('C_bounce_pin').sType).toBe(SETUP.BOUNCE_RES);
    expect(run('C_bounce_close_above_zone').reject).toBe('signal');
    expect(run('C_highest_first').sLevel).toBe(101);
    expect(run('D_retest').sType).toBe(SETUP.RETEST_SUP);
    expect(run('D_breakdown').sType).toBe(SETUP.BREAKDOWN);
    // gates in order
    expect(run('gate_no_zones')).toMatchObject({ reject: 'zones', reason: 'no_zones' });
    expect(run('gate_nearest_too_far')).toMatchObject({ reject: 'zones', reason: 'nearest_too_far' });
    r = run('gate_signal_level_too_far');
    expect(r).toMatchObject({ reject: 'zones', reason: 'signal_level_too_far' });
    expect(setupOf(r).sLevel).toBe(98.2);                               // QUIRK(spec §9.4): proximity 3×zone_pct > max_dist
    expect(run('gate_volume')).toMatchObject({ reject: 'volume' });
    expect(run('gate_volume_off').reject).toBeNull();                   // use_volume off → gate skipped
    expect(run('gate_no_setup')).toMatchObject({ reject: 'signal', reason: 'no_setup' });
    expect(run('gate_approach_impulse')).toMatchObject({ reject: 'signal', reason: 'approach' });
    expect(run('gate_over_tested')).toMatchObject({ reject: 'signal', reason: 'over_tested', testCount: 4 });
    expect(run('gate_rsi_long')).toMatchObject({ reject: 'rsi', reason: 'rsi_ob' });
    expect(run('gate_rsi_short')).toMatchObject({ reject: 'rsi', reason: 'rsi_os' });
    // relax mode widens the windows and admits weak patterns; same bars without relax → nothing
    expect(run('relax_weak_bounce')).toMatchObject({ reject: null, sType: SETUP.BOUNCE_SUP, bullPat: 'Weak: Бычья с нижней тенью' });
    expect(run('norelax_same_bars').reject).toBe('signal');
    // counter-trend flag = local EMA trend opposite to the setup
    r = run('counter_trend_long');
    expect([r.isCounter, r.pro.trendLocal]).toEqual([true, TREND.BEAR]);
    expect(run('session_asia').pro.session).toBe(SESSION.ASIA);
    expect(run('session_dead').pro.session).toBe(SESSION.DEAD);
  });

  it('prologue guard: fewer than max(EMA_SLOW, 100) bars → "none" (no bucket)', () => {
    const cfg = C.defaultIndConfig();
    const df = Frame.fromBars(FX.frames.setup_gate_no_zones);
    expect(L.analyzePart1('x', df, null, cfg)).toEqual({ reject: 'none', reason: 'too_short' });
    expect(L.analyzePart1('x', null, null, cfg)).toEqual({ reject: 'none', reason: 'too_short' });
    expect(L.analyzePart1('x', null, null, cfg, { skipGuard: true })).toEqual({ reject: 'none', reason: 'too_short' });
    expect(L.analyzePart1('x', df, null, cfg, { skipGuard: true }).reject).not.toBe('none'); // _do_analyze directly on 30 bars
  });

  it('session labels by UTC hour', () => {
    const at = (h) => Frame.fromBars([[Date.UTC(2025, 11, 23, h, 0, 0), 1, 1, 1, 1, 1]]);
    expect(marketSession(at(0))).toBe(SESSION.ASIA);
    expect(marketSession(at(7))).toBe(SESSION.ASIA);
    expect(marketSession(at(8))).toBe(SESSION.LONDON);
    expect(marketSession(at(11))).toBe(SESSION.LONDON);
    expect(marketSession(at(12))).toBe(SESSION.EU_US);
    expect(marketSession(at(16))).toBe(SESSION.NY);
    expect(marketSession(at(20))).toBe(SESSION.NY);
    expect(marketSession(at(21))).toBe(SESSION.DEAD);
    expect(marketSession(at(23))).toBe(SESSION.DEAD);
    expect(prologue(at(5), C.defaultIndConfig()).isDeadSession).toBe(true);
  });
});

describe('partial golden sweep (expected/levels.json): part-1 buckets and setup fields', () => {
  const SYMBOLS = envList('GOLDEN_SYMBOLS');
  const VARIANT_FILTER = envList('GOLDEN_VARIANTS');
  const expected = loadExpected('levels');

  it('the stored variant ind_config equals cfgToInd(tradeCfg(trade_cfg), high_wr_mode)', () => {
    for (const v of VARIANTS) {
      const variant = expected.variants[v];
      expect(C.cfgToInd(C.tradeCfg(variant.trade_cfg), variant.high_wr_mode), v).toEqual(variant.ind_config);
    }
  });

  for (const variantName of VARIANTS) {
    if (VARIANT_FILTER && !VARIANT_FILTER.includes(variantName)) continue;
    describe(`variant ${variantName}`, () => {
      const symbols = listSymbols().filter((s) => !SYMBOLS || SYMBOLS.some((p) => s.startsWith(p)));
      for (const symbol of symbols) {
        it(`${symbol}`, () => {
          const variant = expected.variants[variantName];
          const cfg = variant.ind_config;
          const fx = expected.fixtures[symbol][variantName];
          const frames = loadFrames(symbol);
          const signalBars = new Map(fx.signals.map((s) => [s.i, s]));
          const htfCache = new Map();
          const failures = [];
          let checked = 0;
          for (const i of sweepIndices(frames['1h'].length, STEP)) {
            const b = barInputs(frames, i);
            const dfHtf = cfg.USE_HTF_FILTER ? b.dfHtf1d : null;
            const res = L.analyzePart1(symbol, b.df, dfHtf, cfg, { htfZoneCache: htfCache });
            const sig = signalBars.get(i);
            if (sig) {
              if (res.reject !== null) { failures.push(`bar ${i}: expected a ${sig.direction} signal, part 1 rejected with ${res.reject} (${res.reason})`); continue; }
              const diffs = [];
              const eq = (k, got, want) => { if (got !== want) diffs.push(`${k}: ${JSON.stringify(got)} != ${JSON.stringify(want)}`); };
              eq('direction', res.signal, sig.direction);
              eq('breakout_type', res.sType, sig.breakout_type);
              eq('level_class', res.sClass, sig.level_class);
              eq('test_count', res.testCount, sig.test_count);
              eq('pattern', res.instPattern, sig.pattern);
              eq('is_counter_trend', res.isCounter, sig.is_counter_trend);
              eq('trend_local', res.pro.trendLocal, sig.trend_local);
              eq('session', res.pro.session, sig.session);
              // LEVELS stores rsi_now raw (SignalResult.rsi = rsi_now; VOLUME is the one that rounds to 1 dp)
              if (!numbersClose(res.pro.rsiNow, sig.rsi)) diffs.push(`rsi: ${res.pro.rsiNow} != ${sig.rsi}`);
              if (!numbersClose(res.pro.volRatio, sig.volume_ratio)) diffs.push(`volume_ratio: ${res.pro.volRatio} != ${sig.volume_ratio}`);
              if (diffs.length) failures.push(`bar ${i}: ${diffs.join('; ')}`);
            } else {
              const want = fx.reject_reasons[String(i)];
              if (want === undefined) continue;
              if (PART1_BUCKETS.has(want)) {
                if (res.reject !== want) failures.push(`bar ${i}: reject "${res.reject}" (${res.reason}) != "${want}"`);
              } else if (res.reject !== null) {
                failures.push(`bar ${i}: part 1 rejected with "${res.reject}" (${res.reason}) but the bot reached "${want}"`);
              }
            }
            checked++;
            if (failures.length > 10) break;
          }
          if (failures.length) throw new Error(`${symbol}/${variantName}: ${failures.length} failing bars\n${failures.join('\n')}`);
          expect(checked).toBeGreaterThan(0);
        }, 120_000);
      }
    });
  }
});
