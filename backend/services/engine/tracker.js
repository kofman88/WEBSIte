'use strict';
/**
 * tracker.js — the pure half of the bot's `signal_tracker.py` (signal-pipeline.md §11):
 * constants, the levels model, bar replay, the `could_change` pre-filter, TF pick,
 * notification / card-outcome texts, mark-to-market and MISSED arithmetic, the
 * chart window. No clock, no DB, no network: every function takes its inputs and
 * (where the bot reads `time.time()`) a `now` argument. `signalTracker.js` drives
 * these against `signal_trades` on the 60 s cadence.
 *
 * Quirks kept on purpose (PORT_DECISIONS D6 lists none here):
 *   • the fill bar of an SMC zone entry counts SL but never TP1 (§11.5);
 *   • SL wins over TP1 inside one bar before TP1, TP wins over BE after TP1;
 *   • `_pick_tfs` has two identical branches (≤ 20 h / ≤ 70 h → ("15m","1H"));
 *   • `_fmt_r` uses Python's banker's round; `_ago` prints minutes when nothing else.
 */

const { pyFloat, pyInt } = require('./pycoerce');
const { pyRound, pyRoundInt, pyFloorDiv, pyMax, pyMin } = require('../../strategies/common/pyround');
const { fmtFixed, fmtSigned, smartFormat } = require('../../strategies/common/pyfmt');
const { signalRr } = require('./signalOutcome');

// ── env & constants (§11.1) ─────────────────────────────────────────────────

function envFloat(env, name, dflt) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return dflt;
  try { return pyFloat(raw); } catch (_e) { return dflt; }
}

/** signal_tracker module constants read from the environment (bot defaults). */
function readConfig(env = process.env) {
  const rawEnabled = env.SIGNAL_TRACKER_ENABLED;
  const enabledRaw = String(rawEnabled === undefined || rawEnabled === null || rawEnabled === '' ? '1' : rawEnabled).trim();
  return Object.freeze({
    ENABLED: !['0', 'false', 'off'].includes(enabledRaw),
    INTERVAL_S: Math.max(15.0, envFloat(env, 'SIGNAL_TRACKER_INTERVAL_S', 60.0)),
    MAX_AGE_H: Math.max(1.0, envFloat(env, 'SIGNAL_TRACKER_MAX_AGE_H', 72.0)),
    SEND_DELAY_S: Math.max(0.0, envFloat(env, 'SIGNAL_TRACKER_SEND_DELAY_S', 0.05)),
    REST_PER_CYCLE: Math.trunc(Math.max(0.0, envFloat(env, 'SIGNAL_TRACKER_REST_PER_CYCLE', 20.0))),
    MAX_ROWS: Math.trunc(Math.max(100.0, envFloat(env, 'SIGNAL_TRACKER_MAX_ROWS', 20000.0))),
    MAX_EVENT_LAG_H: Math.max(0.5, envFloat(env, 'SIGNAL_TRACKER_MAX_EVENT_LAG_H', 6.0)),
    MISSED_R: Math.max(0.3, envFloat(env, 'SIGNAL_MISSED_R', 1.0)),
    MISSED_MIN_AGE_S: Math.max(60.0, envFloat(env, 'SIGNAL_MISSED_MIN_AGE_S', 900.0)),
  });
}

const CONFIG = readConfig();

// Stages
const NONE = '';
const ENTRY = 'ENTRY';
const TP1 = 'TP1';
const TP2 = 'TP2';
const TP3 = 'TP3';
const SL = 'SL';
const BE = 'BE';
const EXPIRED = 'EXPIRED';
const MISSED = 'MISSED';
const FINAL = Object.freeze(new Set([TP3, SL, BE, EXPIRED, MISSED]));
const TP_ORDER = Object.freeze([TP1, TP2, TP3]);

const TF_SEC = Object.freeze({
  '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
  '1H': 3600, '2H': 7200, '4H': 14400, '1D': 86400,
});
const TF_NORM = Object.freeze({
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1H', '1H': '1H', '2h': '2H', '2H': '2H', '4h': '4H', '4H': '4H', '1d': '1D', '1D': '1D',
});

// [CARD-OUTCOME]
const CARD_MARK = '\n\n📌 ';
const CARD_MAX_JSON = 12000;
const CARD_MAX_TEXT = 4000;

