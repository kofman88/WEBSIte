'use strict';
/**
 * backtester.js — the parts of backtest.Backtester the genome uses, one-to-one
 * (genome-challenge-profiles.md §1.6.3–§1.6.4; backtest.py run_in_thread /
 * _backtest_coin_sync / _simulate_trade / _build_result in fast mode), over the JS engines in
 * backend/strategies on candleStore Frames.
 *
 *   createBacktester(strategy, params, opts)  → { runInThread(symbol, df, tf, days) → BacktestResult }
 *   simulateTrade(sig, symbol, df, entryBarIdx, ctx)  _simulate_trade (SL-first, partial TP, TIMEOUT)
 *   buildResult(trades, signals, ctx)          _build_result (fast_mode: no compound / monthly / MC)
 *   applyFees(trade, params)                   the outer-loop fee deduction (rr − fee_r, round 3)
 *   tsString(ms)                               pandas str(Timestamp) of the bar index ("YYYY-MM-DD HH:MM:SS")
 *
 * Walk-forward loop (`_backtest_coin_sync`): bars 200 … len−2 (the last bar is never a signal
 * bar), window = last 600 bars incl. bar i, one open trade at a time (next entry from the bar
 * after the exit), `cooldown_bars` after a signal, LEVELS zones recomputed every
 * `pivot_strength` bars + the 2 × max_dist_pct pre-filter, VOLUME indicators once per
 * coin + the volume candidate mask, stop after 150 trades.
 *
 * Exceptions: SMC / VOLUME per-bar errors → no signal (the bot logs and continues); a LEVELS
 * error aborts the coin, keeping the trades so far (run_in_thread catches it) — as in the bot.
 */

const { pyRound } = require('../../strategies/common/pyround');
const { pyTruthy, pyFloat } = require('../../strategies/common/pyval');
const { pySum } = require('../../strategies/common/series');
const S = require('../../strategies/common/series');
const levels = require('../../strategies/levels');
const smcAnalyzer = require('../../strategies/smc/analyzer');
const smcConfigMod = require('../../strategies/smc/config');
const smcBuilder = require('../../strategies/smc/signalBuilder');
const volumeIndex = require('../../strategies/volume');
const { VolumeConfig } = require('../../strategies/volume/config');
const { prepareContext } = require('../../strategies/volume/context');
const volHtf = require('../../strategies/volume/htf');
const { signalAt } = require('../../strategies/volume/signal');
const { pyIntOf } = require('./constraints');

const TAKER_FEE_RT = 0.0012;      // 0.12 % round-trip taker fee, in R inside _simulate_trade
const MAX_HOLD_BARS = 100;
const LOOKBACK = 200;
const ANALYZE_WINDOW = 600;
const MAX_TRADES_PER_COIN = 150;

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const pget = (p, k, d) => (own(p, k) && p[k] !== undefined ? p[k] : d);
const pyBoolOf = (x) => pyTruthy(x);

/**
 * numpy's round for a float64 scalar (`round(np.float64(x), k)` → np.round): rint(x × 10^k) / 10^k —
 * NOT Python's correctly-rounded round(): round(np.float64(0.6695), 3) = 0.67, round(0.6695, 3) = 0.669.
 */
