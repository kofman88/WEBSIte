'use strict';
/**
 * vectors.js — loader for the Python-generated pipeline fixtures
 * (tools/gen_vectors.py → fixtures/<section>.json) plus small fakes shared by the
 * pipeline tests: a clock, an in-memory engine_kv, a capturing logger and a Frame
 * builder for [open, high, low, close, volume] rows.
 */

const fs = require('fs');
const path = require('path');
const { Frame } = require('../../../strategies/common/frame');

const FIX = path.join(__dirname, 'fixtures');

function revive(_k, v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.$f === 'string') {
    return v.$f === 'nan' ? NaN : (v.$f === 'inf' ? Infinity : -Infinity);
  }
  return v;
}

function load(name) {
  return JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'), revive);
}

/** Frame from [[o, h, l, c, v], …] (open_time = start + i·step, like gen_vectors.make_df). */
function frameOf(rows, startMs = 1_700_000_000_000, stepMs = 900_000) {
  return Frame.fromBars(rows.map((r, i) => [startMs + i * stepMs, r[0], r[1], r[2], r[3], r[4]]));
}

function clock(t) {
  const c = { t, now: () => c.t, advance: (dt) => { c.t += dt; } };
  return c;
}

function memKv() {
  const d = new Map();
  const writes = [];
  return {
    d, writes,
    get: (k) => (d.has(k) ? d.get(k) : null),
    set: (k, v) => { d.set(k, String(v)); writes.push([k, String(v)]); },
    del: (k) => { const had = d.delete(k); return had ? 1 : 0; },
    has: (k) => d.has(k),
    keysWithPrefix: (p) => Array.from(d.keys()).filter((k) => k.startsWith(p)),
  };
}

/** A logger that records [LEVEL, message] like the Python capture handler. */
function captureLog() {
  const lines = [];
  const rec = (lvl) => (msg) => lines.push([lvl, String(msg)]);
  return { lines, debug: rec('DEBUG'), info: rec('INFO'), warning: rec('WARNING'), warn: rec('WARNING'), error: rec('ERROR') };
}

module.exports = { FIX, load, frameOf, clock, memKv, captureLog };
