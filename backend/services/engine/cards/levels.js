/**
 * cards/levels — scanner_mid.signal_text(sig, cfg, lang) and _corr_label,
 * verbatim (signal-pipeline.md §8.1). The HTML of the LEVELS full card.
 *
 * `sig` is a LEVELS signal object (indicator.SignalResult fields as in
 * tests/golden/expected/levels.json, plus the scanner-side `_sq_boosted`,
 * `mtf_aligned`, `trend_ctx` flags); `cfg` only needs `timeframe`.
 * The BTC trend line comes from `opts.cardLine(direction, tf, lang)`
 * (default: the live trendMonitor) — the bot reads trend_monitor's state.
 */

'use strict';

const { fmtFixed, fmtSigned } = require('../../../strategies/common/pyfmt');
const { escape, makeT, pyStr, cardFp: fp } = require('./html');
const { levelsStars, starsStr } = require('./qualityScale');

const MESSAGES = {
  levels_long_header: { ru: '🟢 <b>LONG СИГНАЛ</b>', en: '🟢 <b>LONG SIGNAL</b>' },
  levels_short_header: { ru: '🔴 <b>SHORT СИГНАЛ</b>', en: '🔴 <b>SHORT SIGNAL</b>' },
  counter_trend_header: { ru: '🔶 <b>━━━ ⚠️ КОНТР-ТРЕНД ━━━</b> 🔶', en: '🔶 <b>━━━ ⚠️ COUNTER-TREND ━━━</b> 🔶' },
  counter_trend_warn: {
    ru: '<i>Сделка идёт ПРОТИВ основного тренда — повышенный риск!</i>',
    en: '<i>Trade goes AGAINST the main trend — increased risk!</i>',
  },
  quality_factors: { ru: '📋 <b>Факторы качества:</b>', en: '📋 <b>Quality factors:</b>' },
  analysis_label: { ru: '🧠 <b>Анализ:</b>', en: '🧠 <b>Analysis:</b>' },
  target1: { ru: '🎯 Цель 1', en: '🎯 Target 1' },
  target2: { ru: '🎯 Цель 2', en: '🎯 Target 2' },
  target3: { ru: '🏆 Цель 3', en: '🏆 Target 3' },
  levels_footer: { ru: '⚡ <i>CHM Laboratory — CHM BREAKER</i>', en: '⚡ <i>CHM Laboratory — CHM BREAKER</i>' },
  fundamental_header: { ru: 'Фундаментал рынка', en: 'Market fundamentals' },
  entry: { ru: '💰 Вход', en: '💰 Entry' },
  stop_loss: { ru: '🛑 Стоп', en: '🛑 Stop Loss' },
  record_result: {
    ru: '👇 <i>Отметь результат когда сделка закроется:</i>',
    en: '👇 <i>Mark result when the trade closes:</i>',
  },
  quality_label: { ru: '⭐ Качество', en: '⭐ Quality' },
};

const t = makeT(MESSAGES);
const SEP = '━━━━━━━━━━━━━━━━━━━━';
const SQUEEZE_LINE = {
  ru: '💥 Пробой из сжатия волатильности — +1 к качеству',
  en: '💥 Breakout from volatility squeeze — +1 quality',
};

/** scanner_mid._corr_label(btc_corr, eth_corr) — Russian in both languages. */
function corrLabel(btcCorr, ethCorr) {
  const HIGH = 0.65;
  const b = Number(btcCorr);
  const e = Number(ethCorr);
  const followsBtc = b >= HIGH;
  const followsEth = e >= HIGH;
  if (followsBtc && followsEth) return `📡 Следует за BTC (${fmtSigned(b, 2)}) и ETH (${fmtSigned(e, 2)})`;
  if (followsBtc) return `📡 Следует за BTC (${fmtSigned(b, 2)})`;
  if (followsEth) return `📡 Следует за ETH (${fmtSigned(e, 2)})`;
  if (b < 0.3 && e < 0.3) return `🔮 Движется самостоятельно (BTC ${fmtSigned(b, 2)} / ETH ${fmtSigned(e, 2)})`;
  return `📊 Слабая связь с рынком (BTC ${fmtSigned(b, 2)} / ETH ${fmtSigned(e, 2)})`;
}

