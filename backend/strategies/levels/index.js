'use strict';
/**
 * index.js — the LEVELS engine (indicator.CHMIndicator), pure.
 *
 *   doAnalyze(symbol, df, dfHtf, dfBtc, dfEth, cfg, opts)
 *       `_do_analyze` end to end: part 1 (setups.analyzePart1: indicators, zones, nearest
 *       level, volume gate, setup search, institutional pattern, approach, tests, RSI) then
 *       part 2 (this file): stops.js → targets.js → context.js → quality.js → checklist →
 *       quality override → highWr.js → explain.js → filters.js → result.js.
 *       Returns { signal: SignalResult | null, rejectReason: bucket | null, stage }.
 *   analyze(symbol, df, dfHtf, dfBtc, dfEth, cfg, opts)
 *       `analyze()`: length guard, cooldown (opts.cooldown = CooldownState), _do_analyze,
 *       ATR-breakout fallback in relaxed mode. rejectReason "none" for the prologue guards.
 *   analyzeOnDemand(...)      `analyze_on_demand`: ≥ 50 bars, min_quality_override = 1, no cooldown.
 *   CooldownState             `_last_signal` + mark_signal / bars_since_signal (cap 500 symbols).
 *   createIndicator(cfg, opts) a CHMIndicator-like object (cfg, cooldown, HTF zone cache, stats).
 *   scannerPostSteps(sig, df, minQuality)
 *       the scanner's pure post-steps recorded in the fixtures: squeeze_score,
 *       quality_after_squeeze (+1 cap 10 when squeeze ≥ 1), passes_min_quality.
 *
 * Live state that the bot keeps on the instance / in modules (zone cache keyed on
 * time.time(), momentum relaxed mode, cached BTC regime, env gates, SL-V2 flag) is
 * injected through `opts`:
 *   { relaxed = false, regime = null, env = LEVELS_ENV, slV2Enabled = env.SL_V2_LEVELS_ENABLED,
 *     relax = env.LEVELS_RELAX_ENABLED, minQualityOverride = null, precomputedZones = null,
 *     zoneCache = null (zones.ZoneCache: the live `_zone_cache`, keyed on `nowSec`),
 *     htfZoneCache = null, cacheMax = 350, cooldown = null, nowSec = 0, breakoutState = null,
 *     triggerReason = '' }
 */

const config = require('./config');
const zones = require('./zones');
const patterns = require('./patterns');
const setups = require('./setups');
const stops = require('./stops');
const targets = require('./targets');
const context = require('./context');
const quality = require('./quality');
const highWr = require('./highWr');
const explain = require('./explain');
const filters = require('./filters');
const stars = require('./stars');
const atrBreakout = require('./atrBreakout');
const result = require('./result');
const squeeze = require('../common/squeeze');
const { levelsRegimeMultiplier } = require('../common/marketRegime');
const { pyMax, pyRoundInt } = require('../common/pyround');

const { REJECT, LEVELS_ENV, minBars, ZONE_CACHE_MAX } = config;
const { ZoneCache } = zones;
const { signalResult } = result;

/** `_last_signal` of a CHMIndicator instance: symbol → open_time ms of the last delivered signal bar. */
class CooldownState {
  constructor({ max = 500 } = {}) {
    this.map = new Map();
    this.max = max;
  }

  /** mark_signal(symbol, df): store df.index[-1]; above `max` symbols evict the oldest timestamp. */
  markSignal(symbol, df) {
    if (!df || !df.length) return;
    this.map.set(symbol, df.t[df.length - 1]);
    if (this.map.size > this.max) {
      let oldestK = null;
      let oldestV = Infinity;
      for (const [k, v] of this.map) if (v < oldestV) { oldestV = v; oldestK = k; }
      if (oldestK !== null) this.map.delete(oldestK);
    }
  }

