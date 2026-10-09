/**
 * The pure partial-TP helpers vs the bot's partial_tp.py (PLAN M13 "calculate_partial_tp_*"):
 * calculate_partial_tp_prices, calculate_partial_tp_qty (+ the [PTP-PCT-CLAMP] warning),
 * bu_target_price and should_apply_bu_after_partial (AUDIT-FIX-C74).
 *
 * fixtures/ptp_math_vectors.json is written by gen/gen_ptp_math_vectors.py on CPython 3.11 (the
 * bot's own module, cwd = bot tree). Every float must match bit for bit (Object.is), every log
 * line exactly.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const req = createRequire(import.meta.url);
const P = req('../../../services/autotrade/partialTp.js');

const V = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'ptp_math_vectors.json'), 'utf8'));

const dec = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'f' in v) return v.f === 'nan' ? NaN : (v.f === 'inf' ? Infinity : -Infinity);
  if (Array.isArray(v)) return v.map(dec);
  return v;
};

function capture() {
  const logs = [];
  const mk = (level) => (m) => logs.push([level, String(m)]);
  return { logs, log: { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR') } };
}

function same(got, want) {
  if (Array.isArray(want)) return Array.isArray(got) && got.length === want.length && want.every((w, i) => same(got[i], w));
  return Object.is(got, want);
}

function check(rows, fn) {
  const bad = [];
  for (const [i, r] of rows.entries()) {
    const { logs, log } = capture();
    let got;
    try { got = { ret: fn(r, log) }; } catch (e) { got = { raise: String(e && e.message) }; }
    const want = r.raise ? { raise: r.raise } : { ret: dec(r.ret) };
    const ok = want.raise ? Boolean(got.raise) : same(got.ret, want.ret);
    const logsOk = JSON.stringify(logs) === JSON.stringify(r.logs);
    if (!ok || !logsOk) bad.push({ i, args: r.args || r.kw, want, got, wantLogs: r.logs, gotLogs: logs });
  }
  expect(bad.slice(0, 5)).toEqual([]);
}

describe('partial TP math — the bot vectors (CPython 3.11)', () => {
  it('fixture shape', () => {
    expect(V.prices.length).toBeGreaterThan(400);
    expect(V.qtys.length).toBeGreaterThan(300);
    expect(V.bu.length).toBeGreaterThan(150);
    expect(V.should.length).toBeGreaterThan(400);
    expect(V.qtys.some((r) => r.logs.length && r.logs[0][1].startsWith('[PTP-PCT-CLAMP]'))).toBe(true);
    expect(V.should.some((r) => r.ret === true) && V.should.some((r) => r.ret === false)).toBe(true);
  });

  it(`calculate_partial_tp_prices × ${V.prices.length}`, () => {
    check(V.prices, (r) => P.calculatePartialTpPrices(...dec(r.args)));
  });

  it(`calculate_partial_tp_qty × ${V.qtys.length} (incl. the [PTP-PCT-CLAMP] warning text)`, () => {
    check(V.qtys, (r, log) => P.calculatePartialTpQty(...dec(r.args), log));
  });

  it('the factory-bound calculatePartialTpQty logs through the factory logger', () => {
    const { logs, log } = capture();
    const ptp = P.createPartialTp({ traderFor: () => { throw new Error('no I/O'); }, log });
    const row = V.qtys.find((r) => r.logs.length);
    expect(same(ptp.calculatePartialTpQty(...dec(row.args)), dec(row.ret))).toBe(true);
    expect(logs).toEqual(row.logs);
  });

  it(`bu_target_price × ${V.bu.length}`, () => {
    check(V.bu, (r) => P.buTargetPrice(...dec(r.args)));
  });

  it(`should_apply_bu_after_partial × ${V.should.length}`, () => {
    const map = {
      initial_qty: 'initialQty', pos_size_now: 'posSizeNow', current_sl: 'currentSl', entry: 'entry', direction: 'direction',
      be_already_set: 'beAlreadySet', threshold: 'threshold', mark_price: 'markPrice', sl_dist: 'slDist', min_progression_r: 'minProgressionR',
    };
    check(V.should, (r) => {
      const kw = {};
      for (const [k, v] of Object.entries(r.kw)) kw[map[k]] = dec(v);
      return P.shouldApplyBuAfterPartial(kw);
    });
  });
});
