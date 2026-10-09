# Wire-level differential: auto-trade vs the bot

`wireDiff.test.js` replays every vector of `fixtures/wire_diff.json.gz` through the site's
production auto-trade entry point and demands the bot's exact wire behaviour.

| file | role |
| --- | --- |
| `py/fake_exchanges.py` | stateful Bybit / BingX / Binance / OKX: accounts, balances, position modes, positions, resting / conditional orders, fills on price moves, HMAC verification, every error class, faults (hang before / after accept, refused connect, HTTP status, slow answers) |
| `py/drive_wire_diff.py` | the bot's own `execute_auto_trade` (CPython 3.11, its DB layer on a temp SQLite) on a virtual-time event loop: the clock jumps only when every coroutine **and** every pybit executor thread is idle; records per task every request (normalised), answer, message, log, trader marker, metric, side effect, then the DB tables |
| `harness.js` | the JS twin: `createAutoTrade` with the real traders on an in-memory site DB and the virtual clock (`../core/vclock.js`); a replay transport serves, per task, the next answer the bot got |
| `compare.js` | the comparison (also a CLI: `node tests/autotrade/wire/compare.js [fixture] [name …|prefix*]`) |
| `cancelSemantics.test.js` | the asyncio cancellation rules the differential found, pinned at the unit level |

Scenarios: 64 seeded random users (`WIRE_SEED` 20261009) over the four exchanges plus the targeted
families (`tgt_<ex>_<class>`, `tgt2_<ex>_<path rejection>_{main,ptp}`, edges, confirm, prop pilot,
challenge daily stop, correlation cap, kill switch, plan expired, slow exchanges, BingX batch
answers, …). `WIRE_ONLY=a,b` limits a run; `WIRE_USERS` changes the random count.

Regenerate (the bot tree is read-only — nothing is written there except the bot's own
`signal_registry.json`, removed afterwards):

```
cd /home/user/MAIN_BOT/CHM_BREAKER_V4
BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> <site>/backend/tests/autotrade/wire/py/drive_wire_diff.py \
  <site>/backend/tests/autotrade/wire/fixtures/wire_diff.json.gz
rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
```

Comparison notes (each one a property of the bot's process, not a tolerance on the port):
the once-per-process «Circuit Breaker ОТКЛЮЧЁН» warning is counted over all tasks; trade_events are
compared per trade; with parallel calls the idempotency uuid suffix is normalised (lock-arrival
order); `trade_placement_latency_ms` is compared to the 2 ms bucket (float accumulation order of
virtual sleeps); the `[SKIP-AFTER-TP-PLACED]` stack suffix is cut.
