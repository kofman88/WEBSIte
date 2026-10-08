'use strict';
/**
 * runtime.js — the injectable environment every trader instance runs in.
 *
 *   transport   HTTP (transport.js)
 *   now()       time.time()        seconds (float)
 *   monotonic() time.monotonic()   seconds (float)
 *   sleep(s)    time.sleep / asyncio.sleep — SECONDS
 *   random()    random.random()
 *   log         { debug, info, warning, error }
 *   kv          { get(key) → str|null, set(key, value) } — engine_kv (hedge-mode persistence)
 *   killswitch  { requireActive(context) } — throws `{ killswitchHalted: true, state }` when halted
 *   planGate    { denyReason(userId, symbol, source) → dict|null }   (plan_gate.deny_reason)
 *   metrics     { record(name, value, tags) }                       (metrics.record, best effort)
 *   events      { emit(tradeId, type, payload) }                    (db.trade_events.emit_bg)
 *   onAuthReset(exchange, apiKey) → uids                            (bybit _reset_auto_trade_for_key)
 *
 * Defaults are the production ones except the auto-trade hooks (killswitch / plan gate /
 * auth reset), which the orchestration milestone wires; until then they allow everything.
 */

const { log: mdLog } = require('../marketData/mdLog');
const { defaultTransport } = require('./transport');

const realSleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000));
const realMonotonic = () => Number(process.hrtime.bigint()) / 1e9;

let _kv = null;
function lazyKv() {
  if (_kv) return _kv;
  try {
    _kv = require('../engineKvService');
  } catch (_e) {
    const m = new Map();
    _kv = { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); } };
  }
  return _kv;
}

/** A Map-backed kv (tests). */
function memoryKv() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(String(k), String(v)); }, _map: m };
}

function makeRuntime(overrides = {}) {
  const rt = {
    transport: overrides.transport || defaultTransport(),
    now: overrides.now || (() => Date.now() / 1000),
    monotonic: overrides.monotonic || realMonotonic,
    sleep: overrides.sleep || realSleep,
    random: overrides.random || Math.random,
    log: overrides.log || mdLog,
    kv: overrides.kv || { get: (k) => lazyKv().get(k), set: (k, v) => lazyKv().set(k, v) },
    killswitch: overrides.killswitch || { requireActive: async () => {} },
    planGate: overrides.planGate || { denyReason: async () => null },
    metrics: overrides.metrics || { record: async () => {} },
    events: overrides.events || { emit: () => {} },
    onAuthReset: overrides.onAuthReset || (async () => []),
    env: overrides.env || process.env,
  };
  return rt;
}

/** Simple async mutex (threading.Lock analogue for per-key serialisation). */
function makeLock() {
  let tail = Promise.resolve();
  return {
    async run(fn) {
      const prev = tail;
      let release;
      tail = new Promise((r) => { release = r; });
      await prev;
      try { return await fn(); } finally { release(); }
    },
  };
}

module.exports = { makeRuntime, memoryKv, makeLock, realSleep, realMonotonic };
