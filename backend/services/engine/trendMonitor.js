/**
 * trendMonitor — the bot's trend_monitor.py one-to-one (signal-pipeline.md §7).
 *
 * BTC trend per TF (15m / 1H / 4H from the WS candle cache; 1D / 1W / 1M by
 * REST every TREND_REST_REFRESH_S): close > EMA_slow and EMA_fast > EMA_slow →
 * LONG, mirrored → SHORT, else RANGE; a change counts after CONFIRM_BY_TF
 * closed bars. State in engine_kv `trend_state_v1`, the "market aligned"
 * dedup in `trend_aligned_v1`, opt-outs in `trend_notify_off_<uid>`.
 *
 * Pure pieces (exported as functions): trendAt, computeTrend, ribbonStrength,
 * normTf, emaPeriods, confirmBars, changeText, alignedText, tfLabel, ctxLabel,
 * parseCtxRisk. Live pieces live on a monitor instance (`createTrendMonitor`)
 * whose clock, kv, candle cache, REST fetcher, user list and delivery callback
 * are injected — the engine worker wires `send` (the broadcast) and the
 * cards read `cardLine` from the default instance.
 *
 * Markers: [TREND-MONITOR], [TREND-CHANGE], [TREND-ALIGNED].
 */

'use strict';

const { ewmSpan } = require('../../strategies/common/series');
const { fmtFixed, fmtG, pyRepr } = require('../../strategies/common/pyfmt');
const { pyRoundInt, pyMax, pyMin } = require('../../strategies/common/pyround');
const { pyTruthy } = require('../../strategies/common/pyval');
const { GRADES } = require('../../strategies/smc/signalBuilder');
const { pyJsonDumps } = require('./pyjson');
const { pyInt, pyFloat } = require('./pycoerce');
const { pyLoads } = require('./signalTradesRepo');
const { log: defaultLog } = require('../marketData/mdLog');
const { pyLower, pyStrip, pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const SYMBOL = 'BTC-USDT-SWAP';
const TFS = Object.freeze(['15m', '1H', '4H', '1D', '1W', '1M']);
const REST_TFS = Object.freeze(['1D', '1W', '1M']);        // нет в WS-кэше — тянем REST'ом
const EMA_FAST = 50;
const EMA_SLOW = 200;
const CONFIRM_BARS = 2;
const EMA_BY_TF = Object.freeze({ '1W': [20, 50], '1M': [10, 20] });   // остальные — (EMA_FAST, EMA_SLOW)
const CONFIRM_BY_TF = Object.freeze({ '1D': 1, '1W': 1, '1M': 1 });    // остальные — CONFIRM_BARS
const REST_LIMIT = Object.freeze({ '1D': 300, '1W': 300, '1M': 120 });
const REST_RETRY_S = 300.0;
const TF_LABEL = Object.freeze({
  ru: { '1D': '1D (дневной)', '1W': '1W (недельный)', '1M': '1M (месячный)' },
  en: { '1D': '1D (daily)', '1W': '1W (weekly)', '1M': '1M (monthly)' },
});
// [MTF-ALIGNED] сигнал по тренду сразу на 15m, 1H и 4H → +MTF_BONUS к качеству
const MTF_TFS = Object.freeze(['15m', '1H', '4H']);
// [RIBBON-STRENGTH] лента из 12 EMA (5…55): round(5 + 50*i/11)
const RIBBON_LENGTHS = Object.freeze(Array.from({ length: 12 }, (_, i) => pyRoundInt(5 + 50 * i / 11)));
const KV_KEY = 'trend_state_v1';
const KV_OFF_PREFIX = 'trend_notify_off_';
const KV_ALIGNED = 'trend_aligned_v1';
const CONTEXTS = Object.freeze(['aligned', 'with', 'counter', 'strong_counter']);
const CTX_RISK_DEFAULT = Object.freeze({ aligned: 1.0, with: 1.0, counter: 0.5, strong_counter: 0.0 });

const TF_ALIAS = Object.freeze({
  '15m': '15m', '30m': '1H', '1h': '1H', '1H': '1H', '2h': '4H', '4h': '4H', '4H': '4H',
  '1d': '1D', '1D': '1D', '1w': '1W', '1W': '1W', '1M': '1M', '': '15m',
});

const WORD = Object.freeze({
  ru: { LONG: 'ЛОНГ', SHORT: 'ШОРТ', RANGE: 'боковик', prio: { LONG: 'в приоритете лонги', SHORT: 'в приоритете шорты' } },
  en: { LONG: 'LONG', SHORT: 'SHORT', RANGE: 'range', prio: { LONG: 'longs have priority', SHORT: 'shorts have priority' } },
});

// ── env ───────────────────────────────────────────────────────────────────
// The module-level constants of trend_monitor.py, read from `env` like
// `os.getenv(NAME, "<default>") or <fallback>`: an unset variable gives the
// default string, an EMPTY one the `or` fallback (TREND_MTF_BONUS="" → 0,
// TREND_NOTIFY_TFS="" → no TF at all). A malformed number raises at import in
// the bot; the site keeps the default instead.
function envGet(env, name, dflt) {
  const v = env[name];
  return v === undefined || v === null ? dflt : String(v);
}
function envNum(env, name, dfltStr, orFallback, parse) {
  const raw = envGet(env, name, dfltStr);
  if (raw === '') return orFallback;
  try { return parse(raw); } catch (_e) { return parse(dfltStr); }
}
function envOn(env, name) {
  return !['0', 'false', 'off'].includes(pyStrip(envGet(env, name, '1') || '1'));
}

/**
 * _parse_ctx_risk(): TREND_CTX_RISK="aligned=1,with=1,counter=0.5,strong_counter=0" over
 * the defaults; each value = max(0.0, min(2.0, float(v))), unparsable values ignored.
 */
function parseCtxRisk(env = process.env) {
  const out = { ...CTX_RISK_DEFAULT };
  const raw = envGet(env, 'TREND_CTX_RISK', '') || '';
  for (const part of raw.split(',')) {
    if (!part.includes('=')) continue;
    const idx = part.indexOf('=');
    const k = pyStrip(part.slice(0, idx));
    const v = part.slice(idx + 1);
    if (!Object.prototype.hasOwnProperty.call(out, k)) continue;
    let f;
    try { f = pyFloat(v); } catch (_e) { continue; }   // float(v) ValueError → pass
    out[k] = pyMax(0.0, pyMin(2.0, f));
  }
  return out;
}

/** The module-level env constants of trend_monitor.py. */
function readConfig(env = process.env) {
  return {
    REST_REFRESH_S: pyMax(300.0, envNum(env, 'TREND_REST_REFRESH_S', '1800', 1800, pyFloat)),
    MTF_BONUS: pyMax(0, envNum(env, 'TREND_MTF_BONUS', '1', 0, pyInt)),
    STRONG_TREND: pyMax(0, pyMin(100, envNum(env, 'TREND_STRONG_PCT', '70', 70, pyInt))),
    STRONG_COUNTER_PENALTY: pyMax(0, envNum(env, 'TREND_STRONG_COUNTER_PENALTY', '1', 0, pyInt)),
    INTERVAL_S: pyMax(20.0, envNum(env, 'TREND_MONITOR_INTERVAL_S', '60', 60, pyFloat)),
    NOTIFY_TFS: (envGet(env, 'TREND_NOTIFY_TFS', '15m,1H,4H,1D,1W,1M') || '').split(',').map((t) => pyStrip(t)).filter(Boolean),
    ENABLED: envOn(env, 'TREND_MONITOR_ENABLED'),
    ALIGNED_NOTIFY: envOn(env, 'TREND_ALIGNED_NOTIFY'),
    CTX_RISK: parseCtxRisk(env),
  };
}

// ── pure helpers ──────────────────────────────────────────────────────────
function emaPeriods(tf) { return EMA_BY_TF[tf] || [EMA_FAST, EMA_SLOW]; }
function confirmBars(tf) { return Object.prototype.hasOwnProperty.call(CONFIRM_BY_TF, tf) ? CONFIRM_BY_TF[tf] : CONFIRM_BARS; }

/** norm_tf(tf): exact alias, then lower-cased, default "15m". */
function normTf(tf) {
  const s = String(tf == null ? '' : tf);
  if (Object.prototype.hasOwnProperty.call(TF_ALIAS, s)) return TF_ALIAS[s];
  const l = pyLower(s);
  return Object.prototype.hasOwnProperty.call(TF_ALIAS, l) ? TF_ALIAS[l] : '15m';
}

function tfLabel(tf, lang = 'ru') {
  const m = TF_LABEL[lang === 'en' ? 'en' : 'ru'];
  return Object.prototype.hasOwnProperty.call(m, tf) ? m[tf] : tf;
}

/** trend_at((close, ema_fast, ema_slow), i): LONG / SHORT / RANGE (null when i is out of range). */
function trendAt(arrs, i) {
  const [c, e50, e200] = arrs;
  const n = c.length;
  const j = i < 0 ? n + i : i;
  if (j < 0 || j >= n || j >= e50.length || j >= e200.length) return null;
  if (c[j] > e200[j] && e50[j] > e200[j]) return 'LONG';
  if (c[j] < e200[j] && e50[j] < e200[j]) return 'SHORT';
  return 'RANGE';
}

/**
 * compute_trend(df, prev, tf): the confirmed trend on the closed bars of `frame`
 * ({ c: Float64Array, length }), EMAs = ewm(span, adjust=False); the new trend is
 * accepted when it holds for confirm_bars(tf) bars, otherwise `prev`.
 */
function computeTrend(frame, prev = null, tf = '15m') {
  try {
    const [fast, slow] = emaPeriods(tf);
    const confirm = confirmBars(tf);
    if (!frame || frame.length < slow + confirm + 5) return prev;
    const close = frame.c;
    const e50 = ewmSpan(close, fast);
    const e200 = ewmSpan(close, slow);
    const arr = [close, e50, e200];
    const last = [];
    for (let k = 0; k < confirm; k++) last.push(trendAt(arr, -1 - k));
    if (last.every((t) => t === last[0]) && last[0] !== null) return last[0];
    return prev;
  } catch (_e) {
    return prev;
  }
}

/**
 * ribbon_strength(df, trend): share (0..100) of ordered EMA pairs of the 12-line
 * ribbon in the direction of `trend` (LONG: faster above slower; SHORT: below;
 * RANGE / null: the better of the two). null when fewer than 60 bars.
 */
function ribbonStrength(frame, trend = null) {
  try {
    if (!frame || frame.length < Math.max(...RIBBON_LENGTHS) + 5) return null;
    const emas = RIBBON_LENGTHS.map((n) => { const e = ewmSpan(frame.c, n); return e[e.length - 1]; });
    const n = emas.length;
    const total = n * (n - 1) / 2;
    let up = 0;
    let down = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (emas[i] > emas[j]) up++;
        else if (emas[i] < emas[j]) down++;
      }
    }
    const share = trend === 'LONG' ? up : (trend === 'SHORT' ? down : Math.max(up, down));
    return pyRoundInt(100.0 * share / total);
  } catch (_e) {
    return null;
  }
}