const OUTCOME_LINE = Object.freeze({
  ru: Object.freeze({
    [TP1]: '🎯 TP1 достигнут · {rr} (стоп → безубыток)',
    [TP2]: '🎯 TP2 достигнут · {rr}',
    [TP3]: '✅ TP3 достигнут · {rr}',
    [SL]: '❌ Стоп · {rr}',
    [BE]: '⚖️ Закрыт в безубыток · {rr}',
    [EXPIRED]: '⏱ Закрыт по времени (72ч) · {rr}',
    [MISSED]: '⛔ Не входить — цена ушла без отката ({rr} без входа)',
  }),
  en: Object.freeze({
    [TP1]: '🎯 TP1 hit · {rr} (stop → break-even)',
    [TP2]: '🎯 TP2 hit · {rr}',
    [TP3]: '✅ TP3 hit · {rr}',
    [SL]: '❌ Stopped out · {rr}',
    [BE]: '⚖️ Closed at break-even · {rr}',
    [EXPIRED]: '⏱ Closed on time (72h) · {rr}',
    [MISSED]: '⛔ Do not enter — price ran away without a pullback ({rr} unfilled)',
  }),
});

// ── small Python helpers ────────────────────────────────────────────────────

/** Python falsiness of a row value (`x or 0`). */
function falsy(v) {
  return v === null || v === undefined || v === false || v === 0 || v === '';
}

/** float(t.get(k) or 0) */
function fOr0(v) {
  return falsy(v) ? 0.0 : pyFloat(v);
}

/** str(x or dflt) */
function sOr(v, dflt = '') {
  return falsy(v) ? dflt : String(v);
}

/** html.escape(s) (quote=True): & < > " ' */
function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// str.isspace() code points (CPython _PyUnicode_IsWhitespace) — note U+FEFF is NOT one,
// unlike JS \s; U+001C..U+001F and U+0085 are.
const PY_SPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

/** Python str.rstrip() (whitespace). */
function rstrip(s) {
  const str = String(s);
  let end = str.length;
  while (end > 0 && PY_SPACE.has(str.charCodeAt(end - 1))) end--;
  return str.slice(0, end);
}

/** len(str) in code points, like Python. */
function pyLen(s) {
  let n = 0;
  for (const _ch of String(s)) n++; // eslint-disable-line no-unused-vars
  return n;
}

// ── Levels model (§11.4) ────────────────────────────────────────────────────

function isLong(L) { return String(L.direction).toUpperCase() === 'LONG'; }

function tpOf(L, stage) {
  if (stage === TP1) return L.tp1;
  if (stage === TP2) return L.tp2;
  if (stage === TP3) return L.tp3;
  return 0.0;
}

function valid(L) {
  if (Math.min(L.entry, L.sl, L.tp1) <= 0) return false;
  if (isLong(L)) return L.sl < L.entry && L.entry < L.tp1;
  return L.tp1 < L.entry && L.entry < L.sl;
}

function risk(L) { return Math.abs(L.entry - L.sl); }

function rOf(L, price) {
  const r = risk(L);
  if (r <= 0 || price <= 0) return 0.0;
  return Math.abs(price - L.entry) / r;
}

function makeLevels({ direction, entry, sl, tp1, tp2, tp3, needs_fill = false, fill_lo = 0.0, fill_hi = 0.0 }) {
  return { direction, entry, sl, tp1, tp2, tp3, needs_fill, fill_lo, fill_hi };
}

/** levels_from_trade(t): original_sl when > 0 else sl; zone [entry_lo, entry_hi] ⇒ needs_fill. */
function levelsFromTrade(t) {
  let sl;
  try {
    const osl = t.original_sl;
    sl = (osl !== null && osl !== undefined && pyFloat(osl) > 0) ? pyFloat(osl) : fOr0(t.sl);
  } catch (_e) {
    sl = 0.0;
  }
  let lo = fOr0(t.entry_lo);
  let hi = fOr0(t.entry_hi);
  if (lo > hi) { const tmp = lo; lo = hi; hi = tmp; }
  const needsFill = lo > 0 && hi > 0 && hi > lo;
  return makeLevels({
    direction: sOr(t.direction, 'LONG').toUpperCase(),
    entry: fOr0(t.entry), sl,
    tp1: fOr0(t.tp1), tp2: fOr0(t.tp2), tp3: fOr0(t.tp3),
    needs_fill: needsFill, fill_lo: lo, fill_hi: hi,
  });
}

// ── Bar replay (§11.5) ──────────────────────────────────────────────────────

