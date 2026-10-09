'use strict';
/**
 * coinAnalysisShell.js — the bot's coin_analysis.py (one coin, one strategy or AUTO, on demand)
 * around the JS engines (strategies/levels, strategies/smc, strategies/volume), plus the
 * pieces of the Mini App analyze flow that are not HTTP:
 *
 *   coin_analysis.py   _levels / _smc / _volume (engine adapters, default configs, 1h),
 *                      _still_valid, _slice_upto, run_strategy (freshness: the setup of the
 *                      last LOOKBACK=6 closed bars that neither hit SL nor TP1 since),
 *                      analyze_coin (fetch 1h [+4h/15m for SMC/AUTO], AUTO = best by
 *                      (quality, freshness, R:R to TP2), first maximum on ties)
 *   handlers/guest.py  _format_strategy_result + the "no setup" text (verbatim, HTML)
 *   miniapp_api.py     h_analyze body parsing (_SYMBOL_RE), _analyze_allowed (10 s cooldown,
 *                      plan_limit("analyze_per_day") quota on kv analyze_count_<uid>_<day>),
 *                      the response payload (signal subset, tried, price) — the PNG is `null`
 *                      and the chart travels as data next to it (chartPayload.js: candles,
 *                      overlays, …; rendered by the client, D3).
 *
 * Engines and I/O are injected: `fetch(symbol, tf, limit)` → Frame | null (production:
 * BingX REST via services/marketData), `price24h(symbol)` → {last, change_pct} | null,
 * kv / planLimit / isPro / clock. Engine calls are synchronous (CPU-bound; callers can move
 * the whole analyze into a worker).
 */

const { levelsStars } = require('../../strategies/levels/stars');
const { fmtFixed, fmtSigned, fmtPriceDisplay } = require('../../strategies/common/pyfmt');
const { pyStrip, pyUpper } = require('./pyUnicode');   // CPython 3.11 str.strip() (str.isspace() characters)
const { pyInt: pyIntStrict } = require('./pycoerce');

const STRATEGIES = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);
const LABELS = Object.freeze({
  LEVELS: '📊 Уровни (LEVELS)',
  SMC: '🧠 Smart Money (SMC)',
  VOLUME: '📈 Объём + MA',
});
const LOOKBACK = 6;
const MIN_BARS = 220;
const ANALYZE_COOLDOWN_S = 10.0;
const SYMBOL_RE = /^[A-Z0-9]{2,15}$/;

/** str.lstrip(chars) for a set of code points. */
function lstripChars(s, chars) {
  const set = new Set(Array.from(chars));
  const arr = Array.from(String(s));
  let i = 0;
  while (i < arr.length && set.has(arr[i])) i++;
  return arr.slice(i).join('');
}

const toNum = (v) => Number(v);
const intOr0 = (v) => (v === null || v === undefined || v === false || v === '' || v === 0 ? 0 : Math.trunc(Number(v)));

// ── engine adapters (sync, CPU-bound) ───────────────────────────────────────

let enginesCache = null;
function engines() {
  if (!enginesCache) {
    enginesCache = {
      L: require('../../strategies/levels'),
      S: require('../../strategies/smc'),
      V: require('../../strategies/volume'),
    };
  }
  return enginesCache;
}

/** _levels(symbol, df): CHMIndicator(_cfg_to_ind(TradeCfg(timeframe="1h")))._do_analyze(…, None, None, None). */
function levelsSetup(symbol, df, { regime = null } = {}) {
  const { L } = engines();
  const cfg = L.cfgToInd(L.tradeCfg({ timeframe: '1h' }), false);
  const res = L.doAnalyze(symbol, df, null, null, null, cfg, { minQualityOverride: null, regime });
  const sig = res && res.signal;
  if (!sig) return null;
  const q10 = intOr0(sig.quality);
  const reasons = (sig.reasons || []).map((r) => pyStrip(lstripChars(String(r), '✅ ')));
  return {
    direction: sig.direction, entry: toNum(sig.entry), sl: toNum(sig.sl),
    tp1: toNum(sig.tp1), tp2: toNum(sig.tp2), tp3: toNum(sig.tp3),
    quality: levelsStars(q10),                                  // [QUALITY-SCALE]
    setup: sig.breakout_type || 'Level',
    reasons: reasons.slice(0, 4),
  };
}

