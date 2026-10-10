/**
 * Adversarial verification of the pure genome pieces against FRESH bot vectors
 * (make_genome_verify_vectors.py; none of these inputs are used by make_genome_vectors.py):
 *   genome._fix_constraints(dict(g), S)       500 genomes per strategy (in-space / out-of-range /
 *                                             int↔float / missing keys (VOLUME refill under the
 *                                             mulberry32 shim, `seed`) / legacy keys / None values)
 *   await genome.evaluate_genome(S, g, tf, _preloaded=fake results, _live_wr_baseline=b)
 *                                             200 trade lists (empty, all-BE, all-loss, single trade,
 *                                             min-trades edges, equal timestamps, 175 / 184 test
 *                                             trades, …), random.Random(42) recorded → mc_p95_raw
 *   genome.compute_fitness(wr, pf, n, dd)     edge tuples
 *   Backtester(S, params=g + fees).run_in_thread(sym, df, tf, days)
 *                                             15m: 6 golden fixtures × 3 strategies × 5 genomes, + the
 *                                             evaluate_genome dict over the 6 recorded results;
 *                                             1h / 4h: the same genomes over 12 golden fixtures
 * Every comparison is exact, SMC liquidity-adjusted prices included: the bot's CPython 3.11 sum()
 * is the same left-to-right addition as strategies/smc/liquidity.js (a 1-ulp price diff fails).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { FIXTURES, loadFixture, pyEqual, memLog } = require('./helpers');
const { fixConstraints } = require('../../services/genome/constraints');
const { createRng } = require('../../services/genome/rng');
const { serializeGenome, parsePyJson, GENE_SPACE, FLOAT_GENE_KEYS } = require('../../services/genome/geneSpace');
const F = require('../../services/genome/fitness');
const E = require('../../services/genome/evaluate');
const BT = require('../../services/genome/backtester');
const { loadFrame } = require('../golden/load');

/**
 * The Python int/float kind of every integral number in the bot's serialize_genome text agrees
 * with the gene's declared kind (FLOAT_GENE_KEYS) — true for every genome the bot's operators
 * produce (float genes hold floats, int / choice genes ints). JS numbers cannot carry the kind of
 * an int stored in a float gene (or 4.0 in an int gene), so the byte comparison of
 * serialize_genome is made for kind-consistent genomes; the VALUES are compared for all.
 */
function kindsConsistent(pyJson) {
  const { value, floatKeys } = parsePyJson(pyJson);
  return Object.entries(value).every(([k, v]) => typeof v !== 'number' || !Number.isInteger(v) || FLOAT_GENE_KEYS.has(k) === floatKeys.has(k));
}

describe('[VOL-MIN-VOLUME 2026-10] _fix_constraints raises the VOLUME bounce_vol_mult to the setup volume floor', () => {
  const V = loadFixture('verify_constraints_floor');
  const Q = require('../../strategies/volume').quality;
  it(`${V.cases.length} cases: VOLUME_MIN_SETUP_VOL_MULT values × bounce values / kinds — the same repaired dict (or exception)`, () => {
    const bad = [];
    let raised = 0;
    try {
      for (const [i, c] of V.cases.entries()) {
        Q.setEnv(c.env === null ? {} : { VOLUME_MIN_SETUP_VOL_MULT: c.env });
        Q._resetForTests();
        let out = null;
        let err = null;
        try { out = fixConstraints(c.in, 'VOLUME', createRng(9100)); } catch (e) { err = e.name; }
        if (c.error) { raised++; if (err !== c.error) bad.push(`#${i} env ${c.env}: py ${c.error}, js ${err}`); continue; }
        if (err) { bad.push(`#${i} env ${c.env}: js raised ${err}`); continue; }
        if (!pyEqual(out, c.out)) bad.push(`#${i} env ${c.env} bounce ${JSON.stringify(c.in.bounce_vol_mult)}: js ${out.bounce_vol_mult} py ${JSON.stringify(c.out.bounce_vol_mult)}`);
      }
    } finally {
      Q.setEnv(null);
    }
    expect(bad, bad.slice(0, 10).join('\n')).toEqual([]);
    // the floor applied (default env), env 2.7 above the gene range, env 0 off, odd kinds kept
    expect(V.cases.some((c) => c.env === null && c.in.bounce_vol_mult === 0.8 && c.out.bounce_vol_mult === 1.5)).toBe(true);
    expect(V.cases.some((c) => c.env === '2.7' && c.in.bounce_vol_mult === 2.0 && c.out.bounce_vol_mult === 2.7)).toBe(true);
    expect(V.cases.some((c) => c.env === '0' && c.in.bounce_vol_mult === 0.8 && c.out.bounce_vol_mult === 0.8)).toBe(true);
    expect(raised).toBe(0);
  });
});

