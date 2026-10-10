'use strict';
/**
 * detectors.js — the five VOLUME setups (volume_strategy._setup_cross/_setup_turn/
 * _setup_bounce/_setup_golden/_setup_ribbon + _rejection / _ribbon_order; spec §7).
 *
 * Every detector takes (ctx, i, s) with s = +1 LONG / −1 SHORT and returns a hit
 * {key, label, ma_label, ma_value, strength, vol_bonus, reasons[, pattern][, sl_anchor]}
 * or null. Russian strings are copied verbatim from the bot.
 */

const S = require('../common/series');
const { fmtFixed } = require('../common/pyfmt');
const { RIBBON_SPANS, RIBBON_LOOKBACK, RIBBON_MIN_ORDER, BOUNCE_LOOKBACK } = require('./config');
const { goldenVolMin } = require('./quality');
const { pyMax } = require('../common/pyround');   // builtin max()/min(): a NaN 2nd argument is ignored

/** `_f(x)`: not None and finite. */
function isF(x) {
  return x !== null && x !== undefined && Number.isFinite(x);
}

/** np.min / np.max of a slice (NaN propagates like numpy). */
function sliceMin(a, lo, hi) {
  let m = Infinity;
  for (let j = lo; j < hi; j++) { const v = a[j]; if (v !== v) return Number.NaN; if (v < m) m = v; }
  return m;
}
function sliceMax(a, lo, hi) {
  let m = -Infinity;
  for (let j = lo; j < hi; j++) { const v = a[j]; if (v !== v) return Number.NaN; if (v > m) m = v; }
  return m;
}

// ── MA Cross ────────────────────────────────────────────────────────────────

function setupCross(ctx, i, s) {
  const cfg = ctx.cfg;
  const lb = cfg.cross_lookback;
  if (i - lb < 0) return null;
  // d = s·(maF − maM) over the last lb+1 bars: all finite, > 0 now, ≤ 0 at least once before
  let anyBelow = false;
  for (let k = i - lb; k <= i; k++) {
    const d = s * (ctx.maF[k] - ctx.maM[k]);
    if (!Number.isFinite(d)) return null;
    if (k === i) { if (d <= 0) return null; } else if (d <= 0) anyBelow = true;
  }
  if (!anyBelow) return null;
  const c = ctx.c[i];
  const maS = ctx.maS[i];
  if (!isF(maS) || !isF(ctx.maS[i - 3])) return null;
  if (s * (c - ctx.o[i]) <= 0 || s * (c - ctx.maF[i]) <= 0 || s * (c - maS) <= 0) return null;
  const slowOk = s * (maS - ctx.maS[i - 3]) > 0 || s * (ctx.maM[i] - maS) > 0;
  if (!slowOk || ctx.vr[i] < cfg.vol_mult) return null;
  const p = cfg.maPrefix();
  const kind = cfg.ma_type === 'sma' ? 'MA' : 'EMA';
  const dirRu = s > 0 ? 'снизу вверх' : 'сверху вниз';
  const sideRu = s > 0 ? 'выше' : 'ниже';
  return {
    key: 'cross', label: `${kind} Cross ${cfg.ma_fast}/${cfg.ma_mid}`,
    ma_label: `${p}${cfg.ma_fast}/${p}${cfg.ma_mid}`, ma_value: ctx.maM[i],
    strength: 0, vol_bonus: ctx.vr[i] >= cfg.vol_mult * 1.5,
    reasons: [`${p}${cfg.ma_fast} пересекла ${p}${cfg.ma_mid} ${dirRu}`,
      `цена ${sideRu} ${p}${cfg.ma_slow}`],
  };
}

// ── MA Turn ─────────────────────────────────────────────────────────────────

