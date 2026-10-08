'use strict';
/**
 * setups.js — the first half of indicator.CHMIndicator._do_analyze, one-to-one:
 *
 *   prologue        indicators (EMA ATR, EMA fast/slow, span-RSI, SMA volume), scalars,
 *                   local trend, session (spec §6)
 *   marketSession   `_market_session_filter` (UTC hour of the last closed bar)
 *   findSetup       the strictly ordered setup search, blocks A–D over zones
 *                   highest-first with the proximity window (spec §9.3)
 *   analyzePart1    `analyze()` length guard + `_do_analyze` up to the RSI gate:
 *                   zones (fresh or precomputed, HTF marking), nearest-level gate,
 *                   volume gate, setup search, signal-level distance re-check,
 *                   institutional pattern, approach quality, test count, RSI gate.
 *                   Returns the reject bucket or every intermediate the second half
 *                   (M6: stops / targets / quality / filters / result) consumes.
 *
 * Pure: Frames + an IndConfig object in; plain object out. No cache, no clock — the
 * live zone cache (zones.ZoneCache) is an optional wrapper one layer up.
 */

const S = require('../common/series');
const { REJECT, LEVELS_ENV, minBars } = require('./config');
const Z = require('./zones');
const P = require('./patterns');

/** Setup names (`s_type`), verbatim. */
const SETUP = Object.freeze({
  SFP_LONG: 'SFP (Захват ликвидности)',
  FAKEOUT: 'Ложный пробой (Fakeout)',
  BOUNCE_SUP: 'Отскок от поддержки',
  RETEST_RES: 'Ретест пробитого уровня',
  BREAKOUT: 'Пробой уровня',
  SFP_SHORT: 'SFP (Ложный пробой вверх)',
  BOUNCE_RES: 'Отскок от сопротивления',
  RETEST_SUP: 'Ретест пробитой поддержки',
  BREAKDOWN: 'Пробой поддержки',
});

const TREND = Object.freeze({ BULL: '📈 Бычий', BEAR: '📉 Медвежий', FLAT: '↔️ Боковик' });

const SESSION = Object.freeze({
  ASIA: '🌏 Азиатская сессия',
  LONDON: '🇬🇧 Лондон открытие',
  EU_US: '🌍 Европа + США пересечение',
  NY: '🇺🇸 Нью-Йорк сессия',
  DEAD: '🌙 Мёртвая зона',
  UNKNOWN: '⏰ Сессия неизвестна',
});

/** Sessions that cost −2 quality (`is_dead_session`). */
const DEAD_SESSIONS = Object.freeze(new Set([SESSION.ASIA, SESSION.DEAD]));

/** indicator._market_session_filter(df) → session label by the UTC hour of df.index[-1]. */
function marketSession(df) {
  let h;
  try {
    h = df.utcHour ? df.utcHour(-1) : new Date(df.t[df.length - 1]).getUTCHours();
    if (!(h >= 0 && h < 24)) return SESSION.UNKNOWN;
  } catch (_e) {
    return SESSION.UNKNOWN;
  }
  if (h >= 0 && h < 8) return SESSION.ASIA;
  if (h >= 8 && h < 12) return SESSION.LONDON;
  if (h >= 12 && h < 16) return SESSION.EU_US;
  if (h >= 16 && h < 21) return SESSION.NY;
  return SESSION.DEAD;
}

/**
 * `_do_analyze` prologue (spec §6): series + last-bar scalars.
 *   atr = ewm(span=ATR_PERIOD, adjust=False) of TR; ema50/ema200 = ewm(span); rsi = span RSI;
 *   vol_ma = rolling(VOL_LEN).mean(); vol_avg = vol_ma[-1] if > 0 else 1.0; vol_ratio = vol_now/vol_avg.
 */
