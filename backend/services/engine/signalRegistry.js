/**
 * signalRegistry — the bot's signal_registry.py one-to-one (signal-pipeline.md §3).
 *
 * Cross-strategy per-user dedup: one slot per (uid, symbol, direction[, strategy])
 * for CROSS_TTL = 4 h. LEVELS uses the 3-tuple key, SMC / VOLUME / the
 * multi-strategy slot the 4-tuple one. `peekCanSend` checks without writing,
 * `commitSend` occupies the slot after confirmed delivery (optionally with a
 * per-call ttl_s, stored as a shifted timestamp so peek / cleanup / persist
 * keep using the strategy TTL), `applyCooldown` soft-clears after an exchange
 * position closes (POST_CLOSE_COOLDOWN_SEC, default 1800).
 *
 * Persistence: engine_kv key `signal_registry` (the bot's signal_registry.json),
 * JSON {"uid|symbol|direction[|strategy]": ts}, debounced 10 s; `forceSave()`
 * on shutdown; on load only live entries are kept (a future ts from a
 * ttl_s-shifted commit is kept).
 *
 * Markers: [REGISTRY-COOLDOWN].
 */

'use strict';

const { pyJsonDumps } = require('./pyjson');
const { pyInt, pyFloat } = require('./pycoerce');
const { pyMax, pyMin } = require('../../strategies/common/pyround');
const { log: defaultLog } = require('../marketData/mdLog');

const CROSS_TTL = 4 * 3600;        // 4 часа: покрывает 1H и 4H сигналы
const STRATEGY_TTL = Object.freeze({});   // per-strategy overrides — empty (extension point)
const CLEANUP_INTERVAL = 1800;     // автоматическая очистка каждые 30 минут
const PERSIST_KEY = 'signal_registry';
const PERSIST_INTERVAL = 10.0;     // debounce (AUDIT-FIX-C75)
const CLAIM_TTL_S = 120;
const POST_CLOSE_COOLDOWN_DEFAULT = 1800;

function ttlFor(strategy) {
  const s = strategy || '';
  return Object.prototype.hasOwnProperty.call(STRATEGY_TTL, s) ? STRATEGY_TTL[s] : CROSS_TTL;
}

/** _key(uid, symbol, direction, strategy): "uid|symbol|direction" or "…|strategy" (the bot's tuple, joined like its persist format). */
function makeKey(uid, symbol, direction, strategy = '') {
  const base = `${uid}|${symbol}|${direction}`;
  return strategy ? `${base}|${strategy}` : base;
}

/** The (uid, symbol, direction, strategy) parts of a key. */
function splitKey(key) {
  const parts = key.split('|');
  return { uid: parts[0], symbol: parts[1], direction: parts[2], strategy: parts.length > 3 ? parts.slice(3).join('|') : '' };
}

/**
 * scanner_mid._check_breakevens: `int(os.getenv("POST_CLOSE_COOLDOWN_SEC", "1800"))`.
 * Python raises on a malformed value (the post-close branch is skipped); the site
 * falls back to the default instead of skipping the cooldown.
 */
function postCloseCooldownS(env = process.env) {
  const raw = env.POST_CLOSE_COOLDOWN_SEC;
  if (raw === undefined || raw === null) return POST_CLOSE_COOLDOWN_DEFAULT;
  try {
    return pyInt(String(raw));
  } catch (_e) {
    return POST_CLOSE_COOLDOWN_DEFAULT;
  }
}

const nowSec = () => Date.now() / 1000;

/**
 * createSignalRegistry({ kv, now, log, isAdmin, isMulti })
 *   kv       — { get(key), set(key, value) } (default services/engineKvService, lazily)
 *   now      — () → unix seconds
 *   isAdmin  — (user) → bool, the bot's ADMIN_IDS bypass (default traderSettingsService.isAdmin)
 *   isMulti  — (user) → bool, `len(enabled_strategies(user)) >= 2`
 *              (default: planFeatures.isMulti(user, { admin: isAdmin(user) }); any error → False)
 */