function setupTurn(ctx, i, s) {
  const cfg = ctx.cfg;
  const k = cfg.turn_slope_bars, N = cfg.turn_lookback;
  if (i - N - k < 0) return null;
  const seg0 = i - N - k;
  for (let j = seg0; j <= i; j++) if (!Number.isFinite(ctx.turn[j])) return null;
  // slope[j] = s·(seg[k+j] − seg[j]), j = 0..N; slope[N] is the signal bar
  const slope = new Float64Array(N + 1);
  for (let j = 0; j <= N; j++) slope[j] = s * (ctx.turn[seg0 + k + j] - ctx.turn[seg0 + j]);
  // [VOLUME-FIX 2026-10] slope ≥ turn_min_slope_atr × ATR; before it N−1 bars against the
  // trade and at most one "flat" transition bar (slope < threshold)
  const a = ctx.atr[i];
  const minUp = isF(a) ? cfg.turn_min_slope_atr * a : 0.0;
  const thr = pyMax(0.0, minUp);
  if (slope[N] <= thr) return null;
  for (let j = 0; j < N - 1; j++) if (!(slope[j] < 0)) return null;     // np.all(_prev[:-1] < 0)
  if (!(slope[N - 1] < thr)) return null;                                // _prev[-1] < thr
  const c = ctx.c[i];
  const maS = ctx.maS[i];
  if (!isF(maS)) return null;
  if (s * (c - ctx.o[i]) <= 0 || s * (c - ctx.turn[i]) <= 0 || s * (c - maS) <= 0) return null;
  if (ctx.vr[i] < cfg.vol_mult) return null;
  const p = cfg.maPrefix();
  const dirRu = s > 0 ? 'вверх' : 'вниз';
  const sideRu = s > 0 ? 'выше' : 'ниже';
  return {
    key: 'turn', label: `MA Turn ${p}${cfg.turn_period}`,
    ma_label: `${p}${cfg.turn_period}`, ma_value: ctx.turn[i],
    strength: 0, vol_bonus: ctx.vr[i] >= cfg.vol_mult * 1.5,
    reasons: [`${p}${cfg.turn_period} развернулась ${dirRu} после ${N}+ свечей`,
      `цена ${sideRu} ${p}${cfg.ma_slow}`],
  };
}

// ── Rejection candle ────────────────────────────────────────────────────────

/** `_rejection(ctx, i, s)` → "hammer" | "engulfing" | "". */
function rejection(ctx, i, s) {
  const o = ctx.o[i], c = ctx.c[i], h = ctx.h[i], l = ctx.l[i];
  const rng = h - l;
  if (rng <= 0) return '';
  const body = Math.abs(c - o);
  let tail, nose;
  if (s > 0) {
    tail = Math.min(o, c) - l;
    nose = h - Math.max(o, c);
  } else {
    tail = h - Math.max(o, c);
    nose = Math.min(o, c) - l;
  }
  if (tail >= 2.0 * Math.max(body, 0.05 * rng) && nose <= 0.35 * rng) return 'hammer';
  if (i >= 1) {
    const po = ctx.o[i - 1], pc = ctx.c[i - 1];
    if (s > 0 && c > o && pc < po && c >= po && o <= pc) return 'engulfing';
    if (s < 0 && c < o && pc > po && c <= po && o >= pc) return 'engulfing';
  }
  return '';
}

// ── EMA Bounce ──────────────────────────────────────────────────────────────

const PAT_RU = {
  hammer: ['молот / пин-бар', 'перевёрнутый пин-бар'],
  engulfing: ['бычье поглощение', 'медвежье поглощение'],
  touch: ['касание EMA и закрытие выше', 'касание EMA и закрытие ниже'],
};

