'use strict';
/**
 * store.js — the genome's SQLite I/O (genome-challenge-profiles.md §1.14) on the site DB:
 * genome_population / genome_history / optimizer_params (migration v11, verbatim bot
 * schema) and the bot kv keys in engine_kv.
 *
 *   savePopulationBatch(S, tf, gen, items)  one INSERT per individual (one transaction) → ids
 *   getCurrentPopulation(S, tf, gen)        rows ORDER BY fitness DESC → {id, genome, fitness, …}
 *   getLastGeneration(S, tf)                MAX(generation) or 0
 *   getHistory(S, tf, limit=20)             last N rows, ASCENDING generation, best_genome parsed
 *   saveGenerationHistory(S, tf, gen, pop)  INSERT OR REPLACE (best = first max fitness, avg = Σ/n)
 *   getLastMutationInfo(S, tf)              the AI-filter `genome_engine` probe (60 s cache)
 *   saveOptimizerParams(uid, S, params)     optimizer._save_params (INSERT OR REPLACE, json.dumps)
 *   loadOptimizerParams(uid, S)             the scanner side (JSON or null)
 *   kvGet / kvSet / kvDelete / kvKeysWithPrefix   engine_kv
 *
 * The handle is injectable (`setDb`) so the worker thread uses its own connection.
 */

