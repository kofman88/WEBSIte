/**
 * volumeFilter (volume_filter.apply_vol_filter + scanner_mid.MidScanner._apply_vol_filter)
 * and coinQualityLearner (coin_quality_learner) on Python vectors
 * (fixtures/volume_filter.json, fixtures/coin_quality.json, tools/gen_vectors.py).
 *
 *   Python: vf.apply_vol_filter(coins, users, vol, lambda u: u.min_volume_usdt, cap_count=…, floor_usdt=…)
 *           await cq.restore_blacklist_from_kv(); await cq.recompute_blacklist(); cq.is_blacklisted(sym, strat)
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');
const { signalTradesDDL } = req('../../../models/engineSchema.js');
const VF = req('../../../services/engine/volumeFilter.js');
const CQ = req('../../../services/engine/coinQualityLearner.js');
const Repo = req('../../../services/engine/signalTradesRepo.js');
const { load, clock, memKv, captureLog } = req('./vectors.js');

const VFV = load('volume_filter');
const CQV = load('coin_quality');

describe('apply_vol_filter (bot table)', () => {
  it.each(VFV.cases.map((c, i) => [i, c.group, c.cap, c.floor, c]))('#%i %s cap=%s floor=%s', (_i, _g, _c, _f, c) => {
    const users = VFV.groups[c.group];
    const coins = c.coins || VFV.coins;
    const got = VF.applyVolFilter(coins, users, VFV.vol, (u) => (u.min_volume_usdt === undefined ? 0 : u.min_volume_usdt),
      { capCount: c.cap, floorUsdt: c.floor, strategyTag: 'SMC', log: captureLog() });
    expect(got).toEqual(c.result);
  });
});

describe('MidScanner._apply_vol_filter (bot table)', () => {
  it.each(VFV.mid.map((c) => [c.group, c]))('%s', (_g, c) => {
    expect(VF.midScannerVolFilter(VFV.coins, VFV.mid_groups[c.group], VFV.vol)).toEqual(c.result);
  });
});

describe('coin quality learner (bot replay)', () => {
  it('restore → recompute → expiry → recompute', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(signalTradesDDL());
    const ins = (r) => {
      const keys = Object.keys(r);
      db.prepare(`INSERT INTO signal_trades (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => r[k]));
    };
    for (const r of CQV.rows) ins(r);
    db.prepare("INSERT INTO signal_trades (trade_id, user_id, symbol, direction, entry, sl, tp1, tp2, tp3, strategy, result, result_rr, created_at) "
      + "VALUES ('tnull', 1, 'NUL-USDT-SWAP', 'LONG', 1, 1, 1, 1, 1, 'SMC', 'SL', NULL, ?)").run(CQV.null_row.created_at);
    const kv = memKv();
    for (const [k, v] of Object.entries(CQV.initial_kv)) kv.set(k, v);
    const c = clock(1_800_000_000.0);
    const log = captureLog();
    const cq = CQ.createCoinQualityLearner({ repo: Repo.createSignalTradesRepo({ db, now: c.now }), kv, now: c.now, log });
    const check = (want) => {
      for (const [key, v] of Object.entries(want)) {
        const [s, st] = key.split('|');
        expect(cq.isBlacklisted(s, st), key).toBe(v);
      }
    };
    const infoLines = () => log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING').map((l) => l[1]);
    for (const s of CQV.steps) {
      c.t = s.now;
      log.lines.length = 0;
      kv.writes.length = 0;
      if (s.op === 'restore') {
        expect(cq.restoreFromKv()).toBe(s.result);
        expect(cq.getBlacklistSnapshot()).toEqual(s.snapshot);
        expect(infoLines()).toEqual(s.logs);
        check(s.check);
      } else if (s.op === 'recompute' || s.op === 'recompute2') {
        expect(cq.recompute()).toEqual(s.result);
        expect(cq.getBlacklistSnapshot()).toEqual(s.snapshot);
        expect(kv.writes.map((w) => w[1])).toEqual(s.kv);
        expect(infoLines()).toEqual(s.logs);
        check(s.check);
      } else {
        check(s.check);
        expect(cq.getBlacklistSnapshot()).toEqual(s.snapshot);
      }
    }
  });
});