function resolveCardLine(opts) {
  if (opts && typeof opts.cardLine === 'function') return opts.cardLine;
  if (opts && opts.trend && typeof opts.trend.cardLine === 'function') return opts.trend.cardLine.bind(opts.trend);
  return require('../trendMonitor').cardLine;
}

/** signal_text(sig, cfg, lang) */
function signalText(sig, cfg, lang = 'ru', opts = {}) {
  const cardLine = resolveCardLine(opts);
  const q5 = levelsStars(sig.quality);          // [QUALITY-SCALE] 0..10 → 1..5
  const stars = starsStr(q5);
  const header = sig.direction === 'LONG' ? t('levels_long_header', lang) : t('levels_short_header', lang);
  const emoji = sig.direction === 'LONG' ? '📈' : '📉';

  let counterTrendWarn = sig.is_counter_trend
    ? '\n' + t('counter_trend_header', lang) + '\n' + t('counter_trend_warn', lang)
    : '';
  // [TREND-MONITOR] тренд BTC 15m (+ ТФ сигнала): по тренду / ПРОТИВ ТРЕНДА
  let marketTrend = '';
  try {
    const tf = cfg && Object.prototype.hasOwnProperty.call(cfg, 'timeframe') ? cfg.timeframe : '15m';
    marketTrend = cardLine(sig.direction, tf, lang);
  } catch (_e) { marketTrend = ''; }
  if (marketTrend) counterTrendWarn += '\n' + marketTrend;
  if (sig._sq_boosted) {   // [SQUEEZE] пробой из сжатия — показываем, за что +1
    counterTrendWarn += '\n' + (lang !== 'en' ? SQUEEZE_LINE.ru : SQUEEZE_LINE.en);
  }

  const entry = Number(sig.entry);
  const pct = (price) => Math.abs((Number(price) - entry) / entry * 100);

  const NL = '\n';
  const reasons = Array.isArray(sig.reasons) ? sig.reasons : [];
  const qualityFactors = reasons.length ? t('quality_factors', lang) + NL + reasons.join(NL) : '';

  return (
    header + NL + NL
    + '💎 <b>' + escape(sig.symbol) + '</b>  ' + emoji + '  <b>' + escape(sig.breakout_type) + '</b>'
    + counterTrendWarn + NL
    + t('quality_label', lang) + ': ' + stars + ` (${q5}/5 · ${pyStr(sig.quality)}/10)` + NL
    + qualityFactors + NL + NL
    + t('analysis_label', lang) + ' <i>' + escape(sig.human_explanation) + '</i>' + NL
    + SEP + NL
    + t('entry', lang) + ':    <code>' + fp(sig.entry) + '</code>' + NL
    + t('stop_loss', lang) + ':    <code>' + fp(sig.sl) + '</code>  '
    + '<i>(движение -' + fmtFixed(sig.risk_pct, 2) + '%)</i>' + NL + NL
    + t('target1', lang) + ': <code>' + fp(sig.tp1) + '</code>  <i>(+' + fmtFixed(pct(sig.tp1), 2) + '%)</i>' + NL
    + t('target2', lang) + ': <code>' + fp(sig.tp2) + '</code>  <i>(+' + fmtFixed(pct(sig.tp2), 2) + '%)</i>' + NL
    + t('target3', lang) + ': <code>' + fp(sig.tp3) + '</code>  <i>(+' + fmtFixed(pct(sig.tp3), 2) + '%)</i>' + NL
    + SEP + NL + NL
    + '📊 ' + escape(sig.trend_local) + '  |  RSI: <code>' + fmtFixed(sig.rsi, 1) + '</code>  |  Vol: <code>x' + fmtFixed(sig.volume_ratio, 1) + '</code>' + NL
    + corrLabel(sig.btc_corr, sig.eth_corr) + NL + NL
    + t('levels_footer', lang) + NL + NL
    + t('record_result', lang)
  );
}

/**
 * The fundamental block appended after the position line (scanner_mid._send):
 * "\n━━━…\n" + fundamental_header + "\n" + fund_block + "\n".
 */
function fundBlockSection(fundBlock, lang = 'ru') {
  if (!fundBlock) return '';
  return '\n' + SEP + '\n' + t('fundamental_header', lang) + '\n' + fundBlock + '\n';
}

module.exports = { MESSAGES, SEP, corrLabel, signalText, fundBlockSection, t };