function ctxLabel(ctx, lang = 'ru') {
  const ru = { aligned: 'все ТФ по тренду', with: 'по тренду', counter: 'против тренда', strong_counter: 'против сильного тренда' };
  const en = { aligned: 'all TFs with trend', with: 'with trend', counter: 'counter-trend', strong_counter: 'against a strong trend' };
  const m = lang === 'en' ? en : ru;
  const k = String(ctx == null ? '' : ctx);
  return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : '';
}

/** aligned_text(direction, strength, lang) — the «🎯🎯 РЫНОК ВЫСТРОИЛСЯ» message. */
function alignedText(direction, strength, lang = 'ru') {
  const w = WORD[lang === 'en' ? 'en' : 'ru'];
  const st = strength !== null && strength !== undefined ? ` · ${lang !== 'en' ? 'сила' : 'strength'} ${strength}%` : '';
  if (lang === 'en') {
    const opp = direction === 'LONG' ? 'shorts' : 'longs';
    return `🎯🎯 <b>MARKET ALIGNED — BTC 15m · 1H · 4H: ${w[direction]}</b>${st}\n\n`
      + `✅ <b>${pyUpper(w.prio[direction])}</b> · ${opp} are against the trend on every `
      + 'timeframe — auto-trade halves their risk or skips them.';
  }
  const opp = direction === 'LONG' ? 'шорты' : 'лонги';
  return `🎯🎯 <b>РЫНОК ВЫСТРОИЛСЯ — BTC 15m · 1H · 4H: ${w[direction]}</b>${st}\n\n`
    + `✅ <b>${pyUpper(w.prio[direction])}</b> · ${opp} — против тренда на всех ТФ, `
    + 'автотрейд режет им риск вдвое или пропускает.';
}

