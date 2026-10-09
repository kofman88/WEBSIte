/**
 * M13b wiring of the money paths outside the replays:
 *   - the D5 exec gate (workers/tradeOpsWorker.js execGate): AUTOTRADE_ENABLED / AUTOTRADE_EXCHANGES
 *     (the queue answering it before the handler, nothing sent: tests/autotrade/e2e)
 *   - auto_trade.reset_auth_failures from the app thread to the engine worker that owns the
 *     auto-trade registries (supervisor.resetAuthFailures → {type:'autotrade'} → autoTradeControl)
 *   - the trade-ops queue's reset_auth_failures job (no-op unless wired)
 *   - the card's trade buttons → their /api/app routes (signalDelivery.actionRoute / withActionRoutes)
 *   - D17 switches: the quick-close / confirm / positions defaults are the site's, bot mode replays
 */
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const TO = req('../../../workers/tradeOpsWorker.js');
const EW = req('../../../workers/engineWorker.js');
const SD = req('../../../services/engine/signalDelivery.js');
const QC = req('../../../services/autotrade/quickClose.js');
const appTrade = req('../../../routes/appTrade.js');

describe('D5 exec gate', () => {
  const u = (ex, lang = 'ru') => ({ user_id: 1, trade_exchange: ex, lang });
  it('off unless AUTOTRADE_ENABLED=1; exchanges default bybit,bingx; the label of the key exchange', () => {
    expect(TO.execGate(u('bybit'), {})).toEqual({ outcome: 'autotrade_disabled', text: TO.EXEC_GATE_MESSAGES.autotrade_disabled.ru });
    expect(TO.execGate(u('bybit', 'en'), { AUTOTRADE_ENABLED: '0' }).text).toBe(TO.EXEC_GATE_MESSAGES.autotrade_disabled.en);
    expect(TO.execGate(u('bybit'), { AUTOTRADE_ENABLED: '1' })).toBeNull();
    expect(TO.execGate(u('bingx'), { AUTOTRADE_ENABLED: '1' })).toBeNull();
    expect(TO.execGate(u('binance'), { AUTOTRADE_ENABLED: '1' })).toEqual({
      outcome: 'exchange_not_enabled', text: '⛔ Автоторговля на Binance на сайте пока не включена — сделка не открыта.',
    });
    expect(TO.execGate(u('okx'), { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'okx' })).toBeNull();
    // an unknown trade_exchange reads the Bybit keys (exec_trade's key_ex) → gated as Bybit
    expect(TO.execGate(u('kraken'), { AUTOTRADE_ENABLED: '1', AUTOTRADE_EXCHANGES: 'okx' }).outcome).toBe('exchange_not_enabled');
  });

  it('reset_auth_failures job: forwarded when wired, a no-op otherwise', async () => {
    const seen = [];
    const ops = TO.createTradeOps({ resetAuthFailures: async (u2, ex) => { seen.push([u2, ex]); } });
    expect(await ops.resetAuthFailures('7', 'okx')).toEqual({ outcome: 'ok' });
    expect(seen).toEqual([[7, 'okx']]);
    expect(await TO.createTradeOps({}).resetAuthFailures(7, 'bybit')).toEqual({ outcome: 'ok' });
  });
});

