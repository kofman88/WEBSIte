/**
 * Wire-level differential of the trade routes (routes/appTrade.js → services/exchangeKeysService.js,
 * services/autotrade/confirmMode.js + quickClose.js through workers/tradeOpsWorker.js) against the
 * bot's own handlers, over the STATEFUL fake exchanges.
 *
 * Fixture: py/drive_wire_diff.py WIRE_MODE=routes (py/wire_routes.py) — per session (a user on one
 * exchange) the bot's miniapp_api h_exchange_keys / h_positions / h_exchange_keys_remove and its
 * Telegram buttons exec_trade / qc_half / qc_full / qc_full_force / qc_holdlock_wait / qc_be /
 * qc_refresh, step by step on one simulator (keys tested under faults, positions read under faults,
 * the confirm-mode exec under every error class, quick close / SL→BE of a position that exists on the
 * exchange), CPython 3.11 on a virtual-time loop (the clock moves only when every coroutine and
 * pybit thread is idle). Per step: every request (normalised, signature verified) with its answer,
 * the handler log lines, the trader log markers, metrics; afterwards the user row, the trade row,
 * trade_events — and, for a key the bot accepted, the exchange's answer to the D15 permission read.
 *
 * Here the same seed goes into the site DB, every step goes through the full Express app over a socket
 * with the user's JWT, the traders run on the production trade-ops registry (killswitch / plan gate /
 * events / auth-reset hooks, cancellable transport, pybit thread semantics) whose transport is the
 * bot's recording; the clock is virtual too (route wait_for timers included) and moves only while no
 * HTTP byte is in flight. Each JS request must be the next one the bot sent; the D15 read (the site's
 * only extra request) is checked against the bot's own signing of it.
 *
 * Site decisions applied to the expectation: D15 (a key that can withdraw / whose permissions cannot be
 * read is refused, nothing stored); D17 off (the bot's close side / OKX dashboard / no exchange write).
 *
 * Regenerate: WIRE_MODE=routes …/drive_wire_diff.py (see README.md).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import net from 'net';
import zlib from 'zlib';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { setupEnv, insertUser, cardJson, makeDelivery, asBotEffects, userSnapshot, tradeSnapshot } from '../ops/helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('wire-routes');

const FIXTURE = path.join(process.cwd(), 'tests', 'autotrade', 'wire', 'fixtures', 'wire_routes.json.gz');
const { pyJsonParse } = nodeRequire('../../../services/engine/pyjson.js');
const FX = pyJsonParse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString('utf8'));
const { normRequest, sigOk } = nodeRequire('./harness.js');
const { firstDiff } = nodeRequire('./compare.js');
const { createVClock } = nodeRequire('../core/vclock.js');
const asyncio = nodeRequire('../../../services/autotrade/asyncio.js');
const { TransportError, fetchError } = nodeRequire('../../../services/exchanges/transport.js');
const { memoryKv } = nodeRequire('../../../services/exchanges/runtime.js');

const SITE = '/api/app';
const BOT = '/miniapp/api';
const BOT_D17 = { positionSide: false, recordExchange: false, okxPositions: false };
const ALL_ON = { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'bybit,bingx,binance,okx' };
const ROUTE_OF = {
  exec_trade: ['POST', 'exec'], cb_qc_half: ['POST', 'qc/half'], cb_qc_full: ['POST', 'qc/full'], cb_qc_full_force: ['POST', 'qc/force'],
  cb_holdlock_wait: ['POST', 'qc/wait'], cb_qc_be: ['POST', 'qc/be'], cb_qc_refresh: ['GET', 'progress'],
};
const MARKER_RE = /\[[A-Z][A-Z0-9_-]*[A-Z0-9]\]/g;
const D15_PATHS = new Set(Object.values(FX.meta.d15_path));
const USER_KEYS = ['lang', 'trade_exchange', 'auto_trade', 'auto_trade_mode', 'bybit_demo', 'trade_risk_pct', 'trade_leverage',
  'max_trades_limit', 'hold_lock_enabled', 'hold_lock_min_rr', 'sub_plan', 'sub_status', 'sub_expires'];

let db; let app; let ts; let keysSvc; let authService; let appRouter; let appTrade; let tradeOps; let repo; let keyboards; let AT; let Frame;
let server; let port;
const io = { busy: 0 };
const SEEN = { http: 0, cb: 0, requests: 0, orders: 0, d15: 0, refused: 0, events: 0, trades: 0, sent: 0, threadTail: 0 };
const W = { clk: null };

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  ts = nodeRequire('../../../services/traderSettingsService.js');
  keysSvc = nodeRequire('../../../services/exchangeKeysService.js');
  authService = nodeRequire('../../../services/authService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appTrade = nodeRequire('../../../routes/appTrade.js');
  tradeOps = nodeRequire('../../../workers/tradeOpsWorker.js');
  repo = nodeRequire('../../../services/engine/signalTradesRepo.js').defaultRepo;
  keyboards = nodeRequire('../../../services/engine/cards/keyboards.js');
  AT = nodeRequire('../../../services/autotrade/index.js');
  ({ Frame } = nodeRequire('../../../strategies/common/frame.js'));
  db.prepare("INSERT OR REPLACE INTO engine_kv (key, value, updated_at) VALUES ('operational_state', ?, 0)")
    .run(JSON.stringify({ state: 'ACTIVE', reason: '' }));
  appRouter.setClock(() => (W.clk ? W.clk.now() : Date.now() / 1000));
  // the socket listener: a request is in flight from the client's write to the server's 'request' and
  // from the response's 'finish' to the client's 'end' (the virtual clock waits meanwhile)
  server = http.createServer((req, res) => {
    io.busy -= 1;
    res.on('finish', () => { io.busy += 1; });
    asyncio.runAsTask('route', () => app(req, res));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  appRouter.setClock(null);
  appTrade.configure({ clock: null, log: null, registry: null, candles: null, tradeOps: null, execWaitS: null, testTimeoutS: null, dashboardTimeoutS: null, d17: null });
  keysSvc.configure({ log: null, registry: null, resetAuthFailures: null, timers: null });
  tradeOps.configureLocal(null);
  await new Promise((r) => server.close(r));
});

function rawRequest({ method, target, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const data = body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8');
    const head = [`${method} ${target} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close'];
    for (const [k, v] of Object.entries(headers)) head.push(`${k}: ${v}`);
    if (['POST', 'PUT', 'DELETE'].includes(method) || data.length) head.push(`Content-Length: ${data.length}`);
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', (e) => { io.busy -= 1; reject(e); });
    sock.on('end', () => {
      io.busy -= 1;
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf('\r\n\r\n');
      const lines = raw.slice(0, sep).toString('latin1').split('\r\n');
      const hdrs = {};
      for (const ln of lines.slice(1)) {
        const i = ln.indexOf(':');
        hdrs[ln.slice(0, i).trim().toLowerCase()] = ln.slice(i + 1).trim();
      }
      let rest = raw.slice(sep + 4);
      if (hdrs['transfer-encoding'] === 'chunked') {
        const parts = [];
        for (;;) {
          const e = rest.indexOf('\r\n');
          const n = parseInt(rest.slice(0, e).toString('latin1'), 16);
          if (!n) break;
          parts.push(rest.slice(e + 2, e + 2 + n));
          rest = rest.slice(e + 2 + n + 2);
        }
        rest = Buffer.concat(parts);
      }
      resolve({ status: Number(lines[0].split(' ')[1]), headers: hdrs, text: rest.toString('utf8') });
    });
    io.busy += 1;
    sock.write(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), data]));
  });
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
const realTick = () => new Promise((r) => setTimeout(r, 1));

/** Drive `promise` on the virtual clock: timers fire only while no HTTP byte is in flight; drains them after. */
async function drive(clk, promise) {
  let done = false;
  let failed = false;
  let value;
  let error;
  promise.then((v) => { done = true; value = v; }, (e) => { done = true; failed = true; error = e; });
  let idle = 0;
  for (;;) {
    await settle();
    if (io.busy > 0) { await realTick(); continue; }
    if (clk.pending()) { idle = 0; clk.fireNext(); continue; }
    if (done) break;
    await realTick();
    if (++idle > 5000) throw new Error('wire routes: the step never settled (deadlock)');
  }
  if (failed) throw error;
  return value;
}

