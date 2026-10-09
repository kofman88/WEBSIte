/**
 * Trade-ops routes (routes/appTrade.js → services/exchangeKeysService.js, services/autotrade/
 * confirmMode.js + quickClose.js through workers/tradeOpsWorker.js) vs the bot's own handlers,
 * step by step.
 *
 * Fixture: py/drive_trade_ops.py ran miniapp_api's h_exchange_keys / h_exchange_keys_remove /
 * h_positions over HTTP (raw request targets, aiohttp TestServer) and the Telegram buttons
 * exec_trade / cb_qc_half / cb_qc_full / cb_qc_full_force / cb_holdlock_wait / cb_qc_be /
 * cb_qc_refresh with a recording CallbackQuery — CPython 3.11, the bot's DB layer on a seeded temp
 * SQLite, time.time pinned per step, every exchange call answered by the scripted fakes of
 * tests/exchanges/py/harness.py (requests / sleeps / log markers recorded).
 *
 * Here the same seed goes into the site DB (keys encrypted in exchange_keys, the delivered cards in
 * signal_card_json), every step goes through the full Express app over a socket with the user's JWT
 * (the buttons as POST trades/{id}/exec | qc/* and GET trades/{id}/progress), the traders run on the
 * same scripted routes (tests/exchanges/replay.js transport, the harness clock) — and every step must
 * give the bot's HTTP status + bytes (routes) or the bot's chat effects (buttons), the bot's user
 * and trade rows afterwards, every exchange request (method, URL, auth headers, body), the sleeps,
 * the trader log markers and the handler log lines.
 *
 * Where the site decides otherwise the expectation is derived from the bot's step:
 *   D15 — a key the exchange says can withdraw (or whose permissions cannot be read) is refused
 *         after the bot's own test calls + one permission read; nothing is stored;
 *   D16 — a button the user's delivered card does not offer (foreign trade, used card, missing id,
 *         hostile id) → 404 not_found before any handler work: no request, no write, no message.
 *
 * Regenerate: py/drive_trade_ops.py (see its docstring).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { createRequire } from 'module';
import {
  setupEnv, loadFixture, makeExchangeWorld, makeLog, seedAll, userSnapshot, tradeSnapshot, candleProvider, makeDelivery,
  asBotEffects, same, firstDiff, rawRequest,
} from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('replay');

const FX = loadFixture();
let db; let app; let ts; let keysSvc; let authService; let appRouter; let appTrade; let tradeOps; let CM; let repo; let keyboards;
let pyJsonParse; let server; let port;
const clock = { now: FX.now };

beforeAll(async () => {
  db = nodeRequire('../../../models/database.js');
  app = (await import('../../../server.js')).default;
  ts = nodeRequire('../../../services/traderSettingsService.js');
  keysSvc = nodeRequire('../../../services/exchangeKeysService.js');
  authService = nodeRequire('../../../services/authService.js');
  appRouter = nodeRequire('../../../routes/app.js');
  appTrade = nodeRequire('../../../routes/appTrade.js');
  tradeOps = nodeRequire('../../../workers/tradeOpsWorker.js');
  CM = nodeRequire('../../../services/autotrade/confirmMode.js');
  repo = nodeRequire('../../../services/engine/signalTradesRepo.js').defaultRepo;
  keyboards = nodeRequire('../../../services/engine/cards/keyboards.js');
  ({ pyJsonParse } = nodeRequire('../../../services/engine/pyjson.js'));
  seedAll(db, FX, { ts, keysSvc, repo, keyboards });
  appRouter.resetRateLimits();
  appRouter.setClock(() => clock.now);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

afterAll(async () => {
  appRouter.setClock(null);
  appTrade.configure({ clock: null, log: null, registry: null, candles: null, tradeOps: null, execWaitS: null, testTimeoutS: null, dashboardTimeoutS: null });
  keysSvc.configure({ log: null, registry: null, resetAuthFailures: null });
  tradeOps.configureLocal(null);
  await new Promise((r) => server.close(r));
});

const SITE = '/api/app';
const BOT = '/miniapp/api';
const ROUTE_OF = {
  exec_trade: ['POST', 'exec'], cb_qc_half: ['POST', 'qc/half'], cb_qc_full: ['POST', 'qc/full'], cb_qc_full_force: ['POST', 'qc/force'],
  cb_holdlock_wait: ['POST', 'qc/wait'], cb_qc_be: ['POST', 'qc/be'], cb_qc_refresh: ['GET', 'progress'],
};
const QC_OK = ['closed_half', 'closed', 'be_set', 'wait'];
const handlerLog = (lines) => lines.filter((l) => !l.startsWith('DEBUG '));
const noQuery = (u) => String(u).split('?')[0];

/** The outcome the site reports for a bot effect list (derived from what the bot did, not from the site). */
function botOutcome(s) {
  const ef = s.effects;
  const sends = ef.filter((e) => e.op === 'send');
  const edits = ef.filter((e) => e.op === 'edit');
  const answers = ef.filter((e) => e.op === 'answer' && e.text);
  const lastSend = sends.length ? sends[sends.length - 1].text : '';
  const I = FX.i18n;
  const isText = (txt, key) => txt === I[key].ru || txt === I[key].en;
  if (s.handler === 'exec_trade') {
    if (ef.length === 1 && ef[0].op === 'answer' && isText(ef[0].text, 'exec_trade_locked')) return 'locked';
    if (sends.length && isText(sends[0].text, 'sub_expired')) return 'sub_expired';
    if (sends.length && /API (не настроен|not configured)/.test(sends[0].text)) return 'api_not_setup';
    const last = edits.length ? edits[edits.length - 1].text : '';
    if (isText(last, 'exec_signal_stale')) return 'stale';
    if (isText(last, 'exec_already_opened')) return 'already_opened';
    if (isText(last, 'exec_already_on_exchange')) return 'already_on_exchange';
    if (/^⛔ (Лимит сделок|Trade limit)/.test(last)) return 'limit';
    if (/^⚠️ <b>(Сделка по|A trade on)/.test(last)) return 'dup_symbol';
    if (lastSend.startsWith('❌ Ошибка открытия сделки:\n')) return 'error';
    return s.trade_after && s.trade_after.order_id ? 'opened' : 'failed';
  }
  if (s.handler === 'cb_holdlock_wait') return 'wait';
  const a0 = answers.length ? answers[0].text : '';
  if (a0 === 'Сделка не найдена') return 'not_found';
  if (a0 === '⛔ Не твоя сделка' || a0 === '⛔') return 'foreign';
  if (a0.startsWith('Сделка уже закрыта')) return 'closed';
  if (a0.startsWith('⏸ HOLD-LOCK')) return 'hold_lock';
  if (s.handler === 'cb_qc_refresh') return a0 === 'Нет данных о текущей цене' ? 'no_data' : 'progress';
  if (lastSend.startsWith('✅ Закрыта половина')) return 'closed_half';
  if (lastSend === '✅ Позиция закрыта полностью') return 'closed';
  if (lastSend.startsWith('🛡 SL → entry')) return 'be_set';
  return 'failed';
}

