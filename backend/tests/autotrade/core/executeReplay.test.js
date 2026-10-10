/**
 * execute_auto_trade differential: every vector of fixtures/execute_vectors.json.gz (written by
 * gen/gen_execute_vectors.py — the bot's own execute_auto_trade on CPython 3.11 against fake
 * traders, a temp bot DB and a virtual clock) replayed through services/autotrade/executeAutoTrade
 * with the bot-mode D6 switches. Per vector the JS run must reproduce:
 *   - the returned dict(s),
 *   - per logical task (call<i>, partial_tp_<uid>_<sym>, limit_unfilled_guard_*, reconcile_sl_*,
 *     reconcile_ptp_*, tilt_detect_*): the ordered trader calls with their bound arguments,
 *     Telegram messages (text, parse mode, keyboard), side effects and INFO+ log lines,
 *   - the trades / users rows, the kv table and the trade_events timeline.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const { loadFixture } = req('./harness.js');
const { replay, compare } = req('./replayCompare.js');

const FX = loadFixture();

describe('execute_auto_trade — bot vs site replay', () => {
  it('covers 40+ cases and every placement branch', () => {
    expect(FX.vectors.length).toBeGreaterThanOrEqual(200);
    const names = new Set(FX.vectors.map((v) => v.case.name));
    for (const n of ['ok_bybit_limit', 'ok_bingx', 'ok_binance', 'ok_okx', 'smc_split_bybit', 'timeout_retry_ok',
      'timeout_first_found_position', 'timeout_first_found_order', 'timeout_both_bingx', 'auth_error_breaker',
      'server_error', 'ptp_fallback_ok', 'ptp_fb_skip_unfilled', 'parallel_same_symbol',
      // batch D (bot c56653d): [VOL15-RISK-CAP] (+ the low-notional pause), [SAME-DIR-CAP],
      // [MARKET-ENTRY-NO-SHIFT], [FEE-AWARE-SIZE], the risk_capped_warning numbers
      'd2_vol15_bybit_cap', 'd2_vol15_ctx_x2_reclamped', 'd2_vol15_env_abc_warn_once', 'd2_vol15_low_notional_pause_flow',
      'd2_vol15_low_notional_ctx_reclamp_own_pause', 'd2_vol15_pause_reset_by_open', 'd2_samedir_third_long',
      'd2_samedir_count_fails', 'd2_samedir_cap_off_no_count', 'd2_samedir_max_trades_first', 'd2_market_short_bingx',
      'd2_limit_short_bingx', 'd2_fee_env_0', 'd2_fee_taker_bad_binance', 'd2_fee_split_unknown_exchange',
      'd2_risk_capped_warning_local_numbers']) {
      expect(names.has(n), n).toBe(true);
    }
  });

  for (const v of FX.vectors) {
    it(v.case.name, async () => {
      const got = await replay(v, FX);
      expect(compare(v, got)).toEqual([]);
    });
  }
});

// The same vectors through the production entry point (services/autotrade/index.js
// createAutoTrade with every exchange enabled): the wrapper the scanners call is transparent.
describe('execute_auto_trade — bot vs site replay through createAutoTrade', () => {
  for (const v of FX.vectors) {
    it(v.case.name, async () => {
      const got = await replay(v, FX, { via: 'index' });
      expect(compare(v, got)).toEqual([]);
    });
  }
});

// The site's D18 guards (in-flight placement, OKX retry rule, reconcile of a failed retry — docs
// PORT_DECISIONS.md D18) are on in production; no bot vector reaches one of their branches, so with
// the production defaults every output is still the bot's (the D18 branches: tests/autotrade/safety).
describe('execute_auto_trade — the bot vectors with the site\'s D18 defaults', () => {
  for (const v of FX.vectors) {
    it(v.case.name, async () => {
      const got = await replay(v, FX, { d18: null });
      expect(compare(v, got)).toEqual([]);
    });
  }
});
