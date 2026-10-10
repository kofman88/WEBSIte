/**
 * PLAN_M15 U1 — the foundation pieces against the bot's own outputs (fixtures/m15_units.json.gz of
 * py/gen_m15_units.py, bot HEAD 1a47ffc):
 *   computeFallbackPnlUsd = db/trades.compute_fallback_pnl_usd (table + 300 random rows, bit for bit)
 *   tradeDb readers on a site DB seeded with the rows the bot DB holds = db_get_open_trades_all,
 *     db_get_all_stale_open_trades ([GHOST-LIVE-TRADES]), db_get_user, db_get_all_users,
 *     user_manager.get_active_auto_trade_users (same rows, same order, same query plans, same log lines)
 *     — and its retry back-off as a cancellation point (wait_for timeout / task.cancel() during the
 *     1 s / 2 s sleep: the same outcome at the same instant, no further query)
 *   D5 key gating of those readers (site-only), the exchange_keys row choice
 *   adminAlerts.alertBeMonitorCrash = admin_alerts.alert_be_monitor_crash (texts, dedup, kv value)
 *   messages.t over the M15 keys = i18n.t (the gen_messages.py round trip)
 *   traders.js METHODS / the trader instances vs the bot traders' M15 functions (presence, arity, sync)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const H = req('./harness.js');
const site = H.setupSiteDb('units');
const FX = H.loadFixture('m15_units');
const R = FX.readers;

const { computeFallbackPnlUsd: repoPnl } = req('../../../services/engine/signalTradesRepo.js');
const TDB = req('../../../services/autotrade/tradeDb.js');
const asyncio = req('../../../services/autotrade/asyncio.js');
const { createAdminAlerts, ALERT_DEDUP_TTL, DEFAULT_TTL } = req('../../../services/autotrade/adminAlerts.js');
const messages = req('../../../services/autotrade/messages.js');
const { F } = req('../../../services/autotrade/pyfmt.js');
const traders = req('../../../services/autotrade/traders.js');
const { createRegistry } = req('../../../services/exchanges/index.js');
const { toSiteArgs, M15_FNS } = req('../../exchanges/callMaps.js');
const schema = req('../../../models/engineSchema.js');

const ALL = ['bybit', 'bingx', 'binance', 'okx'];
const KEY_COLS = ['bybit_api_key', 'bybit_api_secret', 'bingx_api_key', 'bingx_api_secret', 'binance_api_key', 'binance_api_secret',
  'okx_api_key', 'okx_api_secret', 'okx_passphrase'];
const TS_COLS = new Set(['user_id', ...schema.TRADER_SETTINGS_COLUMNS.map((c) => c[0])]);
const db = site.db;
let log;
let tdb;

const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Object.is(a, b) || a === b : JSON.stringify(a) === JSON.stringify(b));

beforeAll(() => {
  H.seedSite(db, { usersRaw: R.users_raw, users: R.users, sitePlain: R.site_plain, trades: R.trades });
  log = H.makeLogCapture();
  tdb = TDB.createTradeDb({ db, now: () => R.now, log, exchanges: ALL, invalidateUserCache: () => {} });
});
afterAll(() => site.cleanup());

describe('computeFallbackPnlUsd = db/trades.compute_fallback_pnl_usd', () => {
  it(`${FX.fallback_pnl.length} rows bit for bit (signalTradesRepo export, re-exported by tradeDb)`, () => {
    expect(TDB.computeFallbackPnlUsd).toBe(repoPnl);
    expect(TDB.createTradeDb({ db }).computeFallbackPnlUsd).toBe(repoPnl);
    const bad = [];
    for (const [args, want] of FX.fallback_pnl) {
      const got = repoPnl(...args);
      const ok = want === null ? got === null : (typeof got === 'number' && (Object.is(got, want) || (Number.isNaN(want) && Number.isNaN(got))));
      if (!ok) bad.push({ args, want, got });
    }
    expect(bad).toEqual([]);
    expect(FX.fallback_pnl.length).toBeGreaterThan(340);
  });
  it('covers None / ≤ 0 / NaN / non-numeric / both directions', () => {
    const outs = FX.fallback_pnl.map((r) => r[1]);
    expect(outs.filter((v) => v === null).length).toBeGreaterThan(20);
    expect(outs.some((v) => typeof v === 'number' && Number.isNaN(v))).toBe(true);
    expect(outs.some((v) => typeof v === 'number' && v < 0)).toBe(true);
  });
});

describe('tradeDb readers = the bot readers on the same rows', () => {
  const PLAN_MAP = [[/\btrades\b/g, 'signal_trades'], [/\busers\b/g, 'trader_settings'], [/idx_trades_/g, 'idx_signal_trades_'],
    [/idx_users_/g, 'idx_trader_settings_']];
  const sitePlan = (sql, ...p) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...p).map((r) => r.detail);
  const botPlan = (lines) => lines.map((l) => PLAN_MAP.reduce((s, [re, to]) => s.replace(re, to), l));

  it('the same query plans (row order without ORDER BY comes from the plan)', () => {
    expect(sitePlan(TDB.OPEN_TRADES_ALL_SQL)).toEqual(botPlan(R.plans.open_all));
    expect(sitePlan(TDB.STALE_OPEN_TRADES_SQL, R.now)).toEqual(botPlan(R.plans.stale));
    expect(sitePlan(TDB.ALL_USERS_SQL)).toEqual(botPlan(R.plans.all_users));
    expect(sitePlan(TDB.ACTIVE_USERS_SQL, R.now)).toEqual(botPlan(R.plans.active_users));
    expect(R.plans.open_all[0]).toContain('idx_trades_open_orders');
  });

  it('getOpenTradesAll = db_get_open_trades_all: 500 of 501 open exchange rows, same rows in the same order', async () => {
    log.take();
    const rows = await tdb.getOpenTradesAll();
    // 501 random-order rows + two [GHOST-LIVE-TRADES] rows older than 72 h: three fall past LIMIT 500
    expect(R.trades.filter((t) => t.result === '' && t.order_id).length).toBe(503);
    expect(rows.length).toBe(500);
    expect(rows.map((r) => r.trade_id)).toEqual(R.open_all.map((r) => r.trade_id));
    // the full rows (both schemas have the same 55 columns)
    expect(Object.keys(rows[0]).sort()).toEqual(Object.keys(R.open_all[0]).sort());
    const diffs = rows.map((r, i) => H.firstDiff(r, R.open_all[i])).filter(Boolean);
    expect(diffs).toEqual([]);
    expect(log.at('WARNING')).toEqual(R.logs.open_all);
  });

  it('getAllStaleOpenTrades = db_get_all_stale_open_trades with [GHOST-LIVE-TRADES]: only rows without an order', async () => {
    for (const [cutoff, want] of R.stale) {
      const rows = await tdb.getAllStaleOpenTrades(cutoff);
      expect(rows.map((r) => r.trade_id), `cutoff ${cutoff}`).toEqual(want.map((r) => r.trade_id));
      expect(rows.map((r, i) => H.firstDiff(r, want[i])).filter(Boolean)).toEqual([]);
      expect(rows.some((r) => r.order_id)).toBe(false);
    }
    const ids = R.stale[0][1].map((r) => r.trade_id);
    expect(ids).not.toContain('g-live-4d');
    expect(ids).not.toContain('g-live-40d');
    expect(ids).not.toContain('s-edge');           // created_at == cutoff: strict <
    expect(R.stale[1][1].map((r) => r.trade_id)).toContain('s-edge');
  });

  const TS_DEFAULT = new Map(schema.TRADER_SETTINGS_COLUMNS.map(([n, type, d]) => [n, type === 'TEXT' ? d.slice(1, -1) : Number(d)]));
  const compareUserRow = (got, want, uid) => {
    // the bot's users row vs the site's trader_settings row + username + keys: the shared columns
    const out = [];
    for (const k of Object.keys(want)) {
      if (!(TS_COLS.has(k) || KEY_COLS.includes(k) || k === 'username')) continue;
      let w = want[k];
      // a bot NULL where the site column is NOT NULL holds the site default (518's auto_trade); a NULL
      // username (users.telegram_username unset) reads as '' — see the README deviations
      if (w === null && TS_DEFAULT.has(k)) w = TS_DEFAULT.get(k);
      if (k === 'username' && w === null) w = '';
      if (!same(got[k], w)) out.push(`${uid}.${k}: site ${JSON.stringify(got[k])} bot ${JSON.stringify(w)}`);
    }
    return out;
  };

  it('getUserWithKeys = db_get_user: every column, the nine decrypted key columns, username, missing → null', async () => {
    const bad = [];
    for (const [uid, want] of Object.entries(R.get_user)) {
      log.take();
      const got = await tdb.getUserWithKeys(Number(uid));
      if (want === null) {
        if (got !== null) bad.push(`${uid}: site row, bot None`);
        continue;
      }
      bad.push(...compareUserRow(got, want, uid));
      for (const k of KEY_COLS) if (!(k in got)) bad.push(`${uid}: no ${k}`);
      const lines = log.at('WARNING');
      if (JSON.stringify(lines) !== JSON.stringify(R.logs.get_user[uid])) bad.push(`${uid} logs ${JSON.stringify(lines)}`);
    }
    expect(bad).toEqual([]);
    // the cases the vectors exist for
    const g = R.get_user;
    expect(g['514'].bingx_api_key).toBe('');            // undecryptable → '' (+ the bot's ERROR)
    expect(g['514'].bingx_api_secret).toBe('BXS-bbbb-2222');
    expect(g['513'].bybit_api_secret).toBe('');         // key without secret
    expect(g['539'].bybit_api_key).toBe('PLAIN-OLD-KEY-6666');
    expect(g['505'].okx_passphrase).toBe('');
    expect(g['504'].okx_passphrase).toBe('OK-pass#4444');
    expect(g['536'].username).toBe(null);                // bot NULL username; the site reads ''
    expect((await tdb.getUserWithKeys(536)).username).toBe('');
  });

  it('getAllUsersOrdered = db_get_all_users: ORDER BY created_at DESC (ties in the bot order), rows with keys', async () => {
    log.take();
    const got = await tdb.getAllUsersOrdered();
    expect(got.map((u) => u.user_id)).toEqual(R.all_users.map((u) => u.user_id));
    const bad = got.flatMap((u, i) => compareUserRow(u, R.all_users[i], u.user_id));
    expect(bad).toEqual([]);
    expect(log.at('WARNING')).toEqual(R.logs.all_users);
  });

  it('getActiveAutoTradeUsers = get_active_auto_trade_users: same users, same order, same UserSettings fields', async () => {
    log.take();
    const got = await tdb.getActiveAutoTradeUsers();
    expect(got.map((u) => u.user_id)).toEqual(R.active.map((u) => u.user_id));
    const bad = [];
    got.forEach((u, i) => {
      const w = R.active[i];
      for (const k of Object.keys(w)) {
        if (!(k in u)) continue;          // UserSettings fields the site does not keep (dead columns)
        if (!same(u[k], w[k])) bad.push(`${u.user_id}.${k}: site ${JSON.stringify(u[k])} bot ${JSON.stringify(w[k])}`);
      }
      for (const k of [...KEY_COLS, 'username', 'trade_exchange', 'auto_trade', 'lang', 'bybit_demo', 'sub_plan']) if (!(k in u)) bad.push(`${u.user_id}: no ${k}`);
    });
    expect(bad).toEqual([]);
    expect(log.at('WARNING')).toEqual(R.logs.active);
    // what the selection rests on
    const ids = got.map((u) => u.user_id);
    for (const uid of [517, 518, 519, 520, 521]) expect(ids).not.toContain(uid);    // auto_trade 0 / NULL / '' / '0' / 0.0
    for (const uid of [522, 523, 524]) expect(ids).toContain(uid);                  // 'false' / 2 / ' ' are truthy
    for (const uid of [507, 510, 511, 512]) expect(ids).not.toContain(uid);         // fallback to the (missing) bybit key
    for (const uid of [506, 508, 509, 513, 515]) expect(ids).toContain(uid);        // fallback key / key-only / secret undecryptable
    for (const uid of [526, 528, 530, 533]) expect(ids).not.toContain(uid);         // lapsed plan / status / all toggles off
  });

  it('getActiveAutoTradeUsers: the 3-attempt retry of db_get_active_users (WARNING + 1 s / 2 s sleeps, 3rd error raises)', async () => {
    const sleeps = [];
    let n = 0;
    const flaky = { prepare: (q) => { if (q === TDB.ACTIVE_USERS_SQL && n++ < 2) throw new Error('database is locked'); return db.prepare(q); } };
    const l2 = H.makeLogCapture();
    const t2 = TDB.createTradeDb({ db: flaky, now: () => R.now, log: l2, exchanges: ALL, sleep: async (s) => { sleeps.push(s); } });
    const got = await t2.getActiveAutoTradeUsers();
    expect(got.map((u) => u.user_id)).toEqual(R.active.map((u) => u.user_id));
    expect(sleeps).toEqual([1, 2]);
    expect(l2.at('WARNING').filter(([lv]) => lv === 'WARNING')).toEqual([
      ['WARNING', 'db_get_active_users retry 1/3: database is locked'], ['WARNING', 'db_get_active_users retry 2/3: database is locked']]);
    const dead = { prepare: (q) => { if (q === TDB.ACTIVE_USERS_SQL) throw new Error('disk I/O error'); return db.prepare(q); } };
    const t3 = TDB.createTradeDb({ db: dead, now: () => R.now, log: H.makeLogCapture(), exchanges: ALL, sleep: async () => {} });
    await expect(t3.getActiveAutoTradeUsers()).rejects.toThrow('disk I/O error');
  });

  /** A site DB whose ACTIVE_USERS_SQL always fails like the bot's patched `_read_conn` (SQLITE_BUSY). */
  const lockedDb = (onQuery) => ({ prepare: (q) => { if (q === TDB.ACTIVE_USERS_SQL) { onQuery(); throw new Error('database is locked'); } return db.prepare(q); } });

  for (const c of FX.active_retry) {
    const label = `${c.mode}${c.at === null ? '' : ` ${c.at} s`}: ${c.outcome[0]} at +${c.elapsed} s after ${c.queries.length} quer${c.queries.length === 1 ? 'y' : 'ies'}`;
    it(`the retry back-off is a cancellation point = the bot — ${label}`, async () => {
      const clk = H.createVClock(R.now, 1000);
      const t0 = clk.mono();
      const queries = [];
      const l2 = H.makeLogCapture();
      // clk.sleep is the virtual clock's PLAIN sleep (it does not honour the cancel scope itself): the reader
      // must make its back-off a cancellation point on its own, as the bot's `await asyncio.sleep(1 + attempt)`
      const t2 = TDB.createTradeDb({ db: lockedDb(() => queries.push(clk.mono() - t0)), now: () => R.now, log: l2, exchanges: ALL, sleep: clk.sleep });
      const read = () => asyncio.runAsTask('be_pass', () => t2.getActiveAutoTradeUsers());
      let outcome = null;
      let elapsed = null;
      await clk.run((async () => {
        try {
          if (c.mode === 'plain') await read();
          else if (c.mode === 'wait_for') await asyncio.waitFor(read, c.at, { timers: clk.timers });
          else {
            const ctrl = new AbortController();
            const task = asyncio.runInScope(ctrl.signal, read);    // the BE pass task; task.cancel() = abort
            task.catch(() => {});
            await clk.sleep(c.at);
            ctrl.abort();
            await task;
          }
          outcome = ['ok'];
        } catch (e) {
          if (asyncio.isCancelledError(e)) outcome = ['CancelledError'];
          else if (asyncio.isTimeoutError(e)) outcome = ['TimeoutError'];
          else outcome = ['error', e.message];
        }
        elapsed = clk.mono() - t0;
        await clk.sleep(10);               // nothing happens afterwards: no late query, no late log line
      })());
      // a DB error: the bot's sqlite3.OperationalError, the site's SqliteError — the same text
      expect(outcome).toEqual(c.outcome.length === 2 ? ['error', c.outcome[1]] : c.outcome);
      expect(elapsed).toBe(c.elapsed);
      expect(queries).toEqual(c.queries);
      expect(l2.at('WARNING')).toEqual(c.logs);
    });
  }

  it('the default sleep (real timers) is a cancellation point too: waitFor / abort end it at once, one query', async () => {
    for (const how of ['wait_for', 'abort']) {
      let n = 0;
      const t2 = TDB.createTradeDb({ db: lockedDb(() => { n += 1; }), now: () => R.now, log: H.makeLogCapture(), exchanges: ALL });
      const started = Date.now();
      let err = null;
      if (how === 'wait_for') {
        await asyncio.waitFor(() => t2.getActiveAutoTradeUsers(), 0.05).catch((e) => { err = e; });
        expect(asyncio.isTimeoutError(err)).toBe(true);
      } else {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 50);
        await asyncio.runInScope(ctrl.signal, () => t2.getActiveAutoTradeUsers()).catch((e) => { err = e; });
        expect(asyncio.isCancelledError(err)).toBe(true);
      }
      expect(Date.now() - started).toBeLessThan(900);      // not after the 1 s back-off
      expect(n).toBe(1);
      await new Promise((r) => setTimeout(r, 1100));       // the abandoned back-off never runs a 2nd query
      expect(n).toBe(1);
    }
  }, 15000);
});