/** change_text(tf, new, prev, since, lang) — `now` (unix s) replaces time.time(). */
function changeText(tf, newTrend, prev, since, lang = 'ru', now = Date.now() / 1000) {
  const w = WORD[lang === 'en' ? 'en' : 'ru'];
  let held = '';
  if (since > 0) {
    const hours = pyMax(0.0, (now - since) / 3600.0);
    held = lang !== 'en'
      ? (hours >= 1 ? `${fmtFixed(hours, 0)} ч` : `${fmtFixed(hours * 60, 0)} мин`)
      : (hours >= 1 ? `${fmtFixed(hours, 0)} h` : `${fmtFixed(hours * 60, 0)} min`);
  }
  const icon = { LONG: '📈', SHORT: '📉', RANGE: '↔️' }[newTrend] || '📊';
  const tfl = tfLabel(tf, lang);
  if (lang === 'en') {
    let head = `🚨🚨 <b>TREND CHANGED — BTC ${tfl}</b>\n\n${icon} Now: <b>${w[newTrend]}</b>`;
    if (newTrend === 'LONG' || newTrend === 'SHORT') {
      const opp = newTrend === 'LONG' ? 'shorts' : 'longs';
      head += `\n✅ <b>${pyUpper(w.prio[newTrend])}</b> · ${opp} are against the trend ⚠️`;
    } else {
      head += '\n⚠️ No clear trend — trade levels, cut size';
    }
    if (prev) head += `\n\n<i>Before: ${w[prev]}` + (held ? ` · held ${held}` : '') + '</i>';
    return head;
  }
  let head = `🚨🚨 <b>ТРЕНД ПОМЕНЯЛСЯ — BTC ${tfl}</b>\n\n${icon} Сейчас: <b>${w[newTrend]}</b>`;
  if (newTrend === 'LONG' || newTrend === 'SHORT') {
    const opp = newTrend === 'LONG' ? 'шорты' : 'лонги';
    head += `\n✅ <b>${pyUpper(w.prio[newTrend])}</b> · ${opp} — против тренда ⚠️`;
  } else {
    head += '\n⚠️ Чёткого тренда нет — торгуем от уровней, размер меньше';
  }
  if (prev) head += `\n\n<i>Было: ${w[prev]}` + (held ? ` · держался ${held}` : '') + '</i>';
  return head;
}

