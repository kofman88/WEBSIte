/**
 * GET /api/app/genome, POST /api/app/genome/apply (miniapp_api.h_genome / h_genome_apply) and
 * POST /api/app/genome/evolve (D10: the bot's adv_g_ev_ → trigger_evolution_now) on the site JWT.
 *   h_genome:       {"ok": true, "available": can("genome"), "auto_apply", "strategies": {S: {timeframe,
 *                    generation, fitness: round(best_fitness, 3), win_rate: round(best_wr, 1),
 *                    profit_factor: round(best_pf, 2), updated_at: int(created_at), applied}}}
 *   h_genome_apply: pro_required / bad_strategy (400) / genome_not_ready + message / {"ok": true}
 *                   + kv miniapp_genome_applied_<uid>_<S> = str(last generation)
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-genome-routes.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';
['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* */ } });

let db; let app; let ts; let authService; let appRouter; let plan; let kv; let runner; let gs;

beforeAll(async () => {
  db = (await import('../../models/database.js')).default;
  app = (await import('../../server.js')).default;
  ts = nodeRequire('../../services/traderSettingsService.js');
  plan = nodeRequire('../../services/planService.js');
  authService = nodeRequire('../../services/authService.js');
  appRouter = nodeRequire('../../routes/app.js');
  kv = nodeRequire('../../services/engineKvService.js');
  runner = nodeRequire('../../services/genome/runner.js');
  gs = nodeRequire('../../services/genome/geneSpace.js');
});

