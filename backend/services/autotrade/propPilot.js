'use strict';
/**
 * propPilot.js — port of prop_pilot.py (Prop Autopilot): the challenge state built from the user's
 * prop_* settings + the live exchange balance, and the adaptive risk that blocks (0.0) or scales
 * the trade.
 *
 *   buildChallengeState(user, balance) → ChallengeState      (persisted peak first — BUG #3)
 *   adaptiveRisk(state, baseRisk) → [riskPct, reason]         (0.0 = block; reasons are the bot's texts)
 *
 * `user` is any object with the bot's column names (the users row).
 */

const { pyRound } = require('../../strategies/common/pyround');
const { fmtFixed } = require('../../strategies/common/pyfmt');

const fget = (u, k, d) => {
  const v = u && Object.prototype.hasOwnProperty.call(u, k) ? u[k] : undefined;
  return v === undefined ? d : v;
};
const pyOrNum = (v, d) => (v === null || v === undefined || v === 0 || v === '' || v === false ? d : v);

class ChallengeState {
  constructor(o = {}) {
    this.capital = 100000.0;
    this.target_pct = 8.0;
    this.max_dd_pct = 5.0;
    this.daily_limit_pct = 4.0;
    this.min_days = 1;
    this.max_days = 30;
    this.trailing_dd = false;
    this.consistency = false;
    this.current_balance = 0.0;
    this.start_balance = 0.0;
    this.day_start_balance = 0.0;
    this.peak_balance = 0.0;
    this.start_date = 0.0;
    this.trading_days = 0;
    Object.assign(this, o);
  }

  get pnl() { return this.current_balance - this.start_balance; }
  get pnl_pct() { return this.start_balance <= 0 ? 0.0 : this.pnl / this.start_balance * 100; }
  get target_amount() { return this.start_balance * this.target_pct / 100; }
  get target_remaining_pct() { return Math.max(0.0, this.target_pct - this.pnl_pct); }
  get target_progress() {
    if (this.target_pct <= 0) return 0.0;
    return Math.min(1.0, Math.max(0.0, this.pnl_pct / this.target_pct));
  }
  get dd_limit() {
    const ref = this.trailing_dd ? this.peak_balance : this.start_balance;
    return ref * this.max_dd_pct / 100;
  }
  get current_dd() {
    const ref = this.trailing_dd ? this.peak_balance : this.start_balance;
    if (ref <= 0) return 0.0;
    return Math.max(0.0, ref - this.current_balance);
  }
  get current_dd_pct() {
    const ref = this.trailing_dd ? this.peak_balance : this.start_balance;
    if (ref <= 0) return 0.0;
    return this.current_dd / ref * 100;
  }
  get dd_remaining_pct() { return Math.max(0.0, this.max_dd_pct - this.current_dd_pct); }
  get dd_ratio() {
    if (this.max_dd_pct <= 0) return 0.0;
    return Math.min(1.0, this.dd_remaining_pct / this.max_dd_pct);
  }
  get daily_pnl() { return this.current_balance - this.day_start_balance; }
  get daily_pnl_pct() { return this.start_balance <= 0 ? 0.0 : this.daily_pnl / this.start_balance * 100; }
  get daily_remaining_pct() {
    if (this.daily_pnl >= 0) return this.daily_limit_pct;
    return Math.max(0.0, this.daily_limit_pct - Math.abs(this.daily_pnl_pct));
  }
  get daily_ratio() {
    if (this.daily_limit_pct <= 0) return 0.0;
    return Math.min(1.0, this.daily_remaining_pct / this.daily_limit_pct);
  }
  get is_passed() { return this.pnl_pct >= this.target_pct && this.trading_days >= this.min_days; }
  get is_failed() { return this.current_dd_pct >= this.max_dd_pct; }
}

