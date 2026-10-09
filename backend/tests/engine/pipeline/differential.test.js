/**
 * Randomized differential replay against the bot (adversarial M9a verification):
 * fixtures/diff_<section>.json from tools/gen_differential.py, card signal objects from
 * tools/dumpDiffCardSignals.js. Sequences are delta-encoded (each step carries only the
 * observed fields that changed); the expected state is carried forward step by step.
 *
 *   loads     pyLoads vs CPython json.loads — values, int/float, dict order, NaN tokens, error text
 *   registry  signal_registry: 40 random peek/commit/claim/cooldown/clear/cleanup/stats/restart
 *             sequences — results, registry, persisted JSON bytes, INFO/WARNING logs; _persist_load
 *   fresh     is_signal_fresh / get_current_price / tolerance and is_momentum_veto (100 + 100, random env)
 *   trend     compute_trend / ribbon_strength (30 frames × 6 TFs), refresh() + restarts (kv bytes,
 *             NaN closes), apply_mtf_bonus ×3 (idempotence, deepcopy, SMC grade bot + D6), card_line
 *   free      free_report across day boundaries (30 sequences): counters, buffers, kv bytes, report
 *   cards     LEVELS / SMC / VOLUME full + lite + assembled cards and keyboards (12 signals × 3 each)
 *   repo      db/trades.py + signal_progress + trade_events + signals: the table after every step
 *
 *   Python: cd <bot> && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python tools/gen_differential.py
 *           (e.g. sr.peek_can_send(1, "BTC-USDT-SWAP", "LONG", "SMC"), json.loads(raw),
 *            asyncio.run(fr.should_send_free_signal(user, q)), await dbt.db_set_trade_result(...))
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const R = req('../../../services/engine/signalRegistry.js');
const F = req('../../../services/engine/signalFreshness.js');
const MV = req('../../../services/engine/momentumVeto.js');
const TM = req('../../../services/engine/trendMonitor.js');
const FR = req('../../../services/engine/freeReport.js');
const Repo = req('../../../services/engine/signalTradesRepo.js');
const levels = req('../../../services/engine/cards/levels.js');
const smc = req('../../../services/engine/cards/smc.js');
const volume = req('../../../services/engine/cards/volume.js');
const lite = req('../../../services/engine/cards/lite.js');
const kb = req('../../../services/engine/cards/keyboards.js');
const { createSignalConfluence } = req('../../../services/engine/signalConfluence.js');
const { positionLine } = req('../../../services/engine/positionLine.js');
const { wmInject } = req('../../../services/engine/watermark.js');
const pf = req('../../../config/planFeatures.js');
const Database = req('better-sqlite3');
const { signalTradesDDL, TRADE_EVENTS_DDL, TRADE_FEEDBACK_DDL } = req('../../../models/engineSchema.js');
const { load, clock, memKv, captureLog, frameOf } = req('./vectors.js');

const quiet = { debug() {}, info() {}, warning() {}, error() {} };

/** Carry a delta-encoded expectation forward: `keys` start at null, each step overrides what changed. */
function expectations(steps, keys) {
  const cur = Object.fromEntries(keys.map((k) => [k, null]));
  return steps.map((s) => {
    for (const [k, v] of Object.entries(s)) if (k !== 'op') cur[k] = v;
    return { op: s.op, ...JSON.parse(JSON.stringify(cur, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? { $f: Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf') } : v))) };
  });
}
const revive = (x) => JSON.parse(JSON.stringify(x), (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$f === 'string'
  ? (v.$f === 'nan' ? NaN : (v.$f === 'inf' ? Infinity : -Infinity)) : v));

// ── loads ──────────────────────────────────────────────────────────────────
describe('pyLoads = CPython json.loads', () => {
  const L = JSON.parse(req('fs').readFileSync(req('path').join(__dirname, 'fixtures', 'diff_loads.json'), 'utf8'));
  const same = (js, py) => {
    if (py && typeof py === 'object' && !Array.isArray(py)) {
      if ('$f' in py) return typeof js === 'number' && (py.$f === 'nan' ? Number.isNaN(js) : js === (py.$f === 'inf' ? Infinity : -Infinity));
      if ('$float' in py) return typeof js === 'number' && Object.is(js, Number(py.$float));
      if ('$int' in py) return typeof js === 'number' && Object.is(js, Number(py.$int));
      if ('$dict' in py) {
        if (!(js instanceof Map)) return false;
        const e = Array.from(js.entries());
        return e.length === py.$dict.length && e.every(([k, v], i) => k === py.$dict[i][0] && same(v, py.$dict[i][1]));
      }
    }
    if (Array.isArray(py)) return Array.isArray(js) && js.length === py.length && js.every((v, i) => same(v, py[i]));
    return js === py;
  };
  it.each(L.cases.map((c, i) => [i, JSON.stringify(c.in).slice(0, 40), c]))('#%i %s', (_i, _s, c) => {
    let got;
    let err = null;
    try { got = Repo.pyLoads(c.in, { mapDepth: 99 }); } catch (e) { err = e.message; }
    if (c.err !== undefined) expect(err).toBe(c.err);
    else {
      expect(err).toBe(null);
      expect(same(got, c.ok)).toBe(true);
    }
  });
  it('plain objects below mapDepth, a duplicate key keeps its first position', () => {
    const v = Repo.pyLoads('{"b": {"7": 1, "101": 2}, "a": 1, "b": 3}', { mapDepth: 1 });
    expect(Array.from(v.keys())).toEqual(['b', 'a']);
    expect(v.get('b')).toBe(3);
    expect(Repo.pyLoads('{"x": {"y": NaN}}').x.y).toBeNaN();
  });
});

// ── registry ───────────────────────────────────────────────────────────────
describe('signal_registry random sequences (bot replay)', () => {
  const V = load('diff_registry');
  const make = (c, kv, log) => R.createSignalRegistry({ now: c.now, kv, log, isMulti: (u) => pf.isMulti(u, { admin: u.user_id === 123 }) });
  it.each(V.seqs.map((s, i) => [i, s.steps.length, s]))('sequence #%i (%i steps)', (_i, _n, seq) => {
    const c = clock(seq.t0);
    const kv = memKv();
    const log = captureLog();
    let r = make(c, kv, log);
    for (const [i, s] of expectations(seq.steps, ['now', 'result', 'registry', 'persisted', 'logs']).entries()) {
      const op = s.op;
      let res = null;
      switch (op[0]) {
        case 'advance': c.advance(op[1]); break;
        case 'peek': res = r.peekCanSend(op[1], op[2], op[3], op[4]); break;
        case 'commit': r.commitSend(op[1], op[2], op[3], op[4], op[5]); break;
        case 'can_send': res = r.canSend(op[1], op[2], op[3], op[4]); break;
        case 'peek_multi': res = r.peekCanSendMulti(op[1], op[2], op[3]); break;
        case 'claim_multi': r.claimMulti(op[1], op[2], op[3], op[4]); break;
        case 'commit_multi': r.commitSendMulti(op[1], op[2], op[3]); break;
        case 'can_send_multi': res = r.canSendMulti(op[1], op[2], op[3]); break;
        case 'cooldown': r.applyCooldown(op[1], op[2], op[3], op[4]); break;
        case 'clear': r.clearForSymbol(op[1], op[2], op[3]); break;
        case 'cleanup': r.cleanup(); break;
        case 'stats': res = r.getStats(); break;
        case 'force_save': res = r.forceSave(); break;
        case 'reset_stats': r.resetStats(); break;
        case 'restart': r = make(c, kv, log); r.load(); break;
        default: throw new Error(op[0]);
      }
      const where = `step ${i} ${JSON.stringify(op)}`;
      expect(c.t, where).toBe(s.now);
      expect(res, where).toEqual(s.result);
      expect(r.snapshot(), where).toEqual(s.registry);
      expect(kv.get('signal_registry'), where).toBe(s.persisted);
      expect(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING'), where).toEqual(s.logs);
      log.lines.length = 0;
    }
  });
  it.each(V.loads.map((c, i) => [i, c.raw.slice(0, 50), c]))('_persist_load #%i %s', (_i, _s, c) => {
    const kv = memKv();
    kv.set('signal_registry', c.raw);
    const log = captureLog();
    const r = make(clock(c.now), kv, log);
    r.load();
    expect(r.snapshot()).toEqual(c.registry);
    expect(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING')).toEqual(c.logs);
  });
});

// ── freshness / momentum veto ──────────────────────────────────────────────
describe('signal_freshness / momentum_veto random tuples (bot values)', () => {
  const V = load('diff_fresh');
  it.each(V.fresh.map((c, i) => [i, c.direction, c]))('is_signal_fresh #%i %s', (_i, _d, c) => {
    const log = captureLog();
    const f = F.createFreshness({ env: c.env, log, getCandles: (_s, tf) => (c.frames[tf] === undefined ? null : frameOf(c.frames[tf])) });
    for (const [s, sec] of c.reports) f.reportCycleTime(s, sec);
    expect(f.MAX_DRIFT_R).toBe(c.max_drift);
    const ema = f.getCycleEma(c.strategy);
    expect(ema).toBe(c.ema);
    expect(f.computeTolerancePct(ema)).toBe(c.tol);
    expect(f.getCurrentPrice(c.symbol)).toBe(c.price);
    log.lines.length = 0;
    expect(f.isSignalFresh({ symbol: c.symbol, direction: c.direction, entry: c.entry, tp1: c.tp1, strategy: c.strategy, uid: c.uid, sl: c.sl }))
      .toBe(c.fresh);
    expect(log.lines.filter((l) => l[0] !== 'DEBUG')).toEqual(c.logs);
  });
  it.each(V.veto.map((c, i) => [i, c.direction, c.rows.length, c]))('is_momentum_veto #%i %s n=%i', (_i, _d, _n, c) => {
    const m = MV.createMomentumVeto(c.env);
    expect({ ENABLED: m.ENABLED, ATR: m.DEFAULT_ATR_MULT, VOL: m.DEFAULT_VOL_MULT, LB: m.DEFAULT_LOOKBACK }).toEqual(c.consts);
    const fr = frameOf(c.rows);
    expect(m.isMomentumVeto(fr, c.direction)).toEqual(c.result);
    expect(m.computeAtrPct(fr)).toBe(c.atr_pct);
  });
});

// ── trend monitor ──────────────────────────────────────────────────────────
describe('trend_monitor random frames / sequences / signals (bot replay)', () => {
  const V = load('diff_trend');
  const frames = V.frames.map((rows) => frameOf(rows));
  it('compute_trend + ribbon_strength', () => {
    for (const [fi, tf, prev, want] of V.compute) {
      const got = tf === 'ribbon' ? TM.ribbonStrength(frames[fi], prev) : TM.computeTrend(frames[fi], prev, tf);
      expect(got, `${fi} ${tf} ${prev}`).toBe(want);
    }
  });
  it.each(V.seqs.map((s, i) => [i, s.steps.length, s]))('refresh sequence #%i (%i steps, restarts, kv round trips)', async (_i, _n, seq) => {
    const c = clock(seq.t0);
    const kv = memKv();
    for (const [k, v] of Object.entries(seq.init_kv)) kv.set(k, v);
    const ws = {};
    const restStore = {};
    const restCalls = [];
    const cacheSets = [];
    let restPlan = {};
    const sends = [];
    const log = captureLog();
    const mk = () => TM.createTrendMonitor({
      env: seq.env, kv, log, now: c.now, sleep: async () => {},
      cache: {
        getCandles: (_s, tf) => { if (ws[tf]) return ws[tf]; const e = restStore[tf]; return e && c.t < e[1] ? e[0] : null; },
        setCandles: (s, tf, df, ttl) => { cacheSets.push([s, tf, df.length, ttl]); restStore[tf] = [df, c.t + Object.values(ttl)[0]]; },
      },
      fetcher: {
        getCandles: async (s, tf, limit) => {
          restCalls.push([s, tf, limit, c.t]);
          const p = restPlan[tf] === undefined ? 'none' : restPlan[tf];
          if (p === 'raise') throw new Error('boom');
          if (p === 'none') return null;
          if (p === 'empty') return frameOf([]);
          const rows = V.frames[p];
          return frameOf(limit < rows.length ? rows.slice(-limit) : rows);
        },
      },
      getUsers: () => seq.users,
      send: async (uid, text, { silent }) => { sends.push({ uid, text, silent }); return true; },
    });
    let m = mk();
    m.loadState();
    const keys = ['t', 'changes', 'sends', 'rest_calls', 'cache_sets', 'kv_writes', 'get_all', 'rest_next', 'aligned', 'logs'];
    for (const [i, s] of expectations(seq.steps, keys).entries()) {
      const [op, adv, wsplan, rplan] = s.op;
      c.advance(adv);
      for (const k of Object.keys(ws)) delete ws[k];
      for (const [tf, fi] of Object.entries(wsplan)) ws[tf] = frames[fi];
      restPlan = rplan;
      sends.length = 0; restCalls.length = 0; cacheSets.length = 0; kv.writes.length = 0; log.lines.length = 0;
      let changes = [];
      if (op === 'restart') {
        m = mk();
        for (const k of Object.keys(restStore)) delete restStore[k];
        m.loadState();
      } else {
        changes = await m.refresh();
      }
      const exp = revive(s);
      const where = `step ${i} ${op}`;
      expect(c.t, where).toBe(exp.t);
      expect(changes, where).toEqual(exp.changes);
      expect(sends, where).toEqual(exp.sends);
      expect(restCalls, where).toEqual(exp.rest_calls);
      expect(cacheSets, where).toEqual(exp.cache_sets);
      expect(kv.writes.filter((w) => w[0] === 'trend_state_v1' || w[0] === 'trend_aligned_v1'), where).toEqual(exp.kv_writes);
      expect(m.getAll(), where).toEqual(exp.get_all);
      expect({ ...m._restNext }, where).toEqual(exp.rest_next);
      expect({ dir: m._aligned.dir, since: m._aligned.since, had_kv: Boolean(m._aligned.had_kv) }, where).toEqual(exp.aligned);
      expect(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING'), where).toEqual(exp.logs);
    }
  });
  it.each(V.loads.map((c, i) => [i, c.raw.slice(0, 60), c]))('load_state #%i %s (json.loads: NaN / Infinity)', (_i, _s, c) => {
    const kv = memKv();
    kv.set('trend_state_v1', c.raw);
    const m = TM.createTrendMonitor({ env: {}, kv, log: quiet });
    m.loadState();
    expect({ ...m._state }).toEqual(c.state);
  });
  it.each(V.aligned_loads.map((c, i) => [i, c.raw, c]))('_load_aligned #%i %s', (_i, _s, c) => {
    const kv = memKv();
    kv.set('trend_aligned_v1', c.raw);
    const m = TM.createTrendMonitor({ env: {}, kv, log: quiet });
    m.loadAligned();
    expect({ dir: m._aligned.dir, since: m._aligned.since, had_kv: Boolean(m._aligned.had_kv) }).toEqual(c.aligned);
  });
  it('a NaN last close: RANGE at price NaN is saved as NaN and survives a restart', async () => {
    const kv = memKv();
    const nanFrame = frameOf(V.nan_rows);
    const cache = { getCandles: (_s, tf) => (tf === '15m' ? nanFrame : null), setCandles() {} };
    const m = TM.createTrendMonitor({ env: {}, kv, log: quiet, cache, now: () => 1_800_000_000.25 });
    m.loadState();
    expect(await m.refresh(1_800_000_000.25, { notify: false })).toEqual(V.nan_refresh.changes);
    expect(kv.writes.filter((w) => w[0] === 'trend_state_v1')).toEqual(V.nan_refresh.kv_writes);
    const m2 = TM.createTrendMonitor({ env: {}, kv, log: quiet, cache });
    m2.loadState();
    expect(m2.getAll()).toEqual(V.nan_refresh.after_restart);
  });
  it.each(V.bonus.map((b, i) => [i, b.attr, b]))('apply_mtf_bonus #%i %s ×3 (+ deepcopy) and card_line', (_i, _a, b) => {
    const m = TM.createTrendMonitor({ env: b.env, kv: memKv(), log: quiet });
    m._seed(b.trends, b.strengths);
    let sig = { ...b.init };
    b.runs.forEach((r, rep) => {
      if (rep === 2) sig = JSON.parse(JSON.stringify(sig));
      expect(m.applyMtfBonus(sig, b.attr, b.cap), `rep ${rep}`).toBe(r.ok);
      const fields = {};
      for (const k of ['mtf_aligned', 'strong_counter', 'trend_ctx', b.attr]) fields[k] = sig[k] === undefined ? null : sig[k];
      expect(fields, `rep ${rep}`).toEqual(r.fields);
      if (b.attr === 'score') expect(sig.grade, `rep ${rep} (bot ${r.bot_grade})`).toBe(r.d6_grade);
      for (const lang of ['ru', 'en']) expect(m.cardLine(sig.direction === undefined ? '' : sig.direction, '1h', lang)).toBe(r.card_line[lang]);
    });
    const d = sig.direction === undefined ? '' : sig.direction;
    expect({ none: m.trendContext(d), tf: m.trendContext(d, true, false), ff: m.trendContext(d, false, false), ft: m.trendContext(d, false, true) })
      .toEqual(b.ctx);
  });
});

// ── free report ────────────────────────────────────────────────────────────
describe('free_report random sequences across day boundaries (bot replay)', () => {
  const V = load('diff_free');
  const FIELDS = ['free_signals_date', 'free_signals_morning', 'free_signals_evening', 'free_signals_night', 'free_signals_today',
    'free_missed_today', 'free_smc_preview_date', 'free_smc_preview_today'];
  const ustate = (u) => Object.fromEntries(FIELDS.map((k) => [k, u[k] === undefined ? null : u[k]]));
  const newUser = (uid, plan, lang) => ({
    user_id: uid, sub_plan: plan, lang, free_signals_date: '', free_signals_morning: 0, free_signals_evening: 0,
    free_signals_night: 0, free_signals_today: 0, free_missed_today: 0, free_smc_preview_date: '', free_smc_preview_today: 0,
  });
  const UID = { a: 101, b: 102, p: 103, c: 104 };
  it.each(V.seqs.map((s, i) => [i, s.steps.length, s]))('sequence #%i (%i steps)', async (_i, _n, seq) => {
    const c = clock(seq.start);
    const kv = memKv();
    const log = captureLog();
    const mk = () => FR.createFreeReport({ now: c.now, kv, log, features: pf.PLAN_FEATURES.free });
    let fr = mk();
    const users = { a: newUser(101, 'free', 'ru'), b: newUser(102, 'free', 'en'), p: newUser(103, 'pro', 'ru'), c: newUser(104, 'free', seq.lang_c) };
    const keys = ['t', 'result', 'users', 'writes', 'sent', 'logs', 'missed', 'closed', 'preview'];
    for (const [i, s] of expectations(seq.steps, keys).entries()) {
      const op = s.op;
      let res = null;
      const sent = [];
      log.lines.length = 0;
      kv.writes.length = 0;
      switch (op[0]) {
        case 'advance': c.advance(op[1]); break;
        case 'should': res = fr.shouldSendFreeSignal(users[op[1]], op[2]); break;
        case 'record': fr.recordFreeSignalSent(users[op[1]], op[2]); break;
        case 'missed': fr.recordMissedSignal(users[op[1]], op[2], op[3], op[4], op[5]); break;
        case 'closed': fr.recordClosedProfitable(op[1], op[2], op[3]); break;
        case 'already': res = fr.freePreviewAlreadySentToday(UID[op[1]], op[2], op[3]); break;
        case 'mark': fr.markFreePreviewSent(UID[op[1]], op[2], op[3]); break;
        case 'should_preview': res = fr.shouldSendFreeSmcPreview(users[op[1]]); break;
        case 'record_preview': fr.recordFreeSmcPreviewSent(users[op[1]]); break;
        case 'restart': fr = mk(); fr.loadPersistentBuffers(); break;
        case 'report': await fr.sendEveningReport(Object.values(users), async (uid, text) => { sent.push([uid, text]); }, { sleep: async () => {} }); break;
        default: throw new Error(op[0]);
      }
      const where = `step ${i} ${JSON.stringify(op)}`;
      expect(c.t, where).toBe(s.t);
      expect(res, where).toEqual(s.result);
      expect(Object.fromEntries(Object.entries(users).map(([k, u]) => [k, ustate(u)])), where).toEqual(s.users);
      expect(kv.writes, where).toEqual(s.writes);
      expect(sent, where).toEqual(s.sent);
      expect(log.lines, where).toEqual(s.logs);
      expect(Object.fromEntries(Array.from(fr.missedBuffer).map(([k, v]) => [String(k), v])), where).toEqual(s.missed);
      expect(fr.closedProfitable, where).toEqual(s.closed);
      expect(Object.fromEntries(Array.from(fr.previewSent).map(([k, mm]) => [String(k), Object.fromEntries(mm)])), where).toEqual(s.preview);
    }
  });
});

// ── cards ──────────────────────────────────────────────────────────────────
describe('cards on random mutations of fresh JS-engine signals (bot strings)', () => {
  const V = load('diff_cards');
  const S = load('diff_card_signals');
  const monitors = V.scenarios.map((sc) => { const m = TM.createTrendMonitor({ env: {}, kv: null, log: quiet }); m._seed(sc.trend, sc.strength); return m; });
  const tg = (rows) => kb.toTelegram(rows).inline_keyboard;
  for (const strat of ['levels', 'smc', 'volume']) {
    it.each(V.cases[strat].map((c, i) => [i, c.source, c.lang, c]))(`${strat} #%i %s lang=%s`, (_i, _src, lang, c) => {
      const sig = { ...revive(S[strat][c.idx].signal), ...c.mutation };
      const trend = monitors[c.scenario];
      const pl = positionLine(c.user, sig.entry, sig.sl, lang, c.ctx, { balance: c.balance, ctxRiskMult: trend.ctxRiskMult, ctxLabel: trend.ctxLabel });
      expect(pl).toBe(c.pl);
      if (strat === 'levels') {
        const full = levels.signalText(sig, { timeframe: c.timeframe }, lang, { trend });
        const lt = lite.formatSignalLite({ symbol: sig.symbol, direction: sig.direction, quality: sig.quality, entry: sig.entry, sl: sig.sl,
          tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, strategy: 'LEVELS', lang, qualityScale: 10 });
        expect(full).toBe(c.out.full);
        expect(lt).toBe(c.out.lite);
        for (const [kind, base] of [['full', full], ['lite', lt]]) {
          const text = base + (pl ? '\n' + pl : '') + levels.fundBlockSection(c.fund, lang);
          expect(wmInject(text, c.user.user_id)).toBe(c.out[`assembled_${kind}`]);
        }
        const [a, b2, d] = c.kb_flags;
        expect(tg(kb.signalCompactKeyboard(`${c.user.user_id}_${c.idx}${c.rep}`, sig.symbol, { showTradeBtn: a, isCounterTrend: b2, isAutoTraded: d, lang })))
          .toEqual(c.out.kb);
      } else if (strat === 'smc') {
        const conf = createSignalConfluence({ now: () => 1_800_000_000 });
        for (const s of c.confluence_others) conf.recordSignal(sig.symbol, sig.direction, s, 3);
        const raw = smc.signalTextSmc(sig, c.fund, lang, { trend });
        const lt = lite.formatSignalLite({ symbol: sig.symbol, direction: sig.direction, quality: sig.score || sig.quality || 0, entry: sig.entry,
          sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, strategy: 'SMC', lang });
        expect(raw).toBe(c.out.full);
        expect(lt).toBe(c.out.lite);
        const label = conf.getConfluenceLabel(sig.symbol, sig.direction, 'SMC');
        expect(label).toBe(c.label);
        for (const [kind, base] of [['assembled_full', raw], ['assembled_lite', lt]]) {
          expect(smc.assemble(base, sig, c.user, lang, { userId: c.user.user_id, positionLine: pl, confluenceLabel: label })).toBe(c.out[kind]);
        }
        const [a, b2, tid] = c.kb_flags;
        expect(tg(kb.smcKeyboard(sig.symbol, tid, { showTradeBtn: a, isAutoTraded: b2, lang }))).toEqual(c.out.kb);
      } else {
        const full = volume.signalText(sig, lang, { trend });
        const lt = lite.formatSignalLite({ symbol: sig.symbol, direction: sig.direction, quality: Math.trunc(sig.quality), entry: sig.entry, sl: sig.sl,
          tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3, strategy: 'VOLUME', lang });
        expect(full).toBe(c.out.full);
        expect(lt).toBe(c.out.lite);
        for (const [kind, base] of [['full', full], ['lite', lt]]) {
          expect(wmInject(base + (pl ? '\n' + pl : ''), c.user.user_id)).toBe(c.out[`assembled_${kind}`]);
        }
        const [a, b2] = c.kb_flags;
        expect(tg(kb.signalCompactKeyboard(`9_vol_${c.idx}${c.rep}`, sig.symbol, { showTradeBtn: a, isAutoTraded: b2, lang }))).toEqual(c.out.kb);
      }
    });
  }
});

// ── repo ───────────────────────────────────────────────────────────────────
describe('signalTradesRepo random op sequences (bot table after every step)', () => {
  const V = load('diff_repo');
  it.each(V.seqs.map((s, i) => [i, s.steps.length, s]))('sequence #%i (%i steps)', (_i, _n, seq) => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(signalTradesDDL());
    db.exec(TRADE_EVENTS_DDL);
    db.exec(TRADE_FEEDBACK_DDL);       // db_set_trade_result writes the trade_feedback row (bot schema)
    const c = clock(seq.t0);
    const log = captureLog();
    const r = Repo.createSignalTradesRepo({ db, now: c.now, log });
    for (const [i, s] of expectations(seq.steps, ['now', 'result', 'error', 'rows', 'events', 'logs']).entries()) {
      const op = s.op;
      let res = null;
      let err = null;
      log.lines.length = 0;
      try {
        switch (op[0]) {
          case 'add': r.addTrade(op[1]); break;
          case 'result': res = r.setTradeResult(op[1], op[2], op[3], { closedPnlUsd: op[4], skipReason: op[5], allowOverwriteSkip: op[6] }); break;
          case 'state': res = r.setTradeState(op[1], op[2], { bumpAttempts: op[3], expectedFrom: op[4] }); break;
          case 'note': res = r.setTradeNote(op[1], { note: op[2], skipReason: op[3] }); break;
          case 'msg': r.setSignalMsgId(op[1], op[2], op[3]); break;
          case 'advance': res = r.advanceSignalProgress(op[1], op[2], op[3], op[4]); break;
          case 'expire': res = r.markSignalExpired(op[1], op[2], op[3], op[4]); break;
          case 'trackable': res = r.getTrackableSignals(op[1], op[2]); break;
          case 'expire_cands': res = r.getExpireCandidates(op[1], op[2], op[3], op[4]); break;
          case 'evt_add': r.addTradeEvent(op[1], op[2], op[3]); break;
          case 'evt_get': res = r.getTradeEvents(op[1], op[2]); break;
          case 'evt_gc': res = r.gcTradeEvents(op[1]); break;
          case 'ghost': res = r.cleanupGhostTrades(op[1], op[2]); break;
          case 'ghost_all': res = r.cleanupGhostTradesAll(op[1]); break;
          case 'user_trades': res = r.getUserTrades(op[1]); break;
          case 'tp': r.updateSignalTp(op[1], { tp2: op[2], tp3: op[3] }); break;
          case 'advance_clock': c.advance(op[1]); break;
          default: throw new Error(op[0]);
        }
      } catch (e) { err = e.name; }
      const where = `step ${i} ${JSON.stringify(op).slice(0, 160)}`;
      expect(c.t, where).toBe(s.now);
      expect(err !== null, `${where} error`).toBe(s.error !== null);
      // Python returns None for the writers whose JS twin returns a change count
      if (!['add', 'msg', 'evt_add', 'tp', 'advance_clock'].includes(op[0]) && s.error === null) expect(res, where).toEqual(s.result);
      expect(db.prepare('SELECT * FROM signal_trades ORDER BY trade_id').all(), where).toEqual(s.rows);
      expect(db.prepare('SELECT * FROM trade_events ORDER BY id').all(), where).toEqual(s.events);   // payload_json byte for byte
      // [SKIP-AFTER-TP-PLACED] ends with the runtime's own call stack (Python's vs JS's)
      const noStack = (m) => m.split(' — logging call stack:')[0];
      expect(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING').map((l) => noStack(l[1])), where).toEqual(s.logs.map(noStack));
    }
  });
});
