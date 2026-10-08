/**
 * signalOutcome.js vs the bot's db/signal_outcome.py on 300 random rows
 * (gen/gen_status_adv.py → fixtures/status_adv.json): legacy rows with missing columns,
 * ghost SKIP / ORPHAN / manual SKIP, exchange rows, string / NaN / negative values,
 * lowercase results and stages and the 72 h boundary — signal_status (three clocks),
 * signal_rr for the real status and for every status, has_card, is_exchange_trade.
 * e.g. python -c "from db.signal_outcome import signal_rr; print(signal_rr({'entry':100,'original_sl':'nan','sl':95,'tp1':110},'tp1'))"  → None
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const SO = nodeRequire('../../../services/engine/signalOutcome.js');

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
const V = dec(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures', 'status_adv.json'), 'utf8')));
const same = (a, b) => (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b) || a === b;

describe('signal_status / signal_rr on 300 random rows', () => {
  it('MAX_AGE_S', () => expect(SO.MAX_AGE_S).toBe(V.max_age_s));
  it(`${V.rows.length} rows: status, rr, rr for every status, has_card, exchange`, () => {
    const seen = new Set();
    for (const c of V.rows) {
      const at = JSON.stringify(c.row);
      const st = SO.signalStatus(c.row, V.now);
      seen.add(st);
      expect(st, at).toBe(c.status);
      expect(same(SO.signalRr(c.row, st), c.rr), `${at} rr ${SO.signalRr(c.row, st)} vs ${c.rr}`).toBe(true);
      for (const [s, want] of Object.entries(c.rr_by)) {
        const got = SO.signalRr(c.row, s);
        expect(same(got, want), `${at} rr(${s}) ${got} vs ${want}`).toBe(true);
      }
      expect(SO.hasCard(c.row), at).toBe(c.has_card);
      expect(SO.isExchangeTrade(c.row), at).toBe(c.exchange);
      expect([SO.signalStatus(c.row, 0.0), SO.signalStatus(c.row, V.now + 3 * 86400)], at).toEqual(c.status_now);
    }
    expect([...seen].sort()).toEqual(['be', 'closed', 'expired', 'missed', 'open', 'skip', 'sl', 'tp1', 'tp2', 'tp3']);
  });

  it("Python `or` keeps a NaN stop (float('nan') or sl → nan); ±0.0 falls through to sl", () => {
    // python -c "from db.signal_outcome import signal_rr; print(signal_rr({'entry':100,'original_sl':'nan','sl':95,'tp1':110},'tp1'))"  → None
    expect(SO.signalRr({ entry: 100, original_sl: 'nan', sl: 95, tp1: 110 }, 'tp1')).toBe(null);
    // python -c "from db.signal_outcome import signal_rr; print(signal_rr({'entry':100,'original_sl':-0.0,'sl':95,'tp1':110},'tp1'))"  → 2.0
    expect(SO.signalRr({ entry: 100, original_sl: -0.0, sl: 95, tp1: 110 }, 'tp1')).toBe(2.0);
    // python -c "import signal_tracker as st; print(st.mark_to_market_rr({'entry':100,'original_sl':'nan','direction':'SHORT','tp3':70}, 100))"  → -1.0
    const T = nodeRequire('../../../services/engine/tracker.js');
    expect(T.markToMarketRr({ entry: 100, original_sl: 'nan', direction: 'SHORT', tp3: 70 }, 100)).toBe(-1.0);
    // miniapp_api._signal: "sl0": float(row.get("original_sl") or 0) or sl
    const SS = nodeRequire('../../../services/engine/signalStats.js');
    const view = (osl) => SS.signalView({ trade_id: 't', symbol: 'BTC-USDT-SWAP', direction: 'LONG', entry: 100, sl: 95, original_sl: osl, tp1: 110, created_at: V.now - 60 }, V.now);
    expect(Number.isNaN(view('nan').sl0)).toBe(true);
    expect(view(0).sl0).toBe(95);
    expect(view(null).sl0).toBe(95);
    expect(view(94).sl0).toBe(94);
  });
});
