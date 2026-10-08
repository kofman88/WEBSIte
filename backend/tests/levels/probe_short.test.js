/**
 * probe_short.test.js — `_do_analyze(..., _precomputed_zones=)` (the backtest path, no length
 * guard) on 1..60-bar frames vs the bot (tests/golden/levels_probe_short.json.gz,
 * `make_levels_probe.py --suite short`).
 *
 * 3000 frames cut from the fixtures (1h / 15m / 4h) and the hand-constructed setup frames; the
 * zones were precomputed by the bot on the 300 bars ending at the same bar (public fields only,
 * no lvn_checker). Five configs (design / defaults + prod gates / LEVELS_RELAX / HIGH_WR /
 * volume + RSI filters), min_quality_override None or 1. Every case must agree: the SignalResult,
 * the _ANALYZE_STATS bucket, or a throw where the bot raised (IndexError: `df.iloc[-7]` in the
 * approach check on 6 bars, `df["close"].iloc[-2]` in the breakout / breakdown check on 1 bar).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import load from '../golden/load.js';
import compare from '../golden/compare.js';
import { Frame } from '../../strategies/common/frame.js';
import L from '../../strategies/levels/index.js';
import { GOLDEN } from './probeReplay.js';

const STEM = 'levels_probe_short';
const FILE = path.join(GOLDEN, `${STEM}.json.gz`);
const { compareSignal, formatDiffs, ROUNDED_FIELDS_BY_STRATEGY } = compare;

describe('LEVELS _do_analyze on 1..60-bar frames with precomputed zones (make_levels_probe.py --suite short)', () => {
  if (!fs.existsSync(FILE)) {
    it.todo(`${STEM}.json.gz not generated yet`);
    return;
  }
  const raw = zlib.gunzipSync(fs.readFileSync(FILE));
  const summary = JSON.parse(fs.readFileSync(path.join(GOLDEN, `${STEM}_summary.json`), 'utf8'));
  const doc = JSON.parse(raw.toString('utf8'));
  const frames = new Map();
  const frameOf = (src, tf) => {
    const k = `${src}_${tf}`;
    if (!frames.has(k)) frames.set(k, doc.frames[src] ? Frame.fromBars(doc.frames[src].bars) : load.loadFrame(src, tf));
    return frames.get(k);
  };

  it('fuzz file is intact and covers signals, rejects and exceptions', () => {
    expect(load.sha256(raw)).toBe(summary.sha256[`${STEM}.json`]);
    expect(doc.cases.length).toBe(summary.cases);
    expect(doc.cases.some((c) => c.error === 'IndexError')).toBe(true);
    expect(doc.cases.filter((c) => c.signal).length).toBeGreaterThan(100);
  });

  it('every case agrees with the bot', () => {
    const failures = [];
    doc.cases.forEach((c, n) => {
      const spec = doc.cfgs[c.cfg];
      const tc = L.tradeCfg({ ...spec.trade_cfg, timeframe: c.tf });
      const cfg = L.cfgToInd(tc, spec.high_wr, spec.env);
      const base = frameOf(c.src, c.tf);
      const df = base.slice(c.i - c.m + 1, c.i + 1);
      const label = `#${n} ${c.src} ${c.tf} i=${c.i} m=${c.m} ${c.cfg} mqo=${c.min_quality_override}`;
      let res;
      try {
        res = L.doAnalyze(c.src, df, null, null, null, cfg, {
          precomputedZones: { sup: c.zones.sup.map((z) => ({ ...z })), res: c.zones.res.map((z) => ({ ...z })) },
          env: spec.env, minQualityOverride: c.min_quality_override,
        });
      } catch (e) {
        if (c.error !== (e && e.name)) failures.push(`${label}: engine threw ${e && e.name}: ${e && e.message} (bot: ${c.error || c.reject || 'signal'})`);
        return;
      }
      if (c.error) { failures.push(`${label}: the bot raised ${c.error}, the engine returned ${res.signal ? 'a signal' : res.rejectReason}`); return; }
      if (c.signal && !res.signal) { failures.push(`${label}: expected "${c.signal.breakout_type}", engine rejected ${res.rejectReason}/${res.stage}`); return; }
      if (!c.signal && res.signal) { failures.push(`${label}: unexpected "${res.signal.breakout_type}" (bot: ${c.reject})`); return; }
      if (!c.signal) {
        const got = res.rejectReason != null ? res.rejectReason : 'none';
        if (got !== c.reject) failures.push(`${label}: reject ${got} (${res.stage}) != bot ${c.reject}`);
        return;
      }
      const diffs = compareSignal(res.signal, c.signal, { roundedFields: ROUNDED_FIELDS_BY_STRATEGY.levels });
      if (diffs.length) failures.push(`${label}:\n${formatDiffs(diffs)}`);
    });
    if (failures.length) throw new Error(`${failures.length}/${doc.cases.length} mismatches\n${failures.slice(0, 30).join('\n')}`);
  }, 120_000);
});
