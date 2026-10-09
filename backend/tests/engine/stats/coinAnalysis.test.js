/**
 * coinAnalysisShell.js vs the bot's coin_analysis.py on the golden candles
 * (gen/gen_coin_analysis_vectors.py → fixtures/coin_analysis_vectors.json): 168 AUTO cuts over
 * the 42 golden symbols (per-strategy candidates, AUTO pick, freshness over the last 6 closed
 * bars), 176 single-strategy / failing-fetch runs, 246 guest result texts, the "no setup"
 * texts and the Mini App analyze quota (10 s cooldown + analyze_count_<uid>_<day>).
 *   python: await coin_analysis.analyze_coin("BTC-USDT-SWAP", "AUTO", fetch)  (fetch = last 300 closed bars)
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const CA = nodeRequire('../../../services/engine/coinAnalysisShell.js');
const G = nodeRequire('../../golden/load.js');

const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures', 'coin_analysis_vectors.json'), 'utf8'));

/** The generator's fetch: what a REST call at close_ms returns (last `limit` closed bars). */
function makeFetch(symbol, closeMs, mode = null) {
  const calls = [];
  const fetch = async (sym, tf, limit) => {
    calls.push([sym, tf, limit]);
    if (mode && mode[tf]) {
      if (mode[tf] === 'raise') throw new Error('boom');
      if (mode[tf] === 'none') return null;
      if (mode[tf] === 'short') return G.loadFrame(symbol, tf).closedPrefix(tf, closeMs, 150);
    }
    return G.loadFrame(symbol, tf).closedPrefix(tf, closeMs, limit);
  };
  return { fetch, calls };
}

const view = (out) => ({ signal: out.signal, tried: out.tried, candidates: out.candidates, df_len: out.df ? out.df.length : null });

describe('constants', () => {
  it('labels, strategies, lookback, min bars, symbol regex, cooldown', () => {
    expect(CA.LABELS).toEqual(V.labels);
    expect(CA.STRATEGIES).toEqual(V.strategies);
    expect(CA.LOOKBACK).toBe(V.lookback);
    expect(CA.MIN_BARS).toBe(V.min_bars);
    expect(CA.SYMBOL_RE.source).toBe(V.symbol_re);
    expect(CA.ANALYZE_COOLDOWN_S).toBe(V.cooldown_s);
  });
});

describe('analyze_coin AUTO on the golden cuts', () => {
  it(`${V.cases.length} cuts: candidates per strategy, AUTO pick, fetch calls`, async () => {
    const bad = [];
    for (const c of V.cases) {
      const { fetch, calls } = makeFetch(c.symbol, c.close_ms);
      const out = await CA.analyzeCoin(c.symbol, c.strategy, fetch);
      const got = view(out);
      const want = { signal: c.signal, tried: c.tried, candidates: c.candidates, df_len: c.df_len };
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ symbol: c.symbol, i: c.i, got, want });
      if (JSON.stringify(calls) !== JSON.stringify(c.calls)) bad.push({ symbol: c.symbol, i: c.i, calls });
    }
    expect(bad.slice(0, 3)).toEqual([]);
    expect(V.cases.filter((c) => c.signal).length).toBeGreaterThan(50);
    expect(V.cases.some((c) => c.candidates.length > 1)).toBe(true);
  });
  it(`${V.special.length} single-strategy and failing-fetch runs`, async () => {
    const bad = [];
    for (const c of V.special) {
      const { fetch, calls } = makeFetch(c.symbol, c.close_ms, c.mode);
      const got = view(await CA.analyzeCoin(c.symbol, c.strategy, fetch));
      const want = { signal: c.signal, tried: c.tried, candidates: c.candidates, df_len: c.df_len };
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ c: [c.symbol, c.i, c.strategy, c.mode], got, want });
      if (JSON.stringify(calls) !== JSON.stringify(c.calls)) bad.push({ c: [c.symbol, c.i, c.strategy, c.mode], calls });
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });
  it('AUTO ordering: quality, then freshness, then R:R to TP2; first maximum wins ties', () => {
    const s = (quality, barsAgo, tp2, strategy) => ({ quality, bars_ago: barsAgo, entry: 100, sl: 99, tp2, strategy });
    expect(CA.pickBest([s(3, 0, 103, 'A'), s(4, 5, 101, 'B')]).strategy).toBe('B');
    expect(CA.pickBest([s(4, 2, 109, 'A'), s(4, 1, 101, 'B')]).strategy).toBe('B');
    expect(CA.pickBest([s(4, 1, 102, 'A'), s(4, 1, 103, 'B')]).strategy).toBe('B');
    expect(CA.pickBest([s(4, 1, 103, 'A'), s(4, 1, 103, 'B')]).strategy).toBe('A');
    expect(CA.pickBest([{ quality: 5, bars_ago: 0, entry: 1, sl: 1, tp2: 2, strategy: 'Z' }]).strategy).toBe('Z');   // risk 0 → 1e-12
  });
  it('freshness helpers', () => {
    const f = G.loadFrame('BTC-USDT-SWAP', '1h').slice(10, 13);
    const hi = Math.max(...f.h); const lo = Math.min(...f.l);
    expect(CA.stillValid({ direction: 'LONG', sl: lo - 1, tp1: hi + 1 }, f)).toBe(true);
    expect(CA.stillValid({ direction: 'LONG', sl: lo, tp1: hi + 1 }, f)).toBe(false);
    expect(CA.stillValid({ direction: 'SHORT', sl: hi + 1, tp1: lo - 1 }, f)).toBe(true);
    expect(CA.stillValid({ direction: 'SHORT', sl: hi + 1, tp1: lo }, f)).toBe(false);
    expect(CA.stillValid({ direction: 'LONG', sl: 0, tp1: 0 }, f.slice(0, 0))).toBe(true);
    expect(CA.sliceUpto(f, f.t[1]).length).toBe(2);
    expect(CA.sliceUpto(null, 1)).toBe(null);
    expect(CA.lstripChars('✅ ✅ x ✅', '✅ ')).toBe('x ✅');
    expect(CA.pyStrip('  x ﻿')).toBe('x ﻿');
  });
});