describe('D5 key gating and the exchange_keys row choice (site-only)', () => {
  it('an exchange outside AUTOTRADE_EXCHANGES reads as no keys in every reader', async () => {
    const l2 = H.makeLogCapture();
    const t2 = TDB.createTradeDb({ db, now: () => R.now, log: l2, exchanges: ['bybit', 'bingx'] });
    const u = await t2.getUserWithKeys(516);
    expect([u.bybit_api_key, u.bingx_api_key, u.binance_api_key, u.okx_api_key, u.okx_passphrase])
      .toEqual(['BYK-AAAA-1111', 'BXK-BBBB-2222', '', '', '']);
    const active = (await t2.getActiveAutoTradeUsers()).map((x) => x.user_id);
    const want = R.active.filter((x) => x.trade_exchange !== 'binance' && x.trade_exchange !== 'okx').map((x) => x.user_id);
    expect(active).toEqual(want);
    expect(l2.at('ERROR').length).toBe(1);   // 514's bingx key; 515's OKX secret is not read
  });

  it('default: the AUTOTRADE_EXCHANGES env (index.enabledExchanges)', async () => {
    const t2 = TDB.createTradeDb({ db, now: () => R.now, log: H.makeLogCapture(), env: { AUTOTRADE_EXCHANGES: 'okx' } });
    const u = await t2.getUserWithKeys(516);
    expect([u.bybit_api_key, u.okx_api_key, u.okx_passphrase]).toEqual(['', 'OKK-DDDD-4444', 'OK-pass#4444']);
    const t3 = TDB.createTradeDb({ db, now: () => R.now, log: H.makeLogCapture(), env: {} });
    const v = await t3.getUserWithKeys(516);
    expect([v.bybit_api_key, v.bingx_api_key, v.binance_api_key, v.okx_api_key]).toEqual(['BYK-AAAA-1111', 'BXK-BBBB-2222', '', '']);
  });

  it("several exchange_keys rows: 'default' label first, then the newest (appSettingsService.exchangeKeys)", async () => {
    H.insertSiteUser(db, 7701);
    db.prepare('INSERT INTO trader_settings (user_id) VALUES (?)').run(7701);
    H.insertSiteKey(db, 7701, 'bybit', 'OLD-K', 'OLD-S', '', { label: 'old', createdAt: '2026-01-01 00:00:00' });
    H.insertSiteKey(db, 7701, 'bybit', 'NEW-K', 'NEW-S', '', { label: 'new', createdAt: '2026-02-01 00:00:00' });
    expect((await tdb.getUserWithKeys(7701)).bybit_api_key).toBe('NEW-K');
    H.insertSiteKey(db, 7701, 'bybit', 'DEF-K', 'DEF-S', '', { label: 'default', createdAt: '2025-01-01 00:00:00' });
    expect((await tdb.getUserWithKeys(7701)).bybit_api_key).toBe('DEF-K');
    expect(TDB.exchangeKeysReader(() => db, { log: H.makeLogCapture() })(7701, 'bybit')).toEqual(['DEF-K', 'DEF-S', '']);
  });
});