describe('_fix_constraints — 500 fresh genomes per strategy vs the bot', () => {
  const V = loadFixture('verify_constraints');
  it('same repaired dict (or the same Python exception type); same serialize_genome when the kinds round-trip', () => {
    const bad = [];
    let raised = 0;
    let jsonChecked = 0;
    for (const [S, cases] of Object.entries(V)) {
      expect(cases.length).toBe(500);
      for (const [i, c] of cases.entries()) {
        let out = null;
        let err = null;
        try { out = fixConstraints(c.in, S, createRng(c.seed)); } catch (e) { err = e.name; }
        if (c.error) {
          raised++;
          if (err !== c.error) bad.push(`${S}#${i} ${c.kind}: py ${c.error}, js ${err || JSON.stringify(out)}`);
          continue;
        }
        if (err) { bad.push(`${S}#${i} ${c.kind}: js raised ${err}`); continue; }
        if (!pyEqual(out, c.out)) { bad.push(`${S}#${i} ${c.kind}: js ${JSON.stringify(out)} py ${JSON.stringify(c.out)}`); continue; }
        if (kindsConsistent(c.out_json)) {
          jsonChecked++;
          if (serializeGenome(out) !== c.out_json) bad.push(`${S}#${i} json: js ${serializeGenome(out)} py ${c.out_json}`);
        }
      }
    }
    expect(bad, bad.slice(0, 10).join('\n')).toEqual([]);
    expect(raised).toBeGreaterThan(3);
    expect(jsonChecked).toBeGreaterThan(1000);
  });

  it('in-space genomes (what random_genome / mutate / crossover produce) serialise byte-identically', () => {
    let n = 0;
    for (const [S, cases] of Object.entries(V)) {
      for (const c of cases.filter((x) => x.kind === 'space' && !x.error)) {
        // the targeted rule triggers may plant a 4.0 / "4" (VOLUME min_quality) — not in-space
        if (!kindsConsistent(c.out_json)) continue;
        n++;
        expect(serializeGenome(fixConstraints(c.in, S, createRng(c.seed)))).toBe(c.out_json);
      }
    }
    expect(n).toBeGreaterThan(380);
    expect(Object.keys(GENE_SPACE)).toEqual(Object.keys(V));
  });
});

