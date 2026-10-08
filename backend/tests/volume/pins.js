'use strict';
/**
 * pins.js — the Python-verified expectations of the VOLUME unit tests (pins.json).
 *
 * pins.json was produced by running the bot's own volume_strategy.py / volume_scanner.py
 * (pinned venv: python 3.11.17 like production, pandas 2.3.3, numpy 1.26.4) on the frames of frames.js
 * with gen/gen_pins.py (its docstring has the command); every float was
 * repr()-ed and parsed back, so each number is the identical double. "inf"/"-inf" are
 * kept as strings (JSON has no infinity) — see pinNum().
 */
const fs = require('fs');
const path = require('path');

const pins = JSON.parse(fs.readFileSync(path.join(__dirname, 'pins.json'), 'utf8'));

/** A pinned scalar as a JS value ("inf"/"-inf"/"nan" strings → numbers). */
function pinNum(v) {
  if (v === 'inf') return Infinity;
  if (v === '-inf') return -Infinity;
  if (v === 'nan') return Number.NaN;
  return v;
}

/** Exact structural equality: numbers with Object.is, arrays/objects recursively. */
function sameValue(a, b) {
  if (typeof b === 'number') return typeof a === 'number' && Object.is(a, b);
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((v, i) => sameValue(a[i], v));
  if (b && typeof b === 'object') {
    if (!a || typeof a !== 'object') return false;
    const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i]) && kb.every((k) => sameValue(a[k], b[k]));
  }
  return a === b;
}

/** Throws with a readable path when `a` and `b` differ (exact rules of sameValue). */
function assertSame(a, b, where = '') {
  if (typeof b === 'number' || b === null || typeof b !== 'object') {
    if (!sameValue(a, b)) throw new Error(`${where}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(b)) {
    if (!Array.isArray(a) || a.length !== b.length) throw new Error(`${where}: length ${a && a.length} != ${b.length}\n got ${JSON.stringify(a)}\nwant ${JSON.stringify(b)}`);
    b.forEach((v, i) => assertSame(a[i], v, `${where}[${i}]`));
    return;
  }
  const ka = Object.keys(a || {}).sort(), kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) throw new Error(`${where}: keys differ\n got ${ka}\nwant ${kb}`);
  for (const k of kb) assertSame(a[k], b[k], `${where}.${k}`);
}

module.exports = { pins, pinNum, sameValue, assertSame };
