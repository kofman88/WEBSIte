'use strict';
/**
 * Bot function name → JS trader method, per exchange, plus the state seeding (`prepare`) and
 * the final-cache snapshot used by the replay suites. Mirrors the per-exchange maps of the
 * <exchange>Trader.test.js suites; used by adversarial.test.js.
 *
 * M15 (PLAN_M15 §5, the authoritative call map): the trade-ops loops' functions are in the maps too
 * (get_execution_exit_price, cancel_tp_orders_only, get_algo_sl_orders, close_position_partial,
 * cancel_tp_orders, is_delisted), and `toSiteArgs(sig, args, kwargs)` turns ANY bot call — positional
 * args + keyword args, as the bot passes them — into the site's positional call: the bot's
 * POSITIONAL parameters in order (a keyword argument lands at its parameter's position, gaps take the
 * Python default), the KEYWORD_ONLY parameters as one trailing options object with camelCase keys
 * (`strict`, `err_out` → `{strict, errOut}`). `sig` is m15_harness.sig_json of the bot function.
 * tests/autotrade/m15/harness.js bindToSig is the inverse.
 */
const BY = require('../../services/exchanges/bybitTrader');
const BX = require('../../services/exchanges/bingxTrader');
const BN = require('../../services/exchanges/binanceTrader');
const OK = require('../../services/exchanges/okxTrader');
const SYM = require('../../services/marketData/symbolMap');

const OPT = {
  tp2: 'tp2', tp3: 'tp3', risk_mode: 'riskMode', demo: 'demo', order_type: 'orderType', trade_id: 'tradeId',
  user_id: 'userId', allow_low_notional_boost: 'allowLowNotionalBoost', passphrase: 'passphrase',
};
const camel = (kw) => Object.fromEntries(Object.entries(kw || {}).map(([k, v]) => [OPT[k] || k, v]));
const camelKey = (k) => String(k).replace(/_([a-z0-9])/g, (_m, c) => c.toUpperCase());

/** A bot call (args, kwargs) → the site's positional argument list (see the header). */
function toSiteArgs(sig, args = [], kwargs = {}) {
  const positional = sig.filter((p) => p[1] === 'POSITIONAL_ONLY' || p[1] === 'POSITIONAL_OR_KEYWORD');
  const kwOnly = sig.filter((p) => p[1] === 'KEYWORD_ONLY');
  if (args.length > positional.length) throw new Error(`toSiteArgs: ${args.length} positional args for ${positional.length} parameters`);
  const out = [];
  let last = args.length - 1;
  positional.forEach(([name, , dflt], i) => {
    if (i < args.length) out.push(args[i]);
    else if (Object.prototype.hasOwnProperty.call(kwargs, name)) { out.push(kwargs[name]); last = i; } else out.push(dflt && dflt.__nodefault__ ? undefined : dflt);
  });
  const res = out.slice(0, last + 1);
  const opts = {};
  for (const [name] of kwOnly) if (Object.prototype.hasOwnProperty.call(kwargs, name)) opts[camelKey(name)] = kwargs[name];
  if (Object.keys(opts).length) {
    while (res.length < positional.length) {
      const [, , dflt] = positional[res.length];
      res.push(dflt && dflt.__nodefault__ ? undefined : dflt);
    }
    res.push(opts);
  }
  const unknown = Object.keys(kwargs).filter((k) => !sig.some((p) => p[0] === k));
  if (unknown.length) throw new Error(`toSiteArgs: unexpected keyword argument '${unknown[0]}'`);
  return res;
}

/** The M15 trade-ops functions (PLAN_M15 §5) — which trader has which is pinned by tests/autotrade/m15/units.test.js. */
const M15_FNS = Object.freeze(['get_positions', 'get_open_orders', 'get_algo_sl_orders', 'cancel_order', 'cancel_all_orders',
  'cancel_tp_orders_only', 'cancel_tp_orders', 'get_closed_pnl', 'get_execution_exit_price', 'get_balance', 'set_trailing_sl',
  'place_sl_tp_for_position', 'place_tp_orders', 'close_position', 'close_position_partial', 'get_funding_rate', 'is_delisted']);

const COMMON = {
  place_trade: (t, a, kw) => t.placeTrade(...a.slice(0, 9), camel(kw)),
  set_trailing_sl: (t, a) => t.setTrailingSl(...a),
  set_breakeven: (t, a) => t.setBreakeven(...a),
  close_position: (t, a) => t.closePosition(...a),
  cancel_all_orders: (t, a) => t.cancelAllOrders(...a),
  cancel_order: (t, a) => t.cancelOrder(...a),
  get_positions: (t, a) => t.getPositions(...a),
  get_open_orders: (t, a) => t.getOpenOrders(...a),
  get_closed_pnl: (t, a) => t.getClosedPnl(...a),
  get_balance: (t, a) => t.getBalance(...a),
  get_dashboard: (t, a) => t.getDashboard(...a),
  test_connection: (t, a) => t.testConnection(...a),
};

