/**
 * Decision D15 (docs/PORT_DECISIONS.md): a key the exchange itself says can withdraw is never
 * stored, and neither is a key whose permissions cannot be read (fail-closed, "try again").
 *
 *   • the four permission endpoints on recorded answers (fixture d15: the shapes the exchanges
 *     document — Bybit /v5/user/query-api, BingX /openApi/v1/account/apiPermissions, Binance
 *     /sapi/v1/account/apiRestrictions, OKX /api/v5/account/config) → ok / withdraw / unknown;
 *   • hostile / drifting shapes all read as `unknown` (never as `ok`);
 *   • the wire: each permission read is the request the bot's own signing code builds for that
 *     endpoint (fixture d15_wire: pybit get_api_key_information live + demo, bingx / okx `_request`,
 *     binance `_build_query`) — method, URL with the signed query, auth headers, byte for byte;
 *   • timeout / transport error / HTTP error → unknown; connectKeys refuses with the ru / en text,
 *     stores nothing, resets nothing, logs no secret.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
import { setupEnv, loadFixture, makeExchangeWorld, makeLog, insertUser, EXCHANGES } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('d15');

const FX = loadFixture();
let db; let ts; let keysSvc;

beforeAll(() => {
  db = nodeRequire('../../../models/database.js');
  ts = nodeRequire('../../../services/traderSettingsService.js');
  keysSvc = nodeRequire('../../../services/exchangeKeysService.js');
});

const route = (ex, kind, extra = {}) => ({ method: 'GET', path: FX.d15_path[ex], responses: [{ text: JSON.stringify(FX.d15[ex][kind]), ...extra }] });
const creds = (ex, demo = false) => {
  const [apiKey, apiSecret, passphrase] = FX.keys[ex];
  return { apiKey, apiSecret, passphrase, demo };
};
const MESSAGES = {
  withdraw: {
    ru: 'Ключ с правом вывода средств не принимается. Создайте на бирже новый API-ключ без права вывода (только торговля фьючерсами) и подключите его.',
    en: 'A key with withdrawal permission is not accepted. Create a new API key on the exchange without withdrawal permission (futures trading only) and connect it.',
  },
  unknown: {
    ru: 'Не удалось проверить права ключа на бирже — ключ не сохранён. Попробуйте ещё раз через минуту.',
    en: 'Could not check the key permissions on the exchange — the key was not saved. Try again in a minute.',
  },
};

describe('D15 — the permission endpoints on recorded answers', () => {
  for (const ex of EXCHANGES) {
    for (const kind of ['ok', 'withdraw', 'unknown']) {
      it(`${ex} ${kind}`, async () => {
        const w = makeExchangeWorld([route(ex, kind)], FX.now);
        const v = await keysSvc.checkWithdrawPermission(ex, creds(ex), { registry: w.registry });
        expect(v.verdict).toBe(kind);
        expect(w.router.log.length).toBe(1);
        expect(w.router.log[0].url.split('?')[0]).toBe(FX.d15_wire[ex][0].url.split('?')[0]);
      });
    }
  }

  it('the messages (ru / en) are the decision text', () => {
    expect(keysSvc.D15_MESSAGES).toEqual(MESSAGES);
  });
});

describe('D15 — the wire is what the bot\'s own signing code sends', () => {
  for (const ex of EXCHANGES) {
    const demos = ex === 'bybit' ? [false, true] : [false];
    for (const demo of demos) {
      it(`${ex}${demo ? ' (demo host)' : ''}`, async () => {
        const w = makeExchangeWorld([route(ex, 'ok')], FX.now);
        const v = await keysSvc.checkWithdrawPermission(ex, creds(ex, demo), { registry: w.registry });
        expect(v.verdict).toBe('ok');
        expect(w.router.log).toEqual([FX.d15_wire[ex][demo ? 1 : 0]]);
        expect(w.clock.sleeps).toEqual([]);
      });
    }
  }
});

describe('D15 — anything but a clear "no withdrawals" is unknown (fail-closed)', () => {
  const V = () => keysSvc._verdicts;
  const cases = [
    ['bybitVerdict', null], ['bybitVerdict', []], ['bybitVerdict', { retCode: '0', result: { permissions: {} } }],
    ['bybitVerdict', { retCode: 0 }], ['bybitVerdict', { retCode: 0, result: { permissions: [] } }],
    ['bybitVerdict', { retCode: 0, result: { permissions: { Wallet: 'Withdraw' } } }],
    ['bybitVerdict', { retCode: 0, result: { permissions: { Wallet: [1] } } }],
    ['bingxVerdict', { code: '0', data: { permissions: [1] } }], ['bingxVerdict', { code: 0, data: {} }],
    ['bingxVerdict', { code: 0, data: { permissions: '1,2' } }], ['bingxVerdict', { code: 0, data: { permissions: [null] } }],
    ['bingxVerdict', { code: 0, data: { permissions: [{ id: 5 }] } }],
    ['binanceVerdict', null], ['binanceVerdict', { enableWithdrawals: 'false' }], ['binanceVerdict', { enableWithdrawals: 0 }],
    ['binanceVerdict', { enableWithdrawals: null }], ['binanceVerdict', []],
    ['okxVerdict', { code: 0, data: [{ perm: 'read_only,trade' }] }], ['okxVerdict', { code: '0', data: [] }],
    ['okxVerdict', { code: '0', data: [{}] }], ['okxVerdict', { code: '0', data: [{ perm: ['trade'] }] }], ['okxVerdict', { code: '0', data: {} }],
  ];
  for (const [fn, resp] of cases) {
    it(`${fn} ${JSON.stringify(resp)} → unknown`, () => {
      expect(V()[fn](resp).verdict).toBe('unknown');
    });
  }
  const withdraws = [
    ['bybitVerdict', { retCode: 0, result: { permissions: { Spot: ['SpotTrade'], Wallet: ['withdraw'] } } }],
    ['bybitVerdict', { retCode: 0, result: { permissions: { Wallet: null, Exchange: ['ExchangeHistory', 'WITHDRAW'] } } }],
    ['bingxVerdict', { code: 0, data: { permissions: ['5'] } }], ['bingxVerdict', { code: 0, data: { permissions: [' 5 '] } }],
    ['bingxVerdict', { code: 0, data: { permissions: ['Withdraw'] } }],
    ['binanceVerdict', { enableWithdrawals: true }],
    ['okxVerdict', { code: '0', data: [{ perm: 'read_only, Withdraw ,trade' }] }],
  ];
  for (const [fn, resp] of withdraws) {
    it(`${fn} ${JSON.stringify(resp)} → withdraw`, () => {
      expect(V()[fn](resp).verdict).toBe('withdraw');
    });
  }
  it('a null permission group (Bybit) is no permission; 1/2/3/4 (BingX) are not withdraw', () => {
    expect(V().bybitVerdict({ retCode: 0, result: { permissions: { Wallet: null, ContractTrade: ['Order'] } } }).verdict).toBe('ok');
    expect(V().bingxVerdict({ code: 0, data: { permissions: [1, 2, 3, 4] } }).verdict).toBe('ok');
  });

  it('timeout → unknown without a request; a dead host / HTTP error → unknown', async () => {
    const w0 = makeExchangeWorld([route('bybit', 'ok')], FX.now);
    expect(await keysSvc.checkWithdrawPermission('bybit', creds('bybit'), { registry: w0.registry, permissionTimeoutS: 0 }))
      .toEqual({ verdict: 'unknown', reason: 'timeout' });
    expect(w0.router.log).toEqual([]);
    for (const ex of EXCHANGES) {
      const w1 = makeExchangeWorld([{ method: 'GET', path: FX.d15_path[ex], responses: [{ raise: 'connect' }] }], FX.now);
      expect((await keysSvc.checkWithdrawPermission(ex, creds(ex), { registry: w1.registry })).verdict, ex).toBe('unknown');
      // an HTTP error: Binance's answer has no success code, so only a 200 counts there; the other three
      // are read through the trader's own `_request` (the bot's signing) and judged by their success code
      const w2 = makeExchangeWorld([route(ex, ex === 'binance' ? 'ok' : 'unknown', { status: 500 })], FX.now);
      expect((await keysSvc.checkWithdrawPermission(ex, creds(ex), { registry: w2.registry })).verdict, `${ex} 500`).toBe('unknown');
      const w3 = makeExchangeWorld([{ method: 'GET', path: FX.d15_path[ex], responses: [{ text: '<html>maintenance</html>' }] }], FX.now);
      expect((await keysSvc.checkWithdrawPermission(ex, creds(ex), { registry: w3.registry })).verdict, `${ex} html`).toBe('unknown');
    }
    expect((await keysSvc.checkWithdrawPermission('kraken', creds('bybit'), {})).verdict).toBe('unknown');
  });
});

describe('D15 — connectKeys refuses, stores nothing, resets nothing', () => {
  let uid = 9100;
  for (const ex of EXCHANGES) {
    for (const kind of ['withdraw', 'unknown']) {
      for (const lang of ['ru', 'en']) {
        it(`${ex} ${kind} (${lang})`, async () => {
          uid += 1;
          insertUser(db, uid);
          const u = ts.getOrCreate(uid);
          Object.assign(u, { sub_plan: 'pro', sub_status: 'active', sub_expires: FX.now + 86400, lang, trade_exchange: 'bingx', auto_trade: true });
          ts.save(u);
          const step = FX.steps.find((s) => s.name === `keys ${ex} ok + D15 ${kind === 'withdraw' ? 'withdraw' : 'unreadable'}`);
          const w = makeExchangeWorld(step.routes, FX.now);
          const log = makeLog();
          const resets = [];
          keysSvc.configure({ resetAuthFailures: async (a, b) => { resets.push([a, b]); } });
          try {
            const [k, s, p] = FX.keys[ex];
            const r = await keysSvc.connectKeys(ts.getOrCreate(uid), ex, k, s, p, { registry: w.registry, log });
            expect(r.refused).toBe(kind);
            expect(r.body).toEqual({ ok: false, error: kind === 'withdraw' ? 'withdraw_permission' : 'permission_unknown', message: MESSAGES[kind][lang] });
            expect(db.prepare('SELECT COUNT(*) n FROM exchange_keys WHERE user_id=?').get(uid).n).toBe(0);
            const after = ts.get(uid);
            expect([after.trade_exchange, Boolean(after.auto_trade)]).toEqual(['bingx', true]);
            expect(resets).toEqual([]);
            expect(log.lines.some((l) => l.includes('refused (D15)'))).toBe(true);
            for (const l of log.lines) for (const sec of [s, p].filter(Boolean)) expect(l).not.toContain(sec);
            expect(JSON.stringify(r)).not.toContain(s);
            // the bot's own test calls first, then exactly one permission read
            expect(w.router.log.length).toBe(step.requests.length + 1);
            expect(w.router.log[w.router.log.length - 1].url.split('?')[0]).toBe(FX.d15_wire[ex][0].url.split('?')[0]);
          } finally {
            keysSvc.configure({ resetAuthFailures: null });
          }
        });
      }
    }
  }

  it('a key that tests OK and cannot withdraw is stored encrypted and resets the auth breaker', async () => {
    uid += 1;
    insertUser(db, uid);
    const u = ts.getOrCreate(uid);
    Object.assign(u, { sub_plan: 'pro', sub_status: 'active', sub_expires: FX.now + 86400 });
    ts.save(u);
    const step = FX.steps.find((s) => s.name === 'keys okx ok + D15 ok → saved');
    const w = makeExchangeWorld(step.routes, FX.now);
    const resets = [];
    keysSvc.configure({ resetAuthFailures: async (a, b) => { resets.push([a, b]); } });
    try {
      const [k, s, p] = FX.keys.okx;
      const r = await keysSvc.connectKeys(ts.getOrCreate(uid), 'okx', k, s, p, { registry: w.registry, log: makeLog() });
      expect(r.body).toEqual({ ok: true, exchange: 'okx', key_hint: 'OKKE…67', balance_usdt: 1000.5 });
      expect(keysSvc.exchangeKeys(uid, 'okx')).toEqual([k, s, p]);
      const row = db.prepare('SELECT * FROM exchange_keys WHERE user_id=?').get(uid);
      for (const col of ['api_key_encrypted', 'api_secret_encrypted', 'passphrase_encrypted']) {
        for (const plain of [k, s, p]) expect(String(row[col])).not.toContain(plain);
      }
      expect(resets).toEqual([[uid, 'okx']]);
      expect(ts.get(uid).trade_exchange).toBe('okx');
    } finally {
      keysSvc.configure({ resetAuthFailures: null });
    }
  });
});
