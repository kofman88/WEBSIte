/**
 * freeReport — the bot's free_report.py one-to-one (signal-pipeline.md §9).
 *
 *   LEVELS daily quota   shouldSendFreeSignal(user, quality) / recordFreeSignalSent(user, window)
 *                        windows 06–13 / 13–21 UTC, one signal each, quality ≥ PLAN_FEATURES.free
 *                        .min_signal_quality (5), relaxed to 3 in the last hour of a window
 *                        ([GUARANTEED-DELIVERY]); counters reset when free_signals_date changes;
 *                        nothing is counted before a confirmed delivery.
 *   missed buffer        recordMissedSignal(user, …) — ≤ 50/user/day, persisted to engine_kv
 *                        `free_missed_buffer` every 10 insertions (admin telemetry only).
 *   closed profitable    recordClosedProfitable(symbol, direction, rr) — rr > 0 only, last 100,
 *                        persisted to `free_closed_profitable` every 5.
 *   SMC "Pro preview"    freePreviewAlreadySentToday / shouldSendFreeSmcPreview (quota
 *                        _FREE_SMC_PREVIEW_DAILY_QUOTA = 3) / recordFreeSmcPreviewSent /
 *                        markFreePreviewSent (dedup map persisted to `free_preview_sent`, only
 *                        today's entries) and previewCardText (i18n smc_pro_preview_card).
 *   evening report       eveningReportText / sendEveningReport (21:00 UTC; [EVENING-DATE]
 *                        counters of another day count as 0; buffers cleared afterwards).
 *
 * The user objects are trader_settings-shaped (mutated in place; the caller saves).
 * Clock injected (`now` → unix seconds). Markers: [FREE-WINDOW], [GUARANTEED-DELIVERY],
 * [FREE-SMC-PREVIEW].
 */

'use strict';

const { pyJsonDumps } = require('./pyjson');
const { pyLoads } = require('./signalTradesRepo');
const { pyInt } = require('./pycoerce');
const { fmtFixed, fmtG } = require('../../strategies/common/pyfmt');
const { pySum } = require('../../strategies/common/series');
const { pyTruthy } = require('../../strategies/common/pyval');
const { makeT } = require('./cards/html');
const { log: defaultLog } = require('../marketData/mdLog');

const FREE_SMC_PREVIEW_DAILY_QUOTA = 3;
const MISSED_SAVE_EVERY = 10;
const CLOSED_SAVE_EVERY = 5;
const MISSED_MAX_PER_USER = 50;
const CLOSED_MAX = 100;
const REPORT_HOUR_UTC = 21;
const SEND_PAUSE_S = 0.3;
const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

const KV_MISSED = 'free_missed_buffer';
const KV_CLOSED = 'free_closed_profitable';
const KV_PREVIEW = 'free_preview_sent';

