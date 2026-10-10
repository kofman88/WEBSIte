/**
 * [VOL-MIN-VOLUME 2026-10] the settings-side VOLUME kv (services/volumeUserCfg.js — Mini App settings/all,
 * profiles, genome apply, reset) against the bot's volume_scanner.save_user_cfg: the same 19 steps the
 * scanner-side replay runs (tests/engine/scanners/py/volume_units.py → units.json.gz `batch_d.save_steps`,
 * produced by the bot at c56653d). kv keeps the user's / genome's pre-floor values across load → to_dict →
 * change → save round trips, the effective config is floored, env 0 restores the stored values,
 * min_sl_pct_15m is never stored. The effective config and the kv text must be the bot's.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

process.env.NODE_ENV = 'development';
process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.DATABASE_PATH = path.join(process.cwd(), 'data', 'test-volume-user-cfg-bd.db');
process.env.DB_QUIET = '1';
process.env.LOG_LEVEL = 'error';
process.env.VITEST = 'true';

const req = createRequire(import.meta.url);
const H = req('./engine/scanners/levels_harness.js');
const FIX = H.loadFixture(path.join(__dirname, 'engine', 'scanners', 'volume_fixtures', 'units.json.gz'));
const STEPS = FIX.out.batch_d.save_steps;

let db, vuc, kv, shim, Q;

beforeAll(() => {
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* */ } });
  // the native-require instances the services use
  db = req('../models/database.js');
  vuc = req('../services/volumeUserCfg.js');
  kv = req('../services/engineKvService.js');
  shim = req('../services/engine/volumeCfgShim.js');
  Q = req('../strategies/volume').quality;
});

beforeEach(() => {
  db.prepare('DELETE FROM engine_kv').run();
  Q.setEnv({});
  Q._resetForTests();
});

describe('volumeUserCfg.saveUserCfg — the bot\'s kv storage / round-trip rule', () => {
  it(`${STEPS.length} steps (the scanner replay's): the same kv text and effective bounce / ribbon as the bot`, () => {
    const FULL = shim.toDict(shim.defaults());   // a full to_dict() (the floored defaults)
    const argOf = (st) => {
      if (st.label.startsWith('explicit full dict ribbon')) return { ...FULL, ribbon_vol_mult: 2.0 };
      if (st.label.startsWith('explicit full dict exactly')) return { ...FULL, bounce_vol_mult: 1.5 };
      if (st.label.startsWith('kv unreadable') || st.label.startsWith('bad json')) return { ...FULL };
      if (st.label.startsWith('floor off: no kv read')) return { ...FULL, bounce_vol_mult: 1.5 };
      if (st.label.startsWith('full dict without')) { const d = { ...FULL }; delete d.min_sl_pct_15m; return d; }
      return st.arg;
    };
    const realGet = kv.get;
    let raise = null;
    kv.get = (k) => { if (raise) throw new Error(raise); return realGet(k); };
    try {
      for (const st of STEPS) {
        Q.setEnv(st.env === null ? {} : { VOLUME_MIN_SETUP_VOL_MULT: st.env });
        const key = vuc.kvKey(st.uid);
        if (st.pre !== '__keep__') {
          if (st.pre === null) kv.del(key);
          else kv.set(key, st.pre);
        }
        raise = st.kv_raise;
        try {
          if (st.op === 'toggle') {
            const d = shim.toDict(vuc.loadUserCfg(st.uid));
            Object.assign(d, st.arg);
            vuc.saveUserCfg(st.uid, d);
          } else if (st.op === 'save') {
            vuc.saveUserCfg(st.uid, { ...argOf(st) });
          } else if (st.op === 'reset') {
            vuc.resetUserCfg(st.uid);
          }
        } finally {
          raise = null;
        }
        const cfg = vuc.loadUserCfg(st.uid);
        expect(kv.get(key), st.label).toBe(st.kv);
        expect([cfg.bounce_vol_mult, cfg.ribbon_vol_mult], st.label).toEqual(st.eff);
      }
    } finally {
      kv.get = realGet;
    }
  });

  it('a settings round trip with the floor on never writes the floor over a lower stored choice; env 0 restores it', () => {
    kv.set(vuc.kvKey(42), '{"bounce_vol_mult": 0.8, "ribbon_vol_mult": 1.1}');
    const eff = vuc.loadUserCfg(42);
    expect([eff.bounce_vol_mult, eff.ribbon_vol_mult, eff.min_sl_pct_15m]).toEqual([1.5, 1.5, 1.0]);
    const d = shim.toDict(eff);
    d.min_quality = 4;                                    // e.g. the Mini App settings/all VOLUME section
    vuc.saveUserCfg(42, d);
    const stored = JSON.parse(kv.get(vuc.kvKey(42)));
    expect([stored.bounce_vol_mult, stored.ribbon_vol_mult, stored.min_quality]).toEqual([0.8, 1.1, 4]);
    expect(stored).not.toHaveProperty('min_sl_pct_15m');
    Q.setEnv({ VOLUME_MIN_SETUP_VOL_MULT: '0' });
    const off = vuc.loadUserCfg(42);
    expect([off.bounce_vol_mult, off.ribbon_vol_mult]).toEqual([0.8, 1.1]);
  });
});
