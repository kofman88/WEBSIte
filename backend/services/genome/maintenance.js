'use strict';
/**
 * maintenance.js — genome_maintenance.py + genome.gc_coin_champions (genome-challenge-
 * profiles.md §1.16):
 *
 *   gcCoinChampions(deps)          delete genome_coin_champ_* kv entries older than 30 d (or
 *                                  unparsable), then the oldest above 200 → {expired, lru_evicted, remaining}
 *   refreshLiveBaselineAll(deps)   validate_via_paper({"min_rr": 1.0}, S, tf) for every (S, tf)
 *                                  in STRATEGY_TFS (rewrites the live-baseline kv), 0.5 s apart
 *   maintenanceTick(state, deps)   one 5-minute check: GC every 24 h, baseline refresh every 6 h
 *   runGenomeMaintenanceLoop(deps) the loop (120 s initial delay, 300 s period) — NOT started here
 */

const C = require('./config');
const { validateViaPaper } = require('./paperValidation');

const GC_INTERVAL_SEC = 24 * 3600;
const BASELINE_INTERVAL_SEC = 6 * 3600;
const PREFIX = 'genome_coin_champ_';

const defaultLog = () => require('../../utils/logger');
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gcCoinChampions({ store = null, now = Date.now() / 1000, log = null } = {}) {
  const st = store || require('./store');
  const lg = log || defaultLog();
  try {
    const keys = st.kvKeysWithPrefix(PREFIX);
    if (!keys.length) return { expired: 0, lru_evicted: 0, remaining: 0 };
    const cutoff = now - C.COIN_CHAMP_TTL_DAYS * 86400;
    let expired = 0;
    const kept = [];
    for (const k of keys) {
      try {
        const raw = st.kvGet(k);
        if (!raw) continue;
        const data = JSON.parse(raw);
        const ts = Number((data && data.ts) || 0);
        if (!Number.isFinite(ts)) throw new Error('bad ts');
        if (ts < cutoff) {
          st.kvDelete(k);
          expired += 1;
        } else {
          kept.push([k, ts]);
        }
      } catch (_e) {
        st.kvDelete(k);          // corrupted entry → delete
        expired += 1;
      }
    }
    let lru = 0;
    if (kept.length > C.COIN_CHAMP_MAX_KEYS) {
      kept.sort((a, b) => a[1] - b[1]);       // oldest first (stable)
      for (const [k] of kept.slice(0, kept.length - C.COIN_CHAMP_MAX_KEYS)) {
        st.kvDelete(k);
        lru += 1;
      }
    }
    if (expired || lru) lg.info(`🧬 [GC-COIN-CHAMP] expired=${expired} lru_evicted=${lru} remaining=${kept.length - lru}`);
    return { expired, lru_evicted: lru, remaining: kept.length - lru };
  } catch (e) {
    lg.warn(`gc_coin_champions: ${e.message}`);
    return { expired: 0, lru_evicted: 0, remaining: 0 };
  }
}

async function refreshLiveBaselineAll({ store = null, now = null, log = null, sleep = realSleep, getRegime = null } = {}) {
  const lg = log || defaultLog();
  const out = [];
  try {
    const permissive = { min_rr: 1.0 };
    for (const [S, tfs] of Object.entries(C.STRATEGY_TFS)) {
      for (const tf of tfs) {
        try {
          const r = validateViaPaper(permissive, S, tf, { store, now: now === null ? Date.now() / 1000 : now(), getRegime, log: lg });
          if (r.status === 'OK') {
            const { fmtFixed } = require('../../strategies/common/pyfmt');
            lg.info(`🧬 [GENOME-MAINT] baseline refresh ${S}/${tf} OK: WR=${fmtFixed(r.paper_wr || 0, 1)}% PF=${fmtFixed(r.paper_pf || 0, 2)} N=${r.paper_trades || 0}`);
          }
          out.push({ strategy: S, tf, status: r.status });
        } catch (e) {
          lg.debug(`baseline refresh ${S}/${tf}: ${e.message}`);
        }
        await sleep(500);
      }
    }
  } catch (e) {
    lg.warn(`_refresh_live_baseline_all: ${e.message}`);
  }
  return out;
}

/** One check of the loop body; `state` = {lastGcTs, lastBaselineTs} (mutated). */
async function maintenanceTick(state, deps = {}) {
  const now = (deps.now || (() => Date.now() / 1000))();
  const done = { gc: null, baseline: null };
  if (now - state.lastGcTs >= GC_INTERVAL_SEC) {
    done.gc = gcCoinChampions({ ...deps, now });
    state.lastGcTs = now;
  }
  if (now - state.lastBaselineTs >= BASELINE_INTERVAL_SEC) {
    done.baseline = await refreshLiveBaselineAll(deps);
    state.lastBaselineTs = now;
  }
  return done;
}

/** run_genome_maintenance_loop(); `deps.stop()` → true ends it. */
async function runGenomeMaintenanceLoop(deps = {}) {
  const lg = deps.log || defaultLog();
  const sleep = deps.sleep || realSleep;
  const stop = deps.stop || (() => false);
  lg.info(`[GENOME-MAINT] maintenance loop started (GC=${GC_INTERVAL_SEC / 3600}h, baseline_refresh=${BASELINE_INTERVAL_SEC / 3600}h)`);
  await sleep(120_000);
  const state = { lastGcTs: 0.0, lastBaselineTs: 0.0 };
  while (!stop()) {
    try {
      await maintenanceTick(state, deps);
    } catch (e) {
      lg.warn(`genome_maintenance loop: ${e.message}`);
    }
    if (stop()) break;
    await sleep(300_000);
  }
}

module.exports = {
  GC_INTERVAL_SEC, BASELINE_INTERVAL_SEC, gcCoinChampions, refreshLiveBaselineAll, maintenanceTick, runGenomeMaintenanceLoop,
};
