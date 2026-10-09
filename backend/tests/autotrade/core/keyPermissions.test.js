/**
 * D15 — withdrawal-capable exchange keys are refused on key add (fail-closed).
 *
 * Recorded responses (the documented shapes of Bybit /v5/user/query-api, Binance
 * /sapi/v1/account/apiRestrictions, OKX /api/v5/account/config, BingX
 * /openApi/v1/account/apiPermissions) are served by a scripted transport; the requests
 * the checker builds (host, path, auth headers, signature) are checked against an independent
 * HMAC computation. No test opens a connection.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const KP = nodeRequire('../../../services/autotrade/keyPermissions.js');

const T0 = 1767225600.25;
const KEY = 'TESTKEY0123456789';
const SEC = 'test-secret-abcdef';
const PP = 'Pass-phrase#1';
const hmacHex = (msg) => crypto.createHmac('sha256', SEC).update(msg).digest('hex');
const hmacB64 = (msg) => crypto.createHmac('sha256', SEC).update(msg).digest('base64');
const quietLog = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };

/** a transport serving one recorded response and recording the request */
function recorded(resp) {
  const seen = [];
  const tx = async (req) => {
    seen.push(req);
    if (resp instanceof Error) throw resp;
    return { status: resp.status === undefined ? 200 : resp.status, headers: { 'content-type': 'application/json' }, text: typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body) };
  };
  return { tx, seen };
}
const checker = (resp) => {
  const r = recorded(resp);
  return { ...r, c: KP.createKeyPermissionChecker({ transport: r.tx, now: () => T0, log: quietLog, sleep: async () => {} }) };
};

const BYBIT_PERMS = {
  ContractTrade: ['Order', 'Position'], Spot: ['SpotTrade'], Wallet: ['AccountTransfer', 'SubMemberTransfer'],
  Options: ['OptionsTrade'], Derivatives: ['DerivativesTrade'], CopyTrading: ['CopyTrading'], BlockTrade: [],
  Exchange: ['ExchangeHistory'], NFT: [], Affiliate: [], Earn: [],
};
const bybitBody = (perms) => ({
  retCode: 0, retMsg: '', retExtInfo: {}, time: 1767225600300,
  result: {
    id: '13770661', note: 'autotrade', apiKey: KEY, readOnly: 0, secret: '', permissions: perms, ips: ['*'], type: 1,
    deadlineDay: 66, expiredAt: '2026-12-22T07:20:25Z', createdAt: '2026-10-07T02:18:23Z', unified: 0, uta: 1,
    userID: 24617703, inviterID: 0, vipLevel: 'No VIP', mktMakerLevel: '0', affiliateID: 0, rsaPublicKey: '',
    isMaster: true, parentUid: '0', kycLevel: 'LEVEL_DEFAULT', kycRegion: '',
  },
});
const binanceBody = (withdraw) => ({
  ipRestrict: true, createTime: 1698645219000, enableReading: true, enableWithdrawals: withdraw, enableInternalTransfer: false,
  enableMargin: false, enableFutures: true, permitsUniversalTransfer: false, enableVanillaOptions: false,
  enableFixApiTrade: false, enableFixReadOnly: false, enableSpotAndMarginTrading: false, enablePortfolioMarginTrading: false,
});
const okxBody = (perm) => ({
  code: '0', msg: '',
  data: [{
    acctLv: '2', autoLoan: false, ctIsoMode: 'automatic', greeksType: 'PA', level: 'Lv1', levelTmp: '', mgnIsoMode: 'automatic',
    posMode: 'long_short_mode', spotOffsetType: '', uid: '44705892343619584', label: 'autotrade', roleType: '0', traderInsts: [],
    spotRoleType: '0', spotTraderInsts: [], opAuth: '0', kycLv: '3', ip: '120.255.24.182', perm, mainUid: '44705892343619584',
  }],
});
const bingxBody = (perms) => ({ code: 0, msg: '', debugMsg: '', data: { ipAddresses: ['120.255.24.182'], note: 'autotrade', permissions: perms } });

