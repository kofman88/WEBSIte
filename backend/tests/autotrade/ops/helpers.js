/**
 * Shared harness for the trade-ops route tests (routes/appTrade.js + services/exchangeKeysService.js,
 * services/autotrade/{confirmMode,quickClose}.js, workers/tradeOpsWorker.js): the fixture of
 * py/drive_trade_ops.py, the site-side seed of the same users / keys / trades / candle cache, a
 * per-step exchange registry on the scripted responses (tests/exchanges/replay.js — the transport
 * the trader parity suites use), and the bot ↔ site mappings the replay compares on.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

export const FIXTURE_PATH = path.join(process.cwd(), 'tests', 'autotrade', 'ops', 'fixtures', 'trade_ops_replay.json.gz');

/** Must run before the first require of models/database. */
export function setupEnv(name) {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
  process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.DATABASE_PATH = path.join(process.cwd(), 'data', `test-trade-ops-${name}.db`);
  process.env.DB_QUIET = '1';
  process.env.LOG_LEVEL = 'error';
  process.env.VITEST = 'true';
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* absent */ } });
}

export function loadFixture() {
  const { pyJsonParse } = nodeRequire('../../../services/engine/pyjson.js');
  return pyJsonParse(zlib.gunzipSync(fs.readFileSync(FIXTURE_PATH)).toString('utf8'));
}

export const EXCHANGES = ['bybit', 'bingx', 'binance', 'okx'];

/** A log capture with the engine's level names; lines are "LEVEL message". */
export function makeLog() {
  const lines = [];
  const mk = (lvl) => (...a) => { lines.push(`${lvl} ${a.map(String).join(' ')}`); };
  return { lines, debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR') };
}

/**
 * One step's exchange world: a registry whose four traders run on the scripted routes with the
 * harness clock (time only moves on sleeps, mono 1000.0) — what harness.run_scenario installs.
 */
export function makeExchangeWorld(routes, start) {
  const { Router, makeTransport, MARKER_RE } = nodeRequire('../../exchanges/replay.js');
  const { makeClock } = nodeRequire('../../exchanges/helpers.js');
  const { memoryKv } = nodeRequire('../../../services/exchanges/runtime.js');
  const exchanges = nodeRequire('../../../services/exchanges/index.js');
  const clock = makeClock(start, 1000.0);
  const router = new Router(routes);
  const log = makeLog();
  const registry = exchanges.createRegistry({
    overrides: {
      transport: makeTransport(router), now: clock.now, monotonic: clock.monotonic, sleep: clock.sleep, random: () => 0.5,
      log, kv: memoryKv(), killswitch: { requireActive: async () => {} }, planGate: { denyReason: async () => null },
      metrics: { record: async () => {} }, events: { emit() {} }, onAuthReset: async () => [], env: {},
    },
  });
  const markers = () => {
    const out = [];
    for (const line of log.lines) {
      const sp = line.indexOf(' ');
      const lvl = line.slice(0, sp);
      for (const m of line.slice(sp + 1).match(MARKER_RE) || []) out.push([lvl, m]);
    }
    return out;
  };
  return { registry, router, clock, log, markers };
}

export function insertUser(db, id, { isAdmin = 0, locale = 'ru' } = {}) {
  db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, referral_code, is_admin, locale) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `u${id}@x.test`, 'x', `R${id}`, isAdmin, locale);
}

/** The delivered card of a seeded trade: the button set the scanner put on it (exec / quick close / none). */
export function cardJson(repo, keyboards, t) {
  let actions;
  if (t._card === 'exec') actions = keyboards.signalCompactKeyboard(t.trade_id, t.symbol, { showTradeBtn: true });
  else if (t._card === 'qc') actions = keyboards.signalCompactKeyboard(t.trade_id, t.symbol, { isAutoTraded: true });
  else actions = keyboards.signalCompactKeyboard(t.trade_id, t.symbol, {});
  return repo.cardSnapshot({ html: `<b>${t.symbol}</b> card`, actions, lang: 'ru' });
}

