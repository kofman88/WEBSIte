/**
 * probeReplay.js — shared replay of the LEVELS differential probes written by
 * tests/golden/make_levels_probe.py (the bot's own indicator.CHMIndicator):
 *
 *   levels_probe.json.gz            main suite, seed 20261008 (154 cases)      → probe.test.js
 *   levels_probe_s<seed>.json.gz    main suite re-check runs (other seeds,
 *                                   redrawn sources, extended random cases)    → probe_seed.test.js
 *   levels_probe_setups.json.gz     hand-constructed setup frames (frames{}
 *                                   stored in the file, not rebuilt)           → probe_setups.test.js
 *
 * Same comparison rules as golden.test.js (compare.js, LEVELS rounds nothing, strict r10 with
 * GOLDEN_STRICT=1): every swept bar must agree — signal ↔ signal with every field, null ↔ null
 * with the same _ANALYZE_STATS bucket, a Python exception ↔ a JS throw.
 *
 * Env knobs: LEVELS_PROBE_CASES=cls_,rand03 (prefix filter), GOLDEN_STRICT=1,
 * LEVELS_PROBE_ENGINE=/abs/path/levels/index.js (replay another engine build), LEVELS_PROBE_MAXFAIL=30.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import load from '../golden/load.js';
import compare from '../golden/compare.js';
import frameMod from '../../strategies/common/frame.js';
import pyfmt from '../../strategies/common/pyfmt.js';
import Lmain from '../../strategies/levels/index.js';

// LEVELS_PROBE_ENGINE=<abs path of a levels/index.js> replays the probe against another engine
// build (e.g. a snapshot of an older commit, to count mismatches before a fix)
const L = process.env.LEVELS_PROBE_ENGINE ? (await import(process.env.LEVELS_PROBE_ENGINE)).default : Lmain;
const { Frame, TF_MS } = frameMod;
const { r10 } = pyfmt;
const { compareSignal, compareValue, formatDiffs, ROUNDED_FIELDS_BY_STRATEGY } = compare;
export const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'golden');
const HARNESS_KEYS = ['i', 'open_time_ms', 'n_bars', 'n_htf_bars'];
const CORR_WINDOW = 299;
const MAX_FAIL = Number(process.env.LEVELS_PROBE_MAXFAIL || 30);
const CASE_FILTER = process.env.LEVELS_PROBE_CASES
  ? process.env.LEVELS_PROBE_CASES.split(',').map((s) => s.trim()).filter(Boolean) : null;

/** Stems (`levels_probe…`) of the probe files present in tests/golden matching `re`. */
export function probeStems(re) {
  return fs.readdirSync(GOLDEN)
    .map((f) => /^(levels_probe[A-Za-z0-9_]*)\.json\.gz$/.exec(f))
    .filter((m) => m && re.test(m[1]) && fs.existsSync(path.join(GOLDEN, `${m[1]}_summary.json`)))
    .map((m) => m[1])
    .sort();
}

const probeCache = new Map();
/** Gunzip + sha256 check against `<stem>_summary.json`. */
export function loadProbe(stem) {
  if (probeCache.has(stem)) return probeCache.get(stem);
  const raw = zlib.gunzipSync(fs.readFileSync(path.join(GOLDEN, `${stem}.json.gz`)));
  const summary = JSON.parse(fs.readFileSync(path.join(GOLDEN, `${stem}_summary.json`), 'utf8'));
  const sha = load.sha256(raw);
  if (sha !== summary.sha256[`${stem}.json`]) {
    throw new Error(`${stem}.json.gz sha256 ${sha} != ${stem}_summary.json (regenerate with make_levels_probe.py)`);
  }
  const res = { probe: JSON.parse(raw.toString('utf8')), summary };
  probeCache.set(stem, res);
  return res;
}

// ── frames, mirrored from make_levels_probe.py ─────────────────────────────

const frameCache = new Map();
/**
 * Working-TF frame of a source: a hand-constructed frame stored in the probe (frames[src].bars,
 * its synthetic 1D range in htf_bars), else the golden fixture; 30m = pairs of 15m bars.
 */
