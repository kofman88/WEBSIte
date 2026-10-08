/**
 * POST /api/app/settings (prefs), /strategy, /profile, /lang — replay of
 * payloads against vectors produced by the bot's own handlers (miniapp_api
 * h_settings / h_strategy / h_profile / h_lang; fixture routes_replay.json):
 * Python truthiness of the toggle values, the genome gate, quiet-hours
 * normalisation, bad_strategy (400) / free mutex / locked strategies /
 * _apply_multi effects, profile apply + skipped lists per plan, lang parsing.
 *
 * Regenerate: gen/gen_routes_replay.py (inputs gen/route_cases.json; CPython 3.11 venv, see its docstring).
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
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-app-routes-replay.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const CASES = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'app', 'fixtures', 'routes_replay.json'), 'utf8'));

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, app, ts, authService, appRouter, plan, volumeUserCfg, volumeCfg;

beforeAll(async () => {
  freshDb();
  db = (await import('../../models/database.js')).default;
  app = (await import('../../server.js')).default;
  ts = (await import('../../services/traderSettingsService.js')).default;
  plan = (await import('../../services/planService.js')).default;
  authService = (await import('../../services/authService.js')).default;
  appRouter = nodeRequire('../../routes/app.js');
  volumeUserCfg = (await import('../../services/volumeUserCfg.js')).default;
  volumeCfg = (await import('../../services/engine/volumeCfgShim.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM plan_changes').run();
  db.prepare('DELETE FROM engine_kv').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
  appRouter.resetRateLimits();
});

const H = (uid) => ({ Authorization: 'Bearer ' + authService._signAccessToken(uid) });

function setupUser(spec = {}) {
  const e = `u-${Math.random().toString(36).slice(2, 8)}@x.com`;
  const ref = 'R' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const uid = db.prepare('INSERT INTO users (email, password_hash, referral_code, is_admin) VALUES (?, ?, ?, ?)')
    .run(e, 'x', ref, spec.admin ? 1 : 0).lastInsertRowid;
  const now = Date.now() / 1000;
  if (spec.plan === 'pro') plan.grantAccess(uid, 30, { actor: 'test' });
  const u = ts.getOrCreate(uid);
  if (spec.plan !== 'pro') {
    u.sub_plan = 'free'; u.sub_status = 'active'; u.sub_expires = now + 365 * 86400;
  }
  for (const [k, v] of Object.entries(spec.attrs || {})) u[k] = v;
  ts.save(u);
  return uid;
}

function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
    if (JSON.stringify(ka) !== JSON.stringify(kb)) return false;
    return ka.every((k) => same(a[k], b[k]));
  }
  return a === b;
}

function diffKeys(actual, expected) {
  return Object.keys(expected).filter((k) => !same(actual[k], expected[k]))
    .map((k) => `${k}: js=${JSON.stringify(actual[k])} bot=${JSON.stringify(expected[k])}`);
}

describe('prefs / strategy / profile / lang — bot vectors', () => {
  for (const c of CASES) {
    it(`${c.route}: ${c.name}`, async () => {
      const uid = setupUser(c.user);
      const before = ts.get(uid);
      const exp = c.expected;
      const r = await request(app).post(`/api/app/${c.route}`).set(H(uid)).send(c.body);
      expect(r.status).toBe(exp.status);
      expect(r.body.ok).toBe(exp.ok);
      expect(r.body.error).toBe(exp.error === null ? undefined : exp.error);
      expect(r.body.message).toBe(exp.message === null ? undefined : exp.message);
      const u = ts.get(uid);
      const actual = {};
      for (const k of Object.keys(exp.state)) actual[k] = u[k];
      if (exp.saved) {
        expect(diffKeys(actual, exp.state)).toEqual([]);
      } else {
        // the bot mutated only its in-memory user (e.g. check_access downgrade inside
        // _strategy_locked, a toggle set before the genome gate) and never saved it
        const initial = {};
        for (const k of Object.keys(exp.state)) initial[k] = before[k];
        expect(diffKeys(actual, initial)).toEqual([]);
      }
      const payload = {};
      const expectedPayload = {};
      for (const k of ['prefs', 'strategy', 'strategies', 'profile', 'applied', 'skipped', 'lang']) {
        if (Object.prototype.hasOwnProperty.call(exp, k)) { payload[k] = r.body[k]; expectedPayload[k] = exp[k]; }
      }
      expect(diffKeys(payload, expectedPayload)).toEqual([]);
      if (c.route === 'profile') {
        const vcfg = volumeCfg.impl().toDict(volumeUserCfg.loadUserCfg(uid));
        expect(diffKeys(vcfg, exp.volume_cfg)).toEqual([]);
      }
    });
  }
});
