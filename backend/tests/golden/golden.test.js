/**
 * golden.test.js — bit-for-bit sweep of the JS engines against the bot's Python
 * output (PLAN §3). Runs with `npm run golden` (vitest run tests/golden).
 *
 * For every strategy / variant / fixture symbol the 1h series is swept from
 * i = 200 to 399; the engine sees df.iloc[:i+1] and the auxiliary frames closed
 * at open_time[i] + 1h (last 300 bars) — exactly what make_golden.py fed the
 * Python functions. The expected set of signal bars must be identical, every
 * recorded field compared with compare.js rules, bars without a signal must be
 * null (LEVELS: with the same reject-reason bucket).
 *
 * Engines not yet registered in engines.js are reported as todo, not failures.
 *
 * Env knobs: GOLDEN_SYMBOLS=SYNRG01,BTC (prefix filter), GOLDEN_STRATEGIES=smc,volume,
 * GOLDEN_VARIANTS=default, GOLDEN_STEP=5 (sweep every k-th bar), GOLDEN_STRICT=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import load from './load.js';
import compare from './compare.js';
import registry from './engines.js';

const { SWEEP, STRATEGIES, VARIANTS, loadExpected, loadFrames, listSymbols, sweepIndices, barInputs, tsString, verifyAll } = load;
const { compareSignal, compareValue, compareDigest, formatDiffs, ROUNDED_FIELDS_BY_STRATEGY } = compare;

const envList = (name) => (process.env[name] ? process.env[name].split(',').map((s) => s.trim()).filter(Boolean) : null);
const SYMBOL_PREFIXES = envList('GOLDEN_SYMBOLS');
const STRATEGY_FILTER = envList('GOLDEN_STRATEGIES');
const VARIANT_FILTER = envList('GOLDEN_VARIANTS');
const STEP = Math.max(1, parseInt(process.env.GOLDEN_STEP || '1', 10) || 1);

const HARNESS_KEYS = {
  levels: ['i', 'ts', 'open_time_ms', 'n_bars', 'n_htf_bars'],
  smc: ['i', 'ts', 'open_time_ms', 'n_mtf_bars', 'n_htf_bars', 'n_ltf_bars'],
  volume: ['i', 'ts', 'open_time_ms', 'n_bars', 'n_htf_bars'],
};

function symbolsToRun() {
  const all = listSymbols();
  if (!SYMBOL_PREFIXES) return all;
  return all.filter((s) => SYMBOL_PREFIXES.some((p) => s.startsWith(p)));
}

/** Build the engine ctx for one bar of one strategy/variant. */
function makeCtx(strategy, symbol, variantName, variant, frames, i, prepared) {
  const b = barInputs(frames, i);
  const base = { symbol, i, closeMs: b.closeMs, openTimeMs: b.openTimeMs, variant: { name: variantName, ...variant }, prepared };
  if (strategy === 'levels') {
    const useHtf = !!(variant.ind_config && variant.ind_config.USE_HTF_FILTER);
    return { ...base, df: b.df, dfHtf: useHtf ? b.dfHtf1d : null, dfBtc: b.dfBtc, dfEth: b.dfEth };
  }
  if (strategy === 'smc') {
    return { ...base, dfHtf: b.dfHtf4h, dfMtf: b.df, dfLtf: b.dfLtf15m };
  }
  const useHtf = !!(variant.volume_config && variant.volume_config.use_htf);
  return { ...base, df: b.df, dfHtf: useHtf ? b.dfHtf4h : null, timeframe: SWEEP.tf };
}

/** Harness-side keys the fixture records carry; verified against the frames the harness built. */
function harnessRecord(strategy, ctx) {
  const n = (f) => (f ? f.length : 0);
  if (strategy === 'smc') {
    return { i: ctx.i, ts: tsString(ctx.openTimeMs), open_time_ms: ctx.openTimeMs, n_mtf_bars: n(ctx.dfMtf), n_htf_bars: n(ctx.dfHtf), n_ltf_bars: n(ctx.dfLtf) };
  }
  return { i: ctx.i, ts: tsString(ctx.openTimeMs), open_time_ms: ctx.openTimeMs, n_bars: n(ctx.df), n_htf_bars: n(ctx.dfHtf) };
}

