'use strict';
/**
 * narrative.js — one-to-one port of the Russian narrative of
 * `smc/signal_builder.py` (`_trend_sentence` … `_invalidation_sentence`,
 * `generate_narrative`). Every string is copied verbatim; prices go through the
 * bot's `_fp` (common/pyfmt.fp), the TP3 percentage through `{:.1f}`, the SL buffer
 * through Python `str(float)` (pyRepr). Spec strategy-smc.md §5.6.
 */

const { fp, fmtFixed, pyRepr } = require('../common/pyfmt');
const { pyTruthy, pyOr, pyGet } = require('../common/pyval');

/** Python f"{x}" of a number the bot stores as float (SL_BUFFER_PCT is typed float). */
function pyStrNum(x) {
  return typeof x === 'number' ? pyRepr(x) : String(x);
}

function trendSentence(structure, tfHtf) {
  const trend = pyGet(structure, 'trend', 'RANGING');
  const choch = pyGet(structure, 'choch', {});
  if (pyTruthy(pyGet(choch, 'detected', undefined)) && choch.direction === 'UP') {
    return `На ${tfHtf} зафиксирована смена характера движения вверх (CHoCH) на уровне ${fp(choch.price)} — первый признак смены тренда в пользу покупателей.`;
  }
  if (pyTruthy(pyGet(choch, 'detected', undefined)) && choch.direction === 'DOWN') {
    return `На ${tfHtf} зафиксирована смена характера движения вниз (CHoCH) на уровне ${fp(choch.price)}.`;
  }
  if (trend === 'BULLISH') {
    return `На ${tfHtf} рынок находится в устойчивом восходящем тренде с чёткой HH/HL структурой.`;
  }
  if (trend === 'BEARISH') {
    return `На ${tfHtf} рынок находится в нисходящем тренде (LH/LL).`;
  }
  return `На ${tfHtf} рынок находится в боковике без чёткой структуры.`;
}

function sweepSentence(liquidity, direction) {
  if (direction === 'LONG') {
    const sw = pyGet(liquidity, 'sweep_up', {});
    if (pyTruthy(pyGet(sw, 'swept', undefined))) {
      const lvl = pyGet(sw, 'level', 0);
      return `Перед этим цена сделала sweep ниже уровня ${fp(lvl)}, сняв ликвидность продавцов и stop-loss'ы лонгов, после чего резко отбила вверх — классический манипуляционный сбор ликвидности перед институциональным входом.`;
    }
  } else {
    const sw = pyGet(liquidity, 'sweep_down', {});
    if (pyTruthy(pyGet(sw, 'swept', undefined))) {
      const lvl = pyGet(sw, 'level', 0);
      return `Цена совершила sweep выше ${fp(lvl)}, собрала ликвидность покупателей (equal highs) и резко развернулась — типичная ловушка для розничных лонгов.`;
    }
  }
  const bosPrice = pyOr(pyGet(pyGet(liquidity, 'sweep_up', {}), 'level', 0),
    pyGet(pyGet(liquidity, 'sweep_down', {}), 'level', 0));
  if (pyTruthy(bosPrice)) {
    return `Пробой структуры (BOS) на уровне ${fp(bosPrice)} подтвердил намерение рынка.`;
  }
  return 'Явного sweep ликвидности на данном таймфрейме не зафиксировано.';
}

function obSentence(obData, direction, tfMtf) {
  const obKey = direction === 'LONG' ? 'bull_ob' : 'bear_ob';
  const ob = pyGet(obData, obKey, {});
  if (!pyTruthy(pyGet(ob, 'found', undefined))) {
    return 'Order Block в зоне входа не обнаружен.';
  }
  const lo = ob.ob_low;
  const hi = ob.ob_high;
  const obType = pyGet(ob, 'type', '');
  if (pyTruthy(pyGet(ob, 'is_breaker', undefined))) {
    // QUIRK(spec §5.6 item 3): the "new role" wording is inverted (LONG → "медвежий")
    const prev = String(obType).includes('bullish') ? 'бычий' : 'медвежий';
    const next = direction === 'LONG' ? 'медвежий' : 'бычий';
    return `Бывший ${prev} OB пробит и стал Breaker Block'ом ${fp(lo)}–${fp(hi)} — теперь работает как ${next} уровень.`;
  }
  if (direction === 'LONG') {
    return `Цена вернулась в бычий ордер-блок ${fp(lo)}–${fp(hi)} на ${tfMtf} — зону, где институционалы формировали позицию перед последним бычьим импульсом с BOS.`;
  }
  return `Цена поднялась в медвежий ордер-блок ${fp(lo)}–${fp(hi)} на ${tfMtf} — зону предложения, откуда начался последний медвежий импульс.`;
}

