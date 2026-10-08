'use strict';
/**
 * signal.js — VOLUME signal evaluation on one bar (volume_strategy.signal_at /
 * _signal_at, nearest_structure, effective_atr, VolumeSignal; spec §6).
 *
 *   pre-checks → per direction (LONG first, then SHORT): F1 RSI bound, F2 over-extension,
 *   F3 climax volume, F4 EMA-trend filter, F5 HTF side → detectors (golden, bounce, ribbon,
 *   cross, turn) → quality 1..5 → main hit (highest quality, then priority) → min_quality
 *   → best direction (strictly higher quality wins → LONG wins ties) → stop placement
 *   (effective ATR, bounce/ribbon anchor or nearest structure, ceiling, floor, max %)
 *   → TP ladder → reasons → VolumeSignal.
 */

const S = require('../common/series');
const { fmtFixed } = require('../common/pyfmt');
const { pyRound } = require('../common/pyround');
const { minBars, SL_RECENT_BARS, CLIMAX_MOVE_ATR } = require('./config');
const { DETECTORS, DETECTOR_ORDER, PRIORITY, FAMILY, isF, sliceMin, sliceMax } = require('./detectors');

/**
 * [VOL-SL-STRUCT 2026-10] Nearest local extreme against the position: LONG → last pivot
 * low (l[j] ≤ both neighbours) inside `lookback`, SHORT → pivot high; the signal bar and
 * the previous one always count. Without a pivot → the window extreme.
 */
function nearestStructure(h, l, i, s, lookback) {
  const lo = Math.max(1, i - lookback);
  // base = np.min(l[max(0, i−1):i+1]) (LONG) / np.max(h[...]) (SHORT) — signal + previous bar
  const base = s > 0 ? sliceMin(l, Math.max(0, i - 1), i + 1) : sliceMax(h, Math.max(0, i - 1), i + 1);
  for (let j = i - 1; j >= lo; j--) {
    if (s > 0) {
      if (l[j] <= l[j - 1] && l[j] <= l[j + 1]) return Math.min(base, l[j]);     // nearest pivot low
    } else if (h[j] >= h[j - 1] && h[j] >= h[j + 1]) {
      return Math.max(base, h[j]);                                                  // nearest pivot high
    }
  }
  const ext = s > 0 ? sliceMin(l, lo, i + 1) : sliceMax(h, lo, i + 1);             // no pivot: window extreme
  return s > 0 ? Math.min(base, ext) : Math.max(base, ext);
}

/**
 * [VOL-SL-VOLATILITY 2026-10] Stop volatility: max(ATR, mean TR of the last `recent`
 * bars incl. the signal bar); the ATR alone when that mean is not finite or ≤ 0.
 */
function effectiveAtr(atr, tr, i, recent = SL_RECENT_BARS) {
  const lo = Math.max(0, i - recent + 1);
  const fresh = S.seriesMean(tr.subarray(lo, i + 1));        // np.nanmean (NaN skipped, all-NaN → NaN)
  if (Number.isFinite(fresh) && fresh > 0) return Math.max(atr, fresh);
  return atr;
}

/** Python `max(a, b)` on floats: returns a unless b > a (NaN-propagating on the first arg). */
function pyMax(a, b) {
  return b > a ? b : a;
}

class VolumeSignal {
  constructor(fields) {
    Object.assign(this, fields);
  }

  /** Compatibility with code expecting `.tp` (like the old signals). */
  get tp() { return this.tp1; }

  get volume_ratio() { return this.vol_ratio; }

  /** SL distance % (like sig.risk_pct of LEVELS — NOT % of the balance). */
  get risk_pct() {
    if (this.entry <= 0) return 0.0;
    return Math.abs(this.entry - this.sl) / this.entry * 100;
  }

  /** dataclasses.asdict(): the 33 dataclass fields in declaration order (copies of the lists). */
  toDict() {
    const d = {};
    for (const k of SIGNAL_FIELDS) d[k] = Array.isArray(this[k]) ? this[k].slice() : this[k];
    return d;
  }
}

