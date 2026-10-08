# Exchange-trader parity generators

The JS traders in `backend/services/exchanges/` are verified against the bot's own Python code
(`/home/user/MAIN_BOT/CHM_BREAKER_V4`, read-only). These scripts run the bot modules offline and
write the fixtures under `../fixtures/`; the vitest suites replay them.

Run from the bot checkout with the production interpreter (CPython 3.11 + the bot's pinned requirements;
no network is used — every HTTP call is scripted):

```sh
cd /home/user/MAIN_BOT/CHM_BREAKER_V4
export BOT_TOKEN_CHM=test:token ADMIN_IDS=123
PY=<python3.11 venv>/bin/python
$PY /path/to/backend/tests/exchanges/py/gen_pure_vectors.py              # → pure_vectors.json
$PY /path/to/backend/tests/exchanges/py/gen_trader_scenarios.py          # → scenarios_{bybit,bingx,binance,okx}.json
$PY /path/to/backend/tests/exchanges/py/gen_balance_cache.py             # → balance_cache.json
$PY /path/to/backend/tests/exchanges/py/gen_format_vectors.py            # → format_vectors.json
$PY /path/to/backend/tests/exchanges/py/gen_adversarial.py               # → adversarial_{bybit,bingx,binance,okx}.json
env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
  $PY /path/to/backend/tests/exchanges/py/gen_net_errors.py              # → net_errors.json (local sockets only)
rm -f signal_registry.json   # the bot's import side effect
```

| Script | Bot code driven | JS test |
|---|---|---|
| `gen_pure_vectors.py` | price_precision, order_id_utils, tp_ladder_fit, api_retry, exchange_breaker, classifiers, signatures (`_sign`, `_build_query`, pybit `_auth`, OKX `_iso_timestamp`), humanizers, symbol maps, CPython repr/quote/urlencode/float | `pureHelpers.test.js`, signature blocks of the trader tests |
| `gen_trader_scenarios.py` + `scen_<exchange>.py` + `harness.py` | the four `*_trader.py` coroutines with a fake clock, scripted HTTP (pybit `requests.Session.send` / aiohttp sessions), stubbed killswitch / plan gate / metrics / hedge-mode DB | `bybitTrader.test.js`, `bingxTrader.test.js`, `binanceTrader.test.js`, `okxTrader.test.js` |
| `gen_balance_cache.py` | `balance_cache.get_cached_balance` / `gc_cache` with stubbed `get_balance` | `adapter.test.js` |
| `gen_format_vectors.py` | `format_trade_result` ×4, bybit `format_trade_result_split` | `formatTradeResult.test.js` |
| `gen_adversarial.py` + `wire.py` (+ `harness.py`) | seeded random scenarios per exchange: 30 orders (direction, Market/Limit, risk modes, qty right at qtyStep boundaries, 1000x/10000x symbols, hedge/one-way, ladders, Bybit split, close/cancel/trailing/BE), 10 recorded error replays (rate limit, auth, benign 34040/10001/-4061/-4028/109400/51000…), 16 reads + 10 hand-written flows with type-preserving fuzzed bodies / injected failures. `wire.py` also sends every request through the REAL aiohttp / requests client to a local echo server and records the bytes (method, request-target, headers, body) | `adversarial.test.js` (also sends each JS request through the production `fetchTransport` to a local echo server and compares the wire) |
| `gen_net_errors.py` | real failures (DNS, refused, server close / RST, truncated Content-Length / chunked body, silent server, HTML 502) through aiohttp 3.14, requests 2.x, the bot's bingx/binance/okx `_request` and a pybit session | `netErrors.test.js` (production transport + `bybitHttp.requestsError` + JS `_request`) |

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

## Exploration sweeps (not committed)

`gen_adversarial.py --seed N --orders 150 [--extreme] [--reads 300 --fuzz 300] [--cross-type] --out DIR`
writes the same fixture format to DIR; replay it with
`ADV_FIXTURES=DIR npx vitest run tests/exchanges/adversarial.test.js`. `--extreme` widens prices,
SL distances, risk, leverage and balances; `--cross-type` fuzzes with values of another JSON type
(bool where a number was, int where a str was, …). Known, not reproduced in that mode: Python's
`False == 0`, `'1,5' < 0` / `None >= 0` TypeErrors outside the Binance `code` checks, `.upper()`
on non-str fields — the JS port coerces there. Integers beyond 2**53 and integral JSON floats
(`0.0`, `1e20`) are never fuzzed: JSON.parse cannot keep Python's int/float distinction for them.
