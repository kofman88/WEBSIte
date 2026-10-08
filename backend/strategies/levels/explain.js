'use strict';
/**
 * explain.js — indicator._build_human_explanation (spec §18.11), verbatim Russian text:
 *   level part (class name, price via `_fmt_p`, hits with "касания"/"касаний"),
 *   setup part by substring of the setup name (Ложный пробой/Fakeout → SFP → Ретест → Пробой → bounce),
 *   then session, corr label, divergence label (when non-empty), risk part
 *   ("Стоп за структуру … (риск x.x%). TP1: … (R:R 1:x.x), TP2: … (R:R 1:x.x).") joined by " ".
 * Pure; formatting through common/pyfmt (fp = `_fmt_p`, fmtFixed = f"{x:.1f}").
 */

const { fp, fmtFixed } = require('../common/pyfmt');
const { CLASS_NAMES } = require('./zones');

const SETUP_TEXT = Object.freeze({
  fakeout: {
    LONG: 'Цена ушла ниже уровня, но быстро вернулась — ложный пробой вниз, ловушка для продавцов.',
    SHORT: 'Цена пробила уровень вверх, но не закрепилась — ложный пробой, ловушка для покупателей.',
  },
  sfp: {
    LONG: 'Захват ликвидности снизу (SFP): пробой ниже уровня со быстрым возвратом — бычья ловушка медвежьих стопов.',
    SHORT: 'Захват ликвидности сверху (SFP): пробой выше уровня со быстрым возвратом — медвежья ловушка бычьих стопов.',
  },
  retest: {
    LONG: 'Уровень пробит снизу вверх и сменил роль — бывшее сопротивление стало поддержкой. Ретест — классическая точка входа в лонг.',
    SHORT: 'Уровень пробит сверху вниз и сменил роль — бывшая поддержка стала сопротивлением. Ретест подтверждает смену тренда.',
  },
  breakout: {
    LONG: 'Пробой ключевого уровня вверх с закреплением. Вход на импульсе по тренду.',
    SHORT: 'Пробой ключевой поддержки вниз с закреплением. Вход на импульсе по тренду.',
  },
  bounce: {
    LONG: 'Цена подошла к уровню поддержки и показывает признаки разворота. Отскок от ключевой зоны.',
    SHORT: 'Цена подошла к уровню сопротивления и теряет импульс. Ожидается отказ и разворот вниз.',
  },
});

/** The setup sentence by the setup name (first matching substring wins; "SFP (Ложный пробой вверх)" → fakeout). */
function setupPart(sType, isLong) {
  const side = isLong ? 'LONG' : 'SHORT';
  if (sType.includes('Ложный пробой') || sType.includes('Fakeout')) return SETUP_TEXT.fakeout[side];
  if (sType.includes('SFP')) return SETUP_TEXT.sfp[side];
  if (sType.includes('Ретест')) return SETUP_TEXT.retest[side];
  if (sType.includes('Пробой')) return SETUP_TEXT.breakout[side];
  return SETUP_TEXT.bounce[side];
}

/**
 * _build_human_explanation(signal, s_level, s_class, s_hits, s_type, entry, sl, tp1, tp2,
 * rr1, rr2, risk_pct, session, corr_label, diverg_label) → str.
 */
function buildHumanExplanation(signal, sLevel, sClass, sHits, sType, entry, sl, tp1, tp2, rr1, rr2, riskPct, session, corrLabel, divergLabel) {
  const isLong = signal === 'LONG';
  const lvlLabel = CLASS_NAMES[sClass] === undefined ? 'Рабочий' : CLASS_NAMES[sClass];

  // 1. Описание уровня
  const hitsStr = sHits <= 4 ? `${sHits} касания` : `${sHits} касаний`;
  const lvlPart = sHits >= 3
    ? `${lvlLabel} уровень ${fp(sLevel)} (${hitsStr}) — каждый раз давал уверенную реакцию.`
    : `${lvlLabel} уровень ${fp(sLevel)} (${hitsStr}).`;

  // 2. Тип сетапа
  const setup = setupPart(String(sType), isLong);

  // 3. Риск и цели
  const riskPart = `Стоп за структуру ${fp(sl)} (риск ${fmtFixed(riskPct, 1)}%). `
    + `TP1: ${fp(tp1)} (R:R 1:${fmtFixed(rr1, 1)}), TP2: ${fp(tp2)} (R:R 1:${fmtFixed(rr2, 1)}).`;

  const parts = [lvlPart, setup];
  if (session) parts.push(session);
  if (corrLabel) parts.push(corrLabel);
  if (divergLabel) parts.push(divergLabel);
  parts.push(riskPart);
  return parts.join(' ');
}

module.exports = { SETUP_TEXT, setupPart, buildHumanExplanation };
