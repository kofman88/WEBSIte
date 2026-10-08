'use strict';
/**
 * helpers.js — fixture loading for the genome tests. The fixtures are produced by
 * make_genome_vectors.py from the bot's own code (see its header for the re-run command) and
 * stored gzipped; "inf" / "-inf" / "nan" strings stand for the non-finite floats JSON lacks.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FIXTURES = path.join(__dirname, 'fixtures');
const cache = new Map();

function reviver(_k, v) {
  if (v === 'inf') return Infinity;
  if (v === '-inf') return -Infinity;
  if (v === 'nan') return NaN;
  return v;
}

function loadFixture(name) {
  if (cache.has(name)) return cache.get(name);
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, `${name}.json.gz`))).toString('utf8');
  const doc = JSON.parse(raw, reviver);
  cache.set(name, doc);
  return doc;
}

/** Deep equality with Python numeric semantics (True == 1, 2 == 2.0, NaN == NaN). */
function pyEqual(a, b) {
  const n = (x) => (typeof x === 'boolean' ? (x ? 1 : 0) : x);
  if ((typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'boolean')) {
    const x = n(a); const y = n(b);
    return x === y || (Number.isNaN(x) && Number.isNaN(y));
  }
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => pyEqual(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort(); const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => pyEqual(a[k], b[k]));
  }
  return a === b;
}

/** Relative closeness for float price fields (|a − b| ≤ rel × max(|a|, |b|)). */
function close(a, b, rel = 1e-12) {
  if (a === b) return true;
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  return Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b));
}

/** A logger that records lines (info / warn / debug / error). */
function memLog() {
  const lines = [];
  const rec = (level) => (msg) => { lines.push([level, String(msg)]); };
  return { lines, info: rec('info'), warn: rec('warn'), warning: rec('warn'), debug: rec('debug'), error: rec('error') };
}

module.exports = { FIXTURES, loadFixture, pyEqual, close, memLog };
