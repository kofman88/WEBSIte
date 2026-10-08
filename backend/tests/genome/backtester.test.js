/**
 * backtest.Backtester (the genome path) over the JS engines, against the bot on the golden
 * candles. Python vectors (make_genome_vectors.py "simulate" / "backtests"):
 *   Backtester(S, params=pv)._simulate_trade(sig, sym, df, i)     1210 synthetic branch cases
 *       (SL-first, BE after TP1, PTP+BE, partial chains, TP3 gap, TIMEOUT incl. end of data,
 *        BACKTEST_DISABLE_BE_MOVE, slippage 0 / 0.25, partial TP off / custom) + 120 on golden bars
 *   Backtester(S, params=genome + fees, silent=True, fast_mode=True).run_in_thread(sym, df, "15m", days)
 *       3 golden fixtures (BTC / SYNDN01 / SYNLV01 15m) × LEVELS / SMC / VOLUME, fixed genomes
 *   await genome.evaluate_genome(S, g, "15m", _preloaded={sym: df}) on the same three coins
 * Every value is bit-identical, SMC liquidity-adjusted prices included: the bot's CPython 3.11
 * sum() is the same left-to-right addition as findEqualLevels (strategies/smc/liquidity.js), so
 * no price field may differ by even 1 ulp (compareTrade still reports any such diff by name).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadFixture, pyEqual, close, memLog } = require('./helpers');
const B = require('../../services/genome/backtester');
const E = require('../../services/genome/evaluate');
const { Frame } = require('../../strategies/common/frame');
const { loadFrame } = require('../golden/load');

const SIM = loadFixture('simulate');
const BT = loadFixture('backtests');

const PRICE_FIELDS = new Set(['entry', 'sl', 'tp1', 'tp2', 'tp3', 'exit_price']);

/** Compare two trade dicts (everything exact; a price off by <= 1e-12 relative is counted, not thrown). Returns that count. */
function compareTrade(js, py, label) {
  let ulp = 0;
  expect(Object.keys(js).sort(), label).toEqual(Object.keys(py).filter((k) => k !== '_exit_idx').sort());
  for (const k of Object.keys(js)) {
    if (PRICE_FIELDS.has(k)) {
      expect(close(js[k], py[k]), `${label} ${k}: js ${js[k]} py ${py[k]}`).toBe(true);
      if (js[k] !== py[k]) ulp++;
    } else {
      expect(pyEqual(js[k], py[k]), `${label} ${k}: js ${js[k]} py ${py[k]}`).toBe(true);
    }
  }
  return ulp;
}

describe('_simulate_trade branch table', () => {
  it('1210 synthetic paths × signals × params × BACKTEST_DISABLE_BE_MOVE — exact', () => {
    const frames = {};
    for (const [name, bars] of Object.entries(SIM.paths)) {
      frames[name] = Frame.fromBars(bars.map((b, i) => [SIM.start_ms + i * SIM.step_ms, b[0], b[1], b[2], b[3], 1.0]));
    }
    const results = new Set();
    for (const [n, c] of SIM.synthetic.entries()) {
      const t = B.simulateTrade(c.sig, 'SYN-USDT-SWAP', frames[c.path], c.i, { params: c.params, strategy: 'LEVELS', env: { BACKTEST_DISABLE_BE_MOVE: c.env_be } });
      if (c.trade === null) { expect(t, `#${n}`).toBeNull(); continue; }
      expect(t, `#${n}`).not.toBeNull();
      expect(compareTrade({ ...t }, c.trade, `#${n} ${c.path}`)).toBe(0);
      expect(t._exitIdx, `#${n} exit idx`).toBe(c.trade._exit_idx);
      results.add(t.result);
    }
    for (const r of ['SL', 'BE', 'PTP+BE', 'TP1', 'TP2', 'TP3', 'PTP+TP1', 'PTP+TP2', 'PTP+TP3', 'TIMEOUT']) expect([...results]).toContain(r);
  });

  it('120 signals on golden 15m bars — exact', () => {
    for (const [n, c] of SIM.golden.entries()) {
      const t = B.simulateTrade(c.sig, 'SYN-USDT-SWAP', loadFrame(c.symbol, c.tf), c.i, { params: c.params, strategy: 'SMC', env: { BACKTEST_DISABLE_BE_MOVE: '0' } });
      if (c.trade === null) { expect(t).toBeNull(); continue; }
      expect(compareTrade({ ...t }, c.trade, `golden #${n}`)).toBe(0);
      expect(t._exitIdx).toBe(c.trade._exit_idx);
    }
  });

  it('fees: fee_pct / risk %, clamp [0, 0.5], slippage_extra only when the in-sim slippage is 0', () => {
    const t = { entry: 100, sl: 99, rr_realized: 1.5 };
    expect(B.applyFees({ ...t }, { fee_pct: 0.12 }).rr_realized).toBe(1.38);
    expect(B.applyFees({ ...t }, { fee_pct: 0.12, slippage_pct: 0, slippage_extra_pct: 0.1 }).rr_realized).toBe(1.28);
    expect(B.applyFees({ entry: 100, sl: 99.9, rr_realized: 1 }, { fee_pct: 0.12 }).rr_realized).toBe(0.5);
    expect(B.applyFees({ entry: 100, sl: 0, rr_realized: 1 }, {}).rr_realized).toBe(0.89);
    expect(B.tsString(Date.UTC(2025, 11, 23, 16, 0, 0))).toBe('2025-12-23 16:00:00');
  });
});

