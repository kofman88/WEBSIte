/**
 * VOLUME scanner unit-level differential (py/volume_units.py → volume_fixtures/units.json.gz):
 * the bot's real dedup_ttl_s / user_tf / group key / bar keys, load_user_cfg over 19 raw kv
 * values (coercions, _fix, falsy and non-dict JSON, json.loads errors), save_user_cfg /
 * reset_user_cfg (keep_prefs), gc_sent, the WS wake event and run_volume_scanner (error
 * backoff, wake, timeout, cancellation) — replayed on the JS volumeScanner; and the batch-D rules
 * (2026-10): [VOL-LIQ-15M] coins_floor_for_tf / coins_for_tf, [VOL-POST-SL-PAUSE] post_sl_pause_bars /
 * _sl_end_ts / post_sl_pause_active over the same seeded trades rows (here signal_trades), the
 * failing query, gc_sent of _pause_logged, and the [VOL-MIN-VOLUME] save_user_cfg storage /
 * round-trip rule.
 *
 *   Python: cd <bot> && BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <py311> \
 *           <site>/backend/tests/engine/scanners/py/volume_units.py
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const H = req('./levels_harness.js');
const VS = req('../../../services/engine/volumeScanner.js');
const LS = req('../../../services/engine/levelsScanner.js');
const V = req('../../../strategies/volume');
const { VolumeConfig } = V;
const FIX = H.loadFixture(path.join(__dirname, 'volume_fixtures', 'units.json.gz'));
const E = FIX.out;
const Q = V.quality;

function makeScanner(extra = {}) {
  const clock = new H.Clock(FIX.t0);
  const cap = H.logCapture();
  const kv = H.memKv();
  const s = VS.createVolumeScanner({ clock, kv, log: cap.make('CHM.VolumeScanner'), sleep: async () => {}, ...extra(clock) });
  Q.setLog(cap.make('CHM.VolumeStrategy'));   // volume_strategy's logger ([VOL-MIN-VOLUME] / env warnings)
  return { s, clock, cap, kv };
}

// one bot process for the whole file (the once-per-value log sets), the batch-D env at its defaults
beforeAll(() => { Q.setEnv({}); Q._resetForTests(); });

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
    s._scanCycle = async (_b, _u, _f, token) => {
      const step = L.plan[pi++];
      if (step === 'ok' || step === 'ok_wake') {
        clock.t += 4.0;
        if (step === 'ok_wake') await s._onWsBarClose('BTC-USDT-SWAP', '1H');
        return;
      }
      if (step === 'raise') { clock.t += 1.0; throw new Error('boom'); }
      // a hung cycle: it ends only when wait_for cancels it (CancelledError at its checkpoint)
      if (step === 'timeout') { armed = true; await new Promise((_r, rej) => token.on(() => rej(new LS.CancelledError()))); }
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

// ── batch D (2026-10) ─────────────────────────────────────────────────────────────────────────
const D = E.batch_d;
/** levels_fakes.enc → JS values ({"$f": "nan"} → NaN). */
const dec = (x) => {
  if (Array.isArray(x)) return x.map(dec);
  if (x && typeof x === 'object') {
    if (Object.keys(x).length === 1 && typeof x.$f === 'string') return x.$f === 'nan' ? NaN : (x.$f === 'inf' ? Infinity : -Infinity);
    return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, dec(v)]));
  }
  return x;
};
/** The generator's fresh(**env): the given env only and a fresh process state. */
function fresh(env = {}) {
  const e = {};
  for (const [k, v] of Object.entries(env)) if (v !== null && v !== undefined) e[k] = v;
  Q.setEnv(e);
  Q._resetForTests();
}

