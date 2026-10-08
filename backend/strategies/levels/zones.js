'use strict';
/**
 * zones.js — LEVELS level (zone) detection, one-to-one with indicator.CHMIndicator:
 *
 *   fractalPivots          layer 1 — strict-window pivot highs/lows (spec §7.1)
 *   kdeLevels (common/kde) layer 2 — scipy KDE density peaks of the pivot prices (§7.2)
 *   volumeProfile (kde.js) layer 3 — 50-bin volume profile HVN/LVN (§7.3)
 *   isPsychologicalLevel   round-number rule (§7.5)
 *   classifyLevel          class 1/2/3 (§7.5)
 *   getZones               `_get_zones(df, strength, atr_now)`: clustering with the
 *                          ATR×ZONE_BUFFER buffer, `_make_zone`, hits ≥ 2 or psychological (§7.4)
 *   markHtfConfluence      `_mark_htf_confluence`: ±0.5·ATR match with HTF zones → "MTF" (§7.7)
 *   ZoneCache / preFilter  the live-path zone cache with TTL by TF and the pre-filter
 *                          shortcut (§7.6) as an optional stateful wrapper: the clock is
 *                          injected (`nowSec`), the golden path never uses it.
 *
 * A zone is a plain object with the Python dict keys in order
 *   price, hits, eff_hits, age_bars, class, is_psychological, layers, has_hvn, has_lvn_to_tp
 * plus a NON-enumerable `lvn_checker(a, b)` closure (any LVN strictly between a and b) so
 * zones can be compared/serialised exactly like the bot's `_zone_public` dumps.
 * HTF-marked copies additionally carry `mtf_label: "MTF"`, `timeframes: ["ltf","htf"]`.
 *
 * Pure: Frames (common/frame.js) or plain Float64Arrays in, plain objects out.
 */

const S = require('../common/series');
const K = require('../common/kde');
const { pyMod } = require('../common/pyround');
const { ZONE_CACHE_TTL_S, ZONE_CACHE_TTL_DEFAULT_S, ZONE_CACHE_MAX } = require('./config');

const CLASS_NAMES = Object.freeze({ 1: 'Абсолютный', 2: 'Сильный', 3: 'Рабочий' });

/** Round-number magnitudes of `_is_psychological_level`. */
const PSYCH_MAGNITUDES = Object.freeze([1, 5, 10, 25, 50, 100, 500, 1_000, 5_000, 10_000, 50_000]);

/**
 * indicator._is_psychological_level(price): for each magnitude (ascending) stop when
 * mag > price×10, skip when mag < price×0.01, True when the distance to the nearest
 * multiple is < 0.3 % of the price. price ≤ 0 → False.
 */
function isPsychologicalLevel(price) {
  if (price <= 0) return false;
  for (const mag of PSYCH_MAGNITUDES) {
    if (mag > price * 10) break;
    if (mag < price * 0.01) continue;
    const rem = pyMod(price, mag);
    if (Math.min(rem, mag - rem) / price < 0.003) return true;
  }
  return false;
}

/**
 * indicator._classify_level(price, hits, age_bars, is_psychological, confirmed_layers):
 * first match of (psych & hits ≥ 2 → 1), (psych → 2), (hits ≥ 3 & age ≤ 30 → 1),
 * (layers ≥ 3 → 1), (hits ≥ 2 & age ≤ 100 → 2), else 3. `hits` is eff_hits.
 */
function classifyLevel(price, hits, ageBars, isPsychological = false, confirmedLayers = 1) {
  if (isPsychological && hits >= 2) return 1;
  if (isPsychological) return 2;
  if (hits >= 3 && ageBars <= 30) return 1;
  if (confirmedLayers >= 3) return 1;
  if (hits >= 2 && ageBars <= 100) return 2;
  if (hits >= 2) return 3; // устаревший уровень
  return 3;
}

/**
 * Layer 1: fractal pivots over a strict ±strength window (spec §7.1). Returns
 * { res: [[price, age], ...], sup: [[price, age], ...] } in bar order, age = n−1−i.
 * Ties count: equal highs produce several points, exactly like `highs[i] == max(window)`.
 */
function fractalPivots(highs, lows, strength) {
  const n = highs.length;
  const res = [];
  const sup = [];
  for (let i = strength; i < n - strength; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - strength; j <= i + strength; j++) {
      if (highs[j] > hi) hi = highs[j];
      if (lows[j] < lo) lo = lows[j];
    }
    if (highs[i] === hi) res.push([highs[i], n - 1 - i]);
    if (lows[i] === lo) sup.push([lows[i], n - 1 - i]);
  }
  return { res, sup };
}

