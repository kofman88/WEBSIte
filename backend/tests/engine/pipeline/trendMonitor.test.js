/**
 * trendMonitor on Python vectors (fixtures/trend.json, fixtures/trend_refresh.json,
 * tools/gen_vectors.py `trend`):
 *   env constants (incl. the empty-string `or` fallbacks and TREND_CTX_RISK parsing),
 *   compute_trend over 6 TFs × 7 series × lengths around slow+confirm+5 × prev,
 *   ribbon_strength, every state helper (aligned_direction, get_all, trend_strength,
 *   is_strong, mtf_aligned, trend_context, is_counter, card_line RU/EN/other) over seven
 *   BTC states, apply_mtf_bonus (two calls → idempotence; quality cap 10 / 5, SMC score
 *   cap 5 with the scanner grade recompute + D6 after the penalty) under four env configs,
 *   ctx_risk_mult / ctx_label, change_text / aligned_text, load_state / _load_aligned, and
 *   an end-to-end refresh() replay (WS cache, throttled REST for 1D/1W/1M, kv writes,
 *   broadcasts with opt-out and quiet hours, logs).
 *
 *   Python: importlib.reload(trend_monitor) per env; tm.compute_trend(df, prev, tf); tm.apply_mtf_bonus(sig, attr, cap) …
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const TM = req('../../../services/engine/trendMonitor.js');
const kb = req('../../../services/engine/cards/keyboards.js');
const { load, frameOf, clock, memKv, captureLog } = req('./vectors.js');

const T = load('trend');
const RF = load('trend_refresh');
const quiet = captureLog();
const nn = (v) => (v === undefined ? null : v);

function monitor(env, scenario, extra = {}) {
  const m = TM.createTrendMonitor({ env, kv: memKv(), log: quiet, ...extra });
  if (scenario) {
    const trends = {};
    for (const [tf, t] of Object.entries(scenario.trend)) trends[tf] = { trend: t, since: 1_800_000_000.0, price: 123.5 };
    m._seed(trends, scenario.strength);
  }
  return m;
}

describe('constants and env', () => {
  it('tables', () => {
    expect(TM.RIBBON_LENGTHS).toEqual(T.ribbon_lengths);
    expect(TM.TFS).toEqual(T.tables.TFS);
    expect(TM.REST_TFS).toEqual(T.tables.REST_TFS);
    expect(TM.MTF_TFS).toEqual(T.tables.MTF_TFS);
    expect(TM.EMA_BY_TF).toEqual(T.tables.EMA_BY_TF);
    expect(TM.CONFIRM_BY_TF).toEqual(T.tables.CONFIRM_BY_TF);
    expect(TM.REST_LIMIT).toEqual(T.tables.REST_LIMIT);
  });
  it.each(T.env.map((e) => [JSON.stringify(e.env), e]))('env %s', (_n, e) => {
    const c = TM.readConfig(e.env);
    expect({
      REST_REFRESH_S: c.REST_REFRESH_S, MTF_BONUS: c.MTF_BONUS, STRONG_TREND: c.STRONG_TREND, STRONG_COUNTER_PENALTY: c.STRONG_COUNTER_PENALTY,
      INTERVAL_S: c.INTERVAL_S, NOTIFY_TFS: c.NOTIFY_TFS, ENABLED: c.ENABLED, ALIGNED_NOTIFY: c.ALIGNED_NOTIFY, CTX_RISK: c.CTX_RISK,
    }).toEqual(e.consts);
  });
});

describe('compute_trend / ribbon_strength', () => {
  const frames = {};
  const fr = (kind, n) => {
    const k = `${kind}|${n}`;
    if (!frames[k]) frames[k] = frameOf(T.series[kind].slice(-n));
    return frames[k];
  };
  it(`compute_trend × ${T.compute.length}`, () => {
    for (const [tf, kind, n, prev, want] of T.compute) {
      const got = kind === 'none' ? TM.computeTrend(null, prev, tf) : TM.computeTrend(fr(kind, n), prev, tf);
      expect(got, `${tf} ${kind} n=${n} prev=${prev}`).toBe(want);
    }
  });
  it(`ribbon_strength × ${T.ribbon.length}`, () => {
    for (const [kind, n, trend, want] of T.ribbon) expect(TM.ribbonStrength(fr(kind, n), trend), `${kind} ${n} ${trend}`).toBe(want);
  });
});

describe('state helpers + card_line', () => {
  it.each(T.helpers.map((h) => [h.scenario, h]))('scenario %i', (si, h) => {
    const m = monitor({}, T.scenarios[si]);
    expect(m.alignedDirection()).toBe(h.aligned_direction);
    expect(m.getAll()).toEqual(h.get_all);
    for (const [tf, v] of Object.entries(h.strength)) expect(m.trendStrength(tf)).toBe(v);
    for (const [tf, v] of Object.entries(h.is_strong)) expect(m.isStrong(tf)).toBe(v);
    for (const ent of h.per_dir) {
      const d = ent.direction;
      expect(m.mtfAligned(d)).toBe(ent.mtf_aligned);
      expect(m.trendContext(d)).toBe(ent.trend_context);
      const combos = [];
      for (const a of [null, true, false]) for (const s of [null, true, false]) combos.push(m.trendContext(d, a, s));
      expect(combos).toEqual(ent.trend_context_given);
      for (const [tf, v] of Object.entries(ent.is_counter)) expect(m.isCounter(d, tf === 'None' ? null : tf), `is_counter ${d} ${tf}`).toBe(v);
      for (const [key, v] of Object.entries(ent.card_line)) {
        const [tf, lang] = key.split('|');
        expect(m.cardLine(d, tf === 'None' ? null : tf, lang), `card_line ${d} ${key}`).toBe(v);
      }
    }
  });
});

describe('apply_mtf_bonus (idempotent; SMC grade incl. D6)', () => {
  it(`${T.bonus.length} cases`, () => {
    for (const b of T.bonus) {
      const m = TM.createTrendMonitor({ env: b.env, kv: memKv(), log: quiet });
      const sc = T.scenarios[b.scenario];
      m._seed(Object.fromEntries(Object.entries(sc.trend).map(([tf, t]) => [tf, { trend: t, since: 0.0, price: 0.0 }])), sc.strength);
      const sig = { ...b.init };
      for (const [i, run] of b.runs.entries()) {
        const ok = m.applyMtfBonus(sig, b.attr, b.cap);
        const where = `${JSON.stringify(b.env)} s${b.scenario} ${b.attr}/${b.cap} ${JSON.stringify(b.init)} run ${i}`;
        expect(ok, where).toBe(run.ok);
        const fields = {};
        for (const k of Object.keys(run.fields)) fields[k] = nn(sig[k]);
        expect(fields, where).toEqual(run.fields);
        if (b.attr === 'score') expect(sig.grade, where).toBe(run.d6_grade);
      }
    }
  });
  it('D6 differs from the bot only after a strong-counter penalty', () => {
    const diverging = T.bonus.filter((b) => b.attr === 'score' && b.runs.some((r) => r.bot_grade !== r.d6_grade));
    expect(diverging.length).toBeGreaterThan(0);
    for (const b of diverging) for (const r of b.runs) if (r.bot_grade !== r.d6_grade) expect(r.ok).toBe(false);
  });
});

describe('ctx risk / labels / texts', () => {
  it('ctx_risk_mult + ctx_label', () => {
    const m = monitor({}, null);
    for (const [k, v] of Object.entries(T.ctx.mult)) expect(m.ctxRiskMult(k === 'None' ? null : (k === '0' ? 0 : k)), k).toBe(v);
    for (const [key, v] of Object.entries(T.ctx.label)) {
      const [c, l] = key.split('|');
      expect(TM.ctxLabel(c === 'None' ? null : c, l)).toBe(v);
    }
  });
  it(`change_text × ${T.texts.length}`, () => {
    for (const [tf, nw, prev, since, lang, want] of T.texts) {
      expect(TM.changeText(tf, nw, prev, since, lang, 1_800_000_000.0), `${tf} ${nw} ${prev} ${since} ${lang}`).toBe(want);
    }
  });
  it('aligned_text / tf_label / norm_tf', () => {
    for (const [d, s, l, want] of T.aligned_texts) expect(TM.alignedText(d, s, l)).toBe(want);
    for (const [tf, l, want] of T.labels) expect(TM.tfLabel(tf, l)).toBe(want);
    for (const [x, want] of T.norm) expect(TM.normTf(x === 'None' ? null : x), x).toBe(want);
  });
});

describe('kv state', () => {
  it.each(T.load_state.map((c, i) => [i, c]))('load_state #%i', (_i, c) => {
    const kv = memKv();
    if (c.raw) kv.set('trend_state_v1', c.raw);
    const m = TM.createTrendMonitor({ env: {}, kv, log: quiet });
    m.loadState();
    expect({ ...m._state }).toEqual(c.state);
  });
  it.each(T.aligned_loads.map((c, i) => [i, c]))('_load_aligned #%i', (_i, c) => {
    const kv = memKv();
    if (c.raw) kv.set('trend_aligned_v1', c.raw);
    const m = TM.createTrendMonitor({ env: {}, kv, log: quiet });
    m.loadAligned();
    expect({ dir: m._aligned.dir, since: m._aligned.since, had_kv: Boolean(m._aligned.had_kv) })
      .toEqual({ dir: c.aligned.dir, since: c.aligned.since, had_kv: Boolean(c.aligned.had_kv) });
  });
});

describe('refresh() end to end (bot replay)', () => {
  it('WS + throttled REST + kv + broadcasts', async () => {
    const c = clock(1_800_000_000.0);
    const kv = memKv();
    for (const [k, v] of Object.entries(RF.initial_kv)) kv.set(k, v);
    for (const uid of RF.opted_out) kv.set(`trend_notify_off_${uid}`, '1');
    const ws = {};
    const restStore = {};
    const restCalls = [];
    const cacheSets = [];
    let restPlan = {};
    const sends = [];
    const log = captureLog();
    const m = TM.createTrendMonitor({
      env: {}, kv, log, now: c.now, sleep: async () => {},
      cache: {
        getCandles: (_s, tf) => {
          if (ws[tf]) return ws[tf];
          const e = restStore[tf];
          return e && c.t < e[1] ? e[0] : null;
        },
        setCandles: (s, tf, df, ttl) => { cacheSets.push([s, tf, df.length, ttl]); restStore[tf] = [df, c.t + Object.values(ttl)[0]]; },
      },
      fetcher: {
        getCandles: async (s, tf, limit) => {
          restCalls.push([s, tf, limit, c.t]);
          const p = restPlan[tf] || 'none';
          if (p === 'raise') throw new Error('boom');
          if (p === 'none') return null;
          if (p === 'empty') return frameOf([]);
          return frameOf(T.series[p].slice(-limit));
        },
      },
      getUsers: () => RF.users,
      send: async (uid, text, { silent, keyboard }) => {
        sends.push({ uid, text, silent, kb: kb.toTelegram(keyboard).inline_keyboard });
        return uid !== 12 || sends.length % 2 === 0;
      },
    });
    m.loadState();
    for (const s of RF.steps) {
      c.t = s.t;
      for (const k of Object.keys(ws)) delete ws[k];
      for (const [tf, kind] of Object.entries(s.ws)) ws[tf] = frameOf(T.series[kind]);
      restPlan = s.rest_plan;
      sends.length = 0; restCalls.length = 0; cacheSets.length = 0; kv.writes.length = 0; log.lines.length = 0;
      const changes = await m.refresh();
      const where = `t=${s.t}`;
      expect(changes, where).toEqual(s.changes);
      expect(sends, where).toEqual(s.sends);
      expect(restCalls, where).toEqual(s.rest_calls);
      expect(cacheSets, where).toEqual(s.cache_sets);
      expect(kv.writes.filter((w) => w[0] === 'trend_state_v1' || w[0] === 'trend_aligned_v1'), where).toEqual(s.kv_writes);
      expect(m.getAll(), where).toEqual(s.get_all);
      expect({ ...m._restNext }, where).toEqual(s.rest_next);
      expect(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING'), where).toEqual(s.logs);
    }
  });

  it('opt-out toggles the kv key', () => {
    const kv = memKv();
    const m = TM.createTrendMonitor({ env: {}, kv, log: quiet });
    m.setOptedOut('77', true);
    expect(kv.get('trend_notify_off_77')).toBe('1');
    expect(m.isOptedOut(77)).toBe(true);
    m.setOptedOut(77, false);
    expect(m.isOptedOut(77)).toBe(false);
  });
});
