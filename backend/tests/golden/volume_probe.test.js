/**
 * volume_probe.test.js — VOLUME differential probe (expected/volume_probe.json.gz, produced by
 * make_volume_probe.py with the bot's own volume_strategy.py): configs, base timeframes, trailing
 * windows, random genome configs and candle mutations that expected/volume.json does not cover.
 * Same comparison rules as golden.test.js (compare.js, strict r10 with GOLDEN_STRICT=1); every
 * swept bar must agree (signal ↔ signal with every field, null ↔ null); the engine must not throw.
 *
 * Env knobs: GOLDEN_PROBE_CASES=momentum_sma,rand03 (prefix filter), GOLDEN_STRICT=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import load from './load.js';
import compare from './compare.js';
import V from '../../strategies/volume/index.js';
import frameMod from '../../strategies/common/frame.js';
import prodPython from '../common/prodPython.js';

const { Frame, TF_MS } = frameMod;
const { PROD_PYTHON } = prodPython;
const { compareSignal, formatDiffs, ROUNDED_FIELDS_BY_STRATEGY } = compare;
const HERE = path.dirname(new URL(import.meta.url).pathname);
const HTF_OF = { '15m': '1h', '1h': '4h', '4h': '1d' };
const HARNESS_KEYS = ['i', 'open_time_ms', 'n_bars', 'n_htf_bars'];
const CASE_FILTER = process.env.GOLDEN_PROBE_CASES
  ? process.env.GOLDEN_PROBE_CASES.split(',').map((s) => s.trim()).filter(Boolean) : null;

function loadProbe() {
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'expected', 'volume_probe.json.gz')));
  const summary = JSON.parse(fs.readFileSync(path.join(HERE, 'probe_summary.json'), 'utf8'));
  const sha = load.sha256(raw);
  if (sha !== summary.sha256['expected/volume_probe.json']) {
    throw new Error(`volume_probe.json.gz sha256 ${sha} != probe_summary.json (regenerate with make_volume_probe.py)`);
  }
  return { probe: JSON.parse(raw.toString('utf8')), summary };
}

/** Deterministic candle mutation of make_volume_probe.mutate (bar index j of the FULL base frame). */
function mutateFrame(frame, mut) {
  if (!mut) return frame;
  const n = frame.length;
  const o = Float64Array.from(frame.o), h = Float64Array.from(frame.h), l = Float64Array.from(frame.l);
  const c = Float64Array.from(frame.c), v = Float64Array.from(frame.v);
  const zv = mut.zero_volume_every, fl = mut.flat_every, sp = mut.spike_every, gp = mut.gap_every;
  let factor = 1.0;
  for (let j = 0; j < n; j++) {
    if (gp && j % gp === 9) factor *= Math.floor(j / gp) % 2 === 0 ? 1.04 : 0.96;
    if (gp) { o[j] *= factor; h[j] *= factor; l[j] *= factor; c[j] *= factor; }
    if (fl && j % fl === 5) { o[j] = c[j]; h[j] = c[j]; l[j] = c[j]; }
    if (sp && j % sp === 2) v[j] *= 40.0;
    if (zv && j % zv === 3) v[j] = 0.0;
  }
  const f = new Frame(Float64Array.from(frame.t), o, h, l, c, v);
  f.symbol = frame.symbol; f.tf = frame.tf;
  return f;
}