/** Attach the `lvn_checker` closure as a non-enumerable property (keeps zones JSON-comparable). */
function attachLvnChecker(zone, lvn) {
  Object.defineProperty(zone, 'lvn_checker', {
    value: (a, b) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = 0; i < lvn.length; i++) if (lo < lvn[i] && lvn[i] < hi) return true;
      return false;
    },
    enumerable: false, writable: true, configurable: true,
  });
  return zone;
}

/** Shallow copy of a zone keeping the non-enumerable lvn_checker (Python `dict(z)` keeps every key). */
function copyZone(z) {
  const c = { ...z };
  if (z.lvn_checker) {
    Object.defineProperty(c, 'lvn_checker', { value: z.lvn_checker, enumerable: false, writable: true, configurable: true });
  }
  return c;
}

/** The dump form of a zone (`make_golden._zone_public`): every enumerable key. */
function zonePublic(z) {
  return { ...z };
}

/**
 * indicator._get_zones(df, strength, atr_now) with cfg.ZONE_BUFFER passed explicitly.
 * `df` is a Frame ({h, l, v} Float64Arrays) or any object with those columns.
 * Returns { sup, res } (the zone lists, price ascending within each side) plus the
 * layers for diagnostics: kdePeaks, hvn, lvn, vpVolumes, pivotsRes, pivotsSup,
 * priceRange, buffer.
 */
function getZones(df, strength, atrNow, zoneBuffer) {
  const highs = df.h;
  const lows = df.l;

  // ── Слой 1: Фракталы ──
  const piv = fractalPivots(highs, lows, strength);
  const allPivotPrices = piv.res.map((p) => p[0]).concat(piv.sup.map((p) => p[0]));

  // ── Слой 2: KDE (price grid = df range, not pivot range) ──
  const priceRange = [S.seriesMin(lows), S.seriesMax(highs)];
  const kdePrices = K.kdeLevels(allPivotPrices, priceRange);

  // ── Слой 3: Volume Profile ──
  const vp = K.volumeProfile(lows, highs, df.v, 50);
  const hvn = vp.hvn;
  const lvn = vp.lvn;

  // ── ATR-буфер для кластеризации ──
  const buffer = atrNow * zoneBuffer;
  const tol = buffer * 2;

  const anyWithin = (price, arr) => {
    for (let i = 0; i < arr.length; i++) if (Math.abs(price - arr[i]) <= tol) return true;
    return false;
  };

  const makeZone = (group) => {
    // Python: sum(x[0] for x in group) / len(group) — sequential builtin sum
    let s = 0.0;
    let minAge = Infinity;
    for (let i = 0; i < group.length; i++) { s += group[i][0]; if (group[i][1] < minAge) minAge = group[i][1]; }
    const avgPrice = s / group.length;
    const hits = group.length;
    const isPsych = isPsychologicalLevel(avgPrice);
    const layers = (anyWithin(avgPrice, kdePrices) ? 1 : 0) + (anyWithin(avgPrice, hvn) ? 1 : 0);
    const effHits = hits + layers * 2; // каждый дополнительный слой даёт +2 к hits
    const lvlClass = classifyLevel(avgPrice, effHits, minAge, isPsych, layers + 1);
    const zone = {
      price: avgPrice,
      hits,
      eff_hits: effHits,
      age_bars: minAge,
      class: lvlClass,
      is_psychological: isPsych,
      layers: layers + 1, // фракталы всегда 1
      has_hvn: anyWithin(avgPrice, hvn),
      has_lvn_to_tp: false, // never set later (spec §7.4)
    };
    return attachLvnChecker(zone, lvn);
  };

  const cluster = (points) => {
    if (!points.length) return [];
    // points.sort(key=price): stable, ties keep bar order
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    const clusters = [];
    let group = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      if (p[0] - group[group.length - 1][0] <= buffer) group.push(p); // chaining: distance to the LAST appended point
      else { clusters.push(makeZone(group)); group = [p]; }
    }
    clusters.push(makeZone(group));
    // Минимум 2 касания (класс 1 может быть и с 1 касанием если психологический)
    return clusters.filter((c) => c.hits >= 2 || c.is_psychological);
  };

  const sup = cluster(piv.sup);
  const res = cluster(piv.res);
  return { sup, res, kdePeaks: kdePrices, hvn, lvn, vpVolumes: vp.volumes, pivotsRes: piv.res, pivotsSup: piv.sup, priceRange, buffer };
}