describe('alertBeMonitorCrash = admin_alerts.alert_be_monitor_crash', () => {
  it('texts, the 6 h dedup and the stored kv value step by step', async () => {
    let wall = 0;
    const kv = new Map();
    const alerts = createAdminAlerts({
      now: () => wall, kvGet: async (k) => (kv.has(k) ? kv.get(k) : null), kvSet: async (k, v) => { kv.set(k, v); },
      adminIds: async () => [123], log: H.makeLogCapture(),
    });
    const D = H.makeDeliveryRecorder();
    for (const st of FX.alert.steps) {
      wall = st.wall;
      const bot = st.name === 'no_bot' ? null : D.bot;
      if (st.last_error === null) await alerts.alertBeMonitorCrash(bot, st.streak);
      else await alerts.alertBeMonitorCrash(bot, st.streak, st.last_error);
      const sent = D.take().map((m) => ({ via: m.via, uid: m.uid, text: m.text, kw: m.kw }));
      expect(sent, st.name).toEqual(st.sent.map((m) => ({ via: m.via, uid: m.uid, text: m.text, kw: m.kw })));
      expect(kv.get('adm_alert_be_monitor_crash_global') || null, st.name).toBe(st.kv);
    }
    expect(FX.alert.steps.filter((s) => s.sent.length).length).toBe(6);
  });
  it('the dedup TTL table is the bot one', () => {
    expect({ ...ALERT_DEDUP_TTL }).toEqual(FX.alert.ttl);
    expect(DEFAULT_TTL).toBe(FX.alert.default_ttl);
  });
});