/** _process_bar(stage, hi, lo, full, L) → events (stage transitions inside one bar). */
function processBar(stage, hi, lo, full, L) {
  const ev = [];
  const up = isLong(L);
  const reached = (price) => price > 0 && (up ? hi >= price : lo <= price);   // favourable touch
  const stopped = (price) => price > 0 && (up ? lo <= price : hi >= price);   // adverse touch

  // waiting for the fill (SMC zone)
  if (stage === NONE && L.needs_fill) {
    const touched = up ? (lo <= L.fill_hi) : (hi >= L.fill_lo);
    if (!touched) return ev;
    ev.push(ENTRY);
    if (stopped(L.sl)) ev.push(SL);
    return ev;                                   // QUIRK(§11.5): TP is not counted in the fill bar
  }

  let justHit;
  if (stage === NONE || stage === ENTRY) {
    if (stopped(L.sl)) {                         // SL first (conservative)
      ev.push(SL);
      return ev;
    }
    if (!full || !reached(L.tp1)) return ev;     // TP1 never in a partially counted bar
    ev.push(TP1);
    stage = TP1;
    justHit = true;
  } else {
    justHit = false;
  }

  // after TP1: stop at break-even, TP-first
  if (stage === TP1 || stage === TP2) {
    const idx = TP_ORDER.indexOf(stage);
    for (const nxt of TP_ORDER.slice(idx + 1)) {
      if (reached(tpOf(L, nxt))) {
        ev.push(nxt);
        stage = nxt;
        justHit = true;
      } else {
        break;
      }
    }
    if (stage !== TP3 && full && !justHit && stopped(L.entry)) ev.push(BE);
  }
  return ev;
}

/**
 * replay(L, bars, stage, progress_ts, created_at, tf_sec) → { stage, progressTs, events }.
 * bars: [[open_ts_s, high, low, ...], ...] ascending.
 */
function replay(L, bars, stage, progressTs, createdAt, tfSec) {
  stage = stage || NONE;
  const events = [];
  for (const b of bars) {
    const t = Number(b[0]);
    if (FINAL.has(stage)) break;
    let full;
    if (stage === NONE) {
      if (t <= createdAt) continue;              // the signal bar and earlier
      full = true;
    } else {
      if (t + tfSec <= progressTs) continue;     // bars before the transition bar
      full = t > progressTs;                     // false ⇒ the transition bar itself
    }
    const ev = processBar(stage, Number(b[1]), Number(b[2]), full, L);
    if (ev.length) {
      events.push(...ev);
      stage = ev[ev.length - 1];
      progressTs = full ? t : progressTs;
    }
  }
  return { stage, progressTs, events };
}

/** could_change(L, stage, hmax, lmin): cheap pre-filter over the extremes after the last transition. */
function couldChange(L, stage, hmax, lmin) {
  const up = isLong(L);
  const reached = (p) => p > 0 && (up ? hmax >= p : lmin <= p);
  const stopped = (p) => p > 0 && (up ? lmin <= p : hmax >= p);
  if (stage === NONE && L.needs_fill) return up ? (lmin <= L.fill_hi) : (hmax >= L.fill_lo);
  if (stage === NONE || stage === ENTRY) return stopped(L.sl) || reached(L.tp1);
  if (stage === TP1 || stage === TP2) {
    const nxt = TP_ORDER[TP_ORDER.indexOf(stage) + 1];
    return reached(tpOf(L, nxt)) || stopped(L.entry);
  }
  return false;
}

// ── Candles (§11.5 bars_from_df / §11.6) ────────────────────────────────────

/**
 * bars_from_df: a Frame ({t ms, h, l, c}) or an array of [t_sec, high, low(, close)]
 * → [[open_ts_s, high, low, close], ...] ascending, NaN rows dropped.
 */
