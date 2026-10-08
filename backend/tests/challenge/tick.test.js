/**
 * challenge.tick / gate / daily summary line on the real engine_kv + signal_trades tables,
 * replaying the generator's fake-clock timeline (gen_challenge_vectors.py §8):
 *   8 users — max-trades stop (201), daily-loss stop (202, EN), goal reached + card (203),
 *   deadline expired with / without card (204 EN / 205), user lookup failure (206), daily
 *   progress over 69 days with the notified-flag eviction (207 EN), unknown lang → RU (208),
 *   a `challengeX9` kv key the bot's LIKE 'challenge_%' also matches (broken JSON → skipped).
 * Per tick: the counters, the messages per user (texts verbatim), the share-card payload, the
 * kv JSON byte-identical for every challenge and gate(uid, now) for four users.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { FIXTURE as V, setupEnv, insertUser, insertTrade, quietLog, captureLog, norm } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('tick');
const db = nodeRequire('../../models/database.js');
const C = nodeRequire('../../services/challengeService.js');

const T = V.tick;
const byUid = (msgs) => {
  const m = {};
  for (const [uid, text] of msgs) (m[uid] = m[uid] || []).push(text);
  return m;
};
const kvSnapshot = () => Object.fromEntries(
  db.prepare("SELECT key, value FROM engine_kv WHERE key LIKE 'challenge\\_%' ESCAPE '\\'").all().map((r) => [r.key, r.value]),
);

beforeAll(() => {
  for (const uid of [201, 202, 203, 204, 205, 206, 207, 208, 999]) insertUser(db, uid);
});

beforeEach(() => {
  C.resetDeps();
  C.configure({ log: quietLog });
});

describe('tick(): the bot timeline replayed', () => {
  it(`reproduces ${T.timeline.length} ticks (counters, messages, cards, kv JSON, gate)`, async () => {
    db.prepare('DELETE FROM engine_kv').run();
    db.prepare('DELETE FROM signal_trades').run();
    let clock = V.t0;
    const sent = [];
    const cards = [];
    const log = captureLog();
    C.configure({
      clock: () => clock,
      log,
      getUser: async (uid) => {
        if (uid === 206) throw new Error('user lookup failed');
        return { user_id: uid, lang: T.langs[String(uid)] || 'ru' };
      },
      notifier: {
        sendText: async (uid, text) => { sent.push([uid, text]); return { dispatched: true }; },
        sendCard: async (uid, p) => { cards.push({ ...p, uid }); return { dispatched: true }; },
      },
    });
    for (const [uid, st0, a] of T.users) {
      clock = st0;
      C.save(C.build(uid, a, st0));
    }
    db.prepare("INSERT INTO engine_kv (key, value, updated_at) VALUES ('challengeX9', '{broken', 0)").run();
    let i = 0;
    for (const e of T.timeline) {
      clock = e.t;
      for (const [uid, r] of e.adds) insertTrade(db, { ...r, user_id: uid, trade_id: `tick${(i += 1)}` });
      sent.length = 0;
      cards.length = 0;
      const st = await C.tick({ now: e.t });
      expect([e.t, st]).toEqual([e.t, e.stats]);
      expect([e.t, byUid(sent)]).toEqual([e.t, byUid(e.sent)]);
      const want = e.cards.map((c) => norm({ uid: c.uid, stats: c.stats, period: c.period, days: c.days, lang: c.lang, filename: c.filename }));
      const got = cards.map((c) => norm({ uid: c.uid, stats: c.stats, period: c.period, days: c.days, lang: c.lang, filename: c.filename }));
      expect([e.t, got]).toEqual([e.t, want]);
      expect([e.t, kvSnapshot()]).toEqual([e.t, e.kv]);
      for (const [uid, reason] of Object.entries(e.gates)) expect([e.t, uid, C.gate(Number(uid), e.t)]).toEqual([e.t, uid, reason]);
    }
    // the per-user failure is logged and skipped; the eviction kept ≤ 60 flags
    expect(log.lines.filter((l) => l.startsWith('warn [CHALLENGE] tick uid=206: user lookup failed')).length).toBe(T.timeline.length);
    const ch207 = C.load(207);
    expect(Object.keys(ch207.notified).length).toBeLessThanOrEqual(60);
    expect(T.timeline.reduce((n, e) => n + e.stats.daily, 0)).toBeGreaterThan(60);

    // daily_summary hook ([CHALLENGE] short line) at the end of the timeline
    clock = V.t0 + 70 * 86400;
    for (const [uid, line] of Object.entries(V.daily_line)) {
      expect([uid, C.dailySummaryLine({ user_id: Number(uid), lang: T.langs[uid] }, clock)]).toEqual([uid, line]);
    }
  });

  it('every transition happened: done, expired (with and without card), both blocks once per day, daily once per day', () => {
    const all = T.timeline;
    expect(all.some((e) => e.stats.done)).toBe(true);
    expect(all.filter((e) => e.stats.expired).length).toBeGreaterThanOrEqual(2);
    expect(all.some((e) => e.cards.length)).toBe(true);
    const blocks = all.flatMap((e) => e.sent.filter(([, t]) => t.startsWith('⛔')));
    expect(blocks.some(([, t]) => t.includes('лимит сделок на сегодня исчерпан'))).toBe(true);
    expect(blocks.some(([, t]) => t.includes('daily loss limit reached'))).toBe(true);
    // a stop is announced once per day: no two block messages for the same uid within one UTC day
    const seen = new Set();
    for (const e of all) {
      for (const [uid, t] of e.sent) {
        if (!t.startsWith('⛔')) continue;
        const k = `${uid}:${C.dayKey(e.t)}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });
});

describe('gate(): fail-open only for a failed kv read', () => {
  it('kv read failure → null + [CHALLENGE-GATE] warning (the bot answers None too)', () => {
    const log = captureLog();
    C.configure({ log, kv: { get: () => { throw new Error('kv down'); } } });
    expect(C.gate(201, V.t0 + 11 * 3600)).toBe(V.gate_kv_fail);
    expect(log.lines).toEqual(['warn [CHALLENGE-GATE] uid=201: kv read failed (kv down) — gate skipped']);
  });

  it('a failing discipline calculation propagates (auto-trade closes fail-closed)', () => {
    C.configure({
      kv: { get: () => C.build(201, { deposit: 1000, goal_value: 25, risk_pct: 1, leverage: 5, strategies: ['LEVELS'] }, V.t0).toJson() },
      rowsSince: () => { throw new Error('db down'); },
    });
    expect(() => C.gate(201, V.t0 + 60)).toThrow('db down');
  });

  it('no challenge / finished challenge → null', () => {
    C.configure({ kv: { get: () => null } });
    expect(C.gate(5, V.t0)).toBe(null);
    const ch = C.build(5, { deposit: 1000, goal_value: 25, risk_pct: 1, leverage: 5, strategies: ['LEVELS'] }, V.t0);
    ch.status = C.STATUS_DONE;
    C.configure({ kv: { get: () => ch.toJson() }, rowsSince: () => { throw new Error('must not read'); } });
    expect(C.gate(5, V.t0)).toBe(null);
  });
});

describe('startLoop', () => {
  it('logs [CHALLENGE] tick {…} when there are active challenges and keeps running after a failed tick', async () => {
    const log = captureLog();
    let calls = 0;
    C.configure({
      log,
      kv: {
        itemsWithPrefix: () => {
          calls += 1;
          if (calls === 1) throw new Error('boom');
          return [];
        },
      },
    });
    const stop = C.startLoop({ initialDelayS: 0, intervalS: 0.001 });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(log.lines[0]).toBe('warn [CHALLENGE] loop: boom');
    expect(calls).toBeGreaterThan(1);
    expect(C.pyDictRepr({ active: 1, done: 0, expired: 0, blocked: 0, daily: 0 }))
      .toBe("{'active': 1, 'done': 0, 'expired': 0, 'blocked': 0, 'daily': 0}");
  });
});
