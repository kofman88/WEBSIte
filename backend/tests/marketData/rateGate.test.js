/**
 * rateGate.js — token bucket 15 r/s burst 10 (acquire timeout 8 s), Semaphore(8),
 * the shared gate and the throttled [OKX-429-BURST] warning. Fake timers drive time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const RG = req('../../services/marketData/rateGate.js');
import { logSpy } from './helpers.js';

const { TokenBucket, Semaphore, RateGate, recordRateLimitHit, getRateLimitStats, _resetRateLimitStats } = RG;

const flush = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

describe('TokenBucket', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('serves the burst immediately and refills at the rate', async () => {
    const b = new TokenBucket(15, 10);
    for (let i = 0; i < 10; i++) expect(await b.acquire()).toBe(true);
    expect(b.tokens).toBeCloseTo(0, 9);
    let done = false;
    const p = b.acquire().then((ok) => { done = ok; });
    await flush();
    expect(done).toBe(false);                       // bucket empty — polling every 25 ms
    await vi.advanceTimersByTimeAsync(50);          // 50 ms × 15/s = 0.75 token — still waiting
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(25);          // 75 ms → 1.125 tokens
    await p;
    expect(done).toBe(true);
  });

  it('gives up after the 8 s acquire timeout (caller proceeds anyway)', async () => {
    const b = new TokenBucket(0, 1);                // rate 0 — never refills
    expect(await b.acquire()).toBe(true);
    let result = null;
    const p = b.acquire(8000).then((ok) => { result = ok; });
    await vi.advanceTimersByTimeAsync(7975);
    expect(result).toBe(null);
    await vi.advanceTimersByTimeAsync(50);
    await p;
    expect(result).toBe(false);
  });

  it('caps the refill at the burst size', async () => {
    const b = new TokenBucket(15, 10);
    await b.acquire();
    await vi.advanceTimersByTimeAsync(60_000);
    await b.acquire();
    expect(b.tokens).toBeCloseTo(9, 9);
  });
});

describe('Semaphore', () => {
  it('limits concurrency and hands the slot to the next waiter', async () => {
    const s = new Semaphore(2);
    await s.acquire(); await s.acquire();
    let third = false;
    const p = s.acquire().then(() => { third = true; });
    await flush();
    expect(third).toBe(false);
    expect(s.waiting).toBe(1);
    s.release();
    await p;
    expect(third).toBe(true);
    expect(s.available).toBe(0);
    s.release(); s.release();
    expect(s.available).toBe(2);
  });
});

describe('RateGate.run', () => {
  it('runs at most `concurrency` callbacks at a time and always releases', async () => {
    const g = new RateGate({ rate: 1000, burst: 100, concurrency: 3 });
    let inFlight = 0, peak = 0;
    const work = () => g.run(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return 'ok';
    });
    const res = await Promise.all(Array.from({ length: 10 }, work));
    expect(res.every((r) => r === 'ok')).toBe(true);
    expect(peak).toBe(3);
    await expect(g.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(g.sem.available).toBe(3);
  });

  it('exposes one shared gate per process', () => {
    expect(RG.sharedGate).toBeInstanceOf(RateGate);
    expect(RG.sharedGate.sem.available).toBe(8);
    expect(RG.sharedGate.bucket._burst).toBe(10);
    expect(RG.sharedGate.bucket._rate).toBe(15);
  });
});

describe('recordRateLimitHit ([OKX-429-BURST] throttle)', () => {
  beforeEach(() => _resetRateLimitStats());

  it('logs the first hit, suppresses within 60 s, rolls up afterwards', () => {
    let t = 1000;
    const now = () => t;
    const log = logSpy();
    recordRateLimitHit('BTC-USDT-SWAP', '1h', 3, { now, log });
    expect(log.lines.warning).toHaveLength(1);
    expect(log.lines.warning[0]).toMatch(/^\[OKX-429-BURST\] 1 hit\(s\) in last 60s; latest sym=BTC-USDT-SWAP tf=1h retry-after=3s \(total-since-start=1\)$/);
    t = 1010;
    recordRateLimitHit('ETH-USDT-SWAP', '4h', 5, { now, log });
    expect(log.lines.warning).toHaveLength(1);
    t = 1061;
    recordRateLimitHit('SOL-USDT-SWAP', '15m', 7, { now, log });
    expect(log.lines.warning).toHaveLength(2);
    expect(log.lines.warning[1]).toContain('2 hit(s) in last 60s; latest sym=SOL-USDT-SWAP tf=15m retry-after=7s (total-since-start=3)');
    expect(getRateLimitStats()).toEqual({ rateLimitHitsTotal: 3, suppressed: 0, lastWarnTs: 1061 });
  });
});