describe('messages.t over the M15 keys = i18n.t (gen_messages.py → messagesData.json round trip)', () => {
  it('gen_messages.py KEYS = messagesData.json keys, and every M15 key is in both', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'tests', 'autotrade', 'core', 'gen', 'gen_messages.py'), 'utf8');
    const block = src.slice(src.indexOf('KEYS = ['), src.indexOf(']', src.indexOf('KEYS = [')));
    const keys = Array.from(block.matchAll(/"([a-z0-9_]+)"/g)).map((m) => m[1]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(messages.MESSAGES).sort()).toEqual([...keys].sort());
    for (const k of FX.i18n.keys) {
      expect(keys).toContain(k);
      expect(Object.keys(messages.MESSAGES[k]).sort()).toEqual(['en', 'ru']);
    }
  });
  it(`${FX.i18n.rows.length} renderings byte for byte (both languages, fallbacks, format errors)`, () => {
    const bad = [];
    for (const [key, lang, kw, floatKeys, want] of FX.i18n.rows) {
      const kwargs = {};
      for (const [k, v] of Object.entries(kw)) kwargs[k] = floatKeys.includes(k) ? F(v) : v;
      const got = messages.t(key, lang, kwargs);
      if (got !== want) bad.push({ key, lang, kw, got, want });
    }
    expect(bad).toEqual([]);
  });
});

