/**
 * tracker.js — pure replay vs the bot's signal_tracker.py.
 *
 * Every expected value in fixtures/tracker_vectors.json was printed by the bot's own
 * Python (gen/gen_tracker_vectors.py, run in the bot venv — see its docstring):
 *   named / random  → signal_tracker.levels_from_trade + replay + could_change + missed_r + mark_to_market_rr
 *   pick_tfs        → signal_tracker._pick_tfs(age_s)
 *   fmt_r / ago / fmt_outcome_r / outcome_line / card_text → the text helpers
 *   build_text      → signal_tracker.build_text(trade, L, event, hit, lang, now)
 *   update_card     → signal_tracker.update_signal_card(fake_bot, trade, stage, lang) (edited text + result)
 *   chart_window    → len(signal_tracker._chart_df(df, created_at, tf_sec))
 * e.g. python -c "import signal_tracker as st; L=st.levels_from_trade({'direction':'LONG','entry':100,'sl':95,'tp1':110,'tp2':120,'tp3':130}); print(st.replay(L,[(10,112,99),(20,121,99.5)],'',0,5,60))"
 *   → ('TP2', 20.0, ['TP1', 'TP2'])
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const T = nodeRequire('../../../services/engine/tracker.js');
const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'tracker', 'fixtures', 'tracker_vectors.json'), 'utf8'));

describe('constants (§11.1)', () => {
  it('defaults match the bot module constants', () => {
    const c = V.constants;
    expect(T.CONFIG.INTERVAL_S).toBe(c.INTERVAL_S);
    expect(T.CONFIG.MAX_AGE_H).toBe(c.MAX_AGE_H);
    expect(T.CONFIG.SEND_DELAY_S).toBe(c.SEND_DELAY_S);
    expect(T.CONFIG.REST_PER_CYCLE).toBe(c.REST_PER_CYCLE);
    expect(T.CONFIG.MAX_ROWS).toBe(c.MAX_ROWS);
    expect(T.CONFIG.MAX_EVENT_LAG_H).toBe(c.MAX_EVENT_LAG_H);
    expect(T.CONFIG.MISSED_R).toBe(c.MISSED_R);
    expect(T.CONFIG.MISSED_MIN_AGE_S).toBe(c.MISSED_MIN_AGE_S);
    expect([...T.FINAL].sort()).toEqual(c.FINAL);
    expect(T.TF_SEC).toEqual(c.TF_SEC);
    expect(T.TF_NORM).toEqual(c.TF_NORM);
    expect(T.CARD_MARK).toBe(c.CARD_MARK);
    expect(T.CARD_MAX_JSON).toBe(c.CARD_MAX_JSON);
    expect(T.CARD_MAX_TEXT).toBe(c.CARD_MAX_TEXT);
    expect(T.OUTCOME_LINE).toEqual(c.OUTCOME_LINE);
  });
  it('readConfig clamps like the bot (max(15, …), bad values → defaults, enabled flag)', () => {
    const c = T.readConfig({ SIGNAL_TRACKER_INTERVAL_S: '5', SIGNAL_TRACKER_MAX_AGE_H: 'abc', SIGNAL_MISSED_R: '0.1', SIGNAL_TRACKER_ENABLED: 'off', SIGNAL_TRACKER_REST_PER_CYCLE: '-3', SIGNAL_TRACKER_MAX_ROWS: '7.9' });
    expect(c).toMatchObject({ ENABLED: false, INTERVAL_S: 15, MAX_AGE_H: 72, MISSED_R: 0.3, REST_PER_CYCLE: 0, MAX_ROWS: 100 });
    expect(T.readConfig({ SIGNAL_TRACKER_ENABLED: 'false' }).ENABLED).toBe(false);
    expect(T.readConfig({ SIGNAL_TRACKER_ENABLED: ' 1 ' }).ENABLED).toBe(true);
    expect(T.readConfig({}).ENABLED).toBe(true);
  });
});

describe('levels_from_trade (§11.4)', () => {
  it(`reproduces ${V.levels_from_trade.length} coercion cases`, () => {
    for (const c of V.levels_from_trade) {
      const L = T.levelsFromTrade(c.trade);
      expect(L, JSON.stringify(c.trade)).toEqual(c.levels);
      expect(T.valid(L)).toBe(c.valid);
      expect(T.risk(L)).toBe(c.risk);
      expect([0, 100, 110, 90, 123.4].map((p) => T.rOf(L, p))).toEqual(c.r_of);
    }
  });
});

describe('replay table (§11.5)', () => {
  for (const c of V.named) {
    it(c.name, () => {
      const L = T.levelsFromTrade(c.trade);
      expect(L).toEqual(c.levels);
      const r = T.replay(L, c.bars, c.stage0, c.progress_ts, c.created_at, c.tf_sec);
      expect(r).toEqual({ stage: c.stage, progressTs: c.pts, events: c.events });
    });
  }
  it(`reproduces ${V.random.length} random replays, could_change pre-filters, missed_r and mark_to_market_rr`, () => {
    const bad = [];
    for (const c of V.random) {
      const L = T.levelsFromTrade(c.trade);
      const r = T.replay(L, c.bars, c.stage0, c.progress_ts, c.created_at, c.tf_sec);
      const got = { stage: r.stage, pts: r.progressTs, events: r.events };
      if (JSON.stringify(got) !== JSON.stringify({ stage: c.stage, pts: c.pts, events: c.events })) bad.push({ c, got });
      const ext = T.extremesAfter(c.bars, c.stage0, c.created_at, c.progress_ts, c.tf_sec);
      const cc = Boolean(ext) && T.couldChange(L, c.stage0, ext.hmax, ext.lmin);
      if (cc !== c.could_change || Boolean(ext) !== c.any_mask) bad.push({ c, cc, ext });
      const after = c.bars.filter((b) => b[0] > c.created_at);
      const mr = after.length ? T.missedR(L, after.map((b) => b[1]), after.map((b) => b[2]), c.bars[c.bars.length - 1][3]) : null;
      if (mr !== c.missed_r) bad.push({ c, mr });
      for (const [p, exp] of Object.entries(c.mtm)) {
        const price = p === 'None' ? null : Number(p);
        if (T.markToMarketRr(c.trade, price) !== exp) bad.push({ c, p, exp, got: T.markToMarketRr(c.trade, price) });
      }
    }
    expect(bad).toEqual([]);
  });
  it('could_change is false once the stage is final / unknown', () => {
    const L = T.levelsFromTrade(V.named[0].trade);
    for (const st of ['TP3', 'SL', 'BE', 'EXPIRED', 'MISSED', 'X']) expect(T.couldChange(L, st, 1e9, 0)).toBe(false);
  });
});

describe('candles helpers', () => {
  it('barsFromFrame reads a Frame (ms → s), drops NaN rows and sorts', () => {
    const { Frame } = nodeRequire('../../../strategies/common/frame.js');
    const f = Frame.fromBars([[2000, 1, 3, 0.5, 2, 1], [1000, 1, 2, 0.9, 1.5, 1], [3000, 1, NaN, 0.1, 1, 1]]);
    expect(T.barsFromFrame(f)).toEqual([[1, 2, 0.9, 1.5], [2, 3, 0.5, 2]]);
    expect(T.barsFromFrame([[5, 1, 0], [4, 2, 1, 1.5]])).toEqual([[4, 2, 1, 1.5], [5, 1, 0, NaN]]);
    expect(T.barsFromFrame(null)).toEqual([]);
    expect(T.covers([[4, 2, 1]], 4)).toBe(true);
    expect(T.covers([[4, 2, 1]], 3.9)).toBe(false);
    expect(T.covers([], 3)).toBe(false);
  });
  it('_pick_tfs', () => {
    for (const [age, exp] of Object.entries(V.pick_tfs)) expect(T.pickTfs(Number(age))).toEqual(exp);
  });
  it('_chart_df window', () => {
    for (const c of V.chart_window) {
      const bars = [];
      const t0 = Date.UTC(2026, 0, 1) / 1000;
      for (let i = 0; i < c.n_bars; i++) bars.push([t0 + i * c.tf_sec, 1, 1, 1]);
      expect(T.chartWindow(bars, c.created_at, c.tf_sec)).toBe(c.keep);
    }
    expect(T.chartWindow([], 0, 900)).toBe(null);
  });
});

describe('texts (§11.7)', () => {
  it('_fmt_r', () => {
    for (const [r, exp] of Object.entries(V.fmt_r)) expect(T.fmtR(Number(r)), r).toBe(exp);
  });
  it('_ago', () => {
    for (const [k, exp] of Object.entries(V.ago)) {
      const [s, lang] = k.split('|');
      expect(T.ago(Number(s), lang), k).toBe(exp);
    }
  });
  it(`build_text — ${V.build_text.length} snapshots (ru / en / fallback, every event, html escaping)`, () => {
    for (const c of V.build_text) {
      expect(T.buildText(c.trade, c.levels, c.event, c.hit, c.lang, c.now), `${c.case} ${c.event} ${c.lang}`).toBe(c.text);
    }
  });
  it('fmtPrice is chart_renderer._smart_format', () => {
    expect(T.fmtPrice(65000.1)).toBe('65000.1');
    expect(T.fmtPrice(2698.79)).toBe('2698.79');
    expect(T.fmtPrice(0.00001234)).toBe('0.00001234');
    expect(T.fmtPrice('abc')).toBe('abc');
  });
});

describe('card outcome (§11.8)', () => {
  it('_fmt_outcome_r', () => {
    for (const [v, exp] of Object.entries(V.fmt_outcome_r)) expect(T.fmtOutcomeR(v === 'None' ? null : Number(v)), v).toBe(exp);
  });
  it(`outcome_line — ${V.outcome_line.length} combos`, () => {
    for (const c of V.outcome_line) expect(T.outcomeLine(c.stage, c.rr, c.lang)).toBe(c.line);
  });
  it('card_text_with_outcome strips the old 📌 mark and trailing whitespace', () => {
    for (const c of V.card_text) expect(T.cardTextWithOutcome(c.html, c.line)).toBe(c.text);
  });
  it(`cardOutcome reproduces update_signal_card's skip rules and edited text (${V.update_card.length} cases)`, () => {
    for (const c of V.update_card) {
      const got = T.cardOutcome(c.trade, c.stage, c.lang);
      if (c.text === null) {
        // the bot never reached edit_message_text: skip / error decided before the edit
        expect(got.result, c.name).toBe(c.result);
      } else {
        // the edit was attempted; its own outcome (ok / not modified / blocked / error) is the
        // delivery layer's business — the pure part must produce exactly the edited text
        expect(got.result, c.name).toBe('ok');
        expect(got.text, c.name).toBe(c.text);
        expect(got.line, c.name).toBe(c.line);
        expect(got.rr, c.name).toBe(c.rr);
        expect(T.pyLen(got.text)).toBe(c.text_len);
      }
    }
  });
});

describe('EXPIRED / MISSED arithmetic (§11.9–11.10)', () => {
  it('mark_to_market_rr table', () => {
    for (const c of V.mtm) expect(T.markToMarketRr(c.trade, c.price), JSON.stringify(c)).toBe(c.rr);
  });
  it('missed_r table — market entries never MISSED, zone touch cancels, ≥ 1R rounded 2 dp', () => {
    for (const c of V.missed_r) {
      const L = T.levelsFromTrade(c.trade);
      expect(T.missedR(L, c.highs, c.lows, c.close), JSON.stringify(c)).toBe(c.r);
    }
  });
});
