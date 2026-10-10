'use strict';
/**
 * signalOutcome.js — the bot's `db/signal_outcome.py` verbatim (signal-pipeline.md §12.1–12.3):
 * one source of truth for "what did this signal_trades row come to" — for the feed,
 * the stats and the reports. A row with `order_id` is an exchange trade (result /
 * result_rr are real); without it the outcome comes from the tracker stage
 * (`progress_stage`). A `SKIP` written by ghost cleanup on a row with a delivered card
 * (`signal_msg_id > 0`) is NOT an outcome (the bot's 2026-10-07 prod incident).
 * [STATS-HONEST 2026-10] has_real_result / is_exchange_result / is_final (bot :114–138).
 */

const { pyFloat, pyInt } = require('./pycoerce');
const { pyRound, pyMax } = require('../../strategies/common/pyround');
const { pyLower, pyStrip, pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const WIN_STAGES = Object.freeze(['TP1', 'TP2', 'TP3']);
const FINAL = Object.freeze(['TP1', 'TP2', 'TP3', 'SL', 'BE']);

function envHours(name, dflt, env = process.env) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return pyMax(1.0, dflt);
  try { return pyMax(1.0, pyFloat(raw)); } catch (_e) { return dflt; }
}

/** The tracker window: that long a signal counts as "in progress", afterwards "no outcome". */
const MAX_AGE_S = envHours('SIGNAL_TRACKER_MAX_AGE_H', 72.0) * 3600.0;

/** _g(row, key, default): missing / None → default. */
function _g(row, key, dflt = null) {
  if (row === null || row === undefined || typeof row !== 'object') return dflt;
  const v = row[key];
  return v === null || v === undefined ? dflt : v;
}

function pyFalsy(v) {
  return v === null || v === undefined || v === false || v === 0 || v === '';
}

function hasCard(row) {
  try {
    const v = _g(row, 'signal_msg_id', 0);
    return pyInt(pyFalsy(v) ? 0 : v) > 0;
  } catch (_e) {
    return false;
  }
}

function isExchangeTrade(row) {
  const v = _g(row, 'order_id', '');
  return Boolean(pyStrip(String(pyFalsy(v) ? '' : v)));
}

/**
 * signal_status(row, now) → 'tp1'|'tp2'|'tp3'|'sl'|'be'|'closed'|'open'|'expired'|'missed'|'skip'
 * — the 10 rules of §12.1 in this exact order.
 */
function signalStatus(row, now = null) {
  const resRaw = _g(row, 'result', '');
  const res = pyUpper(String(pyFalsy(resRaw) ? '' : resRaw));
  const stageRaw = _g(row, 'progress_stage', '');
  const stage = pyUpper(String(pyFalsy(stageRaw) ? '' : stageRaw));
  if (FINAL.includes(res)) return pyLower(res);                                      // 1
  if (res === 'MANUAL' || res === 'TRAIL') return 'closed';                                // 2
  const skipReason = _g(row, 'skip_reason', '');
  if (res === 'SKIP' && String(pyFalsy(skipReason) ? '' : skipReason) === 'manual') return 'skip'; // 3
  if (FINAL.includes(stage)) return pyLower(stage);                                   // 4
  if (stage === 'EXPIRED') return 'expired';                                               // 5
  if (stage === 'MISSED') return 'missed';                                                 // 6
  if (res === 'ORPHAN') return 'skip';                                                     // 7
  if (res === 'SKIP' && !hasCard(row) && !isExchangeTrade(row)) return 'skip';             // 8 ghost
  if (res && res !== 'SKIP') return 'closed';                                              // 9
  const t = now === null || now === undefined ? Date.now() / 1000 : now;                   // 10
  let age;
  try {
    const c = _g(row, 'created_at', 0);
    age = t - pyFloat(pyFalsy(c) ? 0 : c);
  } catch (_e) {
    age = 0.0;
  }
  return age > MAX_AGE_S ? 'expired' : 'open';
}

/**
 * signal_rr(row, status) → number | null: the real result_rr, else by status
 * (TPn → planned R to TPn from the ORIGINAL stop, SL → −1, BE → 0, expired → expire_rr).
 */
