/**
 * Config parsers every scanner calls per user per cycle, against the bot (py/adv_units.py →
 * fixtures/adv_units.json, CPython 3.11): user_manager._sparse_merge (get_long_cfg /
 * get_short_cfg), TradeCfg.from_json, SMCUserCfg.from_json (get_smc_cfg) and
 * handlers._common._load_sparse — the result, the exception (type + message) and the WARNING
 * lines ("CHM.Users") of each call.
 *
 * Found by the adversarial three-scanner differential (adv_scan.test.js): the site parsed with
 * JSON.parse (no NaN / Infinity), never logged the bot's WARNING for an unparsable override /
 * smc_cfg (the bot logs it on every get_long_cfg / get_smc_cfg call), and read a non-object
 * override JSON as {} where the bot raises AttributeError out of get_long_cfg.
 *
 * Plus smc.signal_builder.calculate_levels around the liquidity-aware stop: the bot logs
 * "[SMC-LIQUIDITY-AWARE-SL] …" at INFO ("CHM.SMC.SignalBuilder") for every adjusted stop, which
 * the pure port never wrote, and `analysis.get("symbol", "").upper()` raises for a None symbol.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const tradeCfg = req('../../../../services/engine/tradeCfg.js');
const smcUserCfg = req('../../../../services/engine/smcUserCfg.js');
const { calculateLevels } = req('../../../../strategies/smc/levels.js');
const { smcConfig } = req('../../../../strategies/smc/config.js');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'adv_units.json'), 'utf8'));

function recorder(name) {
  const lines = [];
  const lg = {
    lines,
    debug() {},
    info(m) { lines.push([name, 'INFO', String(m)]); },
    warning(m) { lines.push([name, 'WARNING', String(m)]); },
    error(m) { lines.push([name, 'ERROR', String(m)]); },
  };
  return lg;
}

const norm = (x) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'number' && !Number.isFinite(v)
  ? { $f: Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf') } : v)));

function run(fn, s, log) {
  log.lines.length = 0;
  let out;
  try {
    out = { ok: norm(fn(s)) };
  } catch (e) {
    out = { error: [e.name, e.message] };
  }
  out.logs = log.lines.slice();
  return out;
}

describe('config parsers vs the bot (adv_units.py)', () => {
  const log = recorder('CHM.Users');
  tradeCfg.setLog(log);
  smcUserCfg.setLog(log);

  it('the fixture covers non-object JSON, NaN / Infinity, unparsable text, legacy and sparse overrides', () => {
    const inputs = FIX.vectors.map((v) => v.input);
    for (const s of ['[1, 2]', 'null', '{bad json', '{"min_rr": NaN, "_sparse": true}', '{"_sparse": false, "rsi_ob": 65, "rsi_os": 30}']) {
      expect(inputs).toContain(s);
    }
    expect(FIX.vectors.some((v) => v.sparse_merge.error && v.sparse_merge.error[0] === 'AttributeError')).toBe(true);
    expect(FIX.vectors.some((v) => v.smc_from_json.logs.length === 1)).toBe(true);
  });

  describe('smc calculate_levels: [SMC-LIQUIDITY-AWARE-SL] line, result, exception', () => {
    const blog = recorder('CHM.SMC.SignalBuilder');
    it('the fixture has adjusted LONG and SHORT stops, a missing and a None symbol', () => {
      const msgs = FIX.levels.flatMap((v) => v.logs.map((l) => l[2]));
      expect(msgs.some((m) => m.includes('dir=LONG') && m.includes('magnet_in_zone_long'))).toBe(true);
      expect(msgs.some((m) => m.includes('dir=SHORT') && m.includes('magnet_in_zone_short'))).toBe(true);
      expect(msgs.some((m) => m.includes('sym=? '))).toBe(true);
      expect(FIX.levels.some((v) => v.error && v.error[0] === 'AttributeError')).toBe(true);
    });
    // the bot's dict keys only (the JS levels carry the extra diagnostic liq_info)
    const botKeys = (got, want) => (got && want ? Object.fromEntries(Object.keys(want).map((k) => [k, got[k]])) : got);
    FIX.levels.forEach((v, i) => {
      it(`case ${i}: ${v.direction} sym=${JSON.stringify(v.analysis.symbol)}`, () => {
        const got = run((a) => botKeys(calculateLevels(a, v.direction, smcConfig(), blog), v.ok), v.analysis, blog);
        expect(got).toEqual({ ...(v.error ? { error: v.error } : { ok: v.ok }), logs: v.logs });
      });
    });
    it('without a logger the port stays silent (golden / backtests)', () => {
      const v = FIX.levels.find((x) => x.logs.length && x.ok);
      blog.lines.length = 0;
      expect(norm(botKeys(calculateLevels(v.analysis, v.direction, smcConfig()), v.ok))).toEqual(v.ok);
      expect(blog.lines).toEqual([]);
    });
  });

  describe('smc analyze: the "CHM.SMC.Analyzer" lines', () => {
    const { analyze } = req('../../../../strategies/smc/analyzer.js');
    it('a failing analysis logs ERROR "{symbol}: SMC analyze error: …" (the text after is the JS exception) and sets error', () => {
      const alog = recorder('CHM.SMC.Analyzer');
      const a = analyze('SYNX-USDT-SWAP', null, null, null, smcConfig(), alog);
      expect(typeof a.error).toBe('string');
      expect(alog.lines.length).toBe(1);
      expect(alog.lines[0].slice(0, 2)).toEqual(['CHM.SMC.Analyzer', 'ERROR']);
      expect(alog.lines[0][2].startsWith('SYNX-USDT-SWAP: SMC analyze error: ')).toBe(true);
    });
    it('silent without a logger (golden / backtests)', () => {
      expect(() => analyze('SYNX-USDT-SWAP', null, null, null, smcConfig())).not.toThrow();
    });
  });

  for (const v of FIX.vectors) {
    describe(`input ${JSON.stringify(v.input)}`, () => {
      it('_sparse_merge(TradeCfg(), s)', () => {
        expect(run((s) => tradeCfg.sparseMerge(tradeCfg.tradeCfg(), s), v.input, log)).toEqual(v.sparse_merge);
      });
      it('TradeCfg.from_json(s)', () => {
        expect(run((s) => tradeCfg.fromJson(s), v.input, log)).toEqual(v.trade_from_json);
      });
      it('SMCUserCfg.from_json(s)', () => {
        expect(run((s) => smcUserCfg.fromJson(s), v.input, log)).toEqual(v.smc_from_json);
      });
      it('_common._load_sparse(s)', () => {
        expect(run((s) => tradeCfg.loadSparse(s), v.input, log)).toEqual(v.load_sparse);
      });
    });
  }
});
