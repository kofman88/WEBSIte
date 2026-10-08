/**
 * entryAdvisor vs the bot's entry_advisor.py (gen_challenge_vectors.py §10):
 *   readConfig       ENTRY_ADVISOR_* env with the clamps (importlib.reload per env)
 *   pickAdvice       72 stats dicts (thresholds ≥ 5 MISSED and share ≥ 30 %, highest share, first wins ties)
 *   adviceText       RU / EN verbatim, html.escape of the name, round() half-even of the share
 *   missedStats      the SQL over seeded signal_trades (UPPER/COALESCE, signal_msg_id > 0, 14-day cutoff)
 *   adviseUser       every branch: market entry on, < 7 days since the last advice, broken kv,
 *                    no pick, send failure, quiet hours, languages
 *   entryMarketOn/Keep  handlers/entry_advisor.py
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { FIXTURE as V, setupEnv, insertUser, insertTrade, quietLog, captureLog } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('advisor');
const db = nodeRequire('../../models/database.js');
const ts = nodeRequire('../../services/traderSettingsService.js');
const EA = nodeRequire('../../services/entryAdvisor.js');

beforeAll(() => {
  for (const uid of [401, 402, 403, 404, 405]) insertUser(db, uid);
  for (const r of V.db_rows) if (r.user_id >= 401 && r.user_id <= 405) insertTrade(db, r);
});

beforeEach(() => {
  EA.resetDeps();
  EA.configure({ log: quietLog, db });
});

describe('readConfig (module constants)', () => {
  it(`reproduces ${V.advisor_env.length} env variants incl. clamps and import errors`, () => {
    for (const c of V.advisor_env) {
      if (c.ok) expect([c.env, EA.readConfig(c.env)]).toEqual([c.env, c.cfg]);
      else expect(() => EA.readConfig(c.env)).toThrow();
    }
    // the defaults the module runs with
    expect(EA.config()).toEqual(V.advisor_env[0].cfg);
  });
});

describe('pickAdvice / adviceText', () => {
  it('pick_advice table', () => {
    for (const [stats, want] of V.advisor_pick) expect([stats, EA.pickAdvice(stats)]).toEqual([stats, want]);
  });

  it('advice_text RU / EN (other languages → RU), html-escaped names, half-even share', () => {
    for (const [s, m, t, lg, text] of V.advisor_text) expect(EA.adviceText(s, m, t, lg)).toBe(text);
  });

  it('the two buttons', () => {
    expect(EA.keyboard('ru').map((b) => [b.text, b.action])).toEqual([['Включить вход по рынку', 'entry_market_on'], ['Оставить лимитный', 'entry_market_keep']]);
    expect(EA.keyboard('en').map((b) => [b.text, b.action])).toEqual([['Turn on market entry', 'entry_market_on'], ['Keep limit entry', 'entry_market_keep']]);
  });
});

describe('missedStats over signal_trades', () => {
  it('matches the bot SQL on the same rows', () => {
    const { now, stats } = V.advisor_missed;
    EA.configure({ clock: () => now });
    for (const [uid, want] of Object.entries(stats)) expect([uid, EA.missedStats(Number(uid))]).toEqual([uid, want]);
  });
});

describe('adviseUser branches', () => {
  const { now, cases } = V.advisor_advise;
  for (const c of cases) {
    it(c.name, async () => {
      const kvm = new Map();
      if (c.kv0 !== null) kvm.set(`${EA.KV_PREFIX}${c.uid}`, c.kv0);
      const sent = [];
      const log = captureLog();
      EA.configure({
        clock: () => now,
        log,
        kv: {
          get: (k) => { const v = kvm.has(k) ? kvm.get(k) : null; if (v === 'RAISE') throw new Error('kv down'); return v; },
          set: (k, v) => kvm.set(k, v),
        },
        sender: async (uid, { text, actions, silent }) => {
          sent.push({ uid, text, disable_notification: silent, buttons: actions.map((a) => [a.text, a.action]) });
          return c.send_ok ? { dispatched: true } : { error: 'user_not_found' };
        },
      });
      const user = { ...ts.defaults(c.uid), ...c.attrs };
      const r = await EA.adviseUser(user, now);
      expect(r).toBe(c.ret);
      expect(sent).toEqual(c.sent);
      expect(Object.fromEntries(kvm)).toEqual(c.kv);
      if (c.ret) expect(log.lines.some((l) => l.startsWith(`info [ENTRY-ADVISOR] uid=${c.uid} `) && l.endsWith('— advised market entry'))).toBe(true);
    });
  }
});

describe('loop + buttons', () => {
  it('runCycle advises every active user once and logs the cycle', async () => {
    const { now } = V.advisor_advise;
    const kvm = new Map();
    const log = captureLog();
    const slept = [];
    EA.configure({
      clock: () => now, log, sleep: async (ms) => { slept.push(ms); },
      kv: { get: (k) => kvm.get(k) || null, set: (k, v) => kvm.set(k, v) },
      sender: async () => ({ dispatched: true }),
      activeUsers: () => [{ user_id: 402 }, { user_id: 403 }, { user_id: 'x' }],
      getUser: (uid) => ({ ...ts.defaults(uid) }),
    });
    expect(await EA.runCycle()).toBe(1);
    expect(slept).toEqual([100]);
    expect(log.lines.at(-1)).toBe('info [ENTRY-ADVISOR] cycle: advised 1 users');
    expect(kvm.get('entry_advice_402')).toBe(String(Math.trunc(now)));
    // second run within 7 days: nobody
    expect(await EA.runCycle()).toBe(0);
  });

  it('disabled → [ENTRY-ADVISOR] disabled, no loop', () => {
    const log = captureLog();
    EA.configure({ log, config: { ENABLED: false } });
    const stop = EA.startLoop({ initialDelayS: 0 });
    stop();
    expect(log.lines).toEqual(['info [ENTRY-ADVISOR] disabled']);
  });

  it('entry_market_on sets prefer_market_entry and saves; keep only answers (RU for every language)', async () => {
    const saved = [];
    const users = { 7: { user_id: 7, lang: 'en', prefer_market_entry: false }, 8: { user_id: 8, lang: 'ru', prefer_market_entry: false } };
    EA.configure({ getUser: (uid) => users[uid], saveUser: (u) => saved.push({ ...u }) });
    expect(await EA.entryMarketOn(7)).toMatchObject({ ok: true, message: '🎯 Market entry is on', show_alert: true, remove_keyboard: true });
    expect(await EA.entryMarketOn(8)).toMatchObject({ message: '🎯 Вход по рынку включён' });
    expect(saved.map((u) => [u.user_id, u.prefer_market_entry])).toEqual([[7, true], [8, true]]);
    expect(await EA.entryMarketKeep(7)).toEqual({ ok: true, show_alert: false, remove_keyboard: true, message: 'Оставляем лимитный вход' });
  });
});