function signalRr(row, status) {
  const resRaw = _g(row, 'result', '');
  const res = pyUpper(String(pyFalsy(resRaw) ? '' : resRaw));
  const rrRaw = _g(row, 'result_rr', null);
  if (res && res !== 'SKIP' && res !== 'ORPHAN' && rrRaw !== null && rrRaw !== '') {
    try { return pyFloat(rrRaw); } catch (_e) { /* fall through like the bot */ }
  }
  if (status === 'sl') return -1.0;
  if (status === 'be') return 0.0;
  if (status === 'missed') return null;
  if (status === 'expired') {
    const v = _g(row, 'expire_rr', null);
    try { return v !== null && v !== '' ? pyRound(pyFloat(v), 2) : null; } catch (_e) { return null; }
  }
  if (status === 'tp1' || status === 'tp2' || status === 'tp3') {
    let entry; let sl0; let tp;
    try {
      const e = _g(row, 'entry', 0); entry = pyFloat(pyFalsy(e) ? 0 : e);
      const o = _g(row, 'original_sl', 0); const s = _g(row, 'sl', 0);
      sl0 = pyFloat(pyFalsy(o) ? 0 : o);
      if (sl0 === 0) sl0 = pyFloat(pyFalsy(s) ? 0 : s);                 // Python `or`: NaN is truthy
      const t = _g(row, status, 0); tp = pyFloat(pyFalsy(t) ? 0 : t);
    } catch (_e) {
      return null;
    }
    const risk = Math.abs(entry - sl0);
    return risk > 0 && tp > 0 ? pyRound(Math.abs(tp - entry) / risk, 2) : null;
  }
  return null;
}

/**
 * [STATS-HONEST 2026-10] has_real_result(row): `result` holds an outcome (an exchange close —
 * scanner_mid._trade_result_from_exit / reconcile — or the manual «📋 Результат»); `result` is
 * written only on close, so such an outcome is final. SKIP / ORPHAN are not outcomes.
 */
function hasRealResult(row) {
  const v = _g(row, 'result', '');
  const res = pyUpper(String(pyFalsy(v) ? '' : v));
  return Boolean(res) && res !== 'SKIP' && res !== 'ORPHAN';
}

/**
 * [STATS-HONEST 2026-10] is_exchange_result(row): the row's R is a real exchange result —
 * order_id, a written result and result_rr. That R is measured from the real exit fill
 * ((exit − entry)/|entry − original_sl|): exit slippage is inside, fees are not.
 */
function isExchangeResult(row) {
  if (!isExchangeTrade(row) || !hasRealResult(row)) return false;
  const rr = _g(row, 'result_rr', null);
  return rr !== null && rr !== '';                  // `not in (None, "")`
}

/**
 * [STATS-HONEST 2026-10] is_final(row, status): the outcome is final — TP3 / SL / BE / EXPIRED /
 * MISSED by the tracker or a written result (exchange / manual). Tracker stages TP1 / TP2 without
 * a result are a running trade (stop at entry), not final.
 */
function isFinal(row, status) {
  if (hasRealResult(row)) return true;
  return status !== 'open' && status !== 'tp1' && status !== 'tp2';
}

/**
 * Rows that count as the user's signals / trades at all: ORPHAN (exchange rejected)
 * and SKIP without a card and without an order are garbage.
 */
const COUNTABLE_SQL = "COALESCE(result, '') != 'ORPHAN' "
  + "AND NOT (COALESCE(result, '') = 'SKIP' "
  + '         AND COALESCE(signal_msg_id, 0) = 0 '
  + "         AND COALESCE(order_id, '') = '')";

/** COUNTABLE_SQL with the columns prefixed (`t.result`, …) for JOIN queries. */
function countableSql(prefix = '') {
  if (!prefix) return COUNTABLE_SQL;
  return COUNTABLE_SQL.replace(/result/g, `${prefix}result`)
    .replace(/signal_msg_id/g, `${prefix}signal_msg_id`)
    .replace(/order_id/g, `${prefix}order_id`);
}

module.exports = {
  WIN_STAGES, FINAL, MAX_AGE_S, COUNTABLE_SQL, countableSql, envHours,
  _g, hasCard, isExchangeTrade, signalStatus, signalRr,
  hasRealResult, isExchangeResult, isFinal,
};
