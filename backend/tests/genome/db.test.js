/**
 * The DB-backed genome paths against the bot (make_genome_vectors.py "db": a temp bot SQLite
 * initialised by database.init_db, frozen clock NOW, market_regime.get_cached_regime patched):
 *   await genome.apply_best_to_user(uid, S, tf)          27 scenarios (LEVELS columns / SMC smc_cfg JSON /
 *                                                         VOLUME kv, + the four error branches)
 *   genome._user_tfs_for_strategy(row, S)                240 rows
 *   await genome._auto_apply_best_genome(S, tf, best)    54 cases × 14 users (gates, kill switch, TF match)
 *   await genome.check_drift(S, tf) / validate_via_paper(g, S, tf)   60 trade sets × 5 genomes, 6 regimes
 *   await genome_ui.format_genome_dashboard(S, tf) / format_genome_help()
 *   await genome.gc_coin_champions()
 * The site runs the same SQL on trader_settings / signal_trades / engine_kv / genome_* tables.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-genome-db.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';

['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

const { loadFixture, pyEqual, memLog } = require('./helpers');

let db; let store; let apply; let drift; let paper; let texts; let maint; let gs; let ts;
const D = loadFixture('db_cases');
const NOW = D.now;

beforeAll(() => {
  db = require('../../models/database');
  require('../../models/migrations').runMigrations?.(db);
  store = require('../../services/genome/store');
  apply = require('../../services/genome/apply');
  drift = require('../../services/genome/drift');
  paper = require('../../services/genome/paperValidation');
  texts = require('../../services/genome/texts');
  maint = require('../../services/genome/maintenance');
  gs = require('../../services/genome/geneSpace');
  ts = require('../../services/traderSettingsService');
});

function reset() {
  for (const t of ['signal_trades', 'trader_settings', 'genome_population', 'genome_history', 'optimizer_params', 'engine_kv', 'audit_log']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM users').run();
  store._clearParamsCache();
  ts.invalidateCache();
}

function siteUser(id) {
  db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, referral_code) VALUES (?, ?, ?, ?)').run(id, `u${id}@x.com`, 'x', `R${id}`);
}

function insertTrader(uid, row) {
  siteUser(uid);
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO trader_settings (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`)
    .run(uid, ...cols.map((c) => (typeof row[c] === 'boolean' ? (row[c] ? 1 : 0) : row[c])));
}

function insertPop(S, tf, gen, items) {
  const st = db.prepare('INSERT INTO genome_population (id, strategy, timeframe, generation, genome_json, fitness, winrate, profit_factor, trades, drawdown, parent_a, parent_b, birth_type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const it of items) {
    st.run(it.id ?? null, S, tf, gen, gs.serializeGenome(it.genome), it.fitness, it.winrate, it.profit_factor, it.trades, it.drawdown ?? 1.0,
      it.parent_a ?? 0, it.parent_b ?? 0, it.birth_type ?? 'random', it.created_at ?? NOW - 3600);
  }
}

function insertHist(S, tf, rows) {
  const st = db.prepare('INSERT OR REPLACE INTO genome_history (strategy, timeframe, generation, best_fitness, avg_fitness, best_wr, best_pf, best_genome_json, pop_size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
  for (const h of rows) st.run(S, tf, h.generation, h.best_fitness, h.avg_fitness, h.best_wr, h.best_pf, gs.serializeGenome(h.best_genome || {}), h.pop_size ?? 10, h.created_at ?? NOW);
}

function insertTrades(S, trades) {
  siteUser(1);
  const st = db.prepare('INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, result, result_rr, created_at, strategy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  trades.forEach((t, k) => st.run(`${S}-${k}`, 1, t.symbol || 'BTC-USDT-SWAP', t.direction || 'LONG', t.entry, t.sl, t.tp1, t.tp2, t.tp3 ?? 0, t.result, t.result_rr, t.created_at, S));
}

const USER_COLS = ['genome_auto_apply', 'strategy', 'extra_strategies', 'vol_timeframe', 'timeframe', 'long_tf', 'short_tf', 'long_active', 'short_active', 'active', 'scan_mode', 'smc_cfg',
  'min_rr', 'min_quality', 'vol_mult', 'vol_len', 'rsi_period', 'rsi_ob', 'rsi_os', 'use_rsi', 'use_volume', 'ema_fast', 'ema_slow', 'zone_pct', 'max_dist_pct', 'tp1_rr', 'tp2_rr', 'pivot_strength', 'cooldown_bars'];

beforeEach(() => reset());

describe('apply_best_to_user', () => {
  it('27 scenarios: same result dict, same trader_settings columns / smc_cfg JSON / volume_cfg kv as the bot', () => {
    const kinds = new Set();
    for (const [i, c] of D.apply.entries()) {
      reset();
      if (c.kind !== 'no_evolution') insertPop(c.strategy, c.tf, c.generation, c.population);
      if (c.user) insertTrader(c.uid, c.user);
      if (c.kv_init !== null) store.kvSet(`volume_cfg_${c.uid}`, c.kv_init);
      const res = apply.applyBestToUser(c.uid, c.strategy, c.pass_tf ? c.tf : null, { now: () => NOW, log: memLog() });
      expect(pyEqual(res, c.result), `#${i} ${c.strategy} ${c.kind}: js ${JSON.stringify(res)}\npy ${JSON.stringify(c.result)}`).toBe(true);
      if (c.user_after) {
        const row = db.prepare(`SELECT ${USER_COLS.join(', ')} FROM trader_settings WHERE user_id=?`).get(c.uid);
        expect(pyEqual(row, c.user_after), `#${i} user_after: js ${JSON.stringify(row)}\npy ${JSON.stringify(c.user_after)}`).toBe(true);
      }
      expect(store.kvGet(`volume_cfg_${c.uid}`), `#${i} kv`).toBe(c.kv_after);
      kinds.add(`${c.strategy}:${c.kind}:${res.ok}`);
    }
    expect(kinds.size).toBeGreaterThanOrEqual(12);
  });

  it('a real change writes one audit_log row (mutation_log.emit_mutation "genome_apply")', () => {
    const c = D.apply.find((x) => x.strategy === 'LEVELS' && x.kind === 'ok');
    insertPop(c.strategy, c.tf, c.generation, c.population);
    insertTrader(c.uid, c.user);
    apply.applyBestToUser(c.uid, c.strategy, c.tf, { now: () => NOW, log: memLog() });
    const rows = db.prepare("SELECT user_id, action, metadata FROM audit_log WHERE action='genome_apply'").all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ actor: `user:${c.uid}`, target: `LEVELS/${c.tf}` });
  });
});

describe('_user_tfs_for_strategy', () => {
  it('240 rows', () => {
    for (const c of D.user_tfs) {
      expect([...apply.userTfsForStrategy(c.row, c.strategy)].sort(), JSON.stringify(c)).toEqual(c.out);
    }
  });
});

describe('_auto_apply_best_genome', () => {
  it('gates, kill switch, TF match; optimizer_params rows and volume_cfg kv identical to the bot', () => {
    let wrote = 0;
    for (const [i, c] of D.auto_apply.cases.entries()) {
      reset();
      for (const [uid, u] of D.auto_apply.users) insertTrader(uid, u);
      const log = memLog();
      apply.autoApplyBestGenome(c.strategy, c.tf, c.best, { env: { GENOME_AUTO_APPLY_ENABLED: c.label === 'kill' ? '0' : '1' }, now: () => NOW, log });
      const op = db.prepare('SELECT user_id, strategy, params, updated_at FROM optimizer_params ORDER BY user_id, strategy').all().map((r) => [r.user_id, r.strategy, r.params, r.updated_at]);
      const vk = db.prepare("SELECT key, value FROM engine_kv WHERE key LIKE 'volume_cfg_%' ORDER BY key").all().map((r) => [r.key, r.value]);
      expect(op, `#${i} ${c.strategy}/${c.tf} ${c.label}`).toEqual(c.optimizer_params);
      expect(vk, `#${i} ${c.strategy}/${c.tf} ${c.label}`).toEqual(c.volume_kv);
      if (c.label === 'kill') expect(log.lines.some(([, m]) => m.includes('GENOME_AUTO_APPLY_ENABLED=0 — skip auto-apply'))).toBe(true);
      if (op.length || vk.length) wrote++;
    }
    expect(wrote).toBeGreaterThan(4);
  });
});

describe('check_drift / validate_via_paper', () => {
  it('drift dicts, paper verdicts (OK / FAILED / INSUFFICIENT_DATA / ERROR) and the live-baseline kv', () => {
    const statuses = new Set();
    const drifts = new Set();
    for (const [k, d] of D.drift.entries()) {
      reset();
      insertTrades(d.strategy, d.trades);
      if (d.population.length) insertPop(d.strategy, d.tf, 2, d.population);
      const out = drift.checkDrift(d.strategy, d.tf, { now: NOW, getRegime: () => d.regime });
      expect(pyEqual(out, d.out), `drift #${k}: js ${JSON.stringify(out)}\npy ${JSON.stringify(d.out)}`).toBe(true);
      drifts.add(String(out.drift) + (out.reason || ''));
      for (const p of D.paper.filter((x) => x.trade_set === k)) {
        db.prepare('DELETE FROM engine_kv').run();
        const last = new Map(Object.entries(p.prev_regime));
        const pv = paper.validateViaPaper(p.genome, p.strategy, p.tf, { now: NOW, getRegime: () => p.regime, lastRegime: last, log: memLog() });
        expect(pyEqual(pv, p.out), `paper #${k} ${JSON.stringify(p.genome)}: js ${JSON.stringify(pv)}\npy ${JSON.stringify(p.out)}`).toBe(true);
        const kvs = db.prepare('SELECT key, value FROM engine_kv').all().map((r) => [r.key, r.value]);
        expect(kvs, `paper kv #${k}`).toEqual(p.kv);
        statuses.add(pv.status);
      }
    }
    expect([...statuses].sort()).toEqual(['ERROR', 'FAILED', 'INSUFFICIENT_DATA', 'OK']);
    expect(drifts.has('true')).toBe(true);
  });

  it('drift: unknown / no population → {drift: false}', () => {
    expect(drift.checkDrift('LEVELS', '1h', { now: NOW })).toEqual({ drift: false });
  });
});

describe('texts', () => {
  it('format_genome_dashboard — 7 scenarios, byte-identical HTML', () => {
    for (const c of D.dashboard) {
      reset();
      if (c.population.length) insertPop(c.S, c.T, 4, c.population);
      if (c.history.length) insertHist(c.S, c.T, c.history);
      const text = texts.formatGenomeDashboard(c.strategy, c.tf);
      expect(text, `${c.strategy}/${c.tf}`).toBe(c.text);
    }
  });

  it('format_genome_help — verbatim', () => {
    expect(texts.formatGenomeHelp()).toBe(D.help);
  });
});

describe('maintenance', () => {
  it('gc_coin_champions — expired / corrupted deleted, LRU cap 200, remaining keys identical', () => {
    for (const [k, v] of D.gc.keys) store.kvSet(k, v);
    const out = maint.gcCoinChampions({ now: NOW, log: memLog() });
    expect(out).toEqual(D.gc.out);
    expect(store.kvKeysWithPrefix('genome_coin_champ_')).toEqual(D.gc.remaining_keys);
  });

  it('gc LRU: more than 200 fresh entries → the oldest evicted', () => {
    for (let j = 0; j < 205; j++) store.kvSet(`genome_coin_champ_SMC_1h_X${String(j).padStart(3, '0')}`, JSON.stringify({ ts: NOW - 1000 + j }));
    const out = maint.gcCoinChampions({ now: NOW, log: memLog() });
    expect(out).toEqual({ expired: 0, lru_evicted: 5, remaining: 200 });
    expect(store.kvGet('genome_coin_champ_SMC_1h_X000')).toBeNull();
    expect(store.kvGet('genome_coin_champ_SMC_1h_X005')).not.toBeNull();
  });

  it('maintenance tick: GC every 24 h, permissive baseline refresh of every (S, tf) every 6 h', async () => {
    let t = NOW;
    const state = { lastGcTs: 0, lastBaselineTs: 0 };
    const deps = { now: () => t, log: memLog(), sleep: async () => {} };
    let done = await maintenanceTickOnce(state, deps);
    expect(done.gc).not.toBeNull();
    expect(done.baseline).toHaveLength(9);
    t += 3600;
    done = await maintenanceTickOnce(state, deps);
    expect(done.gc).toBeNull();
    expect(done.baseline).toBeNull();
    t += 6 * 3600;
    done = await maintenanceTickOnce(state, deps);
    expect(done.gc).toBeNull();
    expect(done.baseline).toHaveLength(9);
  });
});

function maintenanceTickOnce(state, deps) {
  return maint.maintenanceTick(state, deps);
}

describe('store', () => {
  it('savePopulationBatch ids in order, getCurrentPopulation by fitness desc, history ascending, last generation', () => {
    const ids = store.savePopulationBatch('SMC', '1h', 1, [
      { genome: { min_rr: 2 }, metrics: { fitness: 0.5, winrate: 50, profit_factor: 1.2, trades: 9, drawdown: 1 }, birth_type: 'random', parent_a: 0, parent_b: 0 },
      { genome: { min_rr: 1.5 }, metrics: { fitness: 1.5 }, birth_type: 'elite', parent_a: 7, parent_b: 0 },
    ], { now: () => NOW });
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0] + 1);
    const pop = store.getCurrentPopulation('SMC', '1h', 1);
    expect(pop.map((p) => p.id)).toEqual([ids[1], ids[0]]);
    expect(pop[0]).toMatchObject({ genome: { min_rr: 1.5 }, fitness: 1.5, winrate: 0, birth_type: 'elite', parent_a: 7, created_at: NOW });
    expect(db.prepare('SELECT genome_json FROM genome_population WHERE id=?').get(ids[0]).genome_json).toBe('{"min_rr": 2.0}');
    expect(store.getLastGeneration('SMC', '1h')).toBe(1);
    expect(store.getLastGeneration('SMC', '4h')).toBe(0);
    store.saveGenerationHistory('SMC', '1h', 1, [{ genome: { a: 1 }, fitness: 0.5, winrate: 40, profit_factor: 1 }, { genome: { b: 2 }, fitness: 1.5, winrate: 60, profit_factor: 2 }], { now: () => NOW });
    store.saveGenerationHistory('SMC', '1h', 2, [{ genome: { c: 3 }, fitness: 0.25 }], { now: () => NOW + 1 });
    const h = store.getHistory('SMC', '1h', 20);
    expect(h.map((x) => x.generation)).toEqual([1, 2]);
    expect(h[0]).toMatchObject({ best_fitness: 1.5, avg_fitness: 1.0, best_wr: 60, best_pf: 2, best_genome: { b: 2 }, pop_size: 2 });
    expect(store.getHistory('SMC', '1h', 1).map((x) => x.generation)).toEqual([2]);
    store._clearMutationInfoCache();
    expect(store.getLastMutationInfo('smc', 'weird', { now: NOW + 7201 })).toMatchObject({ generation: 2, improvement_pct: -60, best_fitness: 0.25 });
    expect(store.getLastMutationInfo('', '1h')).toBeNull();
  });

  it('optimizer_params: INSERT OR REPLACE with json.dumps formatting, load back', () => {
    siteUser(5);
    store.saveOptimizerParams(5, 'LEVELS', { min_rr: 2, min_quality: 3, tp1_rr: 2.5 }, { now: () => NOW });
    expect(db.prepare('SELECT params, updated_at FROM optimizer_params WHERE user_id=5').get())
      .toEqual({ params: '{"min_rr": 2.0, "min_quality": 3, "tp1_rr": 2.5}', updated_at: NOW });
    store._clearParamsCache();
    expect(store.loadOptimizerParams(5, 'LEVELS')).toEqual({ min_rr: 2, min_quality: 3, tp1_rr: 2.5 });
    expect(store.loadOptimizerParams(5, 'SMC')).toBeNull();
  });
});