function setupBounce(ctx, i, s) {
  const cfg = ctx.cfg;
  const bl = BOUNCE_LOOKBACK;
  if (i - bl < 1) return null;
  const a = ctx.atr[i];
  const c = ctx.c[i];
  const tol = cfg.bounce_tol_atr * a;
  const ext = s > 0 ? ctx.l[i] : ctx.h[i];                 // candle extreme towards the EMA
  for (const which of ['trend', 'mid']) {
    const E = which === 'trend' ? ctx.e200 : ctx.e50;
    const period = which === 'trend' ? cfg.ema_trend : cfg.ema_mid;
    const Ei = E[i];
    const dist = s * (ext - Ei);                           // > 0: the extreme did not reach the EMA
    if (dist > tol || dist < -1.0 * a || s * (c - Ei) <= 0) continue;
    // trend context of this EMA
    if (which === 'trend') {
      if (!(s * (Ei - E[i - 10]) >= 0 || s * (ctx.e50[i] - Ei) > 0)) continue;
    } else if (!(s * (ctx.e50[i] - ctx.e200[i]) > 0 && s * (Ei - E[i - 5]) > 0)) {
      continue;
    }
    // pullback "from above": price was over the EMA and ≥ 1 ATR away from it
    let above = 0;
    let farMax = Number.NaN;                                // np.nanmax
    for (let j = i - bl; j < i; j++) {
      if (s * (ctx.c[j] - E[j]) > 0) above++;
      const far = s > 0 ? ctx.h[j] - E[j] : E[j] - ctx.l[j];
      if (far === far && !(far <= farMax)) farMax = far;
    }
    if (above < 0.7 * bl) continue;
    if (farMax < 1.0 * a) continue;                         // QUIRK(spec §7.3): all-NaN → NaN → not skipped
    let pat = rejection(ctx, i, s);
    if (!pat) {
      // [VOLUME-EMA-TOUCH 2026-10] touch by the wick + close with the trend ≥ 0.25 ATR from the EMA
      if (s * (c - ctx.o[i]) > 0 && s * (c - Ei) >= 0.25 * a) pat = 'touch';
      else continue;
    }
    const pullVol = S.npMean(ctx.v.subarray(i - 3, i));
    if (ctx.vr[i] < cfg.bounce_vol_mult || ctx.v[i] <= pullVol) continue;
    // [VOLUME-FIX 2026-10] a stop beyond sl_atr_mult × ATR rejects this bounce only (not the bar)
    const anchor0 = s > 0 ? Math.min(ext, Ei) : Math.max(ext, Ei);
    const risk0 = s * (c - (anchor0 - s * cfg.sl_buffer_atr * a));
    if (risk0 > cfg.sl_atr_mult * a) continue;
    const dry = ctx.vavg[i] > 0 && pullVol < ctx.vavg[i];
    const patRu = PAT_RU[pat][s > 0 ? 0 : 1];
    const rs = [`отскок от EMA${period}: ${patRu}`];
    if (dry) rs.push('объём на откате затухал (VSA)');
    return {
      key: 'bounce', label: `EMA${period} Bounce`,
      ma_label: `EMA${period}`, ma_value: Ei,
      strength: which === 'trend' ? 1 : 0, vol_bonus: Boolean(dry),
      reasons: rs, pattern: pat, sl_anchor: Ei,
    };
  }
  return null;
}

// ── Golden / Death Cross ────────────────────────────────────────────────────

function setupGolden(ctx, i, s) {
  const cfg = ctx.cfg;
  if (i < 1) return null;
  const gNow = s * (ctx.e50[i] - ctx.e200[i]);
  const gPrev = s * (ctx.e50[i - 1] - ctx.e200[i - 1]);
  if (!(gNow > 0 && gPrev <= 0)) return null;
  // [VOL-MIN-VOLUME 2026-10] was «volume ≥ average» (1.0) — now ≥ the floor (1.5)
  if (s * (ctx.c[i] - ctx.e50[i]) <= 0 || ctx.vr[i] < goldenVolMin()) return null;
  const name = s > 0 ? 'Golden Cross' : 'Death Cross';
  const ru = s > 0 ? 'золотой крест' : 'крест смерти';
  const dirRu = s > 0 ? 'снизу вверх' : 'сверху вниз';
  return {
    key: 'golden', label: name,
    ma_label: `EMA${cfg.ema_mid}/EMA${cfg.ema_trend}`, ma_value: ctx.e200[i],
    strength: 1, vol_bonus: ctx.vr[i] >= cfg.vol_mult,
    reasons: [`EMA${cfg.ema_mid} пересекла EMA${cfg.ema_trend} ${dirRu} (${ru})`],
  };
}

// ── Ribbon Pullback ─────────────────────────────────────────────────────────

/** Share of ribbon EMA pairs ordered in direction s at bar j (1.0 = clean ribbon); 0 if any NaN. */
function ribbonOrder(rib, j, s) {
  const n = rib.length;
  for (let k = 0; k < n; k++) if (!Number.isFinite(rib[k][j])) return 0.0;
  let ok = 0;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (s * (rib[a][j] - rib[b][j]) > 0) ok++;
  return ok / (n * (n - 1) / 2);
}

