'use strict';
/**
 * publicTrack — the public paper track behind GET /api/public/{trend,stats,feed} (the landing).
 *
 * Source: the signals of the system ("витринные") accounts listed in PUBLIC_TRACK_USER_IDS —
 * their delivered signal_trades rows without an exchange order (the tracker's paper replay at the
 * prices of the levels). No other user's row is ever read for the track.
 *
 * refresh(now) (at most once per CACHE_TTL_S, on demand or from start()'s minute timer), in one
 * transaction:
 *   1. read the track rows younger than LIVE_WINDOW_S, plus (once) any older row not archived yet —
 *      the first run imports what signal_trades still holds (≤ 30 days), so does a new account;
 *   2. archive new ones (store.js) and append the tracker stage when it changed: the stage is dated
 *      max(engine time, min(now, engine time + LAG_MAX_S)) — when the archive first saw it, but
 *      never more than an hour after the bar the tracker dated it to (progress_ts);
 *   3. for every row created at or before V = now − DELAY_S: its public state at V (view.js); a
 *      state that differs from the published one is published under the next change counter.
 * Payloads (feed page, stats, poll answers) are built from the published states only, memoised
 * until the next refresh, and carry a weak ETag. Nothing per user leaves this module: no user id,
 * email, trade id, price level, exchange or order.
 */

const crypto = require('crypto');
const cfgMod = require('./config');
const { createStore } = require('./store');
const view = require('./view');
const feed = require('./feed');
const { statsPayload } = require('./stats');
const { createTrendSource } = require('./trend');
const { COUNTABLE_SQL } = require('../engine/signalOutcome');

const { DELAY_S, CACHE_TTL_S, LIVE_WINDOW_S, LAG_MAX_S } = cfgMod;
const FEED_EMPTY_REASON = 'Лента появится после первых сигналов трека: они показываются с задержкой 60 минут';
const POLL_CACHE_MAX = 500;