/** VolumeSignal dataclass fields in declaration order. */
const SIGNAL_FIELDS = Object.freeze([
  'symbol', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'rr', 'quality', 'signal_type', 'rsi', 'vol_ratio',
  'ema_fast', 'ema_slow', 'ema_trend', 'atr', 'timeframe', 'is_counter_trend', 'reasons', 'setup', 'ma_label',
  'ma_value', 'ma_slow', 'ema_mid', 'aligned', 'squeeze', 'alignment', 'htf_tf', 'htf_state', 'confluence',
  'pattern', 'ma_names', 'ema_names',
]);

/** Quality of one hit in its direction context (the `_q` closure of _signal_at). */
function qualityOf(h, { aligned, rsiOk, hs, s, families, trendOk }) {
  let q = 2 + h.strength;
  q += aligned ? 1 : 0;
  q += h.vol_bonus ? 1 : 0;
  q += rsiOk ? 1 : 0;
  q += hs === 2 * s ? 1 : 0;
  q += families > 1 ? 1 : 0;
  q -= trendOk ? 0 : 1;
  return Math.max(1, Math.min(5, q));
}

/**
 * Best direction: strictly higher quality replaces the current best, so at equal quality
 * the direction evaluated first (LONG) wins. `cands` are in evaluation order.
 */
function pickBest(cands) {
  let best = null;
  for (const cand of cands) {
    if (cand === null || cand === undefined) continue;
    if (best === null || cand.quality > best.quality) best = cand;
  }
  return best;
}

/** Evaluate one direction on bar i (filters, detectors, quality, min_quality) → candidate or null. */
function evaluateDirection(ctx, i, s, enabled, hs, vr, rNow, c, a, maM) {
  const cfg = ctx.cfg;
  // ── common filters ──
  if (s > 0 && rNow >= cfg.rsi_long_max) return null;                                       // F1
  if (s < 0 && rNow <= cfg.rsi_short_min) return null;
  if (s * (c - maM) > cfg.extension_atr * a) return null;                                   // F2
  if (i >= 5 && vr >= cfg.climax_mult && s * (c - ctx.c[i - 5]) >= CLIMAX_MOVE_ATR * a) return null; // F3 climax after a move — exhaustion
  const trendOk = s * (c - ctx.e200[i]) > 0;
  if (cfg.trend_filter && !trendOk) return null;                                            // F4
  if (hs !== 0 && Math.sign(hs) !== s) return null;                                         // F5
  const hits = [];
  for (const key of DETECTOR_ORDER) {
    if (enabled.includes(key)) {
      const h = DETECTORS[key](ctx, i, s);
      if (h !== null) hits.push(h);
    }
  }
  if (!hits.length) return null;

  const aligned = isF(ctx.maF[i]) && isF(ctx.maS[i])
    && s * (ctx.maF[i] - maM) > 0 && s * (maM - ctx.maS[i]) > 0;
  const rsiOk = s > 0 ? (40 <= rNow && rNow <= 65) : (35 <= rNow && rNow <= 60);
  const families = new Set(hits.map((x) => FAMILY[x.key] || x.key)).size;
  const qctx = { aligned, rsiOk, hs, s, families, trendOk };
  // main = sorted(hits, key=(−q, priority))[0]
  let main = hits[0], mainQ = qualityOf(hits[0], qctx);
  for (let k = 1; k < hits.length; k++) {
    const q = qualityOf(hits[k], qctx);
    if (q > mainQ || (q === mainQ && PRIORITY[hits[k].key] < PRIORITY[main.key])) { main = hits[k]; mainQ = q; }
  }
  if (mainQ < cfg.min_quality) return null;
  return { s, quality: mainQ, main, hits, aligned, rsiOk, trendOk };
}

