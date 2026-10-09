'use strict';
/**
 * publicTrack/view.js — pure: one signal_trades row of a track account + its observed stage
 * history → the public state of that signal at view time V (= now − 60 min).
 *
 * The status and the R are the bot's (services/engine/signalOutcome.js signal_status /
 * signal_rr) on the TRACKER VIEW of the row: `result` cleared, the stage reached by V — the same
 * view the bot's card outcome line uses (signal_tracker.update_signal_card:
 * `signal_rr({**trade, "progress_stage": stage, "result": ""}, stage.lower())`). A manual result,
 * a ghost-cleanup SKIP or an exchange fill never changes the paper track; it is the tracker's
 * replay of the signal at the prices of its levels.
 *
 *   signalOutcome status   public status   path                         r
 *   open (stage '' / ENTRY) open           [open]                       null (in trade)
 *   tp1                     tp1            [open, tp1]                  null (in trade, stop at BE)
 *   tp2                     tp1            [open, tp1, tp2]             null (in trade, stop at BE)
 *   tp3                     tp3            [open, tp1, tp2, tp3]        R(TP3) − fee
 *   sl                      sl             [open, sl]                   −1 − fee
 *   be after TP1 / TP2      tp1be / tp2be  [open, tp1, (tp2,) be]       0 − fee
 *   expired                 exp            [open, (tp1, (tp2,)) exp]    expire_rr − fee | null
 *   missed                  missed         [open, missed]               null (never filled)
 *
 * R after fees is an estimate with the Genome backtester's fee model (config.FEES):
 * fee_r = clamp((0.12 + 0.10) / risk %, 0, 0.5), risk % = |entry − sl0| / entry × 100.
 * Nothing here returns a price level, a user id or a trade id.
 */

const crypto = require('crypto');
const { signalStatus, signalRr } = require('../engine/signalOutcome');
const { pyRound } = require('../../strategies/common/pyround');
const { pyUpper, pyStrip } = require('../../strategies/common/pyUnicode');
const { FEES } = require('./config');

const STRATS = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const STRATEGY_NAME = Object.freeze({ LEVELS: 'Уровни', SMC: 'SMC', VOLUME: 'Объём + MA' });
const FINAL_PUBLIC = Object.freeze(['tp1be', 'tp2be', 'tp3', 'sl', 'exp']);
const RUNNING_PUBLIC = Object.freeze(['open', 'tp1']);
const TF_DISPLAY = Object.freeze({ '1h': '1H', '2h': '2H', '4h': '4H', '6h': '6H', '12h': '12H', '1d': '1D', '1w': '1W' });

