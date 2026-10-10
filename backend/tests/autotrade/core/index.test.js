/**
 * services/autotrade/index.js — the production wiring of execute_auto_trade:
 *   - D5 exchange set (AUTOTRADE_EXCHANGES, default bybit + bingx) and the worker's master switch;
 *   - the scanners' key read (exchange_keys, decrypted in memory, never logged), the balance read,
 *     the users-row merge (telegram username, OKX passphrase), the Bybit auth reset by key;
 *   - kwargs as the scanners pass them (SMC: no `bot`, an extra `user`), confirm-mode hand-off;
 *   - the start-up restore and the cache_gc entries (scheduler.cacheGcOnce order);
 *   - the D6 production switches against the bot vectors (executed=false on reject, fixed_amount %).
 * No network: traders are the harness fakes or never reached.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const req = createRequire(import.meta.url);
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-0123456789abcdef0123';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = process.env.WALLET_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-autotrade-index.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';

const AT = req('../../../services/autotrade/index.js');
const { loadFixture, buildEnv } = req('./harness.js');
const { replay, compare } = req('./replayCompare.js');

const FX = loadFixture();
const vec = (n) => {
  const v = FX.vectors.find((x) => x.case.name === n);
  if (!v) throw new Error(`no vector ${n}`);
  return v;
};
const clone = (o) => JSON.parse(JSON.stringify(o));

function capture() {
  const lines = [];
  const mk = (lvl) => (m) => lines.push([lvl, String(m)]);
  return { lines, log: { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), critical: mk('CRITICAL') } };
}

describe('D5 switches', () => {
  it('AUTOTRADE_EXCHANGES: default bybit + bingx; a list keeps only the four exchanges', () => {
    expect([...AT.enabledExchanges({})]).toEqual(['bybit', 'bingx']);
    expect([...AT.enabledExchanges({ AUTOTRADE_EXCHANGES: '  ' })]).toEqual(['bybit', 'bingx']);
    expect([...AT.enabledExchanges({ AUTOTRADE_EXCHANGES: 'bybit,OKX , kraken,binance' })]).toEqual(['bybit', 'okx', 'binance']);
    expect([...AT.enabledExchanges({ AUTOTRADE_EXCHANGES: 'none' })]).toEqual([]);
  });

  it('the worker master switch is AUTOTRADE_ENABLED=1 only', () => {
    expect(AT.autoTradeEnabled({})).toBe(false);
    expect(AT.autoTradeEnabled({ AUTOTRADE_ENABLED: '0' })).toBe(false);
    expect(AT.autoTradeEnabled({ AUTOTRADE_ENABLED: 'true' })).toBe(false);
    expect(AT.autoTradeEnabled({ AUTOTRADE_ENABLED: ' 1 ' })).toBe(true);
  });
});

describe('createAutoTrade — the entry point the scanners call', () => {
  it('confirm mode: the bot result (show_trade_btn) + the onConfirmPending hand-off, nothing placed', async () => {
    const v = vec('confirm_mode');
    const seen = [];
    const got = await replay(v, FX, { via: 'index', indexDeps: { onConfirmPending: async (info) => { seen.push(info); } } });
    expect(compare(v, got)).toEqual([]);
    expect(seen).toEqual([{ userId: 501, tradeId: 'T1', symbol: 'SOL-USDT-SWAP', direction: 'LONG', strategy: 'LEVELS', exchange: 'bybit' }]);
  });

  it('an exchange outside the D5 set: no trader call, no DB write, the "not placed" result', async () => {
    const v = vec('ok_okx');
    const env = buildEnv(v.case, FX, { via: 'index', indexDeps: { exchanges: ['bybit', 'bingx'] } });
    const before = env.dump();
    const results = await env.run();
    expect(results).toEqual([{ ok: { executed: false, show_trade_btn: false, limit_msg: null, skip_reason: 'exchange_not_enabled' } }]);
    expect(env.recs.filter((r) => r[1] === 'call')).toEqual([]);
    expect(env.recs.filter((r) => r[1] === 'msg')).toEqual([]);
    expect(env.dump()).toEqual(before);
    expect(env.recs.filter((r) => r[1] === 'log').map((r) => r[2])).toEqual([
      ['WARNING', '[AT-D5] uid=501 sym=SOL-USDT-SWAP exchange=okx is not enabled for auto-trade (AUTOTRADE_EXCHANGES) — not placed'],
    ]);
  });

  it('SMC kwargs (no bot, extra `user`): the default bot is used, `user` is dropped', async () => {
    const sent = [];
    const BOT = { name: 'facade' };
    const tdb = {
      getUser: async () => ({ user_id: 9, sub_plan: 'pro', auto_trade: 1 }),
      getUserLang: async () => 'ru',
      setTradeResult: async () => true,
      addTradeEvent: () => true,
      kvGet: async () => null, kvSet: async () => true, kvKeysWithPrefix: async () => [], kvItemsWithPrefix: async () => [],
      setAutoTrade: async () => true,
    };
    const at = AT.createAutoTrade({
      bot: BOT, env: {}, log: capture().log, tradeDb: tdb,
      killswitch: { requireActive: async () => {} }, isAdmin: () => false,
      exchangeSymbols: { isSymbolAvailable: () => true, recordSkip: () => {} },
      getUserRow: async () => ({ user_id: 9, auto_trade: 1, sub_plan: 'pro', lang: 'ru' }),
      trend: { ctxRiskMult: () => 0.0, ctxLabel: () => 'против сильного тренда' },
      sendMessage: async (bot, uid, text) => { sent.push([bot, uid, text.split('\n')[0]]); return true; },
      traderFor: () => { throw new Error('no trader may be reached'); },
    });
    const res = await at.executeAutoTrade({
      user_id: 9, symbol: 'ETH-USDT-SWAP', direction: 'SHORT', entry: 100, sl: 102, tp1: 97, tp2: 95, tp3: 93,
      trade_id: 'S1', api_key: 'K', api_secret: 'S', risk_pct: 1.0, leverage: 10, auto_trade_mode: 'auto',
      max_trades: 5, strategy: 'SMC', exchange: 'bybit', bybit_demo: false, entry_low: 99, entry_high: 101,
      quality: 7, trend_ctx: 'strong_counter', user: { user_id: 9, bybit_api_key: 'never-read' },
    });
    expect(res).toEqual({ executed: false, show_trade_btn: false, limit_msg: null, skip_reason: 'trend_ctx_skip' });
    expect(sent).toEqual([[BOT, 9, '⛔ <b>ETH SHORT</b> — против сильного тренда']]);
  });
});

describe('D6 production switches against the bot vectors', () => {
  const PROD = { executedOnReject: false, fixedAmountPercent: true };

  it('(a) an exchange reject reports executed=false; every other output is the bot one', async () => {
    const v = clone(vec('reject_generic'));
    expect(v.expected.results[0].ok.executed).toBe(true);    // the bot quirk
    const got = await replay(v, FX, { d6: PROD, via: 'index' });
    v.expected.results[0].ok.executed = false;
    expect(compare(v, got)).toEqual([]);
  });

  it('(d) fixed_amount is a percent of the balance (the bot: dollars / balance)', async () => {
    const v = vec('fixed_amount_ok');
    const riskOf = (recs) => recs.filter((r) => r[1] === 'call' && r[2][1] === 'place_trade').map((r) => r[2][2].risk_pct);
    // [FEE-AWARE-SIZE 2026-10] the trader sizes with the configured risk × the fee factor of the 2.0 %
    // stop from the improved Limit entry (99.95): d / (d + entry × 2 × 0.06 %) = 0.94206
    const feeLog = (recs) => recs.filter((r) => r[1] === 'log' && String(r[2][1]).startsWith('[FEE-AWARE-SIZE]')).map((r) => r[2][1]);
    expect(riskOf(v.expected.recs)).toEqual([9.4206]);        // bot: 50 / 500 × 100 = 10 %, × 0.94206
    expect(feeLog(v.expected.recs)).toEqual([expect.stringContaining('risk 10.0000% × factor 0.9421')]);
    const got = await replay(v, FX, { d6: PROD });
    expect(v.case.user_row.fixed_amount).toBe(50);
    expect(riskOf(got.recs)).toEqual([47.1028]);              // site: 50 %, × the same factor
    expect(feeLog(got.recs)).toEqual([expect.stringContaining('risk 50.0000% × factor 0.9421')]);
  });
});

describe('site sources: keys, users row, balance, auth reset, mutations (test DB)', () => {
  let db;
  let crypto;
  let config;
  let uid;
  let uid2;
  const KEY = 'BYBITKEY1234567';
  const SEC = 'BYBITSECRET7654321';
  const OKX_KEY = 'OKXKEY-AAAA-1111';
  const OKX_SEC = 'OKXSECRET-BBBB-2222';
  const OKX_PP = 'Pass-Phrase-99';

  beforeAll(() => {
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(process.env.DATABASE_PATH + ext); } catch (_e) { /* none */ } }
    db = req('../../../models/database.js');
    crypto = req('../../../utils/crypto.js');
    config = req('../../../config/index.js');
  });

  const enc = (s) => crypto.encrypt(s, config.walletEncryptionKey);
  const addKey = (u, ex, k, s, pp = null, label = null) => db.prepare(
    'INSERT INTO exchange_keys (user_id, exchange, api_key_encrypted, api_secret_encrypted, passphrase_encrypted, label) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(u, ex, enc(k), enc(s), pp ? enc(pp) : null, label).lastInsertRowid;
  const makeUser = (tg) => {
    const id = db.prepare('INSERT INTO users (email, password_hash, referral_code, telegram_username) VALUES (?, ?, ?, ?)')
      .run(`a-${Math.random().toString(36).slice(2, 8)}@x.com`, 'x', 'R' + Math.random().toString(36).slice(2, 9).toUpperCase(), tg).lastInsertRowid;
    db.prepare('INSERT INTO trader_settings (user_id, auto_trade, lang) VALUES (?, 1, ?)').run(id, 'en');
    return Number(id);
  };

  beforeEach(() => {
    for (const t of ['exchange_keys', 'trader_settings', 'audit_log', 'users']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM engine_kv WHERE key LIKE 'idemp_v1_%' OR key LIKE 'zb_cooldown_%'").run();
    uid = makeUser('tg_trader');
    uid2 = makeUser(null);
    addKey(uid, 'bybit', KEY, SEC, null, 'default');
    addKey(uid, 'okx', OKX_KEY, OKX_SEC, OKX_PP);
  });

  it('getApiKeys: the decrypted default key, D5-gated, unknown exchange → bybit, missing → null', () => {
    const cap = capture();
    const at = AT.createAutoTrade({ env: {}, log: cap.log });
    expect(at.getApiKeys({ user_id: uid }, 'bybit')).toEqual({ apiKey: KEY, apiSecret: SEC, passphrase: '' });
    expect(at.getApiKeys({ user_id: uid }, 'kraken')).toEqual({ apiKey: KEY, apiSecret: SEC, passphrase: '' });
    expect(at.getApiKeys({ user_id: uid }, 'okx')).toBe(null);       // OKX not in the D5 default set
    expect(at.getApiKeys({ user_id: uid }, 'bingx')).toBe(null);     // no key
    expect(at.getApiKeys({ user_id: uid2 }, 'bybit')).toBe(null);
    expect(at.getApiKeys(null, 'bybit')).toBe(null);
    const okx = AT.createAutoTrade({ env: { AUTOTRADE_EXCHANGES: 'okx' }, log: cap.log });
    expect(okx.getApiKeys({ user_id: uid }, 'okx')).toEqual({ apiKey: OKX_KEY, apiSecret: OKX_SEC, passphrase: OKX_PP });
    expect(okx.getApiKeys({ user_id: uid }, 'bybit')).toBe(null);
    // a key that does not decrypt (rotated WALLET_ENCRYPTION_KEY / tampering) → no keys, no trade
    db.prepare("UPDATE exchange_keys SET api_secret_encrypted = 'garbage' WHERE exchange = 'bybit'").run();
    expect(at.getApiKeys({ user_id: uid }, 'bybit')).toBe(null);
    const text = JSON.stringify(cap.lines);
    for (const s of [KEY, SEC, OKX_KEY, OKX_SEC, OKX_PP]) expect(text).not.toContain(s);
  });

  it('the users row: trader_settings + telegram username + the OKX passphrase', async () => {
    const at = AT.createAutoTrade({ env: {}, log: capture().log });
    const row = await at._parts.getUserRow(uid);
    expect(row.user_id).toBe(uid);
    expect(row.auto_trade).toBe(1);
    expect(row.lang).toBe('en');
    expect(row.username).toBe('tg_trader');
    expect(row.okx_passphrase).toBe(OKX_PP);
    const row2 = await at._parts.getUserRow(uid2);
    expect([row2.username, row2.okx_passphrase]).toEqual([null, '']);
    expect(await at._parts.getUserRow(999999)).toBe(null);
  });

  it('getBalance: the shared balance cache with the user key (bybit demo flag kept); D5-disabled → no key', async () => {
    const seen = [];
    const balanceCache = { getCachedBalance: async (view, ex) => { seen.push([view, ex]); return view[`${ex}_api_key`] ? 123.5 : null; } };
    const at = AT.createAutoTrade({ env: {}, log: capture().log, balanceCache });
    expect(await at.getBalance({ user_id: uid, bybit_demo: 1 }, 'bybit')).toBe(123.5);
    expect(await at.getBalance({ user_id: uid }, 'okx')).toBe(null);
    expect(seen).toEqual([
      [{ user_id: uid, bybit_demo: true, okx_passphrase: '', bybit_api_key: KEY, bybit_api_secret: SEC }, 'bybit'],
      [{ user_id: uid, bybit_demo: false, okx_passphrase: '' }, 'okx'],
    ]);
  });

  it('Bybit auth reset by key: every holder gets auto_trade=0, the uids come back', async () => {
    addKey(uid2, 'bybit', KEY, 'other-secret', null, 'default');
    const at = AT.createAutoTrade({ env: {}, log: capture().log, invalidateUserCache: () => {} });
    expect(await at._parts.onAuthReset('bybit', 'not-this-key')).toEqual([]);
    expect(await at._parts.onAuthReset('bybit', KEY)).toEqual([uid, uid2]);
    const flags = db.prepare('SELECT user_id, auto_trade FROM trader_settings ORDER BY user_id').all();
    expect(flags).toEqual([{ user_id: uid, auto_trade: 0 }, { user_id: uid2, auto_trade: 0 }]);
    expect(await at._parts.onAuthReset('bybit', '')).toEqual([]);
  });

  it('mutation_log → audit_log (no-op before == after skipped)', async () => {
    const at = AT.createAutoTrade({ env: {}, log: capture().log });
    expect(await at._parts.emitMutation('hour_filter_block', {
      actor: 'filter', target: 'SOL-USDT-SWAP', before: 'pass', after: 'blocked', context: { user_id: uid, hour_utc: 4 },
    })).toBe(true);
    expect(await at._parts.emitMutation('noop', { before: 'x', after: 'x' })).toBe(false);
    const rows = db.prepare('SELECT user_id, action, entity_type, metadata FROM audit_log').all();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ user_id: uid, action: 'hour_filter_block', entity_type: 'autotrade' });
    expect(JSON.parse(rows[0].metadata)).toEqual({ actor: 'filter', target: 'SOL-USDT-SWAP', before: 'pass', after: 'blocked', context: { user_id: uid, hour_utc: 4 } });
  });

  it('every auto-trade notice goes through safe_send as a "trade" notification', async () => {
    const calls = [];
    const bot = { sendMessage: async (u, t, kw) => { calls.push([u, t, kw]); return { message_id: 1 }; } };
    const at = AT.createAutoTrade({ env: {}, log: capture().log });
    expect(await at._parts.sendMessage(bot, uid, 'hello', { parseMode: 'HTML' })).toBe(true);
    expect(calls).toEqual([[uid, 'hello', { parseMode: 'HTML', site: { type: 'trade' } }]]);
  });

  it('restore(): live idempotency entries and future zero-balance cooldowns come back (bot.py log lines)', async () => {
    const now = 1_800_000_000;
    const kv = req('../../../services/engineKvService.js');
    kv.set('idemp_v1_live', JSON.stringify({ status: 'placed', ts: now - 30, order_id: 'O1' }));
    kv.set('idemp_v1_old', JSON.stringify({ status: 'placed', ts: now - 6000, order_id: 'O0' }));
    kv.set(`zb_cooldown_${uid}_bybit`, String(now + 600));
    kv.set(`zb_cooldown_${uid2}_bingx`, String(now - 1));
    const cap = capture();
    const at = AT.createAutoTrade({ env: {}, log: cap.log, now: () => now });
    expect(await at.restore()).toEqual({ idempotency: 1, zeroBalance: 1 });
    await at.drain();
    const info = cap.lines.filter((l) => l[0] === 'INFO').map((l) => l[1]);
    expect(info).toEqual([
      '[IDEMPOTENCY-RESTORE] restored=1 expired=1 (TTL=600s)',
      '[IDEMPOTENCY-RESTORE] restored 1 active entries from kv',
      '[C78] Zero-balance cooldowns restored from DB: 1',
      '💸 Zero-balance cooldowns restored: 1',
    ]);
    expect(at._parts.idempotency.registry.has('live')).toBe(true);
    expect(at._parts.cooldowns._zeroBalanceUntil.get(`${uid}|bybit`)).toBe(now + 600);
  });
});

