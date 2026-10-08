'use strict';
/**
 * highWr.js — the [AUDIT-FIX] High-WR Mode filters of indicator._do_analyze (spec §16),
 * applied after the checklist when IndConfig.HIGH_WR_MODE is on, in this order:
 *   1. counter-trend → None            2. levels_stars(quality) < 4 (quality < 6) → None
 *   3. UTC hour of df.index[-1] < 8 or ≥ 22 → None (hour errors are swallowed: no reject)
 *   4. ladder: tp1 = entry ± 1.5 R, tp2 = max/min(tp2, entry ± 2.5 R), tp3 = max/min(tp3, entry ± 4.0 R)
 *   5. LONG in a bear local trend / SHORT in a bull local trend → None
 * Every rejection is the "quality_hwr" bucket. Pure.
 */

const { REJECT } = require('./config');
const { levelsStars } = require('./stars');
const { pyMax, pyMin } = require('../common/pyround');

/** The HIGH_WR ladder (step 4) alone: Python max/min (first operand wins on ties). Returns { tp1, tp2, tp3 }. */
function highWrLadder(signal, entry, risk, tp2, tp3) {
  if (signal === 'LONG') {
    return { tp1: entry + risk * 1.5, tp2: pyMax(tp2, entry + risk * 2.5), tp3: pyMax(tp3, entry + risk * 4.0) };
  }
  return { tp1: entry - risk * 1.5, tp2: pyMin(tp2, entry - risk * 2.5), tp3: pyMin(tp3, entry - risk * 4.0) };
}

/**
 * applyHighWr({ signal, isCounter, quality, df, entry, risk, tp1, tp2, tp3, bullLocal, bearLocal })
 * → { reject: "quality_hwr" | null, reason, tp1, tp2, tp3 }.
 */
function applyHighWr({ signal, isCounter, quality, df, entry, risk, tp1, tp2, tp3, bullLocal, bearLocal }) {
  const bad = (reason) => ({ reject: REJECT.QUALITY_HWR, reason, tp1, tp2, tp3 });
  // 1. Запрет контр-тренда
  if (isCounter) return bad('hwr_counter_trend');
  // 2. min_quality >= 4⭐
  if (levelsStars(quality) < 4) return bad('hwr_stars');
  // 3. Сессионный фильтр 08-22 UTC
  let hour = null;
  try {
    hour = df.utcHour ? df.utcHour(-1) : new Date(df.t[df.length - 1]).getUTCHours();
  } catch (_e) {
    hour = null;
  }
  if (hour !== null && !Number.isNaN(hour) && (hour < 8 || hour >= 22)) return bad('hwr_hour');
  // 4. TP1 = 1.5R, TP2/TP3 не ближе 2.5R / 4R (лестница остаётся валидной)
  const ladder = highWrLadder(signal, entry, risk, tp2, tp3);
  // 5. trend_only (бычий → только LONG, медвежий → только SHORT)
  if (signal === 'LONG' && bearLocal) return { reject: REJECT.QUALITY_HWR, reason: 'hwr_long_in_bear', ...ladder };
  if (signal === 'SHORT' && bullLocal) return { reject: REJECT.QUALITY_HWR, reason: 'hwr_short_in_bull', ...ladder };
  return { reject: null, ...ladder };
}

module.exports = { highWrLadder, applyHighWr };