/** i18n entries (verbatim; pinned against the bot's i18n.py in the tests). */
const MESSAGES = {
  free_report_title: { ru: '📊 <b>Вечерний отчёт (Free план)</b>', en: '📊 <b>Evening report (Free plan)</b>' },
  free_report_received: { ru: 'Сегодня получено: <b>{n}</b> сигналов', en: 'Today received: <b>{n}</b> signals' },
  free_report_closed_today_header: {
    ru: '🔥 <b>На платформе закрыто по TP сегодня ({n}):</b>\n   <i>(трейды Pro юзеров — для мотивации)</i>',
    en: '🔥 <b>Closed at TP across platform today ({n}):</b>\n   <i>(trades from Pro users — for motivation)</i>',
  },
  free_report_more: { ru: '  ... и ещё {n}', en: '  ... and {n} more' },
  free_report_total: { ru: '  Итого: <b>+{r:.1f}R</b>', en: '  Total: <b>+{r:.1f}R</b>' },
  free_report_upsell_pro: {
    ru: '⭐ <b>Pro $69</b> — LEVELS + SMC автотрейд + AI-фильтр + оптимизатор + Genome',
    en: '⭐ <b>Pro $69</b> — LEVELS + SMC auto-trade + AI filter + optimizer + Genome',
  },
  smc_pro_preview_card: {
    ru: '🎁 <b>Pro Preview</b> — SMC сигнал\n\n'
      + '<b>{symbol}</b> · {direction} · quality {score}/10\n'
      + 'Entry: <code>{entry}</code> · SL: <code>{sl}</code> · '
      + 'TP1: <code>{tp1}</code>\n\n'
      + '💡 Это сигнал стратегии <b>SMC</b> — она ловит точки входа '
      + 'на order-blocks и работает даже в тренде, когда LEVELS '
      + 'молчит. На Free-плане ты видишь до <b>3 таких сигналов в '
      + 'день</b> как тизер.\n\n'
      + '💎 Разблокировать все SMC сигналы + авто-торговля → /subscribe',
    en: '🎁 <b>Pro Preview</b> — SMC signal\n\n'
      + '<b>{symbol}</b> · {direction} · quality {score}/10\n'
      + 'Entry: <code>{entry}</code> · SL: <code>{sl}</code> · '
      + 'TP1: <code>{tp1}</code>\n\n'
      + '💡 This is a signal from the <b>SMC</b> strategy — it finds '
      + 'entries at order-blocks and works in trending markets where '
      + 'LEVELS goes quiet. On Free plan you see up to <b>3 such '
      + 'signals per day</b> as a teaser.\n\n'
      + '💎 Unlock all SMC signals + auto-trading → /subscribe',
  },
};
const t = makeT(MESSAGES);

const nowSec = () => Date.now() / 1000;
const sleepMs = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h.unref) h.unref(); });
const intOr0 = (v) => (pyTruthy(v) ? pyInt(v) : 0);   // int(x or 0)
const attr = (o, k, d) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : d);   // getattr(o, k, d)

// datetime.fromtimestamp(ts, tz=utc).strftime("%Y-%m-%d") / .hour — the fraction rounds to whole
// microseconds half-even (common/pytime.js), so …23:59:59.9999996 is already the next day.
const { utcDate, utcHour } = require('../../strategies/common/pytime');

/**
 * json.dumps of a uid-keyed dict in the bot's insertion order: a plain JS object would
 * list integer-like keys ("7", "101") in ascending order instead.
 */
function dumpOrdered(entries, floatKeys = null) {
  return '{' + entries.map(([k, v]) => `${pyJsonDumps(String(k))}: ${pyJsonDumps(v, floatKeys)}`).join(', ') + '}';
}

/** `x.items()` of a json.loads value: a dict (Map) only — anything else raises AttributeError in the bot. */
function itemsOf(v) {
  if (v instanceof Map) return Array.from(v.entries());
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) return Object.entries(v);
  throw new TypeError("object has no attribute 'items'");
}

function resetDay(user, today) {
  user.free_signals_morning = 0;
  user.free_signals_evening = 0;
  user.free_signals_night = 0;     // legacy field, остаётся 0
  user.free_signals_today = 0;     // legacy
  user.free_missed_today = 0;
  user.free_signals_date = today;
}

/**
 * createFreeReport({ kv, now, log, features })
 *   kv       — { get, set } (default engineKvService)
 *   features — PLAN_FEATURES.free (default config/planFeatures)
 */