describe('cache_gc entries', () => {
  it('the registries report what they freed; scheduler.cacheGcOnce keeps the bot key order', async () => {
    let t = 1_800_000_000;
    const at = AT.createAutoTrade({ env: {}, log: capture().log, now: () => t, tradeDb: {
      kvGet: async () => null, kvSet: async () => true, kvKeysWithPrefix: async () => [], kvItemsWithPrefix: async () => [],
    } });
    const today = Math.floor(t / 86400) + 719163;
    at._exec._disabledDaysNotified.set(`5|${today - 3}`, true);
    at._exec._disabledDaysNotified.set(`5|${today}`, true);
    at._parts.skipNotify._userUnfilled.set(5, [t - 7200]);
    at._parts.skipNotify._lastNotified.set(6, t - 8 * 86400);
    at._parts.idempotency.registry.set('k1', { status: 'placed', ts: t - 700, order_id: '' });
    at._parts.cooldowns._zeroBalanceUntil.set('5|bybit', t - 1);
    expect(at.gc.disabledDays(t)).toBe(1);
    expect([...at._exec._disabledDaysNotified.keys()]).toEqual([`5|${today}`]);
    expect(at.gc.skipNotify()).toEqual({ userUnfilled: 1, lastNotified: 1 });
    expect(at.gc.tradeLocks()).toBe(0);

    const SCH = req('../../../services/engine/scheduler.js');
    const fake = {
      tradeLocks: () => 2, idempotency: () => 3, authFail: () => 4, zeroBalance: () => 5, commodity: () => 6,
      disabledDays: () => 7, correlation: () => 8, tilt: () => 9, skipNotify: () => ({ userUnfilled: 10, lastNotified: 11 }),
    };
    const freed = SCH.cacheGcOnce({
      now: () => t, log: capture().log, smcInstance: () => null,
      scanners: { loadModule: () => ({ gcSent: () => 1 }) },
      confluence: () => ({ gcRecent: () => 0 }), balanceCache: () => ({ gcCache: () => 12 }),
      freeReport: () => ({ previewSent: new Map() }), autoTrade: { gc: fake },
    });
    expect(Object.keys(freed)).toEqual([
      'auto_trade._trade_locks', 'volume_scanner._sent_bars', 'auto_trade._idempotency', 'auto_trade._auth_fail',
      'auto_trade._zero_balance', 'auto_trade._commodity_blocklist', 'auto_trade._disabled_days_notified',
      'correlation_cap._CORR_CACHE', 'tilt_detector._NOTIFY_DEDUP', 'balance_cache._BALANCE_CACHE',
      'skip_notify._user_unfilled', 'skip_notify._last_notified',
    ]);
    // the real registries through the same path
    t += 1;
    const real = SCH.cacheGcOnce({
      now: () => t, log: capture().log, smcInstance: () => null, scanners: { loadModule: () => null },
      confluence: () => ({ gcRecent: () => 0 }), balanceCache: () => ({ gcCache: () => 0 }),
      freeReport: () => ({ previewSent: new Map() }), autoTrade: at,
    });
    expect(real).toEqual({ 'auto_trade._idempotency': 1, 'auto_trade._zero_balance': 1 });
    await at.drain();
  });
});

