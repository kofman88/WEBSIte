/**
 * utils/gracefulShutdown.js — bot.py _request_stop / _shutdown_deadline for server.js: the first
 * stop request runs the shutdown steps under a 22 s deadline, a second one exits at once, and
 * under Phusion Passenger the stop arrives as the PhusionPassenger 'exit' event (its Node loader
 * calls process.exit(0) straight away when nobody listens for it).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const GS = req('../utils/gracefulShutdown.js');

function harness(run) {
  const lines = [];
  const exits = [];
  const log = { info: (m) => lines.push(['INFO', m]), warn: (m) => lines.push(['WARNING', m]), error: (m) => lines.push(['ERROR', m]) };
  const stop = GS.createStopRequest({ run, log, exit: (c) => exits.push([Date.now(), c]) });
  return { stop, lines, exits };
}

afterEach(() => { vi.useRealTimers(); });

describe('gracefulShutdown', () => {
  it('first request: the bot lines, the steps, then exit(0); the deadline is cleared', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const steps = [];
    const h = harness(async (src) => { steps.push(src); await new Promise((r) => setTimeout(r, 5000)); steps.push('done'); });
    const p = h.stop.request('SIGTERM');
    expect(h.stop.stopping).toBe(true);
    expect(h.lines).toEqual([
      ['INFO', 'received SIGTERM, shutting down'],
      ['INFO', '🛑 Получен сигнал остановки — инициируем graceful shutdown (дедлайн 22с)...'],
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    await p;
    expect(steps).toEqual(['SIGTERM', 'done']);
    expect(h.exits).toEqual([[5000, 0]]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.exits).toEqual([[5000, 0]]);             // no deadline exit after a clean stop
  });

  it('a second request exits at once ("Повторный сигнал остановки")', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness(() => new Promise(() => {}));
    h.stop.request('SIGTERM');
    await vi.advanceTimersByTimeAsync(1000);
    h.stop.request('SIGTERM');
    expect(h.exits).toEqual([[1000, 0]]);
    expect(h.lines.slice(-1)).toEqual([['WARNING', '🛑 Повторный сигнал остановки — выходим немедленно']]);
  });

  it('a hung step: forced exit after the 22 s deadline', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness(() => new Promise(() => {}));
    h.stop.request('Passenger exit');
    await vi.advanceTimersByTimeAsync(GS.SHUTDOWN_DEADLINE_S * 1000 - 1);
    expect(h.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exits).toEqual([[22_000, 0]]);
    expect(h.lines.slice(-1)).toEqual([['WARNING', '🛑 shutdown не завершился за 22с — принудительный выход (данные уже сохранены на ранних шагах)']]);
  });

  it('a failing step is logged and the process still exits', async () => {
    const h = harness(async () => { throw new Error('boom'); });
    await h.stop.request('SIGINT');
    expect(h.lines.slice(-1)).toEqual([['ERROR', 'shutdown step failed: boom']]);
    expect(h.exits.map((e) => e[1])).toEqual([0]);
  });

  it('sources: SIGTERM / SIGINT on the process and the PhusionPassenger "exit" event', () => {
    const proc = new EventEmitter();
    const passenger = new EventEmitter();
    const got = [];
    const stop = { request: (src) => got.push(src) };
    const off = GS.installStopHandlers(stop, { proc, passenger });
    passenger.emit('exit');
    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    expect(got).toEqual(['Passenger exit', 'SIGTERM', 'SIGINT']);
    // Passenger's loader emits 'exit' only when the app listens for it (else process.exit(0) at once)
    expect(passenger.listeners('exit').length).toBe(1);
    off();
    expect(passenger.listeners('exit').length).toBe(0);
    expect(proc.listeners('SIGTERM').length).toBe(0);
    // standalone: no Passenger object
    const off2 = GS.installStopHandlers(stop, { proc });
    expect(proc.listeners('SIGTERM').length).toBe(1);
    off2();
  });
});