  /**
   * bars_since_signal(symbol, df): int(round((index[-1] − last) / (index[-1] − index[-2]))),
   * 1_000_000 when unknown. Python round() is half-to-EVEN: after a missing bar the step is
   * 2 bars and 5 h / 2 h = 2.5 → 2 (Math.round would give 3 and end a 3-bar cooldown early).
   * A non-finite ratio raises in Python and is swallowed → 1_000_000.
   */
  barsSinceSignal(symbol, df) {
    const last = this.map.get(symbol);
    if (last === undefined || !df || df.length < 2) return 1_000_000;
    const n = df.length;
    const step = df.t[n - 1] - df.t[n - 2];
    if (!step) return 1_000_000;
    const ratio = (df.t[n - 1] - last) / step;
    return Number.isFinite(ratio) ? pyRoundInt(ratio) : 1_000_000;
  }
}

function resolveOpts(opts) {
  const env = opts.env || LEVELS_ENV;
  return {
    env,
    relaxed: Boolean(opts.relaxed),
    regime: opts.regime === undefined ? null : opts.regime,
    slV2Enabled: opts.slV2Enabled === undefined ? Boolean(env.SL_V2_LEVELS_ENABLED) : Boolean(opts.slV2Enabled),
    relax: opts.relax === undefined ? Boolean(env.LEVELS_RELAX_ENABLED) : Boolean(opts.relax),
    minQualityOverride: opts.minQualityOverride === undefined ? null : opts.minQualityOverride,
    precomputedZones: opts.precomputedZones || null,
    zoneCache: opts.zoneCache || null,
    htfZoneCache: opts.htfZoneCache || null,
    cacheMax: opts.cacheMax === undefined || opts.cacheMax === null ? ZONE_CACHE_MAX : opts.cacheMax,
    cooldown: opts.cooldown || null,
    nowSec: opts.nowSec || 0,
    breakoutState: opts.breakoutState || null,
    triggerReason: opts.triggerReason || '',
  };
}

/**
 * `_do_analyze(symbol, df, df_htf, df_btc, df_eth, min_quality_override, _precomputed_zones)`.
 * No length guard here (the bot's backtest / analyze_on_demand call it with shorter frames).
 */