function pack(obj) {
  const body = JSON.stringify(obj);
  const etag = `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;
  return { body, etag };
}

const sameR = (a, b) => (a === null || a === undefined ? b === null || b === undefined : (b !== null && b !== undefined && Number(a) === Number(b)));

function parseStages(raw) {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? a.filter((e) => e && typeof e.s === 'string' && Number.isFinite(e.t)) : [];
  } catch (_e) {
    return [];
  }
}

/**
 * createPublicTrack({ db, now, env, log, rest, kvGet, trend })
 *   db     better-sqlite3 handle (default models/database)
 *   now    () → unix seconds
 *   rest / kvGet  the trend source's REST client and engine_kv reader (trend.js); `trend` replaces the source
 */
function createPublicTrack({ db = null, now = () => Date.now() / 1000, env = process.env, log = null, rest = null, kvGet = null, trend = null } = {}) {
  const cfg = cfgMod.readConfig(env);
  const L = log || require('../../utils/logger');
  const dbOf = () => db || require('../../models/database');
  const ids = cfg.accounts.map((a) => a.userId);
  const aliasOf = new Map(cfg.accounts.map((a) => [a.userId, a.alias]));
  const secret = cfg.idSecret || crypto.randomBytes(32).toString('hex');
  const trendSrc = trend || createTrendSource({ kvGet, rest, now });
  let store = null;
  const storeOf = () => store || (store = createStore(dbOf()));
  let last = null;            // { at, v, page, stats, polls }
  let trendCache = null;      // { at, packed }
  let trendFlight = null;
  let timer = null;

  function refresh(t) {
    if (!ids.length) return { rows: 0, published: 0 };
    const st = storeOf();
    const d = dbOf();
    const v = t - DELAY_S;
    const since = t - LIVE_WINDOW_S;
    const src = d.prepare(
      'SELECT trade_id, user_id, symbol, direction, entry, sl, original_sl, tp1, tp2, tp3, timeframe, strategy, '
      + 'created_at, signal_msg_id, progress_stage, progress_ts, order_id, expire_rr FROM signal_trades '
      + `WHERE user_id IN (${ids.map(() => '?').join(', ')}) AND (created_at >= ? OR trade_id NOT IN (SELECT trade_id FROM public_track)) `
      + 'AND COALESCE(signal_msg_id, 0) > 0 '
      + `AND COALESCE(order_id, '') = '' AND ${COUNTABLE_SQL} ORDER BY created_at ASC, trade_id ASC`,
    ).all(...ids, since);
    let published = 0;
    d.transaction(() => {
      const live = st.liveRows(ids, since - 86400);   // older rows are final: only a first import reads them
      let seq = st.seq();
      for (const row of src) {
        const strategy = view.strategyOf(row.strategy);
        const side = view.sideOf(row.direction);
        const pair = view.baseOf(row.symbol);
        if (!strategy || !side || !pair) continue;
        let arch = live.get(row.trade_id);
        if (!arch) {
          const rec = {
            trade_id: row.trade_id, pub_id: view.publicId(row.trade_id, secret), user_id: row.user_id,
            bot_id: `${aliasOf.get(row.user_id) || 'sys'}-${strategy.toLowerCase()}`, strategy, pair, side,
            tf: view.tfOf(row.timeframe), created_at: view.num(row.created_at),
          };
          st.insert(rec, t);
          arch = { ...rec, stages: '[]', status: null, path: null, r: null, appear_seq: null, seq: null };
        }
        const stages = parseStages(arch.stages);
        const s = view.stageOf(row);
        const lastS = stages.length ? stages[stages.length - 1].s : '';
        if (s && s !== lastS) {
          const dbT = view.stageDbTime(row);
          const seen = Math.max(dbT, Math.min(t, dbT + LAG_MAX_S));
          stages.push({ s, t: stages.length ? Math.max(seen, stages[stages.length - 1].t) : seen });
          st.setStages(row.trade_id, stages, t);
        }
        if (view.num(row.created_at) > v) continue;
        const state = view.publicState(row, stages, v);
        if (arch.appear_seq === null || arch.status !== state.status || arch.path !== JSON.stringify(state.path) || !sameR(arch.r, state.r)) {
          seq += 1;
          published += 1;
          st.publish(row.trade_id, state, seq, t);
        }
      }
      if (published) st.setSeq(seq);
    })();
    if (published) L.debug(`[PUBLIC-TRACK] refresh: rows=${src.length} published=${published}`);
    return { rows: src.length, published };
  }

  /** The refresh of this minute (computes when the last one is CACHE_TTL_S old). */
  function current() {
    const t = now();
    if (!last || t - last.at >= CACHE_TTL_S || t < last.at) {
      refresh(t);
      last = { at: t, v: t - DELAY_S, page: null, stats: null, polls: new Map() };
    }
    return last;
  }

  return {
    config: cfg,
    refresh: (t = now()) => { const r = refresh(t); last = null; return r; },
    current,

    /** GET /feed (after === undefined) or GET /feed?after=<cursor>; throws feed.BadCursor. */
    feed(after) {
      const c = current();
      if (after === undefined) {
        if (!c.page) {
          const p = ids.length ? feed.pagePayload(storeOf(), ids, c.v) : null;
          c.page = pack(p && p.items.length ? p : { empty: true, reason: FEED_EMPTY_REASON });
        }
        return c.page;
      }
      const key = typeof after === 'string' ? after : null;
      if (key !== null && c.polls.has(key)) return c.polls.get(key);
      const out = pack(ids.length ? feed.pollPayload(storeOf(), ids, c.v, after)
        : (() => { feed.parseCursor(after); return { cursor: after, events: [], updated_at: Math.floor(c.v * 1000) }; })());
      if (c.polls.size >= POLL_CACHE_MAX) c.polls.clear();
      c.polls.set(key, out);
      return out;
    },

    /** GET /stats */
    stats() {
      const c = current();
      if (!c.stats) {
        c.stats = pack(ids.length ? statsPayload(storeOf().visible(ids), c.v) : statsPayload([], c.v));
      }
      return c.stats;
    },

    /** GET /trend (async: REST for the ribbon strength and the 24 h change). */
    async trend() {
      const t = now();
      if (trendCache && t - trendCache.at < CACHE_TTL_S && t >= trendCache.at) return trendCache.packed;
      if (!trendFlight) {
        trendFlight = (async () => {
          try {
            trendCache = { at: t, packed: pack(await trendSrc.compute()) };
          } catch (e) {
            L.warn(`[PUBLIC-TRACK] trend: ${e && e.message}`);
            if (!trendCache) throw e;
          } finally {
            trendFlight = null;
          }
        })();
      }
      await trendFlight;
      return trendCache.packed;
    },

    /** The minute timer: keeps the archive's stage history current when nobody asks. */
    start({ everyMs = CACHE_TTL_S * 1000 } = {}) {
      if (timer || !ids.length) return this;
      timer = setInterval(() => {
        try { current(); } catch (e) { L.warn(`[PUBLIC-TRACK] refresh failed: ${e && e.message}`); }
      }, everyMs);
      if (timer.unref) timer.unref();
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

let _default = null;
/** The process-wide instance (models/database, process.env, the shared BingX REST client). */
function defaultTrack() { return _default || (_default = createPublicTrack()); }
function setDefaultTrack(inst) { _default = inst; }

module.exports = { FEED_EMPTY_REASON, createPublicTrack, defaultTrack, setDefaultTrack, pack };
