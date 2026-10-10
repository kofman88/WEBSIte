/**
 * The local ports of db/signal_stats.signal_rows_since / signal_stats over signal_trades
 * (TODO(M10a): signalStats.js) against the bot's own SQL on the same 90 rows of uid 701
 * (gen_challenge_vectors.py §11): ORPHAN, ghost SKIP (no card, no order), NULL result /
 * signal_msg_id / order_id, the 30-day boundary (`created_at > now − days·86400`) and the
 * `created_at >= since` boundary of rows_since.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { FIXTURE as V, setupEnv, insertUser, insertTrade, quietLog, norm } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('sql');
const db = nodeRequire('../../models/database.js');
const C = nodeRequire('../../services/challengeService.js');

beforeAll(() => {
  insertUser(db, 701);
  for (const r of V.db_rows) if (r.user_id === 701) insertTrade(db, r);
});

beforeEach(() => {
  C.resetDeps();
  C.configure({ log: quietLog });
});

describe('signal_rows_since / signal_stats on signal_trades', () => {
  it('rows_since returns the bot rows (COUNTABLE_SQL, ORDER BY created_at)', () => {
    const got = C.dbRowsSince(701, V.sql.since);
    expect(got.length).toBe(V.sql.rows_since.length);
    expect(norm(got)).toEqual(norm(V.sql.rows_since));
  });

  it('signal_stats(uid, 30) and (uid, 7) aggregate identically', () => {
    expect(norm(C.dbSignalStats(701, 30, V.sql.now))).toEqual(norm(V.sql.stats30));
    expect(norm(C.dbSignalStats(701, 7, V.sql.now))).toEqual(norm(V.sql.stats7));
    C.configure({ clock: () => V.sql.now });
    expect(norm(C.stats30(701))).toEqual(norm(V.sql.stats30));
  });

  it('[STATS-HONEST 2026-10] manual «Пропустил» rows are skips in the challenge progress / plan / card', () => {
    const rows = C.dbRowsSince(701, V.sql.since);
    expect(rows.every((r) => Object.prototype.hasOwnProperty.call(r, 'skip_reason'))).toBe(true);
    const ch = C.fromJson(V.sql.challenge_json);
    expect(norm(C.progress(ch, rows, V.sql.now))).toEqual(norm(V.sql.progress));
    expect(norm(C.plan(ch, C.dbSignalStats(701, 30, V.sql.now), V.sql.now))).toEqual(norm(V.sql.plan));
    expect(norm(C.aggregate(rows, 21, V.sql.now))).toEqual(norm(V.sql.card));
    expect(rows.filter((r) => r.skip_reason === 'manual').length).toBeGreaterThanOrEqual(4);
  });

  it('the fixture exercises the filtered rows', () => {
    const all = V.db_rows.filter((r) => r.user_id === 701);
    expect(all.some((r) => r.result === 'ORPHAN')).toBe(true);
    expect(all.some((r) => r.result === 'SKIP' && !r.signal_msg_id && !r.order_id)).toBe(true);
    expect(V.sql.rows_since.length).toBeLessThan(all.length);
  });
});
