'use strict';
/**
 * patterns.js — LEVELS candle & institutional patterns, approach quality and test
 * counting, one-to-one with indicator.CHMIndicator:
 *
 *   detectPattern                `_detect_pattern(df)` → { bull, bear }               (spec §8)
 *   detectWeakPattern            LEVELS_RELAX_ENABLED weak-pattern fallback             (spec §8.2)
 *   detectInstitutionalPattern   `_detect_institutional_pattern` tiers A→D → {name,bonus} (spec §9.5)
 *   assessApproachQuality        `_assess_approach_quality` → { ok, reason }           (spec §9.6)
 *   checkFakeout                 `_check_fakeout`                                       (spec §9.3)
 *   countRecentTests             `_count_recent_tests` (entries into the zone)          (spec §9.7)
 *
 * All Russian strings are verbatim (they end up in `reasons` / cards).
 * `df` is a Frame (o/h/l/c/v Float64Arrays, length) — the LAST ROW IS THE LAST CLOSED BAR.
 * Pure.
 */

/** Candle pattern names (`_detect_pattern`). */
const PATTERN = Object.freeze({
  BULL_PIN: 'Пин-бар покупок',
  BEAR_PIN: 'Пин-бар продаж',
  BULL_ENGULF: 'Бычье поглощение',
  BEAR_ENGULF: 'Медвежье поглощение',
  BULL_DOJI: 'Бычий Doji (Dragonfly)',
  BEAR_DOJI: 'Медвежий Doji (Gravestone)',
  HAMMER: 'Молот (Hammer)',
  INV_HAMMER: 'Перевёрнутый молот',
  INSIDE_BULL: 'Inside Bar (сжатие, бычий)',
  INSIDE_BEAR: 'Inside Bar (сжатие, медвежий)',
  MORNING_STAR: 'Утренняя звезда',
  EVENING_STAR: 'Вечерняя звезда',
  WEAK_BULL: 'Weak: Бычья с нижней тенью',
  WEAK_BEAR: 'Weak: Медвежья с верхней тенью',
});

/** Institutional pattern names and bonuses (`_detect_institutional_pattern`). */
const INST = Object.freeze({
  LIQUIDITY_SWEEP: 'LIQUIDITY_SWEEP',
  INSTITUTIONAL_ORDERBLOCK: 'INSTITUTIONAL_ORDERBLOCK',
  FAKEOUT_PINBAR: 'FAKEOUT_PINBAR',
  ENGULFING_AT_LEVEL: 'ENGULFING_AT_LEVEL',
  PINBAR_AT_LEVEL: 'PINBAR_AT_LEVEL',
  SFP: 'SFP',
  BREAKOUT_RETEST: 'BREAKOUT_RETEST',
  BOUNCE_PLAIN: 'BOUNCE_PLAIN',
});

/** Approach-quality strings (`_assess_approach_quality`). */
const APPROACH = Object.freeze({
  NOT_ENOUGH_DATA: 'Недостаточно данных',
  IMPULSE: 'Импульсный подход с высоким объёмом',
  VERTICAL: 'Вертикальный подход — слишком быстро',
  overTested: (n) => `Уровень тестировался ${n}× подряд — ожидается пробой`,
  VOL_DECLINING: '✅ Снижение объёма на подходе',
  SIZE_DECAYING: '✅ Затухающий импульс',
  CONSOLIDATION: '✅ Консолидация у уровня',
  NEUTRAL: 'Нейтральный подход',
});

/**
 * Where the bot indexes past the start of a short frame (`df.iloc[-7]` on 6 bars) pandas raises
 * IndexError; the port throws this instead of reading `undefined` (a Python exception ↔ a JS throw).
 */
class PyIndexError extends Error {
  constructor(message = 'single positional indexer is out-of-bounds') {
    super(message);
    this.name = 'IndexError';
  }
}

/** Patterns that exempt the impulse check (FIX-WR-2). */
const IMPULSE_EXEMPT = Object.freeze(new Set([INST.LIQUIDITY_SWEEP, INST.INSTITUTIONAL_ORDERBLOCK]));

/**
 * indicator._detect_pattern(df) → { bull, bear } (one if/elif chain, first match wins,
 * then morning/evening star only when nothing matched). Needs ≥ 4 bars.
 */