describe('cpySum — builtin sum() over Python floats mixed with np.float64 (backtest.py avg_mae / avg_mfe)', () => {
  // Printed by CPython 3.11.17 + numpy 1.26.4: sum(xs) → (repr(float(s)), type(s).__name__).
  // 3.12 would give 1.0 / float for the first two (Neumaier-compensated float fast path).
  it('plain left-to-right like CPython 3.11; np.float64 as soon as one item is', () => {
    expect(B.cpySum(Array(10).fill([0.1, false]))).toEqual([0.9999999999999999, false]);
    expect(B.cpySum([[1e16, false], [1.0, false], [-1e16, false]])).toEqual([0.0, false]);
    expect(B.cpySum([[0.1, false], [0.2, false], [0.3, true], [0.4, false], [1e16, false], [-1e16, false]])).toEqual([0.0, true]);
    expect(B.cpySum([[1e16, false], [1.0, false], [-1e16, true], [1.0, false]])).toEqual([1.0, true]);
    expect(B.cpySum([[0.1, true], [0.2, false], [0.3, false]])).toEqual([0.6000000000000001, true]);
    expect(B.cpySum([[0.0, false], [0.0, false], [0.7, true], [0.1, false], [0.2, false]])).toEqual([1.0, true]);
    expect(B.cpySum([])).toEqual([0, false]);
  });
});

describe('run_in_thread on 3 golden fixtures × 3 strategies vs the bot', () => {
  it('identical BacktestResult (trade list, counts, PF, ratios); SMC prices bit-identical', () => {
    let totalTrades = 0;
    let ulp = 0;
    for (const run of BT.runs) {
      const p = { ...run.genome, fee_pct: 0.12, slippage_extra_pct: 0.10 };
      const bt = B.createBacktester(run.strategy, p);
      const r = bt.runInThread(run.symbol, loadFrame(run.symbol, run.tf), run.tf, run.result.period_days);
      const label = `${run.strategy} ${run.symbol}`;
      for (const k of Object.keys(run.result)) {
        if (k === 'trades') continue;
        expect(pyEqual(r[k], run.result[k]), `${label} ${k}: js ${r[k]} py ${run.result[k]}`).toBe(true);
      }
      expect(r.trades.length, label).toBe(run.result.trades.length);
      let runUlp = 0;
      r.trades.forEach((t, i) => { runUlp += compareTrade(t, run.result.trades[i], `${label} trade ${i}`); });
      expect(runUlp, label).toBe(0);
      ulp += runUlp;
      totalTrades += r.total_trades;
    }
    expect(totalTrades).toBeGreaterThan(200);
    expect(ulp).toBe(0);
  }, 120_000);
});

function fakeStore() {
  const m = new Map();
  return { m, kvGet: (k) => (m.has(k) ? m.get(k) : null), kvSet: (k, v) => { m.set(k, String(v)); } };
}