/** Sweep one symbol of one probe case; returns { failures, bars, signals }. */
function sweepCase(c, cfg, symbol, fx, htfWindow) {
  const tf = c.tf, htfTf = HTF_OF[tf];
  const frames = load.loadFrames(symbol);
  const base = mutateFrame(frames[tf], c.mutate), htfAll = frames[htfTf];
  const [start, end, step] = fx.swept;
  const indices = [];
  for (let i = start; i <= end; i += step) indices.push(i);
  if (indices[indices.length - 1] !== end) indices.push(end);
  const expected = new Map(fx.signals.map((s) => [s.i, s]));
  const failures = [];
  let signals = 0;
  for (const i of indices) {
    const df = c.window ? base.slice(Math.max(0, i - c.window + 1), i + 1) : base.prefix(i);
    const closeMs = base.t[i] + TF_MS[tf];
    const dfHtf = cfg.use_htf ? htfAll.closedPrefix(htfTf, closeMs, htfWindow) : null;
    let sig;
    try {
      sig = V.analyzeVolume(symbol, df, cfg, tf, dfHtf);
    } catch (e) {
      failures.push(`bar ${i}: engine threw ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
      continue;
    }
    const exp = expected.get(i);
    if (exp && !sig) { failures.push(`bar ${i}: expected a ${exp.direction} ${exp.setup} signal, engine returned null`); continue; }
    if (!exp && sig) { failures.push(`bar ${i}: unexpected ${sig.direction} ${sig.setup} signal (probe has none)`); continue; }
    if (!exp) continue;
    signals++;
    const record = { ...sig.toDict(), tp: sig.tp, risk_pct: sig.risk_pct, volume_ratio: sig.volume_ratio, ...V.scannerPostSteps(sig, df, cfg) };
    const diffs = compareSignal(record, exp, { ignoreKeys: HARNESS_KEYS, roundedFields: ROUNDED_FIELDS_BY_STRATEGY.volume });
    const hr = { i, open_time_ms: base.t[i], n_bars: df.length, n_htf_bars: dfHtf ? dfHtf.length : 0 };
    for (const k of HARNESS_KEYS) if (hr[k] !== exp[k]) diffs.push({ path: `harness.${k}`, actual: hr[k], expected: exp[k], rule: 'harness' });
    if (diffs.length) failures.push(`bar ${i}:\n${formatDiffs(diffs)}`);
    if (failures.length > 25) { failures.push('… stopping after 25 failures'); break; }
  }
  return { failures, bars: indices.length, signals };
}

describe('golden volume probe (make_volume_probe.py)', () => {
  // the probe ships with the repo (expected/volume_probe.json.gz + probe_summary.json): a missing file fails loudly
  let probe, summary;
  beforeAll(() => { ({ probe, summary } = loadProbe()); });

  it('probe file is intact and the summary counts match', () => {
    expect(probe.python).toMatch(PROD_PYTHON);
    expect(Object.keys(probe.cases).length).toBe(summary.cases);
    let signals = 0, bars = 0;
    for (const c of Object.values(probe.cases)) for (const fx of Object.values(c.fixtures)) { signals += fx.n_signals; bars += fx.n_swept; }
    expect(signals).toBe(summary.signals);
    expect(bars).toBe(summary.bars);
    expect(summary.errors).toBe(0);   // analyze_volume never logged [VOLUME-ERR] on any probe bar
  });

  const names = (() => {
    const { probe: p } = loadProbe();
    return Object.keys(p.cases).filter((n) => !CASE_FILTER || CASE_FILTER.some((f) => n.startsWith(f)));
  })();
  for (const name of names) {
    it(`${name}`, () => {
      const c = probe.cases[name];
      // [VOL-MIN-SL] / [VOL-MIN-VOLUME] 2026-10: the case's batch-D env (every other one unset), as the generator ran it
      V.quality.setEnv(c.env || {});
      try {
        runCase(name, c);
      } finally {
        V.quality.setEnv(null);
      }
    });
  }

  function runCase(name, c) {
    // config path: fromParams reproduces the Python VolumeConfig (coercion + _fix) and min_bars
    const cfg = V.VolumeConfig.fromParams(c.params);
    expect(cfg.toDict()).toEqual(c.volume_config);
    expect(V.minBars(cfg)).toBe(c.min_bars);
    const failures = [];
    let bars = 0, signals = 0, want = 0;
    for (const [symbol, fx] of Object.entries(c.fixtures)) {
      const res = sweepCase(c, cfg, symbol, fx, probe.htf_window);
      bars += res.bars; signals += res.signals; want += fx.n_signals;
      for (const f of res.failures) failures.push(`${symbol} ${f}`);
    }
    if (failures.length) throw new Error(`volume probe ${name}: ${failures.length} failing bars of ${bars}\n${failures.join('\n')}`);
    expect(signals).toBe(want);
  }
});
