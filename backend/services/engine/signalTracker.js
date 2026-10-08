'use strict';
/**
 * signalTracker.js — the loop half of the bot's `signal_tracker.py` + `db/signal_progress.py`
 * (signal-pipeline.md §11): every 60 s, over the delivered signals without an exchange order
 * (`signal_trades.signal_msg_id > 0`, `order_id = ''`), replay the candles since the last
 * transition, CAS-advance `progress_stage` / `progress_ts` BEFORE notifying (at-most-once),
 * write the card outcome line, and send the progress notice. Also: MISSED (zone entries only,
 * ≥ 1R past 900 s) and EXPIRED (72 h, mark-to-market R clamped to [−1, R to TP3]).
 *
 * Site mapping of the Telegram side (PLAN §2.4, D2/D3):
 *   • "card edit" (update_signal_card) → `signal_trades.signal_card_json` gets the edited html
 *     (`… \n\n📌 <line>`) plus `{outcome: {stage, line, rr}}`, and an SSE `progress` event —
 *     silently, regardless of the progress toggle and of the event lag (like the bot);
 *   • "send_progress" (reply to the card) → notifier.dispatch(type 'progress', text verbatim,
 *     link `/app/?tab=signals&id=<trade_id>`, `silent` = quiet hours); `user_not_found`
 *     (deleted / inactive account) plays the role of TelegramForbidden → "blocked";
 *   • the PNG is rendered by the client (D3): instead of `png` the notice carries the chart
 *     descriptor (`render_progress_chart` arguments + the candle window) when
 *     `send_chart_enabled`.
 *
 * Candles come from an injectable provider:
 *   { getCandles(symbol, tf) → Frame | bars | null      (cache, like cache.get_candles)
 *     fetchCandles(symbol, tf, limit) → Frame | null    (REST fallback, budget per cycle)
 *     currentPrice(symbol) → number | null }            (signal_freshness.get_current_price)
 * Production: services/marketData (candleCache + bingxRest); tests: golden Frames.
 *
 * Markers (grep contract): [SIGNAL-PROGRESS] [SIGNAL-PROGRESS-SEND] [SIGNAL-PROGRESS-CYCLE]
 * [CARD-OUTCOME] [SIGNAL-MISSED] [SIGNAL-MISSED-CYCLE] [SIGNAL-EXPIRE] [SIGNAL-EXPIRE-CYCLE].
 */

const T = require('./tracker');
const { pyFloat, pyInt } = require('./pycoerce');
const { fmtFixed, fmtSigned, fmtG } = require('../../strategies/common/pyfmt');
const quietHours = require('./quietHours');

// ═══════════════════════════════════════════════════════════════════════
//  db/signal_progress.py on signal_trades
// ═══════════════════════════════════════════════════════════════════════

const FINAL_STAGES = Object.freeze(['BE', 'EXPIRED', 'MISSED', 'SL', 'TP3']);       // sorted(FINAL_STAGES)
const STOP_RESULTS = Object.freeze(['TP1', 'TP2', 'TP3', 'SL', 'BE', 'MANUAL', 'TRAIL']);

const TRACK_COLS = 'trade_id, user_id, symbol, direction, entry, sl, original_sl, '
  + '       tp1, tp2, tp3, entry_lo, entry_hi, timeframe, strategy, '
  + '       created_at, signal_msg_id, progress_stage, progress_ts, '
  + '       result, order_id, signal_card_json, expire_rr ';
const EXPIRE_COLS = 'trade_id, user_id, symbol, direction, entry, sl, original_sl, '
  + '       tp1, tp2, tp3, timeframe, strategy, created_at, signal_msg_id, '
  + '       progress_stage, progress_ts, result, order_id, signal_card_json, expire_rr ';

