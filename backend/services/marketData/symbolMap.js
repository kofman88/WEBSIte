'use strict';
/**
 * symbolMap.js — symbol conventions of the bot (`fetcher_bingx.py`, `fetcher._to_okx`,
 * `bingx_trader` / `bybit_trader` / `binance_trader` static maps).
 *
 * Canonical symbol everywhere: `XXX-USDT-SWAP` (OKX naming). The translation to
 * each exchange's native name happens only at the boundary:
 *   BTC-USDT-SWAP  ⇄ BTC-USDT          (BingX)
 *   PEPE-USDT-SWAP ⇄ 1000PEPE-USDT     (BingX, price ×1000)
 *   TON-USDT-SWAP  ⇄ TONCOIN-USDT      (BingX alias)
 *   SHIB-USDT-SWAP → SHIB1000USDT      (Bybit alias), 1000SHIBUSDT (Binance ×1000)
 *
 * Prices from BingX are divided by `priceMultiplier(symbol)` before they are stored
 * (OKX units); traders multiply back when sending orders.
 */

const { pyUpper } = require('../../strategies/common/pyUnicode');   // CPython 3.11 str case / whitespace methods
// ── BingX static maps (bingx_trader.py) ─────────────────────────────────────
const BINGX_MULTIPLIER = Object.freeze({
  BONK: 1000, PEPE: 1000, LUNC: 1000, XEC: 1000, CATS: 1000,
  SATS: 10000,
  BABYDOGE: 1000000, MOG: 1000000,
});
const BINGX_NAME_ALIAS = Object.freeze({ TON: 'TONCOIN' });
const MULT_PREFIXES = Object.freeze([1000000, 10000, 1000]);
const NON_CRYPTO_PREFIXES = Object.freeze(['NCCO', 'NCSK', 'NCSI', 'NCFX']);

// ── Bybit (bybit_trader.py) ─────────────────────────────────────────────────
const BYBIT_MULTIPLIER = Object.freeze({
  FLOKI: 1000, BONK: 1000, PEPE: 1000, LUNC: 1000, XEC: 1000, CATS: 1000, TURBO: 1000,
  SATS: 10000,
});
const BYBIT_NAME_ALIAS = Object.freeze({ SHIB: 'SHIB1000', LUNA: 'LUNA2' });

// ── Binance (binance_trader.py) ─────────────────────────────────────────────
const BINANCE_MULTIPLIER = Object.freeze({
  SHIB: 1000, FLOKI: 1000, BONK: 1000, PEPE: 1000, SATS: 1000, LUNC: 1000, XEC: 1000, CATS: 1000,
});
const BINANCE_NAME_ALIAS = Object.freeze({ LUNA: 'LUNA2' });

// Live (status=1) BingX contracts in their own format ("BTC-USDT", "1000PEPE-USDT").
// Filled by getAllUsdtPairs / the WS preload / exchangeSymbols. Needed so aliases
// (TON→TONCOIN) and multipliers survive BingX renames/delistings.
let _LIVE = new Set();

function isNonCrypto(bingxSymbol) {
  const base = pyUpper(String(bingxSymbol || '')).split('-')[0];
  return NON_CRYPTO_PREFIXES.some((p) => base.startsWith(p)) || base.includes('2USD');
}

/** Update the live contract set (after loading /quote/contracts). Empty input keeps the old set. */
function rememberLive(bingxSymbols) {
  const next = new Set();
  for (const s of bingxSymbols || []) if (s) next.add(pyUpper(String(s)));
  if (next.size) _LIVE = next;
}

function getLive() { return _LIVE; }
function _setLive(set) { _LIVE = new Set(Array.from(set || [], (s) => pyUpper(String(s)))); }

/** `fetcher.OKXFetcher._to_okx`: BTCUSDT → BTC-USDT-SWAP; everything else unchanged. */
function toOkx(symbol) {
  const s = String(symbol || '').replace(/ /g, '');
  if (s.endsWith('USDT') && !s.includes('-')) return `${s.slice(0, -4)}-USDT-SWAP`;
  return s;
}

/** `fetcher_bingx._base_of`: strip spaces, upper, strip -USDT-SWAP / -USDT / USDT; else part before '-'. */
function baseOf(symbol) {
  const s = pyUpper(String(symbol || '').replace(/ /g, ''));
  if (s.endsWith('-USDT-SWAP')) return s.slice(0, -10);
  if (s.endsWith('-USDT')) return s.slice(0, -5);
  if (s.endsWith('USDT')) return s.slice(0, -4);
  return s.split('-')[0];
}

/**
 * Canonical symbol → [bingx contract name, price multiplier].
 * Candidates in order: static (alias+mult), (base+mult), (alias,1), (base,1), then
 * every prefix × alias, every prefix × base. With a known live set the first live
 * candidate wins; otherwise the first candidate.
 */
function resolve(symbol) {
  const base = baseOf(symbol);
  const a = BINGX_NAME_ALIAS[base] || base;
  const m = Number(BINGX_MULTIPLIER[base] || 1) || 1;
  const cands = [
    [m > 1 ? `${m}${a}` : a, m],
    [m > 1 ? `${m}${base}` : base, m],
    [a, 1],
    [base, 1],
  ];
  for (const p of MULT_PREFIXES) cands.push([`${p}${a}`, p]);
  for (const p of MULT_PREFIXES) cands.push([`${p}${base}`, p]);
  if (_LIVE.size) {
    for (const [name, mult] of cands) {
      if (_LIVE.has(`${name}-USDT`)) return [`${name}-USDT`, mult];
    }
  }
  return [`${cands[0][0]}-USDT`, cands[0][1]];
}