function doAnalyze(symbol, df, dfHtf, dfBtc, dfEth, cfg, opts = {}) {
  const o = resolveOpts(opts);
  const none = (reject, stage, extra) => ({ signal: null, rejectReason: reject, stage, ...(extra || {}) });

  // ── Part 1: indicators, zones, setup, pattern, approach, tests, RSI ──
  const p1 = setups.analyzePart1(symbol, df, dfHtf, cfg, {
    relax: o.relax, precomputedZones: o.precomputedZones, zoneCache: o.zoneCache, nowSec: o.nowSec,
    htfZoneCache: o.htfZoneCache, cacheMax: o.cacheMax, symbolForCache: symbol, skipGuard: true,
  });
  if (p1.reject) return none(p1.reject, 'part1', { reason: p1.reason, part1: p1 });

  const { pro, signal, sLevel, sType, isCounter, sHits, sClass, sZone, zoneBuf, instPattern, patternBonus,
    approachOk, approachReason, testCount, bullPat, bearPat } = p1;
  const supZones = p1.zones.sup;
  const resZones = p1.zones.res;
  const { cNow, atrNow, rsiNow, volRatio, rsi, bullLocal, bearLocal, trendLocal, session, isDeadSession } = pro;

  // ══ СТОП-ЛОСС (структурный) + ФИЛЬТР СТОПА ══
  const [regimeMult] = levelsRegimeMultiplier(o.regime);
  const entry = cNow;
  const st = stops.computeStop(symbol, signal, entry, sLevel, zoneBuf, atrNow, cfg, supZones, resZones, { regimeMult, slV2Enabled: o.slV2Enabled });
  if (st.reject) return none(st.reject, 'stop', { reason: st.reason, part1: p1, stop: st });
  const { sl, risk, memcoin } = st;

  // ══ ЦЕЛИ (структурные TP → fallback на механический RR) ══
  const stp = targets.findTpLevels(signal, entry, supZones, resZones);
  const scale = targets.tpScale(atrNow, cNow);
  const tg = { ...targets.assembleTargets(signal, entry, risk, stp, cfg, scale), structural: stp };
  if (tg.reject) return none(tg.reject, 'tp_order', { reason: tg.reason, part1: p1, stop: st, targets: tg });
  let { tp1, tp2, tp3 } = tg;

  // ── Проверка R:R (ослабляется в Relaxed Mode) ──
  const rrActual = targets.rrActual(signal, entry, tp1, risk);
  const effectiveMinRr = targets.effectiveMinRr(cfg.MIN_RR, o.relaxed);
  if (rrActual < effectiveMinRr) return none(REJECT.RR, 'rr_actual', { reason: 'rr_actual', part1: p1, stop: st, targets: tg, rrActual });

  const riskPct = Math.abs((sl - entry) / entry * 100);

  // ── R:R score ──
  const rrScore = targets.calculateRrScore(signal, entry, sl, tp1, tp2, tp3);
  if (rrScore < cfg.MIN_RR * 0.5) return none(REJECT.RR, 'rr_score', { reason: 'rr_score_half_min_rr', part1: p1, stop: st, targets: tg, rrActual, rrScore });

  // ── Корреляция / RSI дивергенция / LVN на пути к TP ──
  const corrData = context.btcEthCorrelation(df, dfBtc, dfEth);
  const [divergOk, divergLabel] = context.divergenceCheck(df, rsi, signal);
  const hasLvnPath = context.lvnPath(sZone, entry, tp1);
  const htfOk = cfg.USE_HTF_FILTER ? context.htfConfluence(dfHtf, signal, cfg.HTF_EMA_PERIOD) : false;

  // ══ СИСТЕМА QUALITY (0–10) ══
  const q = quality.accumulateQuality({
    sType, instPattern, patternBonus, sClass, htfOk, sZone, isCounter, volRatio, volMult: cfg.VOL_MULT,
    hasLvnPath, divergOk, divergLabel, approachOk, approachReason, signal, rsiNow, corr: corrData,
    testCount, isDeadSession, session, rrScore, memcoin,
  });
  const diag = { part1: p1, stop: st, targets: tg, rrActual, effectiveMinRr, riskPct, rrScore, corrData, divergOk, divergLabel, hasLvnPath, htfOk, quality: q };
  if (q.reject) return none(q.reject, 'rr_score_1.2', { reason: q.reason, ...diag });
  let qualityScore = q.quality;
  const reasons = q.reasons;

  // ── Финальный чеклист ──
  const hasPattern = Boolean(signal === 'LONG' ? bullPat : bearPat);
  const chk = quality.finalChecklist({ approachOk, hasPattern, sType, volRatio, rrActual, effectiveMinRr, testCount, maxLevelTests: cfg.MAX_LEVEL_TESTS });
  diag.checklist = chk.items;
  if (!chk.ok) return none(REJECT.CHECKLIST, 'checklist', { reason: 'checklist', ...diag });

  // ── Quality фильтр (analyze_on_demand → min_quality_override=1) ──
  if (o.minQualityOverride !== null && qualityScore < o.minQualityOverride) {
    return none(REJECT.QUALITY_HWR, 'quality_override', { reason: 'quality_override', ...diag });
  }

  // ── High-WR Mode фильтры ──
  if (cfg.HIGH_WR_MODE) {
    const hw = highWr.applyHighWr({ signal, isCounter, quality: qualityScore, df, entry, risk, tp1, tp2, tp3, bullLocal, bearLocal });
    diag.highWr = hw;
    if (hw.reject) return none(hw.reject, 'high_wr', { reason: hw.reason, ...diag });
    tp1 = hw.tp1; tp2 = hw.tp2; tp3 = hw.tp3;
  }

  // ── human_explanation ──
  const rr1Val = signal === 'LONG' ? (tp1 - entry) / risk : (entry - tp1) / risk;
  const rr2Val = signal === 'LONG' ? (tp2 - entry) / risk : (entry - tp2) / risk;
  const explanation = explain.buildHumanExplanation(
    signal, sLevel, sClass, sHits, sType, entry, sl, tp1, tp2, rr1Val, rr2Val, riskPct, session, corrData.label, divergLabel,
  );
  diag.final = { tp1, tp2, tp3, riskPct, rr1Val, rr2Val, explanation, effectiveMinRr };

  // ── [LEVELS-FILTERS] regime / vol / confirm (fail-open) ──
  let shadowFilters = [];
  if (filters.gatesActive(o.env)) {
    try {
      const [enf, shadow] = filters.evaluate(df, signal, sLevel, entry, atrNow, {
        regimeMode: o.env.LEVELS_REGIME_GATE === undefined ? 'off' : o.env.LEVELS_REGIME_GATE,
        volMode: o.env.LEVELS_VOL_GATE === undefined ? 'off' : o.env.LEVELS_VOL_GATE,
        volMaxAtrPct: o.env.LEVELS_MAX_ATR_PCT === undefined ? 2.5 : o.env.LEVELS_MAX_ATR_PCT,
        confirmMode: o.env.LEVELS_ENTRY_CONFIRM === undefined ? 'off' : o.env.LEVELS_ENTRY_CONFIRM,
        tf: cfg.TIMEFRAME === undefined ? null : cfg.TIMEFRAME,
      });
      shadowFilters = shadow;
      if (enf) return none(REJECT.LEVELS_FILTER, 'levels_filter', { reason: `filter_${enf}`, shadowFilters, ...diag });
    } catch (_e) {
      // fail-open
    }
  }

  const sig = signalResult({
    symbol,
    direction: signal,
    entry,
    sl,
    tp1,
    tp2,
    tp3,
    risk_pct: riskPct,
    quality: qualityScore,
    reasons,
    rsi: rsiNow,
    volume_ratio: volRatio,
    trend_local: trendLocal,
    trend_htf: '',
    pattern: instPattern,
    breakout_type: sType,
    is_counter_trend: isCounter,
    human_explanation: explanation,
    level_class: sClass,
    test_count: testCount,
    rr_score: rrScore,
    corr_label: corrData.label,
    session,
  });
  return { signal: sig, rejectReason: null, stage: 'signal', shadowFilters, ...diag };
}

