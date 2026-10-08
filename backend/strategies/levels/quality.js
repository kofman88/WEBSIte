'use strict';
/**
 * quality.js — the LEVELS quality system 0..10 of indicator._do_analyze, one-to-one
 * (spec §13): `accumulateQuality` runs the 18 steps in the bot's exact order, appending
 * the verbatim Russian reason strings, with the weighted-R:R drop (rr_score < 1.2 →
 * "rr") in the middle of the accumulation, the [0, 10] clamp and the memcoin cap;
 * `finalChecklist` is §13.1.
 *
 * Pure: a plain params object in, { quality, reasons, reject } out.
 */

const { REJECT } = require('./config');
const { CLASS_NAMES } = require('./zones');
const { APPROACH } = require('./patterns');
const { fmtFixed } = require('../common/pyfmt');
const { pyMax, pyMin } = require('../common/pyround');   // builtin max()/min(): a NaN 2nd argument is ignored

const REASON = Object.freeze({
  setup: (sType) => `✅ ${sType}`,
  patternA: (p) => `✅ [${p}] — паттерн класса A`,
  patternB: (p) => `✅ [${p}] — паттерн класса B`,
  patternC: (p) => `✅ [${p}] — паттерн класса C`,
  patternD: (p) => `⚠️ [${p}] — паттерн класса D`,
  levelClass: (cls) => `✅ Уровень класса ${cls} (${CLASS_NAMES[cls] === undefined ? '' : CLASS_NAMES[cls]})`,
  HTF: '✅ HTF тренд подтверждает',
  MTF3: '✅ Институциональный MTF уровень (3 ТФ)',
  MTF2: '✅ MTF уровень (2 ТФ)',
  WITH_TREND: '✅ По локальному тренду',
  COUNTER: '⚠️ Контртренд',
  volume: (vr) => `✅ Объём x${fmtFixed(vr, 1)}`,
  HVN: '✅ Volume Profile узел (HVN)',
  LVN: '✅ Чистый путь к цели (LVN)',
  approach: (r) => `✅ ${r}`,
  RSI_OS_EXIT: '✅ RSI выходит из перепроданности',
  RSI_OB_EXIT: '✅ RSI выходит из перекупленности',
  INDEPENDENT: '✅ Независимое движение (corr < 0.4)',
  testOk: (n) => `✅ Тест #${n} уровня (оптимально)`,
  testWeak: (n) => `⚠️ Тест #${n} — уровень слабеет`,
  deadSession: (s) => `⚠️ ${s} — низкая ликвидность`,
  rrScoreLow: (rr) => `⚠️ Взвешенный R:R: ${fmtFixed(rr, 2)} (ниже 1.8)`,
  MEMCOIN: '⚠️ Мемкоин (повышенный риск)',
});

/**
 * The accumulation (spec §13 table). Params:
 *   sType, instPattern, patternBonus, sClass, htfOk (USE_HTF_FILTER && _htf_confluence),
 *   sZone ({mtf_label?, timeframes?, has_hvn}), isCounter, volRatio, volMult (cfg.VOL_MULT),
 *   hasLvnPath, divergOk, divergLabel, approachOk, approachReason, signal, rsiNow,
 *   corr ({btc_corr, eth_corr}), testCount, isDeadSession, session, rrScore, memcoin.
 * Returns { quality, reasons, reject } — reject = "rr" when rr_score < 1.2 (quality/reasons
 * up to that point are still returned for diagnostics).
 */