describe('_fix_constraints — Python comparison semantics for a JSON null / str gene value', () => {
  // BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $VENV -c "import genome; genome._fix_constraints(g, S)" for each g:
  //   LEVELS {tp1_rr: None, min_rr: 2.0}                       → TypeError ('<' NoneType / float)
  //   LEVELS {tp1_rr: 2.0, min_rr: 2.0, tp2_rr: None}          → TypeError
  //   LEVELS {…, tp2_rr: 3.0, ema_fast: None, ema_slow: 50}    → TypeError ('>=' NoneType / int)
  //   LEVELS {…, use_rsi: False, use_volume: False, min_quality: None} → TypeError
  //   LEVELS {…, use_rsi: True, min_quality: "3"}              → unchanged (`not use_rsi` short-circuits)
  //   SMC {min_rr: None, min_confirmations: 4, fvg_enabled: True}   → TypeError ('>' NoneType / float)
  //   SMC {min_rr: 2.4, min_confirmations: None, …}            → TypeError
  //   SMC {min_rr: "2.4", min_confirmations: 4, …}             → TypeError ('>' str / float)
  //   SMC {min_rr: 2.4, min_confirmations: True, …}            → unchanged (True ≥ 4 is False)
  it('raises TypeError where CPython does, keeps the short-circuits', () => {
    const L = { tp1_rr: 2.0, min_rr: 2.0, tp2_rr: 3.0 };
    const raises = [
      [{ tp1_rr: null, min_rr: 2.0 }, 'LEVELS'],
      [{ tp1_rr: 2.0, min_rr: 2.0, tp2_rr: null }, 'LEVELS'],
      [{ ...L, ema_fast: null, ema_slow: 50 }, 'LEVELS'],
      [{ ...L, use_rsi: false, use_volume: false, min_quality: null }, 'LEVELS'],
      [{ min_rr: null, min_confirmations: 4, fvg_enabled: true }, 'SMC'],
      [{ min_rr: 2.4, min_confirmations: null, fvg_enabled: true }, 'SMC'],
      [{ min_rr: '2.4', min_confirmations: 4, fvg_enabled: true }, 'SMC'],
    ];
    for (const [g, S] of raises) expect(() => fixConstraints(g, S), JSON.stringify(g)).toThrow(TypeError);
    expect(fixConstraints({ ...L, use_rsi: true, min_quality: '3' }, 'LEVELS')).toEqual({ ...L, use_rsi: true, min_quality: '3' });
    expect(fixConstraints({ min_rr: 2.4, min_confirmations: true, fvg_enabled: true }, 'SMC'))
      .toEqual({ min_rr: 2.4, min_confirmations: true, fvg_enabled: true });
  });
});

function fakeStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { m, kvGet: (k) => (m.has(k) ? m.get(k) : null), kvSet: (k, v) => { m.set(k, String(v)); } };
}
const fakeFactory = () => () => ({
  runInThread(coin, df) {
    if (df && df.raise) throw new Error(`boom ${coin}`);
    return df === null || df === undefined ? null : df;
  },
});

describe('evaluate_genome — 200 fresh trade lists vs the bot (MC p95 injected)', () => {
  const V = loadFixture('verify_fitness');
  it('the whole metrics dict and the coin-champion kv writes', async () => {
    const bad = [];
    const kinds = new Map();
    for (const [i, c] of V.cases.entries()) {
      const store = fakeStore(c.kv_before);
      const before = new Map(store.m);
      const out = await E.evaluateGenome(c.strategy, c.genome, c.tf, {
        preloaded: c.preloaded,
        liveWrBaseline: c.baseline,
        deps: {
          backtesterFactory: fakeFactory(), cache: new Map(), now: () => V.now, mono: () => 0, sleep: async () => {},
          cpuShare: 0.15, log: memLog(), store, mcP95Dd: c.mc_p95_raw === null ? undefined : c.mc_p95_raw,
        },
      });
      if (!pyEqual({ ...out }, c.out)) bad.push(`#${i} ${c.kind}: js ${JSON.stringify(out)}\npy ${JSON.stringify(c.out)}`);
      const writes = {};
      for (const [k, v] of store.m) if (before.get(k) !== v) writes[k] = v;
      if (!pyEqual(writes, c.kv_writes)) bad.push(`#${i} kv: js ${JSON.stringify(writes)} py ${JSON.stringify(c.kv_writes)}`);
      const nz = out.trades > 0 ? 'scored' : 'zero';
      kinds.set(`${c.kind}:${nz}`, (kinds.get(`${c.kind}:${nz}`) || 0) + 1);
    }
    expect(bad, bad.slice(0, 6).join('\n')).toEqual([]);
    for (const k of ['empty:zero', 'all_be:scored', 'all_loss:scored', 'single:zero', 'big:scored', 'wf:scored', 'same_ts:scored']) {
      expect(kinds.get(k), k).toBeGreaterThan(0);
    }
    // the 175 / 184 log1p pins are exercised
    expect(V.cases.some((c) => c.out.trades === 175 || c.out.trades === 184)).toBe(true);
  });

  it('compute_fitness on the edge tuples (N 7/8/50/51/175/184, WR 0.35 / 1.0 / 35 %, PF 1.2, DD 1.0)', () => {
    for (const c of V.compute_fitness) {
      expect(F.computeFitness(c.winrate, c.profit_factor, c.trades, c.drawdown), JSON.stringify(c)).toBe(c.out);
    }
    expect(V.compute_fitness.length).toBeGreaterThan(150);
  });
});

