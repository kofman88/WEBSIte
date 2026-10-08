/**
 * recordSchema.test.js — SMC record SCHEMA parity with the bot (golden round 1).
 *
 * The golden comparator (tests/golden/compare.js) walks the keys of the FIXTURE record, so
 * it cannot notice an extra / renamed key the engine emits, nor whether a `round(x, k)` field
 * (rr 2 dp, risk_pct 3 dp, rr_ladder 2 dp) is rounded by the engine itself or only by the
 * comparator's pyRound step. This test pins what the sweep leaves open, on real fixture bars:
 *
 *   - the engine signal has EXACTLY the keys of `asdict(SMCSignalResult)` + the scanner
 *     post-steps (squeeze_score, passes_ctx_gate, rr_ladder), in the same order — the record
 *     the DB / card / API consume is the bot's record, nothing more, nothing less;
 *   - every Python-rounded field is already rounded by the engine (pyRound(v, k) === v), so
 *     the stored value equals Python's `round(...)` output, not a raw float;
 *   - `confirmations` are 8 `[label, bool]` pairs (the bot renders them with
 *     `✅ if passed else ⬜` and sums `if v`, i.e. consumes them as truthy — see scanner.py);
 *   - the analysis digest carries exactly the keys of make_golden._smc_digest.
 */
import { describe, it, expect } from 'vitest';
import load from '../golden/load.js';
import compare from '../golden/compare.js';
import registry from '../golden/engines.js';
import { pyRound } from '../../strategies/common/pyround.js';

const HARNESS_KEYS = ['i', 'ts', 'open_time_ms', 'n_mtf_bars', 'n_htf_bars', 'n_ltf_bars'];
const RECORD_KEYS = [
  'symbol', 'direction', 'score', 'grade', 'entry_low', 'entry_high', 'entry', 'sl', 'tp1', 'tp2', 'tp3',
  'rr', 'risk_pct', 'confirmations', 'narrative', 'session', 'tf_htf', 'tf_mtf', 'tf_ltf', 'mode_tag',
  'squeeze_score', 'passes_ctx_gate', 'rr_ladder',
];

const engine = registry.get('smc');
const expected = load.loadExpected('smc');
const digestDoc = load.loadExpected('smc_analysis');
const SYMBOLS = ['BTC-USDT-SWAP', ...load.listSymbols().filter((s) => s !== 'BTC-USDT-SWAP').slice(0, 2)];

function runBar(symbol, variantName, i, prepared, frames) {
  const variant = { name: variantName, ...expected.variants[variantName] };
  const b = load.barInputs(frames, i);
  return engine.run({ symbol, i, closeMs: b.closeMs, openTimeMs: b.openTimeMs, variant, prepared, dfHtf: b.dfHtf4h, dfMtf: b.df, dfLtf: b.dfLtf15m });
}

/** Every number under `key` in `value` must be a pyRound(·, k) fixed point. */
function assertPreRounded(value, key, where) {
  const k = compare.ROUNDED_FIELDS[key];
  if (k === undefined) return;
  const nums = Array.isArray(value) ? value : [value];
  for (const v of nums) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    expect(pyRound(v, k), `${where}.${key} must be rounded by the engine (round(x, ${k}))`).toBe(v);
  }
}

describe('SMC record schema parity (fixture bars)', () => {
  for (const variantName of load.VARIANTS) {
    describe(`variant ${variantName}`, () => {
      for (const symbol of SYMBOLS) {
        it(`${symbol}: engine record keys == asdict(SMCSignalResult) + scanner post-steps; rounded fields pre-rounded`, () => {
          const frames = load.loadFrames(symbol);
          const prepared = engine.prepare(frames, { name: variantName, ...expected.variants[variantName] });
          const fx = expected.fixtures[symbol][variantName];
          expect(fx.signals.length).toBeGreaterThan(0);
          for (const rec of fx.signals) {
            const out = runBar(symbol, variantName, rec.i, prepared, frames);
            const where = `${variantName}/${symbol}/bar ${rec.i}`;
            expect(out.signal, where).not.toBeNull();
            const fixtureKeys = Object.keys(rec).filter((k) => !HARNESS_KEYS.includes(k));
            expect(fixtureKeys, `${where}: fixture record keys`).toEqual(RECORD_KEYS);
            expect(Object.keys(out.signal), `${where}: engine record keys (order matters)`).toEqual(RECORD_KEYS);
            for (const key of RECORD_KEYS) assertPreRounded(out.signal[key], key, where);
            // confirmations: 8 [label, bool] pairs, labels identical to the fixture
            expect(out.signal.confirmations).toHaveLength(8);
            for (let c = 0; c < 8; c++) {
              expect(typeof out.signal.confirmations[c][0]).toBe('string');
              expect(typeof out.signal.confirmations[c][1]).toBe('boolean');
              expect(out.signal.confirmations[c]).toEqual(rec.confirmations[c]);
            }
            expect(typeof out.signal.passes_ctx_gate).toBe('boolean');
            expect(Number.isInteger(out.signal.squeeze_score)).toBe(true);
            expect(Number.isInteger(out.signal.score)).toBe(true);
          }
        });
      }
    });
  }

  it('analysis digest keys == make_golden._smc_digest keys (default key)', () => {
    const symbol = SYMBOLS[0];
    const frames = load.loadFrames(symbol);
    const prepared = engine.prepare(frames, { name: 'default', ...expected.variants.default });
    for (const i of [load.SWEEP.warmupIndex, 300, frames['1h'].length - 1]) {
      const out = runBar(symbol, 'default', i, prepared, frames);
      const want = digestDoc.fixtures[symbol][String(i)];
      expect(Object.keys(out.digest).sort()).toEqual(Object.keys(want).sort());
      expect(compare.compareDigest(out.digest, want)).toEqual([]);
    }
  });
});