describe('D15 requests — host, path, auth, signature (the trader\'s own signing, checked with an independent HMAC)', () => {
  const query = (url) => url.split('?')[1] || '';
  const unsigned = (url) => query(url).split('&signature=')[0];
  const sigOf = (url) => (query(url).split('&signature=')[1] || '');

  it('bybit: GET /v5/user/query-api with V5 auth headers (demo key → api-demo)', async () => {
    const { c, seen } = checker({ body: bybitBody(BYBIT_PERMS) });
    await c.check({ exchange: 'bybit', apiKey: KEY, apiSecret: SEC });
    await c.check({ exchange: 'bybit', apiKey: KEY, apiSecret: SEC, testnet: true });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ method: 'GET' });
    expect(seen[0].url.split('?')[0]).toBe('https://api.bybit.com/v5/user/query-api');
    const h = seen[0].headers;
    expect(h).toMatchObject({ 'X-BAPI-API-KEY': KEY, 'X-BAPI-SIGN-TYPE': '2' });
    expect(h['X-BAPI-SIGN']).toBe(hmacHex(h['X-BAPI-TIMESTAMP'] + KEY + h['X-BAPI-RECV-WINDOW'] + query(seen[0].url)));
    expect(seen[1].url.split('?')[0]).toBe('https://api-demo.bybit.com/v5/user/query-api');
  });

  it('binance: signed GET /sapi/v1/account/apiRestrictions on api.binance.com', async () => {
    const { c, seen } = checker({ body: binanceBody(false) });
    await c.check({ exchange: 'binance', apiKey: KEY, apiSecret: SEC });
    expect(seen).toHaveLength(1);
    expect(seen[0].url.split('?')[0]).toBe('https://api.binance.com/sapi/v1/account/apiRestrictions');
    expect(unsigned(seen[0].url)).toContain(`timestamp=${Math.trunc(T0 * 1000)}`);
    expect(sigOf(seen[0].url)).toBe(hmacHex(unsigned(seen[0].url)));
    expect(seen[0].headers).toEqual({ 'X-MBX-APIKEY': KEY });
  });

  it('okx: GET /api/v5/account/config with OK-ACCESS-* (+ simulated trading for demo keys)', async () => {
    const { c, seen } = checker({ body: okxBody('read_only,trade') });
    await c.check({ exchange: 'okx', apiKey: KEY, apiSecret: SEC, passphrase: PP });
    await c.check({ exchange: 'okx', apiKey: KEY, apiSecret: SEC, passphrase: PP, testnet: true });
    expect(seen[0].url).toBe('https://www.okx.com/api/v5/account/config');
    const h = seen[0].headers;
    expect(h).toMatchObject({ 'OK-ACCESS-KEY': KEY, 'OK-ACCESS-PASSPHRASE': PP });
    expect(h['OK-ACCESS-SIGN']).toBe(hmacB64(`${h['OK-ACCESS-TIMESTAMP']}GET/api/v5/account/config`));
    expect(h['x-simulated-trading']).toBeUndefined();
    expect(seen[1].headers['x-simulated-trading']).toBe('1');
  });

  it('bingx: signed GET /openApi/v1/account/apiPermissions', async () => {
    const { c, seen } = checker({ body: bingxBody([1, 2, 3]) });
    await c.check({ exchange: 'bingx', apiKey: KEY, apiSecret: SEC });
    expect(seen).toHaveLength(1);
    expect(seen[0].url.split('?')[0]).toBe('https://open-api.bingx.com/openApi/v1/account/apiPermissions');
    expect(unsigned(seen[0].url)).toContain(`timestamp=${Math.trunc(T0 * 1000)}`);
    expect(sigOf(seen[0].url)).toBe(hmacHex(unsigned(seen[0].url)));
    expect(seen[0].headers).toMatchObject({ 'X-BX-APIKEY': KEY });
  });

  it('never sends a request without key + secret (+ passphrase on OKX)', async () => {
    const { c, seen } = checker({ body: {} });
    expect((await c.check({ exchange: 'bybit', apiKey: '', apiSecret: SEC })).verdict).toBe('unknown');
    expect((await c.check({ exchange: 'okx', apiKey: KEY, apiSecret: SEC })).verdict).toBe('unknown');
    expect((await c.check({ exchange: 'kraken', apiKey: KEY, apiSecret: SEC })).verdict).toBe('unknown');
    expect(seen).toHaveLength(0);
  });

  it('one implementation behind both key-add paths: the app route\'s service reads through this module', () => {
    const keysSvc = nodeRequire('../../../services/exchangeKeysService.js');
    expect(keysSvc.D15_MESSAGES).toBe(KP.MESSAGES);
    expect(keysSvc._verdicts).toBe(KP.verdicts);
    expect(keysSvc.PERMISSION_TIMEOUT_S).toBe(KP.PERMISSION_TIMEOUT_S);
  });
});

