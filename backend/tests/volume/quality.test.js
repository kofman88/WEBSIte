/**
 * [VOL-MIN-SL] / [VOL-MIN-VOLUME] 2026-10 (bot batch D) — strategies/volume/quality.js and the
 * config / signal paths that use it, against pins.quality: the bot's own volume_strategy.py /
 * volume_scanner.py on the same inputs (tests/volume/gen/gen_pins.py quality_pins). Every case runs
 * in a fresh "process" (the once-per-value WARNING / floor-log sets cleared) with exactly the env
 * the generator set, and must emit the same log lines (logger CHM.VolumeStrategy).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import V from '../../strategies/volume/index.js';
import F from './frames.js';
import P from './pins.js';

const Q = V.quality;   // the instance the engine modules require (not a second ESM copy)

const { pins, pinNum, assertSame } = P;
const QP = pins.quality;

/** A pinned env value ("=" + raw, null = unset) → the env object of that case. */
const envOf = (key, pinned) => (pinned === null || pinned === undefined ? {} : { [key]: String(pinned).slice(1) });

let lines = [];
const cap = {
  debug() {},
  info(m) { lines.push(['INFO', 'CHM.VolumeStrategy', String(m)]); },
  warning(m) { lines.push(['WARNING', 'CHM.VolumeStrategy', String(m)]); },
  warn(m) { lines.push(['WARNING', 'CHM.VolumeStrategy', String(m)]); },
  error(m) { lines.push(['ERROR', 'CHM.VolumeStrategy', String(m)]); },
};

/** env_ctx of the generator: the given env only, a fresh process state, an empty capture. */
function fresh(env) {
  Q.setEnv(env);
  Q._resetForTests();
  lines = [];
}

beforeEach(() => { Q.setLog(cap); });
afterAll(() => { Q.setEnv(null); Q.setLog(null); Q._resetForTests(); });

// Pinned params: the repr()-ed floats came back as numbers, nan / inf as the strings 'nan' / 'inf' — float()
// of either is the same value, so they are passed as they are.

describe('env_number / setup_vol_floor / golden_vol_min (VOLUME_MIN_SETUP_VOL_MULT)', () => {
  it(`${QP.env.length} raw env values: value, one WARNING per value, floor, golden, the floored defaults, logs`, () => {
    for (const row of QP.env) {
      fresh(envOf('VOLUME_MIN_SETUP_VOL_MULT', row.raw));
      const a = Q.envNumber('VOLUME_MIN_SETUP_VOL_MULT', '[VOL-MIN-VOLUME]');
      const b = Q.envNumber('VOLUME_MIN_SETUP_VOL_MULT', '[VOL-MIN-VOLUME]');
      // pins.json is JSON: the bot's -0.0 (raw "-0") is stored as 0
      const z = (x) => (x === 0 ? 0 : x);
      const got = { env_number: z(a), again: z(b), floor: Q.setupVolFloor(), golden: Q.goldenVolMin() };
      const cfg = new V.VolumeConfig();
      got.default_cfg = [cfg.bounce_vol_mult, cfg.ribbon_vol_mult];
      assertSame(got, { env_number: row.env_number, again: row.again, floor: row.floor, golden: row.golden, default_cfg: row.default_cfg }, `raw ${row.raw}`);
      expect(lines, `raw ${row.raw}`).toEqual(row.logs);
    }
  });
});

