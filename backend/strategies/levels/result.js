'use strict';
/**
 * result.js — indicator.SignalResult as a plain object in dataclass field order (so
 * `JSON.stringify(sig)` lists the keys like `dataclasses.asdict`), with the dataclass
 * defaults for everything not given.
 */

const SIGNAL_RESULT_DEFAULTS = Object.freeze({
  symbol: '',
  direction: '',
  entry: 0.0,
  sl: 0.0,
  tp1: 0.0,
  tp2: 0.0,
  tp3: 0.0,
  risk_pct: 0.0,
  quality: 0,
  reasons: null,            // list (fresh array per instance)
  rsi: 50.0,
  volume_ratio: 1.0,
  trend_local: '',
  trend_htf: '',
  pattern: '',
  breakout_type: '',
  is_counter_trend: false,
  human_explanation: '',
  level_class: 3,           // 1=Абсолютный, 2=Сильный, 3=Рабочий
  test_count: 0,            // Кол-во тестов уровня за последние 30 свечей
  rr_score: 0.0,            // Взвешенный R:R score
  corr_label: '',           // Корреляционная метка с BTC/ETH
  session: '',              // Торговая сессия по UTC
  btc_corr: 0.0,            // filled by the scanner (0.0 from the indicator)
  eth_corr: 0.0,
  tp1_close_pct: 0.40,      // FIX-WR-1: 40% позиции на TP1
  tp2_close_pct: 0.30,
  tp3_close_pct: 0.30,
  move_sl_to_be_after_tp1: true,
});

const SIGNAL_RESULT_FIELDS = Object.freeze(Object.keys(SIGNAL_RESULT_DEFAULTS));

/** SignalResult(**fields): unknown keys are rejected like a dataclass constructor. */
function signalResult(fields) {
  const out = {};
  for (const k of SIGNAL_RESULT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, k)) out[k] = fields[k];
    else out[k] = k === 'reasons' ? [] : SIGNAL_RESULT_DEFAULTS[k];
  }
  for (const k of Object.keys(fields)) {
    if (!Object.prototype.hasOwnProperty.call(SIGNAL_RESULT_DEFAULTS, k)) throw new TypeError(`SignalResult: unexpected field '${k}'`);
  }
  return out;
}

module.exports = { SIGNAL_RESULT_DEFAULTS, SIGNAL_RESULT_FIELDS, signalResult };