function createRepo(db) {
  const ph = (n) => new Array(n).fill('?').join(',');
  return {
    /** db_set_signal_msg_id(trade_id, message_id, card_json='') */
    setSignalMsgId(tradeId, messageId, cardJson = '') {
      if (!tradeId || !messageId) return;
      if (cardJson) {
        db.prepare('UPDATE signal_trades SET signal_msg_id=?, signal_card_json=? WHERE trade_id=?')
          .run(pyInt(messageId), String(cardJson), String(tradeId));
      } else {
        db.prepare('UPDATE signal_trades SET signal_msg_id=? WHERE trade_id=?').run(pyInt(messageId), String(tradeId));
      }
    },
    /** db_get_trackable_signals(since_ts, limit=3000) */
    getTrackableSignals(sinceTs, limit = 3000) {
      return db.prepare(
        `SELECT ${TRACK_COLS}FROM signal_trades `
        + 'WHERE signal_msg_id > 0 AND created_at >= ? '
        + "  AND (order_id = '' OR order_id IS NULL) "
        + `  AND COALESCE(progress_stage, '') NOT IN (${ph(FINAL_STAGES.length)}) `
        + `  AND COALESCE(result, '') NOT IN (${ph(STOP_RESULTS.length)}) `
        + 'ORDER BY created_at DESC LIMIT ?',
      ).all(pyFloat(sinceTs), ...FINAL_STAGES, ...STOP_RESULTS, Math.trunc(limit));
    },
    /** db_get_expire_candidates(now, max_age_s, grace_s=86400, limit=500) */
    getExpireCandidates(now, maxAgeS, graceS = 86400.0, limit = 500) {
      return db.prepare(
        `SELECT ${EXPIRE_COLS}FROM signal_trades `
        + 'WHERE signal_msg_id > 0 AND created_at >= ? AND created_at < ? '
        + "  AND (order_id = '' OR order_id IS NULL) "
        + `  AND COALESCE(progress_stage, '') NOT IN (${ph(FINAL_STAGES.length)}) `
        + `  AND COALESCE(result, '') NOT IN (${ph(STOP_RESULTS.length)}) `
        + 'ORDER BY created_at LIMIT ?',
      ).all(now - maxAgeS - graceS, now - maxAgeS, ...FINAL_STAGES, ...STOP_RESULTS, Math.trunc(limit));
    },
    /** db_mark_signal_expired(trade_id, expected_stage, rr, progress_ts) — CAS → EXPIRED */
    markSignalExpired(tradeId, expectedStage, rr, progressTs) {
      return db.prepare(
        "UPDATE signal_trades SET progress_stage='EXPIRED', progress_ts=?, expire_rr=? "
        + "WHERE trade_id=? AND COALESCE(progress_stage, '')=?",
      ).run(pyFloat(progressTs), pyFloat(rr), String(tradeId), String(expectedStage || '')).changes > 0;
    },
    /** db_advance_signal_progress(trade_id, expected_stage, new_stage, progress_ts) — CAS */
    advanceSignalProgress(tradeId, expectedStage, newStage, progressTs) {
      return db.prepare(
        'UPDATE signal_trades SET progress_stage=?, progress_ts=? '
        + "WHERE trade_id=? AND COALESCE(progress_stage, '')=?",
      ).run(String(newStage), pyFloat(progressTs), String(tradeId), String(expectedStage || '')).changes > 0;
    },
    /** site: the edited card snapshot (replaces bot.edit_message_text). */
    saveCard(tradeId, cardJson) {
      return db.prepare('UPDATE signal_trades SET signal_card_json=? WHERE trade_id=?')
        .run(String(cardJson), String(tradeId)).changes > 0;
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  _CandleSource — per-cycle memo, cache → REST fallback with a budget
// ═══════════════════════════════════════════════════════════════════════

function frameLen(df) {
  if (!df) return 0;
  return Array.isArray(df) ? df.length : (df.length || 0);
}

function firstRow(df) {
  if (Array.isArray(df)) return df.slice(0, 1);
  return typeof df.slice === 'function' ? df.slice(0, 1) : df;
}

/** _covers(df, need_from): the first bar (NaN rows dropped) opens at or before need_from. */
function covers(df, needFrom) {
  if (!df || frameLen(df) === 0) return false;
  try {
    const b = T.barsFromFrame(firstRow(df));
    return b.length > 0 && b[0][0] <= needFrom;
  } catch (_e) {
    return false;
  }
}

/** df["close"].iloc[-1] */
function lastClose(df) {
  const n = frameLen(df);
  if (!n) return null;
  if (Array.isArray(df)) { const b = df[n - 1]; return b.length > 3 ? Number(b[3]) : null; }
  return df.c ? df.c[n - 1] : null;
}

class CandleSource {
  constructor(provider = {}, { restBudget = T.CONFIG.REST_PER_CYCLE, log = null } = {}) {
    this.provider = provider || {};
    this.restLeft = restBudget;
    this.log = log;
    this._memo = new Map();
    this._bars = new Map();
  }

  async get(symbol, tf, needFrom) {
    const key = `${symbol}\u0000${tf}`;
    let df;
    if (this._memo.has(key)) {
      df = this._memo.get(key);
    } else {
      df = null;
      try {
        if (typeof this.provider.getCandles === 'function') df = await this.provider.getCandles(symbol, tf);
      } catch (e) {
        if (this.log) this.log.debug(`[SIGNAL-PROGRESS] cache ${symbol}/${tf}: ${e.message}`);
        df = null;
      }
      if (!covers(df, needFrom) && typeof this.provider.fetchCandles === 'function' && this.restLeft > 0) {
        this.restLeft -= 1;
        try {
          const df2 = await this.provider.fetchCandles(symbol, tf, 300);
          if (df2 && frameLen(df2) > 0) df = df2;
        } catch (e) {
          if (this.log) this.log.debug(`[SIGNAL-PROGRESS] REST ${symbol}/${tf}: ${e.message}`);
        }
      }
      this._memo.set(key, df);
    }
    return covers(df, needFrom) ? df : null;
  }

  /** Current price: signal_freshness price, else the last 1H close covering now − 2 h. */
  async lastPrice(symbol, now) {
    try {
      if (typeof this.provider.currentPrice === 'function') {
        const px = await this.provider.currentPrice(symbol);
        if (px) return pyFloat(px);
      }
    } catch (e) {
      if (this.log) this.log.debug(`[SIGNAL-EXPIRE] price ${symbol}: ${e.message}`);
    }
    const df = await this.get(symbol, '1H', now - 7200);
    try {
      return df && frameLen(df) ? lastClose(df) : null;
    } catch (_e) {
      return null;
    }
  }

  /** bars memo per (symbol, tf) for the same df object. */
  bars(symbol, tf, df) {
    const key = `${symbol}\u0000${tf}`;
    const hit = this._bars.get(key);
    if (hit && hit.df === df) return hit.arr;
    const b = T.barsFromFrame(df);
    const arr = { bars: b, t: b.map((x) => x[0]), h: b.map((x) => x[1]), l: b.map((x) => x[2]), lastClose: lastClose(df) };
    this._bars.set(key, { df, arr });
    return arr;
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  delivery (site side of update_signal_card / send_progress)
// ═══════════════════════════════════════════════════════════════════════

const pyBoolStr = (b) => (b ? 'True' : 'False');
const pyStr = (v) => (v === null || v === undefined ? 'None' : String(v));
const sOr = (v, d = '') => (v === null || v === undefined || v === '' || v === 0 || v === false ? d : String(v));
const fOr0 = (v) => (v === null || v === undefined || v === '' || v === 0 || v === false ? 0.0 : pyFloat(v));
const uidOf = (t) => { try { return pyInt(t.user_id === null || t.user_id === undefined || t.user_id === '' || t.user_id === 0 ? 0 : t.user_id); } catch (_e) { return 0; } };

/** First line of a notice with the tags stripped (the in-app title). */
function noticeTitle(text) {
  const first = String(text).split('\n')[0];
  return first.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&amp;/g, '&').slice(0, 200);
}

function signalLink(tradeId) {
  return `/app/?tab=signals&id=${encodeURIComponent(String(tradeId || ''))}`;
}

// ═══════════════════════════════════════════════════════════════════════
//  the tracker
// ═══════════════════════════════════════════════════════════════════════

/**
 * createSignalTracker(deps):
 *   db          better-sqlite3 handle (signal_trades)            — or `repo`
 *   provider    candle provider (see the header)
 *   getUser     uid → trader settings object | null (sync or async; traderSettingsService.get)
 *   notifier    { dispatch(uid, opts) } (services/notifier)
 *   sse         { broadcast(uid, event, data) } (services/sseService), optional
 *   log         { info, debug, warn }
 *   config      tracker.readConfig() result (env constants)
 *   sleep       ms → Promise (SEND_DELAY_S / retry pauses)
 *   clock       () → unix seconds
 */
function createSignalTracker(deps = {}) {
  const config = deps.config || T.CONFIG;
  const repo = deps.repo || createRepo(deps.db);
  const log = deps.log || require('../../utils/logger');
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const clock = deps.clock || (() => Date.now() / 1000);
  const getUserFn = deps.getUser || ((uid) => require('../traderSettingsService').get(uid));
  const notifier = deps.notifier || require('../notifier');
  const sse = deps.sse === undefined ? require('../sseService') : deps.sse;
  const blockedUsers = new Set();
  let timer = null;
  let running = false;

  const debug = (m) => (log.debug ? log.debug(m) : undefined);

  async function getUser(uid, memo) {
    if (memo.has(uid)) return memo.get(uid);
    let user = null;
    try {
      user = await getUserFn(uid);
    } catch (e) {
      debug(`[SIGNAL-PROGRESS] user ${uid}: ${e.message}`);
      user = null;
    }
    memo.set(uid, user === undefined ? null : user);
    return memo.get(uid);
  }

  /** update_signal_card(bot, trade, stage, lang) → ok | skip | blocked | error */
  async function updateSignalCard(trade, stage, lang = 'ru') {
    try {
      const r = T.cardOutcome(trade, stage, lang);
      if (r.result !== 'ok') return r.result;
      const uid = uidOf(trade);
      const snapshot = { ...r.card, html: r.text, outcome: { stage, line: r.line, rr: r.rr } };
      repo.saveCard(trade.trade_id, JSON.stringify(snapshot));
      if (sse && typeof sse.broadcast === 'function') {
        sse.broadcast(uid, 'progress', { trade_id: trade.trade_id, kind: 'card', stage, outcome_line: r.line, rr: r.rr, html: r.text });
      }
      return 'ok';
    } catch (e) {
      debug(`[CARD-OUTCOME] edit tid=${pyStr(trade.trade_id)}: ${e.name}: ${e.message}`);
      return 'error';
    }
  }

  /** send_progress(bot, uid, text, png, reply_to, silent) → ok | blocked | failed */
  async function sendProgress(uid, text, { trade, stage, chart, silent }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await notifier.dispatch(uid, {
          type: 'progress',
          title: noticeTitle(text),
          body: text,
          tgText: text,
          link: signalLink(trade.trade_id),
          silent: Boolean(silent),
          data: { trade_id: trade.trade_id, kind: 'notice', stage, text, reply_to: Math.trunc(fOr0(trade.signal_msg_id)), chart: chart || null },
        });
        if (res && res.dispatched) return 'ok';
        if (res && res.error === 'user_not_found') return 'blocked';
        return 'failed';
      } catch (e) {
        log.warn(`[SIGNAL-PROGRESS-SEND] uid=${uid} ${e.name}: ${String(e.message).slice(0, 150)}`);
        if (attempt >= 1) return 'failed';
        await sleep(1000);
      }
    }
    return 'failed';
  }

  /** The render_progress_chart arguments the client needs to draw the picture (D3). */
  function chartDescriptor(trade, L, stage, hitLevels, tier, lang, tf, bars, created, tfSec) {
    let timeframe = sOr(trade.timeframe);
    if (timeframe === '1m' || timeframe === '5m') timeframe = '15m';     // [NO-5M]
    const win = T.chartTail(bars, created, tfSec) || [];
    return {
      symbol: sOr(trade.symbol), timeframe, candle_tf: tf, direction: L.direction,
      entry: L.entry, sl: L.sl, tp1: L.tp1, tp2: L.tp2, tp3: L.tp3,
      strategy: sOr(trade.strategy, 'LEVELS').toUpperCase(), event: stage, hit_levels: hitLevels,
      be_price: hitLevels.some((h) => T.TP_ORDER.includes(h)) ? L.entry : null,
      entry_time: created > 0 ? created : null, tier, lang,
      from_ts: win.length ? win[0][0] : null, bars: win.length,
    };
  }

  /** process_trade(bot, trade, user, src, now, png_cache) → sent stage | null */
  async function processTrade(trade, user, src, now = null) {
    const t = now || clock();
    if (sOr(trade.order_id).trim()) return null;                         // exchange-managed
    const L = T.levelsFromTrade(trade);
    if (!T.valid(L)) return null;
    const created = fOr0(trade.created_at);
    const stage0 = sOr(trade.progress_stage, T.NONE);
    const ts0 = fOr0(trade.progress_ts);
    if (T.FINAL.has(stage0) || created <= 0) return null;
    const symbol = sOr(trade.symbol);

    const needFrom = stage0 === T.NONE ? created : ts0;
    let df = null; let tf = null;
    for (const cand of T.pickTfs(t - needFrom)) {
      df = await src.get(symbol, cand, needFrom);
      if (df) { tf = cand; break; }
    }
    if (!df) return null;
    const { bars, t: tArr, h: hArr, l: lArr } = src.bars(symbol, tf, df);
    if (!bars.length) return null;
    const ratio = bars[bars.length - 1][1] / L.entry;                   // pmult sanity
    if (!(ratio > 0.2 && ratio < 5.0)) {
      debug(`[SIGNAL-PROGRESS] tid=${pyStr(trade.trade_id)} scale mismatch ratio=${fmtG(ratio, 3)} — skip`);
      return null;
    }
    const tfSec = Object.prototype.hasOwnProperty.call(T.TF_SEC, tf) ? T.TF_SEC[tf] : 300;
    if (tArr.length) {
      let any = false; let hmax = -Infinity; let lmin = Infinity;
      for (let i = 0; i < tArr.length; i++) {
        const inMask = stage0 === T.NONE ? tArr[i] > created : tArr[i] + tfSec > ts0;
        if (!inMask) continue;
        any = true;
        if (hArr[i] > hmax) hmax = hArr[i];
        if (lArr[i] < lmin) lmin = lArr[i];
      }
      if (!any || !T.couldChange(L, stage0, hmax, lmin)) return null;
    }
    const { stage, progressTs: pts, events } = T.replay(L, bars, stage0, ts0, created, tfSec);
    if (!events.length || stage === stage0) return null;
    if (!repo.advanceSignalProgress(trade.trade_id, stage0, stage, pts)) return null;   // someone else advanced it

    log.info(`[SIGNAL-PROGRESS] tid=${pyStr(trade.trade_id)} uid=${pyStr(trade.user_id)} ${symbol} ${L.direction} `
      + `${stage0 || '-'} → ${stage} events=${events.join(',')} tf=${tf}`);
    if (stage === T.ENTRY) return null;                                  // silent stage
    let uid = uidOf(trade);
    // [CARD-OUTCOME] the outcome in the card itself — silent, regardless of the toggle and lag
    if (uid && !blockedUsers.has(uid)) {
      const lang0 = user ? (sOr(user.lang, 'ru')) : 'ru';
      const card = await updateSignalCard(trade, stage, lang0);
      if (card === 'blocked') blockedUsers.add(uid);
      log.info(`[CARD-OUTCOME] tid=${pyStr(trade.trade_id)} uid=${uid} ${stage} → ${card}`);
    }
    if (t - pts > config.MAX_EVENT_LAG_H * 3600) {
      log.info(`[SIGNAL-PROGRESS] tid=${pyStr(trade.trade_id)} event ${stage} is ${fmtFixed((t - pts) / 3600, 1)}h old — silent`);
      return null;
    }
    uid = uidOf(trade);
    if (!user || blockedUsers.has(uid)) return null;
    if (!(user.progress_notify_enabled === undefined ? true : Boolean(user.progress_notify_enabled))) return null;

    const lang = sOr(user.lang, 'ru');
    const hit = T.hitFor(stage0, events);
    const text = T.buildText(trade, L, stage, hit, lang, t);
    const hitLevels = T.hitLevelsFor(hit, stage);

    let chart = null;
    if (user.send_chart_enabled === undefined ? true : Boolean(user.send_chart_enabled)) {
      const tier = sOr(user.sub_plan).toLowerCase() === 'free' ? 'free' : 'pro';
      chart = chartDescriptor(trade, L, stage, hitLevels, tier, lang, tf, bars, created, tfSec);
    }
    let silent = false;
    try { silent = Boolean(quietHours.isQuiet(user, t)); } catch (_e) { silent = false; }
    const res = await sendProgress(uid, text, { trade, stage, chart, silent });
    if (res === 'blocked') blockedUsers.add(uid);
    log.info(`[SIGNAL-PROGRESS-SEND] tid=${pyStr(trade.trade_id)} uid=${uid} event=${stage} chart=${pyBoolStr(Boolean(chart))} → ${res}`);
    if (config.SEND_DELAY_S) await sleep(config.SEND_DELAY_S * 1000);
    return res === 'ok' ? stage : null;
  }

  /** mark_missed(bot, um, rows, src, now) → Set of trade ids marked MISSED */
  async function markMissed(rows, src, now = null) {
    const t = now || clock();
    const done = new Set();
    const users = new Map();
    for (const row of rows) {
      try {
        const stage0 = sOr(row.progress_stage, T.NONE);
        const created = fOr0(row.created_at);
        if (stage0 !== T.NONE || created <= 0 || t - created < config.MISSED_MIN_AGE_S) continue;
        if (sOr(row.order_id).trim()) continue;
        const L = T.levelsFromTrade(row);
        if (!T.valid(L)) continue;
        const symbol = sOr(row.symbol);
        let df = null; let tf = null;
        for (const cand of T.pickTfs(t - created)) {
          df = await src.get(symbol, cand, created);
          if (df) { tf = cand; break; }
        }
        if (!df) continue;
        const b = src.bars(symbol, tf, df);
        const highs = []; const lows = [];
        for (let i = 0; i < b.t.length; i++) if (b.t[i] > created) { highs.push(b.h[i]); lows.push(b.l[i]); }
        if (!highs.length) continue;
        const closeLast = Number(b.lastClose);
        const r = T.missedR(L, highs, lows, closeLast, config.MISSED_R);
        if (r === null) continue;
        if (!repo.advanceSignalProgress(row.trade_id, stage0, T.MISSED, t)) continue;
        done.add(row.trade_id);
        const uid = uidOf(row);
        log.info(`[SIGNAL-MISSED] tid=${pyStr(row.trade_id)} uid=${uid} ${symbol} ${L.direction} ran ${fmtSigned(r, 2)}R without entry (tf=${tf})`);
        if (uid && !blockedUsers.has(uid)) {
          const user = await getUser(uid, users);
          const lang = user ? sOr(user.lang, 'ru') : 'ru';
          const res = await updateSignalCard({ ...row, missed_rr: r }, T.MISSED, lang);
          if (res === 'blocked') blockedUsers.add(uid);
        }
      } catch (e) {
        debug(`[SIGNAL-MISSED] tid=${pyStr(row.trade_id)}: ${e.message}`);
      }
    }
    return done;
  }

  /** expire_stale(bot, um, src, now) → number closed on time */
  async function expireStale(src, now = null) {
    const t = now || clock();
    let rows;
    try {
      rows = repo.getExpireCandidates(t, config.MAX_AGE_H * 3600);
    } catch (e) {
      debug(`[SIGNAL-EXPIRE] candidates: ${e.message}`);
      return 0;
    }
    let done = 0;
    const users = new Map();
    for (const row of rows) {
      try {
        const price = await src.lastPrice(sOr(row.symbol), t);
        const rr = price ? T.markToMarketRr(row, price) : null;
        if (rr === null) continue;
        if (!repo.markSignalExpired(row.trade_id, sOr(row.progress_stage), rr, t)) continue;
        done += 1;
        const uid = uidOf(row);
        log.info(`[SIGNAL-EXPIRE] tid=${pyStr(row.trade_id)} uid=${uid} ${pyStr(row.symbol)} ${pyStr(row.direction)} rr=${fmtSigned(rr, 2)}`);
        if (uid && !blockedUsers.has(uid)) {
          const user = await getUser(uid, users);
          const lang = user ? sOr(user.lang, 'ru') : 'ru';
          const res = await updateSignalCard({ ...row, expire_rr: rr }, T.EXPIRED, lang);
          if (res === 'blocked') blockedUsers.add(uid);
        }
      } catch (e) {
        debug(`[SIGNAL-EXPIRE] tid=${pyStr(row.trade_id)}: ${e.message}`);
      }
    }
    return done;
  }

  /** run_cycle(bot, um, fetcher, now) → number of notices sent */
  async function runCycle(now = null) {
    const t = now || clock();
    let rows = repo.getTrackableSignals(t - config.MAX_AGE_H * 3600, config.MAX_ROWS);
    const src = new CandleSource(deps.provider, { restBudget: config.REST_PER_CYCLE, log });
    try {
      const expired = await expireStale(src, t);
      if (expired) log.info(`[SIGNAL-EXPIRE-CYCLE] closed on time: ${expired}`);
    } catch (e) {
      debug(`[SIGNAL-EXPIRE] cycle: ${e.message}`);
    }
    if (!rows.length) return 0;
    try {
      const missed = await markMissed(rows, src, t);
      if (missed.size) {
        log.info(`[SIGNAL-MISSED-CYCLE] marked: ${missed.size}`);
        rows = rows.filter((r) => !missed.has(r.trade_id));
      }
    } catch (e) {
      debug(`[SIGNAL-MISSED] cycle: ${e.message}`);
    }
    const users = new Map();
    let sent = 0;
    for (const row of rows) {
      try {
        const user = await getUser(uidOf(row), users);
        if (await processTrade(row, user, src, t)) sent += 1;
      } catch (e) {
        log.warn(`[SIGNAL-PROGRESS] tid=${pyStr(row.trade_id)} failed: ${e.message}`);
      }
    }
    const line = `[SIGNAL-PROGRESS-CYCLE] tracked=${rows.length} sent=${sent} rest_used=${config.REST_PER_CYCLE - src.restLeft}`;
    if (sent) log.info(line); else debug(line);
    return sent;
  }

  /** signal_tracker_loop: 120 s warm-up, then a cycle every INTERVAL_S (setTimeout chain). */
  function start({ armDelayMs = 120_000 } = {}) {
    if (!config.ENABLED) {
      log.info('[SIGNAL-PROGRESS] disabled (SIGNAL_TRACKER_ENABLED=0)');
      return false;
    }
    if (timer || running) return true;
    const tick = async () => {
      running = true;
      try {
        await runCycle();
      } catch (e) {
        log.warn(`[SIGNAL-PROGRESS] cycle failed: ${e.message}`);
      }
      running = false;
      if (timer !== null) timer = setTimeout(tick, config.INTERVAL_S * 1000);
    };
    timer = setTimeout(() => {
      log.info(`[SIGNAL-PROGRESS] loop armed interval=${fmtFixed(config.INTERVAL_S, 0)}s max_age=${fmtFixed(config.MAX_AGE_H, 0)}h`);
      tick();
    }, armDelayMs);
    return true;
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    repo, blockedUsers, config,
    newSource: (opts = {}) => new CandleSource(deps.provider, { restBudget: config.REST_PER_CYCLE, log, ...opts }),
    updateSignalCard, sendProgress, processTrade, markMissed, expireStale, runCycle, start, stop,
  };
}

/**
 * Production candle provider over services/marketData: cache first (the WS-fed TTL cache),
 * BingX REST as the fallback, the last cached 15m/1H close as the "current price".
 */
function marketDataProvider({ cache = null, rest = null } = {}) {
  const candleCache = cache || require('../marketData/candleCache');
  const getRest = () => rest || require('../marketData/bingxRest').getRest();
  return {
    getCandles: (symbol, tf) => candleCache.getCandles(symbol, tf),
    fetchCandles: (symbol, tf, limit) => getRest().getCandles(symbol, tf, limit),
    // signal_freshness.get_current_price: cached 15m → 1H → 4H, first last close > 0
    currentPrice: (symbol) => {
      for (const tf of ['15m', '1H', '4H']) {
        const f = candleCache.getCandles(symbol, tf);
        const px = f && frameLen(f) > 0 ? Number(lastClose(f)) : 0;
        if (px > 0) return px;
      }
      return null;
    },
  };
}

module.exports = {
  FINAL_STAGES, STOP_RESULTS, createRepo, CandleSource, covers, lastClose, noticeTitle, signalLink,
  createSignalTracker, marketDataProvider,
};