function prologue(df, cfg) {
  const n = df.length;
  const atr = S.atrEmaSpan(df.h, df.l, df.c, cfg.ATR_PERIOD);
  const ema50 = S.ewmSpan(df.c, cfg.EMA_FAST);
  const ema200 = S.ewmSpan(df.c, cfg.EMA_SLOW);
  const rsi = S.rsiSpan(df.c, cfg.RSI_PERIOD);
  const volMa = S.rollingMean(df.v, cfg.VOL_LEN, cfg.VOL_LEN);

  const cNow = df.c[n - 1];
  const atrNow = atr[n - 1];
  const rsiNow = rsi[n - 1];
  const volNow = df.v[n - 1];
  const volAvg = volMa[n - 1] > 0 ? volMa[n - 1] : 1.0;
  const volRatio = volAvg > 0 ? volNow / volAvg : 1.0;

  const e50 = ema50[n - 1];
  const e200 = ema200[n - 1];
  const bullLocal = cNow > e50 && e50 > e200;
  const bearLocal = cNow < e50 && e50 < e200;
  const trendLocal = bullLocal ? TREND.BULL : (bearLocal ? TREND.BEAR : TREND.FLAT);

  const session = marketSession(df);
  const isDeadSession = DEAD_SESSIONS.has(session);

  return {
    atr, ema50, ema200, rsi, volMa,
    cNow, atrNow, rsiNow, volNow, volAvg, volRatio,
    bullLocal, bearLocal, trendLocal, session, isDeadSession,
  };
}

/**
 * The setup search of `_do_analyze` (spec §9.3). Blocks in order, each over its zone
 * list in REVERSE order (highest price first); the first hit ends everything:
 *   A. LONG from support:  SFP → Fakeout → Bounce (bull pattern, close ≥ lvl − zone_buf)
 *   B. LONG retest / breakout of resistance
 *   C. SHORT from resistance: SFP → Fakeout → Bounce
 *   D. SHORT retest / breakdown of support
 * Returns { signal, sLevel, sType, isCounter, sHits, sClass, sZone } or null.
 */
function findSetup(df, pro, supZones, resZones, bullPat, bearPat, zonePct, relax = false) {
  const n = df.length;
  const cNow = pro.cNow;
  const volRatio = pro.volRatio;
  const BOUNCE_MULT = relax ? 4 : 2;        // QUIRK(spec §8.2): relax widens the bounce window
  const PROXIMITY_MULT = relax ? 5 : 3;     // and the proximity window
  const low1 = df.l[n - 1];
  const high1 = df.h[n - 1];
  const close2 = df.c[n - 2];

  const hit = (signal, zone, sType, isCounter) => ({
    signal, sLevel: zone.price, sType, isCounter, sHits: zone.hits, sClass: zone.class, sZone: zone,
  });

  // closes of bars −7..−2 (df["close"].iloc[-7:-1]); any(...) over an empty slice is False
  const anyRecentClose = (pred) => {
    const start = Math.max(0, n - 7);
    for (let i = start; i < n - 1; i++) if (pred(df.c[i])) return true;
    return false;
  };

  // ── ЛОНГ от поддержки ──
  for (let k = supZones.length - 1; k >= 0; k--) {
    const sup = supZones[k];
    const lvl = sup.price;
    const zoneBuf = lvl * zonePct / 100;
    if (Math.abs(cNow - lvl) > zoneBuf * PROXIMITY_MULT) continue;
    // [LEVELS-SFP] SFP before Fakeout
    if (low1 < lvl - zoneBuf && cNow > lvl && volRatio > 1.2) return hit('LONG', sup, SETUP.SFP_LONG, pro.bearLocal);
    if (P.checkFakeout(df, lvl, 'LONG', zoneBuf)) return hit('LONG', sup, SETUP.FAKEOUT, pro.bearLocal);
    if (Math.abs(cNow - lvl) < zoneBuf * BOUNCE_MULT && bullPat && cNow >= lvl - zoneBuf) {
      return hit('LONG', sup, SETUP.BOUNCE_SUP, pro.bearLocal);
    }
  }

  // ── ЛОНГ: ретест пробитого сопротивления ──
  for (let k = resZones.length - 1; k >= 0; k--) {
    const res = resZones[k];
    const lvl = res.price;
    const zoneBuf = lvl * zonePct / 100;
    if (Math.abs(cNow - lvl) > zoneBuf * PROXIMITY_MULT) continue;
    if (anyRecentClose((c) => c > lvl) && Math.abs(low1 - lvl) < zoneBuf && bullPat) {
      return hit('LONG', res, SETUP.RETEST_RES, pro.bearLocal);
    }
    // Честный пробой вверх
    if (close2 < lvl && cNow > lvl + zoneBuf && volRatio > 1.5) return hit('LONG', res, SETUP.BREAKOUT, pro.bearLocal);
  }

  // ── ШОРТ от сопротивления ──
  for (let k = resZones.length - 1; k >= 0; k--) {
    const res = resZones[k];
    const lvl = res.price;
    const zoneBuf = lvl * zonePct / 100;
    if (Math.abs(cNow - lvl) > zoneBuf * PROXIMITY_MULT) continue;
    if (high1 > lvl + zoneBuf && cNow < lvl && volRatio > 1.2) return hit('SHORT', res, SETUP.SFP_SHORT, pro.bullLocal);
    if (P.checkFakeout(df, lvl, 'SHORT', zoneBuf)) return hit('SHORT', res, SETUP.FAKEOUT, pro.bullLocal);
    if (Math.abs(cNow - lvl) < zoneBuf * BOUNCE_MULT && bearPat && cNow <= lvl + zoneBuf) {
      return hit('SHORT', res, SETUP.BOUNCE_RES, pro.bullLocal);
    }
  }

  // ── ШОРТ: ретест пробитой поддержки ──
  for (let k = supZones.length - 1; k >= 0; k--) {
    const sup = supZones[k];
    const lvl = sup.price;
    const zoneBuf = lvl * zonePct / 100;
    if (Math.abs(cNow - lvl) > zoneBuf * PROXIMITY_MULT) continue;
    if (anyRecentClose((c) => c < lvl) && Math.abs(high1 - lvl) < zoneBuf && bearPat) {
      return hit('SHORT', sup, SETUP.RETEST_SUP, pro.bullLocal);
    }
    if (close2 > lvl && cNow < lvl - zoneBuf && volRatio > 1.5) return hit('SHORT', sup, SETUP.BREAKDOWN, pro.bullLocal);
  }

  return null;
}