/** int(getattr(sig, attr, 0) or 0) — raises like int() (NaN, "5.5", objects). */
function intAttr(v) {
  return pyTruthy(v) ? pyInt(v) : 0;
}

/** str(x) of a JSON-loaded value (the bot keeps `str(st["trend"])`). */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) < 1e16 ? String(v) : pyRepr(v);
  return String(v);
}

/** smc.signal_builder GRADES.get(int(score), current) */
function gradeAfter(score, current) {
  try {
    const k = pyInt(score);
    return Object.prototype.hasOwnProperty.call(GRADES, k) ? GRADES[k] : current;
  } catch (_e) {
    return current;
  }
}

const nowSec = () => Date.now() / 1000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * createTrendMonitor(deps):
 *   kv       — { get, set, del, has } (engine_kv; default services/engineKvService)
 *   cache    — { getCandles(symbol, tf), setCandles(symbol, tf, frame, ttlMap) } (default candleCache)
 *   fetcher  — { getCandles(symbol, tf, limit) → Promise<Frame|null> } for 1D/1W/1M (default null)
 *   getUsers — () → active users (default traderSettingsService.getActiveUsers)
 *   send     — async (userId, text, { silent, keyboard, lang }) → bool; null = no broadcasts ("bot is None")
 *   isQuiet  — (user, now) → bool (default quietHours.isQuiet)
 *   now      — () → unix seconds; env — process.env-like; log; sleep(ms)
 */
