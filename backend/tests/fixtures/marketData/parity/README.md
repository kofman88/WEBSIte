# Bot-parity fixtures for the market-data layer (M8)

Every JSON file here was produced by the bot's own Python code (`/home/user/MAIN_BOT/CHM_BREAKER_V4`,
read-only source of truth) by the generator of the same name in `gen/`. The vitest files
`backend/tests/marketData/botParity.*.test.js` replay the same inputs through the JS port and
compare value for value.

| Fixture | Generator | Bot code exercised | JS under test |
|---|---|---|---|
| `rows_to_df.json` | `gen/gen_rows_to_df.py` | `fetcher_bingx._rows_to_df` on 44 synthetic `/v3/quote/klines` payloads | `candleFrame.rowsToFrame`, `pyInt`, `pyFloat` |
| `symbols.json` | `gen/gen_symbols.py` | `fetcher_bingx.resolve/to_bingx/from_bingx/price_multiplier/_base_of/is_non_crypto/remember_live`, `bingx_trader.to_bingx_symbol/bingx_price_multiplier`, `bybit_trader.*`, `binance_trader.*`, `fetcher.OKXFetcher._to_okx` | `symbolMap` |
| `ttl_cache.json` | `gen/gen_ttl_cache.py` | `cache.TTLCache`, `cache.get/set_candles`, `get/set_coins` | `candleCache` |
| `ws_state.json` | `gen/gen_ws_state.py` | `ws_feed_bingx.BingXWebSocketFeed._on_kline/_close_stale_bars/_handle_message` + `ws_feed._update_cache/_initial_load/_fire_bar_close` | `bingxWsFeed` |
| `candle_store.json` | `gen/gen_candle_store.py` | `candle_store.ensure_candles/_adaptive_freshness_ms/prefetch_top_coins/cleanup`, `backtest.BingXHistoryLoader.load/get_top_coins` | `candleStore` |

Regenerate (bot venv, any cwd — the scripts chdir into the bot):

```
cd backend/tests/fixtures/marketData/parity
for g in rows_to_df symbols ttl_cache ws_state candle_store; do
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 BOT_DIR=/home/user/MAIN_BOT/CHM_BREAKER_V4 \
    /path/to/bot/venv/bin/python gen/gen_$g.py > $g.json
done
rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json   # side effect of importing the bot
```

Known, documented deviations (asserted explicitly in the tests): candle-cache keys are normalised
(`PORT_DECISIONS` D6), and `candleStore.getCoverage` is MIN/MAX over the stored rows instead of the
bot's `candle_meta` table (identical decisions for `days ≤ 365`).