/**
 * Nearest zone to the price: `min(all_levels, key=|price − c_now|)` over sup then res
 * (first minimum wins on ties). Returns the price or NaN when there are no zones.
 */
function nearestLevel(supZones, resZones, cNow) {
  let best = NaN;
  let bestD = Infinity;
  const all = supZones.concat(resZones);
  for (let i = 0; i < all.length; i++) {
    const d = Math.abs(all[i].price - cNow);
    if (d < bestD) { bestD = d; best = all[i].price; }
  }
  return best;
}

/**
 * analyze() length guard + the first half of `_do_analyze` (through the RSI gate).
 *
 * @param {string} symbol
 * @param {Frame}  df      working-TF candles, last row = last closed bar
 * @param {Frame|null} dfHtf  1D candles (HTF marking when given and > 20 bars)
 * @param {object} cfg     IndConfig (config.cfgToInd)
 * @param {object} [opts]  { relax: LEVELS_RELAX_ENABLED, precomputedZones: {sup, res},
 *                           htfZoneCache: Map, symbolForCache,
 *                           skipGuard: call `_do_analyze` directly (no analyze() length guard,
 *                           as the bot's backtest / analyze_on_demand do) }
 * @returns {{reject: string}|object}  `reject` ∈ REJECT buckets (NONE for the prologue
 *   guard), or `reject: null` with: pro (prologue), zones {sup, res} (HTF-marked),
 *   rawZones, bullPat, bearPat, signal, sLevel, sType, isCounter, sHits, sClass, sZone,
 *   zoneBuf, distPct, sigDistPct, instPattern, patternBonus, approachOk, approachReason,
 *   testCount.
 */
