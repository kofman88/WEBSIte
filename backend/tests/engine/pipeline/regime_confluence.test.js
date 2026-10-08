/**
 * regimeLoop (market_regime cache + regime_history kv) and signalConfluence on
 * Python vectors (fixtures/regime.json, fixtures/confluence.json, tools/gen_vectors.py).
 *
 *   Python: mr.time = Clock(...); mr.set_cached_regime("ranging"); await mr.get_regime_history(10)
 *           sc.time = Clock(...); sc.record_signal("BTC-USDT-SWAP", "LONG", "LEVELS", 7); sc.get_confluence_label(...)
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const RL = req('../../../services/engine/regimeLoop.js');
const SC = req('../../../services/engine/signalConfluence.js');
const { load, clock, memKv, captureLog, frameOf } = req('./vectors.js');

const RG = load('regime');
const CF = load('confluence');

describe('regime_allows_direction', () => {
  it.each(RG.allows)('%s / %s → %s', (r, d, want) => {
    expect(RL.regimeAllowsDirection(r, d)).toBe(want);
  });
});

describe('cached regime + history (bot replay)', () => {
  it('replays set / get / history steps', () => {
    const c = clock(1_800_000_000.5);
    const kv = memKv();
    const loop = RL.createRegimeLoop({ now: c.now, kv, log: captureLog() });
    for (const s of RG.steps) {
      let res = null;
      const op = s.op;
      if (op[0] === 'set') loop.setCachedRegime(op[1]);
      else if (op[0] === 'get') res = loop.getCachedRegime();
      else if (op[0] === 'advance') c.advance(op[1]);
      else if (op[0] === 'hist') res = loop.getRegimeHistory(op[1]);
      expect(c.t).toBe(s.now);
      expect(res, JSON.stringify(op)).toEqual(s.result);
      expect(kv.get('regime_history'), JSON.stringify(op)).toBe(s.kv);
    }
  });

  it.each(RG.hist.map((h, i) => [i, h]))('_append_regime_history edge #%i', (_i, h) => {
    const kv = memKv();
    if (h.raw !== null) kv.set('regime_history', h.raw);
    const loop = RL.createRegimeLoop({ kv, log: captureLog() });
    loop.appendRegimeHistory('ranging', 'high_vol', 1_800_000_123.5);
    expect(kv.get('regime_history')).toBe(h.after);
  });

  it('tick: 120 × 1H BTC → cache (TTL 1800) → detect_regime → cached regime', async () => {
    const rows = [];
    for (let i = 0; i < 120; i++) { const p = 100 + i * 0.5; rows.push([p, p + 0.4, p - 0.2, p + 0.3, 1000]); }
    const df = frameOf(rows);
    const calls = [];
    const set = [];
    const loop = RL.createRegimeLoop({
      now: () => 1_800_000_000, kv: memKv(), log: captureLog(),
      fetcher: { getCandles: async (s, tf, limit) => { calls.push([s, tf, limit]); return df; } },
      cache: { setCandles: (s, tf, f, ttl) => set.push([s, tf, f.length, ttl]) },
    });
    const regime = await loop.tick();
    expect(calls).toEqual([['BTC-USDT-SWAP', '1H', 120]]);
    expect(set).toEqual([['BTC-USDT-SWAP', '1H', 120, { '1H': 1800 }]]);
    expect(regime).toBe(req('../../../strategies/common/marketRegime.js').detectRegime(df));
    expect(loop.getCachedRegime()).toBe(regime);
    const short = RL.createRegimeLoop({ kv: memKv(), log: captureLog(), fetcher: { getCandles: async () => frameOf(rows.slice(0, 59)) }, cache: { setCandles() {} } });
    expect(await short.tick()).toBe(null);
  });
});

describe('signal_confluence (bot replay)', () => {
  it('replays record / label / strategies / gc / stats', () => {
    const c = clock(1_800_000_000.0);
    const conf = SC.createSignalConfluence({ now: c.now });
    for (const s of CF.steps) {
      const op = s.op;
      let res = null;
      if (op[0] === 'record') conf.recordSignal(op[1], op[2], op[3], op[4]);
      else if (op[0] === 'label') res = conf.getConfluenceLabel(op[1], op[2], op[3]);
      else if (op[0] === 'strategies') res = conf.getConfluentStrategies(op[1], op[2], op[3]).map((e) => [e.strategy, e.ts, e.quality]);
      else if (op[0] === 'advance') c.advance(op[1]);
      else if (op[0] === 'stats') res = conf.getStats();
      else if (op[0] === 'gc') res = conf.gcRecent();
      expect(res, JSON.stringify(op)).toEqual(s.result);
    }
  });
});