function detectPattern(df) {
  const n = df.length;
  if (n < 4) return { bull: '', bear: '' };
  const c = { o: df.o[n - 1], h: df.h[n - 1], l: df.l[n - 1], c: df.c[n - 1] };
  const p = { o: df.o[n - 2], h: df.h[n - 2], l: df.l[n - 2], c: df.c[n - 2] };
  const pp = { o: df.o[n - 3], h: df.h[n - 3], l: df.l[n - 3], c: df.c[n - 3] };

  const bodyC = Math.abs(c.c - c.o);
  const totalC = c.h - c.l;
  const bodyP = Math.abs(p.c - p.o);
  const totalP = (p.h - p.l) > 1e-10 ? (p.h - p.l) : 1e-10;

  if (totalC < 1e-10) return { bull: '', bear: '' };

  const uwC = c.h - Math.max(c.c, c.o); // upper wick
  const lwC = Math.min(c.c, c.o) - c.l; // lower wick

  let bull = '';
  let bear = '';

  if (lwC >= bodyC * 1.5 && uwC < bodyC * 0.5 && c.c >= c.o) {
    bull = PATTERN.BULL_PIN;
  } else if (uwC >= bodyC * 1.5 && lwC < bodyC * 0.5 && c.c <= c.o) {
    bear = PATTERN.BEAR_PIN;
  } else if (c.c > c.o && p.c < p.o && c.o <= p.c && c.c > p.o) {
    bull = PATTERN.BULL_ENGULF;
  } else if (c.c < c.o && p.c > p.o && c.o >= p.c && c.c < p.o) {
    bear = PATTERN.BEAR_ENGULF;
  } else if (bodyC / totalC < 0.10) {
    // Doji сам по себе нейтрален — дальше уточняем по позиции хвостов
    if (lwC > uwC * 2) bull = PATTERN.BULL_DOJI;
    else if (uwC > lwC * 2) bear = PATTERN.BEAR_DOJI;
    // else: нейтральный Doji — пропускаем (chain ends)
  } else if (lwC >= totalC * 0.6 && bodyC <= totalC * 0.3) {
    bull = PATTERN.HAMMER;
  } else if (uwC >= totalC * 0.6 && bodyC <= totalC * 0.3) {
    bear = PATTERN.INV_HAMMER;
  } else if (c.h <= p.h && c.l >= p.l) {
    // Inside Bar: направление — по цвету свечи (QUIRK(spec §8 rule 8): equal → nothing)
    if (c.c > c.o) bull = PATTERN.INSIDE_BULL;
    else if (c.c < c.o) bear = PATTERN.INSIDE_BEAR;
  }

  if (!bull && !bear) {
    if (pp.c < pp.o && bodyP / totalP < 0.3 && c.c > c.o && c.c > (pp.o + pp.c) / 2) {
      bull = PATTERN.MORNING_STAR;
    } else if (pp.c > pp.o && bodyP / totalP < 0.3 && c.c < c.o && c.c < (pp.o + pp.c) / 2) {
      bear = PATTERN.EVENING_STAR;
    }
  }
  return { bull, bear };
}

/**
 * LEVELS_RELAX_ENABLED weak-pattern fallback (spec §8.2), applied by the caller only when
 * relax mode is on, no pattern was found and len(df) ≥ 3: a bullish candle with lower
 * wick ≥ 0.8×body → WEAK_BULL; elif bearish with upper wick ≥ 0.8×body → WEAK_BEAR.
 * Needs total > 1e-10 and body > 1e-10.
 */
function detectWeakPattern(df) {
  const n = df.length;
  if (n < 3) return { bull: '', bear: '' };
  const o = df.o[n - 1]; const h = df.h[n - 1]; const l = df.l[n - 1]; const c = df.c[n - 1];
  const body = Math.abs(c - o);
  const total = h - l;
  if (!(total > 1e-10 && body > 1e-10)) return { bull: '', bear: '' };
  const uw = h - Math.max(c, o);
  const lw = Math.min(c, o) - l;
  if (c > o && lw >= body * 0.8) return { bull: PATTERN.WEAK_BULL, bear: '' };
  if (c < o && uw >= body * 0.8) return { bull: '', bear: PATTERN.WEAK_BEAR };
  return { bull: '', bear: '' };
}

/**
 * indicator._detect_institutional_pattern(df, level, direction, vol_ratio, zone_buf)
 * → { name, bonus }: tiers A (3) → B (2) → C (1) → D (0), first match. Needs ≥ 5 bars.
 */