function rint(y) {
  if (!Number.isFinite(y)) return y;
  const f = Math.floor(y);
  const d = y - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function npRound(x, k) {
  const f = 10 ** k;
  return rint(x * f) / f;
}

/**
 * CPython 3.11 builtin sum() over a mix of exact Python floats and numpy float64 scalars
 * (`items` = [[value, isNumpy]]): the float fast path and the generic PyNumber_Add loop the
 * first numpy item drops to are both plain left-to-right additions (3.12+ would compensate the
 * fast path). The result is a numpy float64 as soon as one item is. Returns [sum, isNumpy].
 */
function cpySum(items) {
  let res = 0;
  let isNp = false;
  for (const [x, np] of items) {
    res += x;
    if (np) isNp = true;
  }
  return [res, isNp];
}

/** pandas str(Timestamp(ms, unit="ms")) for a naive UTC index: "2025-12-23 16:00:00[.ffffff]". */
function tsString(ms) {
  const iso = new Date(ms).toISOString();          // 2025-12-23T16:00:00.000Z
  const base = iso.slice(0, 19).replace('T', ' ');
  const frac = ms % 1000;
  return frac ? `${base}.${String(Math.round(frac * 1000)).padStart(6, '0')}` : base;
}

// ─────────────────────────────────────────────────────────────────────────────
// _simulate_trade
// ─────────────────────────────────────────────────────────────────────────────

function trade(fields) {
  return {
    symbol: fields.symbol,
    direction: fields.direction,
    entry: fields.entry,
    sl: fields.sl,
    tp1: fields.tp1,
    tp2: fields.tp2,
    tp3: fields.tp3,
    entry_time: fields.entry_time,
    exit_time: fields.exit_time,
    exit_price: fields.exit_price,
    result: fields.result,
    rr_realized: fields.rr_realized,
    strategy: fields.strategy,
    mae: fields.mae,
    mfe: fields.mfe,
    duration_bars: fields.duration_bars,
    slippage_applied: fields.slippage_applied,
  };
}

/**
 * _simulate_trade(sig, symbol, df, entry_bar_idx) → trade | null. `ctx` = { params, strategy,
 * env } (env BACKTEST_DISABLE_BE_MOVE ∈ {"1","true"} keeps the SL after partial TP1).
 * Non-enumerable `_exitIdx` = the exit bar index (df.index.searchsorted(exit_time)).
 */
function simulateTrade(sig, symbol, df, entryBarIdx, ctx = {}) {
  const p = ctx.params || {};
  const strategy = ctx.strategy || '';
  const env = ctx.env || process.env;
  const direction = pget(sig, 'direction', 'LONG');
  let entry = pyFloat(pget(sig, 'entry', 0));
  let sl = pyFloat(pget(sig, 'sl', 0));
  const tp1 = pyFloat(pget(sig, 'tp1', 0));
  const tp2 = pyFloat(pget(sig, 'tp2', 0));
  const tp3 = pyFloat(pget(sig, 'tp3', 0));

  if (entry <= 0 || sl <= 0 || tp1 <= 0) return null;
  let risk = Math.abs(entry - sl);
  if (risk <= 0) return null;

  const slippagePct = pyFloat(pget(p, 'slippage_pct', 0.10));
  let slippageR = 0.0;
  if (slippagePct > 0) {
    if (direction === 'LONG') {
      entry = entry * (1 + slippagePct / 100);
      sl = sl * (1 - slippagePct / 100);
    } else {
      entry = entry * (1 - slippagePct / 100);
      sl = sl * (1 + slippagePct / 100);
    }
    risk = Math.abs(entry - sl);
    if (risk <= 0) return null;
    slippageR = slippagePct / 100 * 2;
  }

  const ptpOn = pyBoolOf(pget(p, 'partial_tp_enabled', true));
  const ptp1R = pyFloat(pget(p, 'partial_tp1_r', 1.0));
  const ptp1Pct = pyFloat(pget(p, 'partial_tp1_pct', 40.0));
  const ptp2R = pyFloat(pget(p, 'partial_tp2_r', 1.5));
  const ptp2Pct = pyFloat(pget(p, 'partial_tp2_pct', 30.0));
  const beOverrideOff = ['1', 'true'].includes(String(env.BACKTEST_DISABLE_BE_MOVE === undefined ? '0' : env.BACKTEST_DISABLE_BE_MOVE).trim());
  const ptpMoveSl = pyBoolOf(pget(p, 'partial_tp_move_sl', true)) && !beOverrideOff;
  const sign = direction === 'LONG' ? 1 : -1;

  const ptp1Price = ptpOn ? entry + sign * risk * ptp1R : 0;
  const ptp2Price = ptpOn ? entry + sign * risk * ptp2R : 0;
  const w1 = ptpOn ? ptp1Pct / 100 : 0;
  const w2 = ptpOn ? ptp2Pct / 100 : 0;
  const wRest = ptpOn ? 1.0 - w1 - w2 : 1.0;

  const n = df.length;
  const endIdx = Math.min(entryBarIdx + MAX_HOLD_BARS + 1, n);
  let tp1Hit = false;
  let tp2Hit = false;
  let ptp1Hit = false;
  let ptp2Hit = false;
  let pnlLocked = 0.0;
  let currentSl = sl;
  const entryTime = tsString(df.t[entryBarIdx]);
  let maxAdverse = 0.0;
  let maxFavorable = 0.0;
  // _max_adverse / _max_favorable become numpy float64 once a bar value updates them
  // (bar["low"] is np.float64) → numpy rounding for mae / mfe from then on.
  let advNp = false;
  let favNp = false;
  let j = entryBarIdx;

  const make = (result, exitIdx, exitPrice, rr) => {
    const t = trade({
      symbol, direction, entry, sl, tp1, tp2, tp3,
      entry_time: entryTime, exit_time: tsString(df.t[exitIdx]), exit_price: exitPrice, result,
      rr_realized: rr, strategy,
      mae: advNp ? npRound(maxAdverse, 3) : pyRound(maxAdverse, 3),
      mfe: favNp ? npRound(maxFavorable, 3) : pyRound(maxFavorable, 3),
      duration_bars: j - entryBarIdx, slippage_applied: pyRound(slippageR, 4),
    });
    Object.defineProperty(t, '_exitIdx', { value: exitIdx, enumerable: false, writable: true });
    Object.defineProperty(t, '_maeNp', { value: advNp, enumerable: false });
    Object.defineProperty(t, '_mfeNp', { value: favNp, enumerable: false });
    return t;
  };
  const remainingOpen = () => (ptp2Hit ? wRest : (ptp1Hit ? w2 + wRest : 1.0));

  for (j = entryBarIdx + 1; j < endIdx; j++) {
    const barLow = df.l[j];
    const barHigh = df.h[j];

    let adv;
    let fav;
    if (direction === 'LONG') {
      adv = risk > 0 ? (entry - barLow) / risk : 0;
      fav = risk > 0 ? (barHigh - entry) / risk : 0;
    } else {
      adv = risk > 0 ? (barHigh - entry) / risk : 0;
      fav = risk > 0 ? (entry - barLow) / risk : 0;
    }
    if (adv > maxAdverse) { maxAdverse = adv; advNp = true; }
    if (fav > maxFavorable) { maxFavorable = fav; favNp = true; }

    if (direction === 'LONG') {
      // SL first (worst case: SL and TP on the same bar → SL)
      if (barLow <= currentSl) {
        if (ptpOn && ptp1Hit) {
          const remaining = ptp2Hit ? wRest : (w2 + wRest);
          return make('PTP+BE', j, entry, pyRound(pnlLocked + remaining * 0.0 - TAKER_FEE_RT, 3));
        }
        if (tp1Hit) return make('BE', j, entry, pyRound(0.0 - TAKER_FEE_RT, 3));
        return make('SL', j, sl, pyRound(-1.0 - TAKER_FEE_RT, 3));
      }
      if (ptpOn) {
        if (!ptp1Hit && barHigh >= ptp1Price) {
          pnlLocked += w1 * ptp1R;
          ptp1Hit = true;
          if (ptpMoveSl) currentSl = entry;
        }
        if (ptp1Hit && !ptp2Hit && barHigh >= ptp2Price) {
          pnlLocked += w2 * ptp2R;
          ptp2Hit = true;
        }
      }
      if (tp3 > 0 && barHigh >= tp3) {
        const rrTp = (tp3 - entry) / risk;
        if (ptpOn) {
          return make(ptp1Hit ? 'PTP+TP3' : 'TP3', j, tp3, pyRound(pnlLocked + remainingOpen() * rrTp - TAKER_FEE_RT, 3));
        }
        return make('TP3', j, tp3, pyRound(rrTp - TAKER_FEE_RT, 3));
      }
      if (tp2 > 0 && !tp2Hit && barHigh >= tp2) {
        if (tp3 <= 0) {
          const rrTp = (tp2 - entry) / risk;
          if (ptpOn) return make(ptp1Hit ? 'PTP+TP2' : 'TP2', j, tp2, pyRound(pnlLocked + remainingOpen() * rrTp - TAKER_FEE_RT, 3));
          return make('TP2', j, tp2, pyRound(rrTp - TAKER_FEE_RT, 3));
        }
        tp2Hit = true;
      }
      if (!tp1Hit && barHigh >= tp1) {
        if (tp2 <= 0) {
          const rrTp = (tp1 - entry) / risk;
          if (ptpOn) return make(ptp1Hit ? 'PTP+TP1' : 'TP1', j, tp1, pyRound(pnlLocked + remainingOpen() * rrTp - TAKER_FEE_RT, 3));
          return make('TP1', j, tp1, pyRound(rrTp - TAKER_FEE_RT, 3));
        }
        tp1Hit = true;
      }
    } else {
      if (barHigh >= currentSl) {
        if (ptpOn && ptp1Hit) {
          const remaining = ptp2Hit ? wRest : (w2 + wRest);
          return make('PTP+BE', j, entry, pyRound(pnlLocked + remaining * 0.0 - TAKER_FEE_RT, 3));
        }
        if (tp1Hit) return make('BE', j, entry, pyRound(0.0 - TAKER_FEE_RT, 3));
        return make('SL', j, sl, pyRound(-1.0 - TAKER_FEE_RT, 3));
      }
      if (ptpOn) {
        if (!ptp1Hit && barLow <= ptp1Price) {
          pnlLocked += w1 * ptp1R;
          ptp1Hit = true;
          if (ptpMoveSl) currentSl = entry;
        }
        if (ptp1Hit && !ptp2Hit && barLow <= ptp2Price) {
          pnlLocked += w2 * ptp2R;
          ptp2Hit = true;
        }
      }
      if (tp3 > 0 && barLow <= tp3) {
        const rrTp = (entry - tp3) / risk;
        if (ptpOn) return make(ptp1Hit ? 'PTP+TP3' : 'TP3', j, tp3, pyRound(pnlLocked + remainingOpen() * rrTp - TAKER_FEE_RT, 3));
        return make('TP3', j, tp3, pyRound(rrTp - TAKER_FEE_RT, 3));
      }
      if (tp2 > 0 && !tp2Hit && barLow <= tp2) {
        if (tp3 <= 0) {
          const rrTp = (entry - tp2) / risk;
          if (ptpOn) return make(ptp1Hit ? 'PTP+TP2' : 'TP2', j, tp2, pyRound(pnlLocked + remainingOpen() * rrTp - TAKER_FEE_RT, 3));
          return make('TP2', j, tp2, pyRound(rrTp - TAKER_FEE_RT, 3));
        }
        tp2Hit = true;
      }
      if (!tp1Hit && barLow <= tp1) {
        if (tp2 <= 0) {
          const rrTp = (entry - tp1) / risk;
          if (ptpOn) return make(ptp1Hit ? 'PTP+TP1' : 'TP1', j, tp1, pyRound(pnlLocked + remainingOpen() * rrTp - TAKER_FEE_RT, 3));
          return make('TP1', j, tp1, pyRound(rrTp - TAKER_FEE_RT, 3));
        }
        tp1Hit = true;
      }
    }
  }
  // the for-loop leaves j = endIdx; Python's `for j in range(...)` leaves the LAST value
  j = endIdx > entryBarIdx + 1 ? endIdx - 1 : entryBarIdx;

  // TIMEOUT — market close on the last bar
  const lastIdx = Math.min(endIdx - 1, n - 1);
  const exitPrice = df.c[lastIdx];
  const rrTp = direction === 'LONG' ? (exitPrice - entry) / risk : (entry - exitPrice) / risk;
  let rr;
  if (ptpOn && ptp1Hit) {
    const remaining = ptp2Hit ? wRest : (w2 + wRest);
    rr = pyRound(pnlLocked + remaining * rrTp - TAKER_FEE_RT, 3);
  } else {
    rr = pyRound(rrTp - TAKER_FEE_RT, 3);
  }
  return make('TIMEOUT', lastIdx, exitPrice, rr);
}

/**
 * The outer-loop fee deduction of _backtest_coin_sync ([FIX-OVERFIT] + [PHASE3-FIX 3D-3]):
 * fee_pct (default 0.11; the genome passes 0.12); slippage_extra_pct only when the in-sim
 * slippage_pct is 0; fee_r = clamp((fee + slip_extra) / risk_pct, 0, 0.5); rr − fee_r, round 3.
 */
function applyFees(t, params = {}) {
  const feePct = pyFloat(pget(params, 'fee_pct', 0.11));
  const inSimSlip = pyFloat(pget(params, 'slippage_pct', 0.10));
  const slipExtra = inSimSlip > 0 ? 0.0 : pyFloat(pget(params, 'slippage_extra_pct', 0.10));
  const riskPct = t.entry > 0 && t.sl > 0 ? Math.abs(t.entry - t.sl) / t.entry * 100 : 1.0;
  let feeR = riskPct > 0 ? (feePct + slipExtra) / riskPct : 0.2;
  feeR = Math.max(0.0, Math.min(0.5, feeR));
  t.rr_realized = pyRound(t.rr_realized - feeR, 3);
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// _build_result (fast_mode=True)
// ─────────────────────────────────────────────────────────────────────────────

function buildResult(trades, signals, { strategy = '', timeframe = '', days = 0, coinsTested = 0, symbol = '', params = {}, fastMode = true } = {}) {
  const n = trades.length;
  const losses = trades.filter((t) => t.result === 'SL').length;
  const bes = trades.filter((t) => t.result.includes('BE')).length;
  const timeouts = trades.filter((t) => t.result === 'TIMEOUT').length;
  const closed = trades.filter((t) => t.result !== 'TIMEOUT');
  const wins = closed.filter((t) => t.rr_realized > 0).length;
  const winRate = closed.length ? wins / closed.length : 0.0;
  const winsRr = pySum(closed.filter((t) => t.rr_realized > 0).map((t) => t.rr_realized));
  const lossesRr = pySum(closed.filter((t) => t.rr_realized < 0).map((t) => Math.abs(t.rr_realized)));
  const pf = lossesRr > 0 ? winsRr / lossesRr : Infinity;
  const rets = trades.map((t) => t.rr_realized);
  const avgRr = n ? pySum(rets) / n : 0.0;
  let totalR = pySum(rets);

  let maxCons = 0;
  let cur = 0;
  for (const t of trades) {
    if (t.result === 'SL') { cur += 1; maxCons = Math.max(maxCons, cur); } else cur = 0;
  }
  let peak = 0.0;
  let equity = 0.0;
  let maxDd = 0.0;
  for (const t of trades) {
    equity += t.rr_realized;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  const dollarPct = totalR * 1.0;

  const winT = trades.filter((t) => t.rr_realized > 0);
  const lossT = trades.filter((t) => t.rr_realized < 0);
  const avgWin = winT.length ? pySum(winT.map((t) => t.rr_realized)) / winT.length : 0;
  const avgLoss = lossT.length ? pySum(lossT.map((t) => t.rr_realized)) / lossT.length : 0;
  // sum(t.mae for t in trades) mixes Python floats (0.0, never updated) and numpy float64
  const [maeSum, maeNp] = cpySum(trades.map((t) => [t.mae, Boolean(t._maeNp)]));
  const [mfeSum, mfeNp] = cpySum(trades.map((t) => [t.mfe, Boolean(t._mfeNp)]));
  const avgMae = n ? maeSum / n : 0;
  const avgMfe = n ? mfeSum / n : 0;
  const avgDur = n ? trades.reduce((s, t) => s + t.duration_bars, 0) / n : 0;   // sum of ints is exact

  // fast_mode: no compound equity / monthly breakdown / Monte Carlo
  const compound = 0.0;
  const eqCurve = [];
  const monthly = [];
  const mc = { median: 0, p5: 0, p95: 0, risk_of_ruin_pct: 0, runs: 0 };
  if (!fastMode) throw new Error('backtester: only fast_mode is ported (the genome path)');

  const mean = n ? pySum(rets) / n : 0;
  const std = n > 1 ? Math.sqrt(pySum(rets.map((r) => (r - mean) * (r - mean))) / (n - 1)) : 0;
  const sharpe = std > 0 ? mean / std : 0;
  const ds = n ? Math.sqrt(pySum(rets.map((r) => { const m = r < 0.0 ? r : 0.0; return m * m; })) / n) : 0;
  const sortino = ds > 0 ? mean / ds : 0;
  const calmar = maxDd > 0 ? totalR / maxDd : 0;

  // funding (funding_rate_pct, default 0 → skipped)
  const fp = pyFloat(pget(params, 'funding_rate_pct', 0.0));
  let fr = 0.0;
  if (fp > 0) {
    const TFH = { '1m': 1 / 60, '5m': 5 / 60, '15m': 0.25, '1h': 1, '1H': 1, '4h': 4, '4H': 4, '1d': 24, '1D': 24 };
    const tfh = own(TFH, timeframe) ? TFH[timeframe] : 1;
    for (const t of trades) fr += (t.duration_bars * tfh / 8) * fp / 100;
    totalR -= fr;
  }

  return {
    strategy,
    timeframe,
    period_days: days,
    coins_tested: coinsTested,
    total_signals: signals,
    total_trades: n,
    wins,
    losses,
    breakevens: bes,
    timeouts,
    win_rate: winRate,
    avg_rr: avgRr,
    profit_factor: pf,
    max_consecutive_losses: maxCons,
    max_drawdown_r: maxDd,
    total_r: totalR,
    dollar_result_pct: dollarPct,
    trades: trades.map((t) => ({ ...t })),
    symbol,
    sharpe_ratio: pyRound(sharpe, 3),
    sortino_ratio: pyRound(sortino, 3),
    calmar_ratio: pyRound(calmar, 3),
    avg_win_rr: pyRound(avgWin, 3),
    avg_loss_rr: pyRound(avgLoss, 3),
    avg_duration_bars: pyRound(avgDur, 1),
    avg_mae: n && maeNp ? npRound(avgMae, 3) : pyRound(avgMae, 3),
    avg_mfe: n && mfeNp ? npRound(avgMfe, 3) : pyRound(avgMfe, 3),
    monthly_breakdown: monthly,
    equity_curve: eqCurve,
    monte_carlo: mc,
    compound_final_balance: pyRound(compound, 2),
    slippage_pct: pyFloat(pget(params, 'slippage_pct', 0)),
    funding_total_r: pyRound(fr, 3),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// strategy adapters (configs built from the genome params exactly like the bot)
// ─────────────────────────────────────────────────────────────────────────────

/** _ensure_levels_indicator → IndConfig from the params (no _cfg_to_ind MIN_RR floor here). */
function levelsIndConfig(params, timeframe) {
  const p = params || {};
  const rr = pyFloat(pget(p, 'min_rr', 2.0));
  return {
    TIMEFRAME: timeframe,
    PIVOT_STRENGTH: pyIntOf(pget(p, 'pivot_strength', 7)),
    ATR_PERIOD: 14,
    ATR_MULT: 1.0,
    MAX_RISK_PCT: pyFloat(pget(p, 'max_risk_pct', 1.5)),
    EMA_FAST: pyIntOf(pget(p, 'ema_fast', 50)),
    EMA_SLOW: pyIntOf(pget(p, 'ema_slow', 200)),
    RSI_PERIOD: pyIntOf(pget(p, 'rsi_period', 14)),
    RSI_OB: pyIntOf(pget(p, 'rsi_ob', 65)),
    RSI_OS: pyIntOf(pget(p, 'rsi_os', 35)),
    VOL_MULT: pyFloat(pget(p, 'vol_mult', 1.0)),
    VOL_LEN: pyIntOf(pget(p, 'vol_len', 20)),
    MAX_LEVEL_AGE: pyIntOf(pget(p, 'max_level_age', 100)),
    MAX_RETEST_BARS: pyIntOf(pget(p, 'max_retest_bars', 30)),
    COOLDOWN_BARS: pyIntOf(pget(p, 'cooldown_bars', 0)),
    ZONE_BUFFER: pyFloat(pget(p, 'zone_buffer', 0.3)),
    TP1_RR: pyFloat(pget(p, 'tp1_rr', rr)),
    TP2_RR: pyFloat(pget(p, 'tp2_rr', rr * 1.5)),
    TP3_RR: pyFloat(pget(p, 'tp3_rr', rr * 2.25)),
    HTF_EMA_PERIOD: pyIntOf(pget(p, 'htf_ema_period', 50)),
    HTF_TIMEFRAME: '1d',
    USE_RSI_FILTER: pyTruthy(pget(p, 'use_rsi_filter', false)) || pyTruthy(pget(p, 'use_rsi', false)),
    USE_VOLUME_FILTER: pyTruthy(pget(p, 'use_volume_filter', false)) || pyTruthy(pget(p, 'use_volume', false)),
    USE_PATTERN_FILTER: pyTruthy(pget(p, 'use_pattern_filter', false)),
    USE_HTF_FILTER: false,
    ZONE_PCT: pyFloat(pget(p, 'zone_pct', 0.7)),
    MAX_DIST_PCT: pyFloat(pget(p, 'max_dist_pct', 1.5)),
    MIN_RR: rr,
    MAX_LEVEL_TESTS: pyIntOf(pget(p, 'max_level_tests', 4)),
    HIGH_WR_MODE: false,
  };
}

/** _analyze_smc → SMCConfig(**kwargs); optional fields only when SMCConfig has the attribute. */
function smcBacktestConfig(params) {
  const p = params || {};
  const kw = {
    MIN_CONFIRMATIONS: pyIntOf(pget(p, 'min_confirmations', 2)),
    MIN_RR: pyFloat(pget(p, 'min_rr', 1.5)),
    SL_BUFFER_PCT: pyFloat(pget(p, 'sl_buffer_pct', 0.5)),
    OB_MAX_AGE_CANDLES: pyIntOf(pget(p, 'ob_max_age', 100)),
    FVG_ENABLED: pyTruthy(pget(p, 'fvg_enabled', true)),
    CHOCH_ENABLED: pyTruthy(pget(p, 'choch_enabled', true)),
    OB_USE_BREAKER: pyTruthy(pget(p, 'ob_use_breaker', true)),
    SWING_LOOKBACK: pyIntOf(pget(p, 'swing_lookback', 10)),
    SWEEP_CLOSE_REQUIRED: pyTruthy(pget(p, 'sweep_close_req', false)),
    PD_ENABLED: pyTruthy(pget(p, 'smc_pd_filter', true)),
    VOL_MULT: pyFloat(pget(p, 'smc_vol_mult', 1.2)),
    USE_VOLUME_FILTER: pyTruthy(pget(p, 'smc_use_volume_filter', false)),
  };
  // QUIRK: of CONF_TYPE / RETRACE_DEPTH / MTF_CHECK / MAX_SL_PCT / VOL_LEN only VOL_LEN exists on
  // SMCConfig, so the smc_retrace_depth gene never reaches the backtest (build_smc_signal is
  // called with its default kwargs: WICK_TOUCH, no P/D filter, retrace 0, no MTF check).
  const optional = {
    CONF_TYPE: pget(p, 'smc_conf_type', 'BODY_CLOSE'),
    RETRACE_DEPTH: pyFloat(pget(p, 'smc_retrace_depth', 0.2)),
    MTF_CHECK: pyTruthy(pget(p, 'smc_mtf_check', false)),
    MAX_SL_PCT: pyFloat(pget(p, 'smc_max_sl_pct', 5.0)),
    VOL_LEN: pyIntOf(pget(p, 'smc_vol_len', 20)),
  };
  for (const [k, v] of Object.entries(optional)) if (own(smcConfigMod.SMC_CONFIG_DEFAULTS, k)) kw[k] = v;
  return smcConfigMod.smcConfig(kw);
}

const sigDict = (s) => (s ? { direction: s.direction, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3 } : null);

/**
 * _backtest_coin_sync(symbol, df, timeframe): the walk-forward loop → { trades, signals }.
 * Throws only for a LEVELS analysis error (the caller keeps the partial trade list).
 */
function backtestCoinSync(strategy, params, symbol, df, timeframe, { env = process.env, onError = null, state = null } = {}) {
  const st = state || { trades: [], signals: 0 };
  const p = params || {};
  let nextFreeBar = LOOKBACK;
  let lastSignalBar = -9999;
  const cooldownBars = pyIntOf(pget(p, 'cooldown_bars', 0));

  const isLevels = strategy === 'LEVELS';
  const ps = pyIntOf(pget(p, 'pivot_strength', 7));
  const maxDist = pyFloat(pget(p, 'max_dist_pct', 1.5));
  let cachedZones = null;
  let cachedZprices = [];
  let nextZoneRefresh = LOOKBACK;
  let levelsCfg = null;
  const minQ = pyIntOf(pget(p, 'min_quality', 3));

  const isVolume = strategy === 'VOLUME';
  let volOk = null;
  let vctx = null;
  let vcfg = null;
  if (isVolume) {
    try {
      vcfg = VolumeConfig.fromParams(p);
      const htfArr = vcfg.use_htf ? volHtf.htfStateSeries(df, timeframe, vcfg) : null;
      vctx = prepareContext(df, vcfg, htfArr, volHtf.htfFor(timeframe));
      volOk = vctx.candidateMask();
    } catch (e) {
      if (onError) onError(e, 'backtest VOLUME prefilter failed');
      volOk = null;
      vctx = null;
    }
  }
  let smcCfg = null;

  const analyzeOther = (slice) => {
    try {
      if (strategy === 'SMC') {
        if (!smcCfg) smcCfg = smcBacktestConfig(p);
        const analysis = smcAnalyzer.analyze(symbol, slice, slice, slice, smcCfg);
        const sig = smcBuilder.buildSmcSignal(symbol, analysis, smcCfg);
        if (!sig) return null;
        return {
          direction: sig.direction, entry: pyFloat(sig.entry), sl: pyFloat(sig.sl),
          tp1: pyFloat(sig.tp1), tp2: pyFloat(sig.tp2), tp3: pyFloat(sig.tp3),
        };
      }
      if (strategy === 'VOLUME') {
        if (!vcfg) vcfg = VolumeConfig.fromParams(p);
        const dfHtf = vcfg.use_htf ? volHtf.resampleHtf(slice, timeframe) : null;
        return sigDict(volumeIndex.analyzeVolume(symbol, slice, vcfg, timeframe, dfHtf));
      }
      if (strategy === 'LEVELS') return analyzeLevels(slice, null);
    } catch (e) {
      if (onError) onError(e, `analyze ${symbol}`);
    }
    return null;
  };

  const analyzeLevels = (slice, zones) => {
    if (!levelsCfg) levelsCfg = levelsIndConfig(p, timeframe);
    let res;
    try {
      res = levels.doAnalyze(symbol, slice, null, null, null, levelsCfg, { minQualityOverride: minQ, precomputedZones: zones });
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      res = levels.analyzeOnDemand(symbol, slice, null, null, null, levelsCfg);     // `except TypeError` fallback
    }
    return sigDict(res && res.signal);
  };

  const n = df.length;
  for (let i = LOOKBACK; i < n - 1; i++) {
    if (i < nextFreeBar) continue;
    if (cooldownBars > 0 && i - lastSignalBar <= cooldownBars) continue;
    if (volOk !== null && !volOk[i]) continue;

    const winStart = Math.max(0, i + 1 - ANALYZE_WINDOW);
    const slice = df.slice(winStart, i + 1);

    let sig;
    if (isLevels) {
      if (i >= nextZoneRefresh) {
        try {
          if (!levelsCfg) levelsCfg = levelsIndConfig(p, timeframe);
          const atr = S.atrEmaSpan(slice.h, slice.l, slice.c, levelsCfg.ATR_PERIOD);
          const atrNow = atr.length >= 2 ? atr[atr.length - 1] : S.seriesMean(slice.c) * 0.01;
          const z = levels.getZones(slice, levelsCfg.PIVOT_STRENGTH, atrNow, levelsCfg.ZONE_BUFFER);
          cachedZones = { sup: z.sup, res: z.res };
          cachedZprices = z.sup.concat(z.res).map((zz) => zz.price);
        } catch (e) {
          if (onError) onError(e, 'indicator.get_zones() unhandled exception');
          cachedZones = { sup: [], res: [] };        // get_zones swallows → ([], [])
          cachedZprices = [];
        }
        nextZoneRefresh = i + ps;
      }
      if (cachedZprices.length) {
        const close = slice.c[slice.length - 1];
        let near = false;
        for (const zp of cachedZprices) if (Math.abs(close - zp) / close * 100 <= maxDist * 2) { near = true; break; }
        if (!near) continue;
      }
      sig = analyzeLevels(slice, cachedZones);
    } else if (vctx !== null) {
      try {
        sig = sigDict(signalAt(vctx, i, symbol, timeframe));
      } catch (e) {
        if (onError) onError(e, `analyze VOLUME ${symbol}`);
        sig = null;
      }
    } else {
      sig = analyzeOther(slice);
    }

    if (!sig) continue;
    st.signals += 1;
    lastSignalBar = i;
    const t = simulateTrade(sig, symbol, df, i, { params: p, strategy, env });
    if (t !== null) {
      applyFees(t, p);
      st.trades.push(t);
      nextFreeBar = t._exitIdx + 1;
      if (st.trades.length >= MAX_TRADES_PER_COIN) break;
    }
  }
  return st;
}

/**
 * Backtester(strategy, params, silent=True, fast_mode=True) for the genome: runInThread(symbol,
 * df, tf, days) → BacktestResult (len(df) ≤ 200 → empty result with coins_tested 0).
 */
function createBacktester(strategy, params = {}, { env = process.env, onError = null } = {}) {
  return {
    strategy,
    params,
    runInThread(symbol, df, timeframe, days) {
      if (!df || df.length <= LOOKBACK) {
        return buildResult([], 0, { strategy, timeframe, days, coinsTested: 0, symbol, params });
      }
      const st = { trades: [], signals: 0 };
      try {
        backtestCoinSync(strategy, params, symbol, df, timeframe, { env, onError, state: st });
      } catch (e) {
        if (onError) onError(e, `run_in_thread ${symbol}`);
      }
      return buildResult(st.trades, st.signals, { strategy, timeframe, days, coinsTested: 1, symbol, params });
    },
  };
}

module.exports = {
  TAKER_FEE_RT, MAX_HOLD_BARS, LOOKBACK, ANALYZE_WINDOW, MAX_TRADES_PER_COIN,
  rint, npRound, cpySum, tsString, simulateTrade, applyFees, buildResult, levelsIndConfig, smcBacktestConfig, backtestCoinSync, createBacktester,
};
