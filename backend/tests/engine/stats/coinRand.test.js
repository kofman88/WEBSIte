/**
 * coinAnalysisShell.js vs the bot (gen/gen_coin_rand.py → fixtures/coin_rand.json):
 *   • coin_analysis.analyze_coin("AUTO") on 126 RANDOM 1h cuts of the 42 golden symbols (off the
 *     stride grid of coinAnalysis.test.js; fetch = the last 300 closed bars at the cut, some cuts
 *     taken a moment after the 1h close): per-strategy candidates, the AUTO pick, fetch calls;
 *   • the REAL miniapp_api.h_analyze on 37 adversarial bodies: symbol / strategy parsing
 *     (Python str() of JSON null / bool / list, str.strip() whitespace set incl. U+001F / U+0085
 *     but not U+FEFF, upper-casing), bad_symbol, the parsed symbol and the fetch calls.
 * e.g. python -c "print(repr(str(None).upper().strip()), repr('ETH﻿'.strip()))"  → 'NONE' 'ETH﻿'
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const CA = nodeRequire('../../../services/engine/coinAnalysisShell.js');
const G = nodeRequire('../../golden/load.js');

const V = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'tests', 'engine', 'stats', 'fixtures', 'coin_rand.json'), 'utf8'));

describe('analyze_coin AUTO on random golden cuts', () => {
  it(`${V.cases.length} cuts: candidates, AUTO pick, fetch calls`, async () => {
    const bad = [];
    for (const c of V.cases) {
      const calls = [];
      const fetch = async (sym, tf, limit) => {
        calls.push([sym, tf, limit]);
        return G.loadFrame(c.symbol, tf).closedPrefix(tf, c.close_ms, limit);
      };
      const out = await CA.analyzeCoin(c.symbol, 'AUTO', fetch);
      const got = { signal: out.signal, tried: out.tried, candidates: out.candidates, df_len: out.df ? out.df.length : null, calls };
      const want = { signal: c.signal, tried: c.tried, candidates: c.candidates, df_len: c.df_len, calls: c.calls };
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ symbol: c.symbol, i: c.i, got, want });
    }
    expect(bad.slice(0, 2)).toEqual([]);
    expect(V.cases.filter((c) => c.signal).length).toBeGreaterThan(40);
    expect(V.cases.some((c) => c.candidates.length > 1)).toBe(true);
  });
});

describe('Mini App analyze body parsing vs h_analyze', () => {
  it(`${V.parse.length} bodies: status, error / parsed symbol, fetch calls`, async () => {
    for (const p of V.parse) {
      const calls = [];
      const shell = CA.createAnalyzeShell({
        clock: () => 1_000_000,
        log: { info: () => {}, warn: () => {}, debug: () => {} },
        kv: { get: () => null, incrDay: () => 1 },
        planLimit: () => 999,
        fetch: async (sym, tf, limit) => { calls.push([sym, tf, limit]); return null; },
        price24h: async (sym) => { calls.push([sym, '24h', 0]); return null; },
      });
      const r = await shell.analyze({ user_id: 1 }, p.body, 1_000_000);
      const at = JSON.stringify(p.body);
      expect(r.status, at).toBe(p.status);
      const { png: _png, ...want } = p.resp;
      const { chart: _chart, ...got } = r.body;
      expect(got, at).toEqual(want);
      const key = (c) => c.join('|');
      expect(calls.map(key).sort(), at).toEqual(p.calls.map(key).sort());
    }
  });
});
