# services/publicTrack — the landing's public data (M10b)

`GET /api/public/trend`, `/stats`, `/feed` (`routes/publicLanding.js`, mounted on `/api/public` next to
`routes/public.js`). The response shapes, statuses and honesty rules are documented for the landing in
`frontend/landing/README.md` («Эндпоинты, которые уже отвечают»); this file is the backend side.

The bot has no public endpoints: nothing here is a one-to-one port. What comes from the bot is computed
by the ported, verified modules — the trend monitor's state and `ribbon_strength`
(`engine/trendMonitor.js`), `signal_status` / `signal_rr` (`engine/signalOutcome.js`) — and
`tests/public/parity.test.js` checks those parts against the bot's own code (`py/gen_public_parity.py`, CPython 3.11).

| file | what |
|---|---|
| `config.js` | constants (60-min delay, 60 s cache, 30-signal thresholds, fee model) and env: `PUBLIC_TRACK_USER_IDS`, `PUBLIC_API_RATE_PER_MIN`, `PUBLIC_TRACK_ID_SECRET` |
| `view.js` | pure: one track row + its stage history → public `{status, path, r}` at view time V |
| `store.js` | the archive tables `public_track`, `public_track_meta` (created here, `IF NOT EXISTS`) |
| `index.js` | `createPublicTrack()`: refresh (≤ once per minute), feed / stats / trend payloads with ETag; `defaultTrack()`; `start()` / `stop()` (minute timer, started by `server.js` outside tests) |
| `feed.js` | first page, cursor polls (`new` / `update`, resync of a foreign cursor) |
| `stats.js` | counters, per-bot 30-day figures, outcomes, registry |
| `trend.js` | trend monitor state from engine_kv + ribbon strength over BingX closed bars + 24 h change |
| `rateLimit.js` | per-IP sliding window |

## The track

The track is the paper signals of the **system accounts** listed in `PUBLIC_TRACK_USER_IDS` — the
«витринные боты» of `docs/PRODUCT_CONCEPT.md` M2 until the showcase (V4) gives them frozen versions.
Use accounts that no person logs into, with fixed settings (Pro plan, the strategies the track should
show); their signals are delivered to their own feed like any user's, which is what makes the tracker
follow them. Rows of every other user are never read. An account removed from the list is no longer
published (its archive rows stay in the table).

A row is part of the track when it belongs to a track account, was delivered (`signal_msg_id > 0`), has
no exchange order, is countable (`result != 'ORPHAN'`) and has a LEVELS / SMC / VOLUME strategy and a
LONG / SHORT direction. Its public state is the tracker view: `result` (manual results, ghost-cleanup
SKIP) is ignored, exactly as the bot's card outcome line does.

## Why an archive

The bot's ghost cleanup marks paper signals SKIP after 3 days and its trades GC deletes SKIP rows after
30 days; `signal_trades` also keeps only the current tracker stage. The archive keeps one row per track
signal for good, the stages it saw with the time each became known, the published state and a change
counter. `trade_id` / `user_id` are internal columns, never served; the public id is an HMAC of the
trade id.

## Refresh (one transaction, at most once per minute)

1. Read the track rows younger than 5 days (`LIVE_WINDOW_S`), plus any older row not archived yet (the
   first run imports what `signal_trades` still holds).
2. Archive new rows; when the tracker stage changed, append it dated
   `max(engine time, min(now, engine time + 1 h))` — when the archive saw it, never more than an hour
   after the bar the tracker dated it to (`progress_ts`).
3. For each row created at or before V = now − 60 min, compute its state at V; a state different from the
   published one is published under the next counter value (`seq`); the first one also sets `appear_seq`.

Feed polls read `seq > cursor` (coalesced per signal: one event each), stats read the published states.
Every payload is memoised until the next refresh and carries a weak ETag.

Known limits: TP2 followed by break-even within one refresh minute (or one tracker cycle) shows as
`tp1be` (the bot stores only the last stage; R is 0 − fee either way). `bots_30d` and the registry count
track bots (account × strategy); `published` / `archived` stay 0 until the showcase exists.
