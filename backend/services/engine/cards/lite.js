/**
 * cards/lite — signal_format.format_signal_lite verbatim (signal-pipeline.md §8.4):
 * the compact card used when user.signal_format == "lite" (all three strategies).
 */

'use strict';

const { fp, fmtFixed } = require('../../../strategies/common/pyfmt');
const { escape, pyTruthy, repeat } = require('./html');
const { levelsStars } = require('./qualityScale');

/**
 * format_signal_lite(symbol, direction, quality, entry, sl, tp1, tp2, tp3, strategy, lang, quality_scale)
 * quality_scale 10 (or strategy LEVELS) → levels_stars; otherwise clamp(int(q), 0, 5).
 */
function formatSignalLite({ symbol, direction, quality, entry, sl, tp1, tp2 = null, tp3 = null, strategy = '', lang = 'ru', qualityScale = 5 }) {
  const directionUp = String(direction || '').toUpperCase();
  const arrow = directionUp === 'LONG' ? '📈' : '📉';
  const symClean = escape(symbol);

  // float(quality) with (TypeError, ValueError) → 0.0
  let q;
  if (typeof quality === 'number') q = quality;
  else if (typeof quality === 'boolean') q = quality ? 1 : 0;
  else if (quality === null || quality === undefined) q = 0.0;
  else { const s = String(quality).trim(); const n = Number(s); q = s === '' || Number.isNaN(n) ? 0.0 : n; }

  let q5;
  if (Math.trunc(Number(qualityScale || 5)) === 10 || String(strategy || '').toUpperCase() === 'LEVELS') {
    q5 = levelsStars(q);
  } else {
    q5 = Math.max(0, Math.min(Math.trunc(q), 5));
  }
  const stars = repeat('⭐', q5) + repeat('☆', 5 - q5);

  const e = Number(entry);
  const pctSigned = (price) => {
    if (!pyTruthy(price) || !pyTruthy(entry) || e === 0) return '';
    let delta = (Number(price) - e) / e * 100;
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