describe('evaluate_genome on the 3 golden fixtures', () => {
  const frames = () => new Map(['BTC-USDT-SWAP', 'SYNDN01-USDT-SWAP', 'SYNLV01-USDT-SWAP'].map((s) => [s, loadFrame(s, '15m')]));

  it('the metrics dict and the coin-champion kv equal the bot (MC p95 injected)', async () => {
    for (const ev of BT.evaluate) {
      const store = fakeStore();
      const out = await E.evaluateGenome(ev.strategy, ev.genome, ev.tf, {
        preloaded: frames(),
        deps: { cache: new Map(), now: () => BT.now, sleep: async () => {}, log: memLog(), store, mcP95Dd: ev.mc_p95_raw === null ? undefined : ev.mc_p95_raw },
      });
      expect(pyEqual({ ...out }, ev.out), `${ev.strategy}: js ${JSON.stringify(out)}\npy ${JSON.stringify(ev.out)}`).toBe(true);
      expect(Object.fromEntries(store.m), ev.strategy).toEqual(ev.kv_writes);
    }
  }, 120_000);

  it('a fixed genome gives a reproducible trade list and metrics run-to-run (JS MC included)', async () => {
    const run = async (strategy, genome) => {
      const trades = [];
      const factory = (S, p, o) => {
        const bt = B.createBacktester(S, p, o);
        return { runInThread: (...a) => { const r = bt.runInThread(...a); trades.push(...r.trades.map((t) => `${t.entry_time}|${t.exit_time}|${t.result}|${t.rr_realized}`)); return r; } };
      };
      const out = await E.evaluateGenome(strategy, genome, '15m', {
        preloaded: frames(), deps: { backtesterFactory: factory, cache: new Map(), now: () => 0, sleep: async () => {}, log: memLog(), store: fakeStore() },
      });
      return { out: { ...out }, trades };
    };
    for (const ev of BT.evaluate) {
      const a = await run(ev.strategy, ev.genome);
      const b = await run(ev.strategy, ev.genome);
      expect(a.trades.length).toBeGreaterThan(5);
      expect(b).toEqual(a);
      // everything but the MC-dependent fields equals the bot even with the JS RNG
      for (const k of ['winrate', 'profit_factor', 'trades', 'drawdown', 'live_pf', 'wr_ci_low', 'wr_ci_high', 'regime_mult', 'sample_mult', 'div_mult', 'wf_mult', 'wf_profitable_folds', 'wf_total_folds', 'live_cal_mult']) {
        expect(pyEqual(a.out[k], ev.out[k]), `${ev.strategy} ${k}`).toBe(true);
      }
    }
  }, 120_000);
});

describe('strategy adapters', () => {
  it('LEVELS IndConfig from the genome (no _cfg_to_ind floor), SMC config (retrace gene unused)', () => {
    const ind = B.levelsIndConfig({ min_rr: 1.4, pivot_strength: 10, use_volume: true, cooldown_bars: 5 }, '1h');
    expect(ind).toMatchObject({ TIMEFRAME: '1h', MIN_RR: 1.4, TP1_RR: 1.4, TP2_RR: 1.4 * 1.5, TP3_RR: 1.4 * 2.25, PIVOT_STRENGTH: 10, USE_VOLUME_FILTER: true, USE_RSI_FILTER: false, COOLDOWN_BARS: 5, EMA_FAST: 50, EMA_SLOW: 200, HIGH_WR_MODE: false });
    const smc = B.smcBacktestConfig({ min_confirmations: 3, smc_retrace_depth: 0.5, smc_pd_filter: false, smc_vol_len: 30 });
    expect(smc).toMatchObject({ MIN_CONFIRMATIONS: 3, PD_ENABLED: false, VOL_LEN: 30, SL_BUFFER_PCT: 0.5, OB_MAX_AGE_CANDLES: 100 });
    expect(smc.RETRACE_DEPTH).toBeUndefined();
    expect(smc.CONF_TYPE).toBeUndefined();
  });

  it('a frame of ≤ 200 bars → empty result with coins_tested 0', () => {
    const bt = B.createBacktester('VOLUME', {});
    const r = bt.runInThread('X', loadFrame('BTC-USDT-SWAP', '1h').slice(0, 200), '1h', 60);
    expect(r).toMatchObject({ total_trades: 0, coins_tested: 0, profit_factor: Infinity, win_rate: 0 });
  });
});