function baseFrame(src, tf, stored) {
  const key = `${src}_${tf}`;
  if (frameCache.has(key)) return frameCache.get(key);
  let f;
  if (stored && stored[src]) {
    f = Frame.fromBars(tf === '1d' ? stored[src].htf_bars : stored[src].bars);
  } else if (tf === '30m') {
    const d = baseFrame(src, '15m', stored);
    const m = Math.floor(d.length / 2);
    const cols = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (let k = 0; k < m; k++) {
      const a = 2 * k, b = 2 * k + 1;
      cols.t.push(d.t[a]); cols.o.push(d.o[a]); cols.h.push(Math.max(d.h[a], d.h[b])); cols.l.push(Math.min(d.l[a], d.l[b]));
      cols.c.push(d.c[b]); cols.v.push(d.v[a] + d.v[b]);
    }
    f = Frame.fromColumns(cols);
  } else {
    f = load.loadFrame(src, tf);
  }
  frameCache.set(key, f);
  return f;
}

/** make_levels_probe.mutate (index j counted after the row drop). */
function mutateFrame(frame, mut) {
  if (!mut) return frame;
  let rows = [...Array(frame.length).keys()];
  if (mut.drop_every) rows = rows.filter((j) => j % mut.drop_every !== (mut.drop_rem || 0));
  const n = rows.length;
  const pick = (a) => Float64Array.from(rows, (j) => a[j]);
  const t = pick(frame.t), o = pick(frame.o), h = pick(frame.h), l = pick(frame.l), c = pick(frame.c), v = pick(frame.v);
  const jp = mut.jump_every, fl = mut.flat_every, sp = mut.spike_every, zv = mut.zero_vol_every, nv = mut.nan_vol_every, wk = mut.wick_every;
  const nf = mut.nan_flat_every;
  let factor = 1.0;
  for (let j = 0; j < n; j++) {
    if (jp && j % jp === 9) factor *= Math.floor(j / jp) % 2 === 0 ? 1.04 : 0.96;
    if (jp) { o[j] *= factor; h[j] *= factor; l[j] *= factor; c[j] *= factor; }
    if (wk && j % wk === 6) l[j] = l[j] - (h[j] - l[j]) * 2.0;
    if (wk && j % wk === 0) h[j] = h[j] + (h[j] - l[j]) * 2.0;
    if (fl && j % fl === 5) { o[j] = c[j]; h[j] = c[j]; l[j] = c[j]; }
    if (sp && j % sp === 2) v[j] *= 40.0;
    if (zv && j % zv === 3) v[j] = 0.0;
    if (nv && j % nv === 4) v[j] = NaN;
    if (nf && j % nf === 7) { o[j] = c[j]; h[j] = c[j]; l[j] = c[j]; v[j] = NaN; }
  }
  if (mut.const_tail) {
    const p = c[n - mut.const_tail - 1];
    for (let j = n - mut.const_tail; j < n; j++) { o[j] = p; h[j] = p; l[j] = p; c[j] = p; }
  }
  if (mut.scale) {
    const s = mut.scale;
    for (let j = 0; j < n; j++) { o[j] *= s; h[j] *= s; l[j] *= s; c[j] *= s; }
  }
  return new Frame(t, o, h, l, c, v);
}

function scaleFrame(frame, s) {
  if (!s) return frame;
  const sc = (a) => Float64Array.from(a, (x) => x * s);
  return new Frame(Float64Array.from(frame.t), sc(frame.o), sc(frame.h), sc(frame.l), sc(frame.c), Float64Array.from(frame.v));
}

function corrFrames(mode, tf, closeMs, df) {
  if (mode === 'none') return [null, null];
  const ctf = mode === 'tf1h' ? '1h' : tf;
  const btc = baseFrame('BTC-USDT-SWAP', ctf), eth = baseFrame('ETH-USDT-SWAP', ctf);
  if (mode === 'stale') {
    const at = closeMs - 40 * TF_MS[ctf];
    return [btc.closedPrefix(ctf, at, CORR_WINDOW), eth.closedPrefix(ctf, at, CORR_WINDOW)];
  }
  const b = btc.closedPrefix(ctf, closeMs, CORR_WINDOW), e = eth.closedPrefix(ctf, closeMs, CORR_WINDOW);
  if (mode === 'btc_only') return [b, null];
  if (mode === 'short') return [btc.closedPrefix(ctf, closeMs, 10), eth.closedPrefix(ctf, closeMs, 11)];
  if (mode === 'self') return [df, e];
  return [b, e];
}

