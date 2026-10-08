'use strict';
/**
 * apply.js — the genome → user settings paths (genome-challenge-profiles.md §1.12–§1.13):
 *
 *   userTfsForStrategy(row, strategy)            _user_tfs_for_strategy (lower-case TF set)
 *   autoApplyBestGenome(strategy, tf, best, deps) _auto_apply_best_genome — the ONLY evolution → live
 *       path: gates fitness ≥ 0.5, WR ≥ 50, PF ≥ 1.3, N ≥ 20, env kill switch, non-empty genome;
 *       VOLUME → kv volume_cfg_<uid> (volumeUserCfg.saveUserCfg, prefs kept) for opted-in users on
 *       vol_timeframe = tf; LEVELS {min_rr, min_quality, tp1_rr} / SMC {min_rr, min_quality =
 *       min_confirmations} → optimizer_params for opted-in users whose strategy TF matches.
 *   applyBestToUser(userId, strategy, tf, deps)  apply_best_to_user (Mini App / dashboard "apply"):
 *       VOLUME → kv volume_cfg_<uid>; SMC → trader_settings.smc_cfg JSON merge; LEVELS → the
 *       trader_settings columns named like the genes (bools stored 0/1). Returns the bot dict.
 *
 * Tables: the bot `users` row is the site's trader_settings row (same column names), the bot
 * kv is engine_kv; mutation_log.emit_mutation → audit_log (action "genome_apply").
 */

const { pyFloat, pyTruthy } = require('../../strategies/common/pyval');
const { pyIntOf } = require('./constraints');
const { pyNe } = require('./operators');
const { pyDumps, parsePyJson, FLOAT_GENE_KEYS } = require('./geneSpace');
const C = require('./config');

const defaultLog = () => require('../../utils/logger');
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const f0 = (x) => (pyTruthy(x) ? pyFloat(x) : 0);
const i0 = (x) => (pyTruthy(x) ? pyIntOf(x) : 0);
const fitOf = (g) => (g && g.fitness !== undefined && g.fitness !== null ? g.fitness : 0);

function resolve(deps = {}) {
  const store = deps.store || require('./store');
  return {
    store,
    db: deps.db || store.getDb(),
    log: deps.log || defaultLog(),
    env: deps.env || process.env,
    now: deps.now || (() => Date.now() / 1000),
    volumeUserCfg: deps.volumeUserCfg || require('../volumeUserCfg'),
    invalidate: deps.invalidate || (() => { try { require('../traderSettingsService').invalidateCache(); } catch (_e) { /* */ } }),
  };
}

/** _user_tfs_for_strategy(row, strategy) → Set of lower-case TFs. */
function userTfsForStrategy(row, strategy) {
  const S = String(strategy || '').toUpperCase();
  if (S === 'SMC') {
    let tfKey = '1H';
    try {
      const cfg = JSON.parse((row && row.smc_cfg) || '{}');
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new TypeError('not a dict');
      tfKey = String(pyTruthy(cfg.tf_key) ? cfg.tf_key : '1H');
    } catch (_e) {
      tfKey = '1H';
    }
    return new Set([tfKey.toLowerCase()]);
  }
  let keys = [];
  if (pyTruthy(row.long_active)) keys.push('long_tf');
  if (pyTruthy(row.short_active)) keys.push('short_tf');
  if (pyTruthy(row.active) && String(row.scan_mode || '') === 'both') keys.push('timeframe');
  if (!keys.length) keys = ['long_tf', 'short_tf'];
  const tfs = new Set(keys.map((k) => String(row[k] || '').toLowerCase()));
  tfs.delete('');
  return tfs.size ? tfs : new Set(['1h']);
}

/**
 * _auto_apply_best_genome(strategy, tf, best) → summary {applied, users, params, reason}
 * (the bot returns None; the summary is for the caller's logs/tests only).
 */
