/**
 * reports.js vs the bot's daily_summary.py / weekly_digest.py
 * (gen/gen_reports_vectors.py → fixtures/reports_vectors.json, bot venv, datetime pinned):
 * every text verbatim (48 daily + 9×36 weekly-per-user + 90 extra digests), the schedule
 * arithmetic, ISO week keys, and the two send loops driven with the same fakes (users, stats,
 * sender) — sent texts, counts and [DAILY-SUMMARY] / [WEEKLY-DIGEST] lines. The per-user texts
 * are rebuilt here from the seeded DB of stats_vectors.json (DB → stats → text).
 *   python -c "import weekly_digest as w; print(w._r(-0.04))"  → 0R
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const R = nodeRequire('../../../services/engine/reports.js');
const SS = nodeRequire('../../../services/engine/signalStats.js');
const { engineDb, seedUsers, seedTrades } = nodeRequire('./helpers.js');

const dir = path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures');
const V = JSON.parse(fs.readFileSync(path.join(dir, 'reports_vectors.json'), 'utf8'));
const S = JSON.parse(fs.readFileSync(path.join(dir, 'stats_vectors.json'), 'utf8'));
const NOW = S.now;

let db;
beforeAll(() => {
  db = engineDb();
  seedUsers(db, S.users);
  seedTrades(db, S.trades, S.insert_cols);
});

describe('daily summary (§13)', () => {
  it(`${V.daily_texts.length} texts: day mood, BE, best/worst, 7-day line, Russian month only for ru`, () => {
    for (const c of V.daily_texts) expect(R.formatSummary(c.s24, c.s7, c.lang, c.now), `${c.name} ${c.lang}`).toBe(c.text);
  });
  it('next run at 23:55 UTC', () => {
    for (const c of V.daily_next) expect(R.secondsUntilNextSummary(c.now)).toBe(c.s);
  });
  it('DB → db_get_auto_stats_period(1/7) → text for every seeded user', () => {
    for (const [uid, byLang] of Object.entries(V.daily_per_user)) {
      const s1 = SS.autoStatsPeriod(db, Number(uid), 1, NOW);
      const s7 = SS.autoStatsPeriod(db, Number(uid), 7, NOW);
      for (const [lang, text] of Object.entries(byLang)) expect(R.formatSummary(s1, s7, lang, NOW)).toBe(text);
    }
  });
  it('run: auto_trade users only, challenge line hook, sent counted whatever the sender says (quirk)', async () => {
    const c = V.daily_run;
    const sent = []; const logs = [];
    const rep = R.createReports({
      allUsers: () => c.users,
      getUser: (uid) => c.um[String(uid)] || null,
      stats: { autoStatsPeriod: (uid, days) => { const a = V.daily_auto[String(uid)]; return a ? { ...a[String(days)] } : {}; } },
      challengeLine: (user) => (user.user_id === 101 ? `🎯 Челлендж (${user.lang}): +1.5R` : null),
      sender: async (uid, m) => { sent.push({ uid, text: m.text }); return !c.fail_send.includes(uid); },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => {} },
      sleep: async () => {},
    });
    expect(await rep.runDaily(c.now)).toEqual(c.result);
    expect(sent).toEqual(c.sent);
    expect(logs).toEqual(c.log);
  });
});

describe('weekly digest (§14)', () => {
  it('constants, texts table, _r, ISO week keys, next Monday 09:05', () => {
    const cfg = R.readWeeklyConfig({});
    expect([cfg.WEEKDAY, cfg.HOUR_UTC, cfg.MINUTE_UTC]).toEqual([V.weekly_consts.WEEKDAY, V.weekly_consts.HOUR_UTC, V.weekly_consts.MINUTE_UTC]);
    expect(R.KV_LAST_WEEK).toBe(V.weekly_consts.KV);
    expect(R.SEND_PAUSE_S).toBe(V.weekly_consts.PAUSE);
    expect(R.T).toEqual(V.weekly_consts.T);
    for (const [x, want] of Object.entries(V.weekly_r)) expect(R.r(Number(x)), x).toBe(want);
    for (const c of V.weekly_next) {
      expect(R.secondsUntilNext(c.now, cfg)).toBe(c.s);
      expect(R.weekKey(c.now)).toBe(c.week);
    }
    for (const [ts, k] of Object.entries(V.week_keys)) expect(R.weekKey(Number(ts)), ts).toBe(k);
    expect(R.readWeeklyConfig({ WEEKLY_DIGEST_WEEKDAY: '9', WEEKLY_DIGEST_HOUR_UTC: '25', WEEKLY_DIGEST_MINUTE_UTC: 'x', WEEKLY_DIGEST_ENABLED: '0' }))
      .toEqual({ ENABLED: false, WEEKDAY: 2, HOUR_UTC: 1, MINUTE_UTC: 5 });
  });
  it('DB → signal_stats(uid, 7) → digest for every user × lang × plan × pro overview', () => {
    const pro7 = SS.proOverview(db, 7, NOW);
    for (const [uid, cases] of Object.entries(V.weekly_per_user)) {
      const st = SS.signalStats(db, Number(uid), 7, NOW);
      for (const [key, text] of Object.entries(cases)) {
        const [lang, plan, proKey] = key.split('|');
        const pro = proKey === 'pro_overview_7' ? pro7 : proKey === 'none' ? null : { pro_users: 0 };
        expect(R.formatDigest(st, lang, plan, pro, NOW), `${uid} ${key}`).toBe(text);
      }
    }
  });
  it(`${V.weekly_extra.length} edge digests (no trades, ±0R, best without symbol, one strategy only, period across years)`, () => {
    for (const c of V.weekly_extra) expect(R.formatDigest(c.stats, c.lang, c.plan, c.pro, c.now), JSON.stringify(c)).toBe(c.text);
  });
  it('run_once: free users get the Pro line, sender result counts, [WEEKLY-DIGEST] lines', async () => {
    const c = V.weekly_run;
    const sent = []; const logs = [];
    const um = V.daily_run.um;
    const rep = R.createReports({
      allUsers: () => V.daily_run.users,
      getUser: (uid) => um[String(uid)] || null,
      stats: {
        signalStats: (uid) => (S.per_user[String(uid)] ? S.per_user[String(uid)].signal_stats_7 : { signals: 0 }),
        proOverview: () => S.pro_overview_7,
      },
      sender: async (uid, m) => { sent.push({ uid, text: m.text }); return !V.daily_run.fail_send.includes(uid); },
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), debug: () => {} },
      sleep: async () => {},
    });
    expect(await rep.runWeekly(c.now)).toEqual(c.result);
    expect(sent).toEqual(c.sent);
    expect(logs).toEqual(c.log);
  });
  it('kv weekly_digest_last_week dedups a restart in the same ISO week', async () => {
    const store = new Map();
    const logs = [];
    let runs = 0;
    const rep = R.createReports({
      kv: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) },
      allUsers: () => { runs++; return []; },
      stats: { proOverview: () => null },
      log: { info: (m) => logs.push(m), warn: () => {}, debug: () => {} },
      sleep: async () => {},
    });
    expect(await rep.weeklyTick(NOW)).toEqual([0, 0]);
    expect(store.get('weekly_digest_last_week')).toBe(R.weekKey(NOW));
    expect(await rep.weeklyTick(NOW + 3600)).toBe(null);
    expect(logs.at(-1)).toBe(`[WEEKLY-DIGEST] week ${R.weekKey(NOW)} already sent — skip`);
    expect(runs).toBe(1);
    expect(await rep.weeklyTick(NOW + 7 * 86400)).toEqual([0, 0]);
    expect(runs).toBe(2);
  });
  it('default sender = notifier type report with the stats link and the app button', async () => {
    const calls = [];
    const send = R.notifierSender({ dispatch: async (uid, o) => { calls.push([uid, o]); return { dispatched: true }; } });
    expect(await send(7, { text: '📊 <b>Итоги недели</b> · x\ny', actions: R.appActions('en') })).toEqual({ dispatched: true });
    expect(calls[0][1]).toMatchObject({ type: 'report', title: '📊 Итоги недели · x', body: '📊 <b>Итоги недели</b> · x\ny', link: '/app/?tab=stats' });
    expect(calls[0][1].data.actions).toEqual([{ text: '📱 Open stats', url: '/app/?tab=stats' }]);
    // e-mail: own HTML (the generic template would escape <b>), tag-free text part
    expect(calls[0][1].template.subject).toBe('📊 Итоги недели · x');
    expect(calls[0][1].template.text).toBe('📊 Итоги недели · x\ny');
    expect(calls[0][1].template.html).toContain('📊 <b>Итоги недели</b> · x<br>y');
  });
  it('loops honour the *_ENABLED switches', () => {
    const logs = [];
    const rep = R.createReports({ env: { DAILY_SUMMARY_ENABLED: '0', WEEKLY_DIGEST_ENABLED: '0' }, log: { info: (m) => logs.push(m) } });
    expect(rep.startDaily()).toBe(false);
    expect(rep.startWeekly()).toBe(false);
    expect(logs).toEqual(['[DAILY-SUMMARY] disabled via env DAILY_SUMMARY_ENABLED=0', '[WEEKLY-DIGEST] disabled via env WEEKLY_DIGEST_ENABLED=0']);
  });
});