// ── replay ────────────────────────────────────────────────────────────────

/** Replays one probe case bar by bar; returns { failures, bars, signals, want, records }. */
export function replayCase(c, probe) {
  const triggerReason = probe.trigger_reason;
  const stored = probe.frames || null;
  const tc = L.tradeCfg(c.trade_cfg);
  const cfg = L.cfgToInd(tc, c.high_wr, c.env);
  const failures = [];
  // config path: TradeCfg clamps + _cfg_to_ind (incl. the LEVELS_MIN_RR env floor)
  const dTc = compareValue(Object.fromEntries(Object.entries(tc).map(([k, x]) => [k, r10(x)])), c.trade_cfg_full, 'trade_cfg');
  const dIc = compareValue(Object.fromEntries(Object.entries(cfg).map(([k, x]) => [k, r10(x)])), c.ind_config, 'ind_config');
  if (Object.keys(cfg).join(',') !== Object.keys(c.ind_config).join(',')) failures.push('IndConfig field order differs');
  for (const d of [...dTc, ...dIc]) failures.push(`${d.path}: got ${d.actual}, want ${d.expected}`);
  const minQEff = L.relaxMinQuality(tc.min_quality, c.relaxed);
  if (minQEff !== c.min_quality_eff) failures.push(`min_quality_eff ${minQEff} != ${c.min_quality_eff}`);

  const tf = c.tf, W = c.window, tfMs = TF_MS[tf];
  const scale = c.mutate ? c.mutate.scale : null;
  const syms = Object.entries(c.fixtures).map(([alias, fx]) => {
    const base = mutateFrame(baseFrame(fx.src, tf, stored), c.mutate);
    const n = base.length;
    const idx = [];
    for (let i = n - c.sweep; i < n; i += c.step) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    if (idx[0] !== fx.swept[0] || idx[idx.length - 1] !== fx.swept[1] || idx.length !== fx.n_swept) {
      failures.push(`${alias}: sweep indices ${idx[0]}..${idx[idx.length - 1]} (${idx.length}) != ${fx.swept} (${fx.n_swept})`);
    }
    return {
      alias, fx, base, idx, htf: scaleFrame(baseFrame(fx.src, '1d', stored), scale),
      expected: new Map(fx.signals.map((s) => [s.i, s])), errors: new Set(fx.errors.map((e) => e.i)), signals: 0,
    };
  });
  const opts = { env: c.env, relaxed: c.relaxed, regime: c.regime, triggerReason };
  const live = c.mode === 'live';
  const shared = live ? L.createIndicator(cfg, { ...opts, cacheMax: c.cache_max || undefined }) : null;
  const breakoutState = new Map();
  const nSteps = Math.max(...syms.map((s) => s.idx.length));
  const t0 = (syms[0].base.t[syms[0].idx[0]] + tfMs) / 1000;
  const records = [];
  let bars = 0;
  for (let k = 0; k < nSteps; k++) {
    for (const s of syms) {
      if (k >= s.idx.length) continue;
      const i = s.idx[k];
      bars++;
      const df = W ? s.base.slice(Math.max(0, i - W + 1), i + 1) : s.base.prefix(i);
      const closeMs = s.base.t[i] + tfMs;
      const dfHtf = tc.use_htf ? s.htf.closedPrefix('1d', closeMs, c.htf_window) : null;
      const [btc, eth] = corrFrames(c.corr, tf, closeMs, df);
      let res;
      try {
        if (live) {
          const extra = { nowSec: t0 + k * c.clock_step, breakoutState };
          res = c.call === 'on_demand'
            ? shared.analyzeOnDemand(s.alias, df, dfHtf, btc, eth, extra)
            : shared.analyze(s.alias, df, dfHtf, btc, eth, extra);
        } else {
          const o = { ...opts, nowSec: closeMs / 1000, breakoutState: new Map() };
          res = c.call === 'on_demand'
            ? L.analyzeOnDemand(s.alias, df, dfHtf, btc, eth, cfg, o)
            : L.analyze(s.alias, df, dfHtf, btc, eth, cfg, o);
        }
      } catch (e) {
        if (!s.errors.has(i)) failures.push(`${s.alias} bar ${i}: engine threw ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
        continue;
      }
      if (s.errors.has(i)) { failures.push(`${s.alias} bar ${i}: the bot raised, the engine returned ${res.signal ? 'a signal' : res.rejectReason}`); continue; }
      const sig = res.signal;
      const exp = s.expected.get(i);
      if (exp && !sig) { failures.push(`${s.alias} bar ${i}: expected a ${exp.direction} "${exp.breakout_type}" signal, engine returned null (${res.rejectReason}/${res.stage}/${res.reason})`); continue; }
      if (!exp && sig) { failures.push(`${s.alias} bar ${i}: unexpected ${sig.direction} "${sig.breakout_type}" signal (bot: ${s.fx.rejects[String(i)]})`); continue; }
      if (!exp) {
        const want = s.fx.rejects[String(i)];
        const got = res.rejectReason != null ? res.rejectReason : 'none';
        if (got !== want) failures.push(`${s.alias} bar ${i}: reject "${got}" (${res.stage}/${res.reason}) != bot "${want}"`);
        continue;
      }
      if (live) shared.markSignal(s.alias, df);
      s.signals++;
      const record = { ...sig, ...L.scannerPostSteps(sig, df, tc.min_quality, { relaxed: c.relaxed }) };
      records.push({ alias: s.alias, src: s.fx.src, i, last: i === s.base.length - 1, record });
      const diffs = compareSignal(record, exp, { ignoreKeys: HARNESS_KEYS, roundedFields: ROUNDED_FIELDS_BY_STRATEGY.levels });
      const hr = { i, open_time_ms: s.base.t[i], n_bars: df.length, n_htf_bars: dfHtf ? dfHtf.length : 0 };
      for (const key of HARNESS_KEYS) if (hr[key] !== exp[key]) diffs.push({ path: `harness.${key}`, actual: hr[key], expected: exp[key], rule: 'harness' });
      if (diffs.length) failures.push(`${s.alias} bar ${i}:\n${formatDiffs(diffs)}`);
    }
    if (failures.length > MAX_FAIL) { failures.push(`… stopping after ${MAX_FAIL} failures`); break; }
  }
  const signals = syms.reduce((a, s) => a + s.signals, 0);
  const want = syms.reduce((a, s) => a + s.fx.n_signals, 0);
  return { failures, bars, signals, want, records };
}

/**
 * describe(title): an integrity test (sha + summary counts, ≥ minCases) and one test per case
 * (LEVELS_PROBE_CASES prefix filter). `extra(getProbe)` may register more tests in the block.
 */
export function defineProbeSuite(stem, { title = stem, minCases = 1, extra = null } = {}) {
  describe(`LEVELS differential probe ${title} (make_levels_probe.py)`, () => {
    if (!fs.existsSync(path.join(GOLDEN, `${stem}.json.gz`))) {
      it.todo(`${stem}.json.gz not generated yet (run tests/golden/make_levels_probe.py with the pinned venv)`);
      return;
    }
    let probe, summary;
    beforeAll(() => { ({ probe, summary } = loadProbe(stem)); });

    it('probe file is intact and the summary counts match', () => {
      expect(Object.keys(probe.cases).length).toBe(summary.cases);
      let signals = 0, bars = 0, nulls = 0, errors = 0;
      for (const c of Object.values(probe.cases)) {
        for (const fx of Object.values(c.fixtures)) {
          signals += fx.n_signals; bars += fx.n_swept; nulls += Object.keys(fx.rejects).length; errors += fx.errors.length;
        }
      }
      expect(signals).toBe(summary.signals);
      expect(bars).toBe(summary.bars);
      expect(nulls).toBe(summary.null_bars);
      expect(errors).toBe(summary.errors);
      expect(summary.cases).toBeGreaterThanOrEqual(minCases);
    });

    if (extra) extra(() => probe);

    const names = Object.keys(loadProbe(stem).probe.cases).filter((n) => !CASE_FILTER || CASE_FILTER.some((f) => n.startsWith(f)));
    for (const name of names) {
      it(name, () => {
        const c = probe.cases[name];
        const res = replayCase(c, probe);
        if (res.failures.length) throw new Error(`${stem} ${name}: ${res.failures.length} failures over ${res.bars} bars\n${res.failures.join('\n')}`);
        expect(res.signals).toBe(res.want);
      }, 120_000);
    }
  });
}