function adaptiveRisk(state, baseRisk) {
  if (state.start_balance <= 0) return [baseRisk, 'no start balance'];
  if (state.is_failed) return [0.0, '❌ Challenge FAILED: drawdown limit reached'];
  if (state.is_passed) return [0.0, '🏆 Challenge PASSED: target reached, stop trading'];
  if (state.dd_ratio < 0.15) return [0.0, `🛑 DD safety: запас ${fmtFixed(state.dd_remaining_pct, 1)}% < 15% лимита`];
  if (state.daily_ratio < 0.10) return [0.0, `🛑 Daily limit: осталось ${fmtFixed(state.daily_remaining_pct, 1)}% < 10%`];
  if (state.consistency && state.target_pct > 0) {
    const thr = state.target_pct * 0.30;
    if (state.daily_pnl_pct > thr) {
      return [0.0, `🛑 Consistency rule: дневная прибыль ${fmtFixed(state.daily_pnl_pct, 2)}% `
        + `превысила лимит ${fmtFixed(thr, 2)}% (30% от цели). `
        + 'Стоп до завтра.'];
    }
  }
  const ddCoeff = state.dd_ratio;
  const dailyCoeff = state.daily_ratio;
  let targetCoeff;
  let targetNote;
  if (state.target_remaining_pct < state.target_pct * 0.15) { targetCoeff = 0.5; targetNote = 'close to target'; }
  else if (state.target_remaining_pct < state.target_pct * 0.30) { targetCoeff = 0.75; targetNote = 'approaching target'; }
  else { targetCoeff = 1.0; targetNote = 'normal'; }
  let momentum = 1.0;
  if (state.pnl_pct > 0 && state.dd_ratio > 0.7) momentum = Math.min(1.15, 1.0 + state.pnl_pct / state.target_pct * 0.2);
  let coeff = Math.min(ddCoeff, dailyCoeff) * targetCoeff * momentum;
  coeff = Math.max(0.25, Math.min(1.2, coeff));
  let adjusted = pyRound(baseRisk * coeff, 2);
  adjusted = Math.max(0.1, adjusted);
  const reason = `⚖️ coeff=${fmtFixed(coeff, 2)} `
    + `(dd=${fmtFixed(ddCoeff, 2)} daily=${fmtFixed(dailyCoeff, 2)} `
    + `target=${fmtFixed(targetCoeff, 1)}[${targetNote}] `
    + `momentum=${fmtFixed(momentum, 2)})`;
  return [adjusted, reason];
}

function buildChallengeState(user, currentBalance) {
  let startBal = Number(pyOrNum(fget(user, 'prop_start_balance', 0), 0));
  if (startBal <= 0) startBal = currentBalance;
  const storedPeak = Number(pyOrNum(fget(user, 'prop_peak_balance', 0), 0));
  const peak = Math.max(storedPeak, startBal, currentBalance);
  let dayStart = Number(pyOrNum(fget(user, 'prop_day_start_balance', 0), 0));
  if (dayStart <= 0) dayStart = startBal;
  return new ChallengeState({
    capital: Number(pyOrNum(fget(user, 'prop_capital', 100000), 100000)),
    target_pct: Number(pyOrNum(fget(user, 'prop_target', 8.0), 8.0)),
    max_dd_pct: Number(pyOrNum(fget(user, 'prop_max_dd', 5.0), 5.0)),
    daily_limit_pct: Number(pyOrNum(fget(user, 'prop_daily_limit', 4.0), 4.0)),
    min_days: Math.trunc(Number(pyOrNum(fget(user, 'prop_min_days', 1), 1))),
    max_days: Math.trunc(Number(pyOrNum(fget(user, 'prop_max_days', 30), 30))),
    trailing_dd: Boolean(fget(user, 'prop_trailing_dd', false)),
    consistency: Boolean(fget(user, 'prop_consistency', false)),
    current_balance: currentBalance,
    start_balance: startBal,
    day_start_balance: dayStart,
    peak_balance: peak,
    start_date: Number(pyOrNum(fget(user, 'prop_start_date', 0), 0)),
    trading_days: Math.trunc(Number(pyOrNum(fget(user, 'prop_trading_days', 0), 0))),
  });
}

module.exports = { ChallengeState, adaptiveRisk, buildChallengeState };