function seed(c) {
  const uid = c.uid;
  insertUser(db, uid, { locale: c.user.lang });
  const u = ts.getOrCreate(uid);
  for (const k of USER_KEYS) if (Object.prototype.hasOwnProperty.call(c.user, k)) u[k] = c.user[k];
  ts.save(u);
  for (const [ex, [key, sec, pp]] of Object.entries(c.stored_keys)) keysSvc.writeKeys(uid, ex, key, sec, pp);
  const { bindValue } = nodeRequire('../../../services/engine/signalTradesRepo.js');
  for (const t of c.trades) {
    const cols = FX.meta.trade_cols.filter((col) => Object.prototype.hasOwnProperty.call(t, col));
    const all = [...cols, 'signal_card_json'];
    db.prepare(`INSERT INTO signal_trades (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`)
      .run(...cols.map((col) => bindValue(t[col])), cardJson(repo, keyboards, t));
  }
}

/** The site's own D15 verdict of the exchange's answer (keyPermissions verdicts; Binance: only a 200 counts). */
function siteVerdict(ex, resp) {
  if (!resp || resp.hang || resp.connect) return 'unknown';
  if (ex === 'binance' && Number(resp.status) !== 200) return 'unknown';
  let body;
  try { body = pyJsonParse(resp.text); } catch (_e) { return 'unknown'; }
  const V = keysSvc._verdicts;
  return { bybit: V.bybitVerdict, bingx: V.bingxVerdict, binance: V.binanceVerdict, okx: V.okxVerdict }[ex](body).verdict;
}

