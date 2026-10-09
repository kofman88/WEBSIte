'use strict';
/**
 * planGate.js — port of plan_gate.py, the traders' last-mile plan check (defense in depth
 * below execute_auto_trade's own plan gate). Wired into every trader runtime as
 * `rt.planGate.denyReason(userId, symbol, source)` (services/exchanges/traderCommon.planGateDeny).
 *
 *   checkAutoTradeAllowed(uid) → [allowed, planName]
 *     uid ≤ 0 → [true, ''];  admin → [true, 'admin'];  sub_plan empty → [true, ''] (fail-open);
 *     free/pro/beginner/elite normalised, other names kept; unknown plan → [true, plan] + WARNING;
 *     PLAN_FEATURES[plan].auto_trade false → [false, plan];  any error → [true, '?'] + WARNING.
 *   denyReason(uid, symbol, source) → null | {ok:false, order_id:'', error:'plan_gate: <plan>
 *     disallows auto_trade', plan_gate_blocked:true}
 */

const { PLAN_FEATURES, normalizePlan } = require('../../config/planFeatures');
const { pf } = require('./pyfmt');
const { pyLower } = require('../../strategies/common/pyUnicode');

function createPlanGate({ isAdmin = null, getUser = null, log = null } = {}) {
  const logger = log || require('../marketData/mdLog').log;
  const admin = isAdmin || ((uid) => require('../traderSettingsService').isAdmin(uid));
  const userRow = getUser || (async (uid) => require('../../models/database').prepare('SELECT * FROM trader_settings WHERE user_id=?').get(Number(uid)) || null);

  async function checkAutoTradeAllowed(userId) {
    if (userId <= 0) return [true, ''];
    try {
      if (await admin(userId)) return [true, 'admin'];
      const row = await userRow(userId);
      const plan = (row || {}).sub_plan || '';
      if (!plan) return [true, ''];
      const key = ['free', 'pro', 'beginner', 'elite'].includes(pyLower(String(plan))) ? normalizePlan(plan) : plan;
      const feat = Object.prototype.hasOwnProperty.call(PLAN_FEATURES, key) ? PLAN_FEATURES[key] : null;
      if (feat === null) {
        logger.warning(pf('[PLAN-GATE] unknown plan uid=%s plan=%r', userId, plan));
        return [true, plan];
      }
      if (!feat.auto_trade) return [false, plan];
      return [true, plan];
    } catch (e) {
      logger.warning(pf('[PLAN-GATE] check failed uid=%s: %s — fail-open', userId, e && e.message));
      return [true, '?'];
    }
  }

  async function denyReason(userId, symbol, source) {
    const [ok, plan] = await checkAutoTradeAllowed(userId);
    if (ok) return null;
    logger.warning(pf('[PLAN-GATE] uid=%s sym=%s source=%s blocked: plan=%s disallows auto_trade', userId, symbol, source, plan));
    return { ok: false, order_id: '', error: `plan_gate: ${plan} disallows auto_trade`, plan_gate_blocked: true };
  }

  return { checkAutoTradeAllowed, denyReason };
}

module.exports = { createPlanGate };