describe('[VOL-LIQ-15M] coins_floor_for_tf / coins_for_tf vs the bot', () => {
  it(`coins_floor_for_tf: ${D.coins_floor.length} env × TF combinations (env warning once)`, () => {
    const { cap } = makeScanner(() => ({}));
    for (const r of D.coins_floor) {
      fresh({ VOLUME_15M_COINS_FLOOR_USDT: r.env });
      const n0 = cap.lines.length;
      expect(VS.coinsFloorForTf(r.tf), `${r.env} ${r.tf}`).toBe(r.v);
      expect(cap.lines.slice(n0)).toEqual(r.logs);
    }
  });
  it(`coins_for_tf: ${D.coins_for_tf.length} cases — order kept, unknown / NaN / non-number volume dropped, the INFO / WARNING lines`, () => {
    const { cap } = makeScanner(() => ({}));
    const L = cap.make('CHM.VolumeScanner');
    for (const r of D.coins_for_tf) {
      fresh({ VOLUME_15M_COINS_FLOOR_USDT: r.env });
      const n0 = cap.lines.length;
      const vmap = dec(D.vmaps[r.vmap]);
      expect(VS.coinsForTf(r.coins, r.tf, vmap, L), `${r.vmap} ${r.tf} ${r.env} ${r.coins}`).toEqual(r.out);
      expect(cap.lines.slice(n0)).toEqual(r.logs);
    }
    expect(D.coins_for_tf.some((r) => r.logs.some((l) => l[2].includes('no 24h volume data')))).toBe(true);
  });
});

describe('[VOL-POST-SL-PAUSE] vs the bot (same seeded rows)', () => {
  const Database = req('better-sqlite3');
  const { signalTradesDDL } = req('../../../models/engineSchema.js');
  const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo.js');
  const COLS = ['trade_id', 'user_id', 'symbol', 'direction', 'strategy', 'timeframe', 'created_at', 'signal_msg_id',
    'order_id', 'progress_stage', 'progress_ts', 'result', 'state_changed_at'];
  function seededRepo() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(signalTradesDDL());
    const ins = db.prepare(`INSERT INTO signal_trades (${COLS.join(', ')}, entry, sl, tp1, tp2, tp3) VALUES (${COLS.map(() => '?').join(', ')}, 100.0, 99.0, 101.0, 102.0, 103.0)`);
    for (const r of D.pause_rows) ins.run(...r);
    return createSignalTradesRepo({ db, now: () => FIX.t0, onClosed: null });
  }

  it('post_sl_pause_bars (env) and _sl_end_ts (progress_ts → state_changed_at → created_at)', () => {
    const { cap } = makeScanner(() => ({}));
    for (const r of D.pause_bars) {
      fresh({ VOLUME_POST_SL_PAUSE_BARS: r.env });
      const n0 = cap.lines.length;
      expect(VS.postSlPauseBars(), String(r.env)).toBe(r.v);
      expect(cap.lines.slice(n0)).toEqual(r.logs);
    }
    for (const r of D.sl_end) expect(VS.slEndTs(r.row), JSON.stringify(r.row)).toBe(r.v);
  });

  it(`post_sl_pause_active: ${D.pause.length} queries — 7 vs 9 bars, other direction / user / strategy, BE / TP3 / TP1 previous, latest delivered decides, exchange SL, 1h / 4h, env`, async () => {
    const repo = seededRepo();
    const { s, cap } = makeScanner(() => ({ repo }));
    for (const r of D.pause) {
      const [uid, sym, dir, tf, env] = r.q;
      fresh({ VOLUME_POST_SL_PAUSE_BARS: env });
      const n0 = cap.lines.length;
      const got = await s.postSlPauseActive(uid, sym, dir, tf, FIX.t0);
      expect(got, JSON.stringify(r.q)).toEqual([r.paused, r.why]);
      expect(cap.lines.slice(n0)).toEqual(r.logs);
      expect(repo.lastSignalOutcome(uid, sym, dir, 'VOLUME'), JSON.stringify(r.q)).toEqual(r.row);
    }
    expect(D.pause.filter((r) => r.paused).length).toBeGreaterThan(10);
    expect(D.pause.filter((r) => !r.paused).length).toBeGreaterThan(10);
  });

  it('a failing query → allowed + one WARNING (fail-open)', async () => {
    const boom = new Error('database is locked');
    boom.name = 'RuntimeError';
    const { s, cap } = makeScanner(() => ({ repo: { lastSignalOutcome() { throw boom; } } }));
    fresh();
    const got = await s.postSlPauseActive(7001, 'BTC-USDT-SWAP', 'LONG', '15m', FIX.t0);
    expect(got).toEqual([D.pause_error.paused, D.pause_error.why]);
    expect(cap.lines).toEqual(D.pause_error.logs);
  });

  it('gc_sent drops _pause_logged entries older than 24 h (both key kinds)', () => {
    const { s, clock } = makeScanner(() => ({}));
    clock.t = FIX.t0;
    const t0 = FIX.t0;
    for (const [k, ts] of [['1|A|LONG|x', t0 - 10], ['2|B|SHORT|y', t0 - 86400 - 1], ['min_sl|C|LONG|15m|z', t0 - 86400], ['min_sl|D|SHORT|15m|w', t0 - 90000]]) {
      s._pauseLogged.set(k, ts);
    }
    expect(s.gcSent()).toBe(D.gc_pause.ret);
    expect(Array.from(s._pauseLogged.keys()).sort()).toEqual(D.gc_pause.left);
  });
});

