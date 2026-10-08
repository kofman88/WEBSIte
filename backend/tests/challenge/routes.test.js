/**
 * /api/app/challenge* (routes/appChallenge.js mounted from routes/app.js) with supertest,
 * replaying the bot's own Mini App handlers (miniapp_api.h_challenge_get / post / topup /
 * finish driven by gen_challenge_vectors.py §9 with the same users, rows and clock):
 *   free → pro_required, bad answers → bad_request {field: str(e)}, preview → plan only,
 *   start → state + applied/skipped, already_active, topup validation, replace, finish,
 *   404 not_found, admin bypass, the GET bucket (10 / 60 s → 429 + Retry-After).
 * Per step: HTTP status, the JSON body, the kv JSON (byte-identical) and the user's settings.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { FIXTURE as V, setupEnv, insertUser, insertTrade, quietLog, pickFields, norm } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('routes');

let db; let app; let ts; let C; let appRouter; let authService;
const R = V.routes;
const H = (uid) => ({ Authorization: `Bearer ${authService._signAccessToken(uid)}` });
const URL = {
  'GET challenge': ['get', '/api/app/challenge'],
  'POST challenge': ['post', '/api/app/challenge'],
  'POST challenge/topup': ['post', '/api/app/challenge/topup'],
  'POST challenge/finish': ['post', '/api/app/challenge/finish'],
};

beforeAll(async () => {
  db = nodeRequire('../../models/database.js');
  app = (await import('../../server.js')).default;
  ts = nodeRequire('../../services/traderSettingsService.js');
  C = nodeRequire('../../services/challengeService.js');
  appRouter = nodeRequire('../../routes/app.js');
  authService = nodeRequire('../../services/authService.js');
  for (const uid of Object.keys(R.plans).map(Number)) {
    insertUser(db, uid, { isAdmin: uid === 123 ? 1 : 0 });
    const u = ts.getOrCreate(uid);
    Object.assign(u, { sub_plan: R.plans[uid], sub_status: 'active', sub_expires: V.t0 + 30 * 86400 });
    ts.save(u);
  }
  for (const r of V.db_rows) if (r.user_id === 301) insertTrade(db, r);
  appRouter.resetRateLimits();
  C.resetDeps();
});

describe('Mini App challenge routes (bot replay)', () => {
  it('initial users match the bot UserSettings defaults', () => {
    for (const [uid, fields] of Object.entries(R.init)) expect([uid, pickFields(ts.get(Number(uid)))]).toEqual([uid, fields]);
  });

  it(`reproduces ${R.steps.length} requests`, async () => {
    let clock = V.t0;
    appRouter.setClock(() => clock);
    C.configure({ clock: () => clock, log: quietLog });
    const bad = [];
    for (const [i, s] of R.steps.entries()) {
      clock = s.now;
      const [method, url] = URL[s.route];
      let req = request(app)[method](url).set(H(s.uid));
      if (method === 'post' && s.body !== null) req = req.send(s.body);
      const res = await req;
      const kv = db.prepare('SELECT value FROM engine_kv WHERE key = ?').get(`challenge_${s.uid}`);
      const got = { status: res.status, json: norm(res.body), kv: kv ? kv.value : null, user: pickFields(ts.get(s.uid)) };
      const want = { status: s.status, json: norm(s.json), kv: s.kv, user: s.user };
      if (JSON.stringify(sortKeys(got)) !== JSON.stringify(sortKeys(want))) bad.push({ i, route: s.route, body: s.body, want, got });
      if (s.status === 429) expect(res.headers['retry-after']).toBe('10');
      expect(res.headers['cache-control']).toBe('no-store');
    }
    appRouter.setClock(null);
    expect(bad).toEqual([]);
  });

  it('every challenge POST counts in the generic bucket (MINIAPP_POST_PER_MIN 30 / 60 s), even a 404', async () => {
    // miniapp_api._load_user: POST and not _rate_ok(uid, "post", 30, 60.0) → 429 before the handler runs
    appRouter.resetRateLimits();
    const clock = V.t0 + 10 * 86400;
    appRouter.setClock(() => clock);
    for (let i = 0; i < 30; i += 1) {
      const r = await request(app).post('/api/app/challenge/finish').set(H(303));
      expect([i, r.status, r.body.error]).toEqual([i, 404, 'not_found']);
    }
    const r = await request(app).post('/api/app/challenge/topup').set(H(303)).send({ amount: 5 });
    expect([r.status, r.body.error, r.headers['retry-after']]).toEqual([429, 'rate_limited', '10']);
    appRouter.setClock(null);
    appRouter.resetRateLimits();
  });

  it('unauthenticated → 401 envelope of routes/app.js', async () => {
    const r = await request(app).get('/api/app/challenge');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: 'unauthorized' });
  });
});

describe('entry advisor buttons', () => {
  it('POST entry-advice/on turns market entry on; keep only answers', async () => {
    const before = ts.get(302);
    expect(before.prefer_market_entry).toBe(false);
    let r = await request(app).post('/api/app/entry-advice/keep').set(H(302));
    expect(r.body).toEqual({ ok: true, show_alert: false, remove_keyboard: true, message: 'Оставляем лимитный вход' });
    expect(ts.get(302).prefer_market_entry).toBe(false);
    r = await request(app).post('/api/app/entry-advice/on').set(H(302));
    expect(r.body).toMatchObject({ ok: true, prefer_market_entry: true, message: '🎯 Вход по рынку включён' });
    expect(ts.get(302).prefer_market_entry).toBe(true);
  });
});

function sortKeys(x) {
  if (Array.isArray(x)) return x.map(sortKeys);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])]));
  return x;
}
