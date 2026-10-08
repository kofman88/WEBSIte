'use strict';
/**
 * dumpCardSignals.js — signal objects for the card snapshot tests, produced by the
 * JS engines (LEVELS / SMC / VOLUME) on the golden candle fixtures.
 *
 * The bars are picked from the bot-generated expected files (one signal per distinct
 * card shape: breakout type / setup / grade × direction × flags, plus a spread of
 * price magnitudes), then each bar is re-run through the JS golden runner so the
 * objects carry full float64 precision (the expected files are rounded to 10 digits).
 * The golden suite already proves these objects equal the bot's.
 *
 *   node tests/engine/pipeline/tools/dumpCardSignals.js
 *   → tests/engine/pipeline/fixtures/card_signals.json
 *
 * The Python side (gen_cards.py) renders the same objects with the bot's card
 * functions; cards.test.js pins the JS renderers to those strings.
 */

const fs = require('fs');
const path = require('path');
const { loadExpected, loadFrames, barInputs, SWEEP } = require('../../../golden/load');

const runners = {
  levels: require('../../../golden/runners/levels'),
  smc: require('../../../golden/runners/smc'),
  volume: require('../../../golden/runners/volume'),
};

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

function shapeKey(strategy, g) {
  if (strategy === 'levels') return `${g.breakout_type}|${g.direction}|${g.is_counter_trend}`;
  if (strategy === 'volume') return `${g.setup}|${g.direction}|${g.alignment ? 1 : 0}|${g.htf_state}`;
  return `${g.grade}|${g.direction}|${g.mode_tag}`;
}

/** Up to `perKey` picks per card shape, each from a different symbol. */
function pick(strategy, perKey) {
  const exp = loadExpected(strategy);
  const picks = [];
  const seen = new Map();
  for (const variantName of ['default', 'conservative', 'active']) {
    for (const symbol of Object.keys(exp.fixtures)) {
      for (const g of exp.fixtures[symbol][variantName].signals) {
        const key = `${variantName}:${shapeKey(strategy, g)}`;
        const syms = seen.get(key) || new Set();
        if (syms.size >= perKey || syms.has(symbol)) continue;
        syms.add(symbol);
        seen.set(key, syms);
        picks.push({ variantName, symbol, i: g.i });
      }
    }
  }
  return { exp, picks };
}

function dump(strategy, perKey) {
  const { exp, picks } = pick(strategy, perKey);
  const out = [];
  for (const p of picks) {
    const variant = exp.variants[p.variantName];
    const frames = loadFrames(p.symbol);
    const runner = runners[strategy];
    const ctx = ctxFor(strategy, p.symbol, p.variantName, variant, frames, p.i);
    ctx.prepared = runner.prepare ? runner.prepare(frames, ctx.variant) : undefined;
    const res = runner.run(ctx);
    if (!res.signal) throw new Error(`${strategy} ${p.symbol} i=${p.i}: the JS engine gave no signal`);
    const { digest: _d, analysis: _a, ...signal } = res.signal;
    out.push({ source: `${p.variantName}/${p.symbol}/${p.i}`, signal });
  }
  return out;
}

function main() {
  const doc = {
    note: 'Signal objects of the JS engines on golden fixtures (tools/dumpCardSignals.js). Rendered by gen_cards.py with the bot.',
    levels: dump('levels', 99),
    smc: dump('smc', 2),
    volume: dump('volume', 1),
  };
  const file = path.join(__dirname, '..', 'fixtures', 'card_signals.json');
  fs.writeFileSync(file, JSON.stringify(doc, null, 1) + '\n');
  process.stdout.write(`levels=${doc.levels.length} smc=${doc.smc.length} volume=${doc.volume.length} → ${file}\n`);
}

if (require.main === module) main();

module.exports = { dump };