function createTrendMonitor(deps = {}) {
  const cfg = readConfig(deps.env || process.env);
  const log = deps.log || defaultLog;
  const now = deps.now || nowSec;
  const sleep = deps.sleep || sleepMs;
  const lazy = (name, dflt) => () => (deps[name] !== undefined ? deps[name] : dflt());
  const kvOf = lazy('kv', () => require('../engineKvService'));
  const cacheOf = lazy('cache', () => require('../marketData/candleCache'));
  const getUsers = deps.getUsers || (() => require('../traderSettingsService').getActiveUsers());
  const isQuiet = deps.isQuiet || ((user, t) => require('./quietHours').isQuiet(user, t));
  const fetcher = deps.fetcher || null;
  const send = deps.send || null;

  const state = {};          // tf → {trend, since, price}
  const restNext = {};       // tf → ts
  const strength = {};       // tf → 0..100 (not persisted)
  const aligned = { dir: null, since: 0.0, loaded: false, had_kv: false };
  let loaded = false;

  const m = {
    cfg, SYMBOL, TFS, REST_TFS, MTF_TFS, KV_KEY, KV_OFF_PREFIX, KV_ALIGNED,
    _state: state, _strength: strength, _restNext: restNext, _aligned: aligned,

    getTrend(tf = '15m') {
      const st = state[normTf(tf)];
      return st ? st.trend : null;
    },

    /** tf → {trend, since, price, ema: "50/200", strength?} */
    getAll() {
      const out = {};
      for (const tf of TFS) {
        if (state[tf]) {
          const st = { ...state[tf] };
          const [f, s] = emaPeriods(tf);
          st.ema = `${f}/${s}`;
          if (Object.prototype.hasOwnProperty.call(strength, tf)) st.strength = pyInt(strength[tf]);   // int(): nan / inf raise
          out[tf] = st;
        }
      }
      return out;
    },

    trendStrength(tf = '15m') {
      const k = normTf(tf);
      return Object.prototype.hasOwnProperty.call(strength, k) ? strength[k] : null;
    },

    isStrong(tf = '15m') {
      const s = m.trendStrength(tf);
      return s !== null && s >= cfg.STRONG_TREND;
    },

    /** 'LONG'/'SHORT' when BTC points the same way on every MTF_TFS, else null. */
    alignedDirection() {
      const ts = MTF_TFS.map((tf) => m.getTrend(tf));
      if (ts.length && ts.every((t) => t === ts[0]) && (ts[0] === 'LONG' || ts[0] === 'SHORT')) return ts[0];
      return null;
    },

    /** True — all MTF_TFS in the signal's direction; False — not; null — a TF unknown / bad direction. */
    mtfAligned(direction) {
      const d = pyUpper(String(direction == null ? '' : direction));
      if (d !== 'LONG' && d !== 'SHORT') return null;
      const ts = MTF_TFS.map((tf) => m.getTrend(tf));
      if (ts.some((t) => t === null)) return null;
      return ts.every((t) => t === d);
    },

    /** True — against the BTC trend on tf; null — trend unknown / RANGE. */
    isCounter(direction, tf = '15m') {
      const t = m.getTrend(tf);
      if (t !== 'LONG' && t !== 'SHORT') return null;
      return pyUpper(String(direction == null ? '' : direction)) !== t;
    },

    ctxRiskMult(ctx) {
      const k = pyTruthy(ctx) ? String(ctx) : '';
      return Object.prototype.hasOwnProperty.call(cfg.CTX_RISK, k) ? Number(cfg.CTX_RISK[k]) : 1.0;
    },

    ctxLabel,

    /** 'aligned' | 'with' | 'counter' | 'strong_counter' | '' */
    trendContext(direction, alignedFlag = null, strongCounter = null) {
      const d = pyUpper(String(direction == null ? '' : direction));
      let al = alignedFlag;
      if (al === null || al === undefined) al = Boolean(m.mtfAligned(d));
      if (al) return 'aligned';
      const ct = m.isCounter(d, '15m');
      if (ct === null) return '';
      if (ct) {
        let sc = strongCounter;
        if (sc === null || sc === undefined) sc = m.isStrong('15m');
        return sc ? 'strong_counter' : 'counter';
      }
      return 'with';
    },

    /**
     * apply_mtf_bonus(sig, attr="quality", cap=10): sets sig.mtf_aligned / strong_counter /
     * trend_ctx once and adjusts sig[attr] (+MTF_BONUS when aligned, −STRONG_COUNTER_PENALTY
     * against a strong 15m trend, floor 1). Idempotent via sig.mtf_aligned (LEVELS hands
     * deep copies of one memo result to several users).
     *
     * attr "score" (SMC, cap 5): the SMC scanner recomputes `grade = GRADES.get(int(score),
     * grade)` whenever this returns True; PORT_DECISIONS D6 extends that to the strong-counter
     * penalty, so the grade always follows the adjusted score.
     */
    applyMtfBonus(sig, attr = 'quality', cap = 10) {
      if (sig.mtf_aligned !== null && sig.mtf_aligned !== undefined) {
        const okPrev = Boolean(sig.mtf_aligned);
        if (attr === 'score' && okPrev) sig.grade = gradeAfter(sig.score, sig.grade);
        return okPrev;
      }
      const direction = sig.direction === undefined ? '' : sig.direction;
      const ok = Boolean(m.mtfAligned(direction));
      const strongCounter = Boolean(m.isCounter(direction, '15m')) && m.isStrong('15m');
      sig.mtf_aligned = ok;
      sig.strong_counter = strongCounter;
      sig.trend_ctx = m.trendContext(direction, ok, strongCounter);   // [TREND-CTX]
      let penalised = false;
      try {
        const q = intAttr(sig[attr]);
        if (ok && cfg.MTF_BONUS > 0) {
          sig[attr] = pyMin(pyInt(cap), q + cfg.MTF_BONUS);
        } else if (strongCounter && cfg.STRONG_COUNTER_PENALTY > 0) {
          sig[attr] = pyMax(1, q - cfg.STRONG_COUNTER_PENALTY);
          penalised = true;
        }
      } catch (e) {
        log.debug(`[MTF-ALIGNED] bonus ${attr}: ${e && e.message}`);
      }
      if (attr === 'score' && (ok || penalised)) sig.grade = gradeAfter(sig.score, sig.grade);   // bot + D6
      return ok;
    },

    /** card_line(direction, tf, lang) — "" while the trend is not computed yet. */
    cardLine(direction, tf = '15m', lang = 'ru') {
      const w = WORD[lang === 'en' ? 'en' : 'ru'];
      const t15 = m.getTrend('15m');
      if (t15 === null) return '';
      const sigTf = normTf(tf);
      let extra = '';
      if (sigTf !== '15m') {
        const ts = m.getTrend(sigTf);
        if (ts) extra = ` · ${sigTf}: ${w[ts]}`;
      }
      if (t15 === 'RANGE') {
        return lang !== 'en' ? `↔️ BTC 15m: боковик — тренда нет${extra}` : `↔️ BTC 15m: range — no trend${extra}`;
      }
      const ct = pyUpper(String(direction == null ? '' : direction)) !== t15;
      if (ct) {
        if (m.isStrong('15m')) {   // [RIBBON-STRENGTH] против сильного тренда — отдельно и громче
          const s15 = m.trendStrength('15m');
          return lang !== 'en'
            ? `⛔ <b>ПРОТИВ СИЛЬНОГО ТРЕНДА</b> (${s15}%) · BTC 15m: ${w[t15]} — ${w.prio[t15]}${extra}`
            : `⛔ <b>AGAINST A STRONG TREND</b> (${s15}%) · BTC 15m: ${w[t15]} — ${w.prio[t15]}${extra}`;
        }
        return lang !== 'en'
          ? `⚠️ <b>ПРОТИВ ТРЕНДА</b> · BTC 15m: ${w[t15]} — ${w.prio[t15]}${extra}`
          : `⚠️ <b>AGAINST THE TREND</b> · BTC 15m: ${w[t15]} — ${w.prio[t15]}${extra}`;
      }
      if (m.mtfAligned(direction)) {
        // [MTF-ALIGNED] 15m, 1H и 4H в одну сторону — сильнейший контекст
        return lang !== 'en'
          ? `🎯 <b>ПО ТРЕНДУ НА 15m · 1H · 4H</b> — ${w.prio[t15]}${extra}`
          : `🎯 <b>WITH THE TREND ON 15m · 1H · 4H</b> — ${w.prio[t15]}${extra}`;
      }
      return lang !== 'en'
        ? `✅ По тренду · BTC 15m: ${w[t15]} — ${w.prio[t15]}${extra}`
        : `✅ With the trend · BTC 15m: ${w[t15]} — ${w.prio[t15]}${extra}`;
    },

    // ── state ─────────────────────────────────────────────────────────
    /**
     * load_state(): kv trend_state_v1 → state (only the six TFs, entries with a truthy
     * trend). A malformed since/price aborts the rest of the load (one debug line),
     * the entries read before it stay — like the bot's single try block.
     */
    loadState() {
      if (loaded) return;
      loaded = true;
      try {
        const raw = kvOf().get(KV_KEY);
        if (raw) {
          const data = pyLoads(raw);   // json.loads: a NaN price (last close NaN) round-trips like in the bot
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            for (const [tf, st] of Object.entries(data)) {
              if (TFS.includes(tf) && st && typeof st === 'object' && !Array.isArray(st) && pyTruthy(st.trend)) {
                state[tf] = {
                  trend: pyStr(st.trend),
                  since: pyFloat(pyTruthy(st.since) ? st.since : 0),
                  price: pyFloat(pyTruthy(st.price) ? st.price : 0),
                };
              }
            }
          }
        }
      } catch (e) {
        log.debug(`[TREND-MONITOR] load_state: ${e && e.message}`);
      }
    },

    saveState() {
      try {
        kvOf().set(KV_KEY, pyJsonDumps(state, ['since', 'price']));
      } catch (e) {
        log.debug(`[TREND-MONITOR] save_state: ${e && e.message}`);
      }
    },

    /** The serialized state (what kv `trend_state_v1` holds). */
    dumpState() { return pyJsonDumps(state, ['since', 'price']); },

    /** set_opted_out(uid, off): kv trend_notify_off_<uid> = "1" / deleted. */
    setOptedOut(uid, off) {
      const key = `${KV_OFF_PREFIX}${pyInt(uid)}`;
      if (off) kvOf().set(key, '1'); else kvOf().del(key);
    },

    isOptedOut(uid) {
      return kvOf().has(`${KV_OFF_PREFIX}${pyInt(uid)}`);
    },

    /**
     * broadcast_change(tf, new, prev, since, text_fn): every active user without an
     * opt-out gets text_fn(lang) or change_text(...), silently in their quiet hours.
     * Returns the number sent. No `send` wired → 0 (like bot=None).
     */
    async broadcastChange(tf, newTrend, prev, since, textFn = null) {
      if (!send) return 0;
      let users;
      let off = new Set();
      try {
        users = getUsers() || [];
        const kv = kvOf();
        if (kv && typeof kv.keysWithPrefix === 'function') {
          try {
            off = new Set(kv.keysWithPrefix(KV_OFF_PREFIX).map((k) => k.slice(KV_OFF_PREFIX.length)));
          } catch (e) {
            log.debug(`[TREND-CHANGE] opt-out list: ${e && e.message}`);
          }
        }
      } catch (e) {
        log.warning(`[TREND-CHANGE] users load failed: ${e && e.message}`);
        return 0;
      }
      let sent = 0;
      const t = now();
      const perUserCheck = !(kvOf() && typeof kvOf().keysWithPrefix === 'function');
      for (const row of users) {
        let uid;
        try { uid = pyInt(row ? row.user_id : 0); } catch (_e) { continue; }   // (TypeError, ValueError) → skip
        if (uid <= 0 || off.has(String(uid))) continue;
        if (perUserCheck) {
          let optedOut = false;
          try { optedOut = m.isOptedOut(uid); } catch (_e) { optedOut = false; }
          if (optedOut) continue;
        }
        const lang = (row && pyTruthy(row.lang) ? row.lang : 'ru');
        let silent = false;
        try { silent = Boolean(isQuiet(row, t)); } catch (_e) { silent = false; }
        try {
          const txt = textFn ? textFn(lang) : changeText(tf, newTrend, prev, since, lang, t);
          const keyboard = require('./cards/keyboards').trendKeyboard(lang);
          if (await send(uid, txt, { silent, keyboard, lang, kind: 'trend' })) sent++;
        } catch (e) {
          log.debug(`[TREND-CHANGE] uid=${uid}: ${e && e.message}`);
        }
        await sleep(40);
      }
      return sent;
    },

    // ── candles / refresh ─────────────────────────────────────────────
    /** _candles(tf, fetcher, now): cache first; 1D/1W/1M by REST not more often than REST_REFRESH_S (retry 300 s). */
    async candles(tf, t) {
      const cache = cacheOf();
      let df = null;
      try { df = cache.getCandles(SYMBOL, tf); } catch (e) { log.debug(`[TREND-MONITOR] cache ${tf}: ${e && e.message}`); }
      if (df !== null && df !== undefined) return df;
      if (!REST_TFS.includes(tf) || fetcher === null) return df === undefined ? null : df;
      if (t < (restNext[tf] || 0.0)) return null;
      restNext[tf] = t + REST_RETRY_S;
      try {
        df = await fetcher.getCandles(SYMBOL, tf, REST_LIMIT[tf] || 300);
      } catch (e) {
        log.debug(`[TREND-MONITOR] rest ${tf}: ${e && e.message}`);
        return null;
      }
      if (!df || df.length === 0) return null;
      restNext[tf] = t + cfg.REST_REFRESH_S;
      try {
        cache.setCandles(SYMBOL, tf, df, { [tf]: Math.trunc(cfg.REST_REFRESH_S) });
      } catch (e) {
        log.debug(`[TREND-MONITOR] cache set ${tf}: ${e && e.message}`);
      }
      return df;
    },

    /**
     * refresh(now, {notify}): one pass over TFS. Returns the changes [[tf, new, prev], …].
     * `notify=false` behaves like bot=None (no broadcasts; state still updated).
     */
    async refresh(t = null, { notify = true } = {}) {
      const tNow = t === null || t === undefined ? now() : t;
      const bot = notify && send !== null;
      const changes = [];
      for (const tf of TFS) {
        const df = await m.candles(tf, tNow);
        const st = state[tf];
        const prev = st ? st.trend : null;
        const newT = computeTrend(df, prev, tf);
        const s = ribbonStrength(df, newT || prev);   // [RIBBON-STRENGTH] каждый цикл
        if (s !== null) strength[tf] = s;
        if (newT === null || newT === prev) continue;
        let price = 0.0;
        try { price = Number(df.c[df.length - 1]); } catch (e) { log.debug(`[TREND-MONITOR] price ${tf}: ${e && e.message}`); }
        const sincePrev = st ? Number(st.since || 0) : 0.0;
        state[tf] = { trend: newT, since: tNow, price };
        changes.push([tf, newT, prev]);
        log.info(`[TREND-CHANGE] BTC ${tf}: ${prev || '-'} → ${newT} (price=${fmtG(price, 6)})`);
        if (bot && prev !== null && cfg.NOTIFY_TFS.includes(tf)) {
          try {
            const n = await m.broadcastChange(tf, newT, prev, sincePrev);
            log.info(`[TREND-CHANGE] BTC ${tf} notified ${n} users`);
          } catch (e) {
            log.warning(`[TREND-CHANGE] broadcast ${tf}: ${e && e.message}`);
          }
        }
      }
      if (changes.length) m.saveState();
      try {
        await m.checkAligned(tNow, { notify: bot });        // [TREND-ALIGNED]
      } catch (e) {
        log.debug(`[TREND-ALIGNED] check: ${e && e.message}`);
      }
      return changes;
    },

    /** _load_aligned(): kv trend_aligned_v1 once; had_kv only when the JSON object parsed. */
    loadAligned() {
      if (aligned.loaded) return;
      aligned.loaded = true;
      try {
        const raw = kvOf().get(KV_ALIGNED);
        if (raw) {
          const data = pyLoads(raw);
          if (data === null || typeof data !== 'object' || Array.isArray(data)) {
            throw new TypeError("object has no attribute 'get'");
          }
          aligned.dir = (pyTruthy(data.dir) ? pyStr(data.dir) : '') || null;
          aligned.since = pyFloat(pyTruthy(data.since) ? data.since : 0);
          aligned.had_kv = true;
        }
      } catch (e) {
        log.debug(`[TREND-ALIGNED] load: ${e && e.message}`);
      }
    },

    /** _check_aligned: one message when 15m/1H/4H line up (or flip side); the first observation without kv is only stored. */
    async checkAligned(t, { notify = true } = {}) {
      m.loadAligned();
      const cur = m.alignedDirection();
      const prev = aligned.dir;
      if (cur === prev) return null;
      const first = !aligned.had_kv;
      aligned.dir = cur;
      aligned.since = t;
      aligned.had_kv = true;
      try {
        kvOf().set(KV_ALIGNED, pyJsonDumps({ dir: cur || '', since: t }, ['since']));
      } catch (e) {
        log.debug(`[TREND-ALIGNED] save: ${e && e.message}`);
      }
      if (cur === null) {
        log.info(`[TREND-ALIGNED] BTC 15m/1H/4H разошлись (было ${prev === null ? 'None' : prev})`);
        return null;
      }
      const st = m.trendStrength('15m');
      log.info(`[TREND-ALIGNED] BTC 15m/1H/4H выстроились: ${cur} (сила 15m ${st === null ? 'None' : st}%)`);
      if (notify && send !== null && cfg.ALIGNED_NOTIFY && !first) {
        try {
          const n = await m.broadcastChange('15m', cur, prev, 0.0, (lang) => alignedText(cur, st, lang));
          log.info(`[TREND-ALIGNED] notified ${n} users`);
        } catch (e) {
          log.warning(`[TREND-ALIGNED] broadcast: ${e && e.message}`);
        }
      }
      return cur;
    },

    /**
     * trend_monitor_loop: disabled → one log line; else load_state(), the start log,
     * a 90 s warm-up, then refresh() every INTERVAL_S until `signal.aborted`.
     */
    async runLoop({ signal = null } = {}) {
      if (!cfg.ENABLED) {
        log.info('[TREND-MONITOR] disabled (TREND_MONITOR_ENABLED=0)');
        return;
      }
      m.loadState();
      const st = Object.entries(state).map(([k, v]) => `'${k}': '${v.trend}'`).join(', ');
      log.info(`[TREND-MONITOR] started: tfs=(${TFS.map((t) => `'${t}'`).join(', ')}) `
        + `notify=(${cfg.NOTIFY_TFS.map((t) => `'${t}'`).join(', ')}${cfg.NOTIFY_TFS.length === 1 ? ',' : ''}) `
        + `interval=${fmtFixed(cfg.INTERVAL_S, 0)}s state={${st}}`);
      await sleep(90 * 1000);
      while (!(signal && signal.aborted)) {
        try {
          await m.refresh();
        } catch (e) {
          log.warning(`[TREND-MONITOR] cycle error: ${e && e.message}`);
        }
        if (signal && signal.aborted) break;
        await sleep(cfg.INTERVAL_S * 1000);
      }
    },

    /** Tests / admin: drop the in-memory state. */
    _resetForTests() {
      for (const k of Object.keys(state)) delete state[k];
      for (const k of Object.keys(strength)) delete strength[k];
      for (const k of Object.keys(restNext)) delete restNext[k];
      Object.assign(aligned, { dir: null, since: 0.0, loaded: false, had_kv: false });
      loaded = false;
    },

    /** Tests: seed the trend state directly ({tf: trend} or {tf: {trend, since, price}}) and strengths. */
    _seed(trends = {}, strengths = {}) {
      for (const [tf, v] of Object.entries(trends)) {
        state[tf] = typeof v === 'string' ? { trend: v, since: 0.0, price: 0.0 } : { ...v };
      }
      for (const [tf, v] of Object.entries(strengths)) strength[tf] = v;
    },
  };
  return m;
}

