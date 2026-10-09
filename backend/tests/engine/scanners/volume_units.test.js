/**
 * VOLUME scanner unit-level differential (py/volume_units.py → volume_fixtures/units.json.gz):
 * the bot's real dedup_ttl_s / user_tf / group key / bar keys, load_user_cfg over 19 raw kv
 * values (coercions, _fix, falsy and non-dict JSON, json.loads errors), save_user_cfg /
 * reset_user_cfg (keep_prefs), gc_sent, the WS wake event and run_volume_scanner (error
 * backoff, wake, timeout, cancellation) — replayed on the JS volumeScanner.
 *
 *   Python: cd <bot> && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> \
 *           <site>/backend/tests/engine/scanners/py/volume_units.py
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const H = req('./levels_harness.js');
const VS = req('../../../services/engine/volumeScanner.js');
const LS = req('../../../services/engine/levelsScanner.js');
const { VolumeConfig } = req('../../../strategies/volume');
const FIX = H.loadFixture(path.join(__dirname, 'volume_fixtures', 'units.json.gz'));
const E = FIX.out;

function makeScanner(extra = {}) {
  const clock = new H.Clock(FIX.t0);
  const cap = H.logCapture();
  const kv = H.memKv();
  const s = VS.createVolumeScanner({ clock, kv, log: cap.make('CHM.VolumeScanner'), sleep: async () => {}, ...extra(clock) });
  return { s, clock, cap, kv };
}

describe('volume_scanner units vs the bot (volume_units.py)', () => {
  it('dedup_ttl_s: 4 bars of the TF, at least 1 h (unknown TF → 1 h basis)', () => {
    for (const [tf, v] of Object.entries(E.dedup_ttl)) expect(VS.dedupTtlS(tf)).toBe(v);
  });

  it('user_tf: vol_timeframe lower-cased when 15m / 1h / 4h, else 1h', () => {
    for (const [v, want] of E.user_tf) expect(VS.userTf(v === null ? { vol_timeframe: null } : { vol_timeframe: v })).toBe(want);
  });

  it('group key json.dumps(cfg.to_dict(), sort_keys=True) and the kv json.dumps(cfg.to_dict())', () => {
    for (const c of E.cfg_keys) {
      const cfg = VolumeConfig.fromParams(JSON.parse(c.raw));
      expect(VS.cfgKey(cfg)).toBe(c.key);
      expect(VS.cfgJson(cfg)).toBe(c.json);
    }
  });

  it('bar key = str(df.index[-1]) of the closed frame', () => {
    for (const [sym, tf, ms, str] of E.bar_ts) {
      const f = H.frameAt(sym, tf, FIX.t0, 300);
      expect(f.t[f.length - 1]).toBe(ms);
      expect(VS.barTs(f)).toBe(str);
    }
  });

  it('load_user_cfg: coercions, _fix, falsy JSON → defaults, non-dict JSON / bad JSON → [VOLUME-CFG] warning + defaults', async () => {
    const { s, cap, kv } = makeScanner(() => ({}));
    for (const c of E.load) {
      kv.set(VS.KV_CFG_PREFIX + String(c.uid), c.raw);
      const n0 = cap.lines.length;
      const cfg = await s.loadUserCfg(c.uid);
      expect(H.norm(cfg.toDict())).toEqual(c.cfg);
      expect(cap.lines.slice(n0)).toEqual(c.logs);
    }
  });

  it('save_user_cfg: the switches missing from params come from the current cfg (keep_prefs)', async () => {
    const { s, cap, kv } = makeScanner(() => ({}));
    for (const c of E.save) {
      if (c.pre !== null) kv.set(VS.KV_CFG_PREFIX + String(c.uid), c.pre);
      const n0 = cap.lines.length;
      await s.saveUserCfg(c.uid, c.params, c.keep);
      expect(kv.get(VS.KV_CFG_PREFIX + String(c.uid))).toBe(c.kv);
      expect(cap.lines.slice(n0)).toEqual(c.logs);
    }
  });

  it('reset_user_cfg: kv deleted, non-default switches re-saved when keep_prefs', async () => {
    const { s, cap, kv } = makeScanner(() => ({}));
    for (const c of E.reset) {
      if (c.pre !== null) kv.set(VS.KV_CFG_PREFIX + String(c.uid), c.pre);
      const n0 = cap.lines.length;
      await s.resetUserCfg(c.uid, c.keep);
      expect(kv.get(VS.KV_CFG_PREFIX + String(c.uid))).toBe(c.kv);
      expect(cap.lines.slice(n0)).toEqual(c.logs);
    }
  });

  it('gc_sent: _sent_bars older than 24 h (strict) and HTF frames older than 180 s (strict) dropped', () => {
    const { s } = makeScanner(() => ({}));
    const t0 = FIX.t0;
    const df = H.frameAt('BTC-USDT-SWAP', '4h', t0, 60);
    for (const [k, ts] of [['1|A|LONG|x', t0 - 10], ['2|B|SHORT|y', t0 - 86400 - 1], ['3|C|LONG|z', t0 - 86400], ['4|D|LONG|w', t0 - 90000]]) s._sentBars.set(k, ts);
    for (const [k, ts] of [['A|4h', t0 - 179], ['B|1d', t0 - 181], ['C|4h', t0 - 180]]) s._htfCache.set(k, [ts, df]);
    expect(s.gcSent()).toBe(E.gc.ret);
    expect(Object.fromEntries(s._sentBars)).toEqual(E.gc.sent_bars);
    expect(Array.from(s._htfCache.keys()).sort()).toEqual(E.gc.htf);
  });

  it('_on_ws_bar_close: only the cache TF names (15m / 1H / 4H / 1D) set the wake event', async () => {
    const { s } = makeScanner(() => ({}));
    for (const [tf, set] of E.wake) {
      s._wakeEvent().clear();
      await s._onWsBarClose('BTC-USDT-SWAP', tf);
      expect(s._wakeEvent().isSet()).toBe(set);
    }
  });

  it('run_volume_scanner: backoff 10 → 20 s, heartbeat, wake / interval sleep, timeout keeps the error count, cancel stops', async () => {
    const L = E.loop;
    const sleeps = [];
    const waits = [];
    const beats = [];
    const registered = [];
    let pi = 0;
    let armed = false;
    let scanner;
    const { s, clock, cap } = makeScanner((clk) => ({
      sleep: async (ms) => { sleeps.push(ms / 1000); clk.t += ms / 1000; },
      timers: {
        setTimeout: (fn, ms) => {
          if (ms === VS.CYCLE_TIMEOUT_S * 1000) {
            if (!armed) return 0;
            armed = false;
            Promise.resolve().then(() => { clk.t += ms / 1000; fn(); });
            return 1;
          }
          // the wake-or-interval wait: the interval elapses unless the event is already set
          waits.push([ms / 1000, scanner._wakeEvent().isSet()]);
          Promise.resolve().then(() => { clk.t += ms / 1000; fn(); });
          return 2;
        },
        clearTimeout: () => {},
      },
      wsFeed: { registerOnBarClose: (cb) => registered.push(cb ? '_on_ws_bar_close' : '?') },
    }));
    scanner = s;
    // the bot's evt.wait() with the event already set returns before any timer is armed
    const realWake = s._wakeEvent;
    s._wakeEvent = () => {
      const evt = realWake();
      if (!evt.__wrapped) {
        const wait = evt.wait.bind(evt);
        evt.wait = (timeoutS) => { if (evt.isSet()) waits.push([timeoutS, true]); return wait(timeoutS); };
        evt.__wrapped = true;
      }
      return evt;
    };
    s._scanCycle = async () => {
      const step = L.plan[pi++];
      if (step === 'ok' || step === 'ok_wake') {
        clock.t += 4.0;
        if (step === 'ok_wake') await s._onWsBarClose('BTC-USDT-SWAP', '1H');
        return;
      }
      if (step === 'raise') { clock.t += 1.0; throw new Error('boom'); }
      if (step === 'timeout') { armed = true; await new Promise(() => {}); }
      if (step === 'cancel') throw new LS.CancelledError();
    };
    clock.t = L.start;
    await s.runVolumeScanner(null, null, null, { health: { heartbeat: (n) => beats.push(n) }, intervalSec: 60 });
    expect(sleeps).toEqual(L.sleeps);
    expect(waits).toEqual(L.waits);
    expect(beats).toEqual(L.beats);
    expect(registered).toEqual(L.registered);
    expect(cap.lines).toEqual(L.logs);
    expect(clock.t).toBe(L.end);
    expect(s._wakeEvent().isSet()).toBe(L.wake_set);
  });
});
