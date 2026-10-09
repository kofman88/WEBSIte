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
    expect(FX.vectors.length).toBeGreaterThanOrEqual(40);
    const names = new Set(FX.vectors.map((v) => v.case.name));
    for (const n of ['ok_bybit_limit', 'ok_bingx', 'ok_binance', 'ok_okx', 'smc_split_bybit', 'timeout_retry_ok',
      'timeout_first_found_position', 'timeout_first_found_order', 'timeout_both_bingx', 'auth_error_breaker',
      'server_error', 'ptp_fallback_ok', 'ptp_fb_skip_unfilled', 'parallel_same_symbol']) {
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