function autoApplyBestGenome(strategy, tf, best, deps = {}) {
  const d = resolve(deps);
  if (!best || !Object.keys(best).length) return { applied: 0, reason: 'no_best' };
  const fitness = f0(best.fitness);
  const wr = f0(best.winrate);
  const pf = f0(best.profit_factor);
  const nTrd = i0(best.trades);
  if (fitness < C.AUTO_APPLY_MIN_FITNESS) return { applied: 0, reason: 'fitness' };
  if (wr < C.AUTO_APPLY_MIN_WR || pf < C.AUTO_APPLY_MIN_PF) return { applied: 0, reason: 'wr_pf' };
  if (nTrd < C.AUTO_APPLY_MIN_TRADES) return { applied: 0, reason: 'trades' };
  if (!C.genomeAutoApplyEnabled(d.env)) {
    d.log.warn(`🧬 GENOME_AUTO_APPLY_ENABLED=0 — skip auto-apply (would have applied: strat=${strategy} tf=${tf} fitness=${fitness.toFixed(3)} WR=${wr.toFixed(1)}% PF=${pf.toFixed(2)} N=${nTrd})`);
    return { applied: 0, reason: 'kill_switch' };
  }
  const genome = best.genome || {};
  if (!Object.keys(genome).length) return { applied: 0, reason: 'empty_genome' };

  const S = String(strategy).toUpperCase();
  const tail = `(fit=${fitness.toFixed(3)} WR=${wr.toFixed(1)}% PF=${pf.toFixed(2)} N=${nTrd})`;
  if (S === 'VOLUME') {
    try {
      const uids = d.db.prepare(
        'SELECT user_id FROM trader_settings WHERE genome_auto_apply=1 '
        + "AND (strategy='VOLUME' OR COALESCE(extra_strategies,'') LIKE '%VOLUME%') AND vol_timeframe=?",
      ).all(tf).map((r) => Number(r.user_id));
      for (const uid of uids) d.volumeUserCfg.saveUserCfg(uid, genome);
      if (uids.length) d.log.info(`🧬 [AUTO-APPLY] VOLUME/${tf} → ${uids.length} users ${tail}`);
      return { applied: uids.length, users: uids, params: genome };
    } catch (e) {
      d.log.warn(`🧬 auto_apply VOLUME/${tf} failed: ${e.message}`);
      return { applied: 0, reason: 'error' };
    }
  }
  const params = {};
  if (S === 'LEVELS') {
    if (own(genome, 'min_rr')) params.min_rr = pyFloat(genome.min_rr);
    if (own(genome, 'min_quality')) params.min_quality = pyIntOf(genome.min_quality);
    if (own(genome, 'tp1_rr')) params.tp1_rr = pyFloat(genome.tp1_rr);
  } else {
    if (own(genome, 'min_rr')) params.min_rr = pyFloat(genome.min_rr);
    if (own(genome, 'min_confirmations')) params.min_quality = pyIntOf(genome.min_confirmations);
  }
  if (!Object.keys(params).length) return { applied: 0, reason: 'no_params' };

  let uids;
  try {
    const rows = d.db.prepare(
      'SELECT user_id, timeframe, long_tf, short_tf, long_active, short_active, active, scan_mode, smc_cfg '
      + 'FROM trader_settings WHERE genome_auto_apply=1',
    ).all();
    uids = rows.filter((r) => userTfsForStrategy(r, S).has(String(tf).toLowerCase())).map((r) => Number(r.user_id));
  } catch (e) {
    d.log.warn(`🧬 auto_apply fetch users (${strategy}/${tf}): ${e.message}`);
    return { applied: 0, reason: 'error' };
  }
  if (!uids.length) return { applied: 0, users: [], params };

  let applied = 0;
  for (const uid of uids) {
    try {
      d.store.saveOptimizerParams(uid, S, params, { now: d.now });
      applied += 1;
    } catch (e) {
      d.log.debug(`auto_apply uid=${uid}: ${e.message}`);
    }
  }
  if (applied) d.log.info(`🧬 [AUTO-APPLY] ${strategy}/${tf} → ${applied} users: ${pyDumps(params)} ${tail}`);
  return { applied, users: uids, params };
}

/** metrics.mutation_log.emit_mutation("genome_apply", …) → audit_log (best effort). */
function emitMutation(db, userId, target, changed, best) {
  try {
    const meta = {
      actor: `user:${userId}`, target, before: '', after: changed,
      context: {
        fitness: best.fitness, winrate: best.winrate, pf: best.profit_factor, trades: best.trades,
        changed_keys: Object.keys(changed).sort(),
      },
    };
    db.prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata) VALUES (?, ?, ?, ?, ?)')
      .run(Number(userId), 'genome_apply', 'genome', null, JSON.stringify(meta));
  } catch (_e) { /* mutation log is best-effort */ }
}

/**
 * apply_best_to_user(user_id, strategy, tf=None) →
 *   {ok: true, changed, fitness, winrate, pf, trades} | {ok: false, error}
 */
