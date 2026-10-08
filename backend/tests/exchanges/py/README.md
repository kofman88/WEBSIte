# Exchange-trader parity generators

The JS traders in `backend/services/exchanges/` are verified against the bot's own Python code
(`/home/user/MAIN_BOT/CHM_BREAKER_V4`, read-only). These scripts run the bot modules offline and
write the fixtures under `../fixtures/`; the vitest suites replay them.

Run from the bot checkout with the parity venv (no network is used — every HTTP call is scripted):

```sh
cd /home/user/MAIN_BOT/CHM_BREAKER_V4
export BOT_TOKEN_CHM=test:token ADMIN_IDS=123
PY=<scratchpad>/venv/bin/python
$PY /path/to/backend/tests/exchanges/py/gen_pure_vectors.py              # → pure_vectors.json
$PY /path/to/backend/tests/exchanges/py/gen_trader_scenarios.py          # → scenarios_{bybit,bingx,binance,okx}.json
$PY /path/to/backend/tests/exchanges/py/gen_balance_cache.py             # → balance_cache.json
$PY /path/to/backend/tests/exchanges/py/gen_format_vectors.py            # → format_vectors.json
rm -f signal_registry.json   # the bot's import side effect
```

| Script | Bot code driven | JS test |
|---|---|---|
| `gen_pure_vectors.py` | price_precision, order_id_utils, tp_ladder_fit, api_retry, exchange_breaker, classifiers, signatures (`_sign`, `_build_query`, pybit `_auth`, OKX `_iso_timestamp`), humanizers, symbol maps, CPython repr/quote/urlencode/float | `pureHelpers.test.js`, signature blocks of the trader tests |
| `gen_trader_scenarios.py` + `scen_<exchange>.py` + `harness.py` | the four `*_trader.py` coroutines with a fake clock, scripted HTTP (pybit `requests.Session.send` / aiohttp sessions), stubbed killswitch / plan gate / metrics / hedge-mode DB | `bybitTrader.test.js`, `bingxTrader.test.js`, `binanceTrader.test.js`, `okxTrader.test.js` |
| `gen_balance_cache.py` | `balance_cache.get_cached_balance` / `gc_cache` with stubbed `get_balance` | `adapter.test.js` |
| `gen_format_vectors.py` | `format_trade_result` ×4, bybit `format_trade_result_split` | `formatTradeResult.test.js` |

## Scenario format (harness.py)

`{name, exchange, call, args, kwargs, routes, state, random, clock, mode}`

* `routes`: `[{method, path, query?, responses: [...]}]` — matched by method + URL path (+ optional
  query substring); responses are served in order and the last one repeats; unmatched → 404 text.
  A response is `{status, json|text, headers}` or `{raise: timeout|connect|error, message}`.
  The generator freezes `json` into the exact `text` the fake served.
* `state`: seeds caches/offsets (`account_type`, `hedge`, `kv_hedge`, `time_offset_ms`,
  `bingx_offset_ms`, `binance_offset_ms`, `okx_offset_ms`, `live_bingx`, `ks_halted`,
  `plan_deny`, `auth_uids`).
* `mode: "session"` (Bybit only) replaces pybit's HTTP object with a fake returning scripted dicts
  (the way the bot's own unit tests mock it).

Each fixture row stores what the bot did: every request (method, full URL as sent on the wire
after yarl requoting, auth headers, body), the result or raised exception, the sleeps, log
markers (`[UPPER-CASE]` tags with level), metrics names and final caches. The JS replay
(`../replay.js`) feeds the same response bytes to the JS trader and compares all of it.
