'use strict';
/**
 * traderCommon.js — small pieces shared by the four trader ports.
 *
 *   safeKeyId(key)                  log_utils.safe_key_id (sha256[:8], 'none' for empty)
 *   apiKeyHash(key)                 db.core._api_key_hash (sha256[:32]) — engine_kv `bybit_mode:<hash>`
 *   pyDiv(a, b)                     float division raising ZeroDivisionError like CPython
 *   killswitchGate(rt, ctx)         defense.killswitch.require_active → error dict when halted
 *   planGateDeny(rt, uid, sym, src) plan_gate.deny_reason (exceptions swallowed at debug, like the bot)
 *   recordPlaced(rt, …)             metrics trade_placed / trade_placement_latency_ms / sl_tp_attached
 *   aioQuery(params)                aiohttp/yarl query string for `params={...}` (plain values)
 */

const crypto = require('crypto');
const { PyError, errStr, yarlQueryFromParams } = require('./pyCompat');

function sha256hex(s) {
  return crypto.createHash('sha256').update(Buffer.from(String(s), 'utf8')).digest('hex');
}

function safeKeyId(key) {
  if (!key) return 'none';
  return sha256hex(key).slice(0, 8);
}

function apiKeyHash(key) {
  return sha256hex(key).slice(0, 32);
}

function pyDiv(a, b) {
  if (b === 0) throw new PyError('ZeroDivisionError', 'float division by zero');
  return a / b;
}

/** → null when trading may proceed, else the bot's `{ok:False, order_id:"", error:"killswitch_halted: <state>"}`. */
async function killswitchGate(rt, context) {
  try {
    await rt.killswitch.requireActive(context);
  } catch (e) {
    if (e && e.killswitchHalted) return { ok: false, order_id: '', error: `killswitch_halted: ${e.state}` };
    throw e;
  }
  return null;
}

async function planGateDeny(rt, userId, symbol, source) {
  try {
    const deny = await rt.planGate.denyReason(userId, symbol, source);
    if (deny !== null && deny !== undefined) return deny;
  } catch (e) {
    rt.log.debug(`plan_gate check uid=${userId}: ${errStr(e)}`);
  }
  return null;
}

async function recordPlaced(rt, { symbol, direction, exchange, t0, tpPlaced }) {
  try {
    const tags = { symbol, direction, exchange };
    await rt.metrics.record('trade_placed', 1.0, tags);
    const ms = Math.trunc((rt.monotonic() - t0) * 1000);
    await rt.metrics.record('trade_placement_latency_ms', ms, tags);
    if (tpPlaced) await rt.metrics.record('sl_tp_attached', 1.0, tags);
  } catch (e) {
    rt.log.debug(`metrics trade_placed (${exchange}): ${errStr(e)}`);
  }
}

/** Query string aiohttp/yarl builds from `params={...}` (QUERY_PART_QUOTER per key/value). */
function aioQuery(params) {
  return yarlQueryFromParams(params);
}

/** First key of a Map (Python `next(iter(d))`). */
function firstKey(m) {
  const it = m.keys().next();
  return it.done ? undefined : it.value;
}

module.exports = { sha256hex, safeKeyId, apiKeyHash, pyDiv, killswitchGate, planGateDeny, recordPlaced, aioQuery, firstKey };
