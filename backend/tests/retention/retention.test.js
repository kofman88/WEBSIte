/**
 * M17b retention ports vs the bot (fixtures/retention_vectors.json.gz, CPython 3.11 — see
 * gen/gen_retention_vectors.py): engagement.py (reminder choice, texts, keyboard, send branches,
 * one loop pass, opt-out), the opt-out callback of handlers/subscription.py, drip_campaign.py
 * (process_user over random rows, one loop pass) and smart_prompts.py (throttle + GC, free check,
 * both triggers). Sends go through botSend → a fake dispatch with the site's answers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const E = req('../../services/retention/engagement.js');
const DC = req('../../services/retention/dripCampaign.js');
const SP = req('../../services/retention/smartPrompts.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const V = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(here, 'fixtures', 'retention_vectors.json.gz'))).toString('utf8'));

function capLog() {
  const lines = [];
  const push = (lvl) => (m) => lines.push([lvl, String(m)]);
  return { lines, info: push('info'), warning: push('warning'), warn: push('warning'), debug: push('debug'), error: push('error') };
}

/** dispatch answers per outcome, as the site's notifier gives them. */
function fakeDispatch(planOf, calls) {
  return async (uid, opts) => {
    calls.push({ uid, ...opts });
    const what = planOf(uid);
    if (what === 'forbidden') return { error: 'user_not_found' };
    if (what === 'bad') return { error: 'invalid_args' };
    if (what === 'other') throw new Error('dispatch exploded');
    return { dispatched: true, notificationId: 1, silent: Boolean(opts.silent) };
  };
}

/** action rows → the bot's InlineKeyboardMarkup rows as the generator recorded them. */
function asBotRows(rows, { linkAsCallback = false } = {}) {
  return rows.map((row) => row.map((b) => {
    if (linkAsCallback) return { text: b.label, url: null, callback_data: b.callback };
    return { text: b.label, url: b.kind === 'url' ? b.action : null, callback_data: b.kind === 'callback' ? b.action : null };
  }));
}

const clone = (o) => JSON.parse(JSON.stringify(o));

afterEach(() => {
  E.resetDeps();
  DC.resetDeps();
  SP.resetDeps();
  vi.useRealTimers();
});

describe('vectors', () => {
  it('come from the production Python', () => {
    expect(V.python.startsWith('3.11.')).toBe(true);
    expect(V.which.length).toBeGreaterThan(2500);
  });
});