function applyBestToUser(userId, strategy, tf = null, deps = {}) {
  const d = resolve(deps);
  const t = tf || C.getDefaultTf(strategy);
  const lastGen = d.store.getLastGeneration(strategy, t);
  if (lastGen === 0) return { ok: false, error: `Нет эволюции для ${strategy}/${t}` };
  const pop = d.store.getCurrentPopulation(strategy, t, lastGen);
  if (!pop.length) return { ok: false, error: 'Популяция пустая' };
  let best = pop[0];
  for (let i = 1; i < pop.length; i++) if (fitOf(pop[i]) > fitOf(best)) best = pop[i];
  if (fitOf(best) <= 0 || (best.trades || 0) < C.EVAL_MIN_TRADES) {
    return { ok: false, error: 'Лучший геном имеет fitness=0 — не применяем' };
  }

  let user;
  try {
    user = d.db.prepare('SELECT * FROM trader_settings WHERE user_id=?').get(Number(userId));
    if (!user) return { ok: false, error: 'Пользователь не найден' };
  } catch (e) {
    d.log.warn(`genome.apply_best_to_user(): ${e.message}`);
    return { ok: false, error: `DB error: ${e.message}` };
  }

  const genome = best.genome || {};
  let changed = {};
  try {
    if (strategy === 'VOLUME') {
      const impl = require('../engine/volumeCfgShim').impl();
      const before = impl.toDict(d.volumeUserCfg.loadUserCfg(userId));
      d.volumeUserCfg.saveUserCfg(userId, genome);
      const after = impl.toDict(d.volumeUserCfg.loadUserCfg(userId));
      changed = {};
      for (const [k, v] of Object.entries(after)) if (pyNe(own(before, k) ? before[k] : null, v)) changed[k] = v;
    } else if (strategy === 'SMC') {
      let cfg = {};
      let srcFloats = new Set();
      try {
        const parsed = parsePyJson(user.smc_cfg || '{}');
        cfg = parsed.value;
        srcFloats = parsed.floatKeys;
      } catch (_e) {
        d.log.warn('genome.apply_best_to_user() unhandled exception');
        cfg = {};
      }
      if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
        // json.loads gave a non-dict → `cfg_dict.get(k)` raises AttributeError → "Apply error: …"
        const pyType = cfg === null ? 'NoneType' : Array.isArray(cfg) ? 'list' : typeof cfg === 'string' ? 'str'
          : typeof cfg === 'boolean' ? 'bool' : Number.isInteger(cfg) ? 'int' : 'float';
        throw new Error(`'${pyType}' object has no attribute 'get'`);
      }
      for (const [k, v] of Object.entries(genome)) {
        if (pyNe(own(cfg, k) ? cfg[k] : null, v)) {
          cfg[k] = v;
          changed[k] = v;
        }
      }
      // Python keeps each value's own type: untouched keys as they were in the stored JSON,
      // genome-written keys with the genome's type (float genes are floats).
      const floatKeys = new Set([...srcFloats].filter((k) => !own(changed, k)));
      for (const k of Object.keys(changed)) if (FLOAT_GENE_KEYS.has(k)) floatKeys.add(k);
      d.db.prepare('UPDATE trader_settings SET smc_cfg=?, updated_at=? WHERE user_id=?')
        .run(pyDumps(cfg, { floatKeys }), d.now(), Number(userId));
      d.invalidate();
    } else {
      const cols = new Set(d.db.prepare('PRAGMA table_info(trader_settings)').all().map((r) => r.name));
      const updates = [];
      const params = [];
      for (const [k, v0] of Object.entries(genome)) {
        if (!cols.has(k)) continue;
        if (pyNe(own(user, k) ? user[k] : null, v0)) {
          const v = typeof v0 === 'boolean' ? (v0 ? 1 : 0) : v0;
          updates.push(`${k}=?`);
          params.push(v);
          changed[k] = v;
        }
      }
      if (updates.length) {
        params.push(d.now(), Number(userId));
        d.db.prepare(`UPDATE trader_settings SET ${updates.join(', ')}, updated_at=? WHERE user_id=?`).run(...params);
        d.invalidate();
      }
    }
  } catch (e) {
    d.log.warn(`apply_best_to_user: ${e.message}`);
    return { ok: false, error: `Apply error: ${e.message}` };
  }

  if (Object.keys(changed).length) emitMutation(d.db, userId, `${strategy}/${t}`, changed, best);
  return { ok: true, changed, fitness: best.fitness, winrate: best.winrate, pf: best.profit_factor, trades: best.trades };
}

module.exports = { userTfsForStrategy, autoApplyBestGenome, applyBestToUser };
