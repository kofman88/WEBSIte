/**
 * Money-safety and security of the trade routes (tests/autotrade/safety), on the fake exchanges
 * (no network) through the real Express app:
 *
 *   (b) the killswitch and the risk gates cannot be bypassed through any route or parameter — the
 *       trade routes read nothing from the body, the admin killswitch endpoints (the bot's /halt,
 *       /halt_all … CONFIRM, /resume <token>) halt both the engine and the app's exec, a support
 *       session (admin impersonation, D19) never moves money or keys
 *   (c) keys: encrypted at rest; never in a log line, an HTTP answer, a DB table or a Sentry event;
 *       removal really deletes (and stops trading on them); D15 refuses a withdrawal key and an
 *       unreadable one on all four exchanges through both key routes; the bot's rate limits
 *   (d) routes: auth on every trade route, IDOR, SQL-injection-shaped and hostile ids / bodies
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import request from 'supertest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-sec-'));
process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(tmpDir, 'sec.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const W = req('./world.js');

let w;
let app;
let opsReg;
let auth;
let uidSeq = 7000;
const ENV_ON = { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bybit,bingx,binance,okx' };
const routeLines = [];
const answers = [];          // every HTTP body the tests saw
const tradeOps = req('../../../workers/tradeOpsWorker.js');
const appTrade = req('../../../routes/appTrade.js');
const appRouter = req('../../../routes/app.js');
const SD = req('../../../services/engine/signalDelivery.js');
const authService = req('../../../services/authService.js');
const KP = req('../../../services/autotrade/keyPermissions.js');
const adminRoutes = req('../../../routes/admin.js');
const { createKillswitch } = req('../../../services/autotrade/killswitch.js');

const keep = (res) => { answers.push(JSON.stringify(res.body)); answers.push(String(res.text || '')); return res; };
const post = (uid, url, body = {}, headers = null) => request(app).post(url).set(headers || auth(uid)).send(body).then(keep);
const get = (uid, url, headers = null) => request(app).get(url).set(headers || auth(uid)).then(keep);
const del = (uid, url, headers = null) => request(app).delete(url).set(headers || auth(uid)).then(keep);
const newUser = (ex, settings = {}, opts = {}) => w.user(uidSeq++, ex, settings, opts);
const longSize = (u) => w.positions(u).filter((p) => p.side === 'LONG').reduce((s, p) => s + p.size, 0);
const execCard = (tid) => JSON.stringify({ html: 'card', actions: [[{ id: 'exec', label: 'x', action: `exec_trade_${tid}`, kind: 'callback' }]], lang: 'ru' });
const qcCard = (tid) => JSON.stringify({ html: 'card', actions: [[
  { id: 'qc_half', label: '50', action: `qc_half_${tid}`, kind: 'callback' },
  { id: 'qc_full', label: '100', action: `qc_full_${tid}`, kind: 'callback' },
  { id: 'qc_be', label: 'be', action: `qc_be_${tid}`, kind: 'callback' }]], lang: 'ru' });
const setCard = (tid, json) => w.db.prepare('UPDATE signal_trades SET signal_card_json=? WHERE trade_id=?').run(json, tid);

let ks;          // the killswitch the app's admin routes and the trade-ops registry share (engine_kv store)
const ksKv = new Map();

function wrapWinston(logger) {
  const orig = {};
  for (const l of ['debug', 'info', 'warn', 'error']) {
    orig[l] = logger[l];
    logger[l] = (...a) => { routeLines.push(`[${l}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`); return orig[l].apply(logger, a); };
  }
  return () => { for (const l of Object.keys(orig)) logger[l] = orig[l]; };
}

let unwrap = null;
beforeAll(async () => {
  w = W.createWorld({ duplicateClientIds: true });
  app = (await import('../../../server.js')).default;
  ks = createKillswitch({ kv: { get: (k) => (ksKv.has(k) ? ksKv.get(k) : null), set: (k, v) => ksKv.set(k, String(v)) }, log: w.quiet, emitMutation: async () => false });
  opsReg = w.opsRegistry({ killswitch: ks });
  const facade = SD.localFacade(SD.createSignalDelivery({ log: w.quiet }));
  appTrade.configure({ clock: () => w.clk.now(), log: w.quiet, registry: opsReg, execWaitS: 30 });
  w.keysSvc.configure({ log: w.quiet, registry: opsReg, resetAuthFailures: async () => {} });
  KP.setDefaultKeyPermissionChecker(KP.createKeyPermissionChecker({ registry: opsReg, log: w.quiet }));
  adminRoutes._setKillswitch(ks);
  tradeOps.configureLocal({ registry: opsReg, log: w.quiet, now: () => w.clk.now(), delivery: facade, env: ENV_ON });
  appRouter.resetRateLimits();
  appRouter.setClock(() => w.clk.now());
  unwrap = wrapWinston(req('../../../utils/logger.js'));
  const tokens = {};
  auth = (uid) => {
    if (!tokens[uid]) tokens[uid] = authService._signAccessToken(uid);
    return { Authorization: `Bearer ${tokens[uid]}` };
  };
});
afterAll(() => {
  if (unwrap) unwrap();
  try { appTrade.configure({ clock: null, log: null, registry: null, execWaitS: null }); } catch (_e) { /* */ }
  try { w.keysSvc.configure({ log: null, registry: null, resetAuthFailures: null }); } catch (_e) { /* */ }
  try { KP.setDefaultKeyPermissionChecker(null); } catch (_e) { /* */ }
  try { adminRoutes._setKillswitch(null); } catch (_e) { /* */ }
  try { tradeOps.configureLocal(null); } catch (_e) { /* */ }
  try { appRouter.setClock(null); } catch (_e) { /* */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* tmp */ }
});

