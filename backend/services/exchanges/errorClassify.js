'use strict';
/**
 * errorClassify.js — the bot's exchange-error classification.
 *
 * `isUserFacingError` / `isAuthFailure` are verbatim ports of
 * `auto_trade._is_user_facing_error` / `auto_trade._is_auth_failure` (substring match on
 * str(err).lower()); the auth breaker that consumes them belongs to the auto-trade layer.
 *
 * `BENIGN` lists, per exchange and operation, the codes the traders treat as success /
 * no-op rather than failure (each entry is implemented inside the trader modules; the
 * table is the single place to look them up):
 *   bybit   set_leverage 110043 (not modified), switch_margin_mode 110026,
 *           set_trading_stop 34040 / "not modified" → {ok:true, already_at_target:true},
 *           close_position 10001 + "qty invalid" → {ok:false, benign:true},
 *           cancel_order 110001 (already gone, logged at debug), place_order 110072 duplicate
 *           orderLinkId → verify position → ok (duplicate:true)
 *   bingx   leverage 80014 (already set), duplicate clientOrderId: the "duplicate" / "clientOrderId
 *           exist" text, or 101204/101404 confirmed by the order found by its clientOrderId
 *           ([BINGX-DUP-VERIFY] — 101204 alone is «Insufficient margin», an error),
 *           trailing-SL cancel of the old SL 109400 ("order not exist"), 110424 (size >
 *           available: original SL stays, logged at info)
 *   binance positionSide/dual -4059 (no need to change), duplicate -4015 /
 *           "client order id already"
 *   okx     — (code "0" only)
 */

const { pyLower } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods
const USER_FACING_ERR_PATTERNS = Object.freeze([
  'api key is invalid',
  'api key пов',
  'auth failed after trying',
  'contract is not live',
  'qty invalid',
  'signature',
  'ab not enough',
  'insufficient',
  'недостаточно средств',
  'недостаточно маржи',
  'недостаточно свободного баланса',
  // Bybit
  'errcode: 10003',
  'errcode: 10001',
  'errcode: 110074',
  'errcode: 110001',
  'errcode: 110007',
  'errcode: 110043',
  'errcode: 10002',
  'errcode: 110017',
  'errcode: 110013',
  'errcode: 10006',
  'errcode: 34040',
  'server_timestamp',
  'limit order not filled yet',
  'position closed before tp',
  // BingX
  'code: 100413',
  'code:100413',
  // Binance
  'code: -2014',
  'code:-2014',
  'code: -2015',
  'code:-2015',
  'code: -1022',
  'code:-1022',
  'code: -1021',
  'code:-1021',
]);

const AUTH_FAILURE_PATTERNS = Object.freeze([
  'api key is invalid',
  'api key пов',
  'auth failed after trying',
  // Bybit
  'errcode: 10003',
  '10003',
  // BingX
  'code: 100413',
  'code:100413',
  '100413',
  // Binance
  'code: -2014',
  'code:-2014',
  '-2014',
  'code: -2015',
  'code:-2015',
  '-2015',
]);

function _lower(err) {
  if (err instanceof Error) return pyLower(String(err.message));
  return pyLower(String(err === null || err === undefined ? 'None' : err));
}

/** True when the error is an expected user-side error (not a bug for Sentry). */
function isUserFacingError(err) {
  const s = _lower(err);
  return USER_FACING_ERR_PATTERNS.some((p) => s.includes(p));
}

/** True when the error means an invalid API key (any of the 4 exchanges). */
function isAuthFailure(err) {
  const s = _lower(err);
  return AUTH_FAILURE_PATTERNS.some((p) => s.includes(p));
}

const BENIGN = Object.freeze({
  bybit: Object.freeze({
    set_leverage: [110043],
    switch_margin_mode: [110026],
    set_trading_stop: [34040],
    close_position: [10001],
    cancel_order: [110001],
    place_order_duplicate: [110072],
  }),
  bingx: Object.freeze({
    set_leverage: [80014],
    duplicate: [101204, 101404],              // only with the order found by clientOrderId ([BINGX-DUP-VERIFY])
    trailing_cancel_old_sl: [109400],
    trailing_size_gt_available: [110424],
  }),
  binance: Object.freeze({
    position_side_dual: [-4059],
    duplicate: [-4015],
  }),
  okx: Object.freeze({}),
});

module.exports = { USER_FACING_ERR_PATTERNS, AUTH_FAILURE_PATTERNS, isUserFacingError, isAuthFailure, BENIGN };