/** Canonical (BTC-USDT-SWAP / BTCUSDT) → BingX (BTC-USDT). */
function toBingx(symbol) { return resolve(symbol)[0]; }

/** BingX (1000PEPE-USDT) → canonical (PEPE-USDT-SWAP); null when not a USDT contract. */
function fromBingx(bingxSymbol) {
  const s = pyUpper(String(bingxSymbol || ''));
  if (!s.endsWith('-USDT')) return null;
  let base = s.slice(0, -5);
  for (const p of MULT_PREFIXES) {
    const pre = String(p);
    if (base.startsWith(pre) && base.length > pre.length && !/[0-9]/.test(base[pre.length])) {
      base = base.slice(pre.length);
      break;
    }
  }
  const rev = Object.entries(BINGX_NAME_ALIAS).find(([, v]) => v === base);
  if (rev) base = rev[0];
  return `${base}-USDT-SWAP`;
}

/** How many times the BingX price exceeds the "OKX price" for this symbol (float). */
function priceMultiplier(symbol) { return Number(resolve(symbol)[1]); }

// ── Trader-side helpers (used by exchangeSymbols; traders re-export them in M13/M14) ──

function _requireString(symbol) {
  if (typeof symbol !== 'string') throw new TypeError(`'${symbol === null ? 'NoneType' : typeof symbol}' object has no attribute 'upper'`);
  return pyUpper(symbol);
}

function _stripOkxSuffixBingx(symbol) {
  const s = _requireString(symbol);
  if (s.endsWith('-USDT-SWAP')) return s.slice(0, -10);
  if (s.endsWith('USDT') && !s.includes('-')) return s.slice(0, -4);
  if (s.endsWith('-USDT')) return s.slice(0, -5);
  return s;
}

/** `bingx_trader.to_bingx_symbol`: static map, overridden by the live-resolved pair when known. */
function toBingxSymbol(symbol) {
  let base = _stripOkxSuffixBingx(symbol);
  base = BINGX_NAME_ALIAS[base] || base;
  const mult = BINGX_MULTIPLIER[base] || 1;
  if (mult > 1) base = `${mult}${base}`;
  const out = `${base}-USDT`;
  if (_LIVE.size) return resolve(symbol)[0];
  return out;
}

/** `bingx_trader.bingx_price_multiplier` */
function bingxPriceMultiplier(symbol) {
  if (_LIVE.size) return Number(resolve(symbol)[1]);
  return Number(BINGX_MULTIPLIER[_stripOkxSuffixBingx(symbol)] || 1);
}

function _stripOkxBaseBybit(symbol) {
  const s = _requireString(symbol);
  if (s.endsWith('-USDT-SWAP')) return s.slice(0, -10);
  if (s.endsWith('-USDT')) return s.slice(0, -5);
  return s.replace(/-/g, '').replace(/USDT/g, '');
}

/** `bybit_trader.to_bybit_symbol`: BTC-USDT-SWAP → BTCUSDT, PEPE → 1000PEPEUSDT, SHIB → SHIB1000USDT. */
function toBybitSymbol(symbol) {
  let base = _stripOkxBaseBybit(symbol);
  base = BYBIT_NAME_ALIAS[base] || base;
  const mult = BYBIT_MULTIPLIER[base] || 1;
  if (mult > 1) base = `${mult}${base}`;
  return `${base}USDT`;
}

function bybitPriceMultiplier(symbol) {
  return Number(BYBIT_MULTIPLIER[_stripOkxBaseBybit(symbol)] || 1);
}

function _stripOkxBaseBinance(symbol) {
  const s = _requireString(symbol);
  if (s.endsWith('-USDT-SWAP')) return s.slice(0, -10);
  if (s.endsWith('USDT') && !s.includes('-')) return s.slice(0, -4);
  if (s.endsWith('-USDT')) return s.slice(0, -5);
  return s;
}

/** `binance_trader.to_binance_symbol`: SATS → 1000SATSUSDT (×1000 on Binance, not ×10000). */
function toBinanceSymbol(symbol) {
  let base = _stripOkxBaseBinance(symbol);
  base = BINANCE_NAME_ALIAS[base] || base;
  const mult = BINANCE_MULTIPLIER[base] || 1;
  if (mult > 1) base = `${mult}${base}`;
  return `${base}USDT`;
}

function binancePriceMultiplier(symbol) {
  return Number(BINANCE_MULTIPLIER[_stripOkxBaseBinance(symbol)] || 1);
}

/** Display name: strips `-USDT-SWAP` / `-USDT`. */
function displaySymbol(symbol) {
  return String(symbol || '').replace(/-USDT-SWAP$/, '').replace(/-USDT$/, '');
}

module.exports = {
  BINGX_MULTIPLIER, BINGX_NAME_ALIAS, MULT_PREFIXES, NON_CRYPTO_PREFIXES,
  BYBIT_MULTIPLIER, BYBIT_NAME_ALIAS, BINANCE_MULTIPLIER, BINANCE_NAME_ALIAS,
  isNonCrypto, rememberLive, getLive, _setLive,
  toOkx, baseOf, resolve, toBingx, fromBingx, priceMultiplier,
  toBingxSymbol, bingxPriceMultiplier, toBybitSymbol, bybitPriceMultiplier,
  toBinanceSymbol, binancePriceMultiplier, displaySymbol,
};