/**
 * Sweep one fixture for one strategy/variant. Returns { failures: string[], bars, signals }.
 * A thrown engine error fails only that bar (recorded like the generator's `errors`).
 */
function sweepFixture(strategy, engine, symbol, variantName, variant, expectedFixture, digestFixture) {
  const frames = loadFrames(symbol);
  const n = frames['1h'].length;
  const indices = sweepIndices(n, STEP);
  const expectedBars = new Map(expectedFixture.signals.map((s) => [s.i, s]));
  const failures = [];
  const prepared = typeof engine.prepare === 'function' ? engine.prepare(frames, { name: variantName, ...variant }) : undefined;
  let signals = 0;
  for (const i of indices) {
    const ctx = makeCtx(strategy, symbol, variantName, variant, frames, i, prepared);
    let out;
    try {
      out = engine.run(ctx);
    } catch (e) {
      failures.push(`bar ${i}: engine threw ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      continue;
    }
    const sig = out ? out.signal : null;
    const exp = expectedBars.get(i);
    if (exp) {
      if (!sig) {
        failures.push(`bar ${i}: expected a ${exp.direction} signal, engine returned null${out && out.rejectReason ? ` (reject=${out.rejectReason})` : ''}`);
      } else {
        signals++;
        const diffs = compareSignal(sig, exp, { ignoreKeys: HARNESS_KEYS[strategy], roundedFields: ROUNDED_FIELDS_BY_STRATEGY[strategy] });
        const hr = harnessRecord(strategy, ctx);
        for (const k of HARNESS_KEYS[strategy]) {
          if (exp[k] !== undefined && hr[k] !== exp[k]) diffs.push({ path: `harness.${k}`, actual: hr[k], expected: exp[k], rule: 'harness' });
        }
        if (diffs.length) failures.push(`bar ${i}:\n${formatDiffs(diffs)}`);
      }
    } else if (sig) {
      failures.push(`bar ${i}: unexpected ${sig.direction || ''} signal (fixture has none)`);
    } else if (strategy === 'levels' && expectedFixture.reject_reasons) {
      const want = expectedFixture.reject_reasons[String(i)];
      const got = out && out.rejectReason != null ? out.rejectReason : 'none';
      if (want !== undefined && got !== want) failures.push(`bar ${i}: reject reason "${got}" != "${want}"`);
    }
    if (strategy === 'smc' && digestFixture && variantName === 'default') {
      const wantDigest = digestFixture[String(i)];
      if (wantDigest && out && out.digest) {
        const d = compareDigest(out.digest, wantDigest);
        if (d.length) failures.push(`bar ${i} analysis digest:\n${formatDiffs(d)}`);
      } else if (wantDigest && out && out.digest === undefined) {
        failures.push(`bar ${i}: engine returned no analysis digest`);
      }
    }
    if (failures.length > 25) { failures.push('… stopping after 25 failures'); break; }
  }
  return { failures, bars: indices.length, signals };
}

describe('golden fixtures', () => {
  it('fixture files are intact (sha256 of summary.json, every candle file parses)', () => {
    const rep = verifyAll();
    expect(rep.candles).toBe(42 * 4);
    expect(Object.keys(rep.expected).sort()).toEqual(['levels', 'smc', 'smc_analysis', 'volume']);
  });

  it('frames follow the generator conventions (aligned, closed-bar prefix rule)', () => {
    const frames = loadFrames('BTC-USDT-SWAP');
    expect(frames['1h'].length).toBe(400);
    expect(frames['15m'].length).toBe(2000);
    const i = 200;
    const b = barInputs(frames, i);
    expect(b.df.length).toBe(201);
    expect(b.dfLtf15m.length).toBe(300);
    expect(b.dfHtf4h.length).toBe(300);
    // every aux bar is closed at closeMs and the next one is not
    const last4h = b.dfHtf4h.t[b.dfHtf4h.length - 1];
    expect(last4h + 14_400_000).toBeLessThanOrEqual(b.closeMs);
    const idx4h = frames['4h'].lastClosedAt('4h', b.closeMs);
    if (idx4h + 1 < frames['4h'].length) expect(frames['4h'].t[idx4h + 1] + 14_400_000).toBeGreaterThan(b.closeMs);
    expect(tsString(b.openTimeMs)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

/**
 * Digest-only sweep of the SMC ANALYSIS layer (M3): for every bar the engine's
 * `digest` must equal expected/smc_analysis.json (default analysis key) under the
 * compare.js rules. Runs before the strategy sweeps so a divergence is attributed
 * to structure / liquidity / OB / FVG / PD / ATR / volume / squeeze before the
 * signal builder is involved. Selected with GOLDEN_STRATEGIES=smc_analysis.
 */
function sweepDigestFixture(engine, symbol, digestDoc) {
  const frames = loadFrames(symbol);
  const n = frames['1h'].length;
  const indices = sweepIndices(n, STEP);
  const variant = { analysis_key: digestDoc.analysis_key };
  const prepared = typeof engine.prepare === 'function' ? engine.prepare(frames, { name: 'default', ...variant }) : undefined;
  const want = digestDoc.fixtures[symbol] || {};
  const failures = [];
  let compared = 0;
  for (const i of indices) {
    const ctx = makeCtx('smc', symbol, 'default', variant, frames, i, prepared);
    let out;
    try {
      out = engine.run(ctx);
    } catch (e) {
      failures.push(`bar ${i}: engine threw ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      continue;
    }
    const exp = want[String(i)];
    if (!exp) { failures.push(`bar ${i}: fixture has no digest for this bar`); continue; }
    if (!out || !out.digest) { failures.push(`bar ${i}: engine returned no analysis digest`); continue; }
    const d = compareDigest(out.digest, exp);
    if (d.length) failures.push(`bar ${i} analysis digest:\n${formatDiffs(d)}`); else compared++;
    if (failures.length > 25) { failures.push('… stopping after 25 failures'); break; }
  }
  return { failures, bars: indices.length, compared };
}

if (!STRATEGY_FILTER || STRATEGY_FILTER.includes('smc_analysis')) {
  const engine = registry.get('smc_analysis');
  describe('golden smc_analysis', () => {
    if (!engine || typeof engine.run !== 'function') {
      it.todo('smc_analysis engine not registered yet (tests/golden/engines.js) — sweep skipped');
      return;
    }
    if (VARIANT_FILTER && !VARIANT_FILTER.includes('default')) {
      it.skip('smc_analysis digests exist for the default analysis key only', () => {});
      return;
    }
    let digest;
    beforeAll(() => { digest = loadExpected('smc_analysis'); });
    describe('variant default', () => {
      for (const symbol of symbolsToRun()) {
        it(`${symbol}`, () => {
          const res = sweepDigestFixture(engine, symbol, digest);
          if (res.failures.length) {
            throw new Error(`smc_analysis/default/${symbol}: ${res.failures.length} failing bars of ${res.bars}\n${res.failures.join('\n')}`);
          }
          expect(res.compared).toBe(res.bars);
        });
      }
    });
  });
}

// Order matters: smc_analysis digests are checked inside the smc sweep (default
// variant) BEFORE the signal fields so a divergence is attributed to a module.
for (const strategy of STRATEGIES) {
  if (STRATEGY_FILTER && !STRATEGY_FILTER.includes(strategy)) continue;
  const engine = registry.get(strategy);
  describe(`golden ${strategy}`, () => {
    if (!engine || typeof engine.run !== 'function') {
      it.todo(`${strategy} engine not registered yet (tests/golden/engines.js) — sweep skipped`);
      return;
    }
    let expected;
    let digest = null;
    beforeAll(() => {
      expected = loadExpected(strategy);
      if (strategy === 'smc') digest = loadExpected('smc_analysis');
    });
    for (const variantName of VARIANTS) {
      if (VARIANT_FILTER && !VARIANT_FILTER.includes(variantName)) continue;
      describe(`variant ${variantName}`, () => {
        for (const symbol of symbolsToRun()) {
          it(`${symbol}`, () => {
            const variant = expected.variants[variantName];
            const fx = expected.fixtures[symbol][variantName];
            const dg = digest ? digest.fixtures[symbol] : null;
            const res = sweepFixture(strategy, engine, symbol, variantName, variant, fx, dg);
            if (res.failures.length) {
              throw new Error(`${strategy}/${variantName}/${symbol}: ${res.failures.length} failing bars of ${res.bars}\n${res.failures.join('\n')}`);
            }
            if (STEP === 1) expect(res.signals).toBe(fx.n_signals);
          });
        }
      });
    }
  });
}
