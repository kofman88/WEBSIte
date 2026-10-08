/**
 * coinQualityLearner — the bot's coin_quality_learner.py one-to-one.
 *
 * Every 6 h: per (symbol × strategy) profit factor of the signal_trades rows of
 * the last 30 days (sum(+R) / max(sum(|−R|), 0.01)); a pair with N ≥ 10,
 * PF < 0.7 AND avg R < 0 is banned for 14 days. Scanners call
 * `isBlacklisted(symbol, strategy)` before emitting (sync, hot path).
 *
 * Quirks kept: rows with result '' (open) are counted (their result_rr 0 pulls
 * avg toward 0 — the SQL only excludes PENDING/SKIP/ORPHAN/MANUAL/AUTO); keys
 * restored from kv keep their stored case while lookups upper-case.
 *
 * Storage: engine_kv `coin_blacklist_v1` → JSON {"SYM::STRAT": until_ts}.
 * Markers: [COIN-BLACKLIST], [COIN-BLACKLIST-CYCLE], [COIN-BLACKLIST-RESTORE],
 * [COIN-BLACKLIST-START].
 */

'use strict';

const { pyJsonDumps } = require('./pyjson');
const { pyFloat } = require('./pycoerce');
const { fmtFixed, fmtSigned } = require('../../strategies/common/pyfmt');
const { pyMax } = require('../../strategies/common/pyround');
const { log: defaultLog } = require('../marketData/mdLog');
const { pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

const KV_KEY = 'coin_blacklist_v1';
const MIN_TRADES = 10;               // минимум закрытых trades для решения
const PF_THRESHOLD = 0.7;            // ниже = blacklist
const BLACKLIST_TTL_SEC = 14 * 86400;
const RECOMPUTE_INTERVAL_SEC = 6 * 3600;
const LOOKBACK_DAYS = 30;
const LOOP_SLEEP_SEC = 600;
const VALID_STRATEGIES = Object.freeze(['LEVELS', 'SMC', 'VOLUME']);

const nowSec = () => Date.now() / 1000;
const sleepMs = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h.unref) h.unref(); });
const keyOf = (sym, strat) => `${sym}::${strat}`;

/**
 * createCoinQualityLearner({ repo, kv, now, log })
 *   repo — { coinQualityPairs(cutoffTs) } (default signalTradesRepo)
 *   kv   — { get, set } (default engineKvService)
 */
