/**
 * Bot parity of the bot-derived parts of the public endpoints (fixtures/public_parity.json, made
 * by py/gen_public_parity.py with the bot's own code on CPython 3.11):
 *   • trend: trend_monitor.load_state() of a kv value + ribbon_strength over the case's closes +
 *     get_all() — vs services/publicTrack/trend.js (trend, strength, since) and vs the JS monitor;
 *   • rows: signal_status / signal_rr on the tracker view of a trade (= the bot's card outcome R)
 *     — vs services/publicTrack/view.js publicState (status; R before the site's fee estimate).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tm = require('../../services/engine/trendMonitor.js');
const { createTrendSource, CORE_TFS } = require('../../services/publicTrack/trend.js');
const view = require('../../services/publicTrack/view.js');
const { pyRound } = require('../../strategies/common/pyround.js');
const { Frame } = require('../../strategies/common/frame.js');

const FX = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'public', 'fixtures', 'public_parity.json'), 'utf8'));
const frameOf = (c) => Frame.fromColumns({ t: c.map((_, i) => i * 60000), o: c, h: c, l: c, c, v: c.map(() => 1) });

describe('fixture', () => {
  it('made by CPython 3.11', () => {
    expect(FX.python).toMatch(/^3\.11\./);
    expect(FX.trend.length).toBeGreaterThanOrEqual(12);
    expect(FX.rows.length).toBe(300);
  });
});

describe('trend: trend_monitor state + ribbon_strength + get_all', () => {
  for (const c of FX.trend) {
    it(c.name, async () => {
      const bars = FX.bars[c.bars];
      // the JS monitor, driven like the bot
      const mon = tm.createTrendMonitor({ kv: { get: () => c.raw, set() {}, del() {}, has: () => false }, env: {}, log: { debug() {}, info() {}, warning() {} } });
      mon.loadState();
      for (const tf of Object.keys(mon._state)) {
        const s = bars[tf] ? tm.ribbonStrength(frameOf(bars[tf]), mon._state[tf].trend) : null;
        if (s !== null) mon._strength[tf] = s;
      }
      const all = mon.getAll();
      const jsAll = Object.fromEntries(Object.entries(all).map(([tf, st]) => [tf, { trend: st.trend, since: st.since, ema: st.ema, strength: st.strength === undefined ? null : st.strength }]));
      expect(jsAll).toEqual(c.py);
      // the public payload
      const rest = {
        getCandles: async (_s, tf) => (bars[tf] ? frameOf(bars[tf]) : null),
        get24hChange: async () => null,
      };
      const p = await createTrendSource({ kvGet: () => c.raw, rest, now: () => 1_760_000_000 }).compute();
      if (!CORE_TFS.every((tf) => c.py[tf])) {
        expect(p.empty).toBe(true);
        return;
      }
      expect(Object.keys(p.tfs)).toEqual(Object.keys(c.py));
      for (const [tf, st] of Object.entries(c.py)) {
        expect(p.tfs[tf]).toEqual({ trend: st.trend, strength: st.strength, since: st.since > 0 ? Math.round(st.since * 1000) : null });
      }
    });
  }
});

describe('rows: the tracker view of signal_status / signal_rr', () => {
  it('status equal on all 300 rows; R before fees equal on every closed one', () => {
    let finals = 0;
    for (const { row, v, py } of FX.rows) {
      const stage = view.stageOf(row);
      const s = view.publicState(row, stage ? [{ s: stage, t: 0 }] : [], v);
      expect(s.raw, JSON.stringify(row)).toBe(py.status);
      if (view.isFinal(s.status)) {
        finals += 1;
        expect(s.r, JSON.stringify(row)).toBe(py.rr === null ? null : pyRound(py.rr - view.feeR(row), 2));
      } else {
        expect(s.r).toBeNull();
      }
    }
    expect(finals).toBeGreaterThan(100);
  });
});