function detectInstitutionalPattern(df, level, direction, volRatio, zoneBuf) {
  const n = df.length;
  if (n < 5) return { name: '', bonus: 0 };
  const c = { o: df.o[n - 1], h: df.h[n - 1], l: df.l[n - 1], c: df.c[n - 1] };
  const p = { o: df.o[n - 2], h: df.h[n - 2], l: df.l[n - 2], c: df.c[n - 2] };
  const isLong = direction === 'LONG';

  const bodyC = Math.abs(c.c - c.o);
  const totalC = Math.max(c.h - c.l, 1e-10);
  const bodyP = Math.abs(p.c - p.o);
  const totalP = Math.max(p.h - p.l, 1e-10);

  // ── Уровень A ──
  const lsCond = isLong
    ? (c.l < level - zoneBuf * 0.5 && c.c > level && volRatio > 2.0)
    : (c.h > level + zoneBuf * 0.5 && c.c < level && volRatio > 2.0);
  if (lsCond) return { name: INST.LIQUIDITY_SWEEP, bonus: 3 };

  const obCond = isLong
    ? (p.c < p.o && bodyP / totalP > 0.70 && volRatio > 2.0 && c.c > c.o)
    : (p.c > p.o && bodyP / totalP > 0.70 && volRatio > 2.0 && c.c < c.o);
  if (obCond) return { name: INST.INSTITUTIONAL_ORDERBLOCK, bonus: 3 };

  // ── Уровень B ──
  const uwC = c.h - Math.max(c.c, c.o);
  const lwC = Math.min(c.c, c.o) - c.l;
  void totalC; // body_ratio is computed but unused in the bot
  const fpCond = isLong
    ? (c.l < level - zoneBuf * 0.3 && c.c > level && lwC >= bodyC * 1.5 && uwC < bodyC)
    : (c.h > level + zoneBuf * 0.3 && c.c < level && uwC >= bodyC * 1.5 && lwC < bodyC);
  if (fpCond) return { name: INST.FAKEOUT_PINBAR, bonus: 2 };

  const egCond = isLong
    ? (c.c > c.o && p.c < p.o && c.o <= p.c && c.c > p.o && Math.abs(c.c - level) < zoneBuf * 2)
    : (c.c < c.o && p.c > p.o && c.o >= p.c && c.c < p.o && Math.abs(c.c - level) < zoneBuf * 2);
  if (egCond) return { name: INST.ENGULFING_AT_LEVEL, bonus: 2 };

  // ── Уровень C ──
  const pbCond = isLong
    ? (lwC >= bodyC * 1.5 && uwC < bodyC && c.c >= c.o)
    : (uwC >= bodyC * 1.5 && lwC < bodyC && c.c <= c.o);
  if (pbCond) return { name: INST.PINBAR_AT_LEVEL, bonus: 1 };

  const sfpCond = isLong
    ? (c.l < level - zoneBuf && c.c > level && volRatio > 1.2)
    : (c.h > level + zoneBuf && c.c < level && volRatio > 1.2);
  if (sfpCond) return { name: INST.SFP, bonus: 1 };

  // ── Уровень D ──
  if (volRatio > 1.5) return { name: INST.BREAKOUT_RETEST, bonus: 0 };
  return { name: INST.BOUNCE_PLAIN, bonus: 0 };
}

/**
 * indicator._assess_approach_quality(df, level, zone_buf, vol_ma, inst_pattern)
 * → { ok, reason }. `volMa` = the rolling volume mean series (Float64Array, NaN-prefixed).
 */