beforeEach(() => {
  for (const t of ['notifications', 'plan_changes', 'engine_kv', 'trader_settings', 'subscriptions', 'genome_population', 'genome_history', 'audit_log']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
  appRouter.resetRateLimits();
  appRouter.setClock(null);
  runner.setRunner(null);
  runner.LOCK.held = false;
});

function makeUser({ isAdmin = 0 } = {}) {
  const e = `g-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  return db.prepare('INSERT INTO users (email, password_hash, referral_code, is_admin, locale, is_active) VALUES (?, ?, ?, ?, ?, 1)')
    .run(e, 'x', ref, isAdmin, 'ru').lastInsertRowid;
}
const H = (uid) => ({ Authorization: 'Bearer ' + authService._signAccessToken(uid) });
const pro = (uid, days = 30) => plan.grantAccess(uid, days, { actor: 'test' });

function seedLevels(gen = 3, { fitness = 1.23456, trades = 12 } = {}) {
  const st = db.prepare('INSERT INTO genome_population (strategy, timeframe, generation, genome_json, fitness, winrate, profit_factor, trades, drawdown, parent_a, parent_b, birth_type, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  st.run('LEVELS', '1h', gen, gs.serializeGenome({ min_rr: 2.4, min_quality: 3, use_rsi: true, pivot_strength: 5 }), fitness, 55.55, 1.555, trades, 2.0, 0, 0, 'elite', 1_700_000_000);
  st.run('LEVELS', '1h', gen, gs.serializeGenome({ min_rr: 1.5 }), 0.1, 40, 1.0, 9, 2.0, 0, 0, 'random', 1_700_000_000);
  db.prepare('INSERT INTO genome_history (strategy, timeframe, generation, best_fitness, avg_fitness, best_wr, best_pf, best_genome_json, pop_size, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('LEVELS', '1h', gen, fitness, 0.5, 55.55, 1.555, '{}', 10, 1_700_000_000.7);
}

describe('GET /api/app/genome', () => {
  it('401 without a token', async () => {
    const r = await request(app).get('/api/app/genome');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('free user: available false, every strategy with nulls before any evolution', async () => {
    const uid = makeUser();
    const r = await request(app).get('/api/app/genome').set(H(uid));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true, available: false, auto_apply: false,
      strategies: Object.fromEntries(['LEVELS', 'SMC', 'VOLUME'].map((s) => [s, {
        timeframe: '1h', generation: null, fitness: null, win_rate: null, profit_factor: null, updated_at: null, applied: false,
      }])),
    });
  });

  it('pro user: the last history row of the default TF, rounded like the bot; applied after POST apply', async () => {
    const uid = makeUser();
    pro(uid);
    seedLevels(3);
    let r = await request(app).get('/api/app/genome').set(H(uid));
    expect(r.body.available).toBe(true);
    expect(r.body.strategies.LEVELS).toEqual({ timeframe: '1h', generation: 3, fitness: 1.235, win_rate: 55.5, profit_factor: 1.55, updated_at: 1700000000, applied: false });
    expect(r.body.strategies.SMC.generation).toBeNull();
    r = await request(app).post('/api/app/genome/apply').set(H(uid)).send({ strategy: 'levels' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(kv.get(`miniapp_genome_applied_${uid}_LEVELS`)).toBe('3');
    const row = ts.getRow(uid);
    expect(row).toMatchObject({ min_rr: 2.4, min_quality: 3, use_rsi: 1, pivot_strength: 5 });
    r = await request(app).get('/api/app/genome').set(H(uid));
    expect(r.body.strategies.LEVELS.applied).toBe(true);
    seedLevels(4);
    r = await request(app).get('/api/app/genome').set(H(uid));
    expect(r.body.strategies.LEVELS).toMatchObject({ generation: 4, applied: false });
  });

  it('admin bypass: available true without a plan; auto_apply mirrors trader_settings', async () => {
    const uid = makeUser({ isAdmin: 1 });
    ts.getOrCreate(uid);
    db.prepare('UPDATE trader_settings SET genome_auto_apply=1 WHERE user_id=?').run(uid);
    ts.invalidateCache();
    const r = await request(app).get('/api/app/genome').set(H(uid));
    expect(r.body).toMatchObject({ ok: true, available: true, auto_apply: true });
  });
});

describe('POST /api/app/genome/apply', () => {
  it('free → pro_required (HTTP 200)', async () => {
    const uid = makeUser();
    const r = await request(app).post('/api/app/genome/apply').set(H(uid)).send({ strategy: 'LEVELS' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: false, error: 'pro_required' });
  });

  it('unknown / non-string strategy → 400 bad_strategy', async () => {
    const uid = makeUser();
    pro(uid);
    for (const body of [{ strategy: 'GERCHIK' }, { strategy: 5 }, {}, { strategy: null }]) {
      const r = await request(app).post('/api/app/genome/apply').set(H(uid)).send(body);
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ ok: false, error: 'bad_strategy' });
    }
  });

  it('no evolution / fitness 0 → genome_not_ready with the bot message', async () => {
    const uid = makeUser();
    pro(uid);
    let r = await request(app).post('/api/app/genome/apply').set(H(uid)).send({ strategy: 'SMC' });
    expect(r.body).toEqual({ ok: false, error: 'genome_not_ready', message: 'Нет эволюции для SMC/1h' });
    seedLevels(1, { fitness: 0 });
    db.prepare('UPDATE genome_population SET fitness=0').run();
    r = await request(app).post('/api/app/genome/apply').set(H(uid)).send({ strategy: 'LEVELS' });
    expect(r.body).toEqual({ ok: false, error: 'genome_not_ready', message: 'Лучший геном имеет fitness=0 — не применяем' });
    expect(kv.get(`miniapp_genome_applied_${uid}_LEVELS`)).toBeNull();
  });

  it('POST rate limit (bucket "post", 30 / 60 s) → 429 rate_limited', async () => {
    const uid = makeUser();
    let last;
    for (let k = 0; k < 31; k++) last = await request(app).post('/api/app/genome/apply').set(H(uid)).send({ strategy: 'LEVELS' });
    expect(last.status).toBe(429);
    expect(last.body).toMatchObject({ ok: false, error: 'rate_limited' });
    expect(last.headers['retry-after']).toBe('10');
  });
});

describe('POST /api/app/genome/evolve (D10)', () => {
  it('free → pro_required; bad strategy → 400', async () => {
    const uid = makeUser();
    let r = await request(app).post('/api/app/genome/evolve').set(H(uid)).send({ strategy: 'SMC' });
    expect(r.body).toEqual({ ok: false, error: 'pro_required' });
    pro(uid);
    r = await request(app).post('/api/app/genome/evolve').set(H(uid)).send({ strategy: 'X' });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'bad_strategy' });
  });

  it('wait: true → the run result + the bot status text; unknown TF → default TF', async () => {
    const uid = makeUser();
    pro(uid);
    const calls = [];
    runner.setRunner(async (o) => { calls.push([o.strategy, o.tf, o.mode]); return { ok: true, strategy: o.strategy, tf: o.tf, generation: 7, pop_size: 10, best_fitness: 1.23456, best_wr: 55.55, best_pf: 1.6, elapsed: 93.6 }; });
    const r = await request(app).post('/api/app/genome/evolve').set(H(uid)).send({ strategy: 'smc', tf: '2h', wait: true });
    expect(calls).toEqual([['SMC', '1h', 'manual']]);
    expect(r.body).toMatchObject({ ok: true, generation: 7 });
    expect(r.body.text).toBe('✅ Эволюция SMC/1h завершена!\nПоколение #7, best fitness 1.235, WR 55.5%, PF 1.60\nВремя: 94с');
  });

  it('a run in progress → "Эволюция уже идёт, подожди 1-3 мин" (the bot lock throttle)', async () => {
    const uid = makeUser();
    pro(uid);
    let release;
    runner.setRunner(() => new Promise((res) => { release = res; }));
    const r1 = await request(app).post('/api/app/genome/evolve').set(H(uid)).send({ strategy: 'VOLUME', tf: '4h' });
    expect(r1.body).toEqual({ ok: true, started: true, strategy: 'VOLUME', timeframe: '4h', message: '🚀 Запускаю эволюцию... (1-3 мин)' });
    const r2 = await request(app).post('/api/app/genome/evolve').set(H(uid)).send({ strategy: 'LEVELS' });
    expect(r2.body).toEqual({ ok: false, error: 'Эволюция уже идёт, подожди 1-3 мин' });
    release({ ok: false, error: 'Таймаут 10 мин — OKX недоступен или данных нет' });
    await new Promise((r) => setTimeout(r, 50));
    const n = db.prepare("SELECT title FROM notifications WHERE user_id=? AND type='genome'").all(uid);
    expect(n.map((x) => x.title)).toEqual(['⚠️ Эволюция не удалась: Таймаут 10 мин — OKX недоступен или данных нет']);
    expect(runner.isRunning()).toBe(false);
  });
});