function accumulateQuality(p) {
  let quality = 0;
  const reasons = [];

  // Базовый тип сигнала
  reasons.push(REASON.setup(p.sType));

  // Паттерн (бонус по иерархии A/B/C/D)
  if (p.patternBonus === 3) { quality += 3; reasons.push(REASON.patternA(p.instPattern)); }
  else if (p.patternBonus === 2) { quality += 2; reasons.push(REASON.patternB(p.instPattern)); }
  else if (p.patternBonus === 1) { quality += 1; reasons.push(REASON.patternC(p.instPattern)); }
  else if (p.instPattern) reasons.push(REASON.patternD(p.instPattern));

  // Класс уровня
  reasons.push(REASON.levelClass(p.sClass));
  if (p.sClass === 1) quality += 2;
  else if (p.sClass === 2) quality += 1;
  else quality += 1;   // Class 3 "Рабочий" тоже даёт +1

  // HTF подтверждение
  if (p.htfOk) { quality += 1; reasons.push(REASON.HTF); }

  // MTF уровень
  const z = p.sZone || {};
  const mtfLabel = z.mtf_label === undefined ? '' : z.mtf_label;
  const tfCount = Array.isArray(z.timeframes) ? z.timeframes.length : 0;
  if (mtfLabel === 'Институциональный' || tfCount >= 3) { quality += 2; reasons.push(REASON.MTF3); }
  else if (mtfLabel === 'MTF' || tfCount === 2) { quality += 1; reasons.push(REASON.MTF2); }

  // По тренду
  if (!p.isCounter) { quality += 1; reasons.push(REASON.WITH_TREND); }
  else { quality -= 1; reasons.push(REASON.COUNTER); }

  // Объём
  if (p.volRatio >= p.volMult) { quality += 1; reasons.push(REASON.volume(p.volRatio)); }

  // HVN у уровня
  if (z.has_hvn) { quality += 1; reasons.push(REASON.HVN); }

  // LVN на пути к TP
  if (p.hasLvnPath) { quality += 1; reasons.push(REASON.LVN); }

  // RSI дивергенция
  if (p.divergOk) { quality += 2; reasons.push(p.divergLabel); }

  // Подход
  if (p.approachOk && p.approachReason !== APPROACH.NEUTRAL && p.approachReason !== APPROACH.NOT_ENOUGH_DATA) {
    quality += 1;
    reasons.push(REASON.approach(p.approachReason));
  }

  // Консолидация у уровня — дополнительный бонус
  if (String(p.approachReason).includes('Консолидация')) quality += 1;

  // RSI экстремумы
  if (p.signal === 'LONG' && p.rsiNow > 30 && p.rsiNow < 45) reasons.push(REASON.RSI_OS_EXIT);
  else if (p.signal === 'SHORT' && p.rsiNow > 55 && p.rsiNow < 70) reasons.push(REASON.RSI_OB_EXIT);

  // Независимая монета
  if (p.corr.btc_corr < 0.4 && p.corr.eth_corr < 0.4) { quality += 1; reasons.push(REASON.INDEPENDENT); }

  // Тест-счётчик
  if (p.testCount <= 2) reasons.push(REASON.testOk(p.testCount));
  else { quality -= 1; reasons.push(REASON.testWeak(p.testCount)); }

  // Штраф за мёртвую сессию
  if (p.isDeadSession) { quality -= 2; reasons.push(REASON.deadSession(p.session)); }

  // Взвешенный R:R фильтр (QUIRK(spec §25.7): the third rr_score threshold sits inside the accumulation)
  if (p.rrScore < 1.2) return { quality, reasons, reject: REJECT.RR, reason: 'rr_score_lt_1.2' };
  if (p.rrScore < 1.8) { quality -= 1; reasons.push(REASON.rrScoreLow(p.rrScore)); }

  // Зажим в [0, 10]
  quality = pyMax(0, pyMin(10, quality));

  // Мемкоин: ограничение (но не блокируем при min_quality=4)
  if (p.memcoin && quality > 5) quality = 5;
  if (p.memcoin) reasons.push(REASON.MEMCOIN);

  return { quality, reasons, reject: null };
}

/**
 * Final checklist (spec §13.1): [True, approach_ok, has_pattern or is_fakeout or vol_ratio > 1.2,
 * rr_actual ≥ effective_min_rr, test_count ≤ MAX_LEVEL_TESTS − 1]. Returns { ok, items }.
 */
function finalChecklist({ approachOk, hasPattern, sType, volRatio, rrActual, effectiveMinRr, testCount, maxLevelTests }) {
  const isFakeout = String(sType).includes('Fakeout') || String(sType).includes('SFP');
  const items = [
    true,                                                // уровень (фильтр quality в scanner_mid)
    Boolean(approachOk),                                 // подход
    Boolean(hasPattern) || isFakeout || volRatio > 1.2,  // реакция: снижен порог объёма
    rrActual >= effectiveMinRr,                          // R:R (relaxed — как выше)
    testCount <= maxLevelTests - 1,                      // тесты
  ];
  return { ok: items.every(Boolean), items, isFakeout };
}

module.exports = { REASON, accumulateQuality, finalChecklist };