function createFreeReport(deps = {}) {
  const now = deps.now || nowSec;
  const log = deps.log || defaultLog;
  const kvOf = () => (deps.kv !== undefined ? deps.kv : require('../engineKvService'));
  const featuresOf = () => {
    if (deps.features) return deps.features;
    try { return require('../../config/planFeatures').PLAN_FEATURES.free || {}; } catch (_e) { return {}; }
  };
  const today = () => utcDate(now());

  let missedBuffer = new Map();       // uid → [{symbol, direction, quality, rr, ts}]
  let missedDirty = 0;
  let closedProfitable = [];          // [{symbol, direction, result_rr, closed_at}]
  let closedDirty = 0;
  const previewSent = new Map();      // uid → Map("SYM:DIR" → "YYYY-MM-DD")

  function windows() {
    const f = featuresOf();
    return {
      morning: f.signal_window_morning_utc || [6, 13],
      evening: f.signal_window_evening_utc || [13, 21],
    };
  }

  const fr = {
    FREE_SMC_PREVIEW_DAILY_QUOTA, MESSAGES, t,
    get missedBuffer() { return missedBuffer; },
    get closedProfitable() { return closedProfitable; },
    get previewSent() { return previewSent; },

    // ── SMC preview dedup ──────────────────────────────────────────────
    /** _free_preview_already_sent_today(uid, symbol, direction) */
    freePreviewAlreadySentToday(userId, symbol, direction) {
      const sent = previewSent.get(pyInt(userId));
      if (!sent || !sent.size) return false;
      return sent.get(`${symbol}:${direction}`) === today();
    },

    /** _mark_free_preview_sent: lazy daily wipe of the user's map, then persist (only today's entries). */
    markFreePreviewSent(userId, symbol, direction) {
      const d = today();
      const uid = pyInt(userId);
      const userMap = previewSent.get(uid);
      if (userMap === undefined) {
        previewSent.set(uid, new Map([[`${symbol}:${direction}`, d]]));
      } else {
        if (Array.from(userMap.values()).some((v) => v !== d)) userMap.clear();
        userMap.set(`${symbol}:${direction}`, d);
      }
      fr.savePreviewSent();
    },

    savePreviewSent() {
      try {
        const d = today();
        const payload = [];   // [uid, {"SYM:DIR": date}] in _FREE_PREVIEW_SENT order
        for (const [uid, m] of previewSent) {
          const keep = {};
          for (const [k, v] of m) if (v === d) keep[k] = v;
          if (Object.keys(keep).length) payload.push([String(uid), keep]);
        }
        kvOf().set(KV_PREVIEW, dumpOrdered(payload));
      } catch (e) {
        log.debug(`save preview sent: ${e && e.message}`);
      }
    },

    /** should_send_free_smc_preview(user): permission only (date reset mutates the user). */
    shouldSendFreeSmcPreview(user) {
      if (attr(user, 'sub_plan', '') !== 'free') return false;
      const d = today();
      if (attr(user, 'free_smc_preview_date', '') !== d) {
        user.free_smc_preview_today = 0;
        user.free_smc_preview_date = d;
      }
      if (attr(user, 'free_smc_preview_today', 0) >= FREE_SMC_PREVIEW_DAILY_QUOTA) return false;
      return true;
    },

    /** record_free_smc_preview_sent(user): +1 after a confirmed delivery. */
    recordFreeSmcPreviewSent(user) {
      const d = today();
      if (attr(user, 'free_smc_preview_date', '') !== d) {
        user.free_smc_preview_today = 0;
        user.free_smc_preview_date = d;
      }
      user.free_smc_preview_today = intOr0(attr(user, 'free_smc_preview_today', 0)) + 1;
      log.info(`[FREE-SMC-PREVIEW] uid=${attr(user, 'user_id', '?')} sent (total_today=${user.free_smc_preview_today})`);
    },

    /** The «🎁 Pro Preview» teaser (i18n smc_pro_preview_card; quirk: the 0..5 score prints as /10). */
    previewCardText(sig, symbol, lang = 'ru') {
      return t('smc_pro_preview_card', lang, {
        symbol, direction: sig.direction, score: intOr0(sig.score),
        entry: fmtG(sig.entry, 6), sl: fmtG(sig.sl, 6), tp1: fmtG(sig.tp1, 6),
      });
    },

    // ── LEVELS quota ───────────────────────────────────────────────────
    /** should_send_free_signal(user, quality) → bool; non-free → true. */
    shouldSendFreeSignal(user, quality) {
      if (attr(user, 'sub_plan', '') !== 'free') return true;
      const f = featuresOf();
      const ts = now();
      const hour = utcHour(ts);
      const d = utcDate(ts);
      if (attr(user, 'free_signals_date', '') !== d) resetDay(user, d);
      const { morning: [ms, me], evening: [es, ee] } = windows();
      let window;
      let counterField;
      if (ms <= hour && hour < me) { window = 'morning'; counterField = 'free_signals_morning'; }
      else if (es <= hour && hour < ee) { window = 'evening'; counterField = 'free_signals_evening'; }
      else {
        log.debug(`[FREE-WINDOW] uid=${attr(user, 'user_id', '?')} off-hours (h=${hour} UTC) — blocked`);
        return false;
      }
      const used = intOr0(attr(user, counterField, 0));
      if (used >= 1) {
        log.debug(`[FREE-WINDOW] uid=${attr(user, 'user_id', '?')} window=${window} already_sent=${used} — blocked`);
        return false;
      }
      let minQ = pyInt(pyTruthy(f.min_signal_quality) ? f.min_signal_quality : 5);
      const closing = (window === 'morning' && hour >= me - 1) || (window === 'evening' && hour >= ee - 1);
      if (closing) {
        minQ = 3;
        log.debug(`[GUARANTEED-DELIVERY] uid=${attr(user, 'user_id', '?')} window=${window} closing — relaxed min_q=3`);
      }
      if (quality < minQ) return false;
      log.debug(`[FREE-WINDOW] uid=${attr(user, 'user_id', '?')} window=${window} quality=${Math.trunc(quality)} permission granted (awaiting delivery confirmation)`);
      return true;
    },

    /** record_free_signal_sent(user, window=""): +1 on the window counter after delivery. */
    recordFreeSignalSent(user, window = '') {
      const ts = now();
      const d = utcDate(ts);
      if (attr(user, 'free_signals_date', '') !== d) resetDay(user, d);
      let w = window;
      if (!w) {
        const hour = utcHour(ts);
        const { morning: [ms, me], evening: [es, ee] } = windows();
        if (ms <= hour && hour < me) w = 'morning';
        else if (es <= hour && hour < ee) w = 'evening';
        else w = 'evening';   // off-hours fallback
      }
      const counterField = w === 'morning' ? 'free_signals_morning' : 'free_signals_evening';
      user[counterField] = intOr0(attr(user, counterField, 0)) + 1;
      user.free_signals_today = intOr0(attr(user, 'free_signals_morning', 0)) + intOr0(attr(user, 'free_signals_evening', 0));
      log.info(`[FREE-WINDOW] uid=${attr(user, 'user_id', '?')} window=${w} SENT (total_today=${user.free_signals_today})`);
    },

    /** record_missed_signal(user, symbol, direction, quality, rr): buffer (≤ 50) + free_missed_today + periodic save. */
    recordMissedSignal(user, symbol, direction, quality, rr = 0) {
      const uid = user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, 'user_id') ? user.user_id : pyInt(user);
      if (!missedBuffer.has(uid)) missedBuffer.set(uid, []);
      const list = missedBuffer.get(uid);
      if (list.length < MISSED_MAX_PER_USER) {
        list.push({ symbol, direction, quality, rr, ts: now() });
        missedDirty += 1;
      }
      if (user && typeof user === 'object' && Object.prototype.hasOwnProperty.call(user, 'free_missed_today')) {
        try {
          const d = today();
          if (attr(user, 'free_signals_date', '') !== d) {
            user.free_missed_today = 0;
            user.free_signals_date = d;
          }
          user.free_missed_today = intOr0(attr(user, 'free_missed_today', 0)) + 1;
        } catch (e) {
          log.debug(`record_missed_signal user-update: ${e && e.message}`);
        }
      }
      if (missedDirty >= MISSED_SAVE_EVERY) {
        missedDirty = 0;
        fr.saveMissedBuffer();
      }
    },

    /** record_closed_profitable(symbol, direction, result_rr): rr > 0 only, last 100, save every 5. */
    recordClosedProfitable(symbol, direction, resultRr) {
      if (!(resultRr > 0)) return;
      closedProfitable.push({ symbol, direction, result_rr: resultRr, closed_at: now() });
      closedDirty += 1;
      if (closedProfitable.length > CLOSED_MAX) closedProfitable.shift();
      if (closedDirty >= CLOSED_SAVE_EVERY) {
        closedDirty = 0;
        fr.saveClosedBuffer();
      }
    },

    // ── persistence ────────────────────────────────────────────────────
    saveMissedBuffer() {
      try {
        // {str(uid): [items]} in _missed_buffer order
        kvOf().set(KV_MISSED, dumpOrdered(Array.from(missedBuffer, ([k, v]) => [String(k), v]), ['ts']));
      } catch (e) {
        log.debug(`save missed buffer: ${e && e.message}`);
      }
    },

    saveClosedBuffer() {
      try {
        kvOf().set(KV_CLOSED, pyJsonDumps(closedProfitable, ['closed_at', 'result_rr']));
      } catch (e) {
        log.debug(`save closed buffer: ${e && e.message}`);
      }
    },

    /** load_persistent_buffers(): the three kv buffers (preview dedup: today's entries only). */
    loadPersistentBuffers() {
      try {
        const raw = kvOf().get(KV_MISSED);
        if (raw) {
          const data = pyLoads(raw, { mapDepth: 1 });   // document order, like {int(k): v for k, v in data.items()}
          const m = new Map();
          for (const [k, v] of itemsOf(data)) m.set(pyInt(k), v);
          missedBuffer = m;
          log.info(`free_report: restored ${missedBuffer.size} users' missed buffer`);
        }
      } catch (e) {
        log.debug(`load missed buffer: ${e && e.message}`);
      }
      try {
        const raw = kvOf().get(KV_CLOSED);
        if (raw) {
          closedProfitable = pyLoads(raw);
          const n = Array.isArray(closedProfitable) ? closedProfitable.length : Object.keys(closedProfitable || {}).length;
          log.info(`free_report: restored ${n} closed profitable signals`);
        }
      } catch (e) {
        log.debug(`load closed buffer: ${e && e.message}`);
      }
      try {
        const raw = kvOf().get(KV_PREVIEW);
        if (raw) {
          const d = today();
          const data = pyLoads(raw, { mapDepth: 1 });
          let restored = 0;
          for (const [uid, m] of itemsOf(data)) {
            const keep = new Map();
            for (const [k, v] of itemsOf(pyTruthy(m) ? m : {})) if (v === d) keep.set(k, v);   // (m or {}).items()
            if (keep.size) {
              previewSent.set(pyInt(uid), keep);
              restored += 1;
            }
          }
          if (restored) log.info(`free_report: restored today's SMC preview dedup for ${restored} users`);
        }
      } catch (e) {
        log.debug(`load preview sent: ${e && e.message}`);
      }
    },

    // ── evening report ─────────────────────────────────────────────────
    /** Today's closed-profitable entries and their Σ R. */
    todayProfitable() {
      const d = today();
      const list = closedProfitable.filter((s) => utcDate(s.closed_at) === d);
      return { list, totalR: pySum(list.map((s) => s.result_rr)) };
    },

    /**
     * The evening report of one user (null for non-free users and when there is
     * nothing to report). `profitable` = todayProfitable().
     */
    eveningReportText(user, profitable = null) {
      if (attr(user, 'sub_plan', '') !== 'free') return null;
      const { list, totalR } = profitable || fr.todayProfitable();
      let mornUsed;
      let evenUsed;
      let sentCount;
      if (attr(user, 'free_signals_date', '') !== today()) {   // [EVENING-DATE]
        mornUsed = 0; evenUsed = 0; sentCount = 0;
      } else {
        mornUsed = intOr0(attr(user, 'free_signals_morning', 0));
        evenUsed = intOr0(attr(user, 'free_signals_evening', 0));
        sentCount = mornUsed + evenUsed;
        if (sentCount === 0) sentCount = pyTruthy(attr(user, 'free_signals_today', 0)) ? attr(user, 'free_signals_today', 0) : 0;
      }
      if (sentCount === 0 && !list.length) return null;
      const lang = pyTruthy(attr(user, 'lang', 'ru')) ? attr(user, 'lang', 'ru') : 'ru';
      const lines = [t('free_report_title', lang), SEP, '', t('free_report_received', lang, { n: sentCount })];
      if (mornUsed || evenUsed) {
        lines.push(lang === 'en'
          ? `  🌅 Morning: ${mornUsed}/1  ·  🌆 Evening: ${evenUsed}/1`
          : `  🌅 Утро: ${mornUsed}/1  ·  🌆 Вечер: ${evenUsed}/1`);
      }
      if (list.length) {
        lines.push('');
        lines.push(t('free_report_closed_today_header', lang, { n: list.length }));
        for (const s of list.slice(0, 5)) {
          const sym = String(s.symbol).replace(/-USDT-SWAP/g, '').replace(/-USDT/g, '');
          lines.push(`  📈 ${sym} ${s.direction} → <b>+${fmtFixed(s.result_rr, 1)}R</b>`);
        }
        if (list.length > 5) lines.push(t('free_report_more', lang, { n: list.length - 5 }));
        lines.push(t('free_report_total', lang, { r: totalR }));
      }
      lines.push('', SEP, t('free_report_upsell_pro', lang));
      return lines.join('\n');
    },

    /**
     * _send_evening_report: every free user with something to report gets the text
     * through `send(userId, text)` (0.3 s apart); then both buffers are cleared and
     * persisted empty. Returns the number of reports handed to `send`.
     */
    async sendEveningReport(users, send, { sleep = sleepMs } = {}) {
      const profitable = fr.todayProfitable();
      let n = 0;
      for (const user of users || []) {
        const text = fr.eveningReportText(user, profitable);
        if (text === null) continue;
        try {
          await send(user.user_id, text);
          n += 1;
        } catch (_e) {
          // the bot: log.warning("free_report._send_evening_report() unhandled exception", exc_info=True)
          // — the record's message has no error text (the traceback is exc_info)
          log.warning('free_report._send_evening_report() unhandled exception');
        }
        await sleep(SEND_PAUSE_S * 1000);
      }
      missedBuffer.clear();
      closedProfitable = [];
      fr.saveMissedBuffer();
      fr.saveClosedBuffer();
      return n;
    },

    /** Seconds until the next 21:00 UTC (today when before 21:00, else tomorrow). */
    secondsUntilReport(ts = now()) {
      const dt = new Date(Math.floor(ts * 1000));
      let target = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), REPORT_HOUR_UTC, 0, 0, 0) / 1000;
      if (dt.getUTCHours() >= REPORT_HOUR_UTC) target += 86400;
      return target - ts;
    },

    /** free_evening_report_loop: restore buffers, then report at 21:00 UTC daily (1 h back-off on errors). */
    async runEveningLoop(getUsers, send, { signal = null, sleep = sleepMs } = {}) {
      log.info('Free evening report loop started');
      try { fr.loadPersistentBuffers(); } catch (e) { log.warning(`free_report: restore buffers failed: ${e && e.message}`); }
      while (!(signal && signal.aborted)) {
        try {
          await sleep(fr.secondsUntilReport() * 1000);
          if (signal && signal.aborted) return;
          await fr.sendEveningReport(await getUsers(), send, { sleep });
        } catch (e) {
          log.warning(`free_evening_report: ${e && e.message}`);
          await sleep(3600 * 1000);
        }
      }
    },

    /** Tests: replace the buffers (like a kv restore). */
    _setBuffers({ missed = null, closed = null } = {}) {
      if (missed) missedBuffer = new Map(Object.entries(missed).map(([k, v]) => [pyInt(k), v]));
      if (closed) closedProfitable = closed.map((x) => ({ ...x }));
    },

    _resetForTests() {
      missedBuffer = new Map(); missedDirty = 0; closedProfitable = []; closedDirty = 0; previewSent.clear();
    },
  };
  return fr;
}

const defaultFreeReport = createFreeReport();

module.exports = {
  FREE_SMC_PREVIEW_DAILY_QUOTA, MISSED_SAVE_EVERY, CLOSED_SAVE_EVERY, MISSED_MAX_PER_USER, CLOSED_MAX,
  REPORT_HOUR_UTC, SEP, KV_MISSED, KV_CLOSED, KV_PREVIEW, MESSAGES, utcDate, createFreeReport, defaultFreeReport,
};