/** `_signal_at`: signal at the close of bar i (negative i counts from the end) or null. */
function signalAt(ctx, i, symbol = '', timeframe = '') {
  const cfg = ctx.cfg;
  if (i < 0) i += ctx.n;
  if (i < minBars(cfg) - 1 || i >= ctx.n) return null;
  const enabled = cfg.setupsEnabled();
  if (!enabled.length) return null;
  const c = ctx.c[i];
  const a = ctx.atr[i];
  const va = ctx.vavg[i];
  if (!(isF(c) && isF(a) && isF(va)) || c <= 0 || a <= 0 || va <= 0) return null;
  const vr = ctx.vr[i];
  const rNow = ctx.rsi[i];
  const maM = ctx.maM[i];
  if (!isF(maM)) return null;
  const hs = (cfg.use_htf && ctx.htf !== null && ctx.htf !== undefined) ? ctx.htf[i] : 0;

  const best = pickBest([
    evaluateDirection(ctx, i, 1, enabled, hs, vr, rNow, c, a, maM),
    evaluateDirection(ctx, i, -1, enabled, hs, vr, rNow, c, a, maM),
  ]);
  if (best === null) return null;
  const { s, quality, main, hits, aligned, rsiOk, trendOk } = best;
  const direction = s > 0 ? 'LONG' : 'SHORT';

  // ── SL / TP ──
  // [VOL-SL-VOLATILITY] stop distance from the "effective" volatility
  const aSl = effectiveAtr(a, ctx.tr, i);
  const buf = cfg.sl_buffer_atr * aSl;
  let risk;
  if (main.key === 'bounce' || main.key === 'ribbon') {
    const ext = s > 0 ? ctx.l[i] : ctx.h[i];
    const anchor = s > 0 ? Math.min(ext, main.sl_anchor) : Math.max(ext, main.sl_anchor);
    const structSl = anchor - s * buf;
    risk = s * (c - structSl);
    if (risk > cfg.sl_atr_mult * aSl) return null;             // bounce with a huge wick — bad R
  } else {
    // [VOL-SL-STRUCT 2026-10] anchor = nearest pivot against the position; beyond the ceiling → skip
    const structSl = nearestStructure(ctx.h, ctx.l, i, s, cfg.swing_lookback) - s * buf;
    risk = s * (c - structSl);
    if (risk > cfg.sl_atr_mult * aSl) return null;
  }
  risk = pyMax(risk, 0.8 * aSl);
  if (risk <= 0 || risk / c * 100 > cfg.max_sl_pct) return null;
  const sl = c - s * risk;
  const tp1 = c + s * risk * cfg.tp1_rr;
  const tp2 = c + s * risk * cfg.tp2_rr;
  const tp3 = c + s * risk * cfg.tp3_rr;
  if (sl <= 0 || Math.min(tp1, tp2, tp3) <= 0) return null;

  // ── reasons (short, Russian) ──
  const p = cfg.maPrefix();
  const reasons = main.reasons.slice();
  reasons.push(`объём ×${fmtFixed(vr, 1)} от среднего`);
  let alignment = '';
  if (aligned) {
    const op = s > 0 ? '>' : '<';
    alignment = `${p}${cfg.ma_fast} ${op} ${p}${cfg.ma_mid} ${op} ${p}${cfg.ma_slow}`;
    reasons.push(`MA выстроены: ${alignment}`);
  }
  if (rsiOk) reasons.push(`RSI ${fmtFixed(rNow, 0)} — здоровая зона`);
  const htfTf = hs !== 0 ? ctx.htfTf : '';
  if (hs === 2 * s) reasons.push(`старший ТФ ${htfTf || 'HTF'}: по тренду EMA${cfg.htf_ema}`);
  const others = hits.filter((h) => h !== main).map((h) => h.label);
  if (others.length) reasons.push('совпадение: ' + others.join(', '));
  if (!trendOk) reasons.push(`против EMA${cfg.ema_trend}`);

  return new VolumeSignal({
    symbol, direction, entry: c, sl, tp1, tp2, tp3,
    rr: pyRound(cfg.tp2_rr, 2), quality,
    signal_type: main.label, rsi: pyRound(rNow, 1),
    vol_ratio: pyRound(vr, 2), ema_fast: ctx.maF[i], ema_slow: maM,
    ema_trend: ctx.e200[i], atr: a, timeframe,
    is_counter_trend: !trendOk, reasons,
    setup: main.key, ma_label: main.ma_label, ma_value: main.ma_value,
    ma_slow: ctx.maS[i], ema_mid: ctx.e50[i],
    aligned: Boolean(aligned), squeeze: 0, alignment,
    htf_tf: htfTf, htf_state: hs,
    confluence: others, pattern: main.pattern !== undefined ? main.pattern : '',
    ma_names: `${p} ${cfg.ma_fast}/${cfg.ma_mid}/${cfg.ma_slow}`,
    ema_names: `EMA ${cfg.ema_mid}/${cfg.ema_trend}`,
  });
}

module.exports = {
  VolumeSignal, SIGNAL_FIELDS, nearestStructure, effectiveAtr, qualityOf, pickBest, evaluateDirection, signalAt,
};
