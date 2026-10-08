/**
 * probe.test.js — LEVELS differential probe, main suite (tests/golden/levels_probe.json.gz,
 * produced by tests/golden/make_levels_probe.py with the bot's own indicator.CHMIndicator,
 * seed 20261008): symbol classes, working TFs 15m/30m/4h/1d, HTF zones, BTC/ETH frame variants,
 * HIGH_WR, momentum relaxed mode, env gates, SL-V2 + cached regime, TradeCfg bounds, 44 random
 * configs, degenerate frames and the live path (one persistent indicator: cooldown, zone cache +
 * pre-filter with an injected clock, HTF zone cache, ATR-breakout cooldown) — everything
 * expected/levels.json does not reach.
 *
 * The replay and the comparison rules live in probeReplay.js (env knobs documented there).
 * Re-check runs with other seeds: probe_seed.test.js; hand-constructed setup frames:
 * probe_setups.test.js.
 */
import { defineProbeSuite } from './probeReplay.js';

defineProbeSuite('levels_probe', { title: 'main (seed 20261008)', minCases: 100 });
