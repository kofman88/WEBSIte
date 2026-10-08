/**
 * challenge.apply_settings / start over traderSettingsService + profilesService (bot:
 * profiles._enable_strategy, miniapp_api._apply_multi, user.can, _has_keys) — the
 * generator's truth table (gen_challenge_vectors.py §7): free / pro / admin(123) ×
 * 5 initial strategy states × 5 strategy sets × signals|auto × keys yes|no.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { FIXTURE as V, setupEnv, insertUser, quietLog, captureLog, BASE, pickFields } from './helpers.js';

const nodeRequire = createRequire(import.meta.url);
setupEnv('apply');
const db = nodeRequire('../../models/database.js');
const ts = nodeRequire('../../services/traderSettingsService.js');
const C = nodeRequire('../../services/challengeService.js');
const exchangeService = nodeRequire('../../services/exchangeService.js');

beforeAll(() => {
  insertUser(db, 601);
});

beforeEach(() => {
  C.resetDeps();
  C.configure({ log: quietLog });
});

function botUser(uid, plan, init) {
  return { ...ts.defaults(uid), sub_plan: plan, sub_status: 'active', sub_expires: V.t0 + 30 * 86400, ...init };
}

describe('applySettings truth table', () => {
  it(`reproduces ${V.apply.length} cases (applied / skipped lists + every touched user field)`, () => {
    const bad = [];
    for (const c of V.apply) {
      const user = botUser(c.uid, c.plan, c.init);
      C.configure({ hasKeys: () => c.keys });
      const ch = C.build(c.uid, { ...BASE, strategies: c.strategies, mode: c.mode, risk_pct: 1.5, leverage: 7 }, V.t0);
      const res = C.applySettings(user, ch, { admin: c.uid === 123, save: false });
      if (JSON.stringify(res) !== JSON.stringify(c.res) || JSON.stringify(pickFields(user)) !== JSON.stringify(c.user)) {
        bad.push({ c, got: { res, user: pickFields(user) } });
      }
    }
    expect(bad).toEqual([]);
  });

  it('logs the bot marker with Python list reprs', () => {
    const log = captureLog();
    C.configure({ log, hasKeys: () => false });
    const user = botUser(601, 'free', {});
    C.applySettings(user, C.build(601, { ...BASE, strategies: ['SMC', 'LEVELS'], mode: 'auto' }, V.t0), { admin: false, save: false });
    expect(log.lines).toEqual(["info [CHALLENGE] uid=601 apply applied=['trade_risk_pct', 'trade_leverage', 'strategy.LEVELS'] skipped=['strategy.SMC', 'auto_trade']"]);
  });
});

describe('start(): build → apply → save', () => {
  it('saves the user and the challenge, logs the start marker', () => {
    const log = captureLog();
    C.configure({ log, clock: () => V.t0 + 0.5 });
    const user = ts.getOrCreate(601);
    user.sub_plan = 'pro'; user.sub_status = 'active'; user.sub_expires = V.t0 + 86400 * 30;
    ts.save(user);
    const [ch, res] = C.start(user, { ...BASE, deposit: 2500.5, goal_kind: 'usd', goal_value: 4000, risk_pct: 0.75, leverage: 12, strategies: ['VOLUME'] }, { admin: false });
    expect(res).toEqual({ applied: ['trade_risk_pct', 'trade_leverage', 'strategy.VOLUME'], skipped: [] });
    const saved = ts.get(601);
    expect([saved.trade_risk_pct, saved.trade_leverage, saved.vol_long_active]).toEqual([0.75, 12, true]);
    expect(db.prepare("SELECT value FROM engine_kv WHERE key = 'challenge_601'").get().value).toBe(ch.toJson());
    // python: '[CHALLENGE] uid=%s start deposit=%.0f goal=%.0f r_needed=%.1f term=%s mode=%s' % (601, 2500.5, 4000.0, 80.0, '1m', 'signals')
    // → deposit=2500 (round-half-even on 2500.5) goal=4000 r_needed=80.0
    expect(log.lines.at(-1)).toBe('info [CHALLENGE] uid=601 start deposit=2500 goal=4000 r_needed=80.0 term=1m mode=signals');
  });

  it('the default hasKeys reads exchange_keys (any of bybit/bingx/binance/okx with key and secret)', async () => {
    const user = ts.get(601);
    expect(C.dbHasKeys(user)).toBe(false);
    await exchangeService.addKey(601, { exchange: 'bingx', apiKey: 'k'.repeat(16), apiSecret: 's'.repeat(32) });
    expect(C.dbHasKeys(user)).toBe(true);
    const r = C.applySettings(user, C.build(601, { ...BASE, mode: 'auto' }, V.t0), { admin: false, save: false });
    expect(r.applied).toContain('auto_trade');
    expect(user.auto_trade).toBe(true);
  });
});