const botView = (recs) => recs.filter(([, k, d]) => !(k === 'side' && d[0] === 'mutation')).map(([, k, d]) => (k === 'req' ? [k, (() => {
  const r = { ...d.req };
  delete r.client;
  delete r.unhandled;
  return r;
})()] : [k, d]));

async function runSession(v) {
  const c = v.case;
  const clk = createVClock(c.clock);
  W.clk = clk;
  seed(c);
  const problems = [];
  let stepRecs = [];
  let queue = [];
  let d15 = null;
  let d15Got = [];
  const push = (kind, data) => stepRecs.push([kind, JSON.parse(JSON.stringify(data === undefined ? null : data))]);
  const mkLog = (into) => {
    const mk = (level) => (...a) => { if (level !== 'DEBUG') into(level, a.map(String).join(' ')); };
    return { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), critical: mk('CRITICAL'), exception: mk('ERROR') };
  };
  /**
   * The wait for an answer that is late: a timer of the virtual clock that the request's cancel scope
   * clears (the bot's cancelled coroutine takes its sleep with it; an abandoned pybit thread has a
   * scope of its own and waits on).
   */
  const wait = (sec) => new Promise((resolve, reject) => {
    const chain = [];
    for (let x = asyncio.currentScope(); x; x = x.parent) chain.push(x);
    let h = null;
    const off = () => { for (const x of chain) x.listeners.delete(onCancel); };
    function onCancel() { clk.timers.clearTimeout(h); off(); reject(new asyncio.CancelledError()); }
    h = clk.timers.setTimeout(() => { off(); resolve(); }, sec * 1000);
    for (const x of chain) x.listeners.add(onCancel);
  });
  const routeLog = mkLog((level, s) => push('log', [level, s]));
  const traderLog = mkLog((level, s) => { const ms = s.match(MARKER_RE); if (ms) push('tlog', [level, ms]); });
  const transport = async (req) => {
    const jsReq = normRequest(req, clk.now());
    jsReq.sig_ok = sigOk(c.accounts, req);
    const pathname = new URL(req.url).pathname;
    if (D15_PATHS.has(pathname) && d15) {
      d15Got.push(jsReq);
      const r = d15.resp;
      const headers = {};
      for (const [k, val] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = val;
      return { status: r.status, headers, text: r.text, url: req.url };
    }
    push('req', jsReq);
    const bot = queue.shift();
    if (!bot) return { status: 404, headers: { 'content-type': 'text/plain' }, text: 'no route (the bot sent nothing more)', url: req.url };
    const r = bot.resp;
    const timeoutS = (req.timeoutMs === undefined ? 15000 : req.timeoutMs) / 1000;
    if (r.hang || (r.delay && r.delay >= timeoutS)) {
      await wait(timeoutS);
      throw fetchError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), req.url, req.timeoutMs);
    }
    if (r.connect) throw new TransportError('connect', r.connect.aio, { requestsType: 'ConnectionError', requestsMessage: r.connect.req });
    if (r.delay) await wait(r.delay);
    const headers = {};
    for (const [k, val] of Object.entries(r.headers || {})) headers[k.toLowerCase()] = val;
    return { status: r.status, headers, text: r.text, url: req.url };
  };
  const registry = AT.createTradeOpsRegistry({
    log: routeLog, db, now: clk.now,
    overrides: {
      transport, sleep: clk.sleep, timers: clk.timers, now: clk.now, monotonic: clk.mono, log: traderLog, kv: memoryKv(),
      random: () => 0.5, env: {},
      metrics: { record: async (name, value = 1.0, tags = null) => { push('metric', [name, value, tags === undefined ? null : tags]); } },
    },
  });
  const frames = new Map(Object.entries(c.candles || {}).map(([k, bars]) => [k, Frame.fromBars(bars)]));
  const candles = async (symbol, tf) => frames.get(`${symbol}|${tf}`) || null;
  const delivery = makeDelivery();
  appTrade.configure({ clock: clk.now, log: routeLog, registry, candles, execWaitS: 1e6, testTimeoutS: null, dashboardTimeoutS: null, d17: BOT_D17 });
  keysSvc.configure({ log: routeLog, registry, resetAuthFailures: async () => {}, timers: clk.timers });
  tradeOps.configureLocal({ registry, log: routeLog, now: clk.now, candles, delivery, d17: BOT_D17, env: ALL_ON });
  const token = authService._signAccessToken(c.uid);
  // D15: user fields where the site differs from the bot because it refused a key the bot stored
  let override = {};
  let prevUser = userSnapshot(ts, keysSvc, c.uid);
  const tids = c.trades.map((t) => t.trade_id);

  for (const s of v.expected.steps) {
    const stepName = `${c.name} · ${s.name}`;
    const spec = c.steps.find((x) => x.name === s.name && !x._used);
    spec._used = true;
    await drive(clk, clk.sleep(s.now - clk.now()));
    appRouter.resetRateLimits();
    stepRecs = [];
    d15 = s.d15;
    d15Got = [];
    delivery.sent.length = 0;
    const botRecs = botView(s.recs);
    const tasksSeen = new Set(s.recs.map(([t]) => t));
    if ([...tasksSeen].some((t) => t !== 'route')) problems.push(`${stepName}: bot tasks ${[...tasksSeen]}`);
    queue = s.recs.filter(([, k]) => k === 'req').map(([, , d]) => d);
    const headers = { Authorization: `Bearer ${token}` };
    let method;
    let target;
    let body = null;
    if (spec.kind === 'http') {
      method = spec.method;
      target = SITE + spec.path.slice(BOT.length);
      body = spec.body;
      if (body !== null) headers['Content-Type'] = 'application/json';
    } else {
      const [m, tail] = ROUTE_OF[spec.handler];
      method = m;
      target = `${SITE}/trades/${encodeURIComponent(spec.tid)}/${tail}`;
      if (m === 'POST') { body = '{}'; headers['Content-Type'] = 'application/json'; }
    }
    const res = await drive(clk, rawRequest({ method, target, headers, body }));
    const p = [];
    SEEN[spec.kind] += 1;
    if (stepRecs.some(([k]) => k === 'req')) SEEN.requests += 1;
    SEEN.orders += stepRecs.filter(([k, d0]) => k === 'req' && d0.method !== 'GET' && /order|close-position|trading-stop/.test(d0.target)).length;
    if (s.end > s.now + 8) SEEN.threadTail += 1;
    if (Math.abs(clk.now() - s.end) > 1e-6) p.push(`clock ${clk.now() - c.clock} vs bot ${s.end - c.clock}`);
    let wantRecs = botRecs;
    let refusedNow = false;
    let wroteKeys = null;
    if (spec.kind === 'http') {
      const botBody = s.ctype === 'application/json' ? pyJsonParse(s.text) : null;
      const isKeys = spec.path === `${BOT}/exchange/keys`;
      if (isKeys && botBody && botBody.ok === true) {
        // D15: exactly one permission read, signed like the bot's own code signs it
        const ex = botBody.exchange;
        if (d15Got.length !== 1) p.push(`d15 reads ${d15Got.length}`);
        else {
          const g = { ...d15Got[0] };
          const w = { ...s.d15.req };
          delete w.client;
          for (const k of ['ts_delta', 'timeout']) { delete g[k]; delete w[k]; }
          const d = firstDiff(w, g, 'd15 request');
          if (d) p.push(d);
        }
        SEEN.d15 += 1;
        const verdict = siteVerdict(ex, s.d15.resp);
        const want = s.d15.req.sig_ok === false ? 'unknown' : { ok: 'ok', withdraw: 'withdraw', unreadable: 'unknown' }[c.perm];
        if (verdict !== want) p.push(`d15 verdict ${verdict} vs ${want}`);
        if (verdict !== 'ok') {
          refusedNow = true;
          SEEN.refused += 1;
          const lang = c.user.lang === 'en' ? 'en' : 'ru';
          const kind = verdict === 'withdraw' ? 'withdraw' : 'unknown';
          const wantBody = { ok: false, error: kind === 'withdraw' ? 'withdraw_permission' : 'permission_unknown', message: keysSvc.D15_MESSAGES[kind][lang] };
          const d = firstDiff(wantBody, pyJsonParse(res.text), 'd15 body');
          if (d) p.push(d);
          // the bot's «connected» line is the site's D15 refusal line
          const i = wantRecs.findIndex(([k, d0]) => k === 'log' && /exchange keys uid=\d+ \w+ connected$/.test(d0[1]));
          const line = stepRecs.find(([k, d0]) => k === 'log' && /refused \(D15\)$/.test(d0[1]));
          if (i < 0 || !line) p.push(`d15 log ${JSON.stringify(stepRecs.filter(([k]) => k === 'log'))}`);
          else wantRecs = [...wantRecs.slice(0, i), line, ...wantRecs.slice(i + 1)];
        } else {
          wroteKeys = ex;
        }
      } else if (d15Got.length) p.push(`unexpected d15 read ${JSON.stringify(d15Got)}`);
      if (!refusedNow) {
        if (res.status !== s.status) p.push(`status ${res.status} vs bot ${s.status}`);
        if (res.text !== s.text) p.push(`text ${res.text.slice(0, 300)} vs bot ${s.text.slice(0, 300)}`);
      }
      if (spec.path === `${BOT}/exchange/keys/remove` && botBody && botBody.ok === true) wroteKeys = c.exchange;
    } else {
      if (s.raised !== null) p.push(`bot raised ${s.raised}`);
      if (res.status !== 200) p.push(`status ${res.status} ${res.text.slice(0, 200)}`);
      let got = null;
      try { got = pyJsonParse(res.text); } catch (_e) { got = null; }
      if (!got || !Array.isArray(got.effects)) p.push(`body ${res.text.slice(0, 300)}`);
      else {
        const d = firstDiff(s.effects, asBotEffects(got.effects), 'effects');
        if (d) p.push(d);
        if (got.pending) p.push('pending');
      }
      const deleted = new Set(s.effects.filter((e) => e.op === 'delete').map((e) => e.of));
      const wantSent = spec.handler === 'cb_qc_refresh' ? [] : s.effects.map((e, i) => [e, i]).filter(([e, i]) => e.op === 'send' && !deleted.has(i)).map(([e]) => e.text);
      const d2 = firstDiff(wantSent, delivery.sent.map((x) => x.text), 'sent');
      if (d2) p.push(d2);
      if (wantSent.length) SEEN.sent += 1;
    }
    // int((monotonic() - t0) * 1000) over a sum of virtual sleeps: the two clocks may round the last
    // millisecond differently (float accumulation order) — ±1 ms is the same latency
    wantRecs.forEach(([k, d0], i) => {
      const g = stepRecs[i];
      if (k === 'metric' && d0[0] === 'trade_placement_latency_ms' && g && g[0] === 'metric' && g[1][0] === d0[0]
        && Math.abs(g[1][1] - d0[1]) <= 1) g[1][1] = d0[1];
    });
    const dr = firstDiff(wantRecs, stepRecs, 'recs');
    if (dr) p.push(dr);
    if (process.env.WIRE_ROUTES_TRACE && dr) {
      console.log(`### ${stepName}\n--- bot\n${wantRecs.map((r) => JSON.stringify(r).slice(0, 400)).join('\n')}\n--- site\n${stepRecs.map((r) => JSON.stringify(r).slice(0, 400)).join('\n')}`);
    }
    // rows: the bot's user, except what a D15 refusal kept from changing on the site
    const ua = userSnapshot(ts, keysSvc, c.uid);
    if (wroteKeys) {
      for (const f of [`${wroteKeys}_api_key`, `${wroteKeys}_api_secret`, 'okx_passphrase', 'trade_exchange', 'bybit_demo', 'auto_trade']) delete override[f];
    }
    if (refusedNow) {
      for (const [f, val] of Object.entries(s.user_after)) if (JSON.stringify(val) !== JSON.stringify(prevUser[f])) override[f] = prevUser[f];
    }
    const wantUser = { ...s.user_after, ...override };
    const du = firstDiff(wantUser, ua, 'user');
    if (du) p.push(du);
    prevUser = ua;
    if (spec.tid) {
      const d = firstDiff(s.trade_after, tradeSnapshot(db, spec.tid), 'trade');
      if (d) p.push(d);
      SEEN.trades += 1;
    }
    if (tids.length) {
      const ev = db.prepare(`SELECT trade_id, event_type, payload_json FROM trade_events WHERE trade_id IN (${tids.map(() => '?').join(',')}) ORDER BY id`)
        .all(...tids).map((r) => [r.trade_id, r.event_type, r.payload_json]);
      const d = firstDiff(s.events, ev, 'events');
      if (d) p.push(d);
      if (ev.length) SEEN.events += 1;
    }
    // never a secret in an answer or a log line
    for (const [, sec, pp] of Object.values(c.stored_keys).concat(c.accounts.map((a) => [a.key, a.secret, a.passphrase]))) {
      if (res.text.includes(sec) || (pp && res.text.includes(pp))) p.push('secret in the answer');
      if (stepRecs.some(([k, d0]) => k === 'log' && (d0[1].includes(sec) || (pp && d0[1].includes(pp))))) p.push('secret in a log line');
    }
    if (p.length) problems.push({ step: stepName, problems: p.map((x) => String(x).slice(0, 700)) });
  }
  for (const st of c.steps) delete st._used;
  W.clk = null;
  return problems;
}