describe('reset_auth_failures reaches the engine worker', () => {
  class FakeWorker extends EventEmitter {
    constructor() { super(); this.posted = []; }
    postMessage(m) { this.posted.push(m); }
    terminate() { return Promise.resolve(1); }
  }

  it('supervisor: no worker → false; else the {type:"autotrade"} hand-off', () => {
    const workers = [];
    const sup = EW.createSupervisor({
      delivery: { handleWorkerMessage: () => false }, log: { debug() {}, info() {}, warn() {}, warning() {}, error() {} },
      spawn: () => { const w = new FakeWorker(); workers.push(w); return w; }, heartbeatTimeoutMs: 1e12, watchdogEveryMs: 1e12,
    });
    expect(sup.resetAuthFailures(5, 'bingx')).toBe(false);
    sup.start();
    expect(sup.resetAuthFailures('5', 'bingx')).toBe(true);
    expect(sup.resetAuthFailures(6, '')).toBe(true);
    expect(workers[0].posted.slice(-2)).toEqual([
      { type: 'autotrade', op: 'reset_auth_failures', userId: 5, exchange: 'bingx' },
      { type: 'autotrade', op: 'reset_auth_failures', userId: 6, exchange: 'bybit' },
    ]);
    sup.stop();
  });

  it('worker: the message calls the scheduler\'s auto-trade resetAuthFailures (nothing before it is built)', async () => {
    const port = new EventEmitter();
    const posted = [];
    port.postMessage = (m) => posted.push(m);
    const calls = [];
    const autoTrade = { resetAuthFailures: (u, ex) => calls.push([u, ex]) };
    const w = EW.runWorker(port, { deps: { autoTrade, env: {} }, logs: false, heartbeatMs: 1e9, setEvery: () => null, clearEvery: () => {} });
    expect(w.autoTradeControl({ op: 'reset_auth_failures', userId: 1, exchange: 'bybit' })).toBe(false);
    await w.start({ only: ['__none__'] });
    expect(posted.some((m) => m.type === 'ready')).toBe(true);
    port.emit('message', { type: 'autotrade', op: 'reset_auth_failures', userId: '42', exchange: 'okx' });
    expect(w.autoTradeControl({ op: 'unknown' })).toBe(false);
    expect(calls).toEqual([[42, 'okx']]);
    await w.stop();
  });
});

describe('card trade buttons → /api/app routes', () => {
  it('actionRoute: exec / qc half / full / force / be / refresh / hold-lock wait; other buttons none', () => {
    const t = '77_vol_1_2';
    expect(SD.actionRoute(`exec_trade_${t}`)).toEqual({ method: 'POST', path: `trades/${t}/exec` });
    expect(SD.actionRoute(`qc_half_${t}`)).toEqual({ method: 'POST', path: `trades/${t}/qc/half` });
    expect(SD.actionRoute(`qc_full_${t}`)).toEqual({ method: 'POST', path: `trades/${t}/qc/full` });
    expect(SD.actionRoute(`qc_full_force_${t}`)).toEqual({ method: 'POST', path: `trades/${t}/qc/force` });
    expect(SD.actionRoute(`qc_be_${t}`)).toEqual({ method: 'POST', path: `trades/${t}/qc/be` });
    expect(SD.actionRoute(`qc_refresh_${t}`)).toEqual({ method: 'GET', path: `trades/${t}/progress` });
    expect(SD.actionRoute('qc_holdlock_wait', t)).toEqual({ method: 'POST', path: `trades/${t}/qc/wait` });
    expect(SD.actionRoute('qc_holdlock_wait')).toBeNull();
    expect(SD.actionRoute('my_stats')).toBeNull();
    expect(SD.actionRoute(`sig_records_${t}`)).toBeNull();
    expect(SD.actionRoute('exec_trade_a/b')).toEqual({ method: 'POST', path: 'trades/a%2Fb/exec' });
  });

  it('withActionRoutes annotates callback buttons only and never mutates the stored rows', () => {
    const rows = [[{ id: 'qc_full', action: 'qc_full_9', kind: 'callback' }, { id: 'chart', action: 'https://x', kind: 'url' }], [{ id: 'my_stats', action: 'my_stats', kind: 'callback' }]];
    const copy = JSON.parse(JSON.stringify(rows));
    expect(SD.withActionRoutes(rows, '9')).toEqual([
      [{ id: 'qc_full', action: 'qc_full_9', kind: 'callback', api: { method: 'POST', path: 'trades/9/qc/full' } }, { id: 'chart', action: 'https://x', kind: 'url' }],
      [{ id: 'my_stats', action: 'my_stats', kind: 'callback' }],
    ]);
    expect(rows).toEqual(copy);
    expect(SD.withActionRoutes(null)).toBeNull();
  });
});

describe('D17 defaults', () => {
  it('the site\'s fixes are the defaults; bot mode is an explicit switch', () => {
    expect(QC.D17_SITE).toEqual({ positionSide: true });
    expect(appTrade.D17_SITE).toEqual({ okxPositions: true });
  });
});