function barsFromFrame(frame) {
  if (!frame) return [];
  const out = [];
  if (Array.isArray(frame)) {
    for (const b of frame) {
      const t = Number(b[0]); const h = Number(b[1]); const l = Number(b[2]);
      if (Number.isNaN(t) || Number.isNaN(h) || Number.isNaN(l)) continue;
      out.push([t, h, l, b.length > 3 ? Number(b[3]) : NaN]);
    }
  } else {
    const n = frame.length || 0;
    for (let i = 0; i < n; i++) {
      const t = frame.t[i] / 1000; const h = frame.h[i]; const l = frame.l[i];
      if (Number.isNaN(t) || Number.isNaN(h) || Number.isNaN(l)) continue;
      out.push([t, h, l, frame.c ? frame.c[i] : NaN]);
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/** _covers(df, need_from): the first bar opens at or before need_from. */
function covers(bars, needFrom) {
  return bars.length > 0 && bars[0][0] <= needFrom;
}

/** _pick_tfs(age_s): candidate TFs (cache coverage: 300 × 15m = 75 h, 300 × 1H = 12.5 d). */
function pickTfs(ageS) {
  if (ageS <= 20 * 3600) return ['15m', '1H'];
  if (ageS <= 70 * 3600) return ['15m', '1H'];     // QUIRK: identical branch kept verbatim
  return ['1H'];
}

/**
 * _chart_df(df, created_at, tf_sec): the chart window — ~40 bars before the signal plus
 * everything after, n_keep = max(30, min(160, #bars opening ≥ created − 40·tf)), then
 * df.tail(n_keep). Returns the kept bars; no bars → the input as is (the bot returns df).
 */
function chartTail(bars, createdAt, tfSec) {
  if (!bars || !bars.length) return bars;
  const start = createdAt - 40 * tfSec;
  let nKeep = 0;
  for (const b of bars) if (b[0] >= start) nKeep++;
  nKeep = Math.max(30, Math.min(160, nKeep));
  return bars.slice(Math.max(0, bars.length - nKeep));
}

/** len(_chart_df(...)); null when there are no bars. */
function chartWindow(bars, createdAt, tfSec) {
  if (!bars || !bars.length) return null;
  return chartTail(bars, createdAt, tfSec).length;
}

/** Mask of §11.6 step 4: bars after the signal (stage '') or overlapping the transition bar. */
function extremesAfter(bars, stage0, createdAt, progressTs, tfSec) {
  let hmax = -Infinity; let lmin = Infinity; let any = false;
  for (const b of bars) {
    const inMask = stage0 === NONE ? (b[0] > createdAt) : (b[0] + tfSec > progressTs);
    if (!inMask) continue;
    any = true;
    if (b[1] > hmax) hmax = b[1];
    if (b[2] < lmin) lmin = b[2];
  }
  return any ? { hmax, lmin } : null;
}

// ── Texts (§11.7) ───────────────────────────────────────────────────────────

/** chart_renderer._smart_format(float(p)) with the f"{p:.6g}" fallback. */
function fmtPrice(p) {
  try { return smartFormat(pyFloat(p)); } catch (_e) { return String(p); }
}

/** _fmt_r: whole numbers without decimals, else one decimal stripped. */
function fmtR(r) {
  if (Math.abs(r - pyRoundInt(r)) > 1e-9) return fmtFixed(r, 1).replace(/0+$/, '').replace(/\.$/, '');
  return String(pyRoundInt(r));
}

/** _ago(seconds, lang): "{d}д {h}ч {m}м" / "{d}d {h}h {m}m", zero parts omitted, minutes shown when nothing else. */
function ago(seconds, lang) {
  let m = Math.max(0, Math.trunc(pyFloorDiv(Number(seconds), 60)));
  let h = Math.floor(m / 60); m -= h * 60;
  const d = Math.floor(h / 24); h -= d * 24;
  const parts = lang === 'en'
    ? [d ? `${d}d` : '', h ? `${h}h` : '', (m || !(d || h)) ? `${m}m` : '']
    : [d ? `${d}д` : '', h ? `${h}ч` : '', (m || !(d || h)) ? `${m}м` : ''];
  return parts.filter((p) => p).join(' ');
}

/** build_text(trade, L, event, hit, lang, now) — the progress notification (HTML). */
function buildText(trade, L, event, hit, lang = 'ru', now = null) {
  const en = (lang || 'ru') === 'en';
  const sym = sOr(trade.symbol).replace(/-USDT-SWAP/g, '').replace(/-USDT/g, '');
  const head = `<b>${htmlEscape(sym)} ${htmlEscape(L.direction)}</b>`;
  const strat = htmlEscape(sOr(trade.strategy).toUpperCase() || '—');
  const tf = htmlEscape(sOr(trade.timeframe));
  const tps = hit.filter((h) => TP_ORDER.includes(h));
  const rTxt = (st) => fmtR(rOf(L, tpOf(L, st)));

  let line;
  if (event === TP1) {
    line = en
      ? `✅ ${head} — TP1 reached (+${rTxt(TP1)}R)\n🛡 Stop moved to breakeven (${fmtPrice(L.entry)})`
      : `✅ ${head} — TP1 достигнут (+${rTxt(TP1)}R)\n🛡 Стоп переведён в безубыток (${fmtPrice(L.entry)})`;
  } else if (event === TP2) {
    line = en
      ? `🎯 ${head} — TP2 reached (+${rTxt(TP2)}R)\n🛡 Stop at breakeven`
      : `🎯 ${head} — TP2 достигнут (+${rTxt(TP2)}R)\n🛡 Стоп в безубытке`;
  } else if (event === TP3) {
    line = en
      ? `🏆 ${head} — TP3 reached (+${rTxt(TP3)}R). Signal fully played out`
      : `🏆 ${head} — TP3 достигнут (+${rTxt(TP3)}R). Сигнал отработал полностью`;
  } else if (event === SL) {
    line = en ? `🛑 ${head} — SL hit (-1R)` : `🛑 ${head} — сработал SL (-1R)`;
  } else if (event === BE) {
    const last = tps.length ? tps[tps.length - 1] : TP1;
    line = en
      ? `⚪ ${head} — Breakeven: price returned to entry after ${last} (0R on the rest)`
      : `⚪ ${head} — Безубыток: цена вернулась к входу после ${last} (0R по остатку)`;
  } else {
    line = `ℹ️ ${head} — ${htmlEscape(String(event))}`;
  }

  const steps = ['📍 ' + (en ? 'Entry' : 'Вход')];
  for (const st of tps) steps.push((st === TP3 ? '🏆 ' : '✅ ') + st);
  if (event === SL) steps.push('🛑 SL');
  else if (event === BE) steps.push('⚪ ' + (en ? 'BE' : 'БУ'));
  const created = fOr0(trade.created_at);
  const info = `${strat}${tf ? ' · ' + tf : ''} · ${en ? 'entry' : 'вход'} ${fmtPrice(L.entry)} · SL ${fmtPrice(L.sl)}`;
  const lines = [line, '', info, steps.join(' → ')];
  if (created) {
    const t = falsy(now) ? Date.now() / 1000 : now;               // (now or time.time())
    const a = ago(t - created, en ? 'en' : 'ru');
    lines.push(en ? `⏱ ${a} after the signal` : `⏱ через ${a} после сигнала`);
  }
  lines.push(en ? '<i>Tracked by signal price, not an exchange position</i>'
    : '<i>Отслеживание по цене сигнала, не позиция на бирже</i>');
  return lines.join('\n');
}

// ── Card outcome (§11.8) ────────────────────────────────────────────────────

/** _fmt_outcome_r: '+2.0R' / '-1.0R' / '0R' / '—'. */
function fmtOutcomeR(rr) {
  if (rr === null || rr === undefined) return '—';
  return `${fmtSigned(rr, 1)}R`.replace('+0.0R', '0R').replace('-0.0R', '0R');
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function outcomeLine(stage, rr, lang = 'ru') {
  const table = OUTCOME_LINE[hasOwn(OUTCOME_LINE, lang) ? lang : 'ru'];
  const tpl = hasOwn(table, stage) ? table[stage] : '';
  return tpl ? tpl.replace('{rr}', fmtOutcomeR(rr)) : '';
}

function cardTextWithOutcome(html, line) {
  const base = rstrip(String(html).split(CARD_MARK)[0]);
  return base + CARD_MARK + line;
}

/**
 * The pure part of update_signal_card(bot, trade, stage, lang) up to the edit call:
 *   { result: 'skip' }  — no delivered card / no user / no or unparsable snapshot / empty
 *                          html / unknown stage / edited text > 4000 chars;
 *   { result: 'error' } — where the bot's outer `except Exception` fires before the edit
 *                          (int() of a non-numeric signal_msg_id / user_id, a snapshot that
 *                          parses to something without .get());
 *   { result: 'ok', line, rr, text, card } — what the bot would send to edit_message_text.
 * `trade.missed_rr` carries the MISSED distance; otherwise rr = signal_rr(§12.2) with the
 * stage forced and `result` blanked.
 */
function cardOutcome(trade, stage, lang = 'ru') {
  let mid; let uid;
  try {
    mid = pyInt(falsy(trade.signal_msg_id) ? 0 : trade.signal_msg_id);
    uid = pyInt(falsy(trade.user_id) ? 0 : trade.user_id);
  } catch (_e) {
    return { result: 'error' };
  }
  const raw = falsy(trade.signal_card_json) ? '' : trade.signal_card_json;
  if (!mid || !uid || !raw || !hasOwn(OUTCOME_LINE.ru, stage)) return { result: 'skip' };
  if (typeof raw !== 'string') return { result: 'skip' };          // json.loads(non-str) → TypeError
  let card;
  try { card = JSON.parse(raw); } catch (_e) { return { result: 'skip' }; }
  if (card === null || typeof card !== 'object' || Array.isArray(card)) return { result: 'error' };
  const html = sOr(card.html);
  if (!html) return { result: 'skip' };
  const rr = stage === MISSED
    ? (trade.missed_rr === undefined ? null : trade.missed_rr)
    : signalRr({ ...trade, progress_stage: stage, result: '' }, stage.toLowerCase());
  const line = outcomeLine(stage, rr, lang);
  const text = cardTextWithOutcome(html, line);
  if (pyLen(text) > CARD_MAX_TEXT) return { result: 'skip' };
  return { result: 'ok', line, rr, text, card };
}

/**
 * process_trade step 12: TPs reached before (stage0 ∈ TPs ⇒ TP1..stage0) followed by the
 * TPs among the new events; hit levels for the chart add the final SL / BE stage.
 */
function hitFor(stage0, events) {
  const prev = TP_ORDER.includes(stage0) ? TP_ORDER.slice(0, TP_ORDER.indexOf(stage0) + 1) : [];
  return prev.concat(events.filter((e) => TP_ORDER.includes(e)));
}

function hitLevelsFor(hit, stage) {
  return hit.concat(stage === SL || stage === BE ? [stage] : []);
}

// ── EXPIRED / MISSED arithmetic (§11.9, §11.10) ─────────────────────────────

/** mark_to_market_rr(trade, price): sign·(price − entry)/risk clamped to [−1, R to TP3] (10 when no TP3), 2 dp. */
function markToMarketRr(trade, price) {
  try {
    const entry = fOr0(trade.entry);
    const sl0 = fOr0(trade.original_sl) || fOr0(trade.sl);
    const rsk = Math.abs(entry - sl0);
    if (entry <= 0 || rsk <= 0 || falsy(price)) return null;
    const sign = sOr(trade.direction, 'LONG').toUpperCase() === 'LONG' ? 1.0 : -1.0;
    const rr = sign * (pyFloat(price) - entry) / rsk;
    const tp3 = fOr0(trade.tp3);
    const cap = tp3 > 0 ? Math.abs(tp3 - entry) / rsk : 10.0;
    return pyRound(pyMax(-1.0, pyMin(cap, rr)), 2);
  } catch (_e) {
    return null;
  }
}

/**
 * missed_r(L, highs, lows, close_last): R the price ran in the signal direction without
 * the zone ever being reached; null for market entries ([MISSED-MARKET]), when the
 * zone was touched, or when the run is < MISSED_R.
 */
function missedR(L, highs, lows, closeLast, missedRMin = CONFIG.MISSED_R) {
  const rsk = risk(L);
  if (rsk <= 0 || closeLast <= 0 || !lows || lows.length === 0) return null;
  if (!L.needs_fill) return null;
  let r;
  if (isLong(L)) {
    let minLow = Infinity; for (const x of lows) if (x < minLow) minLow = x;
    if (minLow <= L.fill_hi) return null;
    r = (closeLast - L.entry) / rsk;
  } else {
    let maxHigh = -Infinity; for (const x of highs) if (x > maxHigh) maxHigh = x;
    if (maxHigh >= L.fill_lo) return null;
    r = (L.entry - closeLast) / rsk;
  }
  return r >= missedRMin ? pyRound(r, 2) : null;
}

module.exports = {
  CONFIG, readConfig,
  NONE, ENTRY, TP1, TP2, TP3, SL, BE, EXPIRED, MISSED, FINAL, TP_ORDER, TF_SEC, TF_NORM,
  CARD_MARK, CARD_MAX_JSON, CARD_MAX_TEXT, OUTCOME_LINE,
  makeLevels, levelsFromTrade, isLong, tpOf, valid, risk, rOf,
  processBar, replay, couldChange, barsFromFrame, covers, pickTfs, chartTail, chartWindow, extremesAfter,
  hitFor, hitLevelsFor,
  fmtPrice, fmtR, ago, buildText, fmtOutcomeR, outcomeLine, cardTextWithOutcome, cardOutcome,
  markToMarketRr, missedR, htmlEscape, pyLen, falsy, fOr0, sOr,
};
