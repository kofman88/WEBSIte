# Market-data layer (M8)

One-to-one port of the bot's BingX data pipeline (`fetcher_bingx.py`, `fetcher.py`,
`ws_feed.py` + `ws_feed_bingx.py`, `cache.py`, `cache_warmer.py`, `candle_store.py`,
`exchange_symbols.py`, universe selection of `bot.py`). Spec: `data-and-market.md` §6–§8.

| Module | Bot source | What it holds |
|---|---|---|
| `httpClient.js` | aiohttp session | `fetchJson(url, {params, timeoutMs})` → `{status, headers, json, text}`; UA / Accept-Encoding of the bot; `TimeoutError` |
| `rateGate.js` | `OKXFetcher._gate` | token bucket 15 r/s burst 10 (8 s acquire timeout) + Semaphore(8), one `sharedGate` per process; `[OKX-429-BURST]` throttle |
| `symbolMap.js` | `fetcher_bingx` + trader maps | `resolve/toBingx/fromBingx/priceMultiplier` with the live-contract override, `toOkx`, `toBybitSymbol/toBinanceSymbol/toBingxSymbol` |
| `candleFrame.js` | `_rows_to_df` | `rowsToFrame(rows, tfBingx, mult, nowMs)` → engine `Frame` (closed bars, USDT volume, OKX prices); TF tables (`TF_TO_BINGX`, `TF_MS`, `TF_NORM`, `TTL_MAP`, `CACHE_TTL`); python-faithful `pyInt/pyFloat` |
| `candleCache.js` | `cache.py` | ordered-LRU `TTLCache` (cap 4000), `initCache/getCandles/setCandles/getCoins/setCoins/cacheStats`; **D6: keys normalised** (`_1h` → `_1H`) |
| `bingxRest.js` | `BingXFetcher` | `getCandles/checkSymbol/getAllUsdtPairs/get24hChange`, dead symbols 1 h, `volBySym`, 120 s pairs cache |
| `bingxWsFeed.js` | `BingXWebSocketFeed` | gzip frames, Ping/Pong, subscribe batching 10/0.1 s, bar state machine, `_updateCache` semantics, watchdog 300 s, backoff 1→30 s, bar-close bus (`registerOnBarClose`) |
| `wsPool.js` | `run_ws_feed`, `bot._start_ws_feed` | universe (coins cache → `getAllUsdtPairs(500000)` → top-150), `requiredShards`, round-robin shards, initial REST fill, `runWsPool` |
| `cacheWarmer.js` | `CacheWarmer` | per-shard throttled fill of cold channels (5 r/s, 30 s, reservation pattern, [WS-REFILL]) |
| `candleStore.js` | `candle_store.py`, `BingXHistoryLoader` | `candles_cache(exchange='bingx')`: `ensureCandles` (2 h freshness, ≥ 50 rows, Semaphore(3)), prefetch loop, 365-day cleanup, `HistoryLoader` paging 1440 bars backwards |
| `globalTrend.js` | `fetcher.get_global_trend` | BTC/ETH `H1 | H4 | D1 | W1` marks on EMA 50/200 (1W 20/50, 1M 10/20), cached `TREND_UPDATE_INTERVAL` |
| `../exchanges/exchangeSymbols.js` | `exchange_symbols.py` | native symbol sets of Bybit/BingX/Binance/OKX, 4 h refresh, `isAvailable(strict)` |

Conventions: canonical symbol `XXX-USDT-SWAP`; prices in OKX units (BingX ×1000 coins divided
by `priceMultiplier` on ingest); candle index = open time in ms, ascending, **last row = last
closed bar**; cache/WS timeframes `15m 1H 4H 1D`.

Deliberate deviations (recorded here and in the M8 report):

* D6 — cache keys are normalised, so LEVELS on `1h/4h/1d` shares the WS entries instead of
  REST-loading its own copy (bot quirk §7.6 #1).
* `WS_FEED_MAX_SYMBOLS` defaults to 150 (PLAN §2.2 budget); the bot used 300 under
  `DATA_SOURCE=bingx` when the env was unset.
* `candleStore.cleanup` does not `VACUUM` by default (the table lives in the shared site DB).
* The receive loop is event-driven (`ws` package) — frames are still processed one at a time;
  the 30 s receive timeout of the bot is covered by the watchdog alone.

Smoke: `node backend/utils/smoke-market.js` (needs outbound access to `open-api.bingx.com`).
Tests: `backend/tests/marketData/*.test.js`, `backend/tests/exchanges/exchangeSymbols.test.js`;
WS frame fixtures: `backend/tests/fixtures/marketData/ws-frames` (`make-ws-frames.js`).
