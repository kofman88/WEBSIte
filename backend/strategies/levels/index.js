'use strict';
/**
 * index.js — LEVELS engine entry point.
 *
 * Part 1 (M5, this file's exports): configuration, zones, patterns, setup search
 * (`analyzePart1` = analyze() guard + `_do_analyze` through the RSI gate).
 *
 * TODO(M6): part 2 completes `analyze()` — stops.js (structural SL, cap/floor,
 * liquidity magnets, coin-class minimums), targets.js (structural TPs ±0.05 %, ATR scale,
 * assembly/repair, R:R checks, rr_score), context.js (BTC/ETH rolling correlation,
 * RSI divergence, HTF EMA confluence, LVN path), quality.js (18-step accumulation,
 * checklist, memcoin cap), highWr.js, filters.js (levels_filters.evaluate +
 * market_regime.detect_regime), explain.js (human_explanation), stars.js,
 * atrBreakout.js, and the `analyze(symbol, df, dfHtf, dfBtc, dfEth, {cooldownState})`
 * → { signal: SignalResult|null, rejectReason } runner. Only then register the engine in
 * tests/golden/engines.js:
 *   require('../golden/engines').register('levels', { run(ctx) { ... } })
 * The golden sweep stays `todo` until that registration (never a failure).
 */

const config = require('./config');
const zones = require('./zones');
const patterns = require('./patterns');
const setups = require('./setups');

module.exports = {
  ...config,
  ...zones,
  ...patterns,
  ...setups,
  config, zones, patterns, setups,
};