describe('engine worker wiring', () => {
  it('no AUTOTRADE_ENABLED → no executor (scanners see no keys); =1 → built and restored', async () => {
    const W = req('../../../workers/engineWorker.js');
    expect(await W.workerAutoTrade({}, {})).toBe(null);
    expect(await W.workerAutoTrade({}, { AUTOTRADE_ENABLED: '0' })).toBe(null);
    const inst = await W.workerAutoTrade({ alertAdmins: async () => 0 }, { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bingx' });
    expect(inst).not.toBe(null);
    expect(inst.exchanges()).toEqual(['bingx']);
    expect(typeof inst.executeAutoTrade).toBe('function');
    expect(inst.getApiKeys({ user_id: 1 }, 'bybit')).toBe(null);
  });

  it('runWorker: one scheduler even when two starts race the auto-trade restore; the scanners get its hooks', async () => {
    const W = req('../../../workers/engineWorker.js');
    const { MessageChannel } = req('worker_threads');
    const ch = new MessageChannel();
    const seen = [];
    ch.port2.on('message', (m) => seen.push(m));
    const cache = { getCache: () => ({}), initCache: () => {}, getCandles: () => null, getCoins: () => null };
    const w = W.runWorker(ch.port1, {
      logs: false,
      deps: {
        log: capture().log, cache, fetcher: {}, registry: { forceSave: () => 0 },
        exchangeSymbols: { startBackgroundRefresh: async () => ({ stop() {} }), getStats: () => ({}) },
        env: { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bybit' },
        // [M15-LOOPS-REQUIRED]: the executor runs only with every trade loop wired
        tradeLoopsDeps: { passes: {
          beMonitorLoop: async () => {}, reconcileOnce: async () => {}, cleanupPass: async () => {}, runOnce: async () => {},
          checkSingleTrade: async () => {}, getOpenTradesAll: () => [], sweepOneUser: async () => {}, getAllUsers: () => [],
        } },
      },
    });
    ch.port2.postMessage({ type: 'start', options: { only: [] } });
    ch.port2.postMessage({ type: 'start', options: { only: [] } });
    for (let i = 0; i < 200 && !seen.some((m) => m.type === 'ready'); i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(seen.filter((m) => m.type === 'ready').length).toBe(1);
    expect(seen.filter((m) => m.type === 'fatal')).toEqual([]);
    const ctx = w.scheduler().ctx;
    expect(ctx.autoTrade.exchanges()).toEqual(['bybit']);
    const sd = ctx.scannerDeps('LEVELS');
    expect(sd.executeAutoTrade).toBe(ctx.autoTrade.executeAutoTrade);
    expect(sd.getApiKeys).toBe(ctx.autoTrade.getApiKeys);
    await w.stop();
    ch.port1.close();
    ch.port2.close();
  });
});