describe(`wire differential, trade routes — ${FX.vectors.length} sessions replayed against the bot`, () => {
  it('fixture: CPython 3.11, every exchange × route, faults on every path', () => {
    expect(FX.meta.python.startsWith('3.11.')).toBe(true);
    const steps = FX.vectors.flatMap((v) => v.case.steps.map((s) => [v.case.exchange, s]));
    for (const ex of ['bybit', 'bingx', 'binance', 'okx']) {
      for (const n of ['keys connect', 'positions', 'exec', 'cb_qc_half', 'cb_qc_full', 'cb_qc_be', 'remove']) {
        expect(steps.some(([e, s]) => e === ex && s.name.startsWith(n)), `${ex} ${n}`).toBe(true);
      }
    }
    const labels = new Set(FX.vectors.flatMap((v) => v.case.faults.map((f) => f.label)));
    for (const l of ['test_hang', 'test_502', 'test_rate', 'dash_hang', 'qc_pos_hang', 'qc_rate', 'qc_reject', 'timeout_after_accept', 'insufficient_margin']) {
      expect(labels.has(l), l).toBe(true);
    }
    expect(FX.vectors.filter((v) => v.case.perm !== 'ok' && !Object.keys(v.case.stored_keys).length).length).toBeGreaterThanOrEqual(16);
    for (const ex of ['bybit', 'bingx', 'binance', 'okx']) {
      for (const cls of ['insufficient_margin', 'precision', 'rate_limit', 'duplicate', 'position_mode', 'delisted', 'timeout_after_accept',
        'timeout_before_accept', 'html_502', 'connect']) {
        expect(FX.vectors.some((v) => v.case.exchange === ex && v.case.faults.some((f) => f.label === cls)), `${ex} exec ${cls}`).toBe(true);
      }
    }
    expect(FX.vectors.every((v) => !(v.expected.sim_errors || []).length)).toBe(true);
  });

  it('every step: answer bytes / effects, requests, logs, markers, metrics, user + trade rows, trade_events, D15 read', async () => {
    const bad = [];
    const only = (process.env.WIRE_ROUTES_ONLY || '').split(',').filter(Boolean);
    for (const v of FX.vectors) {
      if (only.length && !only.includes(v.case.name)) continue;
      const p = await runSession(v);
      if (p.length) bad.push({ session: v.case.name, problems: p });
    }
    if (bad.length && process.env.WIRE_ROUTES_DUMP) fs.writeFileSync(process.env.WIRE_ROUTES_DUMP, JSON.stringify(bad, null, 1));
    expect(bad).toEqual([]);
    if (only.length) return;
    if (process.env.WIRE_ROUTES_TRACE) console.log(JSON.stringify(SEEN));
    // the comparison really covered every family
    const steps = FX.vectors.flatMap((v) => v.expected.steps);
    expect(SEEN.http + SEEN.cb).toBe(steps.length);
    expect(SEEN.requests).toBeGreaterThan(180);
    expect(SEEN.orders).toBeGreaterThan(60);
    expect(SEEN.d15).toBeGreaterThanOrEqual(30);
    expect(SEEN.refused).toBeGreaterThanOrEqual(12);
    expect(SEEN.trades).toBe(SEEN.cb);
    expect(SEEN.sent).toBeGreaterThan(100);
    expect(SEEN.cb).toBeGreaterThan(120);
    expect(SEEN.threadTail).toBeGreaterThan(15);
  }, 600_000);
});

