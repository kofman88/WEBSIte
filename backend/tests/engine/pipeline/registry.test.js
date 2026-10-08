/**
 * signalRegistry — replay of the bot's signal_registry.py on a fake clock
 * (fixtures/registry.json, tools/gen_vectors.py `registry`):
 *   peek / commit (ttl_s shift) / can_send / *_multi / claim_multi / apply_cooldown /
 *   clear_for_symbol / cleanup / stats / force_save — per step: result, registry
 *   snapshot, persisted JSON (debounced 10 s, Python json.dump bytes), INFO/WARNING logs;
 *   _persist_load on crafted files (expired, future, bad uid, null ts abort, list, bad JSON).
 *
 *   Python: sr.time = Clock(...); sr._PERSIST_PATH = tmp; sr.peek_can_send(1, "BTC-USDT-SWAP", "LONG", "") …
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const R = req('../../../services/engine/signalRegistry.js');
const pf = req('../../../config/planFeatures.js');
const { load, clock, memKv, captureLog } = req('./vectors.js');

const V = load('registry');

function make(c, kv, log) {
  return R.createSignalRegistry({
    now: c.now, kv, log,
    isMulti: (user) => pf.isMulti(user, { admin: user.user_id === 123 }),
  });
}

function sameLogs(js, py) {
  expect(js.length).toBe(py.length);
  py.forEach(([lvl, msg], i) => {
    expect(js[i][0]).toBe(lvl);
    if (/Expecting|line \d+ column/.test(msg)) expect(js[i][1].split('load error:')[0]).toBe(msg.split('load error:')[0]);
    else expect(js[i][1]).toBe(msg);
  });
}

describe('constants', () => {
  it('match the bot', () => {
    expect(R.CROSS_TTL).toBe(V.constants.CROSS_TTL);
    expect(R.CLAIM_TTL_S).toBe(V.constants.CLAIM_TTL_S);
    expect(R.CLEANUP_INTERVAL).toBe(V.constants._CLEANUP_INTERVAL);
    expect(R.PERSIST_INTERVAL).toBe(V.constants._PERSIST_INTERVAL);
    expect(R.STRATEGY_TTL).toEqual(V.constants._STRATEGY_TTL);
  });
  it.each(V.env_cooldown)('POST_CLOSE_COOLDOWN_SEC=%j', (raw, want) => {
    const env = raw === null ? {} : { POST_CLOSE_COOLDOWN_SEC: raw };
    // "raise" = ValueError in the bot (the post-close branch is skipped); the site keeps the default
    expect(R.postCloseCooldownS(env)).toBe(want === 'raise' ? 1800 : want);
  });
});

describe('registry scripts (bot replay)', () => {
  for (const [name, steps] of Object.entries(V.scripts)) {
    it(name, () => {
      const c = clock(1_800_000_000.25);
      const kv = memKv();
      const log = captureLog();
      const r = make(c, kv, log);
      steps.forEach((s, i) => {
        const op = s.op;
        const U = (n) => V.users[n];
        let res = null;
        switch (op[0]) {
          case 'advance': c.advance(op[1]); break;
          case 'peek': res = r.peekCanSend(op[1], op[2], op[3], op[4]); break;
          case 'commit': r.commitSend(op[1], op[2], op[3], op[4], op[5]); break;
          case 'can_send': res = r.canSend(op[1], op[2], op[3], op[4]); break;
          case 'peek_multi': res = r.peekCanSendMulti(U(op[1]), op[2], op[3]); break;
          case 'claim_multi': r.claimMulti(U(op[1]), op[2], op[3], op[4]); break;
          case 'commit_multi': r.commitSendMulti(U(op[1]), op[2], op[3]); break;
          case 'can_send_multi': res = r.canSendMulti(U(op[1]), op[2], op[3]); break;
          case 'cooldown': r.applyCooldown(op[1], op[2], op[3], op[4]); break;
          case 'clear': r.clearForSymbol(op[1], op[2], op[3]); break;
          case 'stats': res = r.getStats(); break;
          case 'force_save': res = r.forceSave(); break;
          default: throw new Error(op[0]);
        }
        const where = `${name} step ${i} ${JSON.stringify(op)}`;
        expect(c.t, where).toBe(s.now);
        expect(res, where).toEqual(s.result);
        expect(r.snapshot(), where).toEqual(s.registry);
        expect(kv.get('signal_registry'), where).toBe(s.persisted);
        sameLogs(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING'), s.logs);
        log.lines.length = 0;
      });
    });
  }
});

describe('_persist_load (bot table)', () => {
  it.each(V.loads.map((c, i) => [i, c]))('#%i', (_i, c) => {
    const kv = memKv();
    kv.set('signal_registry', c.raw);
    const log = captureLog();
    const r = make(clock(c.now), kv, log);
    r.load();
    expect(r.snapshot()).toEqual(c.registry);
    sameLogs(log.lines.filter((l) => l[0] === 'INFO' || l[0] === 'WARNING'), c.logs);
  });

  it('a force_save → load round trip keeps every live entry, ttl-shifted future stamps included', () => {
    const c = clock(1_800_000_000.5);
    const kv = memKv();
    const r = make(c, kv, captureLog());
    r.commitSend(1, 'BTC-USDT-SWAP', 'LONG');
    r.commitSend(2, 'ETH-USDT-SWAP', 'SHORT', 'VOLUME', 57600);   // ts in the future
    r.commitSend(3, 'SOL-USDT-SWAP', 'LONG', 'MULTI', 120);
    r.forceSave();
    c.advance(60);
    const r2 = make(c, kv, captureLog());
    expect(r2.load()).toBe(3);
    expect(r2.snapshot()).toEqual(r.snapshot());
    expect(r2.peekCanSend(2, 'ETH-USDT-SWAP', 'SHORT', 'VOLUME')).toBe(false);
    expect(r2.peekCanSend(3, 'SOL-USDT-SWAP', 'LONG', 'MULTI')).toBe(false);
    c.advance(61);   // the 120 s provisional MULTI claim lapsed; a restart now drops it
    expect(r2.peekCanSend(3, 'SOL-USDT-SWAP', 'LONG', 'MULTI')).toBe(true);
    const r3 = make(c, kv, captureLog());
    expect(r3.load()).toBe(2);
  });
});