// ── A ────────────────────────────────────────────────────────────────────
describe('engagement._which_reminder', () => {
  it(`${V.which.length} users (random + every boundary) choose the bot's reminder`, () => {
    const bad = [];
    for (const c of V.which) {
      const got = E.whichReminder(clone(c.user), c.now);
      if (got !== c.result) bad.push({ user: c.user, want: c.result, got });
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

// ── B ────────────────────────────────────────────────────────────────────
describe('engagement texts and keyboard', () => {
  it('every type × language (RU fallback) × user id, and the flag of each type', () => {
    for (const c of V.texts) {
      expect(E.render(c.type, { user_id: c.user_id, lang: c.lang })).toBe(c.text);
      expect(E.flagFor(c.type)).toBe(c.flag);
    }
  });
  it('the keyboard: pay link + opt-out callback with the user id', () => {
    for (const c of V.keyboards) {
      const kb = E.keyboard(c.user_id, { withOptout: true, lang: E.userLang({ lang: c.lang }) });
      expect(asBotRows(kb)).toEqual(c.rows);
      expect(kb[1][0].api).toEqual({ method: 'POST', path: 'engagement/optout' });
    }
  });
});

// ── C ────────────────────────────────────────────────────────────────────
describe('engagement._send_reminder', () => {
  for (const c of V.sends) {
    it(`${c.outcome}${c.save_fail ? ' + save fails' : ''} · ${c.type} · ${c.lang}`, async () => {
      const L = capLog();
      const calls = [];
      const saved = [];
      E.configure({
        clock: () => c.now, log: L,
        dispatch: fakeDispatch(() => c.outcome, calls),
        saveUser: async (u) => {
          if (c.save_fail) throw new Error('database is locked');
          saved.push(clone(u));
        },
      });
      const user = clone(c.user_before);
      const ok = await E.sendReminder(user, c.type);
      expect(ok).toBe(c.result);
      expect(user).toEqual(c.user_after);
      expect(saved).toEqual(c.saved);
      expect(L.lines).toEqual(c.logs);
      expect(calls.length).toBe(c.calls.length);
      const py = c.calls[0];
      expect(calls[0].uid).toBe(py.uid);
      expect(calls[0].tgText).toBe(py.text);
      expect(calls[0].body).toBe(py.text);
      expect(calls[0].type).toBe('reminder');
      expect(calls[0].silent).toBe(false);
      expect(py.parse_mode).toBe('HTML');
      expect(py.disable_notification).toBeUndefined();
      expect(asBotRows(calls[0].data.actions)).toEqual(py.reply_markup);
    });
  }
});

// ── D ────────────────────────────────────────────────────────────────────
describe('engagement_loop', () => {
  for (const [i, c] of V.loops.entries()) {
    it(`pass ${i}: sends, saves, user rows and log lines as the bot`, async () => {
      const L = capLog();
      const calls = [];
      const saved = [];
      const sleeps = [];
      let T = V.now + c.sleeps[0];                 // after the 120 s start delay
      const users = clone(c.users);
      const plan = c.plan;
      E.configure({
        clock: () => T, log: L,
        dispatch: fakeDispatch((uid) => plan[String(uid)] || 'ok', calls),
        allUsers: async () => {
          if (c.get_fail.includes('all')) throw new Error('db locked');
          return users;
        },
        saveUser: async (u) => {
          if (c.save_fail.includes(u.user_id)) throw new Error('database is locked');
          saved.push(clone(u));
        },
        sleep: async (ms) => { sleeps.push(ms / 1000); T += ms / 1000; },
      });
      await E.runPass();
      expect([c.sleeps[0], ...sleeps, E.LOOP_INTERVAL_S]).toEqual(c.sleeps);
      expect(calls.map((x) => [x.uid, x.tgText])).toEqual(c.calls.map((x) => [x.uid, x.text]));
      expect(saved).toEqual(c.saved);
      expect(users).toEqual(c.users_after);
      expect([['info', `Engagement loop started (interval=${E.LOOP_INTERVAL_S}s)`], ...L.lines]).toEqual(c.logs);
    });
  }

  it('startLoop: the start line, the first pass after 120 s, then hourly; stop() ends it', async () => {
    vi.useFakeTimers({ now: V.now * 1000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const L = capLog();
    const passes = [];
    E.configure({ log: L, clock: () => Date.now() / 1000, allUsers: async () => { passes.push(Date.now() / 1000 - V.now); return []; } });
    const stop = E.startLoop();
    expect(L.lines).toEqual([['info', 'Engagement loop started (interval=3600s)']]);
    await vi.advanceTimersByTimeAsync(119 * 1000);
    expect(passes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(passes).toEqual([120]);
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    expect(passes).toEqual([120, 3720]);
    stop();
    await vi.advanceTimersByTimeAsync(5 * 3600 * 1000);
    expect(passes.length).toBe(2);
  });

  it('the bot\'s constants', () => {
    expect(V.loop_constants).toEqual({ LOOP_INTERVAL_S: E.LOOP_INTERVAL_S, MIN_GAP: E.MIN_GAP_BETWEEN_REMINDERS, THROTTLE: E.SEND_THROTTLE_S });
  });
});

// ── E / F ────────────────────────────────────────────────────────────────
describe('engagement opt-out', () => {
  for (const c of V.optout) {
    it(`handle_optout_callback: ${c.case}`, async () => {
      const L = capLog();
      const saved = [];
      const user = { user_id: 6001, ...clone(c.user_after), reminders_optout: false };
      E.configure({
        log: L,
        getUser: async (uid) => {
          if (c.case === 'get_fails') throw new Error('lookup failed');
          return c.case === 'missing' ? null : (uid === 6001 ? user : null);
        },
        saveUser: async (u) => {
          if (c.case === 'save_fails') throw new Error('database is locked');
          saved.push(clone(u));
        },
      });
      expect(await E.handleOptoutCallback(6001)).toBe(c.result);
      expect(saved).toEqual(c.saved);
      expect(L.lines).toEqual(c.logs);
      if (c.case !== 'missing' && c.case !== 'get_fails') expect(user).toEqual(c.user_after);
    });
  }

  for (const c of V.optout_cb) {
    it(`cb_engagement_optout ${JSON.stringify(c.data).slice(0, 48)} caller=${c.caller} lang=${c.lang}${c.get_fail ? ' (lookup fails)' : ''}`, async () => {
      const L = capLog();
      const saved = [];
      const users = new Map();
      for (const uid of c.users) users.set(uid, { user_id: uid, lang: uid === c.caller ? c.lang : 'ru', reminders_optout: false });
      E.configure({
        log: L,
        getUser: async (uid) => {
          if (c.get_fail) throw new Error('lookup failed');
          return users.get(uid) || null;
        },
        saveUser: async (u) => { saved.push(u.user_id); },
      });
      const r = await E.optoutButton(c.caller, c.data);
      expect(c.answers.length).toBe(1);
      expect(r.message).toBe(c.answers[0].text);
      expect(r.show_alert).toBe(c.answers[0].show_alert);
      expect(saved).toEqual(c.saved.map((s) => s.user_id));
      expect(L.lines).toEqual(c.logs);
    });
  }
});

// ── G ────────────────────────────────────────────────────────────────────
describe('drip_campaign', () => {
  it('_build_message for days 0..9', () => {
    for (const c of V.drip_messages) {
      const [text, btns] = DC.buildMessage(c.day, c.lang);
      expect(text).toBe(c.text);
      expect(btns).toEqual(c.buttons);
    }
  });

  it(`_process_user on ${V.drip.length} random rows: eligibility, kv branches, silent send, marks, log lines`, async () => {
    const bad = [];
    for (const c of V.drip) {
      const L = capLog();
      const calls = [];
      const KV = new Map(Object.entries(c.kv_before));
      DC.configure({
        clock: () => V.now, log: L,
        dispatch: fakeDispatch(() => c.outcome, calls),
        kv: {
          get: (k) => { if (c.kv_fail.get) throw new Error('kv read failed'); return KV.has(k) ? KV.get(k) : null; },
          set: (k, v) => { if (c.kv_fail.set) throw new Error('kv write failed'); KV.set(k, v); },
        },
      });
      let err = null;
      try {
        await DC.processUser(clone(c.row));
      } catch (e) {
        err = e.message;
      }
      const got = {
        err: err === null ? null : 'error',
        calls: calls.map((x) => ({ uid: x.uid, text: x.tgText, silent: x.silent, rows: asBotRows(x.data.actions, { linkAsCallback: true }) })),
        kv: Object.fromEntries(KV),
        logs: L.lines,
      };
      const want = {
        err: c.error === null ? null : 'error',
        calls: c.calls.map((x) => ({ uid: x.uid, text: x.text, silent: x.disable_notification === true, rows: x.reply_markup })),
        kv: c.kv_after,
        logs: c.logs,
      };
      try {
        expect(got).toEqual(want);
      } catch (_e) {
        bad.push({ row: c.row, got, want });
      }
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });

  for (const [i, c] of V.drip_loops.entries()) {
    it(`drip_loop pass ${i}${c.fail_rows ? ' (the rows read fails)' : ''}`, async () => {
      const L = capLog();
      const calls = [];
      const sleeps = [];
      const KV = new Map();
      let T = V.now + DC.LOOP_INTERVAL_S;
      DC.configure({
        clock: () => T, log: L,
        dispatch: fakeDispatch((uid) => c.plan[String(uid)] || 'ok', calls),
        kv: { get: (k) => (KV.has(k) ? KV.get(k) : null), set: (k, v) => { KV.set(k, v); } },
        allRows: async () => {
          if (c.fail_rows) throw new Error('no such table: users');
          return clone(c.rows);
        },
        sleep: async (ms) => { sleeps.push(ms / 1000); T += ms / 1000; },
      });
      const r = await DC.runPass();
      // the bot: sleep(3600) at the loop top, throttle sleeps, then the next top sleep (or the back-off)
      expect([DC.LOOP_INTERVAL_S, ...sleeps, DC.LOOP_INTERVAL_S]).toEqual(c.sleeps);
      expect(r.error !== undefined).toBe(c.fail_rows);
      expect(calls.map((x) => [x.uid, x.tgText])).toEqual(c.calls.map((x) => [x.uid, x.text]));
      expect(Object.fromEntries(KV)).toEqual(c.kv_after);
      expect([['info', '[DRIP] loop started, interval=3600s'], ...L.lines]).toEqual(c.logs);
    });
  }

  it('startLoop: the start line, a pass every hour, one more hour after a failed pass', async () => {
    vi.useFakeTimers({ now: V.now * 1000, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const L = capLog();
    const passes = [];
    let fail = true;
    DC.configure({
      log: L, clock: () => Date.now() / 1000,
      allRows: async () => {
        passes.push(Date.now() / 1000 - V.now);
        if (fail) { fail = false; throw new Error('db locked'); }
        return [];
      },
    });
    const stop = DC.startLoop();
    expect(L.lines[0]).toEqual(['info', '[DRIP] loop started, interval=3600s']);
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    expect(passes).toEqual([3600]);
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    expect(passes).toEqual([3600]);                      // back-off hour after the error
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    expect(passes).toEqual([3600, 3 * 3600]);
    await vi.advanceTimersByTimeAsync(3600 * 1000);
    expect(passes).toEqual([3600, 3 * 3600, 4 * 3600]);
    stop();
    await vi.advanceTimersByTimeAsync(10 * 3600 * 1000);
    expect(passes.length).toBe(3);
  });

  it('the bot\'s constants', () => {
    expect(V.drip_constants).toEqual({ DAYS: [...DC.DRIP_DAYS], LOOP_INTERVAL_S: DC.LOOP_INTERVAL_S, MAX_AGE_DAYS: DC.MAX_AGE_DAYS });
  });
});

// ── H ────────────────────────────────────────────────────────────────────
describe('smart_prompts', () => {
  let rows;
  let rowsFail;
  let T;
  beforeEach(() => {
    rows = V.sp_free.rows;
    rowsFail = false;
    T = V.now;
    SP.resetDeps();
  });
  const wire = (L) => SP.configure({
    log: L, clock: () => T,
    planOf: async () => { if (rowsFail) throw new Error('db locked'); return clone(rows); },
  });

  it('_is_free_active', async () => {
    const L = capLog();
    wire(L);
    for (const c of V.sp_free.cases) {
      rowsFail = Boolean(c.rows_fail);
      expect(await SP.isFreeActive(c.uid)).toBe(c.result);
    }
  });

  it(`trigger_after_win: ${V.sp_win.length} steps (texts, R formatting, throttle, free check, failed sends)`, async () => {
    const L = capLog();
    wire(L);
    for (const c of V.sp_win) {
      T = c.now;
      L.lines.length = 0;
      const calls = [];
      const bot = { notifier: { dispatch: fakeDispatch(() => c.outcome, calls) } };
      await SP.triggerAfterWin(bot, c.uid, c.symbol, c.r);
      expect(calls.map((x) => ({ uid: x.uid, text: x.tgText, rows: asBotRows(x.data.actions, { linkAsCallback: true }) })))
        .toEqual(c.calls.map((x) => ({ uid: x.uid, text: x.text, rows: x.reply_markup })));
      expect(L.lines).toEqual(c.logs);
      const e = SP.throttleEntries().find(([u, k]) => u === c.uid && k === 'after_win');
      expect(e ? e[2] : null).toBe(c.last);
    }
  });

  it(`trigger_after_quota_hit: ${V.sp_quota.length} steps`, async () => {
    const L = capLog();
    wire(L);
    for (const c of V.sp_quota) {
      T = c.now;
      L.lines.length = 0;
      const calls = [];
      const bot = { notifier: { dispatch: fakeDispatch(() => c.outcome, calls) } };
      await SP.triggerAfterQuotaHit(bot, c.uid);
      expect(calls.map((x) => ({ uid: x.uid, text: x.tgText, type: x.type, rows: asBotRows(x.data.actions, { linkAsCallback: true }) })))
        .toEqual(c.calls.map((x) => ({ uid: x.uid, text: x.text, type: 'promo', rows: x.reply_markup })));
      expect(L.lines).toEqual(c.logs);
      const e = SP.throttleEntries().find(([u, k]) => u === c.uid && k === 'after_quota_hit');
      expect(e ? e[2] : null).toBe(c.last);
    }
  });

  it(`throttle + GC over ${V.sp_gc.steps.length} steps (dict size after each, final entries)`, () => {
    wire(capLog());
    expect([SP.PROMPT_TTL_S, SP.GC_THRESHOLD]).toEqual([V.sp_gc.TTL, V.sp_gc.GC_THRESHOLD]);
    let size = 0;
    for (const [t, uid, kind, can, n] of V.sp_gc.steps) {
      T = t;
      const got = SP.canSend(uid, kind);
      expect(got).toBe(can);
      if (got) SP.markSent(uid, kind);
      size = SP.throttleEntries().length;
      expect(size).toBe(n);
    }
    const final = SP.throttleEntries().sort((a, b) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(final).toEqual(V.sp_gc.final);
  });
});