/**
 * indicator._mark_htf_confluence: every working-TF zone whose price lies within
 * 0.5·atr_now of ANY HTF zone price (sup or res) becomes a copy with
 * mtf_label="MTF", timeframes=["ltf","htf"], class=min(class, 2). No HTF zones →
 * the same lists are returned unchanged. Returns { sup, res }.
 */
function markHtfConfluence(supZones, resZones, htfSup, htfRes, atrNow) {
  const htfPrices = htfSup.concat(htfRes).map((z) => z.price);
  if (!htfPrices.length) return { sup: supZones, res: resZones };
  const tol = atrNow * 0.5;
  const mark = (zones) => zones.map((z) => {
    let near = false;
    for (let i = 0; i < htfPrices.length; i++) if (Math.abs(z.price - htfPrices[i]) <= tol) { near = true; break; }
    if (!near) return z;
    const c = copyZone(z);
    c.mtf_label = 'MTF';
    c.timeframes = ['ltf', 'htf'];
    c.class = Math.min(z.class == null ? 3 : z.class, 2);
    return c;
  });
  return { sup: mark(supZones), res: mark(resZones) };
}

/**
 * HTF zones for `_mark_htf_confluence`: `_get_zones(df_htf, PIVOT_STRENGTH, atr_now)` with
 * the WORKING-TF atr_now (QUIRK(spec §7.7): the daily frame is clustered with the 1h ATR).
 * `cache` (optional Map) mirrors `_htf_zone_cache`: key (len, last open_time) per symbol.
 */
function htfZones(dfHtf, strength, atrNow, zoneBuffer, cache = null, symbol = '') {
  const key = `${dfHtf.length}_${dfHtf.t ? dfHtf.t[dfHtf.length - 1] : ''}`;
  if (cache) {
    const hit = cache.get(symbol);
    if (hit && hit.key === key) return { sup: hit.sup, res: hit.res };
  }
  const z = getZones(dfHtf, strength, atrNow, zoneBuffer);
  if (cache) {
    if (cache.size >= ZONE_CACHE_MAX) cache.clear();
    cache.set(symbol, { key, sup: z.sup, res: z.res });
  }
  return { sup: z.sup, res: z.res };
}

/** Zone-cache TTL for a TIMEFRAME string (spec §7.6). */
function zoneCacheTtl(timeframe) {
  const ttl = ZONE_CACHE_TTL_S[timeframe];
  return ttl === undefined ? ZONE_CACHE_TTL_DEFAULT_S : ttl;
}

/**
 * The cached-zones pre-filter of _do_analyze: True when the price is farther than
 * 2×MAX_DIST_PCT from EVERY cached zone (→ `zones` reject without recomputing).
 * Empty zone lists → False (the regular "no zones" path handles them).
 */
function preFilterSkip(supZones, resZones, cNow, maxDistPct) {
  const all = supZones.concat(resZones);
  if (!all.length) return false;
  let minDist = Infinity;
  for (let i = 0; i < all.length; i++) {
    const d = Math.abs(cNow - all[i].price) / cNow;
    if (d < minDist) minDist = d;
  }
  return minDist > maxDistPct / 100 * 2;
}

/**
 * Per-indicator zone cache of the live path (`_zone_cache`): symbol → {ts, sup, res}.
 * The clock is injected (`nowSec`) so the wrapper stays deterministic; eviction order
 * = TTL-expired first, then the oldest entry, once the cache exceeds `max` symbols.
 */
class ZoneCache {
  constructor({ max = ZONE_CACHE_MAX } = {}) {
    this.max = max;
    this.map = new Map();
  }

  /** Fresh entry or null. */
  lookup(symbol, nowSec, ttlSec) {
    const e = this.map.get(symbol);
    if (e && nowSec - e.ts < ttlSec) return e;
    return null;
  }

  store(symbol, nowSec, sup, res, ttlSec) {
    this.map.set(symbol, { ts: nowSec, sup, res });
    if (this.map.size > this.max) {
      for (const [k, v] of this.map) if (nowSec - v.ts > ttlSec) this.map.delete(k);
      if (this.map.size > this.max) {
        let oldestK = null;
        let oldestTs = Infinity;
        for (const [k, v] of this.map) if (v.ts < oldestTs) { oldestTs = v.ts; oldestK = k; }
        if (oldestK !== null) this.map.delete(oldestK);
      }
    }
  }
}

module.exports = {
  CLASS_NAMES, PSYCH_MAGNITUDES,
  isPsychologicalLevel, classifyLevel, fractalPivots, getZones, markHtfConfluence, htfZones,
  attachLvnChecker, copyZone, zonePublic,
  zoneCacheTtl, preFilterSkip, ZoneCache,
};