function setupRibbon(ctx, i, s) {
  const cfg = ctx.cfg;
  const rib = ctx.rib;
  const lb = RIBBON_LOOKBACK;
  if (rib === null || rib === undefined || i - lb < 1) return null;
  const a = ctx.atr[i];
  const c = ctx.c[i], o = ctx.o[i];
  const fast = rib[0], slow = rib[rib.length - 1];
  // ribbon ordered before the pullback
  const order0 = ribbonOrder(rib, i - lb, s);
  if (order0 < RIBBON_MIN_ORDER || s * (fast[i - lb] - slow[i - lb]) <= 0) return null;
  // pullback went inside the ribbon (extreme beyond the fast EMA) but the slow EMA held
  let inside = false;
  let held = true;
  for (let j = i - lb; j < i; j++) {
    const extW = s > 0 ? ctx.l[j] : ctx.h[j];
    if (s * (fast[j] - extW) > 0) inside = true;
    if (!(s * (ctx.c[j] - slow[j]) > -0.25 * a)) held = false;
  }
  if (!inside) return null;
  if (!held) return null;
  // signal bar: body with the trend, close back over the fast EMA, the bar touched the ribbon
  const touched = s * (fast[i] - (s > 0 ? ctx.l[i] : ctx.h[i])) > 0 || s * (fast[i - 1] - ctx.c[i - 1]) > 0;
  if (!(touched && s * (c - o) > 0 && s * (c - fast[i]) > 0)) return null;
  const r = ctx.rsi[i];
  if (!(35 <= r && r <= 65)) return null;
  if (ctx.vr[i] < cfg.ribbon_vol_mult) return null;
  const pullVol = S.npMean(ctx.v.subarray(i - lb, i));
  const dry = ctx.vavg[i] > 0 && pullVol < ctx.vavg[i];
  const ext = s > 0 ? sliceMin(ctx.l, i - lb, i) : sliceMax(ctx.h, i - lb, i);
  const anchor = s > 0 ? Math.min(ext, ctx.l[i]) : Math.max(ext, ctx.h[i]);
  const risk0 = s * (c - (anchor - s * cfg.sl_buffer_atr * a));
  if (risk0 > cfg.sl_atr_mult * a) return null;
  const orderNow = ribbonOrder(rib, i, s);
  const rs = [`откат к ленте EMA ${RIBBON_SPANS[0]}…${RIBBON_SPANS[RIBBON_SPANS.length - 1]}: лента выстроена на ${fmtFixed(order0 * 100, 0)}%, `
    + `возврат ${s > 0 ? 'над' : 'под'} EMA${RIBBON_SPANS[0]}`];
  if (dry) rs.push('объём на откате затухал (VSA)');
  return {
    key: 'ribbon', label: 'Ribbon Pullback',
    ma_label: `EMA ${RIBBON_SPANS[0]}–${RIBBON_SPANS[RIBBON_SPANS.length - 1]}`, ma_value: fast[i],
    strength: orderNow >= 0.9 ? 1 : 0, vol_bonus: Boolean(dry),
    sl_anchor: anchor, reasons: rs, pattern: 'ribbon',
  };
}

const DETECTORS = Object.freeze({
  golden: setupGolden, bounce: setupBounce, cross: setupCross, turn: setupTurn, ribbon: setupRibbon,
});
/** Evaluation order inside signal_at. */
const DETECTOR_ORDER = Object.freeze(['golden', 'bounce', 'ribbon', 'cross', 'turn']);
/** Tie-break priority at equal quality. */
const PRIORITY = Object.freeze({ golden: 0, bounce: 1, ribbon: 2, cross: 3, turn: 4 });
/** [VOLUME-FIX 2026-10] "confluence" bonus only across families (cross + turn = one move of the MAs). */
const FAMILY = Object.freeze({ golden: 'trend', bounce: 'bounce', ribbon: 'bounce', cross: 'momentum', turn: 'momentum' });

module.exports = {
  isF, sliceMin, sliceMax, setupCross, setupTurn, rejection, setupBounce, setupGolden, ribbonOrder, setupRibbon,
  DETECTORS, DETECTOR_ORDER, PRIORITY, FAMILY, PAT_RU,
};