// ── default instance (the module-level state of trend_monitor.py) ──────────
const defaultMonitor = createTrendMonitor();
const bound = {};
for (const name of ['getTrend', 'getAll', 'trendStrength', 'isStrong', 'alignedDirection', 'mtfAligned',
  'isCounter', 'ctxRiskMult', 'trendContext', 'applyMtfBonus', 'cardLine', 'loadState', 'saveState',
  'setOptedOut', 'isOptedOut', 'broadcastChange', 'candles', 'refresh', 'checkAligned', '_resetForTests', '_seed']) {
  bound[name] = (...a) => defaultMonitor[name](...a);
}

module.exports = {
  SYMBOL, TFS, REST_TFS, EMA_FAST, EMA_SLOW, CONFIRM_BARS, EMA_BY_TF, CONFIRM_BY_TF, REST_LIMIT, REST_RETRY_S,
  TF_LABEL, MTF_TFS, RIBBON_LENGTHS, KV_KEY, KV_OFF_PREFIX, KV_ALIGNED, CONTEXTS, CTX_RISK_DEFAULT, TF_ALIAS, WORD,
  readConfig, parseCtxRisk, emaPeriods, confirmBars, normTf, tfLabel, trendAt, computeTrend, ribbonStrength,
  ctxLabel, alignedText, changeText, createTrendMonitor, defaultMonitor,
  ...bound,
};
