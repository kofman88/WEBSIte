'use strict';
/**
 * idempotency.js — auto_trade's idempotency registry ([AUDIT-FIX] + [MONEY-AUDIT P1.1]).
 *
 *   makeIdempotencyKey(uid, sym, ts)  f"{uid}_{sym}_{int(ts)}_{uuid4().hex[:8]}"
 *   setIdempotency(key, status, oid)  registry[key] = {status, ts: now, order_id}; kv
 *                                     `idemp_v1_<key>` = json.dumps(rec) (fire-and-forget task)
 *   restoreIdempotencyRegistry()      start-up: live entries back into memory, expired ones
 *                                     tombstoned (''), `[IDEMPOTENCY-RESTORE] restored=… expired=… (TTL=600s)`
 *   gcIdempotencyRegistry()           drop entries older than TTL (+ kv tombstone)
 *
 * The orphan sweeper (M15) reads `registry` to spare symbols with a fresh entry attempt.
 */

const crypto = require('crypto');
const { pf } = require('./pyfmt');
const { pyDumps } = require('../engine/signalTradesRepo');

const IDEMPOTENCY_TTL = 600;
const KV_PREFIX = 'idemp_v1_';

function createIdempotency({
  now = () => Date.now() / 1000, uuidHex = () => crypto.randomUUID().replace(/-/g, ''),
  kvGet = null, kvSet = null, kvKeysWithPrefix = null, tasks = null, log = null,
} = {}) {
  const logger = log || require('../marketData/mdLog').log;
  const registry = new Map();
  const spawn = (name, fn) => {
    if (tasks) tasks.create(name, fn);
    else Promise.resolve().then(fn).catch(() => {});
  };

  function makeIdempotencyKey(uid, sym, ts) {
    const shortUuid = String(uuidHex()).slice(0, 8);
    return `${uid}_${sym}_${Math.trunc(ts)}_${shortUuid}`;
  }

  async function persistIdempotencyKv(key, rec) {
    try {
      await kvSet(`${KV_PREFIX}${key}`, pyDumps(rec, { floatKeys: ['ts'], ensureAscii: true }));
    } catch (e) {
      logger.debug(`idem persist key=${key.slice(0, 32)}: ${e && e.message}`);
    }
  }

  function setIdempotency(key, status, orderId = '') {
    const rec = { status, ts: now(), order_id: orderId };
    registry.set(key, rec);
    spawn(`idem_persist_${key.slice(0, 32)}`, () => persistIdempotencyKv(key, rec));
  }

  async function restoreIdempotencyRegistry() {
    try {
      const rows = await kvKeysWithPrefix(KV_PREFIX);
      const t = now();
      let restored = 0;
      let expired = 0;
      for (const kvKey of rows) {
        const shortKey = kvKey.slice(KV_PREFIX.length);
        try {
          const raw = await kvGet(kvKey);
          if (!raw) continue;
          const rec = JSON.parse(raw);
          if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) continue;
          if (t - Number(rec.ts || 0) >= IDEMPOTENCY_TTL) {
            await kvSet(kvKey, '');
            expired += 1;
            continue;
          }
          registry.set(shortKey, rec);
          restored += 1;
        } catch (e) {
          logger.debug(`idem restore key=${kvKey}: ${e && e.message}`);
        }
      }
      if (restored || expired) {
        logger.info(pf('[IDEMPOTENCY-RESTORE] restored=%d expired=%d (TTL=%ds)', restored, expired, IDEMPOTENCY_TTL));
      }
      return restored;
    } catch (e) {
      logger.debug(`idem restore fatal: ${e && e.message}`);
      return 0;
    }
  }

  function gcIdempotencyRegistry() {
    const t = now();
    const stale = Array.from(registry.entries()).filter(([, v]) => t - v.ts > IDEMPOTENCY_TTL).map(([k]) => k);
    for (const k of stale) {
      registry.delete(k);
      spawn('idem_gc_kv', async () => {
        try { await kvSet(`${KV_PREFIX}${k}`, ''); } catch (e) { logger.debug(`silent exc auto_trade.py: ${e && e.message}`); }
      });
    }
    return stale.length;
  }

  return { registry, makeIdempotencyKey, setIdempotency, persistIdempotencyKv, restoreIdempotencyRegistry, gcIdempotencyRegistry };
}

module.exports = { IDEMPOTENCY_TTL, KV_PREFIX, createIdempotency };
