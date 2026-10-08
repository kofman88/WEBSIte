'use strict';
/**
 * gen_pins.js — the JS half of gen_pins.py (run that one, it calls this):
 *   node gen_pins.js dump             → stdout: frames.js dumpScenarios() as JSON ({name: bars[]})
 *   node gen_pins.js assemble OUT     → stdin: the bot's raw output (floats as repr() strings);
 *                                       writes OUT (pins.json, JSON.stringify(obj, null, 1) layout)
 * A repr() string is parsed back to the identical double; "inf" / "-inf" / "nan" stay strings
 * (JSON has no infinity, see pins.js pinNum), any other string is kept.
 */
const fs = require('fs');
const path = require('path');

function back(x) {
  if (Array.isArray(x)) return x.map(back);
  if (x && typeof x === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(x)) o[k] = back(v);
    return o;
  }
  if (typeof x === 'string') {
    if (x === 'inf' || x === '-inf' || x === 'nan') return x;
    if (/^-?(\d+\.?\d*(e[+-]?\d+)?|\.\d+)$/i.test(x)) return Number(x);
    return x;
  }
  return x;
}

function assemble(raw) {
  const { python, pandas, numpy, scenarios, ...rest } = raw;
  const out = {
    _provenance: `Produced by the bot code (volume_strategy.py / volume_scanner.py, python ${python}, pandas ${pandas}, `
      + `numpy ${numpy}) on the frames of frames.js — tests/volume/gen/gen_pins.py; floats were repr()-ed and parsed `
      + 'back, so every number is the identical double.',
    python,
    scenarios: back(scenarios),
  };
  for (const [k, v] of Object.entries(rest)) out[k] = back(v);
  return out;
}

function main(argv) {
  const [cmd, outPath] = argv;
  if (cmd === 'dump') {
    const F = require(path.join(__dirname, '..', 'frames.js'));
    process.stdout.write(JSON.stringify(F.dumpScenarios()));
  } else if (cmd === 'assemble' && outPath) {
    const raw = JSON.parse(fs.readFileSync(0, 'utf8'));
    fs.writeFileSync(outPath, JSON.stringify(assemble(raw), null, 1) + '\n');
  } else {
    throw new Error('usage: node gen_pins.js dump | assemble OUT');
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { back, assemble };