describe('[VOL-MIN-VOLUME] save_user_cfg: kv keeps the pre-floor values (round-trip rule) vs the bot', () => {
  it(`${D.save_steps.length} steps: HTF / setup toggles over kv 0.8, no kv row, genome partial, explicit values, unreadable kv, floor off, env 2.0, min_sl_pct_15m never stored`, async () => {
    let raiseMsg = null;
    const { s, cap, kv } = makeScanner(() => ({}));
    const realGet = kv.get;
    kv.get = (k) => { if (raiseMsg) throw new Error(raiseMsg); return realGet(k); };
    fresh();
    const FULL = new VolumeConfig().toDict();   // a full to_dict() (the floored defaults)
    const argOf = (st) => {
      if (st.label.startsWith('explicit full dict ribbon')) return { ...FULL, ribbon_vol_mult: 2.0 };
      if (st.label.startsWith('explicit full dict exactly')) return { ...FULL, bounce_vol_mult: 1.5 };
      if (st.label.startsWith('kv unreadable') || st.label.startsWith('bad json')) return { ...FULL };
      if (st.label.startsWith('floor off: no kv read')) return { ...FULL, bounce_vol_mult: 1.5 };
      if (st.label.startsWith('full dict without')) { const d = { ...FULL }; delete d.min_sl_pct_15m; return d; }
      return st.arg;
    };
    for (const st of D.save_steps) {
      fresh({ VOLUME_MIN_SETUP_VOL_MULT: st.env });
      const n0 = cap.lines.length;
      const key = VS.KV_CFG_PREFIX + String(st.uid);
      if (st.pre !== '__keep__') {
        if (st.pre === null) kv.delete(key);
        else kv.set(key, st.pre);
      }
      raiseMsg = st.kv_raise;
      try {
        if (st.op === 'toggle') {
          const d = (await s.loadUserCfg(st.uid)).toDict();
          Object.assign(d, st.arg);
          await s.saveUserCfg(st.uid, d);
        } else if (st.op === 'save') {
          await s.saveUserCfg(st.uid, { ...argOf(st) });
        } else if (st.op === 'reset') {
          await s.resetUserCfg(st.uid);
        }
      } finally {
        raiseMsg = null;
      }
      const cfg = await s.loadUserCfg(st.uid);
      expect(kv.get(key), st.label).toBe(st.kv);
      expect([cfg.bounce_vol_mult, cfg.ribbon_vol_mult], st.label).toEqual(st.eff);
      expect(cap.lines.slice(n0), st.label).toEqual(st.logs);
    }
    expect(V.FIELD_NAMES.slice().sort()).toEqual(D.config_fields);
  });
});
