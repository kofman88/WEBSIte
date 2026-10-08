/**
 * cards/keyboards — the inline keyboards under the signal cards
 * (scanner_mid.signal_compact_keyboard / trade_records_keyboard,
 * smc/scanner._smc_keyboard, trend_monitor._keyboard, chart_sender) as
 * action descriptors.
 *
 * A keyboard is an array of rows; a row is an array of
 *   { id, label, action, kind }
 * where `action` is the bot's verbatim callback_data (kind "callback") or the
 * URL (kind "url"), `label` the button text, `id` the stable button name the
 * web UI / Telegram mirror dispatch on. Row and button order are the bot's.
 */

'use strict';

const { makeT } = require('./html');

const MESSAGES = {
  signal_chart_btn: { ru: '📈 График', en: '📈 Chart' },
  signal_stats_btn: { ru: '📊 Статистика', en: '📊 Statistics' },
  signal_record_btn: { ru: '📋 Записать результат ▾', en: '📋 Record result ▾' },
  signal_open_trade_btn: { ru: '✅ Открыть сделку на Bybit', en: '✅ Open trade on Bybit' },
  signal_counter_trend_help_btn: { ru: '❓ Что такое контр-тренд?', en: '❓ What is counter-trend?' },
  trend_notify_off_btn: { ru: '🔕 Не присылать смену тренда', en: '🔕 Stop trend alerts' },
  chart_help_btn: { ru: '🖼 Что значат символы?', en: '🖼 What do symbols mean?' },
};

const t = makeT(MESSAGES);

const cb = (id, label, action) => ({ id, label, action, kind: 'callback' });
const url = (id, label, action) => ({ id, label, action, kind: 'url' });

/** scanner_mid._tv_url: BTC-USDT-SWAP → https://www.tradingview.com/chart/?symbol=OKX:BTCUSDT.P */
function tvUrl(symbol) {
  const clean = String(symbol).replace(/-SWAP/g, '').replace(/-/g, '');
  return 'https://www.tradingview.com/chart/?symbol=OKX:' + clean + '.P';
}

/** The four [QUICK-CLOSE] buttons (two rows) for an auto-traded position. */
function quickCloseRows(tradeId) {
  return [
    [cb('qc_half', '🎯 50%', 'qc_half_' + tradeId), cb('qc_full', '💰 100%', 'qc_full_' + tradeId)],
    [cb('qc_be', '🛡 SL→BE', 'qc_be_' + tradeId), cb('qc_refresh', '📊 Прогресс', 'qc_refresh_' + tradeId)],
  ];
}

/**
 * signal_compact_keyboard(trade_id, symbol, show_trade_btn, is_counter_trend, is_auto_traded, lang)
 * — LEVELS and VOLUME cards.
 */
function signalCompactKeyboard(tradeId, symbol, { showTradeBtn = false, isCounterTrend = false, isAutoTraded = false, lang = 'ru' } = {}) {
  const rows = [];
  if (isAutoTraded) rows.push(...quickCloseRows(tradeId));
  rows.push([url('chart', t('signal_chart_btn', lang), tvUrl(symbol)), cb('my_stats', t('signal_stats_btn', lang), 'my_stats')]);
  rows.push([cb('sig_records', t('signal_record_btn', lang), 'sig_records_' + tradeId)]);
  if (showTradeBtn) rows.unshift([cb('exec_trade', t('signal_open_trade_btn', lang), 'exec_trade_' + tradeId)]);
  if (isCounterTrend) rows.push([cb('counter_trend_help', t('signal_counter_trend_help_btn', lang), 'counter_trend_help')]);
  return rows;
}

/** trade_records_keyboard(trade_id) — the «📋 Записать результат» submenu (Russian only in the bot). */
function tradeRecordsKeyboard(tradeId) {
  return [
    [cb('res_TP1', '🎯 TP1', 'res_TP1_' + tradeId), cb('res_TP2', '🎯 TP2', 'res_TP2_' + tradeId), cb('res_TP3', '🏆 TP3', 'res_TP3_' + tradeId)],
    [cb('res_SL', '❌ Стоп-лосс', 'res_SL_' + tradeId), cb('res_SKIP', '⏭ Пропустил', 'res_SKIP_' + tradeId)],
    [cb('sig_back', '◀️ Назад', 'sig_back_' + tradeId)],
  ];
}

/** smc/scanner._smc_keyboard(symbol, trade_id, show_trade_btn, is_auto_traded, lang) — no «record result» button. */
function smcKeyboard(symbol, tradeId = '', { showTradeBtn = false, isAutoTraded = false, lang = 'ru' } = {}) {
  const rows = [];
  if (isAutoTraded && tradeId) rows.push(...quickCloseRows(tradeId));
  rows.push([url('chart', t('signal_chart_btn', lang), tvUrl(symbol)), cb('my_stats', t('signal_stats_btn', lang), 'my_stats')]);
  if (showTradeBtn && tradeId) rows.unshift([cb('exec_trade', t('signal_open_trade_btn', lang), 'exec_trade_' + tradeId)]);
  return rows;
}

/** trend_monitor._keyboard(lang) — the single opt-out button under a trend alert (EN only for lang == "en"). */
function trendKeyboard(lang = 'ru') {
  return [[cb('trend_notify_off', lang !== 'en' ? MESSAGES.trend_notify_off_btn.ru : MESSAGES.trend_notify_off_btn.en, 'trend_notify_off')]];
}

/** chart_sender._send_chart: the single «🖼 Что значат символы?» button (RU only for lang == "ru"). */
function chartKeyboard(lang = 'ru') {
  return [[cb('chart_help', lang === 'ru' ? MESSAGES.chart_help_btn.ru : MESSAGES.chart_help_btn.en, 'chart_help')]];
}

/** Telegram `inline_keyboard` shape (for the optional Telegram mirror). */
function toTelegram(rows) {
  return {
    inline_keyboard: rows.map((row) => row.map((b) => (b.kind === 'url'
      ? { text: b.label, url: b.action }
      : { text: b.label, callback_data: b.action }))),
  };
}

module.exports = {
  MESSAGES, tvUrl, quickCloseRows, signalCompactKeyboard, tradeRecordsKeyboard, smcKeyboard,
  trendKeyboard, chartKeyboard, toTelegram,
};