function createCoinQualityLearner(deps = {}) {
  const now = deps.now || nowSec;
  const log = deps.log || defaultLog;
  const repoOf = () => (deps.repo ? deps.repo : require('./signalTradesRepo').defaultRepo);
  const kvOf = () => (deps.kv !== undefined ? deps.kv : require('../engineKvService'));
  let blacklist = new Map();   // "SYM::STRAT" → until_ts
  let lastCalcTs = 0.0;

  const c = {
    KV_KEY,
    get lastCalcTs() { return lastCalcTs; },

    /** is_blacklisted(symbol, strategy): upper-cased lookup, expired entries dropped lazily. */
    isBlacklisted(symbol, strategy) {
      if (!symbol || !strategy) return false;
      const key = keyOf(pyUpper(String(symbol)), pyUpper(String(strategy)));
      const until = blacklist.has(key) ? blacklist.get(key) : 0.0;
      if (until <= 0) return false;
      if (now() > until) {
        blacklist.delete(key);
        return false;
      }
      return true;
    },

    /** get_blacklist_snapshot(): {"SYM::STRAT": until} of the live entries. */
    getBlacklistSnapshot() {
      const t = now();
      const out = {};
      for (const [k, v] of blacklist) if (v > t) out[k] = v;
      return out;
    },

    /** restore_blacklist_from_kv(): live entries only; the in-memory map is replaced. */
    restoreFromKv() {
      try {
        const raw = kvOf().get(KV_KEY);
        if (!raw) return 0;
        let decoded;
        try {
          decoded = JSON.parse(raw);
        } catch (_e) {
          log.debug('coin_blacklist: bad JSON в kv — игнорируем');
          return 0;
        }
        if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return 0;
        const t = now();
        const restored = new Map();
        for (const [kStr, tsV] of Object.entries(decoded)) {
          const s = String(kStr);
          const idx = s.indexOf('::');
          if (idx < 0) continue;                       // unpack ValueError → skip
          let tsF;
          try { tsF = pyFloat(tsV); } catch (_e) { continue; }
          if (tsF <= t) continue;                      // expired
          restored.set(keyOf(s.slice(0, idx), s.slice(idx + 2)), tsF);
        }
        blacklist = restored;
        if (restored.size) log.info(`[COIN-BLACKLIST-RESTORE] ${restored.size} active entries restored from kv`);
        return restored.size;
      } catch (e) {
        log.warning(`restore_blacklist_from_kv: ${e && e.message}`);
        return 0;
      }
    },

    /** _persist_blacklist(): drop expired, write {"sym::strat": float}. */
    persist() {
      try {
        const t = now();
        for (const [k, v] of Array.from(blacklist)) if (!(v > t)) blacklist.delete(k);
        const encoded = {};
        for (const [k, v] of blacklist) encoded[k] = Number(v);
        kvOf().set(KV_KEY, pyJsonDumps(encoded, Object.keys(encoded)));
      } catch (e) {
        log.debug(`persist coin blacklist: ${e && e.message}`);
      }
    },

    /** recompute_blacklist() → {total_pairs, blacklisted, expired}. */
    recompute() {
      const t = now();
      const cutoff = t - LOOKBACK_DAYS * 86400;
      let pairs;
      try {
        pairs = repoOf().coinQualityPairs(cutoff).map((row) => ({
          sym: pyUpper(String(row.symbol)),
          strat: pyUpper(String(row.strategy)),
          wins_rr: Number(row.wins_rr || 0),
          losses_rr: Number(row.losses_rr || 0),
          n: Math.trunc(Number(row.n || 0)),
          avg_rr: Number(row.avg_rr || 0),
        }));
      } catch (e) {
        log.warning(`coin_quality SQL failed: ${e && e.message}`);
        return { total_pairs: 0, blacklisted: 0, expired: 0 };
      }
      const fresh = new Map();
      let banned = 0;
      for (const p of pairs) {
        if (!VALID_STRATEGIES.includes(p.strat)) continue;
        if (p.n < MIN_TRADES) continue;
        const pf = p.wins_rr / pyMax(p.losses_rr, 0.01);   // guard от div-by-zero
        if (pf < PF_THRESHOLD && p.avg_rr < 0) {
          fresh.set(keyOf(p.sym, p.strat), t + BLACKLIST_TTL_SEC);
          banned += 1;
          log.info(`[COIN-BLACKLIST] sym=${p.sym} strat=${p.strat} pf=${fmtFixed(pf, 2)} n=${p.n} avg=${fmtSigned(p.avg_rr, 2)}R → 14d ban`);
        }
      }
      let expired = 0;
      const merged = new Map();
      for (const [k, until] of blacklist) {
        if (until > t) merged.set(k, until); else expired += 1;
      }
      for (const [k, v] of fresh) merged.set(k, v);   // new entries refresh the TTL
      blacklist = merged;
      lastCalcTs = t;
      c.persist();
      log.info(`[COIN-BLACKLIST-CYCLE] pairs_analyzed=${pairs.length} new_banned=${banned} expired=${expired} `
        + `active_total=${blacklist.size} (lookback=${LOOKBACK_DAYS}d, threshold=PF<${fmtFixed(PF_THRESHOLD, 1)}, min_trades=${MIN_TRADES})`);
      return { total_pairs: pairs.length, blacklisted: banned, expired };
    },

    /**
     * coin_quality_loop: restore, an initial recompute when the last one is > 6 h old,
     * then wake every 10 min and recompute every 6 h until `signal.aborted`.
     */
    async runLoop({ signal = null, sleep = sleepMs } = {}) {
      log.info(`[COIN-BLACKLIST-START] coin quality learner armed (recompute every ${RECOMPUTE_INTERVAL_SEC}s, lookback ${LOOKBACK_DAYS}d)`);
      c.restoreFromKv();
      if (now() - lastCalcTs > RECOMPUTE_INTERVAL_SEC) {
        try { c.recompute(); } catch (e) { log.warning(`[COIN-BLACKLIST] initial recompute fail: ${e && e.message}`); }
      }
      while (!(signal && signal.aborted)) {
        try {
          await sleep(LOOP_SLEEP_SEC * 1000);
          if (signal && signal.aborted) return;
          if (now() - lastCalcTs >= RECOMPUTE_INTERVAL_SEC) c.recompute();
        } catch (e) {
          log.warning(`[COIN-BLACKLIST] loop error: ${e && e.message} — sleeping 60s`);
          await sleep(60 * 1000);
        }
      }
    },

    _resetForTests() { blacklist = new Map(); lastCalcTs = 0.0; },
  };
  return c;
}

const defaultLearner = createCoinQualityLearner();

module.exports = {
  KV_KEY, MIN_TRADES, PF_THRESHOLD, BLACKLIST_TTL_SEC, RECOMPUTE_INTERVAL_SEC, LOOKBACK_DAYS, LOOP_SLEEP_SEC,
  VALID_STRATEGIES, createCoinQualityLearner, defaultLearner,
  isBlacklisted: (...a) => defaultLearner.isBlacklisted(...a),
  getBlacklistSnapshot: () => defaultLearner.getBlacklistSnapshot(),
  restoreBlacklistFromKv: () => defaultLearner.restoreFromKv(),
  recomputeBlacklist: () => defaultLearner.recompute(),
};
