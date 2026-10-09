'use strict';
/**
 * publicTrack/store.js — the public track's own archive (tables `public_track`,
 * `public_track_meta`, created here, idempotently).
 *
 * Why an archive and not signal_trades alone: the bot's ghost cleanup marks every paper signal
 * SKIP after 3 days and its trades GC deletes SKIP rows after 30 days (services/engine/
 * ghostCleanup.js, kept as in the bot), and signal_trades keeps only the CURRENT tracker stage.
 * The public track needs (a) a history longer than 30 days, (b) the stages it saw on the way
 * (TP2 before break-even, the time each stage became known) to show the track as of
 * now − 60 min, and (c) a durable change counter for the feed cursor. One row per track signal;
 * the internal columns (trade_id, user_id) are never served.
 *
 *   public_track(trade_id PK, pub_id UNIQUE, user_id, bot_id, strategy, pair, side, tf, created_at,
 *                stages JSON [{s, t}], status, path JSON, r, appear_seq, seq, updated_at)
 *     status / path / r  — the PUBLISHED state (as of the last refresh's V)
 *     appear_seq         — change counter value when the signal became visible (NULL = not yet)
 *     seq                — change counter value of the last published change
 *   public_track_meta(key PK, value): 'epoch' (random, names this archive in the cursor), 'seq'
 */

const crypto = require('crypto');

const DDL = `
  CREATE TABLE IF NOT EXISTS public_track (
    trade_id   TEXT PRIMARY KEY,
    pub_id     TEXT NOT NULL UNIQUE,
    user_id    INTEGER NOT NULL,
    bot_id     TEXT NOT NULL,
    strategy   TEXT NOT NULL,
    pair       TEXT NOT NULL,
    side       TEXT NOT NULL,
    tf         TEXT NOT NULL,
    created_at REAL NOT NULL,
    stages     TEXT NOT NULL DEFAULT '[]',
    status     TEXT,
    path       TEXT,
    r          REAL,
    appear_seq INTEGER,
    seq        INTEGER,
    updated_at REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_public_track_seq ON public_track(seq);
  CREATE INDEX IF NOT EXISTS idx_public_track_created ON public_track(created_at);
  CREATE INDEX IF NOT EXISTS idx_public_track_user ON public_track(user_id, created_at);
  CREATE TABLE IF NOT EXISTS public_track_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

const COLS = 'trade_id, pub_id, user_id, bot_id, strategy, pair, side, tf, created_at, stages, status, path, r, appear_seq, seq';

function createStore(db) {
  db.exec(DDL);
  const getMeta = db.prepare('SELECT value FROM public_track_meta WHERE key = ?');
  const setMeta = db.prepare('INSERT INTO public_track_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  // first process wins: a second one starting at the same time keeps the stored epoch
  db.prepare('INSERT OR IGNORE INTO public_track_meta (key, value) VALUES (?, ?)').run('epoch', crypto.randomBytes(6).readUIntBE(0, 6).toString(36));
  const stmts = {
    insert: db.prepare(`INSERT OR IGNORE INTO public_track (trade_id, pub_id, user_id, bot_id, strategy, pair, side, tf, created_at, stages, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?)`),
    setStages: db.prepare('UPDATE public_track SET stages = ?, updated_at = ? WHERE trade_id = ?'),
    publish: db.prepare('UPDATE public_track SET status = ?, path = ?, r = ?, seq = ?, appear_seq = COALESCE(appear_seq, ?), updated_at = ? WHERE trade_id = ?'),
  };
  const inList = (ids) => ids.map(() => '?').join(', ');

  return {
    db,
    epoch() { return getMeta.get('epoch').value; },
    seq() {
      const row = getMeta.get('seq');
      const n = row ? Number(row.value) : 0;
      return Number.isSafeInteger(n) && n > 0 ? n : 0;
    },
    setSeq(n) { setMeta.run('seq', String(n)); },
    /** archive rows of `ids` created at or after `since`, by trade_id */
    liveRows(ids, since) {
      if (!ids.length) return new Map();
      const rows = db.prepare(`SELECT ${COLS} FROM public_track WHERE user_id IN (${inList(ids)}) AND created_at >= ?`).all(...ids, since);
      return new Map(rows.map((r) => [r.trade_id, r]));
    },
    insert(rec, now) {
      stmts.insert.run(rec.trade_id, rec.pub_id, rec.user_id, rec.bot_id, rec.strategy, rec.pair, rec.side, rec.tf, rec.created_at, now);
    },
    setStages(tradeId, stages, now) { stmts.setStages.run(JSON.stringify(stages), now, tradeId); },
    publish(tradeId, state, seq, now) {
      stmts.publish.run(state.status, JSON.stringify(state.path), state.r, seq, seq, now, tradeId);
    },
    /** visible rows, newest first */
    page(ids, limit) {
      if (!ids.length) return [];
      return db.prepare(`SELECT ${COLS} FROM public_track WHERE appear_seq IS NOT NULL AND user_id IN (${inList(ids)})
        ORDER BY created_at DESC, appear_seq DESC LIMIT ?`).all(...ids, limit);
    },
    /** visible rows changed after `seq`: the last `limit` changes, in change order */
    changedSince(ids, seq, limit) {
      if (!ids.length) return [];
      return db.prepare(`SELECT ${COLS} FROM public_track WHERE appear_seq IS NOT NULL AND seq > ? AND user_id IN (${inList(ids)})
        ORDER BY seq DESC LIMIT ?`).all(seq, ...ids, limit).reverse();
    },
    /** visible rows created in (from, to], newest first */
    createdBetween(ids, from, to, limit) {
      if (!ids.length) return [];
      return db.prepare(`SELECT ${COLS} FROM public_track WHERE appear_seq IS NOT NULL AND created_at > ? AND created_at <= ? AND user_id IN (${inList(ids)})
        ORDER BY created_at DESC, appear_seq DESC LIMIT ?`).all(from, to, ...ids, limit);
    },
    /** every visible row (stats), oldest first */
    visible(ids) {
      if (!ids.length) return [];
      return db.prepare(`SELECT bot_id, created_at, status, r FROM public_track WHERE appear_seq IS NOT NULL AND user_id IN (${inList(ids)})
        ORDER BY created_at ASC, appear_seq ASC`).all(...ids);
    },
  };
}

module.exports = { DDL, createStore };