describe('trader methods: traders.js METHODS and the instances vs the bot traders (PLAN_M15 §5)', () => {
  const reg = createRegistry({});
  const params = (fn) => {
    const s = fn.toString();
    const open = s.indexOf('(');
    let depth = 0;
    let cur = '';
    const out = [];
    for (let i = open + 1; i < s.length; i++) {
      const c = s[i];
      if (depth === 0 && c === ')') { if (cur.trim()) out.push(cur.trim()); break; }
      if ('({['.includes(c)) depth++;
      if (')}]'.includes(c)) depth--;
      if (depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    return out;
  };
  const camel = (f) => f.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());

  it('every M15 function exists on exactly the site instances whose bot module has it, with the bot arity', () => {
    const bad = [];
    for (const ex of ALL) {
      const inst = reg(ex, false);
      for (const fn of M15_FNS) {
        const bot = FX.sigs[ex][fn];
        const js = inst[camel(fn)];
        if (!bot) {
          if (typeof js === 'function') bad.push(`${ex}.${fn}: site has it, the bot does not`);
          continue;
        }
        if (typeof js !== 'function') { bad.push(`${ex}.${fn}: missing on the site`); continue; }
        const pos = bot.sig.filter((p) => p[1] === 'POSITIONAL_OR_KEYWORD' || p[1] === 'POSITIONAL_ONLY').length;
        const kwOnly = bot.sig.filter((p) => p[1] === 'KEYWORD_ONLY').length;
        const jsp = params(js);
        const want = pos + (kwOnly ? 1 : 0);
        if (jsp.length !== want) bad.push(`${ex}.${fn}: site params ${jsp.join(', ')} vs bot ${pos} positional + ${kwOnly} keyword-only`);
        if (kwOnly && !/^(opts|\{)/.test(jsp[jsp.length - 1])) bad.push(`${ex}.${fn}: last site param ${jsp[jsp.length - 1]} is not the options object`);
        const isAsync = js.constructor.name === 'AsyncFunction';
        if (isAsync !== bot.async) bad.push(`${ex}.${fn}: async ${isAsync} vs bot ${bot.async}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('METHODS carries the M15 methods; a handle has a method only when its instance does', () => {
    for (const m of ['getExecutionExitPrice', 'cancelTpOrdersOnly', 'getAlgoSlOrders', 'closePositionPartial', 'isDelisted', 'cancelTpOrders']) {
      expect(traders.METHODS).toContain(m);
    }
    for (const ex of ALL) {
      const inst = reg(ex, false);
      const h = traders.makeHandle(ex, inst);
      for (const m of traders.METHODS) {
        expect(typeof h[m], `${ex}.${m}`).toBe(typeof inst[m] === 'function' ? 'function' : 'undefined');
      }
    }
    const by = traders.makeHandle('bybit', reg('bybit', false));
    expect(by.isDelisted('BTCUSDT')).toBe(false);              // synchronous on the shared instance, like the bot
    expect(by.cancelTpOrdersOnly).toBeUndefined();
    expect(traders.makeHandle('okx', reg('okx', false)).cancelTpOrders).toBeTypeOf('function');
    // a handle on an instance without the method keeps working for the others
    const partial = traders.makeHandle('bingx', { getPositions: async () => [] });
    expect(partial.cancelTpOrdersOnly).toBeUndefined();
    expect(partial.getPositions).toBeTypeOf('function');
  });

  it('callMaps.toSiteArgs + harness.bindToSig reproduce the bot binding of every recorded self-test call', () => {
    const S = FX.harness;
    const labelMap = new Map(Object.entries(S.labels).map(([n, v]) => [v, n]));
    const unmask = (v) => (typeof v === 'string' && Object.prototype.hasOwnProperty.call(S.labels, v) ? S.labels[v] : v);
    const bad = [];
    for (const c of S.calls) {
      const sig = S.sigs[c.ex][c.fn].sig;
      const siteArgs = toSiteArgs(sig, c.args.map(unmask), Object.fromEntries(Object.entries(c.kwargs).map(([k, v]) => [k, unmask(v)])));
      const b = H.bindToSig(sig, siteArgs, labelMap);
      if (b.error || JSON.stringify(b.bound) !== JSON.stringify(c.bound)) bad.push({ c, siteArgs, b });
    }
    expect(bad).toEqual([]);
    expect(S.calls.length).toBeGreaterThan(8);
  });
});
