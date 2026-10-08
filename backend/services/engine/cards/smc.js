/**
 * cards/smc — smc/scanner._signal_text_smc, _rr_ladder, _rr_ladder_text and
 * _maybe_append_smc_sl_warning, verbatim (signal-pipeline.md §8.2).
 *
 * `sig` is an SMC signal object (smc.signal_builder.SMCSignalResult fields as
 * in tests/golden/expected/smc.json). Post-processing order in the bot:
 * watermark → SL warning → position line → confluence label prepended —
 * see `assemble()` for the exact sequence the scanner follows.
 */

'use strict';

const { fmtFixed, fmtG } = require('../../../strategies/common/pyfmt');
const { pyRound } = require('../../../strategies/common/pyround');
const { escape, makeT, repeat, cardFp: fp } = require('./html');

const MESSAGES = {
  smc_long_header: { ru: '🟢 <b>LONG — ПОКУПКА</b>', en: '🟢 <b>LONG — BUY</b>' },
  smc_short_header: { ru: '🔴 <b>SHORT — ПРОДАЖА</b>', en: '🔴 <b>SHORT — SELL</b>' },
  smc_tf_label: { ru: 'ТФ', en: 'TF' },
  smc_entry_zone: { ru: 'Зона входа', en: 'Entry zone' },
  smc_tp1_pct: { ru: '33% позиции', en: '33% position' },
  smc_tp2_pct: { ru: '50% позиции', en: '50% position' },
  smc_tp3_pct: { ru: '17% позиции', en: '17% position' },
  smc_confirmations: { ru: 'ПОДТВЕРЖДЕНИЯ ({score}/5):', en: 'CONFIRMATIONS ({score}/5):' },
  smc_entry_logic: { ru: 'ЛОГИКА ВХОДА:', en: 'ENTRY LOGIC:' },
  stop_loss: { ru: '🛑 Стоп', en: '🛑 Stop Loss' },
  target1: { ru: '🎯 Цель 1', en: '🎯 Target 1' },
  target2: { ru: '🎯 Цель 2', en: '🎯 Target 2' },
  target3: { ru: '🏆 Цель 3', en: '🏆 Target 3' },
  fundamental_header: { ru: 'Фундаментал рынка', en: 'Market fundamentals' },
  smc_sl_inline_warning: {
    ru: '\n⚠️ <b>SL {sl_pct}% > ваш лимит {max_pct}%</b>\nАвто-трейд пропустит этот сигнал.',
    en: '\n⚠️ <b>SL {sl_pct}% > your limit {max_pct}%</b>\nAuto-trade will skip this signal.',
  },
};

const t = makeT(MESSAGES);
const SEP = '━━━━━━━━━━━━━━━━━━━━';

/** signal_builder.GRADES — score → grade label; other scores → f"⚡ {score}/5". */
const GRADES = { 5: '🔥 A+', 4: '✅ A', 3: '⚡ B' };
function gradeFor(score) {
  return Object.prototype.hasOwnProperty.call(GRADES, score) ? GRADES[score] : `⚡ ${score}/5`;
}

const num0 = (v) => Number(v || 0);

/** _rr_ladder(sig): R to TP1/TP2/TP3 from entry and stop, rounded to 2 dp (zeros when risk ≤ 0). */
function rrLadder(sig) {
  try {
    const entry = num0(sig.entry);
    const risk = Math.abs(entry - num0(sig.sl));
    if (risk <= 0) return [0.0, 0.0, 0.0];
    return ['tp1', 'tp2', 'tp3'].map((k) => pyRound(Math.abs(num0(sig[k]) - entry) / risk, 2));
  } catch (_e) {
    return [0.0, 0.0, 0.0];
  }
}

/** _rr_ladder_text(sig): "1:{r1:g} / 1:{r2:g} / 1:{r3:g}" */
function rrLadderText(sig) {
  const [r1, r2, r3] = rrLadder(sig);
  return `1:${fmtG(r1, 6)} / 1:${fmtG(r2, 6)} / 1:${fmtG(r3, 6)}`;
}

function resolveCardLine(opts) {
  if (opts && typeof opts.cardLine === 'function') return opts.cardLine;
  if (opts && opts.trend && typeof opts.trend.cardLine === 'function') return opts.trend.cardLine.bind(opts.trend);
  return require('../trendMonitor').cardLine;
}