/**
 * `analyze(symbol, df, df_htf, df_btc, df_eth)`: too short / cooldown → null without a
 * bucket (rejectReason "none"); then _do_analyze; in relaxed mode a null result falls back
 * to the ATR-breakout detector.
 */
function analyze(symbol, df, dfHtf, dfBtc, dfEth, cfg, opts = {}) {
  const o = resolveOpts(opts);
  if (!df || df.length < minBars(cfg)) return { signal: null, rejectReason: REJECT.NONE, stage: 'too_short' };
  if (o.cooldown && o.cooldown.barsSinceSignal(symbol, df) < cfg.COOLDOWN_BARS) {
    return { signal: null, rejectReason: REJECT.NONE, stage: 'cooldown' };
  }
  const res = doAnalyze(symbol, df, dfHtf, dfBtc, dfEth, cfg, { ...opts, minQualityOverride: null });
  if (res.signal === null && o.relaxed) {
    const br = atrBreakout.detectAtrBreakout(symbol, df, { nowSec: o.nowSec, lastAlert: o.breakoutState });
    if (br) return { ...res, signal: atrBreakout.breakoutSignal(symbol, br, o.triggerReason), stage: 'atr_breakout', breakout: br };
  }
  return res;
}

/** `analyze_on_demand`: ≥ 50 bars, no cooldown, min_quality_override = 1. */
function analyzeOnDemand(symbol, df, dfHtf, dfBtc, dfEth, cfg, opts = {}) {
  if (!df || df.length < 50) return { signal: null, rejectReason: REJECT.NONE, stage: 'too_short' };
  return doAnalyze(symbol, df, dfHtf, dfBtc, dfEth, cfg, { ...opts, minQualityOverride: 1 });
}

