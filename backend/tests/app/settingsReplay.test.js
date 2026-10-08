/**
 * POST /api/app/settings/all — replay of adversarial payloads against vectors
 * produced by the bot's own miniapp_api.h_settings_all_post (fixture
 * settings_all_replay.json: 125 cases — out-of-range / wrong types / plan
 * gates / quiet-hours edge cases / VOLUME with every setup off / auto_trade
 * without keys / circuit-breaker coupling / schema order of the first
 * rejected key). For every case the status, the envelope (ok / error /
 * message), the resulting trader_settings state, the VOLUME kv config and the
 * Mini App subset of the returned `settings` must equal the bot's.
 *
 * Regenerate: gen/gen_settings_all_replay.py (inputs gen/settings_all_cases.json; CPython 3.11 venv, see its docstring).
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
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-app-settings-replay.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const CASES = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'app', 'fixtures', 'settings_all_replay.json'), 'utf8'));
const KEY_ATTRS = new Set(['bybit_api_key', 'bybit_api_secret', 'bingx_api_key', 'bingx_api_secret',
  'binance_api_key', 'binance_api_secret', 'okx_api_key', 'okx_api_secret', 'okx_passphrase']);

function freshDb() {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
}

let db, app, ts, authService, appRouter, plan, exchangeService, kv, volumeUserCfg, volumeCfg;

beforeAll(async () => {
  freshDb();
  db = (await import('../../models/database.js')).default;
  app = (await import('../../server.js')).default;
  ts = (await import('../../services/traderSettingsService.js')).default;
  plan = (await import('../../services/planService.js')).default;
  authService = (await import('../../services/authService.js')).default;
  appRouter = nodeRequire('../../routes/app.js');
  exchangeService = (await import('../../services/exchangeService.js')).default;
  kv = (await import('../../services/engineKvService.js')).default;
  volumeUserCfg = (await import('../../services/volumeUserCfg.js')).default;
  volumeCfg = (await import('../../services/engine/volumeCfgShim.js')).default;
});

beforeEach(() => {
  db.prepare('DELETE FROM notifications').run();
  db.prepare('DELETE FROM plan_changes').run();
  db.prepare('DELETE FROM engine_kv').run();
  db.prepare('DELETE FROM exchange_keys').run();
  db.prepare('DELETE FROM trader_settings').run();
  db.prepare('DELETE FROM subscriptions').run();
  db.prepare('DELETE FROM users').run();
  ts.invalidateCache();
  appRouter.resetRateLimits();
});

const H = (uid) => ({ Authorization: 'Bearer ' + authService._signAccessToken(uid) });

/** The bot harness's fake user: free = active for a year, pro = active 30 d, admin = ADMIN_IDS. */
async function setupUser(spec = {}) {
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
  const attrs = spec.attrs || {};
  const keys = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (KEY_ATTRS.has(k)) {
      const [ex, field] = [k.split('_')[0], k.slice(k.indexOf('_') + 1)];
      keys[ex] = keys[ex] || {};
      keys[ex][field] = v;
    } else {
      u[k] = v;
    }
  }
  ts.save(u);
  for (const [ex, k] of Object.entries(keys)) {
    if (k.api_key && k.api_secret) {
      await exchangeService.addKey(uid, { exchange: ex, apiKey: k.api_key, apiSecret: k.api_secret, passphrase: k.passphrase });
    }
  }
  if (spec.volume_cfg) volumeUserCfg.saveUserCfg(uid, spec.volume_cfg);
  return uid;
}

function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
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

// Documented deviations from the Mini App (decision D9): the web takes the superset of
// what the bot's Telegram menus accepted, so these bot vectors are asserted inverted.
const DEVIATIONS = {
  'max_trades_limit 0 pro': 'trading.max_trades_limit: Mini App 1..50, Telegram «✏️ Своё значение» 0..9999 → web 0..9999',
};

describe('POST settings/all — bot vectors', () => {
  for (const c of CASES) {
    if (DEVIATIONS[c.name]) {
      it(`${c.name} — D9 deviation: ${DEVIATIONS[c.name]}`, async () => {
        const uid = await setupUser(c.user);
        expect(c.expected.ok).toBe(false);                          // the Mini App rejected it …
        const r = await request(app).post('/api/app/settings/all').set(H(uid)).send(c.body);
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);                              // … the web accepts it
        expect(ts.get(uid).max_trades_limit).toBe(0);
      });
      continue;
    }
    it(c.name, async () => {
      const uid = await setupUser(c.user);
      const exp = c.expected;
      const r = await request(app).post('/api/app/settings/all').set(H(uid)).send(c.body);
      expect(r.status).toBe(exp.status);
      expect(r.body.ok).toBe(exp.ok);
      expect(r.body.error).toBe(exp.error === null ? undefined : exp.error);
      expect(r.body.message).toBe(exp.message === null ? undefined : exp.message);
      // resulting user state (the bot compares its in-memory user; here the saved row)
      const u = ts.get(uid);
      const actual = {};
      const expected = {};
      for (const [k, v] of Object.entries(exp.state)) {
        if (k === 'sub_status' || k === 'sub_plan') continue;              // mirror handled by planService on the site
        actual[k] = k === 'smc_cfg' ? JSON.parse(u[k]) : u[k];
        expected[k] = k === 'smc_cfg' ? JSON.parse(v) : v;
      }
      expect(diffKeys(actual, expected)).toEqual([]);
      // VOLUME kv config
      const vcfg = volumeCfg.impl().toDict(volumeUserCfg.loadUserCfg(uid));
      expect(diffKeys(vcfg, exp.volume_cfg)).toEqual([]);
      const kvWritten = Boolean(kv.get(`volume_cfg_${uid}`));
      expect(kvWritten).toBe(Boolean(exp.volume_saved || (c.user && c.user.volume_cfg)));
      if (exp.ok) {
        const s = r.body.settings;
        const sub = {
          lang: s.lang, ui_mode: s.ui_mode, genome_auto_apply: s.genome_auto_apply,
          levels: Object.fromEntries(Object.keys(exp.settings_miniapp.levels).map((k) => [k, s.levels[k]])),
          smc: Object.fromEntries(Object.keys(exp.settings_miniapp.smc).map((k) => [k, s.smc[k]])),
          volume: Object.fromEntries(Object.keys(exp.settings_miniapp.volume).map((k) => [k, s.volume[k]])),
          trading: Object.fromEntries(Object.keys(exp.settings_miniapp.trading).map((k) => [k, s.trading[k]])),
          risk: Object.fromEntries(Object.keys(exp.settings_miniapp.risk).map((k) => [k, s.risk[k]])),
          notifications: Object.fromEntries(Object.keys(exp.settings_miniapp.notifications).map((k) => [k, s.notifications[k]])),
        };
        expect(diffKeys(sub, exp.settings_miniapp)).toEqual([]);
      }
    });
  }
});