/** Python falsiness of a DB value (`x or 0`). */
const falsy = (v) => v === null || v === undefined || v === false || v === 0 || v === '';
/** float(x or 0) of a DB value; a non-number reads as 0. */
function num(v) {
  if (falsy(v)) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The tracker stage column as signal_status reads it: str(progress_stage or '').upper(). */
function stageOf(row) {
  const v = row ? row.progress_stage : '';
  return pyUpper(String(falsy(v) ? '' : v));
}

/** The engine time of the row's current stage: progress_ts (bar open / mark time), else created_at. */
function stageDbTime(row) {
  const p = num(row.progress_ts);
  return p > 0 ? p : num(row.created_at);
}

/** 'BTC-USDT-SWAP' → 'BTC' (letters and digits only: the landing writes the pair unescaped). */
function baseOf(symbol) {
  return String(symbol == null ? '' : symbol).split('-USDT-SWAP').join('').split('-USDT').join('').replace(/[^A-Za-z0-9]/g, '');
}

/** '1h' → '1H', '15m' → '15m', '4h' → '4H', '1d' → '1D' (the landing's labels). */
function tfOf(tf) {
  const s = String(falsy(tf) ? '1h' : tf).trim().replace(/[^A-Za-z0-9]/g, '');
  if (Object.prototype.hasOwnProperty.call(TF_DISPLAY, s)) return TF_DISPLAY[s];
  return s || '1H';
}

/** LONG / SHORT, or null for anything else (such a row is not published). */
function sideOf(direction) {
  const d = pyUpper(pyStrip(String(falsy(direction) ? '' : direction)));
  return d === 'LONG' || d === 'SHORT' ? d : null;
}

/** LEVELS / SMC / VOLUME, or null (legacy / unknown strategies are not part of the track). */
function strategyOf(strategy) {
  const s = pyUpper(pyStrip(String(falsy(strategy) ? '' : strategy)));
  return STRATS.includes(s) ? s : null;
}

/** fee_r of one signal (config.FEES): the backtester's applyFees without in-simulation slippage. */
function feeR(row) {
  const entry = num(row.entry);
  let sl0 = num(row.original_sl);
  if (sl0 === 0) sl0 = num(row.sl);
  const riskPct = entry > 0 && sl0 > 0 ? Math.abs(entry - sl0) / entry * 100 : 1.0;
  const f = riskPct > 0 ? (FEES.round_trip_pct + FEES.slippage_pct) / riskPct : 0.2;
  return Math.max(0, Math.min(FEES.max_r, f));
}

/** Opaque public id of a signal: HMAC of the trade id (which starts with the user id). */
function publicId(tradeId, secret) {
  return 's' + crypto.createHmac('sha256', String(secret)).update(`public-track:${tradeId}`).digest('base64url').slice(0, 12);
}

/**
 * The stage history as of V: the entries observed with t ≤ V (`stages` = [{s, t}], ascending).
 * Returns { stage, reached:Set } — `reached` also holds the stages the current one implies
 * (BE ⇒ TP1, TP2 ⇒ TP1, TP3 ⇒ TP1 + TP2).
 */
function stageAt(stages, v) {
  const reached = new Set();
  let stage = '';
  for (const e of stages || []) {
    if (e.t > v) break;
    stage = e.s;
    reached.add(e.s);
  }
  if (stage === 'TP2' || stage === 'TP3' || stage === 'BE') reached.add('TP1');
  if (stage === 'TP3') reached.add('TP2');
  return { stage, reached };
}

/**
 * Public state of `row` at V (unix seconds) given its observed stages → { status, path, r, raw }
 * (`raw` = the signalOutcome status, for the tests / logs).
 */
function publicState(row, stages, v) {
  const { stage, reached } = stageAt(stages, v);
  const view = {
    ...row, result: '', result_rr: null, skip_reason: '', progress_stage: stage,
    expire_rr: stage === 'EXPIRED' ? row.expire_rr : null,
  };
  const raw = signalStatus(view, v);
  const rr = signalRr(view, raw);
  const after = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : pyRound(Number(x) - feeR(row), 2));
  const tps = () => ['TP1', 'TP2'].filter((s) => reached.has(s)).map((s) => s.toLowerCase());
  switch (raw) {
    case 'tp1': return { status: 'tp1', path: ['open', 'tp1'], r: null, raw };
    case 'tp2': return { status: 'tp1', path: ['open', 'tp1', 'tp2'], r: null, raw };
    case 'tp3': return { status: 'tp3', path: ['open', 'tp1', 'tp2', 'tp3'], r: after(rr), raw };
    case 'sl': return { status: 'sl', path: ['open', 'sl'], r: after(rr), raw };
    case 'be':
      return reached.has('TP2')
        ? { status: 'tp2be', path: ['open', 'tp1', 'tp2', 'be'], r: after(rr), raw }
        : { status: 'tp1be', path: ['open', 'tp1', 'be'], r: after(rr), raw };
    case 'expired': return { status: 'exp', path: ['open', ...tps(), 'exp'], r: after(rr), raw };
    case 'missed': return { status: 'missed', path: ['open', 'missed'], r: null, raw };
    default: return { status: 'open', path: ['open'], r: null, raw };
  }
}

function isFinal(status) { return FINAL_PUBLIC.includes(status); }
function isRunning(status) { return RUNNING_PUBLIC.includes(status); }

module.exports = {
  STRATS, STRATEGY_NAME, FINAL_PUBLIC, RUNNING_PUBLIC,
  falsy, num, stageOf, stageDbTime, baseOf, tfOf, sideOf, strategyOf, feeR, publicId, stageAt, publicState,
  isFinal, isRunning,
};