const EXCHANGES = {
  bybit: {
    create: (o) => BY.createBybitTrader(o),
    calls: {
      ...COMMON,
      place_trade_split: (t, a, kw) => t.placeTradeSplit(...a.slice(0, 10), camel(kw)),
      get_execution_exit_price: (t, a) => t.getExecutionExitPrice(...a),
      place_tp_orders: (t, a) => t.placeTpOrders(...a),
      get_last_price: (t, a) => t.getLastPrice(...a),
      get_spread_pct: (t, a) => t.getSpreadPct(...a),
      get_funding_rate: (t, a) => t.getFundingRate(...a),
      sync_time: (t) => t.syncTime(),
      get_all_closed_pnl: (t, a) => t.getAllClosedPnl(...a),
      get_account_summary: (t, a) => t.getAccountSummary(...a),
      is_delisted: (t, a) => t.isDelisted(...a),
    },
    prepare(t, sc) {
      const st = sc.state || {};
      for (const [k, v] of Object.entries(st.account_type || {})) t._state.accountTypeCache.set(k, v);
      for (const [k, v] of Object.entries(st.hedge || {})) t._hedgeCacheSet(k, v);
      if (st.time_offset_ms !== undefined) { t._state.timeOffsetMs = st.time_offset_ms; t._state.timeSyncedAt = sc.clock; }
    },
    final(t) {
      const st = t._state;
      return {
        hedge: Object.fromEntries(st.hedgeModeCache),
        account_type: Object.fromEntries(st.accountTypeCache),
        delisted: Array.from(st.delisted.keys()).sort(),
        fail_count: Object.fromEntries(st.symbolFailCount),
        bybit_offset: st.timeOffsetMs,
      };
    },
    expectedFinal: (f) => ({ hedge: f.hedge, account_type: f.account_type, delisted: f.delisted, fail_count: f.fail_count, bybit_offset: f.bybit_offset }),
  },
  bingx: {
    create: (o) => BX.createBingxTrader(o),
    calls: {
      ...COMMON,
      place_sl_tp_for_position: (t, a) => t.placeSlTpForPosition(...a),
      cancel_tp_orders_only: (t, a) => t.cancelTpOrdersOnly(...a),
      get_last_price: (t, a) => t.getLastPrice(...a),
      sync_time: (t) => t.syncTime(),
    },
    prepare(t, sc) {
      SYM._setLive((sc.state && sc.state.live_bingx) || []);
      if (sc.state && sc.state.bingx_offset_ms !== undefined) t._state.timeOffsetMs = sc.state.bingx_offset_ms;
    },
    cleanup() { SYM._setLive([]); },
    final: (t) => ({ bingx_offset: t._state.timeOffsetMs }),
    expectedFinal: (f) => ({ bingx_offset: f.bingx_offset }),
  },
  binance: {
    create: (o) => BN.createBinanceTrader(o),
    calls: {
      ...COMMON,
      place_sl_tp_for_position: (t, a) => t.placeSlTpForPosition(...a),
      cancel_tp_orders_only: (t, a) => t.cancelTpOrdersOnly(...a),
      get_last_price: (t, a) => t.getLastPrice(...a),
      sync_time: (t) => t.syncTime(),
      _find_working_binance_url: (t) => t.findWorkingBinanceUrl(),
    },
    prepare(t, sc) {
      if (sc.state && sc.state.binance_offset_ms !== undefined) t._state.timeOffsetMs = sc.state.binance_offset_ms;
    },
    final: (t) => ({ binance_base: t._state.baseUrl, binance_offset: t._state.timeOffsetMs }),
    expectedFinal: (f) => ({ binance_base: f.binance_base, binance_offset: f.binance_offset }),
  },
  okx: {
    create: (o) => OK.createOkxTrader(o),
    calls: {
      ...COMMON,
      place_sl_tp_for_position: (t, a) => t.placeSlTpForPosition(...a),
      get_last_price: (t, a) => t.getLastPrice(...a),
      get_account_summary: (t, a) => t.getAccountSummary(...a),
      sync_time: (t) => t.syncTime(),
      okx_sz: (t, a) => t.okxSz(...a),
      close_position_partial: (t, a) => t.closePositionPartial(...a),
      get_algo_sl_orders: (t, a) => t.getAlgoSlOrders(...a),
      cancel_tp_orders: (t, a) => t.cancelTpOrders(...a),
    },
    prepare(t, sc) {
      if (sc.state && sc.state.okx_offset_ms !== undefined) t._state.timeOffsetMs = sc.state.okx_offset_ms;
    },
    final: (t) => ({ okx_offset: t._state.timeOffsetMs }),
    expectedFinal: (f) => ({ okx_offset: f.okx_offset }),
  },
};

module.exports = { EXCHANGES, camel, toSiteArgs, M15_FNS };
