/**
 * cards/volume — volume_scanner.signal_text(sig, lang), setup_title and the
 * VOLUME `_fp`, verbatim (signal-pipeline.md §8.3).
 *
 * `sig` is a VOLUME signal object (volume_strategy.VolumeSignal fields as in
 * tests/golden/expected/volume.json). Note `ru = lang == "ru"`: any language
 * other than "ru" renders the English branch (unlike the i18n fallback of
 * the LEVELS/SMC cards).
 */

'use strict';

const { fpVolume, fmtFixed } = require('../../../strategies/common/pyfmt');
const { escape, pyTruthy, repeat } = require('./html');

const SETUP_NAMES = {
  cross: ['✂️', 'Пересечение', 'Cross'],
  turn: ['🔄', 'Разворот', 'Turn of'],
  bounce: ['↩️', 'Отскок от', 'Bounce off'],
  ribbon: ['🔁', 'Откат к ленте', 'Pullback to ribbon'],   // [VOLUME-RIBBON]
};

/** volume_scanner._fp — any exception → str(v). */
function fp(v) {
  try {
    const n = Number(v);
    if (typeof v === 'string' && v.trim() === '') return String(v);
    if (Number.isNaN(n)) return String(v);
    return fpVolume(n);
  } catch (_e) {
    return String(v);
  }
}

/** setup_title(sig, lang): «↩️ Отскок от EMA200» */
function setupTitle(sig, lang = 'ru') {
  const ru = lang === 'ru';
  if (sig.setup === 'golden') {
    if (sig.direction === 'LONG') return '🌟 ' + (ru ? 'Золотой крест ' : 'Golden Cross ') + sig.ma_label;
    return '💀 ' + (ru ? 'Крест смерти ' : 'Death Cross ') + sig.ma_label;
  }
  if (Object.prototype.hasOwnProperty.call(SETUP_NAMES, sig.setup) && sig.ma_label) {
    const [ico, r, e] = SETUP_NAMES[sig.setup];
    return `${ico} ${ru ? r : e} ${sig.ma_label}`;
  }
  return sig.signal_type;
}

function resolveCardLine(opts) {
  if (opts && typeof opts.cardLine === 'function') return opts.cardLine;
  if (opts && opts.trend && typeof opts.trend.cardLine === 'function') return opts.trend.cardLine.bind(opts.trend);
  return require('../trendMonitor').cardLine;
}

/** signal_text(sig, lang) — the VOLUME card (MA setup + volume). */
function signalText(sig, lang = 'ru', opts = {}) {
  const cardLine = resolveCardLine(opts);
  const ru = lang === 'ru';
  const NL = '\n';
  const sym = escape(String(sig.symbol).replace(/-USDT-SWAP/g, '').replace(/-USDT/g, ''));
  const head = sig.direction === 'LONG' ? '🟢 <b>LONG</b>' : '🔴 <b>SHORT</b>';
  const q = Math.max(0, Math.min(5, Math.trunc(Number(sig.quality))));
  const stars = repeat('⭐', q) + repeat('☆', 5 - q);
  const entry = Number(sig.entry);
  const slPct = pyTruthy(sig.entry) ? Math.abs(Number(sig.sl) - entry) / entry * 100 : 0.0;

  const pct = (tp) => (pyTruthy(sig.entry) ? `${fmtFixed(Math.abs(Number(tp) - entry) / entry * 100, 2)}%` : '?');

  const title = ru ? '📈 Торговля по объёму и MA' : '📈 Volume & MA Trading';
  const setup = escape(setupTitle(sig, lang));
  const lines = [
    `${title} · ${head}`,
    `<b>${sym}/USDT</b>  ·  ${sig.timeframe}  ·  ${stars}`,
    '',
    (ru ? `🎯 Сетап: <b>${setup}</b>` : `🎯 Setup: <b>${setup}</b>`)
      + (pyTruthy(sig.ma_value) ? `  ·  <code>${fp(sig.ma_value)}</code>` : ''),
  ];
  let trendLn = '';
  try { trendLn = cardLine(sig.direction, sig.timeframe, lang); } catch (_e) { trendLn = ''; }   // [TREND-MONITOR]
  if (trendLn) lines.push(trendLn);
  if (pyTruthy(sig.squeeze)) {
    const strong = Math.trunc(Number(sig.squeeze)) >= 2;
    lines.push(ru
      ? '💥 Выход из сжатия волатильности' + (strong ? ' (сильное)' : '') + ' — +1 к качеству'
      : '💥 Breakout from volatility squeeze' + (strong ? ' (strong)' : '') + ' — +1 quality');
  }
  if (sig.alignment) {
    lines.push((ru ? '📐 MA выстроены: ' : '📐 MA aligned: ') + escape(sig.alignment) + ' ✅');
  } else if (sig.setup) {
    lines.push(ru ? '📐 MA не выстроены полностью' : '📐 MAs not fully aligned');
  }
  lines.push(`📦 ${ru ? 'Объём' : 'Volume'} ×${fmtFixed(sig.vol_ratio, 1)}  ·  RSI ${fmtFixed(sig.rsi, 0)}`);
  if (sig.htf_tf && pyTruthy(sig.htf_state)) {
    const strong = Math.abs(Math.trunc(Number(sig.htf_state))) === 2;
    lines.push(
      (ru ? `🕐 Старший ТФ ${sig.htf_tf}: ` : `🕐 HTF ${sig.htf_tf}: `)
      + (ru ? (strong ? 'по тренду ✅' : 'цена за EMA50 ☑️') : (strong ? 'with trend ✅' : 'price beyond EMA50 ☑️')),
    );
  }
  if (Array.isArray(sig.reasons) && sig.reasons.length && ru) {
    lines.push('💡 <i>' + escape(sig.reasons.slice(0, 4).map((r) => String(r)).join('; ')) + '</i>');
  }
  lines.push(
    '',
    (ru ? 'Вход' : 'Entry') + `: <code>${fp(sig.entry)}</code>`,
    'SL: ' + `<code>${fp(sig.sl)}</code>  <i>(-${fmtFixed(slPct, 2)}%)</i>`,
    `🎯 TP1: <code>${fp(sig.tp1)}</code>  <i>(+${pct(sig.tp1)})</i>`,
    `🎯 TP2: <code>${fp(sig.tp2)}</code>  <i>(+${pct(sig.tp2)})</i>`,
    `🎯 TP3: <code>${fp(sig.tp3)}</code>  <i>(+${pct(sig.tp3)})</i>`,
    '',
    `${sig.ma_names || 'MA'}: ${fp(sig.ema_fast)} / ${fp(sig.ema_slow)} / ${fp(sig.ma_slow)}`,
    `${sig.ema_names || 'EMA'}: ${fp(sig.ema_mid)} / ${fp(sig.ema_trend)}`,
    '',
    '#VOLUME',
  );
  return lines.join(NL);
}

module.exports = { SETUP_NAMES, fp, setupTitle, signalText };
