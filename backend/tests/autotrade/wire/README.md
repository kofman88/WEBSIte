# Wire-level differential: auto-trade vs the bot

`wireDiff.test.js` replays every vector of `fixtures/wire_diff.json.gz` through the site's
production auto-trade entry point and demands the bot's exact wire behaviour.

| file | role |
| --- | --- |
| `py/fake_exchanges.py` | stateful Bybit / BingX / Binance / OKX: accounts, balances, position modes, positions, resting / conditional orders, fills on price moves, HMAC verification, every error class, faults (hang before / after accept, refused connect, HTTP status, slow answers) |
| `py/drive_wire_diff.py` | the bot's own `execute_auto_trade` (CPython 3.11, its DB layer on a temp SQLite) on a virtual-time event loop: the clock jumps only when every coroutine **and** every pybit executor thread is idle, and timers due at the same instant fire in scheduling order (FIFO), like `../core/vclock.js`; records per task every request (normalised), answer, message, log, trader marker, metric, side effect, then the DB tables |
| `harness.js` | the JS twin: `createAutoTrade` with the real traders on an in-memory site DB and the virtual clock (`../core/vclock.js`); a replay transport serves, per task, the next answer the bot got |
| `compare.js` | the comparison (also a CLI: `node tests/autotrade/wire/compare.js [fixture] [name …|prefix*]`) |
| `cancelSemantics.test.js` | the asyncio cancellation rules the differential found, pinned at the unit level |
| `py/wire_routes.py` | `WIRE_MODE=routes`: the bot's Mini App key / position handlers and its exec / quick-close / SL→BE / progress buttons, session by session on one simulator; per step the requests, logs, markers, metrics, user / trade rows, trade_events and the D15 permission answer (signed by the bot's own code) |
| `wireRoutes.test.js` | the same sessions through the full Express app over a socket (JWT), the trade-ops registry on the bot's recording, the virtual clock (route wait_for timers included) moving only while no HTTP byte is in flight |

Scenarios: 64 seeded random users (`WIRE_SEED` 20261009) over the four exchanges plus the targeted
families (`tgt_<ex>_<class>`, `tgt2_<ex>_<path rejection>_{main,ptp}`, edges, confirm, prop pilot,
challenge daily stop, correlation cap, kill switch, plan expired, slow exchanges, BingX batch
answers, …) and the bot's batch D (`d2_*`, own rng, uids 9600+: VOLUME 15m vs 1h qty under
[VOL15-RISK-CAP] + [FEE-AWARE-SIZE], the fee factor off, the VOLUME 15m low-notional pause on a $25
account with a LEVELS trade still placing, [SAME-DIR-CAP] with two open LONG) and the per-user lock under
contention (`lock_parallel_same_symbol_<ex>`, uids 9700+: two signals on one symbol 1 ms apart, call0's
first in-lock price read answered after 1 s → call1 waits at the lock, then its dedup SKIPs it).
`WIRE_ONLY=a,b` limits a run; `WIRE_USERS` changes the random count.

Route sessions: 16 per exchange (`WIRE_SESSIONS`), seed 20261010: sessions 0-9 open the confirm-mode
trade under one exec error class each, 10-11 cleanly, 12-15 meet a key the site refuses (D15: withdraw
permission / unreadable permissions); keys are tested under faults (hang, 502, rate limit, refused
connect, bad key, wrong secret), positions under dashboard faults, quick close / SL→BE under close-path
faults. `WIRE_MODE=routes` writes `fixtures/wire_routes.json.gz`.

Regenerate (the bot tree is read-only — nothing is written there except the bot's own
`signal_registry.json`, removed afterwards):

```
cd /home/user/MAIN_BOT/CHM_BREAKER_V4
BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> <site>/backend/tests/autotrade/wire/py/drive_wire_diff.py \
  <site>/backend/tests/autotrade/wire/fixtures/wire_diff.json.gz
WIRE_MODE=routes BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> <site>/backend/tests/autotrade/wire/py/drive_wire_diff.py \
  <site>/backend/tests/autotrade/wire/fixtures/wire_routes.json.gz
rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
```

A simulator crash is recorded (`sim_errors`) and fails the tests — it would otherwise look like an
exchange answer.

Comparison notes (each one a property of the bot's process, not a tolerance on the port):
the scenarios that reach a D18 site branch (`D18_FIRES` in wireDiff.test.js: slow_all_bingx — its
retry is answered «duplicate clientOrderId» since [MARKET-ENTRY-NO-SHIFT]) are compared in bot mode
(`d18: BOT_D18`; the branch adds requests the bot never sent) and the D18 branch is pinned by its own
test; the once-per-process «Circuit Breaker ОТКЛЮЧЁН» warning is counted over all tasks; trade_events are
compared per trade; with parallel calls the idempotency uuid suffix is normalised (lock-arrival
order); `trade_placement_latency_ms` is compared to the 2 ms bucket (float accumulation order of
virtual sleeps); the `[SKIP-AFTER-TP-PLACED]` stack suffix is cut. Routes: the bot's
`setting_change` mutation that `um.save` emits on a key connect / remove is not compared — the site has
no settings audit trail yet (settings domain, open issue); the D15 permission read is the site's one
extra request and is checked against the bot's own signing of it; a refused key is expected to leave the
user row as it was.
