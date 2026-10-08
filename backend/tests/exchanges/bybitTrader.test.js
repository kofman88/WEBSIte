/**
 * bybitTrader.js vs bybit_trader.py — request-for-request replay.
 *
 * fixtures/scenarios_bybit.json is produced by py/gen_trader_scenarios.py: each scenario
 * runs the BOT's trader (real pybit 5.14 over a fake `requests.Session.send`, or a
 * dict-returning session stand-in for mode='session') on a fake clock and records every
 * HTTP request (method, URL, X-BAPI-* headers incl. signature + timestamp, JSON body),
 * the result dict / raised exception, sleeps, log markers and final caches. The JS trader
 * replays the same scripted responses and must produce identical output.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const BY = req('../../services/exchanges/bybitTrader.js');
const { runScenario } = req('./replay.js');
const { loadFixture } = req('./helpers.js');

const ROWS = loadFixture('scenarios_bybit.json');

const OPT_KEYS = {
  tp2: 'tp2', tp3: 'tp3', risk_mode: 'riskMode', demo: 'demo', order_type: 'orderType', trade_id: 'tradeId',
  user_id: 'userId', allow_low_notional_boost: 'allowLowNotionalBoost',
};
const camel = (kw) => Object.fromEntries(Object.entries(kw || {}).map(([k, v]) => [OPT_KEYS[k] || k, v]));

const CALLS = {
  place_trade: (t, a, kw) => t.placeTrade(...a.slice(0, 9), camel(kw)),
  place_trade_split: (t, a, kw) => t.placeTradeSplit(...a.slice(0, 10), camel(kw)),
  set_trailing_sl: (t, a) => t.setTrailingSl(...a),
  set_breakeven: (t, a) => t.setBreakeven(...a),
  close_position: (t, a) => t.closePosition(...a),
  cancel_all_orders: (t, a) => t.cancelAllOrders(...a),
  cancel_order: (t, a) => t.cancelOrder(...a),
  get_positions: (t, a) => t.getPositions(...a),
  get_open_orders: (t, a) => t.getOpenOrders(...a),
  get_closed_pnl: (t, a) => t.getClosedPnl(...a),
  get_balance: (t, a) => t.getBalance(...a),
  get_execution_exit_price: (t, a) => t.getExecutionExitPrice(...a),
  get_dashboard: (t, a) => t.getDashboard(...a),
  test_connection: (t, a) => t.testConnection(...a),
  place_tp_orders: (t, a) => t.placeTpOrders(...a),
};

function prepare(t, sc) {
  const st = sc.state || {};
  for (const [k, v] of Object.entries(st.account_type || {})) t._state.accountTypeCache.set(k, v);
  for (const [k, v] of Object.entries(st.hedge || {})) t._hedgeCacheSet(k, v);
  if (st.time_offset_ms !== undefined) { t._state.timeOffsetMs = st.time_offset_ms; t._state.timeSyncedAt = sc.clock; }
}

describe('bybit_trader replay parity', () => {
  for (const { scenario: sc, expected: exp } of ROWS) {
    it(sc.name, async () => {
      const { out, trader } = await runScenario(sc, (o) => BY.createBybitTrader(o), (t, s) => {
        const fn = CALLS[s.call];
        if (!fn) throw new Error(`no JS mapping for ${s.call}`);
        return fn(t, s.args, s.kwargs);
      }, prepare);
      expect(out.requests, 'requests').toEqual(exp.requests);
      if (exp.raised) expect(out.raised, 'raised').toEqual(exp.raised);
      else expect(out.result, 'result').toEqual(exp.result);
      expect(out.sleeps, 'sleeps').toEqual(exp.sleeps);
      expect(out.markers, 'log markers').toEqual(exp.markers);
      expect(out.saved, 'saved').toEqual(exp.saved);
      const st = trader._state;
      expect(Object.fromEntries(st.hedgeModeCache), 'hedge cache').toEqual(exp.final.hedge);
      expect(Object.fromEntries(st.accountTypeCache), 'account type').toEqual(exp.final.account_type);
      expect(Array.from(st.delisted.keys()).sort(), 'delisted').toEqual(exp.final.delisted);
      expect(Object.fromEntries(st.symbolFailCount), 'fail count').toEqual(exp.final.fail_count);
      expect(st.timeOffsetMs, 'time offset').toBe(exp.final.bybit_offset);
    });
  }
});
