/**
 * cards/lite — signal_format.format_signal_lite verbatim (signal-pipeline.md §8.4):
 * the compact card used when user.signal_format == "lite" (all three strategies).
 */

'use strict';

const { fmtFixed } = require('../../../strategies/common/pyfmt');
const { pyMax, pyMin } = require('../../../strategies/common/pyround');
const { pyFloat, pyInt } = require('../pycoerce');
const { escape, pyTruthy, repeat, cardFp: fp } = require('./html');
const { levelsStars } = require('./qualityScale');
const { pyUpper } = require('../../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

/**
 * format_signal_lite(symbol, direction, quality, entry, sl, tp1, tp2, tp3, strategy, lang, quality_scale)
 * quality_scale 10 (or strategy LEVELS) → levels_stars; otherwise clamp(int(q), 0, 5).
 */
function formatSignalLite({ symbol, direction, quality, entry, sl, tp1, tp2 = null, tp3 = null, strategy = '', lang = 'ru', qualityScale = 5 }) {
  const directionUp = pyUpper(String(direction || ''));
  const arrow = directionUp === 'LONG' ? '📈' : '📉';
  const symClean = escape(symbol);

  // float(quality) with (TypeError, ValueError) → 0.0
  let q;
  try { q = pyFloat(quality); } catch (_e) { q = 0.0; }

  let q5;
  if (pyInt(pyTruthy(qualityScale) ? qualityScale : 5) === 10 || pyUpper(String(strategy || '')) === 'LEVELS') {
    q5 = levelsStars(q);                      // [QUALITY-SCALE] 0..10 → 1..5
  } else {
    q5 = pyMax(0, pyMin(pyInt(q), 5));        // int(nan) raises like the bot
  }
  const stars = repeat('⭐', q5) + repeat('☆', 5 - q5);

  const e = Number(entry);
  const pctSigned = (price) => {
    if (!pyTruthy(price) || !pyTruthy(entry) || e === 0) return '';
    let delta = (Number(price) - e) / e * 100;   // SHORT: -0.0 stays "+-0.00%" like the bot
    if (directionUp === 'SHORT') delta = -delta;
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${fmtFixed(delta, 2)}%`;
  };

  const headerLabel = directionUp === 'LONG' ? 'ЛОНГ' : 'ШОРТ';
  const qLabel = lang === 'en' ? 'Quality' : 'Качество';

  const out = [];
  out.push(`${arrow} <b>${symClean}</b> ${headerLabel}`);
  out.push(`${qLabel}: ${stars} (${q5}/5)`);
  out.push('');
  out.push(`🎯 Entry: <code>${fp(entry)}</code>`);
  out.push(`🛑 SL: <code>${fp(sl)}</code>  <i>(${pctSigned(sl)})</i>`);
  if (pyTruthy(tp1)) out.push(`✅ TP1: <code>${fp(tp1)}</code>  <i>(${pctSigned(tp1)})</i>`);
  if (pyTruthy(tp2)) out.push(`✅ TP2: <code>${fp(tp2)}</code>  <i>(${pctSigned(tp2)})</i>`);
  if (pyTruthy(tp3)) out.push(`✅ TP3: <code>${fp(tp3)}</code>  <i>(${pctSigned(tp3)})</i>`);
  if (strategy) {
    out.push('');
    out.push(`<i>Strategy: ${escape(strategy)}</i>`);
  }
  return out.join('\n');
}

/** is_lite_format(user) */
function isLiteFormat(user) {
  const v = user && Object.prototype.hasOwnProperty.call(user, 'signal_format') ? user.signal_format : 'full';
  return v === 'lite';
}

module.exports = { formatSignalLite, isLiteFormat };
