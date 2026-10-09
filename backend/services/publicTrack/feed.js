'use strict';
/**
 * publicTrack/feed.js — GET /api/public/feed payloads from the archive (store.js).
 *
 * First request: { delay_min: 60, levels_hidden: true, cursor, items, source, updated_at, fees }
 * (the newest FEED_PAGE visible signals, newest first). Polling ?after=<cursor>:
 * { cursor, events, updated_at } where every visible signal whose published state changed after
 * the cursor appears ONCE — `{type: 'new', item}` if it became visible after the cursor (with its
 * latest state), else `{type: 'update', id, status, path, r}`. Updates come in change order, new
 * items oldest first (the landing prepends each one). The cursor is `<epoch>.<seq>.<v>`: the
 * archive's epoch, its change counter and the view time (unix s) of the answer.
 *
 * A cursor of another archive (epoch differs) or from the future (seq above the counter) cannot
 * be diffed; the answer then resynchronises from its view time: `update` for the signals created
 * up to it, `new` for the ones created after it. Only then can an update repeat a state the client
 * already shows. One answer carries at most FEED_MAX_EVENTS changes (the newest; a client that
 * far behind holds older items only) and FEED_MAX_NEW new items (the landing keeps 60).
 */

const { FEED_PAGE, FEED_MAX_NEW, FEED_MAX_EVENTS, DELAY_S, FEES } = require('./config');
const { STRATEGY_NAME } = require('./view');

const CURSOR_RE = /^([a-z0-9]{1,16})\.(\d{1,15})\.(\d{1,12})$/;

class BadCursor extends Error {
  constructor() { super('bad_cursor'); this.code = 'bad_cursor'; }
}

function encodeCursor(epoch, seq, v) { return `${epoch}.${seq}.${Math.floor(v)}`; }

function parseCursor(raw) {
  if (typeof raw !== 'string') throw new BadCursor();
  const m = CURSOR_RE.exec(raw);
  if (!m) throw new BadCursor();
  return { epoch: m[1], seq: Number(m[2]), v: Number(m[3]) };
}

function parsePath(p) {
  try {
    const a = JSON.parse(p);
    return Array.isArray(a) ? a : ['open'];
  } catch (_e) {
    return ['open'];
  }
}

/** archive row → feed item (the README's key order). */
function itemOf(row) {
  return {
    id: row.pub_id,
    t: Math.floor(row.created_at) * 1000,
    pair: `${row.pair}/USDT`,
    bot_id: row.bot_id,
    strategy: row.strategy,
    strategy_name: STRATEGY_NAME[row.strategy] || row.strategy,
    tf: row.tf,
    side: row.side,
    status: row.status,
    path: parsePath(row.path),
    r: row.r === null || row.r === undefined ? null : row.r,
  };
}

function updateOf(row) {
  const it = itemOf(row);
  return { type: 'update', id: it.id, status: it.status, path: it.path, r: it.r };
}

const byCreatedAsc = (a, b) => (a.created_at - b.created_at) || ((a.appear_seq || 0) - (b.appear_seq || 0));

/** The first page; `v` = the view time of the last refresh. */
function pagePayload(store, ids, v) {
  const rows = store.page(ids, FEED_PAGE);
  const cursor = encodeCursor(store.epoch(), store.seq(), v);
  return {
    delay_min: DELAY_S / 60,
    levels_hidden: true,
    cursor,
    items: rows.map(itemOf),
    source: 'paper',
    updated_at: Math.floor(v * 1000),
    fees: FEES,
  };
}

/** A poll answer for `after` (raw query value). Throws BadCursor on a malformed cursor. */
function pollPayload(store, ids, v, after) {
  const c = parseCursor(after);
  const seqNow = store.seq();
  const epoch = store.epoch();
  const events = [];
  if (c.epoch === epoch && c.seq <= seqNow) {
    const news = [];
    for (const row of store.changedSince(ids, c.seq, FEED_MAX_EVENTS)) {
      if (row.appear_seq > c.seq) news.push(row);
      else events.push(updateOf(row));
    }
    news.sort(byCreatedAsc);
    for (const row of news.slice(-FEED_MAX_NEW)) events.push({ type: 'new', item: itemOf(row) });
  } else {
    const known = store.createdBetween(ids, -1, c.v, FEED_MAX_NEW).sort(byCreatedAsc);
    for (const row of known) events.push(updateOf(row));
    const news = store.createdBetween(ids, c.v, 1e15, FEED_MAX_NEW).sort(byCreatedAsc);
    for (const row of news) events.push({ type: 'new', item: itemOf(row) });
  }
  return { cursor: encodeCursor(epoch, seqNow, v), events, updated_at: Math.floor(v * 1000) };
}

module.exports = { BadCursor, encodeCursor, parseCursor, itemOf, pagePayload, pollPayload };