function createSignalRegistry(deps = {}) {
  const log = deps.log || defaultLog;
  const now = deps.now || nowSec;
  const kvOf = () => (deps.kv !== undefined ? deps.kv : require('../engineKvService'));
  const isAdmin = deps.isAdmin || ((user) => {
    try {
      return require('../traderSettingsService').isAdmin(user.user_id);
    } catch (_e) {
      return false;
    }
  });
  const isMultiFn = deps.isMulti || ((user) => {
    try {
      return require('../../config/planFeatures').isMulti(user, { admin: Boolean(isAdmin(user)) });
    } catch (_e) {
      return false;
    }
  });

  const registry = new Map();   // key → ts
  const stats = { allowed: 0, blocked: 0 };
  let lastCleanup = 0.0;
  let lastPersist = 0.0;

  function cleanupLocked(t) {
    const stale = [];
    for (const [k, ts] of registry) if (t - ts > ttlFor(splitKey(k).strategy)) stale.push(k);
    for (const k of stale) registry.delete(k);
    if (stale.length) log.debug(`signal_registry cleanup: удалено ${stale.length}, осталось ${registry.size}`);
  }

  function persistSaveNow() {
    try {
      const snapshot = {};
      for (const [k, v] of registry) snapshot[k] = v;
      kvOf().set(PERSIST_KEY, pyJsonDumps(snapshot, Object.keys(snapshot)));
    } catch (e) {
      log.warning(`signal_registry save error: ${e && e.message}`);
    }
  }

  function persistSave() {
    const t = now();
    if (t - lastPersist < PERSIST_INTERVAL) return;   // QUIRK: a write inside the debounce window is skipped, not deferred
    lastPersist = t;
    persistSaveNow();
  }

  const r = {
    CROSS_TTL, CLAIM_TTL_S, PERSIST_KEY,
    _registry: registry,

    /**
     * _persist_load(): restore the live entries from kv. Like the bot, any malformed
     * timestamp aborts the whole load (nothing restored, one warning); a key whose uid
     * is not an int is skipped; only entries with now − ts < ttl are kept.
     */
    load() {
      try {
        const raw = kvOf().get(PERSIST_KEY);
        if (!raw) return 0;
        const data = JSON.parse(raw);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          throw new TypeError(`'${Array.isArray(data) ? 'list' : typeof data}' object has no attribute 'items'`);
        }
        const t = now();
        const loaded = new Map();
        for (const [kStr, ts] of Object.entries(data)) {
          const parts = String(kStr).split('|');
          if (parts.length < 3) continue;
          let uid;
          try { uid = pyInt(parts[0]); } catch (_e) { continue; }   // int(parts[0]) ValueError → skip
          const key = [String(uid), ...parts.slice(1)].join('|');
          const ttl = ttlFor(parts.length > 3 ? parts[3] : '');
          const f = pyFloat(ts);   // float(ts): TypeError / ValueError abort the load (outer except)
          if (t - f < ttl) loaded.set(key, f);   // загружаем только не истёкшие
        }
        for (const [k, v] of loaded) registry.set(k, v);
        log.info(`FIX-AUDIT-26: signal_registry загружен (${loaded.size} записей)`);
        return loaded.size;
      } catch (e) {
        log.warning(`FIX-AUDIT-26: signal_registry load error: ${e && e.message}`);
        return 0;
      }
    },

    /** Legacy can_send: check AND write in one call (the scanners use peek/commit now). */
    canSend(uid, symbol, direction, strategy = '', _quality = 0) {
      const key = makeKey(uid, symbol, direction, strategy);
      const ttl = ttlFor(strategy);
      const t = now();
      if (t - lastCleanup > CLEANUP_INTERVAL) { cleanupLocked(t); lastCleanup = t; }
      const lastTs = registry.has(key) ? registry.get(key) : 0.0;
      if (t - lastTs < ttl) { stats.blocked += 1; return false; }
      registry.set(key, t);
      stats.allowed += 1;
      persistSave();
      return true;
    },

    /** peek_can_send: no write; blocked → stats.blocked += 1. */
    peekCanSend(uid, symbol, direction, strategy = '') {
      const key = makeKey(uid, symbol, direction, strategy);
      const ttl = ttlFor(strategy);
      const t = now();
      const lastTs = registry.has(key) ? registry.get(key) : 0.0;
      if (t - lastTs < ttl) { stats.blocked += 1; return false; }
      return true;
    },

    /**
     * commit_send(uid, symbol, direction, strategy, ttl_s): occupy the slot after delivery.
     * ttl_s → ts = now + (max(60, int(ttl_s)) − ttl_strategy) so ts + ttl_strategy == now + ttl_s.
     */
    commitSend(uid, symbol, direction, strategy = '', ttlS = null) {
      const key = makeKey(uid, symbol, direction, strategy);
      const t = now();
      let ts = t;
      if (ttlS !== null && ttlS !== undefined) ts = t + (pyMax(60, pyInt(ttlS)) - ttlFor(strategy));
      if (t - lastCleanup > CLEANUP_INTERVAL) { cleanupLocked(t); lastCleanup = t; }
      registry.set(key, ts);
      stats.allowed += 1;
      persistSave();
    },

    isMulti(user) { return Boolean(isMultiFn(user)); },

    /** peek_can_send_multi(user, symbol, direction): single-strategy user → always True. */
    peekCanSendMulti(user, symbol, direction) {
      if (!r.isMulti(user)) return true;
      return r.peekCanSend(user.user_id, symbol, direction, 'MULTI');
    },

    commitSendMulti(user, symbol, direction) {
      if (r.isMulti(user)) r.commitSend(user.user_id, symbol, direction, 'MULTI');
    },

    /** [MULTI-CLAIM] provisional MULTI reservation for ttl_s (120 s) after a successful peek. */
    claimMulti(user, symbol, direction, ttlS = CLAIM_TTL_S) {
      if (r.isMulti(user)) r.commitSend(user.user_id, symbol, direction, 'MULTI', ttlS);
    },

    /** Legacy can_send_multi (check + write). */
    canSendMulti(user, symbol, direction) {
      let multi;
      try { multi = r.isMulti(user); } catch (_e) { return true; }
      if (!multi) return true;
      return r.canSend(user.user_id, symbol, direction, 'MULTI');
    },

    /** clear_for_symbol: drop every key of (uid, symbol, direction) — all strategies incl. MULTI. */
    clearForSymbol(uid, symbol, direction) {
      const toRemove = [];
      for (const k of registry.keys()) {
        const p = splitKey(k);
        if (p.uid === String(uid) && p.symbol === symbol && p.direction === direction) toRemove.push(k);
      }
      for (const k of toRemove) registry.delete(k);
      if (toRemove.length) {
        log.debug(`signal_registry: cleared ${toRemove.length} keys for uid=${uid} ${symbol} ${direction}`);
        persistSave();
      }
      return toRemove.length;
    },

    /**
     * apply_cooldown(uid, symbol, direction, cooldown_s=1800): soft-clear — every matching
     * key gets ts = now − (k_ttl − min(cooldown, k_ttl)); no key → the 3-tuple key is created
     * with ts = now − (CROSS_TTL − cooldown). peek returns True again after cooldown_s.
     */
    applyCooldown(uid, symbol, direction, cooldownS = POST_CLOSE_COOLDOWN_DEFAULT) {
      const cd = pyMax(60, pyMin(Number(cooldownS), CROSS_TTL));   // max(60, min(cooldown_s, CROSS_TTL)) — no int()
      const t = now();
      const keys = [];
      for (const k of registry.keys()) {
        const p = splitKey(k);
        if (p.uid === String(uid) && p.symbol === symbol && p.direction === direction) keys.push(k);
      }
      for (const k of keys) {
        const kTtl = ttlFor(splitKey(k).strategy);
        const kCd = pyMin(cd, kTtl);
        registry.set(k, t - (kTtl - kCd));
      }
      if (!keys.length) registry.set(makeKey(uid, symbol, direction), t - (CROSS_TTL - cd));
      log.info(`[REGISTRY-COOLDOWN] uid=${uid} ${symbol} ${direction} — block re-entry for ${Math.trunc(cd)}s`);   // %ds
      persistSave();
    },

    cleanup() { cleanupLocked(now()); },

    getStats() { return { allowed: stats.allowed, blocked: stats.blocked, active: registry.size }; },

    resetStats() { stats.allowed = 0; stats.blocked = 0; registry.clear(); },

    /** force_save(): immediate persist (shutdown hook); returns the entry count. */
    forceSave() { persistSaveNow(); return registry.size; },

    /** Raw snapshot {key: ts} (tests / admin). */
    snapshot() { const o = {}; for (const [k, v] of registry) o[k] = v; return o; },

    /** The ts stored for a key (tests). */
    get(uid, symbol, direction, strategy = '') {
      const key = makeKey(uid, symbol, direction, strategy);
      return registry.has(key) ? registry.get(key) : null;
    },
  };
  return r;
}

const defaultRegistry = createSignalRegistry();

module.exports = {
  CROSS_TTL, STRATEGY_TTL, CLEANUP_INTERVAL, PERSIST_KEY, PERSIST_INTERVAL, CLAIM_TTL_S, POST_CLOSE_COOLDOWN_DEFAULT,
  ttlFor, makeKey, splitKey, postCloseCooldownS, createSignalRegistry, defaultRegistry,
};