const PRICE = new Set(['entry', 'sl', 'tp1', 'tp2', 'tp3', 'exit_price']);
const BT_FIXTURES = ['verify_backtests_levels', 'verify_backtests_smc', 'verify_backtests_volume', 'verify_wide']
  .filter((n) => fs.existsSync(path.join(FIXTURES, `${n}.json.gz`)));

describe('run_in_thread on fresh golden fixtures × 5 genomes per strategy vs the bot', () => {
  it('all strategy fixtures are present (15m × 6 coins per strategy; 1h + 4h × 12 coins)', () => {
    expect(BT_FIXTURES).toHaveLength(4);
  });

  for (const name of BT_FIXTURES) {
    it(`${name}: identical BacktestResult and trade lists (entry/exit bar, result, R, fees, MAE/MFE); evaluate_genome dict`, async () => {
      const V = loadFixture(name);
      const bad = [];
      let trades = 0;
      let ulp = 0;
      const results = new Map();
      for (const run of V.runs) {
        const g = V.genomes[run.strategy][run.g];
        const bt = BT.createBacktester(run.strategy, { ...g, fee_pct: 0.12, slippage_extra_pct: 0.10 }, { env: { BACKTEST_DISABLE_BE_MOVE: '0' } });
        const r = bt.runInThread(run.symbol, loadFrame(run.symbol, run.tf), run.tf, run.days);
        results.set(`${run.strategy}|${run.g}|${run.symbol}|${run.tf}`, r);
        const lab = `${run.strategy}#${run.g} ${run.symbol}`;
        for (const k of Object.keys(run.result)) {
          if (k !== 'trades' && !pyEqual(r[k], run.result[k])) bad.push(`${lab} ${k}: js ${JSON.stringify(r[k])} py ${JSON.stringify(run.result[k])}`);
        }
        if (r.trades.length !== run.result.trades.length) { bad.push(`${lab}: ${r.trades.length} trades vs ${run.result.trades.length}`); continue; }
        r.trades.forEach((t, i) => {
          const p = run.result.trades[i];
          if (Object.keys(t).sort().join() !== Object.keys(p).sort().join()) bad.push(`${lab} trade ${i} keys`);
          for (const k of Object.keys(p)) {
            if (PRICE.has(k) && t[k] !== p[k] && Math.abs(t[k] - p[k]) <= 1e-12 * Math.abs(p[k])) ulp++;   // counted: must stay 0
            if (!pyEqual(t[k], p[k])) bad.push(`${lab} trade ${i} ${k}: js ${t[k]} py ${p[k]}`);
          }
        });
        trades += run.result.trades.length;
      }
      for (const ev of V.evaluate || []) {
        const g = V.genomes[ev.strategy][ev.g];
        const store = fakeStore();
        const out = await E.evaluateGenome(ev.strategy, g, ev.tf, {
          preloaded: new Map(V.coins.map((s) => [s, loadFrame(s, ev.tf)])),
          deps: {
            backtesterFactory: () => ({ runInThread: (coin) => results.get(`${ev.strategy}|${ev.g}|${coin}|${ev.tf}`) }),
            cache: new Map(), now: () => V.now, mono: () => 0, sleep: async () => {}, log: memLog(), store,
            mcP95Dd: ev.mc_p95_raw === null ? undefined : ev.mc_p95_raw,
          },
        });
        if (!pyEqual({ ...out }, ev.out)) bad.push(`evaluate ${ev.strategy}#${ev.g}: js ${JSON.stringify(out)} py ${JSON.stringify(ev.out)}`);
        if (!pyEqual(Object.fromEntries(store.m), ev.kv_writes)) bad.push(`evaluate kv ${ev.strategy}#${ev.g}`);
      }
      expect(bad, bad.slice(0, 10).join('\n')).toEqual([]);
      const wide = name === 'verify_wide';
      expect(V.runs).toHaveLength(wide ? 360 : 30);
      expect(V.coins).toHaveLength(wide ? 12 : 6);
      expect(trades).toBeGreaterThan(name.endsWith('levels') ? 5 : 300);
      expect(ulp).toBe(0);
    }, 300_000);
  }
});