describe('D15 verdicts on recorded responses', () => {
  const cases = [
    ['bybit', { body: bybitBody(BYBIT_PERMS) }, 'ok'],
    ['bybit', { body: bybitBody({ ...BYBIT_PERMS, Wallet: ['AccountTransfer', 'SubMemberTransfer', 'Withdraw'] }) }, 'withdraw'],
    ['bybit', { body: { retCode: 10003, retMsg: 'API key is invalid.', result: {}, retExtInfo: {}, time: 1 } }, 'unknown'],
    ['bybit', { body: { ...bybitBody(BYBIT_PERMS), result: { apiKey: KEY } } }, 'unknown'],
    ['bybit', { body: bybitBody({ ...BYBIT_PERMS, Wallet: 'Withdraw' }) }, 'unknown'],
    ['binance', { body: binanceBody(false) }, 'ok'],
    ['binance', { body: binanceBody(true) }, 'withdraw'],
    ['binance', { status: 401, body: { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' } }, 'unknown'],
    ['binance', { body: { code: -2015, msg: 'Invalid API-key, IP, or permissions for action.' } }, 'unknown'],
    ['binance', { body: { ...binanceBody(false), enableWithdrawals: 'false' } }, 'unknown'],
    ['okx', { body: okxBody('read_only,trade') }, 'ok'],
    ['okx', { body: okxBody('read_only,withdraw,trade') }, 'withdraw'],
    ['okx', { status: 401, body: { code: '50111', msg: 'Invalid OK-ACCESS-KEY', data: [] } }, 'unknown'],
    ['okx', { body: { code: '0', msg: '', data: [] } }, 'unknown'],
    ['okx', { body: okxBody('') }, 'unknown'],
    ['bingx', { body: bingxBody([1, 2, 3]) }, 'ok'],
    ['bingx', { body: bingxBody([1, 2, 3, 5]) }, 'withdraw'],
    ['bingx', { body: bingxBody(['Spot Trading', 'Withdraw']) }, 'withdraw'],
    ['bingx', { body: { code: 100001, msg: 'Signature verification failed', debugMsg: '' } }, 'unknown'],
    ['bingx', { body: { code: 0, msg: '', data: {} } }, 'unknown'],
  ];
  for (const [ex, resp, want] of cases) {
    it(`${ex} → ${want} (${JSON.stringify(resp.body).slice(0, 60)})`, async () => {
      const { c } = checker(resp);
      expect((await c.check({ exchange: ex, apiKey: KEY, apiSecret: SEC, passphrase: PP })).verdict).toBe(want);
    });
  }

  it('transport failures, non-JSON and 5xx are undeterminable (fail-closed)', async () => {
    const { TransportError } = nodeRequire('../../../services/exchanges/transport.js');
    for (const resp of [new TransportError('timeout', ''), new TransportError('connect', 'ECONNREFUSED'), { status: 502, body: '<html>bad gateway</html>' }, { body: 'not json' }]) {
      for (const ex of ['bybit', 'binance', 'okx', 'bingx']) {
        const { c } = checker(resp);
        expect((await c.check({ exchange: ex, apiKey: KEY, apiSecret: SEC, passphrase: PP })).verdict, ex).toBe('unknown');
      }
    }
  });

  it('assertKeyCanBeAdded: withdraw → 400 KEY_CAN_WITHDRAW, unknown → 503 KEY_PERMISSIONS_UNVERIFIED (ru / en)', async () => {
    const w = checker({ body: binanceBody(true) }).c;
    await expect(w.assertKeyCanBeAdded({ exchange: 'binance', apiKey: KEY, apiSecret: SEC })).rejects.toMatchObject({
      statusCode: 400, code: 'KEY_CAN_WITHDRAW', message: KP.MESSAGES.withdraw.ru,
    });
    await expect(w.assertKeyCanBeAdded({ exchange: 'binance', apiKey: KEY, apiSecret: SEC }, { lang: 'en' })).rejects.toMatchObject({
      statusCode: 400, message: KP.MESSAGES.withdraw.en,
    });
    const u = checker({ status: 500, body: {} }).c;
    await expect(u.assertKeyCanBeAdded({ exchange: 'bybit', apiKey: KEY, apiSecret: SEC }, { lang: 'en' })).rejects.toMatchObject({
      statusCode: 503, code: 'KEY_PERMISSIONS_UNVERIFIED', message: KP.MESSAGES.unknown.en,
    });
    const ok = checker({ body: okxBody('read_only,trade') }).c;
    await expect(ok.assertKeyCanBeAdded({ exchange: 'okx', apiKey: KEY, apiSecret: SEC, passphrase: PP })).resolves.toMatchObject({ verdict: 'ok' });
  });

  it('logs the verdict but never the key, secret, passphrase or signature', async () => {
    const lines = [];
    const log = { ...quietLog, info: (m) => lines.push(String(m)), warning: (m) => lines.push(String(m)) };
    const r = recorded({ body: okxBody('read_only,withdraw') });
    const c = KP.createKeyPermissionChecker({ transport: r.tx, now: () => T0, log, sleep: async () => {} });
    await expect(c.assertKeyCanBeAdded({ exchange: 'okx', apiKey: KEY, apiSecret: SEC, passphrase: PP })).rejects.toThrow();
    const text = lines.join('\n');
    expect(text).toContain('verdict=withdraw');
    for (const s of [KEY, SEC, PP, r.seen[0].headers['OK-ACCESS-SIGN']]) expect(text).not.toContain(s);
  });

  it('under vitest the default transport refuses to connect', async () => {
    const c = KP.createKeyPermissionChecker({ log: quietLog, sleep: async () => {} });
    for (const ex of ['bybit', 'binance', 'okx', 'bingx']) {
      expect((await c.check({ exchange: ex, apiKey: KEY, apiSecret: SEC, passphrase: PP })).verdict, ex).toBe('unknown');
    }
  });
});

// ── the key-add route ─────────────────────────────────────────────────────
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-key-permissions.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';

describe('POST /api/exchanges/keys — D15 gate', () => {
  let app;
  let db;
  let authService;
  const freshDb = () => {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* none */ } }
  };
  beforeAll(async () => {
    freshDb();
    db = nodeRequire('../../../models/database.js');
    app = nodeRequire('../../../server.js');
    authService = nodeRequire('../../../services/authService.js');
  });
  afterAll(() => { KP.setDefaultKeyPermissionChecker(null); });
  beforeEach(() => {
    db.prepare('DELETE FROM exchange_keys').run();
    db.prepare('DELETE FROM users').run();
    KP.setDefaultKeyPermissionChecker(null);
  });
  const makeUser = (locale = 'ru') => db.prepare('INSERT INTO users (email, password_hash, referral_code, locale) VALUES (?, ?, ?, ?)')
    .run(`k-${Math.random().toString(36).slice(2, 8)}@x.com`, 'x', 'R' + Math.random().toString(36).slice(2, 9).toUpperCase(), locale).lastInsertRowid;
  const H = (uid) => ({ Authorization: 'Bearer ' + authService._signAccessToken(uid) });
  const body = { exchange: 'bybit', apiKey: KEY, apiSecret: SEC };
  const keys = () => db.prepare('SELECT COUNT(*) AS n FROM exchange_keys').get().n;

  it('a withdrawal-capable key is refused and not stored (ru)', async () => {
    const uid = makeUser('ru');
    KP.setDefaultKeyPermissionChecker(checker({ body: bybitBody({ ...BYBIT_PERMS, Wallet: ['Withdraw'] }) }).c);
    const res = await request(app).post('/api/exchanges/keys').set(H(uid)).send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: KP.MESSAGES.withdraw.ru, code: 'KEY_CAN_WITHDRAW' });
    expect(keys()).toBe(0);
  });

  it('undeterminable permissions → 503 "try again" in the user language, nothing stored', async () => {
    const uid = makeUser('en');
    KP.setDefaultKeyPermissionChecker(checker({ status: 503, body: 'maintenance' }).c);
    const res = await request(app).post('/api/exchanges/keys').set(H(uid)).send(body);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: KP.MESSAGES.unknown.en, code: 'KEY_PERMISSIONS_UNVERIFIED' });
    expect(keys()).toBe(0);
  });

  it('with the default checker (no network in tests) every add is refused', async () => {
    const uid = makeUser();
    const res = await request(app).post('/api/exchanges/keys').set(H(uid)).send(body);
    expect(res.status).toBe(503);
    expect(keys()).toBe(0);
  });

  it('a trade-only key is stored (encrypted, masked in the answer)', async () => {
    const uid = makeUser();
    KP.setDefaultKeyPermissionChecker(checker({ body: bybitBody(BYBIT_PERMS) }).c);
    const res = await request(app).post('/api/exchanges/keys').set(H(uid)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.apiKeyMasked).toBe('••••6789');
    expect(JSON.stringify(res.body)).not.toContain(SEC);
    const row = db.prepare('SELECT api_key_encrypted, api_secret_encrypted FROM exchange_keys').get();
    expect(row.api_key_encrypted).not.toContain(KEY);
    expect(row.api_secret_encrypted).not.toContain(SEC);
  });
});