/** _smc(symbol, htf, mtf, ltf): SMCAnalyzer(SMCConfig()).analyze + build_smc_signal(4H/1H/15m). */
function smcSetup(symbol, dfHtf, dfMtf, dfLtf) {
  const { S } = engines();
  const cfg = S.smcConfig();
  const analysis = S.analyze(symbol, dfHtf, dfMtf, dfLtf, cfg);
  const sig = S.buildSmcSignal(symbol, analysis, cfg, { tf_htf: '4H', tf_mtf: '1H', tf_ltf: '15m' });
  if (!sig) return null;
  const reasons = (sig.confirmations || []).filter(([, ok]) => ok).map(([lbl]) => String(lbl));
  return {
    direction: sig.direction, entry: toNum(sig.entry), sl: toNum(sig.sl),
    tp1: toNum(sig.tp1), tp2: toNum(sig.tp2), tp3: toNum(sig.tp3),
    quality: Math.max(1, Math.min(5, intOr0(sig.score))),
    setup: pyStrip(`SMC ${sig.grade === undefined || sig.grade === null ? '' : sig.grade}`),
    reasons: reasons.slice(0, 4),
  };
}

/** _volume(symbol, df): analyze_volume(symbol, df, None, "1h"). */
function volumeSetup(symbol, df) {
  const { V } = engines();
  const sig = V.analyzeVolume(symbol, df, null, '1h');
  if (!sig) return null;
  return {
    direction: sig.direction, entry: toNum(sig.entry), sl: toNum(sig.sl),
    tp1: toNum(sig.tp1), tp2: toNum(sig.tp2), tp3: toNum(sig.tp3),
    quality: Math.max(1, Math.min(5, Math.trunc(Number(sig.quality)))),
    setup: sig.signal_type,
    reasons: (sig.reasons || []).map((r) => String(r)).slice(0, 4),
  };
}

// ── freshness ───────────────────────────────────────────────────────────────

/** _still_valid(sig, after): no SL / TP1 touch on the bars after the signal bar. */
function stillValid(sig, after) {
  if (!after || !after.length) return true;
  let hi = -Infinity; let lo = Infinity;
  for (let i = 0; i < after.length; i++) {
    if (after.h[i] > hi) hi = after.h[i];
    if (after.l[i] < lo) lo = after.l[i];
  }
  if (sig.direction === 'LONG') return lo > sig.sl && hi < sig.tp1;
  return hi < sig.sl && lo > sig.tp1;
}

/** _slice_upto(df, ts): rows whose open time ≤ ts (ms). */
function sliceUpto(df, tsMs) {
  if (!df) return null;
  if (tsMs === null || tsMs === undefined) return df;
  let n = 0;
  while (n < df.length && df.t[n] <= tsMs) n++;
  return df.slice(0, n);
}

/**
 * run_strategy(strategy, symbol, frames {"1h", "4h", "15m"}): the freshest setup among the
 * last LOOKBACK closed 1h bars; a fresher setup that already ran (SL or TP1 touched since)
 * ends the search with null.
 */
function runStrategy(strategy, symbol, frames, opts = {}) {
  const df = frames['1h'];
  if (!df || df.length < MIN_BARS) return null;
  const depth = LOOKBACK;                                         // frames always carry times (dated)
  for (let k = 0; k < depth; k++) {
    const cut = k ? df.slice(0, df.length - k) : df;
    let sig = null;
    try {
      if (strategy === 'LEVELS') sig = levelsSetup(symbol, cut, opts);
      else if (strategy === 'VOLUME') sig = volumeSetup(symbol, cut);
      else if (strategy === 'SMC') {
        const ts = cut.t[cut.length - 1];
        const htf = sliceUpto(frames['4h'], ts);
        const ltf = sliceUpto(frames['15m'], ts);
        if (!htf || htf.length < 60) return null;
        sig = smcSetup(symbol, htf, cut, ltf);
      } else {
        return null;
      }
    } catch (e) {
      if (opts.log && opts.log.debug) opts.log.debug(`[COIN-ANALYSIS] ${strategy} ${symbol} k=${k}: ${e.message}`);
      sig = null;
    }
    if (!sig) continue;
    if (k && !stillValid(sig, df.slice(df.length - k))) return null;   // the freshest setup already played out
    sig.strategy = strategy;
    sig.bars_ago = k;
    return sig;
  }
  return null;
}

/** AUTO ordering key: (quality, −bars_ago, R:R to TP2), compared lexicographically. */
function autoKey(s) {
  const risk = Math.abs(s.entry - s.sl) || 1e-12;
  return [s.quality, -s.bars_ago, Math.abs(s.tp2 - s.entry) / risk];
}