function assessApproachQuality(df, level, zoneBuf, volMa, instPattern = '') {
  const n = df.length;
  if (n < 6) return { ok: true, reason: APPROACH.NOT_ENOUGH_DATA };

  const lastVolMa = volMa[volMa.length - 1];
  const avgVol = lastVolMa > 0 ? lastVolMa : 1.0; // NaN > 0 is False → 1.0, like pandas
  const lastVol = df.v[n - 1];
  const lastBody = Math.abs(df.c[n - 1] - df.o[n - 1]);
  const lastRng = Math.max(df.h[n - 1] - df.l[n - 1], 1e-10);

  // 🚫 Импульсный подход с большим объёмом (FIX-WR-2: A-tier patterns are exempt)
  const impulseExempt = IMPULSE_EXEMPT.has(instPattern);
  if (!impulseExempt && lastVol > avgVol * 1.8 && lastBody / lastRng > 0.7) {
    return { ok: false, reason: APPROACH.IMPULSE };
  }

  // 🚫 Вертикальный подход: 3+ свечи подряд одного цвета >1% каждая (bars −4, −3, −2)
  let verticalCount = 0;
  for (let i = n - 4; i < n - 1; i++) {
    const o = df.o[i]; const c = df.c[i];
    const barPct = Math.abs(c - o) / Math.max(o, 1e-10) * 100;
    if (barPct > 1.0) {
      if (c > o) verticalCount = verticalCount >= 0 ? verticalCount + 1 : 1;
      else verticalCount = verticalCount <= 0 ? verticalCount - 1 : -1;
    } else {
      verticalCount = 0;
    }
  }
  if (Math.abs(verticalCount) >= 3) return { ok: false, reason: APPROACH.VERTICAL };

  // 🚫 4+ касаний уровня подряд (the last 9 bars EXCLUDING bar −1)
  let nearCount = 0;
  for (let i = Math.max(0, n - 10); i < n - 1; i++) {
    if (df.l[i] <= level + zoneBuf && df.h[i] >= level - zoneBuf) nearCount++;
  }
  if (nearCount >= 4) return { ok: false, reason: APPROACH.overTested(nearCount) };

  // ✅ Momentum decay: bodies of bars −5..−1
  const bodies = [];
  for (let i = n - 5; i < n; i++) bodies.push(Math.abs(df.c[i] - df.o[i]));
  const sizeDecaying = bodies[4] < bodies[3] && bodies[3] < bodies[2] && bodies[0] > 0;

  // ✅ Объём на подходе снижался (bars −4, −3, −2)
  const vols = [df.v[n - 4], df.v[n - 3], df.v[n - 2]];
  const volDeclining = vols[0] > 0 ? (vols[2] < vols[1] && vols[1] < vols[0]) : true;

  // ✅ Консолидация у уровня (bars −7..−2): `df.iloc[-7]` raises IndexError on a 6-bar frame
  // (the < 6 guard above lets exactly 6 bars through; reachable only via precomputed zones)
  if (n < 7) throw new PyIndexError();
  let consolCount = 0;
  for (let i = n - 7; i < n - 1; i++) {
    if (df.l[i] <= level + zoneBuf && df.h[i] >= level - zoneBuf) consolCount++;
  }
  const hasConsolidation = consolCount >= 3 && consolCount <= 7;

  const reasonsOk = [];
  if (volDeclining) reasonsOk.push(APPROACH.VOL_DECLINING);
  if (sizeDecaying) reasonsOk.push(APPROACH.SIZE_DECAYING);
  if (hasConsolidation) reasonsOk.push(APPROACH.CONSOLIDATION);
  if (reasonsOk.length) return { ok: true, reason: reasonsOk.join(' | ') };
  return { ok: true, reason: APPROACH.NEUTRAL };
}

/** indicator._check_fakeout(df, level, direction, zone_buf) on the last closed bar. */
function checkFakeout(df, level, direction, zoneBuf) {
  const n = df.length;
  if (direction === 'LONG') return df.l[n - 1] < level - zoneBuf * 0.5 && df.c[n - 1] > level;
  return df.h[n - 1] > level + zoneBuf * 0.5 && df.c[n - 1] < level;
}

/**
 * indicator._count_recent_tests(df, level, zone_pct, lookback=30): number of ENTRIES
 * into the ±level×zone_pct/100 band over the last `lookback` bars (incl. bar −1).
 */
function countRecentTests(df, level, zonePct, lookback = 30) {
  const n = df.length;
  const zoneRange = level * zonePct / 100;
  let count = 0;
  let prevIn = false;
  for (let i = Math.max(0, n - lookback); i < n; i++) {
    const inZone = df.l[i] <= level + zoneRange && df.h[i] >= level - zoneRange;
    if (inZone && !prevIn) count++;
    prevIn = inZone;
  }
  return count;
}

module.exports = {
  PATTERN, INST, APPROACH, IMPULSE_EXEMPT, PyIndexError,
  detectPattern, detectWeakPattern, detectInstitutionalPattern, assessApproachQuality,
  checkFakeout, countRecentTests,
};