describe('VolumeConfig under the [VOL-MIN-VOLUME] floor', () => {
  it(`from_params: ${QP.from_params.length} cases × env (default / 2.0 / 0 / abc) — floored fields, min_sl_pct_15m _fix, golden threshold, logs`, () => {
    for (const row of QP.from_params) {
      fresh(envOf('VOLUME_MIN_SETUP_VOL_MULT', row.env));
      const cfg = V.VolumeConfig.fromParams(row.params);
      const got = { bounce_vol_mult: cfg.bounce_vol_mult, ribbon_vol_mult: cfg.ribbon_vol_mult, min_sl_pct_15m: cfg.min_sl_pct_15m };
      const where = `env ${row.env} ${JSON.stringify(row.params)}`;
      assertSame(got, Object.fromEntries(Object.entries(row.cfg).map(([k, v]) => [k, pinNum(v)])), where);
      // min([vol_mult] + [bounce if setup_bounce] + [golden_vol_min(), ribbon]) — Python min() order
      const th = [cfg.vol_mult].concat(cfg.setup_bounce ? [cfg.bounce_vol_mult] : [], [Q.goldenVolMin(), cfg.ribbon_vol_mult]);
      let m = th[0];
      for (const x of th.slice(1)) if (x < m) m = x;
      assertSame(m, pinNum(row.mask_min), `${where} mask`);
      expect(lines, where).toEqual(row.logs);
    }
  });

  it('__init__ / dataclasses.replace apply the floor (__post_init__); a non-number field is left alone', () => {
    for (const row of QP.ctor) {
      fresh(envOf('VOLUME_MIN_SETUP_VOL_MULT', row.env));
      const c1 = new V.VolumeConfig({ bounce_vol_mult: 0.7, ribbon_vol_mult: 3.0 });
      const c2 = c1.replace({ min_quality: 2 });
      const c3 = new V.VolumeConfig({ bounce_vol_mult: 2, ribbon_vol_mult: 'x' });
      assertSame([c1.bounce_vol_mult, c1.ribbon_vol_mult], row.init, `init ${row.env}`);
      assertSame([c2.bounce_vol_mult, c2.ribbon_vol_mult, c2.min_quality], row.replace, `replace ${row.env}`);
      assertSame([c3.bounce_vol_mult, c3.ribbon_vol_mult], row.init_types, `types ${row.env}`);
      expect(lines).toEqual(row.logs);
    }
  });

  it('volume_scanner._unfloored_vol_values: bounce ≥ 0.3, ribbon as is, missing / not a number / non-finite → 1.0', () => {
    for (const row of QP.unfloored) {
      assertSame(V.unflooredVolValues(row.params), row.out, JSON.stringify(row.params));
    }
  });

  it('math.isclose (rel_tol 1e-9): the round-trip comparison of the kv rule', () => {
    for (const [a, b, want] of QP.isclose) expect(Q.pyIsclose(pinNum(a), pinNum(b)), `${a} ~ ${b}`).toBe(want);
  });
});

describe('[VOL-MIN-SL] min_sl_pct_for and the stop floor inside signal_at', () => {
  it(`min_sl_pct_for: ${QP.min_sl_pct_for.length} (env × field × timeframe) combinations, with the env WARNING`, () => {
    for (const row of QP.min_sl_pct_for) {
      fresh(envOf('VOLUME_MIN_SL_PCT_15M', row.env));
      const cfg = new V.VolumeConfig();
      cfg.min_sl_pct_15m = pinNum(row.field);
      const where = `env ${row.env} field ${row.field} tf ${JSON.stringify(row.tf)}`;
      assertSame(Q.minSlPctFor(cfg, row.tf), row.v, where);
      expect(lines, where).toEqual(row.logs);
    }
  });

  it(`signal_at: ${QP.stop_floor.length} sweeps — 15m widens the stop (≤ max_sl_pct, env over the field), TPs keep their R, 1h / 4h untouched, sl_raw_pct`, () => {
    let widened = 0;
    for (const row of QP.stop_floor) {
      fresh(envOf('VOLUME_MIN_SL_PCT_15M', row.env));
      const cfg = V.VolumeConfig.fromParams(row.params);
      const ctx = new V.VolumeContext(F.SCENARIOS[row.scenario](), cfg);
      const out = [];
      for (let i = 0; i < ctx.n; i++) {
        const sg = V.signalAt(ctx, i, 'TEST', row.tf);
        if (sg) out.push({ i, ...sg.toDict(), tp: sg.tp, risk_pct: sg.risk_pct });
      }
      const where = `${row.scenario} ${JSON.stringify(row.params)} env ${row.env} ${row.tf}`;
      assertSame(out, row.signals, where);
      expect(lines, where).toEqual(row.logs);
      widened += out.filter((x) => x.sl_raw_pct > 0).length;
    }
    expect(widened).toBeGreaterThan(20);
  });

  it('the widened 15m stop: exactly 1 % (or max_sl_pct), same entry / quality / reasons as 1h, TP distances = R multiples', () => {
    const rows = QP.stop_floor.filter((r) => r.scenario === 'bounce_long_hammer_hi' && r.env === null && Object.keys(r.params).length === 0);
    const s15 = rows.find((r) => r.tf === '15m').signals[0];
    const s1h = rows.find((r) => r.tf === '1h').signals[0];
    expect(s15.sl_raw_pct).toBe(0.4337);
    expect(s1h.sl_raw_pct).toBe(0.0);
    expect(Math.abs(s15.risk_pct - 1.0)).toBeLessThan(1e-9);
    expect(s15.entry).toBe(s1h.entry);
    expect(s15.quality).toBe(s1h.quality);
    expect(s15.reasons).toEqual(s1h.reasons);
    const r = s15.entry - s15.sl;
    expect(Math.abs((s15.tp2 - s15.entry) / r - 2.0)).toBeLessThan(1e-9);
    expect(Math.abs((s15.tp3 - s15.entry) / r - 3.0)).toBeLessThan(1e-9);
  });
});
