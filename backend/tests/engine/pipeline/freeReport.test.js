/**
 * freeReport on Python vectors (fixtures/free.json, tools/gen_vectors.py `free`, with
 * free_report.datetime / time faked and kv in memory):
 *   LEVELS windows 06–13 / 13–21 UTC (off-hours, one per window, quality ≥ 5, last-hour relax
 *   to 3, day reset, record with / without an explicit window, pro bypass), the missed
 *   buffer (≤ 50 per user, kv save every 10), closed-profitable buffer (last 100, save every 5),
 *   SMC preview dedup + quota 3/day + kv persistence, the preview card text, buffer restore
 *   from kv, and the 21:00 evening report texts ([EVENING-DATE], > 5 rows, RU/EN/fallback).
 *
 *   Python: fr.datetime = FakeDT; await fr.should_send_free_signal(user, q); fr.record_free_signal_sent(user, "") …
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const FR = req('../../../services/engine/freeReport.js');
const { PLAN_FEATURES } = req('../../../config/planFeatures.js');
const { load, clock, memKv, captureLog } = req('./vectors.js');

const V = load('free');
const FIELDS = ['free_signals_date', 'free_signals_morning', 'free_signals_evening', 'free_signals_night', 'free_signals_today',
  'free_missed_today', 'free_smc_preview_date', 'free_smc_preview_today'];
const ustate = (u) => Object.fromEntries(FIELDS.map((k) => [k, u[k] === undefined ? null : u[k]]));
const tsOf = (day, hh, mm = 0) => Date.UTC(2027, 2, day, hh, mm) / 1000;

function newUser(uid, plan = 'free', extra = {}) {
  return {
    user_id: uid, sub_plan: plan, lang: 'ru', free_signals_date: '', free_signals_morning: 0, free_signals_evening: 0,
    free_signals_night: 0, free_signals_today: 0, free_missed_today: 0, free_smc_preview_date: '', free_smc_preview_today: 0, ...extra,
  };
}

function make() {
  const c = clock(0);
  const kv = memKv();
  const log = captureLog();
  return { c, kv, log, fr: FR.createFreeReport({ now: c.now, kv, log, features: PLAN_FEATURES.free }) };
}

describe('constants', () => {
  it('quota 3/day (free_report._FREE_SMC_PREVIEW_DAILY_QUOTA)', () => {
    expect(FR.FREE_SMC_PREVIEW_DAILY_QUOTA).toBe(V.quota_const);
    expect(PLAN_FEATURES.free.min_signal_quality).toBe(5);
    expect(PLAN_FEATURES.free.signal_window_morning_utc).toEqual([6, 13]);
    expect(PLAN_FEATURES.free.signal_window_evening_utc).toEqual([13, 21]);
  });
});

describe('LEVELS free windows + counters (bot replay)', () => {
  it('replays should_send_free_signal / record_free_signal_sent', () => {
    const { c, log, fr } = make();
    const users = {
      a: newUser(101), b: newUser(102), pro: newUser(103, 'pro'),
      c: newUser(104, 'free', { free_signals_date: '2027-03-01', free_signals_morning: 1, free_signals_evening: 1, free_signals_today: 2 }),
    };
    for (const q of V.quota) {
      const [kind, who, day, hh, mm, arg] = q.op;
      c.t = tsOf(day, hh, mm);
      expect(c.t).toBe(q.now);
      log.lines.length = 0;
      let res = null;
      if (kind === 'should') res = fr.shouldSendFreeSignal(users[who], arg);
      else fr.recordFreeSignalSent(users[who], arg);
      const where = JSON.stringify(q.op);
      expect(res, where).toBe(q.result);
      expect(ustate(users[who]), where).toEqual(q.user);
      expect(log.lines.map((l) => l[1]), where).toEqual(q.logs);
    }
  });
});

describe('missed / closed-profitable buffers (bot replay)', () => {
  it('missed buffer: cap 50 per user, kv save every 10, daily free_missed_today', () => {
    const { c, kv, fr } = make();
    const u = newUser(201);
    const nou = { user_id: 202 };
    for (const step of V.missed) {
      const i = step.i;
      if (i < 55) {
        c.t = tsOf(3, 10, 0) + i * 7.25;
        const target = [u, nou, 203][i % 3];
        fr.recordMissedSignal(target, `S${i}-USDT-SWAP`, i % 2 ? 'LONG' : 'SHORT', i % 10, [0, 0.5, 1.25, 2.75][i % 4]);
      } else {
        c.t = tsOf(4, 1, 0);
        fr.recordMissedSignal(u, 'X-USDT-SWAP', 'LONG', 5);
      }
      expect(ustate(u), `missed ${i}`).toEqual(step.user);
      expect(kv.writes.filter((w) => w[0] === 'free_missed_buffer'), `missed ${i}`).toEqual(step.writes);
      kv.writes.length = 0;
    }
    expect(Object.fromEntries(Array.from(fr.missedBuffer).map(([k, v]) => [String(k), v]))).toEqual(V.missed_final);
  });

  it('closed profitable: rr > 0 only, last 100, kv save every 5', () => {
    const { c, kv, fr } = make();
    for (const step of V.closed) {
      const i = step.i;
      c.t = tsOf(3, 0, 0) + i * 600.5;
      const rr = [1.5, -1.0, 0.0, 2.0, 0.75, 3.25][i % 6];
      fr.recordClosedProfitable(`C${i}-USDT-SWAP`, i % 2 ? 'SHORT' : 'LONG', rr);
      expect(fr.closedProfitable.length, `closed ${i}`).toBe(step.len);
      expect(fr.closedProfitable[0] || null, `closed ${i}`).toEqual(step.first);
      expect(kv.writes.filter((w) => w[0] === 'free_closed_profitable'), `closed ${i}`).toEqual(step.writes);
      kv.writes.length = 0;
    }
  });
});

describe('SMC Pro preview (bot replay)', () => {
  it('dedup / quota / record / kv persistence', () => {
    const { c, kv, log, fr } = make();
    const u = newUser(301);
    const pro = newUser(302, 'pro');
    for (const step of V.preview) {
      const op = step.op;
      c.t = tsOf(op[op.length - 2], op[op.length - 1], 0);
      log.lines.length = 0;
      let res = null;
      if (op[0] === 'already') res = fr.freePreviewAlreadySentToday(op[1], op[2], op[3]);
      else if (op[0] === 'mark') fr.markFreePreviewSent(op[1], op[2], op[3]);
      else if (op[0] === 'should') res = fr.shouldSendFreeSmcPreview(op[1] === 'u' ? u : pro);
      else if (op[0] === 'record') fr.recordFreeSmcPreviewSent(u);
      const where = JSON.stringify(op);
      expect(res, where).toBe(step.result);
      expect(ustate(u), where).toEqual(step.user);
      expect(kv.writes.filter((w) => w[0] === 'free_preview_sent'), where).toEqual(step.writes);
      expect(log.lines.filter((l) => l[0] === 'INFO').map((l) => l[1]), where).toEqual(step.logs);
      kv.writes.length = 0;
    }
  });

  it.each(V.cards.map((x) => [x.symbol, x.lang, x]))('preview card %s %s', (_s, _l, x) => {
    const { fr } = make();
    expect(fr.previewCardText(x.sig, x.symbol, x.lang)).toBe(x.text);
  });
});

describe('load_persistent_buffers (bot table)', () => {
  it.each(V.loads.map((l, i) => [i, l]))('#%i', (_i, l) => {
    const { c, kv, fr } = make();
    c.t = tsOf(7, 12, 0);
    if (l.missed !== null) kv.set('free_missed_buffer', l.missed);
    if (l.closed !== null) kv.set('free_closed_profitable', l.closed);
    if (l.preview !== null) kv.set('free_preview_sent', l.preview);
    fr.loadPersistentBuffers();
    expect(Object.fromEntries(Array.from(fr.missedBuffer).map(([k, v]) => [String(k), v]))).toEqual(l.missed_buffer);
    expect(fr.closedProfitable).toEqual(l.closed_buffer);
    expect(Object.fromEntries(Array.from(fr.previewSent).map(([k, m]) => [String(k), Object.fromEntries(m)]))).toEqual(l.preview_sent);
  });
});

describe('evening report (bot texts)', () => {
  it('21:00 UTC report, buffers cleared and persisted empty', async () => {
    const { c, kv, fr } = make();
    const R = V.report;
    c.t = R.now;
    fr._setBuffers({ missed: { 1: [{ symbol: 'Q' }] }, closed: R.closed });
    const sent = [];
    const users = R.users.map((u) => ({ ...u }));
    kv.writes.length = 0;
    const n = await fr.sendEveningReport(users, async (uid, text) => { sent.push([uid, text]); }, { sleep: async () => {} });
    expect(n).toBe(R.sent.length);
    expect(sent).toEqual(R.sent);
    expect(kv.writes).toEqual(R.writes);
    expect(fr.missedBuffer.size).toBe(0);
    expect(fr.closedProfitable).toEqual([]);
    fr._setBuffers({ closed: R.closed_small });
    const sent2 = [];
    await fr.sendEveningReport(users, async (uid, text) => { sent2.push([uid, text]); }, { sleep: async () => {} });
    expect(sent2).toEqual(R.sent_small);
  });

  it('next report time is 21:00 UTC', () => {
    const { fr } = make();
    expect(fr.secondsUntilReport(tsOf(8, 20, 0))).toBe(3600);
    expect(fr.secondsUntilReport(tsOf(8, 21, 0))).toBe(86400);
    expect(fr.secondsUntilReport(tsOf(8, 23, 30))).toBe(21.5 * 3600);
  });
});