/** Seed users / trader_settings / exchange_keys / signal_trades like the driver. */
export function seedAll(db, fx, { ts, keysSvc, repo, keyboards }) {
  for (const [uid, plan, status, exp, lang, extra, keys] of fx.users) {
    insertUser(db, uid, { isAdmin: uid === 123 ? 1 : 0, locale: lang });
    const u = ts.getOrCreate(uid);
    Object.assign(u, { sub_plan: plan, sub_status: status, sub_expires: exp ? fx.now + exp : 0, lang }, extra);
    ts.save(u);
    for (const [ex, [key, sec, pp]] of Object.entries(keys)) keysSvc.writeKeys(uid, ex, key, sec, pp);
  }
  const { bindValue } = nodeRequire('../../../services/engine/signalTradesRepo.js');
  for (const t of fx.trades) {
    // the driver inserts only the columns a row names (the others keep their column default)
    const cols = fx.trade_cols.filter((c) => Object.prototype.hasOwnProperty.call(t, c));
    const card = cardJson(repo, keyboards, t);
    const all = [...cols, 'signal_card_json'];
    db.prepare(`INSERT INTO signal_trades (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`)
      .run(...cols.map((c) => bindValue(t[c])), card);
  }
}

/** The bot's user snapshot (drive_trade_ops.USER_FIELDS) read from the site's tables. */
export function userSnapshot(ts, keysSvc, uid) {
  const u = ts.get(uid);
  if (!u) return null;
  const out = {};
  for (const ex of EXCHANGES) {
    const [k, s] = keysSvc.exchangeKeys(uid, ex);
    out[`${ex}_api_key`] = k;
    out[`${ex}_api_secret`] = s;
  }
  out.okx_passphrase = keysSvc.exchangeKeys(uid, 'okx')[2];
  out.bybit_demo = Boolean(u.bybit_demo);
  out.trade_exchange = u.trade_exchange;
  out.auto_trade = Boolean(u.auto_trade);
  const order = ['bybit_api_key', 'bybit_api_secret', 'bingx_api_key', 'bingx_api_secret', 'binance_api_key', 'binance_api_secret',
    'okx_api_key', 'okx_api_secret', 'okx_passphrase', 'bybit_demo', 'trade_exchange', 'auto_trade'];
  return Object.fromEntries(order.map((k) => [k, out[k]]));
}

export function tradeSnapshot(db, tid) {
  const r = db.prepare('SELECT order_id, pos_idx, qty, tp_placed, be_set, result, state FROM signal_trades WHERE trade_id=?').get(tid);
  return r ? { ...r } : null;
}

/** The candle cache of the driver (cache.get_candles) as the site's provider: (symbol, tf) → Frame | null. */
export function candleProvider(fx) {
  const { Frame } = nodeRequire('../../../strategies/common/frame.js');
  const m = new Map(fx.candles.map(([sym, tf, bars]) => [`${sym}|${tf}`, Frame.fromBars(bars)]));
  return async (symbol, tf) => m.get(`${symbol}|${tf}`) || null;
}

/** A delivery fake recording what the trade-ops jobs hand to the site's channels. */
export function makeDelivery() {
  const sent = [];
  const broadcasts = [];
  return {
    sent, broadcasts,
    async sendText(uid, text, opts) { sent.push({ uid, text, opts }); return true; },
    broadcast(uid, event, data) { broadcasts.push({ uid, event, data }); return 1; },
  };
}

/** Bot keyboard ([[{text, callback_data}]]) of a site effect's action rows. */
export function tgKeyboard(rows) {
  if (!rows) return null;
  return rows.map((r) => r.map((b) => ({ text: b.label, callback_data: b.action })));
}

/** A site effect list in the bot's recording shape. */
export function asBotEffects(effects) {
  return effects.map((e) => {
    if (e.op === 'answer') return { op: 'answer', text: e.text, show_alert: e.show_alert };
    if (e.op === 'edit') return { op: 'edit', text: e.text, parse_mode: e.parse_mode, keyboard: tgKeyboard(e.keyboard) };
    if (e.op === 'send') return { op: 'send', text: e.text, parse_mode: e.parse_mode, keyboard: tgKeyboard(e.keyboard) };
    return { op: 'delete', of: e.of };
  });
}

export { same, firstDiff, rawRequest } from '../../app/data/helpers.js';