const { pySum } = require('../../strategies/common/series');
const { serializeGenome, deserializeGenome, pyDumps, pyJsonLoads } = require('./geneSpace');
const C = require('./config');
const { pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods

let _db = null;
function setDb(db) { _db = db; }
function getDb() {
  if (!_db) _db = require('../../models/database');
  return _db;
}

const nowSec = () => Date.now() / 1000;
const fitOf = (g) => (g && g.fitness !== undefined && g.fitness !== null ? g.fitness : 0);
const mget = (m, k, d) => (m && Object.prototype.hasOwnProperty.call(m, k) && m[k] !== undefined ? m[k] : d);

/**
 * save_population_batch(strategy, tf, generation, items): items = [{genome, metrics,
 * parent_a, parent_b, birth_type}] → the row ids in the same order ([] on failure).
 */
function savePopulationBatch(strategy, tf, generation, items, { now = nowSec, log = null } = {}) {
  if (!items || !items.length) return [];
  try {
    const db = getDb();
    const ins = db.prepare(
      'INSERT INTO genome_population (strategy, timeframe, generation, genome_json, fitness, winrate, '
      + 'profit_factor, trades, drawdown, parent_a, parent_b, birth_type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    const ids = [];
    db.transaction(() => {
      for (const it of items) {
        const m = it.metrics || {};
        const r = ins.run(
          strategy, tf, generation, serializeGenome(it.genome || {}),
          mget(m, 'fitness', 0), mget(m, 'winrate', 0), mget(m, 'profit_factor', 0), mget(m, 'trades', 0), mget(m, 'drawdown', 0),
          mget(it, 'parent_a', 0), mget(it, 'parent_b', 0), mget(it, 'birth_type', 'random'), now(),
        );
        ids.push(Number(r.lastInsertRowid));
      }
    })();
    return ids;
  } catch (e) {
    if (log) log.warn(`save_population_batch: ${e.message}`);
    return [];
  }
}

/** get_current_population(strategy, tf, generation) — [] on any error. */
function getCurrentPopulation(strategy, tf, generation) {
  try {
    const rows = getDb().prepare(
      'SELECT id, genome_json, fitness, winrate, profit_factor, trades, drawdown, parent_a, parent_b, birth_type, created_at '
      + 'FROM genome_population WHERE strategy=? AND timeframe=? AND generation=? ORDER BY fitness DESC',
    ).all(strategy, tf, generation);
    return rows.map((r) => ({
      id: r.id,
      genome: deserializeGenome(r.genome_json),
      fitness: r.fitness,
      winrate: r.winrate,
      profit_factor: r.profit_factor,
      trades: r.trades,
      drawdown: r.drawdown,
      parent_a: r.parent_a,
      parent_b: r.parent_b,
      birth_type: r.birth_type,
      created_at: r.created_at,
    }));
  } catch (_e) {
    return [];
  }
}

/** get_last_generation(strategy, tf) → MAX(generation) or 0. */
function getLastGeneration(strategy, tf) {
  try {
    const row = getDb().prepare('SELECT MAX(generation) AS g FROM genome_population WHERE strategy=? AND timeframe=?').get(strategy, tf);
    return row && row.g ? Math.trunc(Number(row.g)) : 0;
  } catch (_e) {
    return 0;
  }
}

/** get_history(strategy, tf, limit=20): last `limit` generations in ASCENDING order. */
function getHistory(strategy, tf, limit = 20) {
  try {
    const rows = getDb().prepare(
      'SELECT generation, best_fitness, avg_fitness, best_wr, best_pf, best_genome_json, pop_size, created_at '
      + 'FROM genome_history WHERE strategy=? AND timeframe=? ORDER BY generation DESC LIMIT ?',
    ).all(strategy, tf, limit);
    return rows.map((r) => ({
      generation: r.generation,
      best_fitness: r.best_fitness,
      avg_fitness: r.avg_fitness,
      best_wr: r.best_wr,
      best_pf: r.best_pf,
      best_genome: deserializeGenome(r.best_genome_json),
      pop_size: r.pop_size,
      created_at: r.created_at,
    })).reverse();
  } catch (_e) {
    return [];
  }
}

/** save_generation_history(strategy, tf, generation, population) */
function saveGenerationHistory(strategy, tf, generation, population, { now = nowSec, log = null } = {}) {
  if (!population || !population.length) return;
  try {
    let best = population[0];
    for (let i = 1; i < population.length; i++) if (fitOf(population[i]) > fitOf(best)) best = population[i];
    const fits = population.map(fitOf);
    const avg = fits.length ? pySum(fits) / fits.length : 0;
    getDb().prepare(
      'INSERT OR REPLACE INTO genome_history (strategy, timeframe, generation, best_fitness, avg_fitness, best_wr, '
      + 'best_pf, best_genome_json, pop_size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ).run(strategy, tf, generation, fitOf(best), avg, mget(best, 'winrate', 0), mget(best, 'profit_factor', 0),
      serializeGenome(mget(best, 'genome', {})), population.length, now());
  } catch (e) {
    if (log) log.debug(`save_generation_history: ${e.message}`);
  }
}

// ── get_last_mutation_info (AI-filter layer genome_engine), 60 s cache ──
const _mutationInfoCache = new Map();

function getLastMutationInfo(strategy, tf = null, { now = nowSec() } = {}) {
  if (!strategy) return null;
  const S = pyUpper(String(strategy));
  let t = tf;
  if (!C.getTfs(S).includes(t)) t = C.getDefaultTf(S);
  const key = `${S}|${t}`;
  const cached = _mutationInfoCache.get(key);
  if (cached && now - cached[0] < 60) return cached[1];
  let rows = [];
  try {
    rows = getDb().prepare(
      'SELECT generation, best_wr, best_fitness, created_at FROM genome_history WHERE strategy=? AND timeframe=? ORDER BY generation DESC LIMIT 2',
    ).all(S, t);
  } catch (_e) { rows = []; }
  let info = null;
  if (rows.length) {
    const r0 = rows[0];
    const prevWr = rows.length > 1 ? rows[1].best_wr : r0.best_wr;
    const { pyRound, pyMax } = require('../../strategies/common/pyround');
    info = {
      generation: Math.trunc(Number(r0.generation || 0)),
      hours_since_mutation: pyMax(0.0, (now - Number(r0.created_at || 0)) / 3600),
      improvement_pct: pyRound(Number(r0.best_wr || 0) - Number(prevWr || 0), 2),
      best_wr: Number(r0.best_wr || 0),
      best_fitness: Number(r0.best_fitness || 0),
    };
  }
  _mutationInfoCache.set(key, [now, info]);
  return info;
}

function _clearMutationInfoCache() { _mutationInfoCache.clear(); }

// ── optimizer_params (optimizer._save_params / load_params + optimizer_cache) ──
// optimizer_cache: {(uid, S): {"params": dict(params), "ts"}} with a 4 h TTL; set_cached_params
// fails (and caches nothing) for a value dict() rejects — None / a list / a scalar.
const PARAMS_CACHE_TTL_S = 4 * 3600;
const _paramsCache = new Map();
const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function _cacheParams(k, params, now) {
  if (isDict(params)) _paramsCache.set(k, { params: { ...params }, ts: now });
}

/** _save_params: INSERT OR REPLACE json.dumps(params); never raises (log.warning). */
function saveOptimizerParams(userId, strategy, params, { now = nowSec, log = null } = {}) {
  try {
    getDb().prepare('INSERT OR REPLACE INTO optimizer_params (user_id, strategy, params, updated_at) VALUES (?, ?, ?, ?)')
      .run(Number(userId), strategy, pyDumps(params), now());
    _cacheParams(`${userId}|${strategy}`, params, now());
  } catch (e) {
    if (log) log.warn(`_save_params uid=${userId} strat=${strategy}: ${e.message}`);
  }
}

/**
 * load_params: the cached dict (≤ 4 h old) or json.loads of the row — any JSON value comes back
 * as-is (a list / scalar too); no row / empty text / a DB or JSON error → null.
 */
function loadOptimizerParams(userId, strategy, { now = nowSec } = {}) {
  const k = `${userId}|${strategy}`;
  const hit = _paramsCache.get(k);
  if (hit) {
    if (now() - hit.ts > PARAMS_CACHE_TTL_S) _paramsCache.delete(k);
    else return { ...hit.params };
  }
  try {
    const row = getDb().prepare('SELECT params FROM optimizer_params WHERE user_id=? AND strategy=?').get(Number(userId), strategy);
    if (!row || !row.params) return null;
    const p = pyJsonLoads(row.params);
    _cacheParams(k, p, now());
    return isDict(p) ? { ...p } : p;
  } catch (_e) {
    return null;
  }
}

function _clearParamsCache() { _paramsCache.clear(); }

// ── engine_kv (db_kv_get / db_kv_set / db_kv_delete / db_kv_keys_with_prefix) ──
function kvGet(key) {
  const row = getDb().prepare('SELECT value FROM engine_kv WHERE key = ?').get(String(key));
  return row ? row.value : null;
}

function kvSet(key, value, { now = nowSec } = {}) {
  getDb().prepare(
    'INSERT INTO engine_kv (key, value, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(String(key), String(value), now());
}

function kvDelete(key) {
  return getDb().prepare('DELETE FROM engine_kv WHERE key = ?').run(String(key)).changes;
}

function kvKeysWithPrefix(prefix) {
  const esc = String(prefix).replace(/[\\%_]/g, (c) => `\\${c}`);
  return getDb().prepare("SELECT key FROM engine_kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key").all(`${esc}%`).map((r) => r.key);
}

module.exports = {
  setDb, getDb,
  savePopulationBatch, getCurrentPopulation, getLastGeneration, getHistory, saveGenerationHistory,
  getLastMutationInfo, _clearMutationInfoCache,
  saveOptimizerParams, loadOptimizerParams, _clearParamsCache,
  kvGet, kvSet, kvDelete, kvKeysWithPrefix,
};
