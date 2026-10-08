/**
 * Adversarial parity (M17a verification) against the bot's own Python
 * (gen/gen_verify_vectors.py, independent seed and a much wider input domain than
 * gen_challenge_vectors.py). Regenerate:
 *   cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 \
 *     <venv>/bin/python <repo>/backend/tests/challenge/gen/gen_verify_vectors.py \
 *     <repo>/backend/tests/challenge/fixtures/verify_vectors.json.gz
 *   rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
 *
 *   A build / plan / plan_text / _challenge_dict on 300 random answer sets (Unicode digits and
 *     spaces of every kind, PEP 515 underscores, > 4300-digit ints, 200-char repr truncation,
 *     non-printable characters, quotes, wrong types)
 *   B progress + texts on 100 random row sets       C discipline on 200 random limits
 *   D gate on 200 users (signal_trades + engine_kv)  E tick: 30 days × 10 challenges
 *   F kv JSON round trips + add_topup / notify_once / finish replays
 *   G entry advisor: 40 env variants, 50 MISSED histories, pick / text tables
 *   H _parse_num / _answers                          I Mini App routes (rate buckets included)
 * Numbers are compared strictly (Object.is — the sign of zero shows in the texts), except in
 * HTTP bodies where JSON itself drops it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import request from 'supertest';
import { createRequire } from 'module';
import { setupEnv, insertUser, insertTrade, quietLog, captureLog } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('verify');

const revive = (x) => {
  if (Array.isArray(x)) return x.map(revive);
  if (x && typeof x === 'object') {
    const ks = Object.keys(x);
    if (ks.length === 1 && ks[0] === '$f') return { inf: Infinity, '-inf': -Infinity, nan: NaN }[x.$f];
    const o = {};
    for (const k of ks) o[k] = revive(x[k]);
    return o;
  }
  return x;
};
const V = revive(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(process.cwd(), 'tests', 'challenge', 'fixtures', 'verify_vectors.json.gz'))).toString('utf8')));
const TICK_UIDS = new Set(Object.keys(V.tick.users).map(Number));

let db; let C; let EA; let ts; let kvSvc; let pycoerce;

/** First difference between two JSON-shaped values ('' when equal); numbers by Object.is. */
function diff(a, b, p = '$', loose = false) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return '';
    return (loose ? a === b : Object.is(a, b)) ? '' : `${p}: ${String(Object.is(a, -0) ? '-0' : a)} != ${String(Object.is(b, -0) ? '-0' : b)}`;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return `${p}: array vs ${JSON.stringify(b)}`;
    if (a.length !== b.length) return `${p}: length ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i += 1) { const d = diff(a[i], b[i], `${p}[${i}]`, loose); if (d) return d; }
    return '';
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
    if (ka.join('\u{1}') !== kb.join('\u{1}')) return `${p}: keys ${JSON.stringify(ka)} != ${JSON.stringify(kb)}`;
    for (const k of ka) { const d = diff(a[k], b[k], `${p}.${k}`, loose); if (d) return d; }
    return '';
  }
  return a === b ? '' : `${p}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
}

function etype(e) {
  if (e && e.pyType) return e.pyType;
  if (e instanceof pycoerce.PyValueError) return 'ValueError';
  if (e instanceof pycoerce.PyTypeError) return 'TypeError';
  return e && e.constructor ? e.constructor.name : typeof e;
}

const errOf = (e) => ({ ok: false, etype: etype(e), msg: String(e && e.message) });
const short = (x) => { const s = JSON.stringify(x); return s && s.length > 300 ? `${s.slice(0, 300)}…` : s; };

beforeAll(() => {
  db = nodeRequire('../../models/database.js');
  C = nodeRequire('../../services/challengeService.js');
  EA = nodeRequire('../../services/entryAdvisor.js');
  ts = nodeRequire('../../services/traderSettingsService.js');
  kvSvc = nodeRequire('../../services/engineKvService.js');
  pycoerce = nodeRequire('../../services/engine/pycoerce.js');
  for (const uid of V.uids) insertUser(db, uid, { isAdmin: uid === 123 ? 1 : 0 });
  for (const r of V.db_rows) if (!TICK_UIDS.has(r.user_id)) insertTrade(db, r);
});

