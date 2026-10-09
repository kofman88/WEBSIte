/**
 * GET /api/app/trend and POST /api/app/trend/notify (routes/appTrend.js) — the bot's /trend
 * command, /trend_on and the «🔕 Не присылать смену тренда» callback (handlers/trend.py) as app
 * routes (D10). Texts and get_all() are pinned to fixtures/trend_cmd.json, produced by
 * py/drive_trend_cmd.py with CPython 3.11 driving the bot's own handlers.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { setupEnv, insertUser, rawRequest } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('trend');

const FX = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'app', 'data', 'fixtures', 'trend_cmd.json'), 'utf8'));
const RU = 741;
const EN = 742;
let tm; let appTrend; let bridge; let kv; let server; let port; const tokens = {};

beforeAll(async () => {
  const db = nodeRequire('../../../models/database.js');
  const app = (await import('../../../server.js')).default;
  const authService = nodeRequire('../../../services/authService.js');
  const ts = nodeRequire('../../../services/traderSettingsService.js');
  tm = nodeRequire('../../../services/engine/trendMonitor.js');
  appTrend = nodeRequire('../../../routes/appTrend.js');
  bridge = nodeRequire('../../../services/engine/engineBridge.js');
  kv = nodeRequire('../../../services/engineKvService.js');
  for (const [uid, lang] of [[RU, 'ru'], [EN, 'en']]) {
    insertUser(db, uid, { locale: lang });
    const u = ts.getOrCreate(uid);
    u.lang = lang;
    ts.save(u);
    tokens[uid] = authService._signAccessToken(uid);
  }
  appTrend.configure({ log: { debug() {}, info() {}, warn() {}, error() {} } });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  bridge.setRemote(null);
  appTrend.configure({ log: null, all: null });
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => { nodeRequire('../../../routes/app.js').resetRateLimits(); });

const call = async (uid, method, target, body = null) => {
  const r = await rawRequest(port, { method, target: `/api/app${target}`, headers: { Authorization: `Bearer ${tokens[uid]}`, 'Content-Type': 'application/json' }, body });
  return { status: r.status, d: JSON.parse(r.text) };
};

/** the JS monitor seeded like the Python module state */
function jsAll(state, strength) {
  const m = tm.createTrendMonitor({ kv: { get: () => null, set() {}, del() {}, has: () => false }, env: {}, log: { debug() {}, info() {}, warning() {} } });
  m._seed(state, strength);
  return m.getAll();
}

describe(`/trend text vs the bot (${FX.trend.length} monitor states, CPython ${FX.meta.python})`, () => {
  it('get_all() and the cmd_trend reply are identical', () => {
    expect(FX.meta.tfs).toEqual(tm.TFS);
    for (const c of FX.trend) {
      const all = jsAll(c.state, c.strength);
      expect([c.name, all]).toEqual([c.name, c.get_all]);
      const { text, parse_mode: pm } = appTrend.trendText(all);
      expect([c.name, { text, parse_mode: pm }]).toEqual([c.name, c.sent[0]]);
    }
  });
});

describe('GET /api/app/trend', () => {
  it('reads the running worker\'s monitor through the bridge', async () => {
    const c = FX.trend.find((x) => x.name === 'all, strengths');
    const calls = [];
    bridge.setRemote(async (method) => { calls.push(method); return jsAll(c.state, c.strength); });
    try {
      const { status, d } = await call(RU, 'GET', '/trend');
      expect(status).toBe(200);
      expect(Object.keys(d)).toEqual(['ok', 'trend', 'text', 'parse_mode', 'notify']);
      expect(d).toMatchObject({ ok: true, text: c.sent[0].text, parse_mode: 'HTML', notify: true });
      expect(d.trend).toEqual(c.get_all);
      expect(calls).toEqual(['marketTrend']);
    } finally {
      bridge.setRemote(null);
    }
  });

  it('without a worker: the persisted trend_state_v1 (load_state, no strength); nothing persisted → the wait text', async () => {
    kv.del(tm.KV_KEY);
    const empty = await call(RU, 'GET', '/trend');
    expect(empty.d).toMatchObject({ ok: true, trend: {}, text: 'Тренд ещё считается — подождите пару минут.', parse_mode: null });
    const c = FX.trend.find((x) => x.name === '15m long only');
    kv.set(tm.KV_KEY, JSON.stringify(c.state));
    try {
      const { d } = await call(RU, 'GET', '/trend');
      expect(d.text).toBe(c.sent[0].text);
      expect(d.trend).toEqual(c.get_all);
    } finally {
      kv.del(tm.KV_KEY);
    }
  });
});

describe('POST /api/app/trend/notify', () => {
  const offOk = (lang) => FX.off.find((o) => o.lang === lang && o.setter === 'ok' && !o.um_fail).alerts[0].text;
  const offFail = (lang) => FX.off.find((o) => o.lang === lang && o.setter === 'fail' && !o.um_fail).alerts[0].text;

  it('off / on: the kv opt-out the broadcast reads, the bot\'s texts by lang, GET trend notify flag', async () => {
    const key = `${tm.KV_OFF_PREFIX}${RU}`;
    kv.del(key);
    const off = await call(RU, 'POST', '/trend/notify', '{"on": false}');
    expect(off.d).toEqual({ ok: true, notify: false, message: offOk('ru') });
    expect(kv.get(key)).toBe('1');
    expect(tm.isOptedOut(RU)).toBe(true);
    expect((await call(RU, 'GET', '/trend')).d.notify).toBe(false);
    const on = await call(RU, 'POST', '/trend/notify', '{"on": true}');
    expect(on.d).toEqual({ ok: true, notify: true, message: FX.on.find((o) => o.setter === 'ok').sent[0].text });
    expect(kv.has(key)).toBe(false);
    const en = await call(EN, 'POST', '/trend/notify', '{"on": 0}');
    expect(en.d).toEqual({ ok: true, notify: false, message: offOk('en') });
    expect((await call(EN, 'POST', '/trend/notify', '{"on": "yes"}')).d.notify).toBe(true);   // Python truthiness
    expect((await call(RU, 'POST', '/trend/notify', '{}')).d).toEqual({ ok: false, error: 'bad_request', message: 'on' });
  });

  it('a failed kv write: unavailable with the bot\'s error text (EN only for an en user\'s off)', async () => {
    const orig = tm.setOptedOut;
    tm.setOptedOut = () => { throw new Error('kv down'); };
    try {
      expect((await call(RU, 'POST', '/trend/notify', '{"on": false}')).d).toEqual({ ok: false, error: 'unavailable', message: offFail('ru') });
      expect((await call(EN, 'POST', '/trend/notify', '{"on": false}')).d).toEqual({ ok: false, error: 'unavailable', message: offFail('en') });
      expect((await call(EN, 'POST', '/trend/notify', '{"on": true}')).d).toEqual({ ok: false, error: 'unavailable', message: FX.on.find((o) => o.setter === 'fail').sent[0].text });
    } finally {
      tm.setOptedOut = orig;
    }
  });

  it('the trend change card\'s button maps to this route (callback trend_notify_off)', () => {
    const kb = nodeRequire('../../../services/engine/cards/keyboards.js').trendKeyboard('ru');
    expect(kb[0][0]).toEqual({ id: 'trend_notify_off', label: '🔕 Не присылать смену тренда', action: 'trend_notify_off', kind: 'callback' });
  });
});