/** CM.summarize re-derived from the bot's effects (independent of the site's code). */
function botSummary(effects) {
  const deleted = new Set(effects.filter((e) => e.op === 'delete').map((e) => e.of));
  let message = null;
  let alert = null;
  let card = null;
  effects.forEach((e, i) => {
    if (e.op === 'send' && !deleted.has(i)) message = e.text;
    else if (e.op === 'answer' && e.text) alert = { text: e.text, show_alert: e.show_alert };
    else if (e.op === 'edit') card = e.text;
  });
  return { message: message !== null ? message : (alert ? alert.text : card), alert, card };
}

/** The site's expected answer body for a button step. */
function expectedButtonBody(s, siteEffects) {
  const outcome = botOutcome(s);
  if (s.handler === 'cb_qc_refresh' && outcome === 'progress') {
    const text = s.effects.filter((e) => e.op === 'send').pop().text;
    return { ok: true, outcome, text, pnl: s.pnl, effects: siteEffects };
  }
  const ok = s.handler === 'exec_trade' ? outcome === 'opened' : (s.handler === 'cb_qc_refresh' ? false : QC_OK.includes(outcome));
  const sum = botSummary(s.effects);
  const out = { ok, outcome };
  if (!ok) out.error = outcome;
  return { ...out, message: sum.message, alert: sum.alert, card: sum.card, effects: siteEffects };
}