describe('texts (handlers/guest.py)', () => {
  it(`${V.texts.length} result cards verbatim (auto / single, paid / free, price data or not, escaping)`, () => {
    for (const c of V.texts) {
      expect(CA.formatStrategyResult(c.symbol, c.data, c.sig, c.ref, c.paid, c.auto, c.tried), JSON.stringify(c.sig).slice(0, 80)).toBe(c.text);
    }
  });
  it('no-setup replies', () => {
    for (const [s, text] of Object.entries(V.no_setup)) expect(CA.noSetupText('ETH', s)).toBe(text);
  });
});

describe('Mini App analyze', () => {
  it('quota: 10 s cooldown, plan_limit("analyze_per_day") on kv analyze_count_<uid>_<day>, pro fallback', async () => {
    const store = {};
    const kv = {
      get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      incrDay: (prefix, uid, { now }) => {
        const k = `${prefix}_${uid}_${Math.floor(now / 86400)}`;
        store[k] = String(Number(store[k] || '0') + 1);
        return Number(store[k]);
      },
    };
    const shell = CA.createAnalyzeShell({
      kv,
      planLimit: (u) => { if (u.limit === 'raise') throw new Error('x'); return u.limit; },
      isPro: () => false,              // the generator's fake user has no check_access → _is_pro False
      log: { info: () => {}, warn: () => {}, debug: () => {} },
    });
    for (const q of V.quota) {
      expect(await shell.analyzeAllowed({ user_id: q.uid, limit: q.limit }, q.t), JSON.stringify(q)).toBe(q.result);
      expect(store).toEqual(q.kv);
    }
  });
  it('body parsing like h_analyze', () => {
    expect(CA.parseAnalyzeBody({ symbol: ' btc/usdt ', strategy: 'smc' })).toEqual({ symbol: 'BTC', strategy: 'SMC' });
    expect(CA.parseAnalyzeBody({ symbol: 'ethusdt' })).toEqual({ symbol: 'ETH', strategy: 'AUTO' });
    expect(CA.parseAnalyzeBody({ symbol: '1000PEPE', strategy: 'foo' })).toEqual({ symbol: '1000PEPE', strategy: 'AUTO' });
    expect(CA.parseAnalyzeBody({ symbol: 'a<b' })).toEqual({ error: 'bad_symbol' });
    expect(CA.parseAnalyzeBody({ symbol: 'X' })).toEqual({ error: 'bad_symbol' });
    expect(CA.parseAnalyzeBody({})).toEqual({ error: 'bad_symbol' });
    expect(CA.parseAnalyzeBody({ symbol: 'ABCDEFGHIJKLMNOP' })).toEqual({ error: 'bad_symbol' });
  });
  it('payload: signal subset, tried, price, chart JSON instead of the PNG; cooldown answer', async () => {
    const c = V.cases.find((x) => x.signal && x.symbol === 'BTC-USDT-SWAP') || V.cases.find((x) => x.signal);
    const base = c.symbol.replace('-USDT-SWAP', '');
    const logs = [];
    const shell = CA.createAnalyzeShell({
      kv: { get: () => null, incrDay: () => 1 },
      planLimit: () => 999,
      fetch: (sym, tf, limit) => {
        expect(sym).toBe(c.symbol);
        return G.loadFrame(c.symbol, tf).closedPrefix(tf, c.close_ms, limit);
      },
      price24h: async () => ({ last: 123.4, change_pct: 1.23456 }),
      log: { info: (m) => logs.push(m), warn: () => {}, debug: () => {} },
    });
    const r = await shell.analyze({ user_id: 5 }, { symbol: base, strategy: 'auto' }, 1000);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.symbol).toBe(base);
    expect(r.body.price).toEqual({ price: 123.4, change_pct: 1.23 });
    expect(r.body.tried).toEqual(c.tried);
    expect(r.body.signal).toEqual({
      strategy: c.signal.strategy, direction: c.signal.direction, entry: c.signal.entry, sl: c.signal.sl,
      tp1: c.signal.tp1, tp2: c.signal.tp2, tp3: c.signal.tp3, quality: c.signal.quality, setup: c.signal.setup,
      reasons: c.signal.reasons, bars_ago: c.signal.bars_ago,
    });
    // D3: png null + the chart as data (chartPayload: the pro window of 110 bars, MAs 20/50/200)
    expect(r.body.png).toBe(null);
    expect(r.body.timeframe).toBe('1h');
    expect(r.body.candles.length).toBe(110);
    expect(r.body.overlays.emas.map((e) => e.label)).toEqual(['EMA 20', 'EMA 50', 'EMA 200']);
    expect(r.body.overlays.entry).toBe(c.signal.entry);
    expect(logs).toEqual([`[MINIAPP] analyze uid=5 ${base} AUTO → ${c.signal.strategy}`]);
    expect((await shell.analyze({ user_id: 5 }, { symbol: base }, 1005)).body).toEqual({ ok: false, error: 'rate_limited' });
    expect((await shell.analyze({ user_id: 5 }, { symbol: '??' }, 2000))).toEqual({ status: 400, body: { ok: false, error: 'bad_symbol' } });
  });
});
