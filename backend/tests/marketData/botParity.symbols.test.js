/**
 * Bot parity — symbol maps vs the bot's Python (fetcher_bingx.resolve / to_bingx / from_bingx /
 * price_multiplier / _base_of / is_non_crypto, bingx_trader.to_bingx_symbol /
 * bingx_price_multiplier, bybit_trader.*, binance_trader.*, fetcher.OKXFetcher._to_okx) over
 * 146 inputs, without and with a live BingX contract set (parity/symbols.json).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { loadParity } from './parityHelpers.js';

const req = createRequire(import.meta.url);
const SM = req('../../services/marketData/symbolMap.js');
const fx = loadParity('symbols.json');

const FIELDS = {
  resolve: (s) => SM.resolve(s),
  to_bingx: (s) => SM.toBingx(s),
  price_multiplier: (s) => SM.priceMultiplier(s),
  base_of: (s) => SM.baseOf(s),
  to_bingx_symbol: (s) => SM.toBingxSymbol(s),
  bingx_price_multiplier: (s) => SM.bingxPriceMultiplier(s),
  to_bybit_symbol: (s) => SM.toBybitSymbol(s),
  bybit_price_multiplier: (s) => SM.bybitPriceMultiplier(s),
  to_binance_symbol: (s) => SM.toBinanceSymbol(s),
  binance_price_multiplier: (s) => SM.binancePriceMultiplier(s),
  to_okx: (s) => SM.toOkx(s),
};

function checkSnapshot(snap, label) {
  for (const s of fx.inputs) {
    const exp = snap[s];
    for (const [k, fn] of Object.entries(FIELDS)) {
      expect(fn(s), `${label} ${k}(${JSON.stringify(s)})`).toEqual(exp[k]);
    }
  }
}

describe('symbolMap == bot symbol functions', () => {
  beforeEach(() => SM._setLive([]));

  it('static tables equal the bot maps', () => {
    expect(SM.BINGX_MULTIPLIER).toEqual(fx.maps.bingx_mult);
    expect(SM.BINGX_NAME_ALIAS).toEqual(fx.maps.bingx_alias);
    expect(SM.BYBIT_MULTIPLIER).toEqual(fx.maps.bybit_mult);
    expect(SM.BYBIT_NAME_ALIAS).toEqual(fx.maps.bybit_alias);
    expect(SM.BINANCE_MULTIPLIER).toEqual(fx.maps.binance_mult);
    expect(SM.BINANCE_NAME_ALIAS).toEqual(fx.maps.binance_alias);
    expect(Array.from(SM.MULT_PREFIXES)).toEqual(fx.maps.mult_prefixes);
    expect(Array.from(SM.NON_CRYPTO_PREFIXES)).toEqual(fx.maps.non_crypto_prefixes);
  });

  it(`every function on every input without a live set (${fx.inputs.length} inputs)`, () => {
    expect(fx.inputs.length).toBeGreaterThan(100);
    checkSnapshot(fx.no_live, 'no_live');
  });

  it('fromBingx / isNonCrypto on BingX names (prefix stripping, aliases, non-USDT → null)', () => {
    for (const [n, exp] of Object.entries(fx.from_bingx)) expect(SM.fromBingx(n), `fromBingx(${JSON.stringify(n)})`).toBe(exp);
    for (const [n, exp] of Object.entries(fx.is_non_crypto)) expect(SM.isNonCrypto(n), `isNonCrypto(${JSON.stringify(n)})`).toBe(exp);
  });

  it('rememberLive: falsy input keeps the set, a live set overrides names/multipliers, a new set replaces', () => {
    SM.rememberLive([]);
    SM.rememberLive([null, '']);
    expect(Array.from(SM.getLive()).sort()).toEqual(fx.live_after_empty);
    SM.rememberLive(fx.live_in);
    expect(Array.from(SM.getLive()).sort()).toEqual(fx.live_set);
    checkSnapshot(fx.live, 'live');
    SM.rememberLive(['BTC-USDT']);
    expect(Array.from(SM.getLive()).sort()).toEqual(fx.live_replaced);
    for (const [s, exp] of Object.entries(fx.live_replaced_snap)) {
      expect(SM.resolve(s)).toEqual(exp.resolve);
      expect(SM.toBingxSymbol(s)).toBe(exp.to_bingx_symbol);
      expect(SM.bingxPriceMultiplier(s)).toBe(exp.bingx_price_multiplier);
    }
  });
});
