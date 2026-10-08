'use strict';
/**
 * bingxRest.js — BingX Perpetual Swap market data (`fetcher_bingx.BingXFetcher`).
 *
 *   getCandles(symbol, tf, limit=300, retries=2) → Frame | null   (closed bars only)
 *   checkSymbol(symbol) → boolean
 *   getAllUsdtPairs(minVolumeUsdt=1e6, blacklist=[], maxCoins=0) → string[]  (+ volBySym side effect, 120 s cache)
 *   get24hChange(symbol) → { last, price, change_pct, change_pct_24h, volume_usdt, vol_24h_usdt } | null
 *
 * Canonical symbols in, canonical symbols out; prices divided by the BingX
 * multiplier (OKX units); volume = base × close (USDT). Every request goes through
 * the shared rate gate (15 r/s burst 10 + 8 concurrent). Error handling (`getJson`):
 * 429 → sleep Retry-After (default 3 s) and null; non-200 → null; non-object JSON →
 * null; `code` not in (0,"0",null) → null and, for 109418 (offline) / 109425 (not
 * exist), the symbol is marked dead for 3600 s (`isDead` → `getCandles` returns null
 * without a request). `[BINGX-DATA]` warnings at most once per 60 s.
 */

const { fetchJson, isTimeout } = require('./httpClient');
const { sharedGate, recordRateLimitHit, defaultSleep } = require('./rateGate');
const { log: defaultLog } = require('./mdLog');
const sym = require('./symbolMap');
const { TF_TO_BINGX, MAX_KLINES, rowsToFrame, pyFloat, pyInt, pyFalsy } = require('./candleFrame');

const BINGX_BASE = 'https://open-api.bingx.com';
const BINGX_KLINES = `${BINGX_BASE}/openApi/swap/v3/quote/klines`;
const BINGX_TICKER = `${BINGX_BASE}/openApi/swap/v2/quote/ticker`;
const BINGX_CONTRACTS = `${BINGX_BASE}/openApi/swap/v2/quote/contracts`;

const DEAD_CODES = new Set(['109418', '109425']); // offline / not exist
const DEAD_TTL_S = 3600;
const PAIRS_CACHE_TTL_S = 120;
const PAIRS_CACHE_MAX_KEYS = 20;