function analyzePart1(symbol, df, dfHtf, cfg, opts = {}) {
  const relax = opts.relax === undefined ? LEVELS_ENV.LEVELS_RELAX_ENABLED : Boolean(opts.relax);
  if (!df || (!opts.skipGuard && df.length < minBars(cfg))) return { reject: REJECT.NONE, reason: 'too_short' };

  // ── Базовые индикаторы ──
  const pro = prologue(df, cfg);
  const { cNow, atrNow, rsiNow, volRatio } = pro;

  // ── Зоны (многослойная кластеризация) ──
  let supZones;
  let resZones;
  let rawZones = null;
  if (opts.precomputedZones) {
    supZones = opts.precomputedZones.sup;
    resZones = opts.precomputedZones.res;
  } else {
    rawZones = Z.getZones(df, cfg.PIVOT_STRENGTH, atrNow, cfg.ZONE_BUFFER);
    supZones = rawZones.sup;
    resZones = rawZones.res;
  }
  if (!supZones.length && !resZones.length) return { reject: REJECT.ZONES, reason: 'no_zones', pro };

  // ── Паттерны ──
  let { bull: bullPat, bear: bearPat } = P.detectPattern(df);
  if (relax && !bullPat && !bearPat && df.length >= 3) {
    const weak = P.detectWeakPattern(df);
    bullPat = weak.bull; bearPat = weak.bear;
  }

  // [LEVELS-MTF] HTF zone confluence marking (independent of USE_HTF_FILTER — the scanner
  // only passes df_htf when use_htf is on)
  if (dfHtf && dfHtf.length > 20) {
    const htf = Z.htfZones(dfHtf, cfg.PIVOT_STRENGTH, atrNow, cfg.ZONE_BUFFER, opts.htfZoneCache || null, opts.symbolForCache || symbol);
    const marked = Z.markHtfConfluence(supZones, resZones, htf.sup, htf.res, atrNow);
    supZones = marked.sup; resZones = marked.res;
  }

  // ── Ближайший уровень ──
  const nearest = nearestLevel(supZones, resZones, cNow);
  const distPct = Math.abs(cNow - nearest) / cNow * 100;
  if (distPct > cfg.MAX_DIST_PCT) return { reject: REJECT.ZONES, reason: 'nearest_too_far', pro, distPct };

  const ZONE_PCT = cfg.ZONE_PCT;

  // ── Фильтр объёма ──
  if (cfg.USE_VOLUME_FILTER && volRatio < cfg.VOL_MULT * 0.7) return { reject: REJECT.VOLUME, reason: 'vol_ratio', pro, distPct };

  // ── Поиск сигнала ──
  const setup = findSetup(df, pro, supZones, resZones, bullPat, bearPat, ZONE_PCT, relax);
  if (!setup || setup.sLevel == null) return { reject: REJECT.SIGNAL, reason: 'no_setup', pro, distPct, bullPat, bearPat };
  const { signal, sLevel, sType, isCounter, sHits, sClass, sZone } = setup;

  // [LEVELS-FIX] MAX_DIST_PCT re-checked against the SIGNAL's level (QUIRK(spec §9.4))
  const sigDistPct = cNow > 0 ? Math.abs(cNow - sLevel) / cNow * 100 : 0.0;
  if (sigDistPct > cfg.MAX_DIST_PCT) return { reject: REJECT.ZONES, reason: 'signal_level_too_far', pro, distPct, sigDistPct, setup };

  const zoneBuf = sLevel * ZONE_PCT / 100;
  const diag = { pro, setup, distPct, sigDistPct, zoneBuf };

  // ── Институциональный паттерн (иерархия A→D) ──
  const inst = P.detectInstitutionalPattern(df, sLevel, signal, volRatio, zoneBuf);

  // ── Качество подхода ──
  const approach = P.assessApproachQuality(df, sLevel, zoneBuf, pro.volMa, inst.name);
  if (!approach.ok) return { reject: REJECT.SIGNAL, reason: 'approach', ...diag, instPattern: inst.name, patternBonus: inst.bonus, approachReason: approach.reason };

  // ── Тест-счётчик ──
  const testCount = P.countRecentTests(df, sLevel, ZONE_PCT, 30);
  if (testCount >= cfg.MAX_LEVEL_TESTS) return { reject: REJECT.SIGNAL, reason: 'over_tested', ...diag, instPattern: inst.name, patternBonus: inst.bonus, approachReason: approach.reason, testCount };

  // ── Фильтр RSI ──
  if (cfg.USE_RSI_FILTER) {
    const rsiBase = { ...diag, instPattern: inst.name, patternBonus: inst.bonus, approachOk: true, approachReason: approach.reason, testCount };
    if (signal === 'LONG' && rsiNow > cfg.RSI_OB) return { reject: REJECT.RSI, reason: 'rsi_ob', ...rsiBase };
    if (signal === 'SHORT' && rsiNow < cfg.RSI_OS) return { reject: REJECT.RSI, reason: 'rsi_os', ...rsiBase };
  }

  return {
    reject: null,
    symbol,
    pro,
    zones: { sup: supZones, res: resZones },
    rawZones,
    bullPat, bearPat,
    signal, sLevel, sType, isCounter, sHits, sClass, sZone,
    zoneBuf, distPct, sigDistPct,
    instPattern: inst.name, patternBonus: inst.bonus,
    approachOk: approach.ok, approachReason: approach.reason,
    testCount,
  };
}

module.exports = {
  SETUP, TREND, SESSION, DEAD_SESSIONS,
  marketSession, prologue, findSetup, nearestLevel, analyzePart1,
};