async function openPosition(ex) {
  const at = w.autoTrade();
  const u = newUser(ex);
  const r = w.signal(u);
  await w.run(at.executeAutoTrade(w.kw(u, r)));
  await w.run(at.drain());
  setCard(r.trade_id, qcCard(r.trade_id));
  return { u, r };
}

// ═══════════════════════════════════════════════════════════════════════
describe('(b) the killswitch and the risk gates cannot be bypassed', () => {
  it('exec ignores every body parameter: size, leverage, symbol and exchange come from the user settings and the trade row', async () => {
    appRouter.resetRateLimits();
    const u = newUser('bybit', { auto_trade_mode: 'confirm', trade_risk_pct: 1.0, trade_leverage: 10 });
    const r = w.signal(u);
    setCard(r.trade_id, execCard(r.trade_id));
    const hostile = {
      risk_pct: 50, trade_risk_pct: 50, leverage: 125, trade_leverage: 125, symbol: 'BTC-USDT-SWAP', exchange: 'okx',
      entry: 1, sl: 0.5, qty: 1e9, user_id: u.uid + 1, trade_id: 'x', filters_all_off: true, demo: true,
    };
    const res = await post(u.uid, `/api/app/trades/${encodeURIComponent(r.trade_id)}/exec`, hostile);
    expect(res.body.outcome).toBe('opened');
    const entry = w.entriesSent(u)[0];
    expect(entry.body.symbol).toBe('SAFEUSDT');
    expect(Number(entry.body.qty)).toBe(50);                        // 1 % of 10 000 over the 2.0 stop (the row's entry / sl)
    const lev = w.allReqs(u).find((q) => q.path === '/v5/position/set-leverage');
    expect(lev.body.buyLeverage).toBe('10');
    expect(w.fake.requests.some((q) => q.ex === 'okx' && q.key === u.key)).toBe(false);
  });

  it('admin killswitch (the bot\'s /halt, /halt_all … CONFIRM, /resume <token>): non-admins refused; HALTED stops the engine AND the app\'s exec; one-shot token', async () => {
    const admin = newUser('bybit');
    w.db.prepare("UPDATE users SET is_admin=1, admin_role='superadmin' WHERE id=?").run(admin.uid);
    const plain = newUser('bybit');
    expect((await get(plain.uid, '/api/admin/engine/killswitch')).status).toBe(403);
    expect((await post(plain.uid, '/api/admin/engine/killswitch/halt', { reason: 'x' })).status).toBe(403);
    expect((await get(admin.uid, '/api/admin/engine/killswitch')).body).toMatchObject({ ok: true, state: 'ACTIVE' });
    // halt_all needs CONFIRM
    const noConfirm = await post(admin.uid, '/api/admin/engine/killswitch/halt-all', { reason: 'panic' });
    expect(noConfirm.status).toBe(400);
    expect((await ks.getState())[0]).toBe('ACTIVE');
    const halt = await post(admin.uid, '/api/admin/engine/killswitch/halt', { reason: 'incident' });
    expect(halt.body).toMatchObject({ ok: true, state: 'HALTED_NEW', reason: 'incident' });
    const token = halt.body.resume_token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect((await post(admin.uid, '/api/admin/engine/killswitch/halt', {})).status).toBe(409);
    const status = await get(admin.uid, '/api/admin/engine/killswitch');
    expect(status.body).toMatchObject({ state: 'HALTED_NEW', has_resume_token: true, actor_uid: admin.uid });
    expect(JSON.stringify(status.body)).not.toContain(token);
    // the engine: execute_auto_trade blocks before any exchange request
    ks.invalidateCache();
    const at = w.autoTrade({ killswitch: ks });
    const u1 = newUser('bingx');
    const r1 = w.signal(u1);
    const res1 = await w.run(at.executeAutoTrade(w.kw(u1, r1)));
    expect(res1.limit_msg).toBe('killswitch_halted: HALTED_NEW');
    expect(w.allReqs(u1)).toEqual([]);
    // the app: the confirm exec reaches the trader, which refuses before any request
    appRouter.resetRateLimits();
    const u2 = newUser('okx', { auto_trade_mode: 'confirm' });
    const r2 = w.signal(u2);
    setCard(r2.trade_id, execCard(r2.trade_id));
    const ex = await post(u2.uid, `/api/app/trades/${encodeURIComponent(r2.trade_id)}/exec`);
    expect(ex.body.outcome).toBe('failed');
    expect(JSON.stringify(ex.body)).toContain('killswitch_halted: HALTED_NEW');
    expect(w.orderReqs(u2)).toEqual([]);
    // resume: wrong token refused, the right one works once
    expect((await post(admin.uid, '/api/admin/engine/killswitch/resume', { token: 'wrong-token-1234' })).status).toBe(403);
    expect((await post(admin.uid, '/api/admin/engine/killswitch/resume', {})).status).toBe(400);
    expect((await post(admin.uid, '/api/admin/engine/killswitch/resume', { token })).body).toMatchObject({ ok: true, state: 'ACTIVE' });
    const all = await post(admin.uid, '/api/admin/engine/killswitch/halt-all', { reason: 'x', confirm: 'CONFIRM' });
    expect(all.body.state).toBe('HALTED_ALL');
    expect((await post(admin.uid, '/api/admin/engine/killswitch/resume', { token })).status).toBe(403);   // the old token is spent
    expect((await post(admin.uid, '/api/admin/engine/killswitch/resume', { token: all.body.resume_token })).body.state).toBe('ACTIVE');
    // every flip is in the audit log, with the admin as actor
    const audit = w.db.prepare("SELECT user_id, metadata FROM audit_log WHERE action='killswitch_flipped' ORDER BY id").all();
    expect(audit.length).toBe(0);   // this test injects its own killswitch (no mutation sink)
  });

  it('the default admin killswitch writes every flip to audit_log with the admin id', async () => {
    adminRoutes._setKillswitch(null);
    const admin = newUser('bybit');
    w.db.prepare("UPDATE users SET is_admin=1, admin_role='superadmin' WHERE id=?").run(admin.uid);
    const h = await post(admin.uid, '/api/admin/engine/killswitch/halt', { reason: 'audit check' });
    expect(h.body.state).toBe('HALTED_NEW');
    await post(admin.uid, '/api/admin/engine/killswitch/resume', { token: h.body.resume_token });
    const audit = w.db.prepare("SELECT user_id, metadata FROM audit_log WHERE action='killswitch_flipped' ORDER BY id").all();
    expect(audit.map((a) => a.user_id)).toEqual([admin.uid, admin.uid]);
    expect(audit.map((a) => JSON.parse(a.metadata).after)).toEqual(['HALTED_NEW', 'ACTIVE']);
    adminRoutes._setKillswitch(ks);
  });

  it('D19: an admin support session (impersonation token) never opens / closes a position or adds / removes a key', async () => {
    appRouter.resetRateLimits();
    const admin = newUser('bybit');
    w.db.prepare("UPDATE users SET is_admin=1, admin_role='superadmin' WHERE id=?").run(admin.uid);
    const { u, r } = await openPosition('bybit');
    const imp = await post(admin.uid, `/api/admin/users/${u.uid}/impersonate`, { reason: 'support ticket 1' });
    expect(imp.status).toBe(200);
    // the support session token comes from the one-time hand-off code (never from the admin answer)
    const red = await request(app).post('/api/auth/impersonation/redeem').send({ code: imp.body.handoffCode });
    expect(red.status).toBe(200);
    const H = { Authorization: `Bearer ${red.body.accessToken}` };
    const tid = encodeURIComponent(r.trade_id);
    const before = w.fake.requests.length;
    for (const a of ['exec', 'qc/half', 'qc/full', 'qc/force', 'qc/be']) {
      const res = await post(u.uid, `/api/app/trades/${tid}/${a}`, {}, H);
      expect(res.status, a).toBe(403);
      expect(res.body).toEqual({ ok: false, error: 'impersonation_forbidden' });
    }
    const k = await post(u.uid, '/api/app/exchange/keys', { exchange: 'bybit', api_key: 'IMPKEY0123456789', api_secret: 'imp-secret-0123456789' }, H);
    expect(k.status).toBe(403);
    expect((await post(u.uid, '/api/app/exchange/keys/remove', { exchange: 'bybit' }, H)).status).toBe(403);
    expect((await post(u.uid, '/api/exchanges/keys', { exchange: 'bybit', apiKey: 'IMPKEY0123456789', apiSecret: 'imp-secret-0123456789' }, H)).status).toBe(403);
    const keyId = w.db.prepare('SELECT id FROM exchange_keys WHERE user_id=?').get(u.uid).id;
    expect((await del(u.uid, `/api/exchanges/keys/${keyId}`, H)).status).toBe(403);
    expect(w.fake.requests.length).toBe(before);
    expect(near(longSize(u), 51.282)).toBe(true);
    expect(w.db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE user_id=?').get(u.uid).n).toBe(1);
    // reading stays possible (support work): progress / card / positions
    expect((await get(u.uid, `/api/app/trades/${tid}/card`, H)).status).toBe(200);
    expect(routeLines.concat(w.logs).some((l) => l.includes('[IMPERSONATION-BLOCK]'))).toBe(true);
  });

  it('settings/all cannot push risk, leverage or the trade limit outside the bot\'s ranges', async () => {
    appRouter.resetRateLimits();
    const u = newUser('bybit');
    for (const [field, value] of [['trade_risk_pct', 50], ['trade_risk_pct', -1], ['trade_leverage', 125], ['trade_leverage', 0], ['max_trades_limit', -5], ['max_trades_limit', 10 ** 9]]) {
      const res = await post(u.uid, '/api/app/settings/all', { trading: { [field]: value } });
      expect(res.body.ok, `${field}=${value}`).toBe(false);
    }
    const row = w.db.prepare('SELECT trade_risk_pct, trade_leverage, max_trades_limit FROM trader_settings WHERE user_id=?').get(u.uid);
    expect(row).toEqual({ trade_risk_pct: 1.0, trade_leverage: 10, max_trades_limit: 10 });
  });
});

const near = (a, b) => Math.abs(a - b) < 1e-6;

// ═══════════════════════════════════════════════════════════════════════
describe('(c) exchange keys', () => {
  const PERMS = {
    bybit: { ok: null, withdraw: { ContractTrade: ['Order', 'Position'], Wallet: ['AccountTransfer', 'Withdraw'] } },
    bingx: { ok: null, withdraw: [1, 2, 3, 5] },
    binance: { ok: null, withdraw: { withdraw: true } },
    okx: { ok: null, withdraw: 'read_only,trade,withdraw' },
  };
  const PERM_PATH = {
    bybit: '/v5/user/query-api', bingx: '/openApi/v1/account/apiPermissions', binance: '/sapi/v1/account/apiRestrictions', okx: '/api/v5/account/config',
  };
  const body = (u) => ({ exchange: u.ex, api_key: u.key, api_secret: u.secret, ...(u.ex === 'okx' ? { passphrase: u.passphrase } : {}) });

  for (const ex of W.EXCHANGES) {
    it(`${ex}: D15 on POST /api/app/exchange/keys — withdraw → refused, unreadable permissions → refused (try again), clean key → stored ENCRYPTED`, async () => {
      // a withdrawal-capable key
      appRouter.resetRateLimits();
      const bad = newUser(ex, {}, { perms: PERMS[ex].withdraw, storeKeys: false });
      const r1 = await post(bad.uid, '/api/app/exchange/keys', body(bad));
      expect(r1.body).toMatchObject({ ok: false, error: 'withdraw_permission' });
      expect(w.db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE user_id=?').get(bad.uid).n).toBe(0);
      // the permission endpoint does not answer
      appRouter.resetRateLimits();
      const flaky = newUser(ex, {}, { storeKeys: false });
      w.faults.add({ on: (p) => p.path === PERM_PATH[ex], kind: 'reset-after', key: flaky.key, times: 3 });
      const r2 = await post(flaky.uid, '/api/app/exchange/keys', body(flaky));
      expect(r2.body).toMatchObject({ ok: false, error: 'permission_unknown' });
      expect(r2.body.message).toContain('Попробуйте ещё раз');
      expect(w.db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE user_id=?').get(flaky.uid).n).toBe(0);
      // a trade-only key
      appRouter.resetRateLimits();
      const good = newUser(ex, {}, { storeKeys: false });
      const r3 = await post(good.uid, '/api/app/exchange/keys', body(good));
      expect(r3.body).toMatchObject({ ok: true, exchange: ex });
      expect(r3.body.key_hint).toBe(`${good.key.slice(0, 4)}…${good.key.slice(-2)}`);
      const row = w.db.prepare('SELECT * FROM exchange_keys WHERE user_id=?').get(good.uid);
      const raw = JSON.stringify(row);
      for (const s of [good.key, good.secret, good.passphrase].filter(Boolean)) expect(raw).not.toContain(s);
      expect(w.keysSvc.exchangeKeys(good.uid, ex)).toEqual([good.key, good.secret, ex === 'okx' ? good.passphrase : '']);
    });

    it(`${ex}: D15 on the account page's POST /api/exchanges/keys — the same verdicts (400 / 503), nothing stored`, async () => {
      const bad = newUser(ex, {}, { perms: PERMS[ex].withdraw, storeKeys: false });
      const b = { exchange: ex, apiKey: bad.key, apiSecret: bad.secret, ...(ex === 'okx' ? { passphrase: bad.passphrase } : {}) };
      const r1 = await post(bad.uid, '/api/exchanges/keys', b);
      expect(r1.status).toBe(400);
      expect(r1.body.code).toBe('KEY_CAN_WITHDRAW');
      const flaky = newUser(ex, {}, { storeKeys: false });
      w.faults.add({ on: (p) => p.path === PERM_PATH[ex], kind: 'connect-error', key: flaky.key, times: 3 });
      const r2 = await post(flaky.uid, '/api/exchanges/keys', { ...b, apiKey: flaky.key, apiSecret: flaky.secret, ...(ex === 'okx' ? { passphrase: flaky.passphrase } : {}) });
      expect(r2.status).toBe(503);
      expect(r2.body.code).toBe('KEY_PERMISSIONS_UNVERIFIED');
      expect(w.db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE user_id IN (?, ?)').get(bad.uid, flaky.uid).n).toBe(0);
    });
  }

  it('removal really deletes: no row, auto-trade off, the Bybit session dropped; exec / positions / quick close never use the key again', async () => {
    appRouter.resetRateLimits();
    const { u, r } = await openPosition('bybit');
    const inst = opsReg('bybit', false);
    // a session for the key exists in this thread (the open above went through the engine's own registry;
    // build one here like a test_connection / positions call would)
    await get(u.uid, '/api/app/positions');
    const crypto = req('crypto');
    const sessKey = crypto.createHash('sha256').update(`${u.key}:live`).digest('hex').slice(0, 32);
    expect(inst._state.pybitSessions.has(sessKey)).toBe(true);            // the secret is held in memory now
    const res = await post(u.uid, '/api/app/exchange/keys/remove', { exchange: 'bybit' });
    expect(inst._state.pybitSessions.has(sessKey)).toBe(false);           // … and dropped with the key
    expect(res.body).toEqual({ ok: true });
    expect(w.db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE user_id=?').get(u.uid).n).toBe(0);
    expect(w.db.prepare('SELECT auto_trade FROM trader_settings WHERE user_id=?').get(u.uid).auto_trade).toBe(0);
    const before = w.allReqs(u).length;
    appRouter.resetRateLimits();
    const pos = await get(u.uid, '/api/app/positions');
    expect(pos.body).toMatchObject({ ok: true, positions: [], orders_count: 0 });
    const qc = await post(u.uid, `/api/app/trades/${encodeURIComponent(r.trade_id)}/qc/full`);
    expect(qc.body.message).toBe('API-ключи не настроены');
    expect(w.allReqs(u).length).toBe(before);
    // the engine side reads no key either
    const at = w.autoTrade();
    expect(at.getApiKeys({ user_id: u.uid }, 'bybit')).toBe(null);
  });

  it('the account page DELETE /api/exchanges/keys/:id: the row goes, and with the last key of the trade exchange auto-trade goes off', async () => {
    const u = newUser('binance');
    const id = w.db.prepare('SELECT id FROM exchange_keys WHERE user_id=?').get(u.uid).id;
    const intruder = newUser('binance');
    expect((await del(intruder.uid, `/api/exchanges/keys/${id}`)).status).toBe(404);     // IDOR: not his key
    expect((await del(u.uid, `/api/exchanges/keys/${id}`)).body).toEqual({ deleted: true });
    expect(w.db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE id=?').get(id).n).toBe(0);
    expect(w.db.prepare('SELECT auto_trade FROM trader_settings WHERE user_id=?').get(u.uid).auto_trade).toBe(0);
    expect(w.db.prepare('SELECT auto_trade FROM trader_settings WHERE user_id=?').get(intruder.uid).auto_trade).toBe(1);
  });

  it('the account page DELETE of a Bybit key also drops this thread\'s Bybit session of it', async () => {
    appRouter.resetRateLimits();
    const u = newUser('bybit');
    const inst = opsReg('bybit', false);
    await get(u.uid, '/api/app/positions');
    const sessKey = req('crypto').createHash('sha256').update(`${u.key}:live`).digest('hex').slice(0, 32);
    expect(inst._state.pybitSessions.has(sessKey)).toBe(true);
    const id = w.db.prepare('SELECT id FROM exchange_keys WHERE user_id=?').get(u.uid).id;
    expect((await del(u.uid, `/api/exchanges/keys/${id}`)).body).toEqual({ deleted: true });
    expect(inst._state.pybitSessions.has(sessKey)).toBe(false);
    expect(w.db.prepare('SELECT auto_trade FROM trader_settings WHERE user_id=?').get(u.uid).auto_trade).toBe(0);
  });

  it('rate limits as the bot: keys 1 / 30 s (HTTP 200 rate_limited, no exchange request), positions 6 / 60 s (429, Retry-After 10)', async () => {
    appRouter.resetRateLimits();
    const u = newUser('bybit', {}, { storeKeys: false });
    const first = await post(u.uid, '/api/app/exchange/keys', { exchange: 'bybit', api_key: u.key, api_secret: u.secret });
    expect(first.body.ok).toBe(true);
    const n = w.allReqs(u).length;
    const second = await post(u.uid, '/api/app/exchange/keys', { exchange: 'bybit', api_key: u.key, api_secret: u.secret });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: false, error: 'rate_limited', message: 'Проверка ключей — не чаще раза в 30 секунд' });
    expect(w.allReqs(u).length).toBe(n);
    for (let i = 0; i < 6; i++) expect((await get(u.uid, '/api/app/positions')).status).toBe(200);
    const seventh = await get(u.uid, '/api/app/positions');
    expect(seventh.status).toBe(429);
    expect(seventh.headers['retry-after']).toBe('10');
  });

  it('never leaked: no key, secret or passphrase in any log line, HTTP answer, DB table or Sentry event of everything above', async () => {
    // a failing key test (the exchange answers an auth error) and an exception path, for the error texts
    appRouter.resetRateLimits();
    const u = newUser('okx', {}, { storeKeys: false });
    w.fake.account('okx', u.key).passphrase = 'other';   // the exchange refuses the passphrase
    await post(u.uid, '/api/app/exchange/keys', { exchange: 'okx', api_key: u.key, api_secret: u.secret, passphrase: u.passphrase });
    const secrets = [];
    for (const k of w.users.values()) {
      secrets.push(k.secret, k.key);
      if (k.passphrase) secrets.push(k.passphrase);
    }
    const tables = w.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    const dbText = tables.map((t) => JSON.stringify(w.db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
    const logText = w.logs.concat(routeLines).join('\n');
    const httpText = answers.join('\n');
    const leaks = [];
    for (const s of secrets) {
      if (logText.includes(s)) leaks.push(['log', s]);
      if (httpText.includes(s)) leaks.push(['http', s]);
      if (dbText.includes(s)) leaks.push(['db', s]);
    }
    expect(leaks).toEqual([]);
    expect(secrets.length).toBeGreaterThan(20);
    // Sentry: a captured request with the bot's key fields is scrubbed (the beforeSend of utils/sentry.js)
    const { scrubEvent } = req('../../../utils/sentry.js');
    const ev = scrubEvent({
      request: { headers: { Authorization: 'Bearer x', 'X-BAPI-API-KEY': u.key, 'OK-ACCESS-PASSPHRASE': u.passphrase }, data: { exchange: 'okx', api_key: u.key, api_secret: u.secret, passphrase: u.passphrase } },
      extra: { apiKey: u.key, nested: { api_secret: u.secret } },
    });
    const evText = JSON.stringify(ev);
    for (const s of [u.key, u.secret, u.passphrase]) expect(evText).not.toContain(s);
    expect(ev.request.data.exchange).toBe('okx');
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('(d) the trade routes: auth, IDOR, injection-shaped and hostile input', () => {
  it('every trade route answers 401 without a valid token and does no work', async () => {
    const before = w.fake.requests.length;
    for (const [m, url] of [
      ['post', '/api/app/exchange/keys'], ['post', '/api/app/exchange/keys/remove'], ['get', '/api/app/positions'],
      ['post', '/api/app/trades/1_x/exec'], ['post', '/api/app/trades/1_x/qc/half'], ['post', '/api/app/trades/1_x/qc/full'],
      ['post', '/api/app/trades/1_x/qc/force'], ['post', '/api/app/trades/1_x/qc/be'], ['get', '/api/app/trades/1_x/progress'],
      ['get', '/api/app/trades/1_x/card'], ['get', '/api/admin/engine/killswitch'], ['post', '/api/admin/engine/killswitch/halt'],
    ]) {
      for (const h of [{}, { Authorization: 'Bearer not-a-jwt' }, { Authorization: 'Basic abc' }]) {
        const r = await request(app)[m](url).set(h).send({});
        expect(r.status, `${m} ${url} ${JSON.stringify(h)}`).toBe(401);
      }
    }
    expect(w.fake.requests.length).toBe(before);
    expect((await ks.getState())[0]).toBe('ACTIVE');
  });

  it('injection-shaped and hostile trade ids → 404 before any work; the table is intact', async () => {
    appRouter.resetRateLimits();
    const { u, r } = await openPosition('bybit');
    const count = w.db.prepare('SELECT COUNT(*) n FROM signal_trades').get().n;
    const before = w.fake.requests.length;
    const ids = [
      "x' OR '1'='1", `${r.trade_id}' OR 1=1 --`, '%', '_', '%25', `${r.trade_id}%00`, '1;DROP TABLE signal_trades',
      'a'.repeat(5000), '..%2F..%2Fexchange%2Fkeys', 'ﾠ', '‮', `${r.trade_id.toUpperCase()}`,
    ];
    for (const id of ids) {
      appRouter.resetRateLimits();       // the bot's generic POST bucket (30 / 60 s) would answer 429 first
      for (const a of ['exec', 'qc/half', 'qc/full', 'qc/be']) {
        const res = await post(u.uid, `/api/app/trades/${encodeURIComponent(id)}/${a}`);
        expect([404, 405], `${a} ${id.slice(0, 40)}`).toContain(res.status);
      }
    }
    expect(w.db.prepare('SELECT COUNT(*) n FROM signal_trades').get().n).toBe(count);
    expect(w.fake.requests.length).toBe(before);
    expect(near(longSize(u), 51.282)).toBe(true);
  });

  it('hostile key bodies (types, sizes, unknown exchanges) → the bot\'s bad_request, nothing sent or stored', async () => {
    const u = newUser('bybit', {}, { storeKeys: false });
    const before = w.fake.requests.length;
    const cases = [
      [{ exchange: ['bybit'], api_key: u.key, api_secret: u.secret }, 'exchange'],
      [{ exchange: 'ftx', api_key: u.key, api_secret: u.secret }, 'exchange'],
      [{ exchange: 'bybit', api_key: { a: 1 }, api_secret: u.secret }, 'api_key'],      // str({'a': 1}) is 8 chars
      [{ exchange: 'bybit', api_key: 'short', api_secret: u.secret }, 'api_key'],
      [{ exchange: 'bybit', api_key: u.key, api_secret: 12345 }, 'api_secret'],
      [{ exchange: 'okx', api_key: u.key, api_secret: u.secret, passphrase: '' }, 'passphrase'],
      [{ exchange: 'bybit' }, 'api_key'],
    ];
    for (const [b, want] of cases) {
      appRouter.resetRateLimits();
      const res = await post(u.uid, '/api/app/exchange/keys', b);
      expect(res.body, JSON.stringify(b)).toEqual({ ok: false, error: 'bad_request', message: want });
    }
    expect(w.fake.requests.length).toBe(before);       // every bad_request answered before any exchange call
    // str() of an object long enough is just a (wrong) key string — the exchange refuses it, nothing is stored
    appRouter.resetRateLimits();
    const odd = await post(u.uid, '/api/app/exchange/keys', { exchange: 'bybit', api_key: { $gt: '', $ne: null }, api_secret: u.secret });
    expect(odd.body).toMatchObject({ ok: false, error: 'invalid_keys' });
    appRouter.resetRateLimits();
    const huge = await request(app).post('/api/app/exchange/keys').set(auth(u.uid)).set('Content-Type', 'application/json').send(`{"exchange":"bybit","api_key":"${'k'.repeat(2 * 1024 * 1024)}"}`);
    expect([200, 413]).toContain(huge.status);
    expect(w.fake.requests.filter((q, i) => i >= before && ['/v5/user/query-api'].includes(q.path))).toEqual([]);   // never reached D15
    expect(w.db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE user_id=?').get(u.uid).n).toBe(0);
  });
});
