/**
 * Adversarial parity of tracker.js with the bot's signal_tracker.py pure functions
 * (gen/gen_tracker_adv.py → fixtures/tracker_adv.json): replay with exact level touches,
 * unaligned progress_ts, duplicate / inverted bars and odd stages; could_change on the level
 * grid; levels_from_trade / valid / risk / r_of / mark_to_market_rr on legacy, string and
 * NaN rows; missed_r at the MISSED_R boundary; _fmt_r / _fmt_outcome_r ties; _ago;
 * build_text; outcome lines; card_text_with_outcome whitespace; the _chart_df window.
 * e.g. python -c "import signal_tracker as st; print(st._fmt_r(2.25), st._ago(-61,'ru'))"  → 2.2 0м
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const T = nodeRequire('../../../services/engine/tracker.js');
const { PyValueError, PyTypeError } = nodeRequire('../../../services/engine/pycoerce.js');

const dec = (v) => {
  if (Array.isArray(v)) return v.map(dec);
  if (v && typeof v === 'object') {
    if (Object.keys(v).length === 1 && Object.prototype.hasOwnProperty.call(v, '$f')) {
      return v.$f === 'nan' ? NaN : (v.$f === 'inf' ? Infinity : -Infinity);
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
  }
  return v;
};
const V = dec(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'tracker', 'fixtures', 'tracker_adv.json'), 'utf8')));

function call(fn) {
  try {
    return { ok: fn() };
  } catch (e) {
    let name = e.name;
    if (e instanceof PyValueError) name = 'ValueError';
    else if (e instanceof PyTypeError) name = 'TypeError';
    return { raise: name, msg: e.message };
  }
}
const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b) || a === b;

describe('tracker.js adversarial vectors vs signal_tracker.py', () => {
  it(`replay + could_change: ${V.replay.length} trades with exact touches`, () => {
    for (const c of V.replay) {
      const L = T.levelsFromTrade(c.trade);
      expect(L, JSON.stringify(c.trade)).toEqual(c.levels);
      const r = T.replay(L, c.bars, c.stage0, c.pts, c.created, c.tf);
      expect({ stage: r.stage, pts: r.progressTs, events: r.events }, JSON.stringify(c))
        .toEqual({ stage: c.stage, pts: c.pts2, events: c.events });
      const grid = [L.sl, L.entry, L.tp1, L.tp2, L.tp3, L.fill_lo, L.fill_hi].slice(0, 5);
      for (const stg of ['', 'ENTRY', 'TP1', 'TP2', 'TP3', 'SL', 'tp1']) {
        expect(T.couldChange(L, stg, c.hmax, c.lmin)).toBe(c.could_change[stg]);
        const g = [];
        for (const g1 of grid) for (const g2 of grid) g.push(T.couldChange(L, stg, g1, g2));
        expect(g).toEqual(c.could_change[`${stg}@grid`]);
      }
    }
  });

  it(`levels_from_trade / valid / risk / r_of / mark_to_market_rr: ${V.levels.length} odd rows`, () => {
    const prices = [100.0, 115.0, 85.0, 1000.0, 0.0, null, -5.0, 130.0, 70.0, '101', NaN];
    for (const c of V.levels) {
      const at = JSON.stringify(c.trade);
      const L = call(() => T.levelsFromTrade(c.trade));
      if (c.raise) {
        expect(L.raise, at).toBe(c.raise.raise);
        expect(L.msg, at).toBe(c.raise.msg);
      } else {
        const lv = L.ok;
        for (const k of Object.keys(c.levels)) expect(same(lv[k], c.levels[k]), `${at} ${k}: ${lv[k]} vs ${c.levels[k]}`).toBe(true);
        expect(call(() => T.valid(lv)), at).toEqual(c.valid);
        const rk = call(() => T.risk(lv));
        expect(same(rk.ok, c.risk.ok), at).toBe(true);
        [0.0, -1.0, 100.0, 112.5, 87.5].forEach((p, i) => {
          const got = call(() => T.rOf(lv, p));
          expect(same(got.ok, c.r_of[i].ok), `${at} r_of(${p}) ${got.ok} vs ${c.r_of[i].ok}`).toBe(true);
        });
      }
      prices.forEach((p, i) => {
        const got = call(() => T.markToMarketRr(c.trade, p));
        const want = c.mtm[i];
        expect(Object.keys(got), `${at} mtm(${p})`).toEqual(Object.keys(want));
        if ('ok' in want) expect(same(got.ok, want.ok), `${at} mtm(${p}) ${got.ok} vs ${want.ok}`).toBe(true);
      });
    }
  });

  it(`missed_r: ${V.missed.length} cases around MISSED_R`, () => {
    for (const c of V.missed) {
      const L = T.levelsFromTrade(c.trade);
      expect(T.missedR(L, c.highs, c.lows, c.close), JSON.stringify(c)).toBe(c.r);
    }
  });

  it('_fmt_r / _ago / _fmt_outcome_r', () => {
    for (const [x, s] of V.fmt_r) expect(T.fmtR(x), String(x)).toBe(s);
    for (const [x, lang, s] of V.ago) expect(T.ago(x, lang), `${x} ${lang}`).toBe(s);
    for (const [x, s] of V.fmt_outcome) expect(T.fmtOutcomeR(x), String(x)).toBe(s);
  });

  it(`build_text: ${V.texts.length} notices`, () => {
    for (const c of V.texts) {
      const L = T.levelsFromTrade(c.trade);
      expect(T.buildText(c.trade, L, c.event, c.hit, c.lang, c.now), JSON.stringify(c)).toBe(c.text);
    }
  });

  it('outcome_line / card_text_with_outcome', () => {
    for (const [stg, rr, lang, s] of V.outcome_lines) expect(T.outcomeLine(stg, rr, lang), `${stg} ${rr} ${lang}`).toBe(s);
    for (const [h, ln, s] of V.card_texts) expect(T.cardTextWithOutcome(h, ln), JSON.stringify(h)).toBe(s);
  });

  it(`_chart_df window: ${V.chart.length} frames`, () => {
    for (const c of V.chart) {
      const bars = [];
      for (let i = 0; i < c.n; i++) bars.push([c.t0 + i * c.tf, 2.0, 0.5, 1.5]);
      const w = T.chartTail(bars, c.created, c.tf);
      expect({ len: w.length, first: w[0][0] }, JSON.stringify(c)).toEqual({ len: c.len, first: c.first });
    }
  });
});