describe('the routes\' wait_for (exchangeKeysService.waitFor) is asyncio.wait_for', () => {
  it('the timeout cancels the work: TimeoutError(""), no further request; a timeout <= 0 never starts it', async () => {
    const clk = createVClock(1e9);
    keysSvc.configure({ timers: clk.timers });
    try {
      const sent = [];
      const tx = asyncio.cancellableTransport(async (r) => { sent.push(r); await clk.sleep(10); return r; });
      const work = async () => { await tx('dashboard positions'); await tx('dashboard open orders'); };
      await expect(clk.run(keysSvc.waitFor(work, 8))).rejects.toMatchObject({ isTimeout: true, message: '' });
      expect(sent).toEqual(['dashboard positions']);
      let started = false;
      await expect(keysSvc.waitFor(async () => { started = true; }, 0)).rejects.toMatchObject({ isTimeout: true });
      expect(started).toBe(false);
      expect(await clk.run(keysSvc.waitFor(async () => { await clk.sleep(1); return 'ok'; }, 8))).toBe('ok');
    } finally {
      keysSvc.configure({ timers: null });
    }
  });

  it('the process-wide and the trade-ops traders run with the cancellable runtime and pybit thread semantics', () => {
    const exchanges = nodeRequire('../../../services/exchanges/index.js');
    const quiet = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };
    for (const ex of ['bybit', 'bingx', 'binance', 'okx']) {
      expect(exchanges.getTrader(ex).instance({}).rt.runInThread, ex).toBe(asyncio.runInThread);
      expect(AT.createTradeOpsRegistry({ log: quiet })(ex, false).rt.runInThread, ex).toBe(asyncio.runInThread);
    }
  });
});
