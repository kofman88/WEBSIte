'use strict';
/**
 * killswitch.js — port of defense/killswitch.py: the admin-level global halt of the trade flow.
 *
 * States ACTIVE | HALTED_NEW | HALTED_ALL; the bot's single-row `operational_state` table lives
 * in engine_kv under OPERATIONAL_STATE_KEY as JSON {state, reason, actor_uid, changed_at,
 * resume_token}. 5 s cache on the monotonic clock; a read error → ('HALTED_ALL',
 * 'db_read_failed'), never cached (self-heals on the next call); a missing row → ACTIVE (the
 * bot's fresh-install path); an unknown state → ('HALTED_ALL', 'invalid_state_in_db').
 *
 *   getState() / requireActive(context) / setState(state, {reason, actorUid}) →
 *   resume token / validateAndConsumeResumeToken(token) / currentStatus() / invalidateCache()
 *
 * requireActive throws KillswitchHalted (str "<STATE>: <reason>", `.killswitchHalted` for the
 * trader runtimes' killswitchGate). Both halted states block every new-trade entry point.
 */

const crypto = require('crypto');
const { pf } = require('./pyfmt');

const STATE_ACTIVE = 'ACTIVE';
const STATE_HALTED_NEW = 'HALTED_NEW';
const STATE_HALTED_ALL = 'HALTED_ALL';
const VALID_STATES = new Set([STATE_ACTIVE, STATE_HALTED_NEW, STATE_HALTED_ALL]);
const CACHE_TTL_S = 5.0;
const OPERATIONAL_STATE_KEY = 'operational_state';

class KillswitchHalted extends Error {
  constructor(state, reason, context = '') {
    super(reason ? `${state}: ${reason}` : state);
    this.name = 'KillswitchHalted';
    this.pyType = 'KillswitchHalted';
    this.state = state;
    this.reason = reason;
    this.context = context;
    this.killswitchHalted = true;
  }
}

/** secrets.token_urlsafe(12): 12 random bytes, base64url without padding (16 chars). */
function tokenUrlsafe(n = 12) {
  return crypto.randomBytes(n).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createKillswitch({
  kv = null, monotonic = null, now = () => Date.now() / 1000, log = null, emitMutation = null, token = tokenUrlsafe,
} = {}) {
  const store = kv || require('../engineKvService');
  const mono = monotonic || (() => Number(process.hrtime.bigint()) / 1e9);
  const logger = log || require('../marketData/mdLog').log;
  let cache = null;   // [state, reason, fetchedAtMono]

  function readRow() {
    const raw = store.get(OPERATIONAL_STATE_KEY);
    if (raw === null || raw === undefined) return null;
    return JSON.parse(raw);
  }

  async function loadStateFromDb() {
    try {
      const row = readRow();
      if (!row) return [STATE_ACTIVE, ''];
      const state = row.state || STATE_ACTIVE;
      if (!VALID_STATES.has(state)) {
        logger.warning(pf('[KILLSWITCH] invalid state %r in DB — fail-safe HALTED_ALL', state));
        return [STATE_HALTED_ALL, 'invalid_state_in_db'];
      }
      return [state, row.reason || ''];
    } catch (e) {
      logger.warning(`[KILLSWITCH] DB read failed — fail-safe HALTED_ALL: ${e && e.message}`);
      return [STATE_HALTED_ALL, 'db_read_failed'];
    }
  }

  const cacheFresh = () => cache !== null && (mono() - cache[2]) < CACHE_TTL_S;

  function invalidateCache() { cache = null; }

  async function getState() {
    if (cacheFresh()) return [cache[0], cache[1]];
    const [state, reason] = await loadStateFromDb();
    if (reason !== 'db_read_failed') cache = [state, reason, mono()];
    return [state, reason];
  }

  async function requireActive(context) {
    const [state, reason] = await getState();
    if (state !== STATE_ACTIVE) throw new KillswitchHalted(state, reason, context);
  }

  async function setState(newState, { reason = '', actorUid = 0 } = {}) {
    if (!VALID_STATES.has(newState)) {
      const e = new Error(pf('unknown killswitch state: %r', newState));
      e.pyType = 'ValueError';
      throw e;
    }
    const [prevState, prevReason] = await loadStateFromDb();
    const resumeToken = newState !== STATE_ACTIVE ? token(12) : '';
    store.set(OPERATIONAL_STATE_KEY, JSON.stringify({
      state: newState, reason: reason || '', actor_uid: Math.trunc(Number(actorUid || 0)),
      changed_at: Math.trunc(now()), resume_token: resumeToken || '',
    }));
    invalidateCache();
    logger.warning(pf('[KILLSWITCH] state %s → %s (reason=%r actor=%s)', prevState, newState, reason, actorUid));
    try {
      if (emitMutation) {
        await emitMutation('killswitch_flipped', {
          actor: `admin:${actorUid}`, target: 'operational_state', before: prevState, after: newState,
          context: { reason: reason || '', token_issued: Boolean(resumeToken), prev_reason: prevReason || '' },
        });
      }
    } catch (e) {
      logger.warning(`[KILLSWITCH] emit_mutation failed: ${e && e.message}`);
    }
    return resumeToken;
  }

  async function validateAndConsumeResumeToken(tok) {
    const t = String(tok || '').trim();
    if (!t) return false;
    let stored = '';
    try {
      const row = readRow();
      stored = row && row.resume_token ? String(row.resume_token) : '';
    } catch (e) {
      logger.warning(`[KILLSWITCH] resume-token read failed: ${e && e.message}`);
      return false;
    }
    if (!stored || stored !== t) return false;
    const [state] = await loadStateFromDb();
    if (state === STATE_ACTIVE) return false;
    const row = readRow();
    store.set(OPERATIONAL_STATE_KEY, JSON.stringify({ ...row, resume_token: '' }));
    return true;
  }

  async function currentStatus() {
    let row;
    try {
      row = readRow();
    } catch (e) {
      return {
        state: STATE_HALTED_ALL, reason: 'db_read_failed', actor_uid: 0, changed_at: 0,
        has_resume_token: false, cache_age_s: null, db_error: String(e && e.message),
      };
    }
    if (!row) {
      return { state: STATE_ACTIVE, reason: '', actor_uid: 0, changed_at: 0, has_resume_token: false, cache_age_s: null };
    }
    return {
      state: row.state || STATE_ACTIVE, reason: row.reason || '', actor_uid: Math.trunc(Number(row.actor_uid || 0)),
      changed_at: Math.trunc(Number(row.changed_at || 0)), has_resume_token: Boolean(row.resume_token),
      cache_age_s: cache ? mono() - cache[2] : null,
    };
  }

  return { getState, requireActive, setState, validateAndConsumeResumeToken, currentStatus, invalidateCache, loadStateFromDb };
}

let _default = null;
function defaultKillswitch() {
  if (!_default) _default = createKillswitch();
  return _default;
}

module.exports = {
  STATE_ACTIVE, STATE_HALTED_NEW, STATE_HALTED_ALL, VALID_STATES, CACHE_TTL_S, OPERATIONAL_STATE_KEY,
  KillswitchHalted, createKillswitch, defaultKillswitch, tokenUrlsafe,
};