// ═══════════════════════════════════════════════════════════════════════
describe('A. build / plan / texts (300 random answer sets)', () => {
  it('build: value or the bot error (type + message), _challenge_dict, two plans with texts each', () => {
    C.resetDeps();
    C.configure({ log: quietLog });
    const bad = [];
    for (const [i, c] of V.build.entries()) {
      let got;
      let ch = null;
      try {
        ch = C.build(c.uid, c.answers, c.now);
        got = { ok: true, json: ch.toJson() };
      } catch (e) {
        got = errOf(e);
      }
      const want = c.ok ? { ok: true, json: c.json } : { ok: false, etype: c.etype, msg: c.msg };
      const d = diff(got, want);
      if (d) { bad.push({ i, answers: short(c.answers), d }); continue; }
      if (!c.ok) {
        if (C.badText(got.msg, 'ru') !== c.bad_ru) bad.push({ i, what: 'bad_ru' });
        continue;
      }
      const dd = diff(C.challengeDict(ch), c.dict);
      if (dd) bad.push({ i, what: 'dict', d: dd });
      for (const [j, p] of c.plans.entries()) {
        const pl = C.plan(ch, p.stats, p.now);
        const dp = diff(pl, p.plan);
        if (dp) { bad.push({ i, j, what: 'plan', d: dp }); continue; }
        for (const lg of ['ru', 'en', 'de']) if (C.planText(ch, pl, lg) !== p[lg]) bad.push({ i, j, lg, got: C.planText(ch, pl, lg), want: p[lg] });
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('B. progress on random rows', () => {
  it('progress dict + progress_text (full / short, RU / EN) + block_text', () => {
    C.resetDeps();
    const bad = [];
    for (const [i, c] of V.progress.entries()) {
      const ch = C.fromJson(c.json);
      let pr;
      try {
        pr = C.progress(ch, c.rows, c.now);
      } catch (e) {
        bad.push({ i, err: e.message });
        continue;
      }
      const d = diff(pr, c.progress);
      if (d) { bad.push({ i, d }); continue; }
      const texts = {
        ru: C.progressText(ch, pr, 'ru'), en: C.progressText(ch, pr, 'en'),
        ru_short: C.progressText(ch, pr, 'ru', true), en_short: C.progressText(ch, pr, 'en', true),
        block_ru: pr.blocked ? C.blockText(pr.block_reason, 'ru') : null,
        block_en: pr.blocked ? C.blockText(pr.block_reason, 'en') : null,
      };
      for (const [k, v] of Object.entries(texts)) if (v !== c[k]) bad.push({ i, k, got: v, want: c[k] });
    }
    expect(bad).toEqual([]);
  });
});

describe('C. discipline', () => {
  it('200 random (status, limits, trades today, R today)', () => {
    const bad = [];
    for (const [i, c] of V.discipline.entries()) {
      const ch = new C.Challenge({
        user_id: 1, started_at: V.t0, deposit: 1000.0, goal_kind: 'pct', goal_value: 10.0,
        risk_pct: c.risk, max_trades_day: c.mtd, daily_loss_pct: c.dlp, status: c.status,
      });
      const d = diff([...C.discipline(ch, c.sig, c.tr), ch.daily_loss_r], [c.blocked, c.reason, c.daily_loss_r]);
      if (d) bad.push({ i, c, d });
    }
    expect(bad).toEqual([]);
  });
});

describe('D. gate on signal_trades + engine_kv', () => {
  it('200 users: fail-open on a broken / unreadable record, block reasons otherwise', () => {
    C.resetDeps();
    const log = captureLog();
    let clock = V.t0;
    C.configure({ log, clock: () => clock });
    db.prepare("DELETE FROM engine_kv WHERE key LIKE 'challenge%'").run();
    const bad = [];
    for (const c of V.gate) {
      if (c.kv !== null) kvSvc.set(C.key(c.uid), c.kv);
      clock = c.wall;
      const g = C.gate(c.uid, c.now);
      if (g !== c.gate) bad.push({ uid: c.uid, kind: c.kind, got: g, want: c.gate });
    }
    expect(bad).toEqual([]);
    const broken = V.gate.filter((c) => c.kind === 'broken' && c.kv && c.kv.startsWith('{"user_id"')).length;
    expect(log.lines.filter((l) => l.includes('[CHALLENGE-GATE]') && l.includes('kv read failed')).length).toBe(broken);
    db.prepare("DELETE FROM engine_kv WHERE key LIKE 'challenge%'").run();
  });
});

describe('E. tick: 30 days, 10 challenges', () => {
  it(`replays ${V.tick.timeline.length} ticks (counters, messages, cards, kv JSON, gate)`, async () => {
    C.resetDeps();
    db.prepare("DELETE FROM engine_kv WHERE key LIKE 'challenge%'").run();
    let clock = V.t0;
    let failUm = false;
    const sent = [];
    const cards = [];
    const langs = V.tick.langs;
    C.configure({
      clock: () => clock,
      log: quietLog,
      getUser: async (uid) => {
        if (uid === 5006 && failUm) throw new Error('user lookup failed');
        return { user_id: uid, lang: langs[String(uid)] };
      },
      notifier: {
        sendText: async (uid, text) => { sent.push([uid, text]); return { dispatched: true }; },
        sendCard: async (uid, p) => { cards.push({ uid, stats: p.stats, period: p.period, days: p.days, lang: p.lang, filename: p.filename }); },
      },
    });
    const snap = () => Object.fromEntries(db.prepare("SELECT key, value FROM engine_kv WHERE key LIKE 'challenge%'").all().map((r) => [r.key, r.value]));
    let prev = {};
    const bad = [];
    const byUid = (msgs) => { const m = {}; for (const [u, t] of msgs) (m[u] = m[u] || []).push(t); return m; };
    for (const e of V.tick.timeline) {
      for (const op of e.ops) {
        const [kind] = op;
        if (kind === 'start') { clock = op[2]; C.save(C.build(op[1], op[3], op[2])); }
        if (kind === 'insert') insertTrade(db, op[1]);
        if (kind === 'update') {
          const ks = Object.keys(op[2]).sort();
          db.prepare(`UPDATE signal_trades SET ${ks.map((k) => `${k}=?`).join(', ')} WHERE trade_id=?`).run(...ks.map((k) => op[2][k]), op[1]);
        }
        if (kind === 'fail_um') failUm = op[1];
        if (kind === 'topup') { clock = op[3]; C.addTopup(C.load(op[1]), op[2]); }
        if (kind === 'finish') C.finish(C.load(op[1]), C.STATUS_CANCELLED, op[2]);
      }
      clock = e.wall;
      sent.length = 0;
      cards.length = 0;
      const st = await C.tick({ now: e.t });
      const now = snap();
      const changed = Object.fromEntries(Object.entries(now).filter(([k, v]) => prev[k] !== v));
      prev = now;
      const gates = {};
      for (const uid of Object.keys(e.gates)) gates[uid] = C.gate(Number(uid), e.t);
      // per user: the order of the challenges inside one pass is the kv scan order (the bot's
      // INSERT OR REPLACE moves a saved key to the end of the table), which no user can observe
      const cardsBy = (cs) => byUid(cs.map((c) => [c.uid, c]));
      const d = diff({ st, sent: byUid(sent), cards: cardsBy(cards), kv: changed, gates },
        { st: e.stats, sent: byUid(e.sent), cards: cardsBy(e.cards), kv: e.kv, gates: e.gates });
      if (d) bad.push({ t: e.t, d });
      if (bad.length > 5) break;
    }
    expect(bad).toEqual([]);
    // a record from_json cannot build aborts the whole pass with the dataclass TypeError
    clock = V.tick.broken_wall;
    kvSvc.set('challenge_5999', '{"user_id": 5999, "deposit": 5}');
    let broken;
    try { await C.tick({ now: clock }); broken = { ok: true }; } catch (e) { broken = errOf(e); }
    expect(broken).toEqual(V.tick.broken_tick);
    db.prepare("DELETE FROM engine_kv WHERE key='challenge_5999'").run();
    for (const [uid, line] of Object.entries(V.tick.final_lines)) {
      expect([uid, C.dailySummaryLine({ user_id: Number(uid), lang: langs[uid] })]).toEqual([uid, line]);
    }
    expect(snap()).toEqual(V.tick.final_kv);
  });
});

describe('F. kv JSON', () => {
  it('add_topup / notify_once / finish replays end byte-identical; from_json of every raw variant', () => {
    C.resetDeps();
    let clock = V.t0;
    const store = new Map();
    C.configure({ clock: () => clock, log: quietLog, kv: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) } });
    const bad = [];
    for (const [i, c] of V.kv_json.entries()) {
      const ch = C.fromJson(c.start);
      for (const op of c.ops) {
        clock = op[2];
        if (op[0] === 'topup') {
          let ok = true;
          try { C.addTopup(ch, op[1]); } catch (_e) { ok = false; }
          if (ok !== op[3]) bad.push({ i, op });
        } else if (op[0] === 'notify') {
          if (C.notifyOnce(ch, op[1]) !== op[3]) bad.push({ i, op });
        } else {
          C.finish(ch, op[1], op[2]);
        }
      }
      if (ch.toJson() !== c.good) { bad.push({ i, got: ch.toJson(), want: c.good }); continue; }
      if (store.get(C.key(ch.user_id)) !== undefined && c.ops.length && store.get(C.key(ch.user_id)) !== c.good) bad.push({ i, what: 'stored' });
      const derived = {
        goal_usd: ch.goal_usd, goal_profit_usd: ch.goal_profit_usd, risk_usd: ch.risk_usd, r_needed: ch.r_needed,
        topups_total: ch.topups_total, daily_loss_r: ch.daily_loss_r,
      };
      const d = diff(derived, c.derived) || diff(C.challengeDict(ch), c.dict);
      if (d) bad.push({ i, d });
      for (const r of c.raws) {
        let got;
        try { const c2 = C.fromJson(r.raw); got = { ok: true, json: c2 === null ? null : c2.toJson() }; } catch (e) { got = errOf(e); }
        const want = r.ok ? { ok: true, json: r.json } : { ok: false, etype: r.etype, msg: r.msg };
        const dr = diff(got, want);
        if (dr) bad.push({ i, raw: short(r.raw), d: dr });
      }
    }
    for (const [i, c] of V.topup.entries()) {
      const ch = C.fromJson(c.start);
      clock = c.wall;
      let got;
      try { C.addTopup(ch, c.amount); got = { ok: true, json: ch.toJson(), total: ch.topups_total }; } catch (e) { got = errOf(e); }
      const want = c.ok ? { ok: true, json: c.json, total: c.total } : { ok: false, etype: c.etype, msg: c.msg };
      const d = diff(got, want);
      if (d) bad.push({ topup: i, amount: short(c.amount), d });
    }
    expect(bad).toEqual([]);
  });
});

describe('G. entry advisor', () => {
  it('readConfig on 40 random ENTRY_ADVISOR_* environments', () => {
    const bad = [];
    for (const c of V.advisor_env) {
      let got;
      try { got = { ok: true, cfg: EA.readConfig(c.env) }; } catch (e) { got = errOf(e); }
      const want = c.ok ? { ok: true, cfg: c.cfg } : { ok: false, etype: c.etype, msg: c.msg };
      const d = diff(got, want);
      if (d) bad.push({ env: c.env, d });
    }
    expect(bad).toEqual([]);
  });

  it('50 MISSED histories: missed_stats SQL, pick_advice, advise_user (text, buttons, silent, kv, return)', async () => {
    EA.resetDeps();
    const { now, cases } = V.advisor;
    const bad = [];
    for (const c of cases) {
      const kvm = new Map();
      if (c.kv0 !== null) kvm.set(`${EA.KV_PREFIX}${c.uid}`, c.kv0);
      const sent = [];
      EA.configure({
        db, clock: () => now, log: quietLog,
        kv: {
          get: (k) => { const v = kvm.has(k) ? kvm.get(k) : null; if (v === 'RAISE') throw new Error('kv down'); return v; },
          set: (k, v) => kvm.set(k, v),
        },
        sender: async (uid, { text, actions, silent }) => {
          sent.push({ uid, text, disable_notification: silent, buttons: actions.map((a) => [a.text, a.action]) });
          return c.send_ok ? { dispatched: true } : { error: 'user_not_found' };
        },
      });
      const ms = EA.missedStats(c.uid);
      const user = { ...ts.defaults(c.uid), ...c.attrs };
      const ret = await EA.adviseUser(user, now);
      const d = diff({ ms, pick: EA.pickAdvice(ms), ret, sent, kv: Object.fromEntries(kvm) },
        { ms: c.missed, pick: c.pick, ret: c.ret, sent: c.sent, kv: c.kv });
      if (d) bad.push({ uid: c.uid, d });
    }
    expect(bad).toEqual([]);
  });

  it('pick_advice / advice_text tables', () => {
    EA.resetDeps();
    const bad = [];
    for (const [st, want] of V.advisor_pick) { const d = diff(EA.pickAdvice(st), want); if (d) bad.push({ st, d }); }
    for (const [s, m, t, lg, text] of V.advisor_text) if (EA.adviceText(s, m, t, lg) !== text) bad.push({ s, m, t, lg });
    expect(bad).toEqual([]);
  });
});

describe('H. questionnaire helpers', () => {
  it('_parse_num / _answers', () => {
    const bad = [];
    for (const [s, ok, want] of V.parse_num) {
      let got;
      try { got = [true, C.parseNum(s)]; } catch (e) { got = [false, errOf(e)]; }
      const d = diff(got, [ok, want]);
      if (d) bad.push({ s, d });
    }
    for (const c of V.answers_from_state) {
      let got;
      try { got = { ok: true, answers: C.answersFromState(c.state) }; } catch (e) { got = errOf(e); }
      const want = c.ok ? { ok: true, answers: c.answers } : { ok: false, etype: c.etype, msg: c.msg };
      const d = diff(got, want);
      if (d) bad.push({ state: c.state, d });
    }
    expect(bad).toEqual([]);
  });
});

describe('I. Mini App routes', () => {
  it(`replays ${V.routes.steps.length} requests through /api/app/challenge*`, async () => {
    const app = (await import('../../server.js')).default;
    const appRouter = nodeRequire('../../routes/app.js');
    const authService = nodeRequire('../../services/authService.js');
    const R = V.routes;
    for (const uid of Object.keys(R.plans).map(Number)) {
      const u = ts.getOrCreate(uid);
      Object.assign(u, { sub_plan: R.plans[uid], sub_status: 'active', sub_expires: R.expires });
      ts.save(u);
    }
    db.prepare("DELETE FROM engine_kv WHERE key LIKE 'challenge%'").run();
    appRouter.resetRateLimits();
    C.resetDeps();
    let clock = V.t0;
    appRouter.setClock(() => clock);
    C.configure({ clock: () => clock, log: quietLog, hasKeys: (u) => Object.prototype.hasOwnProperty.call(R.keys, String(u.user_id)) });
    const URL = {
      'GET challenge': ['get', '/api/app/challenge'], 'POST challenge': ['post', '/api/app/challenge'],
      'POST challenge/topup': ['post', '/api/app/challenge/topup'], 'POST challenge/finish': ['post', '/api/app/challenge/finish'],
    };
    const fields = Object.keys(R.steps[0].user);
    const bad = [];
    for (const [i, s] of R.steps.entries()) {
      clock = s.now;
      const [method, url] = URL[s.route];
      let req = request(app)[method](url).set('Authorization', `Bearer ${authService._signAccessToken(s.uid)}`);
      if (method === 'post' && s.body !== null) req = req.send(s.body);
      const res = await req;
      const kv = db.prepare('SELECT value FROM engine_kv WHERE key = ?').get(`challenge_${s.uid}`);
      const u = ts.get(s.uid);
      const got = { status: res.status, json: JSON.parse(JSON.stringify(res.body)), kv: kv ? kv.value : null, user: Object.fromEntries(fields.map((k) => [k, u[k]])) };
      const want = { status: s.status, json: JSON.parse(JSON.stringify(s.json)), kv: s.kv, user: s.user };
      const d = diff(got, want, '$', true);
      if (d) bad.push({ i, uid: s.uid, route: s.route, body: short(s.body), d });
      if (bad.length > 8) break;
    }
    appRouter.setClock(null);
    appRouter.resetRateLimits();
    expect(bad).toEqual([]);
  });
});