/** _signal_text_smc(sig, fund_block, lang) */
function signalTextSmc(sig, fundBlock = '', lang = 'ru', opts = {}) {
  const cardLine = resolveCardLine(opts);
  const NL = '\n';
  const isLong = sig.direction === 'LONG';
  const dirLine = isLong ? t('smc_long_header', lang) : t('smc_short_header', lang);
  const score = Math.trunc(Number(sig.score));
  const stars = repeat('⭐', score) + repeat('☆', 5 - score);

  let confirmationsBlock = '';
  for (const [label, passed] of (sig.confirmations || [])) {
    const mark = passed ? '✅' : '⬜';
    confirmationsBlock += mark + ' ' + label + NL;
  }

  const entry = Number(sig.entry);
  const pct = (price) => (entry > 0 ? Math.abs((Number(price) - entry) / entry * 100) : 0.0);

  const fundSection = fundBlock
    ? NL + SEP + NL + t('fundamental_header', lang) + NL + fundBlock + NL
    : '';

  const modeBadge = sig.mode_tag ? sig.mode_tag : '⚡ Aggressive';
  const symEsc = escape(sig.symbol);
  let trendLn = '';
  try { trendLn = cardLine(sig.direction, sig.tf_mtf, lang); } catch (_e) { trendLn = ''; }

  return (
    dirLine + '  ' + sig.grade + '  <i>[' + modeBadge + ']</i>' + NL
    + '<b>' + symEsc + '</b>  ' + stars + NL
    + (trendLn ? trendLn + NL : '') + NL
    + '📊 ' + t('smc_tf_label', lang) + ': ' + sig.tf_ltf + ' → ' + sig.tf_mtf + ' → ' + sig.tf_htf + NL
    + '💰 ' + t('smc_entry_zone', lang) + ': <code>' + fp(sig.entry_low) + ' – ' + fp(sig.entry_high) + '</code>' + NL
    + '🛑 ' + t('stop_loss', lang) + ': <code>' + fp(sig.sl) + '</code>  (-' + fmtFixed(sig.risk_pct, 2) + '%)' + NL + NL
    + '🎯 ' + t('target1', lang) + ': <code>' + fp(sig.tp1) + '</code>  (+' + fmtFixed(pct(sig.tp1), 2) + '%) — ' + t('smc_tp1_pct', lang) + NL
    + '🎯 ' + t('target2', lang) + ': <code>' + fp(sig.tp2) + '</code>  (+' + fmtFixed(pct(sig.tp2), 2) + '%) — ' + t('smc_tp2_pct', lang) + NL
    + '🏆 ' + t('target3', lang) + ': <code>' + fp(sig.tp3) + '</code>  (+' + fmtFixed(pct(sig.tp3), 2) + '%) — ' + t('smc_tp3_pct', lang) + NL
    + '📐 R:R: ' + rrLadderText(sig) + NL + NL
    + '📋 ' + t('smc_confirmations', lang, { score: sig.score }) + NL
    + confirmationsBlock + NL
    + '🧠 ' + t('smc_entry_logic', lang) + '\n'
    + sig.narrative
    + fundSection + NL
    + '⚡ <i>CHM Laboratory — SMC Strategy</i>'
  );
}

/**
 * _maybe_append_smc_sl_warning(text, sig, user, lang): the inline SL-too-wide
 * warning when sig.risk_pct > user.smc_max_sl_pct (> 0). Any error → text unchanged.
 */
function maybeAppendSmcSlWarning(text, sig, user, lang = 'ru') {
  try {
    const hasAttr = user && Object.prototype.hasOwnProperty.call(user, 'smc_max_sl_pct');
    const raw = hasAttr ? user.smc_max_sl_pct : 5.0;
    const userMaxSl = Number(raw || 0);
    const sigSlPct = Number((sig && sig.risk_pct) || 0);
    if (Number.isNaN(userMaxSl) || Number.isNaN(sigSlPct)) return text;
    if (userMaxSl > 0 && sigSlPct > userMaxSl) {
      return text + t('smc_sl_inline_warning', lang || 'ru', { sl_pct: fmtFixed(sigSlPct, 1), max_pct: fmtFixed(userMaxSl, 1) });
    }
  } catch (_e) { /* keep signal-send path alive */ }
  return text;
}

/**
 * The SMC scanner's post-processing sequence after the raw card (full or lite):
 *   wm_inject → SL warning → "\n" + position line (if any) → confluence label prepended.
 * `rawText` is the card HTML, `parts` = { userId, positionLine, confluenceLabel }.
 */
function assemble(rawText, sig, user, lang, { userId, positionLine = '', confluenceLabel = '' } = {}) {
  const { wmInject } = require('../watermark');
  let text = wmInject(rawText, userId === undefined ? user.user_id : userId);
  text = maybeAppendSmcSlWarning(text, sig, user, lang);
  if (positionLine) text += '\n' + positionLine;
  if (confluenceLabel) text = `${confluenceLabel}\n${text}`;
  return text;
}

module.exports = { MESSAGES, SEP, GRADES, gradeFor, rrLadder, rrLadderText, signalTextSmc, maybeAppendSmcSlWarning, assemble, t };
