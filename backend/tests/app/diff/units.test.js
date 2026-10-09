/**
 * Pins of the divergences the adversarial replay (appDiff.test.js) found, one by one, so a later
 * refactor fails here with a name instead of somewhere in a 670-step byte diff. Python values were
 * produced with CPython 3.11 (py/drive_app_diff.py `units`, or quoted from the bot's code).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { loadFixture } from './harness.js';

const nodeRequire = createRequire(import.meta.url);
const PJ = nodeRequire('../../../services/engine/pyjson.js');
const PT = nodeRequire('../../../strategies/common/pytime.js');
const SS = nodeRequire('../../../services/engine/signalStats.js');
const CP = nodeRequire('../../../services/engine/chartPayload.js');
const TF = nodeRequire('../../../services/engine/tradeFeedback.js');
const TM = nodeRequire('../../../services/engine/trendMonitor.js');
const { Frame } = nodeRequire('../../../strategies/common/frame.js');
const Database = nodeRequire('better-sqlite3');
const { TRADE_FEEDBACK_DDL } = nodeRequire('../../../models/engineSchema.js');

const FX = loadFixture();
const F = PJ.FLOAT;

describe('json.dumps bytes (web.json_response)', () => {
  it('floats print with repr(): 0.0, 1e+16, 5e-324, NaN / Infinity literals', () => {
    for (const [v, text] of FX.units.floats) expect(PJ.pyJsonDumpsTyped(v, F), text).toBe(text);
  });
  it('strings: ensure_ascii escapes (\\u2028, lone surrogates, DEL, astral pairs)', () => {
    for (const [v, text] of FX.units.strings) expect(PJ.pyJsonDumps(v), JSON.stringify(v)).toBe(text);
  });
  it('a JS number that holds a Python float is typed by path; ints stay ints; a key may be float in one place and int in another', () => {
    const v = { be: 2, overlays: { be: 2, tps: [1, 2.5, 3] }, candles: [[1767225600000, 1, 2, 0.5, 1, 7]] };
    const t = { overlays: { be: F, tps: [F] }, candles: [{ $tuple: [null, F, F, F, F, F] }] };
    expect(PJ.pyJsonDumpsTyped(v, t))
      .toBe('{"be": 2, "overlays": {"be": 2.0, "tps": [1.0, 2.5, 3.0]}, "candles": [[1767225600000, 1.0, 2.0, 0.5, 1.0, 7.0]]}');
    expect(PJ.pyJsonDumpsTyped({ a: { x: 0, y: 0 } }, { a: { '*': F, y: null } })).toBe('{"a": {"x": 0.0, "y": 0}}');
  });
  it('pyDict keeps the insertion order of integer-like keys and treats "__proto__" as a key (JSON.stringify would not)', () => {
    const [, text] = FX.units.dicts[0];          // Python json.dumps({"60": 1, "1": 2, "a": 3, "__proto__": 4, "constructor": 5})
    const d = PJ.pyDict([['60', 1], ['1', 2], ['a', 3], ['__proto__', 4], ['constructor', 5]]);
    expect(PJ.pyJsonDumps(d)).toBe(text);
    expect(PJ.pyJsonDumpsTyped(d, { '*': F })).toBe('{"60": 1.0, "1": 2.0, "a": 3.0, "__proto__": 4.0, "constructor": 5.0}');
    PJ.pyDictSet(d, '1', 9);                    // a known key keeps its place
    expect(Object.keys(d)).toEqual(['1', '60', 'a', '__proto__', 'constructor']);   // (a JS object's own order)
    expect(PJ.pyJsonDumps(d)).toBe('{"60": 1, "1": 9, "a": 3, "__proto__": 4, "constructor": 5}');
  });
});

describe('datetime.fromtimestamp(ts, tz=utc) range (GET stats sessions / weekdays)', () => {
  it('year 1..9999 after the µs rounding, else it raises like the bot (→ HTTP 500)', () => {
    expect(PT.utcDatetimeStrict(-62135596800).toISOString()).toBe('0001-01-01T00:00:00.000Z');
    expect(PT.utcDatetimeStrict(253402300799).toISOString()).toBe('9999-12-31T23:59:59.000Z');
    expect(PT.utcDatetimeStrict(1e11).toISOString()).toBe('5138-11-16T09:46:40.000Z');
    expect(PT.utcDatetimeStrict(253402300799.5).toISOString()).toBe('9999-12-31T23:59:59.000Z');
    for (const bad of [-62135596801, 253402300800, 1e12, Infinity, -Infinity, NaN]) {
      expect(() => PT.utcDatetimeStrict(bad), String(bad)).toThrow();
    }
  });
});

describe('int() of DB values (miniapp_api._signal / aggregate / rating)', () => {
  const row = (o) => ({ trade_id: 't', symbol: 'BTC-USDT-SWAP', direction: 'LONG', entry: 100, sl: 99, tp1: 101, tp2: 102, tp3: 103,
    strategy: 'SMC', created_at: 1767225600.5, result: '', progress_stage: '', ...o });
  it('quality: int(4.7) = 4, int("inf") / int("abc") raise; flags and created_at the same way', () => {
    expect(SS.signalView(row({ quality: 4.7 }), 1767225700).quality).toBe(4);
    expect(() => SS.signalView(row({ quality: 'inf' }), 1767225700)).toThrow(/invalid literal for int\(\) with base 10: 'inf'/);
    expect(() => SS.signalView(row({ mtf_aligned: 'abc' }), 1767225700)).toThrow();
    expect(() => SS.signalView(row({ created_at: Infinity }), 1767225700)).toThrow(/cannot convert float infinity to integer/);
    expect(SS.signalView(row({ created_at: 1e11 }), 1767225700).created_at).toBe(100000000000);
  });
  it('aggregate: sorted(key=float(created_at)) reads every key, even of a single row; equity int(inf) raises', () => {
    expect(() => SS.aggregate([row({ created_at: 'abc', result: 'TP1', result_rr: 1 })], 30, 1767225700))
      .toThrow(/could not convert string to float: 'abc'/);
    expect(() => SS.aggregate([row({ created_at: Infinity, result: 'TP1', result_rr: 1 })], 30, 1767225700))
      .toThrow(/cannot convert float infinity to integer/);
  });
  it('rating: int(inf // 3600) = int(nan) raises (the dashboard then shows rating null, uncached)', () => {
    expect(() => SS.ratingFromRows([row({ created_at: Infinity, result: 'TP1', result_rr: 1 })], 1767225700)).toThrow();
  });
  it('GET stats: a countable row of year 10000 makes the whole answer raise', () => {
    expect(() => SS.statsPayload([row({ created_at: 253402300800, result: 'TP1', result_rr: 1 })], { now: 1767225700 })).toThrow();
  });
  it('GET stats by_timeframe keeps a "60" / "240" timeframe where the bot puts it', () => {
    const rows = [row({ timeframe: '1h', result: 'TP1', result_rr: 1 }), row({ timeframe: '60', result: 'SL', result_rr: -1 })];
    const out = SS.statsPayload(rows, { now: 1767225700 });
    expect(PJ.dictKeys(out.by_timeframe)).toEqual(['1h', '60']);
  });
});

describe('chart data (D3): pd.Timestamp(created_at, unit="s") beyond the ns range', () => {
  const bars = Array.from({ length: 150 }, (_, i) => [1767225600000 - (150 - i) * 3600000, 100, 101, 99, 100 + (i % 5) * 0.1, 10]);
  const frame = Frame.fromBars(bars);
  const args = { symbol: 'BTC-USDT-SWAP', direction: 'LONG', entry: 100, sl: 99, tp1: 101, event: 'TP1', hit_levels: ['TP1'], be_price: 100 };
  it('inside 1677-09-21 .. 2262-04-11: the entry bar widens the window (≤ 200 bars)', () => {
    expect(CP.chartPayload(frame, { ...args, entry_time: 1767225600 - 140 * 3600 }).candles.length).toBe(150);
  });
  it('outside (year 1653 / 5138 / 10000): searchsorted raises a caught ValueError → no entry bar, the tier window', () => {
    for (const et of [-10000000000, 100000000000, 253402300800, 9223372037, -9223372037]) {
      expect(CP.chartPayload(frame, { ...args, entry_time: et }).candles.length, String(et)).toBe(110);
    }
    expect(CP.chartPayload(frame, { ...args, entry_time: 9223372036 }).candles.length).toBe(110);   // in range, after the last bar
  });
});

describe('trade_feedback (db_set_trade_result → record_feedback)', () => {
  it('_map_result_for_ml', () => {
    const cases = [['TP1', 0, 'WIN'], ['tp3', 0, 'WIN'], ['WIN', 0, 'WIN'], ['SL', 0, 'LOSS'], ['LOSS', 0, 'LOSS'], ['MANUAL', 0.11, 'WIN'],
      ['MANUAL', -0.11, 'LOSS'], ['MANUAL', 0.1, 'SKIP'], ['MANUAL', 'x', 'SKIP'], ['BE', 5, 'SKIP'], ['ORPHAN', 0, 'SKIP'], ['', 1, 'SKIP'], [null, 1, 'SKIP']];
    for (const [r, pnl, want] of cases) expect(TF.mapResultForMl(r, pnl), `${r} ${pnl}`).toBe(want);
  });
  it('the row and the features JSON as the bot writes them (INSERT OR REPLACE per user + trade)', () => {
    const db = new Database(':memory:');
    db.exec(TRADE_FEEDBACK_DDL);
    const trade = { user_id: 7, symbol: 'ETH-USDT-SWAP', strategy: 'smc', direction: 'short', entry: 100, sl: 101, tp1: 98.5, quality: null, exchange: 'bingx' };
    const now = () => 1767225600.25;
    expect(TF.recordFromTrade(db, trade, 'x1', 'TP2', 3.0, { regime: 'TRENDING_DOWN', now, log: null })).toBe(true);
    expect(TF.recordFromTrade(db, trade, 'x1', 'SL', -1.0, { regime: '', now, log: null })).toBe(true);    // replaces the row
    const rows = db.prepare('SELECT id, user_id, trade_id, symbol, strategy, direction, entry, sl, tp1, result, pnl_pct, regime, features, ts FROM trade_feedback').all();
    expect(rows).toEqual([{ id: 2, user_id: 7, trade_id: 'x1', symbol: 'ETH-USDT-SWAP', strategy: 'SMC', direction: 'SHORT', entry: 100, sl: 101, tp1: 98.5,
      result: 'LOSS', pnl_pct: -1, regime: '', ts: 1767225600.25,
      features: '{"rr": 1.5, "risk_pct": 1.0, "tp_pct": 1.5, "direction_enc": 1, "quality": 3, "session_hour": 0, "regime_enc": 0, '
        + '"vol_ratio": 1.0, "atr_pct": 0.02, "rr_target": 0.0, "exchange": "bingx", "tf": "", "raw_result": "SL"}' }]);
  });
  it('a row the block cannot read (int("abc") quality, float("12,5") entry) writes nothing', () => {
    const db = new Database(':memory:');
    db.exec(TRADE_FEEDBACK_DDL);
    const lines = [];
    const log = { debug: (m) => lines.push(m), warning: (m) => lines.push(m) };
    expect(TF.recordFromTrade(db, { user_id: 1, entry: 1, quality: 'abc' }, 'q', 'TP1', 1, { regime: '', now: () => 0, log })).toBe(false);
    expect(TF.recordFromTrade(db, { user_id: 1, entry: '12,5' }, 'e', 'TP1', 1, { regime: '', now: () => 0, log })).toBe(false);
    expect(db.prepare('SELECT COUNT(*) n FROM trade_feedback').get().n).toBe(0);
    expect(lines[0]).toMatch(/^auto record_feedback failed trade=q: invalid literal for int\(\)/);
  });
});

describe('trend_monitor.get_all(): int(strength)', () => {
  it('a NaN / inf strength raises (the dashboard then answers market_trend {})', () => {
    const m = TM.createTrendMonitor({ kv: { get: () => null, set() {}, del() {}, has: () => false }, log: { debug() {}, info() {}, warning() {} } });
    m._seed({ '15m': { trend: 'LONG', since: 1.0, price: 2.0 } }, { '15m': 86.6 });
    expect(m.getAll()['15m'].strength).toBe(86);
    m._seed({}, { '15m': NaN });
    expect(() => m.getAll()).toThrow();
    m._seed({}, { '15m': Infinity });
    expect(() => m.getAll()).toThrow();
  });
});
