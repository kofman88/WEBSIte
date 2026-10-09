/**
 * The building blocks every order path stands on, pinned directly:
 *   - asyncio.js: wait_for timeout = cancel + wait (no request leaves after the cancel), the
 *     shielded (pybit thread) variant, nested scopes, FIFO asyncio.Lock, named background tasks
 *     that a caller's timeout does not cancel;
 *   - config.js vs the bot's config.py imported by CPython 3.11 (fixtures/config_vectors.json);
 *   - killswitch.js fail-closed reads and the 5 s cache;
 *   - idempotency / auth-failure breaker registries.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const req = createRequire(import.meta.url);
const A = req('../../../services/autotrade/asyncio.js');
const { readConfig } = req('../../../services/autotrade/config.js');
const KS = req('../../../services/autotrade/killswitch.js');
const { createIdempotency, IDEMPOTENCY_TTL } = req('../../../services/autotrade/idempotency.js');
const { createCooldowns, AUTH_FAIL_THRESHOLD } = req('../../../services/autotrade/cooldowns.js');
const { createVClock } = req('./vclock.js');

const silent = { debug() {}, info() {}, warning() {}, warn() {}, error() {}, critical() {} };
function capture() {
  const lines = [];
  const mk = (lvl) => (m) => lines.push([lvl, String(m)]);
  return { lines, log: { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR'), critical: mk('CRITICAL') } };
}

describe('asyncio.waitFor', () => {
  it('returns the value inside the timeout', async () => {
    const clk = createVClock(1e9);
    expect(await clk.run(A.waitFor(async () => { await clk.sleep(1); return 42; }, 5, { timers: clk.timers }))).toBe(42);
  });

  it('a timeout cancels the scope: the in-flight request is abandoned and no further request starts', async () => {
    const clk = createVClock(1e9);
    const sent = [];
    const tx = A.cancellableTransport(async (r) => { sent.push(r); await clk.sleep(10); return { status: 200 }; });
    let caught = null;
    const fn = async () => {
      try { await tx('place-1'); } catch (e) { caught = e; }        // a trader's generic `catch`
      return tx('place-2');                                         // … must not reach the exchange
    };
    const t0 = clk.mono();
    let at = null;
    const p = A.waitFor(fn, 3, { timers: clk.timers }).catch((e) => { at = clk.mono() - t0; throw e; });
    await expect(clk.run(p)).rejects.toMatchObject({ name: 'TimeoutError', message: '' });
    expect(sent).toEqual(['place-1']);
    expect(A.isCancelledError(caught)).toBe(true);
    expect(at).toBe(3);                    // raised at the timeout, not when the abandoned request ends
  });

  it('the timeout error comes only after the cancelled body has settled (wait_for cancels and waits)', async () => {
    const clk = createVClock(1e9);
    const order = [];
    const sleep = A.cancellableSleep((s) => clk.sleep(s));
    const fn = async () => {
      try { await sleep(10); } finally { order.push('body-finally'); }
    };
    await clk.run(A.waitFor(fn, 2, { timers: clk.timers }).catch((e) => order.push(`raised:${e.name}`)));
    expect(order).toEqual(['body-finally', 'raised:TimeoutError']);
  });

  it('shield (pybit run_in_executor): TimeoutError at once, the call keeps running, its result is dropped', async () => {
    const clk = createVClock(1e9);
    let finished = false;
    const fn = async () => { await clk.sleep(10); finished = true; return 'late'; };
    const t0 = clk.mono();
    let at = null;
    const p = A.waitFor(fn, 3, { timers: clk.timers, shield: true }).catch((e) => { at = clk.mono() - t0; throw e; });
    await expect(clk.run(p)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(at).toBe(3);
    expect(finished).toBe(true);           // the virtual clock ran the background call to its end
  });

  it('runInThread (loop.run_in_executor): the awaiting coroutine is cancelled AT the await, the thread runs on with its requests', async () => {
    const clk = createVClock(1e9);
    const sent = [];
    const tx = A.cancellableTransport(async (r) => { sent.push(r); await clk.sleep(4); return r; });
    const after = [];
    let threadDone = false;
    const thread = async () => { await tx('thread-1'); await tx('thread-2'); threadDone = true; return 'late'; };
    const coro = async () => {
      const v = await A.runInThread(thread);
      after.push(v);                        // the bot's code after `await loop.run_in_executor(...)`
      await tx('after-await');
    };
    const t0 = clk.mono();
    let at = null;
    const p = A.waitFor(coro, 5, { timers: clk.timers }).catch((e) => { at = clk.mono() - t0; throw e; });
    await expect(clk.run(p)).rejects.toMatchObject({ name: 'TimeoutError', message: '' });
    expect(at).toBe(5);                    // wait_for: cancel → the await raises CancelledError at once
    expect(after).toEqual([]);
    expect(threadDone).toBe(true);
    expect(sent).toEqual(['thread-1', 'thread-2']);   // the thread's own second request still left (t=4)
  });

  it('runInThread inside the timeout returns the value; the thread error propagates', async () => {
    const clk = createVClock(1e9);
    expect(await clk.run(A.waitFor(() => A.runInThread(async () => { await clk.sleep(1); return 7; }), 5, { timers: clk.timers }))).toBe(7);
    const boom = new Error('pybit');
    await expect(clk.run(A.runInThread(() => { throw boom; }))).rejects.toBe(boom);
  });

  it('an error of the body propagates unchanged; a nested timeout of the outer scope cancels the inner one', async () => {
    const clk = createVClock(1e9);
    const boom = new Error('boom');
    await expect(clk.run(A.waitFor(async () => { throw boom; }, 5, { timers: clk.timers }))).rejects.toBe(boom);
    const sent = [];
    const tx = A.cancellableTransport(async (r) => { sent.push(r); await clk.sleep(30); return r; });
    const outer = A.waitFor(() => A.waitFor(() => tx('inner'), 20, { timers: clk.timers }), 2, { timers: clk.timers });
    await expect(clk.run(outer)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(sent).toEqual(['inner']);
  });
});

describe('asyncio.Lock / tasks', () => {
  it('Lock is FIFO and exclusive', async () => {
    const clk = createVClock(1e9);
    const lk = A.makeLock();
    const order = [];
    const job = (n, d) => lk.run(async () => { order.push(`in${n}`); await clk.sleep(d); order.push(`out${n}`); });
    const all = Promise.all([job(1, 3), job(2, 1), job(3, 1)]);
    expect(lk.locked()).toBe(true);
    await clk.run(all);
    expect(order).toEqual(['in1', 'out1', 'in2', 'out2', 'in3', 'out3']);
    expect(lk.locked()).toBe(false);
  });

  it('named tasks: their own name, errors to onError, CancelledError silent, not cancelled by the caller timeout', async () => {
    const clk = createVClock(1e9);
    const tg = A.createTaskGroup({ log: silent });
    const seen = [];
    const errors = [];
    expect(A.currentTaskName()).toBe('main');
    await A.runAsTask('call0', async () => {
      seen.push(A.currentTaskName());
      tg.create('partial_tp_1_SOL', async () => { seen.push(A.currentTaskName()); });
      tg.create('bad', async () => { throw new Error('x'); }, { onError: (e) => errors.push(e.message) });
      tg.create('cancelled', async () => { throw new A.CancelledError(); }, { onError: (e) => errors.push(`never ${e.name}`) });
    });
    const sleep = A.cancellableSleep((s) => clk.sleep(s));
    let bgDone = false;
    const outer = A.waitFor(async () => {
      tg.create('bg', async () => { await sleep(5); bgDone = true; });
      await sleep(10);
    }, 1, { timers: clk.timers });
    await expect(clk.run(outer)).rejects.toMatchObject({ name: 'TimeoutError' });
    await clk.run(tg.drain());
    expect(bgDone).toBe(true);
    expect(seen).toEqual(['call0', 'partial_tp_1_SOL']);
    expect(errors).toEqual(['x']);
    expect(tg.size()).toBe(0);
  });
});

describe('config.readConfig vs the bot config.py (CPython 3.11)', () => {
  const FX = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'config_vectors.json'), 'utf8'));
  it('fixture comes from CPython 3.11', () => { expect(FX.python.startsWith('3.11.')).toBe(true); });
  for (const c of FX.cases) {
    it(JSON.stringify(c.env), () => {
      let got;
      try {
        got = { ok: readConfig(c.env) };
      } catch (e) {
        got = { err: [e.pyType || e.name, e.message] };
      }
      expect(got).toEqual(c.err ? { err: c.err } : { ok: c.ok });
    });
  }
});

describe('killswitch — fail-closed', () => {
  const kvOf = (init = {}) => {
    const m = new Map(Object.entries(init));
    return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } };
  };
  it('no row → ACTIVE (fresh install); a halted row blocks with KillswitchHalted', async () => {
    let mono = 0;
    const kv = kvOf();
    const ks = KS.createKillswitch({ kv, monotonic: () => mono, log: silent });
    expect(await ks.getState()).toEqual(['ACTIVE', '']);
    await ks.requireActive('t');
    kv.set(KS.OPERATIONAL_STATE_KEY, JSON.stringify({ state: 'HALTED_NEW', reason: 'maint' }));
    expect(await ks.getState()).toEqual(['ACTIVE', '']);          // 5 s cache
    mono = 5.0;
    await expect(ks.requireActive('auto_trade.execute_auto_trade')).rejects.toMatchObject({
      killswitchHalted: true, state: 'HALTED_NEW', message: 'HALTED_NEW: maint',
    });
  });

  it('a read error → HALTED_ALL db_read_failed, never cached; an unknown / unparsable state → HALTED_ALL', async () => {
    const cap = capture();
    let broken = true;
    const kv = { get: () => { if (broken) throw new Error('disk I/O error'); return null; }, set: () => {} };
    const ks = KS.createKillswitch({ kv, monotonic: () => 0, log: cap.log });
    expect(await ks.getState()).toEqual(['HALTED_ALL', 'db_read_failed']);
    broken = false;
    expect(await ks.getState()).toEqual(['ACTIVE', '']);          // self-heals on the next call
    const bad = KS.createKillswitch({ kv: kvOf({ [KS.OPERATIONAL_STATE_KEY]: JSON.stringify({ state: 'PAUSED' }) }), monotonic: () => 0, log: cap.log });
    expect(await bad.getState()).toEqual(['HALTED_ALL', 'invalid_state_in_db']);
    const junk = KS.createKillswitch({ kv: kvOf({ [KS.OPERATIONAL_STATE_KEY]: '{not json' }), monotonic: () => 0, log: cap.log });
    expect(await junk.getState()).toEqual(['HALTED_ALL', 'db_read_failed']);
    expect(cap.lines.map((l) => l[0])).toEqual(['WARNING', 'WARNING', 'WARNING']);
  });

  it('setState: unknown state refused; a halt issues a resume token, consumed once', async () => {
    const kv = kvOf();
    const ks = KS.createKillswitch({ kv, monotonic: () => 0, now: () => 1000, log: silent, token: () => 'TOKEN123' });
    await expect(ks.setState('STOPPED')).rejects.toMatchObject({ pyType: 'ValueError' });
    expect(await ks.setState('HALTED_ALL', { reason: 'incident', actorUid: 7 })).toBe('TOKEN123');
    expect(JSON.parse(kv.get(KS.OPERATIONAL_STATE_KEY))).toEqual({
      state: 'HALTED_ALL', reason: 'incident', actor_uid: 7, changed_at: 1000, resume_token: 'TOKEN123',
    });
    expect(await ks.validateAndConsumeResumeToken('wrong')).toBe(false);
    expect(await ks.validateAndConsumeResumeToken('TOKEN123')).toBe(true);
    expect(await ks.validateAndConsumeResumeToken('TOKEN123')).toBe(false);
  });
});

describe('idempotency + auth breaker registries', () => {
  it('key format, persisted record, restore keeps live entries and tombstones expired ones', async () => {
    let t = 1_800_000_000.25;
    const kv = new Map();
    const tg = A.createTaskGroup({ log: silent });
    const idem = createIdempotency({
      now: () => t, uuidHex: () => 'abcdef0123456789', kvGet: async (k) => (kv.has(k) ? kv.get(k) : null),
      kvSet: async (k, v) => { kv.set(k, v); }, kvKeysWithPrefix: async (p) => [...kv.keys()].filter((k) => k.startsWith(p)), tasks: tg, log: silent,
    });
    const key = idem.makeIdempotencyKey(501, 'SOL-USDT-SWAP', t);
    expect(key).toBe('501_SOL-USDT-SWAP_1800000000_abcdef01');
    idem.setIdempotency(key, 'placing');
    await tg.drain();
    expect(kv.get(`idemp_v1_${key}`)).toBe('{"status": "placing", "ts": 1800000000.25, "order_id": ""}');
    kv.set('idemp_v1_old', JSON.stringify({ status: 'placed', ts: t - IDEMPOTENCY_TTL - 1, order_id: 'X' }));
    const idem2 = createIdempotency({
      now: () => t, kvGet: async (k) => (kv.has(k) ? kv.get(k) : null), kvSet: async (k, v) => { kv.set(k, v); },
      kvKeysWithPrefix: async (p) => [...kv.keys()].filter((k) => k.startsWith(p) && kv.get(k)), tasks: tg, log: silent,
    });
    expect(await idem2.restoreIdempotencyRegistry()).toBe(1);
    expect([...idem2.registry.keys()]).toEqual([key]);
    expect(kv.get('idemp_v1_old')).toBe('');
    t += IDEMPOTENCY_TTL + 1;
    expect(idem2.gcIdempotencyRegistry()).toBe(1);
    await tg.drain();
    expect(kv.get(`idemp_v1_${key}`)).toBe('');
  });

  it(`auth breaker: ${AUTH_FAIL_THRESHOLD} auth failures in the window → auto_trade off once, admin alerted once`, async () => {
    let t = 1_800_000_000;
    const offs = [];
    const alerts = [];
    const msgs = [];
    const tg = A.createTaskGroup({ log: silent });
    const cd = createCooldowns({
      now: () => t, kvSet: async () => {}, kvItemsWithPrefix: async () => [], tasks: tg, log: silent,
      setAutoTrade: async (uid, on) => { offs.push([uid, on]); }, invalidateUserCaches: async () => {},
      sendMessage: async (_b, uid, text) => { msgs.push([uid, text.split('\n')[0]]); return true; },
      alertAuthBreaker: async (_b, uid, ex, n) => { alerts.push([uid, ex, n]); },
    });
    const results = [];
    for (let i = 0; i < AUTH_FAIL_THRESHOLD + 1; i++) {
      results.push(await cd.handleAuthFailure(7, 'bybit', {}));
      t += 1;
    }
    await tg.drain();
    expect(results).toEqual([...Array(AUTH_FAIL_THRESHOLD - 1).fill(false), true, true]);
    expect(offs).toEqual([[7, false]]);
    expect(alerts.length).toBe(1);
    expect(msgs.length).toBe(1);
    expect(await cd.recordAuthFailure(7, 'bybit', {}, new Error('insufficient balance'))).toBe(false);   // not an auth error
  });
});