function keyGreater(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** max(candidates, key=_key) — the FIRST maximal candidate wins ties. */
function pickBest(candidates) {
  let best = null; let bestKey = null;
  for (const c of candidates) {
    const k = autoKey(c);
    if (best === null || keyGreater(k, bestKey)) { best = c; bestKey = k; }
  }
  return best;
}

/**
 * analyze_coin(symbol, strategy, fetch) → { signal, df, tried, candidates }.
 * strategy: LEVELS | SMC | VOLUME | AUTO (any case). Fetch failures become null frames.
 */
async function analyzeCoin(symbol, strategy, fetch, opts = {}) {
  const strat = pyUpper(String(strategy));
  const needSmc = strat === 'SMC' || strat === 'AUTO';
  const call = (tf) => Promise.resolve().then(() => fetch(symbol, tf, 300));   // gather(return_exceptions=True)
  const tasks = [call('1h')];
  if (needSmc) tasks.push(call('4h'), call('15m'));
  const res = (await Promise.allSettled(tasks)).map((r) => (r.status === 'fulfilled' ? (r.value || null) : null));
  const frames = { '1h': res[0] };
  if (needSmc) { frames['4h'] = res[1]; frames['15m'] = res[2]; }
  const out = { signal: null, df: frames['1h'], tried: [], candidates: [] };
  if (!frames['1h']) return out;
  const names = strat === 'AUTO' ? STRATEGIES : [strat];
  for (const name of names) {
    out.tried.push(name);
    const sig = runStrategy(name, symbol, frames, opts);
    if (sig) out.candidates.push(sig);
  }
  if (out.candidates.length) out.signal = pickBest(out.candidates);
  return out;
}

// ── texts (handlers/guest.py) ───────────────────────────────────────────────

function htmlEscape(s) {
  return String(s === null || s === undefined || s === '' || s === 0 || s === false ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const pick = (d, ...keys) => {
  if (!d) return null;
  for (const k of keys) {
    const v = d[k];
    if (!(v === null || v === undefined || v === '' || v === 0 || v === false)) return v;
  }
  return null;
};

/** _format_strategy_result(symbol, data, sig, ref_link, paid, auto, tried) — the result card. */
function formatStrategyResult(symbol, data, sig, refLink, paid, auto, tried) {
  const pv = pick(data, 'last', 'price');
  const price = Number(pv !== null ? pv : sig.entry);
  const cv = pick(data, 'change_pct_24h');
  const chg = Number(cv !== null ? cv : 0);
  const risk = Math.abs(sig.entry - sig.sl) || 1e-12;
  const rr = (tp) => Math.abs(tp - sig.entry) / risk;
  const riskPct = sig.entry ? risk / sig.entry * 100 : 0;
  const dirEm = sig.direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT';
  const q = Number(sig.quality);
  const stars = '⭐'.repeat(Math.max(0, q)) + '☆'.repeat(Math.max(0, 5 - q));
  const label = Object.prototype.hasOwnProperty.call(LABELS, sig.strategy) ? LABELS[sig.strategy] : sig.strategy;
  const ago = sig.bars_ago === undefined ? 0 : sig.bars_ago;
  const when = !ago ? 'на последней закрытой свече' : `${ago} св. назад, ещё действует`;
  const lines = [
    `${chg >= 0 ? '📈' : '📉'} <b>${symbol}/USDT</b>  <code>${fmtPriceDisplay(price)}</code>  `
    + `<b>${fmtSigned(chg, 2)}%</b>`,
    '',
    auto ? `🤖 <b>Авто:</b> лучший сетап из ${tried.length} стратегий → ${label}` : `Стратегия: <b>${label}</b>`,
    `<b>${dirEm}</b>  ${stars}  · 1h · ${htmlEscape(sig.setup === undefined ? '' : sig.setup)}`,
    `<i>Сигнал ${when}</i>`,
    '',
    `🎯 <b>Entry:</b> <code>${fmtPriceDisplay(sig.entry)}</code>`,
    `🛑 <b>SL:</b>    <code>${fmtPriceDisplay(sig.sl)}</code>  <i>(-${fmtFixed(riskPct, 2)}%)</i>`,
    `🎯 <b>TP1:</b>  <code>${fmtPriceDisplay(sig.tp1)}</code>  <i>(${fmtFixed(rr(sig.tp1), 1)}R)</i>`,
    `🎯 <b>TP2:</b>  <code>${fmtPriceDisplay(sig.tp2)}</code>  <i>(${fmtFixed(rr(sig.tp2), 1)}R)</i>`,
    `🏆 <b>TP3:</b>  <code>${fmtPriceDisplay(sig.tp3)}</code>  <i>(${fmtFixed(rr(sig.tp3), 1)}R)</i>`,
  ];
  if (sig.reasons && sig.reasons.length) {
    lines.push('');
    for (const r of sig.reasons.slice(0, 4)) lines.push(`✅ ${htmlEscape(r)}`);
  }
  lines.push('');
  if (paid) lines.push('<i>⚠️ Не финансовый совет. Сигналы + автотрейд в личке бота.</i>');
  else lines.push(`<i>⚠️ Не финансовый совет. Все сигналы + автотрейд:</i> ${refLink}`);
  return lines.join('\n');
}

/** The "no current setup" reply of the strategy picker. */
function noSetupText(symbol, strategy) {
  const label = Object.prototype.hasOwnProperty.call(LABELS, strategy) ? LABELS[strategy] : '🤖 Авто';
  return `⏳ <b>${symbol}</b>: по стратегии ${label} `
    + 'сейчас нет действующего сетапа (1h).\n'
    + 'Попробуй другую стратегию или 🤖 Авто — или загляни позже: '
    + 'бот следит за рынком 24/7.';
}

// ── Mini App analyze: body, quota, payload ──────────────────────────────────

/**
 * str(v) of a parsed JSON value as Python prints it: None / True / False; a list or dict prints
 * with brackets (never a valid symbol or strategy name), so JSON text stands in for its repr.
 */
function pyStrJson(v) {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** dict.get(key, default) on the request body. */
function bodyGet(body, key, dflt) {
  return body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined
    ? body[key] : dflt;
}

/**
 * h_analyze body → { symbol, strategy } | { error: 'bad_symbol' }:
 * str(body.get("symbol", "")).upper().strip() (Python whitespace: U+001C–U+001F and U+0085 are
 * stripped, U+FEFF is not) minus "/USDT" and "USDT"; str(body.get("strategy", "AUTO")).upper().
 */
function parseAnalyzeBody(body) {
  const symbol = pyStrip(pyUpper(pyStrJson(bodyGet(body, 'symbol', ''))))
    .split('/USDT').join('').split('USDT').join('');
  let strategy = pyUpper(pyStrJson(bodyGet(body, 'strategy', 'AUTO')));
  if (!SYMBOL_RE.test(symbol || '')) return { error: 'bad_symbol' };
  if (!STRATEGIES.includes(strategy) && strategy !== 'AUTO') strategy = 'AUTO';
  return { symbol, strategy };
}

/**
 * createAnalyzeShell(deps): the stateful part (cooldown map) of the Mini App analyze.
 *   kv          { get(key) } + incr via `incrDay(prefix, uid, {now})` (engineKvService)
 *   planLimit   user → number (UserSettings.plan_limit("analyze_per_day"); planFeatures)
 *   isPro       user → bool (fallback when plan_limit throws)
 *   fetch       (symbol "XXX", tf, limit) → Frame | null  (the "-USDT-SWAP" suffix is added here)
 *   price24h    "XXX-USDT-SWAP" → { last, change_pct } | null
 *   clock, log, timeoutMs (30 s like the bot)
 */
function createAnalyzeShell(deps = {}) {
  const clock = deps.clock || (() => Date.now() / 1000);
  const log = deps.log || require('../../utils/logger');
  const kv = deps.kv || require('../engineKvService');
  const ts = () => require('../traderSettingsService');
  const planLimit = deps.planLimit || ((user) => ts().planLimit(user, 'analyze_per_day'));
  const isPro = deps.isPro || ((user) => ts().isPro(user));
  const timeoutMs = deps.timeoutMs || 30_000;
  const last = new Map();

  const dayKey = (uid, now) => `analyze_count_${uid}_${Math.floor(Math.trunc(now) / 86400)}`;

  /** _analyze_allowed(user) → null | "rate_limited" (10 s cooldown, then the daily quota). */
  async function analyzeAllowed(user, now = null) {
    const t = now === null || now === undefined ? clock() : now;
    const uid = user.user_id;
    if (t - (last.has(uid) ? last.get(uid) : 0.0) < ANALYZE_COOLDOWN_S) return 'rate_limited';
    let limit;
    try {
      limit = Math.trunc(Number(planLimit(user)));
      if (!Number.isFinite(limit)) throw new Error('bad limit');
    } catch (_e) {
      let pro = false;
      try { pro = Boolean(isPro(user)); } catch (_e2) { pro = false; }
      limit = pro ? 999 : 1;
    }
    if (limit < 999) {
      const v = await kv.get(dayKey(uid, t));
      // db_count_user_analyzes_today: int(val) if val else 0 — a value int() rejects raises (→ HTTP 500)
      const count = v ? pyIntStrict(v) : 0;
      if (count >= limit) return 'rate_limited';
      await kv.incrDay('analyze_count', uid, { now: Math.trunc(t) });
    }
    last.set(uid, t);
    return null;
  }

  const withTimeout = (p) => Promise.race([
    p, new Promise((_, rej) => { const h = setTimeout(() => rej(new Error('timeout')), timeoutMs); if (h.unref) h.unref(); }),
  ]);

  /**
   * POST analyze for one user → the Mini App JSON:
   * { ok, symbol, price: {price, change_pct} | null, signal: {strategy, direction, entry, sl,
   *   tp1..3, quality, setup, reasons, bars_ago} | null, tried, chart } or { ok: false, error }.
   */
  async function analyze(user, body, now = null) {
    const t = now === null || now === undefined ? clock() : now;
    const parsed = parseAnalyzeBody(body || {});
    if (parsed.error) return { status: 400, body: { ok: false, error: parsed.error } };
    const err = await analyzeAllowed(user, t);
    if (err) return { status: 200, body: { ok: false, error: err } };
    if (typeof deps.fetch !== 'function') return { status: 200, body: { ok: false, error: 'timeout' } };
    const { symbol, strategy } = parsed;
    const fetch = (sym, tf, limit) => deps.fetch(`${sym}-USDT-SWAP`, tf, limit);
    let out; let price;
    try {
      [out, price] = await withTimeout(Promise.all([
        analyzeCoin(symbol, strategy, fetch, { log }),
        typeof deps.price24h === 'function' ? deps.price24h(`${symbol}-USDT-SWAP`) : Promise.resolve(null),
      ]));
    } catch (e) {
      if (e.message !== 'timeout') log.warn(`[MINIAPP] analyze ${symbol} ${strategy}: ${e.message}`);
      return { status: 200, body: { ok: false, error: 'timeout' } };
    }
    const sig = out.signal;
    log.info(`[MINIAPP] analyze uid=${user.user_id} ${symbol} ${strategy} → ${sig ? sig.strategy : 'none'}`);
    let signal = null;
    if (sig) {
      signal = {};
      for (const k of ['strategy', 'direction', 'entry', 'sl', 'tp1', 'tp2', 'tp3', 'quality', 'setup', 'reasons', 'bars_ago']) {
        signal[k] = sig[k] === undefined ? null : sig[k];
      }
    }
    // render_signal_chart(out["df"], symbol=f"{symbol}-USDT-SWAP", …, quality=str(quality), tier="pro",
    // timeframe="1h") — D3: the chart as data (chartPayload.js) next to `png: null`
    let chart = null;
    if (sig && out.df) {
      try {
        chart = require('./chartPayload').chartPayload(out.df, {
          symbol: `${symbol}-USDT-SWAP`, direction: sig.direction, entry: sig.entry, sl: sig.sl, tp1: sig.tp1,
          tp2: sig.tp2, tp3: sig.tp3, strategy: sig.strategy, quality: String(sig.quality), tier: 'pro', timeframe: '1h',
        }, { warning: (m) => log.warn(m) });
      } catch (e) {
        log.debug(`[MINIAPP] analyze chart ${symbol}: ${e.message}`);
        chart = null;
      }
    }
    const { pyRound } = require('../../strategies/common/pyround');
    return {
      status: 200,
      body: {
        ok: true, symbol,
        price: price ? { price: Number(price.last || 0), change_pct: pyRound(Number(price.change_pct || 0), 2) } : null,
        signal, tried: out.tried || [], png: null, ...(chart || {}),
      },
    };
  }

  return { analyzeAllowed, analyze, _last: last };
}

/** Production fetch over BingX REST (services/marketData/bingxRest). */
function restFetch(rest = null) {
  return (symbol, tf, limit) => (rest || require('../marketData/bingxRest').getRest()).getCandles(symbol, tf, limit);
}

module.exports = {
  STRATEGIES, LABELS, LOOKBACK, MIN_BARS, ANALYZE_COOLDOWN_S, SYMBOL_RE,
  levelsSetup, smcSetup, volumeSetup, stillValid, sliceUpto, runStrategy, autoKey, pickBest, analyzeCoin,
  formatStrategyResult, noSetupText, parseAnalyzeBody, createAnalyzeShell, restFetch, lstripChars, pyStrip,
};
