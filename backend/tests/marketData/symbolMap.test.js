/**
 * symbolMap.js — resolve / toBingx / fromBingx / priceMultiplier tables, live-contract
 * override, and the Bybit / Binance / BingX trader naming (values printed by the bot's
 * own Python: fetcher_bingx.resolve, bingx_trader.to_bingx_symbol,
 * bybit_trader.to_bybit_symbol, binance_trader.to_binance_symbol).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const S = req('../../services/marketData/symbolMap.js');

beforeEach(() => S._setLive([]));

describe('BingX resolve / toBingx / fromBingx (static map)', () => {
  it.each([
    ['BTC-USDT-SWAP', 'BTC-USDT', 1],
    ['PEPE-USDT-SWAP', '1000PEPE-USDT', 1000],
    ['TON-USDT-SWAP', 'TONCOIN-USDT', 1],
    ['SATS-USDT-SWAP', '10000SATS-USDT', 10000],
    ['BABYDOGE-USDT-SWAP', '1000000BABYDOGE-USDT', 1000000],
    ['MOG-USDT-SWAP', '1000000MOG-USDT', 1000000],
    ['LUNC-USDT-SWAP', '1000LUNC-USDT', 1000],
    ['BTCUSDT', 'BTC-USDT', 1],
    ['btc-usdt', 'BTC-USDT', 1],
    ['1INCH-USDT-SWAP', '1INCH-USDT', 1],
    ['SHIB-USDT-SWAP', 'SHIB-USDT', 1],
  ])('resolve(%s) → [%s, %s]', (canon, name, mult) => {
    expect(S.resolve(canon)).toEqual([name, mult]);
    expect(S.toBingx(canon)).toBe(name);
    expect(S.priceMultiplier(canon)).toBe(mult);
    expect(S.toBingxSymbol(canon)).toBe(name);
    expect(S.bingxPriceMultiplier(canon)).toBe(mult);
  });

  it.each([
    ['BTC-USDT', 'BTC-USDT-SWAP'],
    ['1000PEPE-USDT', 'PEPE-USDT-SWAP'],
    ['1000pepe-usdt', 'PEPE-USDT-SWAP'],
    ['10000SATS-USDT', 'SATS-USDT-SWAP'],
    ['1000000BABYDOGE-USDT', 'BABYDOGE-USDT-SWAP'],
    ['TONCOIN-USDT', 'TON-USDT-SWAP'],
    ['1INCH-USDT', '1INCH-USDT-SWAP'],
    ['1000-USDT', '1000-USDT-SWAP'],      // prefix only stripped when followed by a non-digit
    ['10001-USDT', '10001-USDT-SWAP'],
    ['1000NEWCOIN-USDT', 'NEWCOIN-USDT-SWAP'],
  ])('fromBingx(%s) → %s', (bingx, canon) => {
    expect(S.fromBingx(bingx)).toBe(canon);
  });

  it('fromBingx rejects non-USDT contracts', () => {
    expect(S.fromBingx('BTC-USDC')).toBe(null);
    expect(S.fromBingx('')).toBe(null);
    expect(S.fromBingx(null)).toBe(null);
  });

  it('roundtrips the bot test table', () => {
    for (const [canon, bingx] of [
      ['BTC-USDT-SWAP', 'BTC-USDT'], ['PEPE-USDT-SWAP', '1000PEPE-USDT'], ['SATS-USDT-SWAP', '10000SATS-USDT'],
      ['BABYDOGE-USDT-SWAP', '1000000BABYDOGE-USDT'], ['TON-USDT-SWAP', 'TONCOIN-USDT'],
      ['SHIB-USDT-SWAP', 'SHIB-USDT'], ['1INCH-USDT-SWAP', '1INCH-USDT'],
    ]) {
      expect(S.toBingx(canon)).toBe(bingx);
      expect(S.fromBingx(bingx)).toBe(canon);
    }
  });
});

describe('live contract set overrides the static map', () => {
  it('alias falls back to the live name (TONCOIN offline)', () => {
    S._setLive(['TON-USDT', 'BTC-USDT', '1000PEPE-USDT']);
    expect(S.toBingx('TON-USDT-SWAP')).toBe('TON-USDT');
    expect(S.toBingxSymbol('TON-USDT-SWAP')).toBe('TON-USDT');
    expect(S.toBingx('PEPE-USDT-SWAP')).toBe('1000PEPE-USDT');
    S._setLive(['TONCOIN-USDT']);
    expect(S.toBingx('TON-USDT-SWAP')).toBe('TONCOIN-USDT');
    expect(S.toBingxSymbol('TON-USDT-SWAP')).toBe('TONCOIN-USDT');
  });

  it('keeps name and multiplier consistent', () => {
    S._setLive(['LUNC-USDT', '1000PEPE-USDT', 'BTC-USDT', '1000NEWCOIN-USDT']);
    expect(S.resolve('LUNC-USDT-SWAP')).toEqual(['LUNC-USDT', 1]);
    expect(S.toBingxSymbol('LUNC-USDT-SWAP')).toBe('LUNC-USDT');
    expect(S.bingxPriceMultiplier('LUNC-USDT-SWAP')).toBe(1);
    expect(S.priceMultiplier('LUNC-USDT-SWAP')).toBe(1);
    expect(S.resolve('NEWCOIN-USDT-SWAP')).toEqual(['1000NEWCOIN-USDT', 1000]);
    expect(S.resolve('PEPE-USDT-SWAP')).toEqual(['1000PEPE-USDT', 1000]);
    expect(S.bingxPriceMultiplier('PEPE-USDT-SWAP')).toBe(1000);
  });

  it('candidate order: static pair, static base, alias, base, prefixes×alias, prefixes×base', () => {
    S._setLive(['TON-USDT', '1000TON-USDT']);
    expect(S.resolve('TON-USDT-SWAP')).toEqual(['TON-USDT', 1]);
    S._setLive(['1000TONCOIN-USDT']);
    expect(S.resolve('TON-USDT-SWAP')).toEqual(['1000TONCOIN-USDT', 1000]);
    S._setLive(['10000PEPE-USDT']);
    expect(S.resolve('PEPE-USDT-SWAP')).toEqual(['10000PEPE-USDT', 10000]);
    S._setLive(['XXX-USDT']); // nothing matches → first candidate
    expect(S.resolve('PEPE-USDT-SWAP')).toEqual(['1000PEPE-USDT', 1000]);
  });

  it('rememberLive ignores an empty update and upper-cases names', () => {
    S.rememberLive(['btc-usdt', '', null]);
    expect(Array.from(S.getLive())).toEqual(['BTC-USDT']);
    S.rememberLive([]);
    expect(Array.from(S.getLive())).toEqual(['BTC-USDT']);
  });
});

describe('helpers', () => {
  it('toOkx (fetcher._to_okx)', () => {
    expect(S.toOkx('BTCUSDT')).toBe('BTC-USDT-SWAP');
    expect(S.toOkx('BTC-USDT')).toBe('BTC-USDT');
    expect(S.toOkx('btc usdt')).toBe('btcusdt');
    expect(S.toOkx('BTC-USDT-SWAP')).toBe('BTC-USDT-SWAP');
  });

  it('baseOf', () => {
    expect(S.baseOf('btc usdt')).toBe('BTC');
    expect(S.baseOf('ETH-USD')).toBe('ETH');
    expect(S.baseOf('')).toBe('');
    expect(S.baseOf('PEPE-USDT-SWAP')).toBe('PEPE');
    expect(S.baseOf('1000PEPE-USDT')).toBe('1000PEPE');
  });

  it('isNonCrypto', () => {
    expect(S.isNonCrypto('NCCOGOLD2USD-USDT')).toBe(true);
    expect(S.isNonCrypto('NCSKTSLA2USD-USDT')).toBe(true);
    expect(S.isNonCrypto('NCSKTSLA-USDT')).toBe(true);
    expect(S.isNonCrypto('NEAR-USDT')).toBe(false);
    expect(S.isNonCrypto('BTC-USDT')).toBe(false);
    expect(S.isNonCrypto('')).toBe(false);
  });

  it('displaySymbol', () => {
    expect(S.displaySymbol('BTC-USDT-SWAP')).toBe('BTC');
    expect(S.displaySymbol('BTC-USDT')).toBe('BTC');
  });
});

describe('Bybit / Binance / OKX native names (trader maps)', () => {
  it.each([
    ['BTC-USDT-SWAP', 'BTCUSDT', 'BTCUSDT', 'BTC-USDT'],
    ['PEPE-USDT-SWAP', '1000PEPEUSDT', '1000PEPEUSDT', '1000PEPE-USDT'],
    ['SATS-USDT-SWAP', '10000SATSUSDT', '1000SATSUSDT', '10000SATS-USDT'],
    ['SHIB-USDT-SWAP', 'SHIB1000USDT', '1000SHIBUSDT', 'SHIB-USDT'],
    ['LUNA-USDT-SWAP', 'LUNA2USDT', 'LUNA2USDT', 'LUNA-USDT'],
    ['TURBO-USDT-SWAP', '1000TURBOUSDT', 'TURBOUSDT', 'TURBO-USDT'],
    ['TON-USDT-SWAP', 'TONUSDT', 'TONUSDT', 'TONCOIN-USDT'],
    ['BTCUSDT', 'BTCUSDT', 'BTCUSDT', 'BTC-USDT'],
    ['BTC-USDT', 'BTCUSDT', 'BTCUSDT', 'BTC-USDT'],
    ['FLOKI-USDT-SWAP', '1000FLOKIUSDT', '1000FLOKIUSDT', 'FLOKI-USDT'],
    ['1000PEPEUSDT', '1000PEPEUSDT', '1000PEPEUSDT', '1000PEPE-USDT'],
    ['SHIB1000USDT', 'SHIB1000USDT', 'SHIB1000USDT', 'SHIB1000-USDT'],
  ])('%s → bybit %s, binance %s, bingx %s', (okx, bybit, binance, bingx) => {
    expect(S.toBybitSymbol(okx)).toBe(bybit);
    expect(S.toBinanceSymbol(okx)).toBe(binance);
    expect(S.toBingxSymbol(okx)).toBe(bingx);
  });

  it('price multipliers per exchange', () => {
    expect(S.bybitPriceMultiplier('SATS-USDT-SWAP')).toBe(10000);
    expect(S.binancePriceMultiplier('SATS-USDT-SWAP')).toBe(1000);
    expect(S.bybitPriceMultiplier('SHIB-USDT-SWAP')).toBe(1);   // alias, not multiplier
    expect(S.binancePriceMultiplier('SHIB-USDT-SWAP')).toBe(1000);
    expect(S.bybitPriceMultiplier('BTC-USDT-SWAP')).toBe(1);
  });

  it('non-string input raises like `None.upper()`', () => {
    expect(() => S.toBybitSymbol(null)).toThrow(TypeError);
    expect(() => S.toBinanceSymbol(undefined)).toThrow(TypeError);
    expect(() => S.toBingxSymbol(42)).toThrow(TypeError);
  });
});
