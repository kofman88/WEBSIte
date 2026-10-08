/**
 * reports.js vs the bot's REAL daily_summary_loop / weekly_digest_loop on a DB seeded with random
 * exchange trades and tracked signals of 10 random users (gen/gen_reports_rand.py →
 * fixtures/reports_rand.json): every text sent, every [DAILY-SUMMARY] / [WEEKLY-DIGEST] log line
 * (loop start, per user, iteration totals, the ISO-week kv dedup on the second weekly run), with
 * one user whose send returns False and one whose send raises.
 * e.g. python -c "print(f'{13.125:.2f}', f'{62.5:.0f}')"  → 13.12 62
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const R = nodeRequire('../../../services/engine/reports.js');
const { engineDb, seedUsers, seedTrades } = nodeRequire('./helpers.js');

const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures', 'reports_rand.json'), 'utf8'));

function setup(now) {
  const db = engineDb();
  seedUsers(db, V.users.map((u) => [u.user_id, u.sub_plan]));
  seedTrades(db, V.trades, V.insert_cols);
  const sent = []; const logs = []; const kvStore = new Map();
  const clock = { t: now };
  const reports = R.createReports({
    db,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => {} },
    sleep: async () => {},
    clock: () => clock.t,
    env: {},
    allUsers: () => V.users.map((u) => ({ user_id: u.user_id, auto_trade: u.auto_trade })),
    getUser: (uid) => {
      const u = V.users.find((x) => x.user_id === uid);
      return u ? { user_id: uid, lang: u.lang, sub_plan: u.sub_plan } : null;
    },
    kv: { get: (k) => (kvStore.has(k) ? kvStore.get(k) : null), set: (k, v) => { kvStore.set(k, v); } },
    sender: async (uid, { text }) => {
      sent.push({ uid, text });
      if (uid === V.send_raise) throw new Error('network down');
      return { dispatched: uid !== V.send_false };
    },
  });
  return { reports, sent, logs, kvStore };
}

const noCancel = (lines) => lines.filter((l) => !l.endsWith('cancelled — shutdown'));

describe('reports vs the bot loops on random users', () => {
  it('daily summary: texts and log lines', async () => {
    const { reports, sent, logs } = setup(V.now_daily);
    reports.startDaily();
    reports.stop();
    await reports.runDaily(V.now_daily);
    expect(sent).toEqual(V.daily.sent.map((s) => ({ uid: s.uid, text: s.text })));
    expect(logs).toEqual(noCancel(V.daily.logs));
    expect(sent.length).toBeGreaterThan(5);
  });
  it('weekly digest: texts, log lines, ISO-week dedup on the second run', async () => {
    const { reports, sent, logs, kvStore } = setup(V.now_weekly);
    for (const run of V.weekly) {
      sent.length = 0; logs.length = 0;
      reports.startWeekly();
      reports.stop();
      await reports.weeklyTick(V.now_weekly);
      expect(sent).toEqual(run.sent.map((s) => ({ uid: s.uid, text: s.text })));
      expect(logs).toEqual(noCancel(run.logs));
      expect(kvStore.get(R.KV_LAST_WEEK)).toBe(run.kv);
    }
  });
});