function isPlainObject(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
function isLiveStatus(st) { return ['1', 'True', 'true'].includes(String(st === undefined ? 1 : st)); }
function codeOk(code) { return code === 0 || code === '0' || code === null || code === undefined; }

/**
 * `/quote/contracts` rows → { liveRaw: BingX names (status 1, crypto only), canon: Set of canonical }.
 * Shared by getAllUsdtPairs and the WS preload.
 */
function parseContracts(rows) {
  const liveRaw = [];
  const canon = new Set();
  for (const c of rows || []) {
    if (!isPlainObject(c)) continue;
    if (!isLiveStatus(c.status)) continue;
    const name = c.symbol || '';
    if (sym.isNonCrypto(name)) continue;
    liveRaw.push(name);
    const cn = sym.fromBingx(name);
    if (cn) canon.add(cn);
  }
  return { liveRaw, canon };
}

class BingxRest {
  constructor({ http = fetchJson, gate = sharedGate, now = () => Date.now(), sleep = defaultSleep, log = defaultLog } = {}) {
    this._http = http;
    this._gate = gate;
    this._now = now;
    this._sleep = sleep;
    this._log = log;
    this.source = 'bingx';
    this.volBySym = {}; // canonical symbol → 24 h USDT volume (only symbols that passed the threshold of the last call)
    this.lastError = null;
    this._dead = new Map(); // symbol → expiry (s)
    this._pairsCache = new Map();
    this._lastFailLog = 0;
    this.apiCalls = 0;
  }

  // ── dead symbols ──────────────────────────────────────────────────────────
  markDead(symbol, ttlS = DEAD_TTL_S) { this._dead.set(symbol, this._now() / 1000 + ttlS); }
  isDead(symbol) { return (this._dead.get(symbol) || 0) > this._now() / 1000; }

  _fail(reason) {
    this.lastError = reason;
    const now = this._now() / 1000;
    if (now - this._lastFailLog >= 60) {
      this._lastFailLog = now;
      this._log.warning(`[BINGX-DATA] ${reason}`);
    }
  }

  /** The gated GET + BingX envelope validation. Returns the parsed body or null. */
  async getJson(url, params = {}, { timeoutMs = 20_000, symbol = '', timeframe = '' } = {}) {
    this.apiCalls += 1;
    const data = await this._gate.run(async () => {
      const resp = await this._http(url, { params, timeoutMs });
      if (resp.status === 429) {
        const h = resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null;
        const wait = h === null || h === undefined ? 3 : pyInt(h);
        recordRateLimitHit(symbol || url, timeframe, wait, { now: () => this._now() / 1000, log: this._log });
        await this._sleep(wait * 1000);
        return null;
      }
      if (resp.status !== 200) {
        const body = String(resp.text ?? '').slice(0, 300);
        this._fail(`HTTP ${resp.status} ${url} params=${JSON.stringify(params)} body=${JSON.stringify(body)}`);
        return null;
      }
      return resp.json === undefined ? null : resp.json;
    });
    if (data === null) return null;
    if (!isPlainObject(data)) {
      this._fail(`non-dict JSON from ${url}: ${JSON.stringify(String(JSON.stringify(data)).slice(0, 200))}`);
      return null;
    }
    if (!codeOk(data.code)) {
      this._fail(`${url} params=${JSON.stringify(params)} code=${data.code} msg=${JSON.stringify(data.msg ?? null)}`);
      if (DEAD_CODES.has(String(data.code)) && symbol) this.markDead(symbol);
      return null;
    }
    return data;
  }

  /**
   * Closed candles for a canonical symbol. Unknown timeframe silently becomes '1h'
   * (QUIRK data-and-market §7.3 #8 — the OKX fetcher returned None instead).
   */
  async getCandles(symbol, timeframe, limit = 300, retries = 2) {
    if (this.isDead(symbol)) return null;
    const tf = TF_TO_BINGX[timeframe] ?? '1h'; // QUIRK(spec §7.3): unknown TF → 1h
    const canon = sym.toOkx(symbol);
    const bsym = sym.toBingx(canon);
    const params = {
      symbol: bsym,
      interval: tf,
      limit: String(Math.min(pyInt(limit), MAX_KLINES)),
      timestamp: String(Math.trunc(this._now())),
    };
    const mult = sym.priceMultiplier(canon);
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const data = await this.getJson(BINGX_KLINES, params, { symbol, timeframe });
        if (data !== null) return rowsToFrame(data.data || [], tf, mult, this._now());
        if (this.isDead(symbol)) return null; // no contract — no retries
      } catch (e) {
        if (isTimeout(e)) this._fail(`${symbol} timeout (попытка ${attempt}) — нет ответа от ${BINGX_BASE}`);
        else this._fail(`${symbol} ${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e} (попытка ${attempt})`);
      }
      if (attempt < retries) await this._sleep(1000 * attempt);
    }
    return null;
  }

  /** klines interval=1h limit=2 has data. */
  async checkSymbol(symbol) {
    try {
      const data = await this.getJson(
        BINGX_KLINES,
        { symbol: sym.toBingx(sym.toOkx(symbol)), interval: '1h', limit: '2' },
        { timeoutMs: 8000, symbol },
      );
      return !!(data && !pyFalsy(data.data));
    } catch (e) {
      this._log.warning(`bingxRest.checkSymbol() unhandled exception: ${e && e.message}`);
      return false;
    }
  }

  /** `/quote/contracts` → parsed body or null (also used by the WS preload / exchangeSymbols). */
  async fetchContracts() { return this.getJson(BINGX_CONTRACTS, {}); }

  /**
   * Canonical symbols sorted by 24 h USDT volume desc, filtered by `minVolumeUsdt`,
   * blacklist and `maxCoins` (0 = no cap). Side effects: `rememberLive`, `volBySym`
   * (ONLY the symbols that passed the threshold of this call — spec §6.1 quirk),
   * 120 s result cache keyed by (minVolume, maxCoins, blacklist), ≤ 20 keys.
   */
  async getAllUsdtPairs(minVolumeUsdt = 1_000_000, blacklist = null, maxCoins = 0) {
    const bl = blacklist || [];
    const cacheKey = `pairs_${minVolumeUsdt}_${maxCoins}_${bl.slice().sort().join(',').slice(0, 200)}`;
    const cached = this._pairsCache.get(cacheKey);
    const nowS = this._now() / 1000;
    if (cached && nowS - cached.ts < PAIRS_CACHE_TTL_S) return cached.coins.slice();
    try {
      const [contracts, tickers] = await Promise.all([
        this.getJson(BINGX_CONTRACTS, {}),
        this.getJson(BINGX_TICKER, {}),
      ]);
      if (contracts === null) return [];
      const { liveRaw, canon: liveAll } = parseContracts(contracts.data || []);
      const live = new Set(Array.from(liveAll).filter((c) => !bl.includes(c)));
      sym.rememberLive(liveRaw);
      if (tickers === null) return Array.from(live).sort();
      const filtered = [];
      for (const t of tickers.data || []) {
        if (!isPlainObject(t)) continue;
        const cn = sym.fromBingx(t.symbol || '');
        if (!cn || !live.has(cn)) continue;
        let vol;
        try { vol = pyFloat(pyFalsy(t.quoteVolume) ? 0 : t.quoteVolume); } catch (_e) { vol = 0.0; }
        if (vol >= minVolumeUsdt) filtered.push([cn, vol]);
      }
      filtered.sort((a, b) => b[1] - a[1]); // stable, desc
      const volBySym = {};
      for (const [s, v] of filtered) volBySym[s] = v;
      this.volBySym = volBySym;
      let coins = filtered.map(([s]) => s);
      if (maxCoins && maxCoins > 0) coins = coins.slice(0, maxCoins);
      this._pairsCache.set(cacheKey, { ts: this._now() / 1000, coins: coins.slice() });
      if (this._pairsCache.size > PAIRS_CACHE_MAX_KEYS) {
        let oldestKey = null, oldestTs = Infinity;
        for (const [k, v] of this._pairsCache) if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
        this._pairsCache.delete(oldestKey);
      }
      return coins;
    } catch (e) {
      this._log.error(`BingX: ошибка загрузки монет: ${e && e.message ? e.message : e}`);
      return [];
    }
  }

  /** Ticker → { last, price, change_pct, change_pct_24h, volume_usdt, vol_24h_usdt } in OKX units. */
  async get24hChange(symbol) {
    try {
      const canon = sym.toOkx(symbol);
      const data = await this.getJson(BINGX_TICKER, { symbol: sym.toBingx(canon) }, { symbol });
      if (!data) return null;
      let t = data.data;
      if (Array.isArray(t)) t = t.length ? t[0] : null;
      if (!t || !isPlainObject(t)) return null;
      const mult = sym.priceMultiplier(canon);
      const num = (v) => pyFloat(pyFalsy(v) ? 0 : v);
      const last = num(t.lastPrice) / mult;
      const op = num(t.openPrice) / mult;
      let chg;
      if (t.priceChangePercent !== null && t.priceChangePercent !== undefined && t.priceChangePercent !== '') {
        chg = pyFloat(String(t.priceChangePercent).replace(/%+$/, ''));
      } else {
        chg = op ? ((last - op) / op) * 100 : 0.0;
      }
      const vol = num(t.quoteVolume);
      return {
        last, price: last,
        change_pct: chg, change_pct_24h: chg,
        volume_usdt: vol, vol_24h_usdt: vol,
      };
    } catch (e) {
      this._log.warning(`bingxRest.get24hChange() unhandled exception: ${e && e.message}`);
    }
    return null;
  }

  /** Tests / diagnostics. */
  _resetPairsCache() { this._pairsCache.clear(); }
}

let _shared = null;
/** One client per process (the bot created several fetchers sharing one gate; one is enough here). */
function getRest(opts) {
  if (!_shared) _shared = new BingxRest(opts);
  return _shared;
}
function _resetShared() { _shared = null; }

module.exports = {
  BingxRest, getRest, _resetShared, parseContracts, isLiveStatus, codeOk, isPlainObject,
  BINGX_BASE, BINGX_KLINES, BINGX_TICKER, BINGX_CONTRACTS, DEAD_CODES, DEAD_TTL_S, PAIRS_CACHE_TTL_S,
};