/** The user fields a successful keys / remove step writes (h_exchange_keys / h_exchange_keys_remove). */
function fieldsWritten(s) {
  if (s.kind !== 'http' || s.method !== 'POST' || s.status !== 200) return [];
  let body;
  try { body = JSON.parse(s.text); } catch (_e) { return []; }
  if (!body.ok) return [];
  if (s.path === `${BOT}/exchange/keys`) {
    const ex = body.exchange;
    return [`${ex}_api_key`, `${ex}_api_secret`, ...(ex === 'okx' ? ['okx_passphrase'] : []), 'trade_exchange', ...(ex === 'bybit' ? ['bybit_demo'] : [])];
  }
  if (s.path === `${BOT}/exchange/keys/remove`) {
    const ex = String(JSON.parse(s.body).exchange).trim().toLowerCase();
    return [`${ex}_api_key`, `${ex}_api_secret`, ...(ex === 'okx' ? ['okx_passphrase'] : []), 'auto_trade'];
  }
  return [];
}

const D15_LINE =/^INFO \[MINIAPP\] exchange keys uid=(\d+) (\w+): (withdraw permission|permission check failed \((.+)\)) — refused \(D15\)$/;

describe(`trade ops — ${FX.steps.length} steps replayed against the bot`, () => {
  it('fixture: CPython 3.11, every route × scenario family present', () => {
    expect(FX.python.startsWith('3.11.')).toBe(true);
    const names = FX.steps.map((s) => s.name);
    for (const p of ['keys ', 'remove ', 'positions ', 'route ', 'exec ', 'qc half', 'qc full', 'qc force', 'qc wait', 'qc be', 'progress ']) {
      expect(names.some((n) => n.startsWith(p)), p).toBe(true);
    }
    expect(FX.steps.filter((s) => s.site === 'not_found').length).toBeGreaterThanOrEqual(14);
    expect(FX.steps.filter((s) => s.d15 && s.d15 !== 'ok').length).toBeGreaterThanOrEqual(9);
  });

  it('seed: users, encrypted keys, trades with their delivered cards', () => {
    expect(db.prepare('SELECT COUNT(*) n FROM signal_trades').get().n).toBe(FX.trades.length);
    const rows = db.prepare('SELECT api_key_encrypted, api_secret_encrypted FROM exchange_keys').all();
    expect(rows.length).toBeGreaterThan(20);
    const plain = Object.values(FX.keys).flatMap(([k, s]) => [k, s]);
    for (const r of rows) for (const p of plain) expect(String(r.api_key_encrypted) + String(r.api_secret_encrypted)).not.toContain(p);
  });

  it('every step: status + bytes / effects, user + trade rows, exchange requests, sleeps, markers, logs', async () => {
    const bad = [];
    const tokens = {};
    const seen = { http: 0, bytes: 0, button: 0, effects: 0, requests: 0, d15: 0, d16: 0, trade: 0, user: 0, logs: 0, cards: 0, sent: 0, progress: 0 };
    // the site's user rows: the bot's, except what a D15 refusal kept from changing
    const override = {};
    const botPrev = {};
    for (const [uid] of FX.users) botPrev[uid] = userSnapshot(ts, keysSvc, uid);
    const candles = candleProvider(FX);

    for (const s of FX.steps) {
      clock.now = s.now;
      const world = makeExchangeWorld(s.routes, s.now);
      const opsLog = makeLog();
      const delivery = makeDelivery();
      const resets = [];
      appTrade.configure({
        clock: () => clock.now, log: opsLog, registry: world.registry, candles, execWaitS: 60,
        testTimeoutS: s.force_timeout === 'test' ? 0 : null, dashboardTimeoutS: s.force_timeout === 'dashboard' ? 0 : null,
      });
      keysSvc.configure({ log: opsLog, registry: world.registry, resetAuthFailures: async (uid, ex) => { resets.push([uid, ex]); } });
      tradeOps.configureLocal({ registry: world.registry, log: opsLog, now: () => clock.now, candles, delivery });

      const headers = {};
      if (s.uid !== null) {
        if (!tokens[s.uid]) tokens[s.uid] = authService._signAccessToken(s.uid);
        headers.Authorization = `Bearer ${tokens[s.uid]}`;
      }
      let method; let target; let body = null;
      if (s.kind === 'http') {
        method = s.method;
        target = SITE + s.path.slice(BOT.length);
        body = s.body;
        if (s.ctype && body !== null) headers['Content-Type'] = s.ctype;
      } else {
        const [m, tail] = ROUTE_OF[s.handler];
        method = m;
        target = `${SITE}/trades/${encodeURIComponent(s.tid)}/${tail}`;
        if (m === 'POST') { body = '{}'; headers['Content-Type'] = 'application/json'; }
      }
      const tradeBefore = s.tid ? tradeSnapshot(db, s.tid) : null;
      const cardBefore = s.tid ? (db.prepare('SELECT signal_card_json c FROM signal_trades WHERE trade_id=?').get(s.tid) || {}).c : null;
      if (s.pre_lock) CM._execTradeLocks.set(s.tid, { held: true });
      let res;
      try {
        res = await rawRequest(port, { method, target, headers, body });
      } finally {
        if (s.pre_lock) CM._execTradeLocks.delete(s.tid);
      }
      const problems = [];
      const gotReq = world.router.log;
      let wantReq = s.requests;
      let wantLogs = s.logs.slice();
      let wantSleeps = s.sleeps;
      let wantMarkers = s.markers;
      let refused = false;
      let d16 = false;

      if (s.kind === 'http') {
        seen.http += 1;
        const botBody = (s.headers['content-type'] || '').startsWith('application/json') ? pyJsonParse(s.text) : null;
        const isKeys = s.path === `${BOT}/exchange/keys` && s.method === 'POST';
        refused = Boolean(isKeys && s.d15 && s.d15 !== 'ok' && botBody && botBody.ok === true);
        const testPassed = Boolean(isKeys && botBody && botBody.ok === true);
        if (res.status !== s.status) problems.push(`status ${res.status} vs bot ${s.status}`);
        if (refused) {
          seen.d15 += 1;
          const lang = FX.users.find((u) => u[0] === s.uid)[4] === 'en' ? 'en' : 'ru';
          const kind = s.d15 === 'withdraw' ? 'withdraw' : 'unknown';
          const want = { ok: false, error: kind === 'withdraw' ? 'withdraw_permission' : 'permission_unknown', message: keysSvc.D15_MESSAGES[kind][lang] };
          const d = firstDiff(pyJsonParse(res.text), want);
          if (d) problems.push(`d15 body ${d}`);
          const i = wantLogs.findIndex((l) => l.endsWith(' connected'));
          const line = handlerLog(opsLog.lines).find((l) => D15_LINE.test(l));
          if (i < 0 || !line) problems.push(`d15 log ${JSON.stringify(handlerLog(opsLog.lines))}`);
          else {
            const m = line.match(D15_LINE);
            if (Number(m[1]) !== s.uid || m[2] !== s.d15_ex || (kind === 'withdraw') !== (m[3] === 'withdraw permission')) problems.push(`d15 log ${line}`);
            wantLogs[i] = line;
          }
          if (resets.length) problems.push(`refused key reset auth failures ${JSON.stringify(resets)}`);
        } else {
          seen.bytes += 1;
          if (res.text !== s.text) problems.push(`text ${res.text.slice(0, 300)} vs bot ${s.text.slice(0, 300)}`);
          if (testPassed && !same(resets, [[s.uid, botBody.exchange]])) problems.push(`resets ${JSON.stringify(resets)}`);
          if (!testPassed && resets.length) problems.push(`resets ${JSON.stringify(resets)}`);
        }
        if (res.headers['content-type'] !== s.headers['content-type']) problems.push(`content-type ${res.headers['content-type']} vs ${s.headers['content-type']}`);
        for (const h of ['retry-after', 'allow']) if (res.headers[h] !== s.headers[h]) problems.push(`${h} ${res.headers[h]} vs ${s.headers[h]}`);
        if (testPassed) {
          // D15: one permission read after the bot's own calls (signed exactly as d15_wire, pinned in d15.test.js)
          wantReq = [...s.requests, null];
          const extra = gotReq[gotReq.length - 1];
          const ex = s.d15_ex;
          const wire = FX.d15_wire[ex][ex === 'bybit' && s.user_after.bybit_demo ? 1 : 0];
          if (!extra || extra.method !== 'GET' || noQuery(extra.url) !== noQuery(wire.url)) problems.push(`d15 request ${JSON.stringify(extra)}`);
          else {
            const k = Object.keys(wire.headers).find((h) => /API-?KEY|ACCESS-KEY|APIKEY/i.test(h));
            if (!same(Object.keys(extra.headers).sort(), Object.keys(wire.headers).sort()) || extra.headers[k] !== JSON.parse(s.body).api_key.trim()) {
              problems.push(`d15 request headers ${JSON.stringify(Object.keys(extra.headers))}`);
            }
          }
        }
      } else {
        seen.button += 1;
        if (s.raised !== null) problems.push(`bot raised ${s.raised}`);
        if (s.site === 'not_found') {
          d16 = true;
          seen.d16 += 1;
          if (res.status !== 404 || res.text !== '{"ok": false, "error": "not_found"}') problems.push(`d16 ${res.status} ${res.text}`);
          wantReq = [];
          wantLogs = [];
          wantSleeps = [];
          wantMarkers = [];
        } else {
          if (res.status !== 200) problems.push(`status ${res.status} ${res.text.slice(0, 200)}`);
          let got;
          try { got = pyJsonParse(res.text); } catch (_e) { got = null; }
          if (!got || !Array.isArray(got.effects)) problems.push(`body ${res.text.slice(0, 200)}`);
          else {
            const d0 = firstDiff(asBotEffects(got.effects), s.effects);
            if (d0) problems.push(`effects ${d0}`);
            else seen.effects += 1;
            const d1 = firstDiff(got, expectedButtonBody(s, got.effects));
            if (d1) problems.push(`body ${d1}`);
            if (got.outcome === 'progress') seen.progress += 1;
          }
        }
      }

      // exchange requests, sleeps, trader markers
      if (wantReq.length && wantReq[wantReq.length - 1] === null) {
        const d = firstDiff(gotReq.slice(0, -1), wantReq.slice(0, -1));
        if (d || gotReq.length !== wantReq.length) problems.push(`requests ${d || `${gotReq.length} vs ${wantReq.length}`}`);
      } else {
        const d = firstDiff(gotReq, wantReq);
        if (d) problems.push(`requests ${d} (${gotReq.length} vs ${wantReq.length})`);
      }
      if (gotReq.length) seen.requests += 1;
      if (!same(world.clock.sleeps, wantSleeps)) problems.push(`sleeps ${JSON.stringify(world.clock.sleeps)} vs ${JSON.stringify(wantSleeps)}`);
      const gotMarkers = world.markers();
      if (!same(gotMarkers, wantMarkers)) problems.push(`markers ${JSON.stringify(gotMarkers)} vs ${JSON.stringify(wantMarkers)}`);
      const gotLogs = handlerLog(opsLog.lines);
      if (!same(gotLogs, wantLogs)) problems.push(`logs ${JSON.stringify(gotLogs)} vs ${JSON.stringify(wantLogs)}`);
      if (gotLogs.length) seen.logs += 1;

      // user row
      if (s.uid !== null && s.user_after) {
        const ov = override[s.uid] || {};
        const prev = botPrev[s.uid];
        let want;
        if (refused) {
          want = { ...prev };
          for (const [f, v] of Object.entries(ov)) want[f] = v;
          const nov = { ...ov };
          for (const f of Object.keys(s.user_after)) if (!same(s.user_after[f], want[f])) nov[f] = want[f];
          override[s.uid] = nov;
        } else {
          want = { ...s.user_after };
          const nov = {};
          const wrote = fieldsWritten(s);
          for (const [f, v] of Object.entries(ov)) {
            if (wrote.includes(f) || (prev && !same(prev[f], s.user_after[f]))) continue;   // the step wrote it: the site's write too
            want[f] = v;
            nov[f] = v;
          }
          override[s.uid] = nov;
        }
        botPrev[s.uid] = s.user_after;
        const got = userSnapshot(ts, keysSvc, s.uid);
        const d = firstDiff(got, want);
        if (d) problems.push(`user ${d}`);
        seen.user += 1;
      }

      // trade row, card, deliveries
      if (s.tid) {
        const after = tradeSnapshot(db, s.tid);
        const want = d16 ? tradeBefore : s.trade_after;
        const d = firstDiff(after, want);
        if (d) problems.push(`trade ${d}`);
        if (after) seen.trade += 1;
        const cardAfter = (db.prepare('SELECT signal_card_json c FROM signal_trades WHERE trade_id=?').get(s.tid) || {}).c;
        const edits = d16 ? [] : s.effects.filter((e) => e.op === 'edit');
        if (edits.length) {
          seen.cards += 1;
          const c = JSON.parse(cardAfter);
          if (c.html !== edits[edits.length - 1].text || c.actions !== null) problems.push(`card ${cardAfter.slice(0, 200)}`);
        } else if (cardAfter !== cardBefore) problems.push('card changed without an edit');
        const deleted = new Set(s.effects.filter((e) => e.op === 'delete').map((e) => e.of));
        const wantSent = d16 || s.handler === 'cb_qc_refresh' ? [] : s.effects.map((e, i) => [e, i]).filter(([e, i]) => e.op === 'send' && !deleted.has(i)).map(([e]) => e.text);
        const gotSent = delivery.sent.map((x) => x.text);
        if (!same(gotSent, wantSent)) problems.push(`sent ${JSON.stringify(gotSent)} vs ${JSON.stringify(wantSent)}`);
        if (gotSent.length) seen.sent += 1;
        for (const x of delivery.sent) {
          if (x.uid !== s.uid || x.opts.type !== 'trade' || x.opts.link !== `/app/?tab=signals&id=${encodeURIComponent(s.tid)}`) problems.push(`sent opts ${JSON.stringify(x.opts)}`);
        }
      }
      // never a secret in a response or a log line
      for (const [, sec] of Object.values(FX.keys)) {
        if (res.text.includes(sec) || opsLog.lines.some((l) => l.includes(sec))) problems.push('secret leaked');
      }
      if (problems.length) bad.push({ step: s.name, problems });
    }
    if (bad.length && process.env.TRADE_OPS_DUMP) nodeRequire('fs').writeFileSync(process.env.TRADE_OPS_DUMP, JSON.stringify(bad, null, 1));
    expect(bad).toEqual([]);
    // the comparison really ran over every family (exact counts of this fixture)
    expect(seen.http).toBe(FX.steps.filter((s) => s.kind === 'http').length);
    expect(seen.bytes).toBe(69);
    expect(seen.d15).toBe(9);
    expect(seen.d16).toBe(FX.steps.filter((s) => s.site === 'not_found').length);
    expect(seen.effects).toBe(FX.steps.filter((s) => s.kind === 'cb' && s.site !== 'not_found').length);
    expect(seen.requests).toBe(64);
    expect(seen.trade).toBe(73);
    expect(seen.user).toBe(153);
    expect(seen.logs).toBe(55);
    expect(seen.cards).toBe(20);
    expect(seen.sent).toBe(45);
    expect(seen.progress).toBe(8);
  }, 180_000);
});
