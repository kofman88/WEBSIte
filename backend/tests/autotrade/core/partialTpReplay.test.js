/**
 * partial_tp.place_partial_tp_orders vs services/autotrade/partialTp.js — request-for-request.
 *
 * fixtures/partial_tp_vectors.json is written by gen/gen_partial_tp_vectors.py: the bot's partial
 * TP ladder on the bot's real traders over the exchange replay harness (scripted HTTP / pybit
 * session, fake clock). The JS ladder runs on the JS traders with the same scripted responses
 * (tests/exchanges/replay.js) and must reproduce the return value, every request (URL, auth
 * headers, body), the sleeps, the trader log markers, its own INFO+ log lines, the ladder
 * downgrade message / enqueue and the admin alert.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const req = createRequire(import.meta.url);
const { runScenario } = req('../../exchanges/replay.js');
const { EXCHANGES } = req('../../exchanges/callMaps.js');
const { createPartialTp } = req('../../../services/autotrade/partialTp.js');
const { makeHandle } = req('../../../services/autotrade/traders.js');

const ROWS = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'partial_tp_vectors.json'), 'utf8'));

async function runPtp(sc) {
  const EX = EXCHANGES[sc.exchange];
  let overrides = null;
  const side = { logs: [], msgs: [], alerts: [], enqueue: [] };
  const mk = (level) => (msg) => {
    if (level === 'DEBUG') return;
    const s = String(msg);
    if (!s.startsWith('[TG-SAFE]')) side.logs.push([level, s]);
  };
  const log = { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), critical: mk('CRITICAL') };
  const res = await runScenario(sc, (o) => { overrides = o; return EX.create(o); }, async (trader, s) => {
    const kw = { ...s.kwargs };
    const sendFail = Boolean(kw.send_fail);
    delete kw.send_fail;
    const user = kw.user;
    const bot = kw.bot ? {} : null;
    const ptp = createPartialTp({
      traderFor: (ex) => makeHandle(ex, trader),
      log,
      sleep: overrides.sleep,
      sendMessage: async (_b, uid, text, opts = {}) => { side.msgs.push([uid, text, opts.parseMode === undefined ? null : opts.parseMode]); return !sendFail; },
      enqueueCritical: async (_b, uid, text, { parseMode = 'HTML', reason = '' } = {}) => { side.enqueue.push([uid, text, parseMode, reason]); return 'q1'; },
      adminAlert: async (_b, title, details, dedupKey, alertType = '') => { side.alerts.push([title, details, dedupKey, alertType]); },
    });
    let value;
    try {
      value = { ok: await ptp.placePartialTpOrders({ ...kw, user, bot }) };
    } catch (e) {
      value = { raised: [e.pyType || e.name, e.message] };
    }
    return { value, ...side };
  }, EX.prepare ? (t, s, ctx) => EX.prepare(t, s, ctx) : undefined);
  if (EX.cleanup) EX.cleanup();
  return res.out;
}

describe('partial TP ladder — bot vs site, wire level', () => {
  it('covers every exchange branch', () => {
    const ex = new Set(ROWS.map((r) => r.scenario.exchange));
    expect([...ex].sort()).toEqual(['binance', 'bingx', 'bybit', 'okx']);
    expect(ROWS.length).toBeGreaterThanOrEqual(30);
  });

  for (const { scenario: sc, expected: exp } of ROWS) {
    it(`${sc.exchange} ${sc.name}`, async () => {
      const out = await runPtp(sc);
      expect(out.raised, 'raised').toEqual(exp.raised);
      expect(out.result.value, 'value').toEqual(exp.result.value);
      expect(out.requests, 'requests').toEqual(exp.requests);
      expect(out.sleeps, 'sleeps').toEqual(exp.sleeps);
      expect(out.markers, 'trader markers').toEqual(exp.markers);
      expect(out.result.logs, 'partial TP log lines').toEqual(exp.result.logs);
      expect(out.result.msgs, 'messages').toEqual(exp.result.msgs);
      expect(out.result.enqueue, 'enqueue').toEqual(exp.result.enqueue);
      expect(out.result.alerts, 'admin alerts').toEqual(exp.result.alerts);
    });
  }
});
