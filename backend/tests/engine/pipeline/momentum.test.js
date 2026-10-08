/**
 * momentumVeto + momentumDetector on Python vectors (fixtures/momentum.json,
 * tools/gen_vectors.py `momentum`):
 *   is_momentum_veto / _compute_atr_pct over 30 synthetic frames (random walks, injected
 *   anti-direction spikes with / without a volume spike, short, flat, zero-volume,
 *   zero-price and NaN frames) × LONG/SHORT/BOTH × six env configurations (module
 *   reloaded per env like the bot's read-once constants);
 *   relax_* in / out of relaxed mode, check_macro_momentum reasons + state + 30 min expiry,
 *   detect_atr_breakout with the shared per-symbol 1 h cooldown.
 *
 *   Python: importlib.reload(momentum_veto); mv.is_momentum_veto(df, "LONG"); md.detect_atr_breakout(sym, df)
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const MV = req('../../../services/engine/momentumVeto.js');
const MD = req('../../../services/engine/momentumDetector.js');
const { load, frameOf, clock, captureLog } = req('./vectors.js');

const V = load('momentum');
const frames = V.frames.map((rows) => frameOf(rows));

describe('momentum veto (bot table)', () => {
  for (const cfg of V.veto) {
    it(`env ${JSON.stringify(cfg.env)}`, () => {
      const v = MV.createMomentumVeto(cfg.env);
      expect({ ENABLED: v.ENABLED, ATR: v.DEFAULT_ATR_MULT, VOL: v.DEFAULT_VOL_MULT, LB: v.DEFAULT_LOOKBACK }).toEqual(cfg.consts);
      for (const [fi, dir, want, atrPct] of cfg.results) {
        const f = fi < 0 ? null : frames[fi];
        expect(v.isMomentumVeto(f, dir), `frame ${fi} ${dir}`).toEqual(want);
        if (f) expect(MV.computeAtrPct(f), `atr frame ${fi}`).toBe(atrPct);
      }
    });
  }
});

describe('momentum detector (bot replay)', () => {
  it('relax_* outside relaxed mode return the original', () => {
    const d = MD.createMomentumDetector({ now: () => 1_800_000_000, log: captureLog() });
    for (const [orig, q, rr, conf, rr22] of V.detector.relax) {
      expect([d.relaxMinQuality(orig), d.relaxMinRr(orig), d.relaxConfirmations(orig), d.relaxMinRr(2.2)]).toEqual([q, rr, conf, rr22]);
    }
  });

  it('check_macro_momentum reasons and state', async () => {
    const c = clock(1_800_000_000.0);
    const d = MD.createMomentumDetector({ now: c.now, log: captureLog() });
    for (const m of V.detector.macro) {
      // the generator resets these three fields between cases (the rest carries over)
      Object.assign(d.getState(), { relaxed: false, relaxed_until: 0.0, trigger_reason: '' });
      const reason = await d.checkMacroMomentum(async () => m.oc);
      expect(reason).toBe(m.reason);
      const st = d.getState();
      expect({ relaxed: st.relaxed, relaxed_until: st.relaxed_until, trigger_symbol: st.trigger_symbol, trigger_reason: st.trigger_reason, btc: st.btc_1h_change, eth: st.eth_1h_change })
        .toEqual(m.state);
      expect(d.isRelaxedMode()).toBe(m.relaxed_now);
    }
  });

  it('relaxed mode expires after 30 min', () => {
    const c = clock(1_800_000_000.0);
    const d = MD.createMomentumDetector({ now: c.now, log: captureLog() });
    d.activateRelaxed('BTC', 'x');
    for (const [dt, relaxed, q] of V.detector.expiry) {
      c.t = 1_800_000_000.0 + dt;
      expect([d.isRelaxedMode(), d.relaxMinQuality(4)]).toEqual([relaxed, q]);
    }
  });

  it('detect_atr_breakout with the shared cooldown map', () => {
    const c = clock(1_800_000_000.0);
    const d = MD.createMomentumDetector({ now: c.now, log: captureLog() });
    for (const b of V.detector.breakout) {
      c.t = b.now;
      expect(d.detectAtrBreakout(b.symbol, frameOf(V.breakout_frames[b.frame])), `frame ${b.frame}`).toEqual(b.result);
    }
    const o = d.levelsOpts();
    expect(o.relaxed).toBe(false);
    expect(o.breakoutState instanceof Map).toBe(true);
    expect(o.breakoutState.size).toBeGreaterThan(0);
  });
});