/**
 * A CHMIndicator-like stateful wrapper: holds cfg, the cooldown map (`_last_signal`), the live
 * zone cache (`_zone_cache`, TTL by cfg.TIMEFRAME, pre-filter), the HTF zone cache and the
 * per-instance reject counters (`_ANALYZE_STATS` is module-global in the bot; here one map per
 * indicator, reset by `resetAnalyzeStats()` at job boundaries like the scanner does).
 *
 * opts (besides the analyze() opts):
 *   clock     () → seconds; the zone-cache clock when a call passes no `nowSec` (default wall
 *             clock, like the bot's time.time()); a call's `extra.nowSec` always wins
 *   zoneCache false → no live zone cache (zones recomputed on every call)
 *   cacheMax  `_ZONE_CACHE_MAX` of both zone caches (default 350)
 * The ATR-breakout cooldown map is module-global in the bot (`_last_breakout_alert`): pass the
 * same `breakoutState` Map to every indicator that should share it.
 */
function createIndicator(cfg, opts = {}) {
  const cacheMax = opts.cacheMax === undefined || opts.cacheMax === null ? ZONE_CACHE_MAX : opts.cacheMax;
  const cooldown = new CooldownState();
  const htfZoneCache = new Map();
  const zoneCache = opts.zoneCache === false ? null : new ZoneCache({ max: cacheMax });
  const clock = typeof opts.clock === 'function' ? opts.clock : () => Date.now() / 1000;
  const stats = new Map();
  // `_none_stat` fires inside _do_analyze, so the bucket is counted even when the relaxed-mode
  // ATR-breakout fallback then returns a signal (rejectReason stays set on that result; a regular
  // signal has rejectReason null)
  const bump = (res) => {
    if (res.rejectReason && res.rejectReason !== REJECT.NONE) stats.set(res.rejectReason, (stats.get(res.rejectReason) || 0) + 1);
    return res;
  };
  const base = { ...opts, cooldown, htfZoneCache, zoneCache, cacheMax };
  const withClock = (extra) => ({ ...base, ...extra, nowSec: extra && extra.nowSec !== undefined ? extra.nowSec : clock() });
  return {
    cfg,
    cooldown,
    htfZoneCache,
    zoneCache,
    analyze: (symbol, df, dfHtf = null, dfBtc = null, dfEth = null, extra = {}) => bump(analyze(symbol, df, dfHtf, dfBtc, dfEth, cfg, withClock(extra))),
    analyzeOnDemand: (symbol, df, dfHtf = null, dfBtc = null, dfEth = null, extra = {}) => bump(analyzeOnDemand(symbol, df, dfHtf, dfBtc, dfEth, cfg, withClock(extra))),
    markSignal: (symbol, df) => cooldown.markSignal(symbol, df),
    barsSinceSignal: (symbol, df) => cooldown.barsSinceSignal(symbol, df),
    getAnalyzeStats: () => Object.fromEntries(stats),
    resetAnalyzeStats: () => stats.clear(),
  };
}

/**
 * scanner_mid pure post-steps on a SignalResult (FIXTURES.md LEVELS):
 *   squeeze_score = compute_squeeze_score(df); quality_after_squeeze = min(quality + 1, 10) if ≥ 1
 *   passes_min_quality = quality_after_squeeze ≥ minQuality (profile / user min_quality;
 *   momentum relaxed mode lowers it to max(2, min_quality − 1) — pass `relaxed`).
 */
function scannerPostSteps(sig, df, minQuality, { relaxed = false } = {}) {
  const sq = squeeze.computeSqueezeScore(df);
  const qualityAfter = sq >= 1 ? Math.min(sig.quality + 1, 10) : sig.quality;
  const effMinQ = relaxMinQuality(minQuality, relaxed);
  return { squeeze_score: sq, quality_after_squeeze: qualityAfter, passes_min_quality: qualityAfter >= effMinQ };
}

/** momentum_detector.relax_min_quality */
function relaxMinQuality(original, relaxed = false) {
  return relaxed ? pyMax(2, original - 1) : original;
}

module.exports = {
  ...config,
  ...zones,
  ...patterns,
  ...setups,
  ...stops,
  ...targets,
  ...context,
  ...quality,
  ...highWr,
  ...explain,
  ...filters,
  ...stars,
  ...atrBreakout,
  ...result,
  config, zones, patterns, setups, stops, targets, context, quality, highWr, explain, filters, stars, atrBreakout, result,
  CooldownState, doAnalyze, analyze, analyzeOnDemand, createIndicator, scannerPostSteps, relaxMinQuality,
};
