'use strict';
/**
 * dumpDiffCardSignals.js — 12 more signal objects per strategy for the differential card
 * test (differential.test.js `cards`): the JS engines (LEVELS / SMC / VOLUME) on the golden
 * candle fixtures, at bars picked by a seeded draw among the bot-expected signals that
 * card_signals.json (dumpCardSignals.js) does not use yet.
 *
 *   node tests/engine/pipeline/tools/dumpDiffCardSignals.js
 *   → tests/engine/pipeline/fixtures/diff_card_signals.json
 *
 * gen_differential.py `cards` renders them with the bot's card functions under random
 * BTC trend states, price scales, languages and flags.
 */

const fs = require('fs');
const path = require('path');
const { loadExpected, loadFrames, barInputs, SWEEP } = require('../../../golden/load');

const runners = {
  levels: require('../../../golden/runners/levels'),
  smc: require('../../../golden/runners/smc'),
  volume: require('../../../golden/runners/volume'),
};
const FIX = path.join(__dirname, '..', 'fixtures');

function ctxFor(strategy, symbol, variantName, variant, frames, i) {
  const b = barInputs(frames, i);
  const base = { symbol, i, closeMs: b.closeMs, variant: { name: variantName, ...variant } };
  if (strategy === 'levels') {
    const useHtf = !!(variant.ind_config && variant.ind_config.USE_HTF_FILTER);
    return { ...base, df: b.df, dfHtf: useHtf ? b.dfHtf1d : null, dfBtc: b.dfBtc, dfEth: b.dfEth };
  }
  if (strategy === 'smc') return { ...base, dfHtf: b.dfHtf4h, dfMtf: b.df, dfLtf: b.dfLtf15m };
  const useHtf = !!(variant.volume_config && variant.volume_config.use_htf);
  return { ...base, df: b.df, dfHtf: useHtf ? b.dfHtf4h : null, timeframe: SWEEP.tf };
}

function main() {
  const used = JSON.parse(fs.readFileSync(path.join(FIX, 'card_signals.json'), 'utf8'));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const out = { note: 'JS engine signal objects for differential.test.js (tools/dumpDiffCardSignals.js).' };
  for (const strategy of ['levels', 'smc', 'volume']) {
    const exp = loadExpected(strategy);
    const taken = new Set(used[strategy].map((x) => x.source));
    const all = [];
    for (const variantName of ['default', 'conservative', 'active']) {
      for (const symbol of Object.keys(exp.fixtures)) {
        for (const g of exp.fixtures[symbol][variantName].signals) {
          const src = `${variantName}/${symbol}/${g.i}`;
          if (!taken.has(src)) all.push({ variantName, symbol, i: g.i, src });
        }
      }
    }
    const picks = [];
    const seenSym = new Set();
    while (picks.length < 12 && all.length) {
      const p = all.splice(Math.floor(rnd() * all.length), 1)[0];
      if (seenSym.has(p.symbol + p.variantName) && all.length > 50) continue;
      seenSym.add(p.symbol + p.variantName);
      picks.push(p);
    }
    out[strategy] = picks.map((p) => {
      const variant = exp.variants[p.variantName];
      const frames = loadFrames(p.symbol);
      const runner = runners[strategy];
      const ctx = ctxFor(strategy, p.symbol, p.variantName, variant, frames, p.i);
      ctx.prepared = runner.prepare ? runner.prepare(frames, ctx.variant) : undefined;
      const res = runner.run(ctx);
      if (!res.signal) throw new Error(`${strategy} ${p.src}: the JS engine gave no signal`);
      const { digest: _d, analysis: _a, ...signal } = res.signal;
      return { source: p.src, signal };
    });
  }
  const file = path.join(FIX, 'diff_card_signals.json');
  fs.writeFileSync(file, JSON.stringify(out) + '\n');
  process.stdout.write(`levels=${out.levels.length} smc=${out.smc.length} volume=${out.volume.length} → ${file}\n`);
}

if (require.main === module) main();