function fvgSentence(fvg, direction) {
  const obj = direction === 'LONG' ? pyGet(fvg, 'bull_fvg', undefined) : pyGet(fvg, 'bear_fvg', undefined);
  if (!pyTruthy(obj)) {
    return 'FVG в данной зоне отсутствует, вход основан на чистом OB.';
  }
  const lo = obj.fvg_low;
  const hi = obj.fvg_high;
  const inv = pyGet(obj, 'inversed', false);
  if (pyTruthy(inv)) {
    const role = direction === 'LONG' ? 'поддержки' : 'сопротивления';
    return `Перевёрнутый FVG ${fp(lo)}–${fp(hi)} выступает как усиленный уровень ${role} после смены роли.`;
  }
  const ftype = direction === 'LONG' ? 'bullish' : 'bearish';
  return `Внутри зоны присутствует ${ftype} FVG ${fp(lo)}–${fp(hi)} — дисбаланс, который рынок стремится заполнить, добавляя магнетизм к точке входа.`;
}

function slSentence(levels, direction, bufPct) {
  const sl = levels.sl;
  if (direction === 'LONG') {
    return `Стоп размещён под нижним экстремумом OB с буфером ${pyStrNum(bufPct)}% на уровне ${fp(sl)} — ниже этого уровня бычий контекст теряется.`;
  }
  return `Стоп размещён над верхним экстремумом OB с буфером ${pyStrNum(bufPct)}% на уровне ${fp(sl)} — выше этого уровня медвежий контекст нарушен.`;
}

function tpSentence(levels, direction, fvg) {
  const tp1 = levels.tp1;
  const tp3 = levels.tp3;
  const fvgObj = direction === 'LONG' ? pyGet(fvg, 'bull_fvg', undefined) : pyGet(fvg, 'bear_fvg', undefined);
  // QUIRK(spec §5.6 item 6): "закрытие FVG" whenever the direction's FVG exists, even if TP1 was not taken from it
  const tp1Desc = pyTruthy(fvgObj) ? `закрытие FVG (${fp(tp1)})` : `структурный уровень (${fp(tp1)})`;
  const em = levels.entry_mid;
  const pct3 = em > 0 ? Math.abs(tp3 - em) / em * 100 : 0.0;
  return `Первая цель — ${tp1Desc}, финальная цель — следующая зона ликвидности ${fp(tp3)} (+${fmtFixed(pct3, 1)}%).`;
}

function invalidationSentence(levels, direction, tfLtf) {
  const sl = levels.sl;
  if (direction === 'LONG') {
    return `Сетап теряет силу, если ${tfLtf}-свеча закроется ниже ${fp(sl)} — это полная митигация OB и потеря бычьей структуры.`;
  }
  return `Сетап теряет силу, если ${tfLtf}-свеча закроется выше ${fp(sl)} — медвежья структура будет нарушена.`;
}

/**
 * generate_narrative(analysis, levels, direction, tf_htf="4H", tf_mtf="1H", tf_ltf="15m",
 *                    show_invalidation=True, cfg=None) → the sentences joined with " ".
 */
function generateNarrative(analysis, levels, direction, { tf_htf = '4H', tf_mtf = '1H', tf_ltf = '15m', show_invalidation = true, cfg = null } = {}) {
  const bufPct = pyTruthy(cfg) ? cfg.SL_BUFFER_PCT : 0.15;
  const parts = [
    trendSentence(analysis.structure, tf_htf),
    sweepSentence(analysis.liquidity, direction),
    obSentence(analysis.ob, direction, tf_mtf),
  ];
  if (pyTruthy(pyGet(analysis.fvg, direction === 'LONG' ? 'bull_found' : 'bear_found', undefined))) {
    parts.push(fvgSentence(analysis.fvg, direction));
  }
  parts.push(slSentence(levels, direction, bufPct));
  parts.push(tpSentence(levels, direction, analysis.fvg));
  if (show_invalidation) parts.push(invalidationSentence(levels, direction, tf_ltf));
  return parts.join(' ');
}

module.exports = {
  trendSentence, sweepSentence, obSentence, fvgSentence, slSentence, tpSentence, invalidationSentence,
  generateNarrative,
};
