/**
 * sseService — handshake headers, retry hint + hello event, 25 s heartbeat (fake timers),
 * per-user broadcast to every open tab, cleanup on close, tab cap, express handler auth.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const sse = nodeRequire('../../../services/sseService.js');

function fakeRes() {
  const res = new EventEmitter();
  res.headers = null;
  res.status_ = null;
  res.chunks = [];
  res.ended = false;
  res.headersSent = false;
  res.writeHead = (code, headers) => { res.status_ = code; res.headers = headers; res.headersSent = true; };
  res.flushHeaders = vi.fn();
  res.write = (c) => { res.chunks.push(c); return true; };
  res.end = () => { res.ended = true; };
  res.status = (code) => { res.status_ = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

beforeEach(() => { sse._resetForTests(); vi.useFakeTimers(); });
afterEach(() => { sse._resetForTests(); vi.useRealTimers(); });

describe('handshake', () => {
  it('writes the event-stream headers (X-Accel-Buffering: no), retry hint and a hello event', () => {
    const res = fakeRes();
    const c = sse.addClient(7, res);
    expect(res.status_).toBe(200);
    expect(res.headers).toEqual({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.chunks[0]).toBe('retry: 10000\n\n');
    expect(res.chunks[1]).toBe(`event: hello\ndata: {"client":${c.id},"heartbeat_s":25}\n\n`);
    expect(sse.clientCount(7)).toBe(1);
    expect(sse.clientCount()).toBe(1);
  });

  it('heartbeat comment every 25 s, stops after close', () => {
    const res = fakeRes();
    sse.addClient(7, res);
    const n0 = res.chunks.length;
    vi.advanceTimersByTime(24_999);
    expect(res.chunks.length).toBe(n0);
    vi.advanceTimersByTime(1);
    expect(res.chunks.length).toBe(n0 + 1);
    expect(res.chunks[n0]).toMatch(/^: ping \d+\n\n$/);
    vi.advanceTimersByTime(50_000);
    expect(res.chunks.length).toBe(n0 + 3);
    res.emit('close');
    expect(sse.clientCount(7)).toBe(0);
    vi.advanceTimersByTime(100_000);
    expect(res.chunks.length).toBe(n0 + 3);
  });
});

describe('broadcast', () => {
  it('reaches every tab of the user only, with incrementing ids and JSON data', () => {
    const a = fakeRes(); const b = fakeRes(); const other = fakeRes();
    sse.addClient(7, a); sse.addClient('7', b); sse.addClient(8, other);
    expect(sse.broadcast(7, 'progress', { trade_id: 't1', stage: 'TP1' })).toBe(2);
    expect(a.chunks.at(-1)).toBe('id: 1\nevent: progress\ndata: {"trade_id":"t1","stage":"TP1"}\n\n');
    expect(b.chunks.at(-1)).toBe(a.chunks.at(-1));
    expect(other.chunks.some((c) => c.includes('progress'))).toBe(false);
    expect(sse.broadcast(9, 'x', {})).toBe(0);
    expect(sse.broadcastAll('trend', { tf: '1D', trend: 'up' })).toBe(3);
    expect(other.chunks.at(-1)).toBe('id: 2\nevent: trend\ndata: {"tf":"1D","trend":"up"}\n\n');
  });

  it('multi-line string payloads are split into data: lines', () => {
    expect(sse.frame('m', 'a\nb')).toBe('event: m\ndata: a\ndata: b\n\n');
  });

  it('a throwing socket is dropped from the registry', () => {
    const res = fakeRes();
    sse.addClient(7, res);
    res.write = () => { throw new Error('EPIPE'); };
    expect(sse.broadcast(7, 'x', 1)).toBe(0);
    expect(sse.clientCount(7)).toBe(0);
  });

  it('caps open streams per user (oldest is ended)', () => {
    const list = [];
    for (let i = 0; i < sse.MAX_CLIENTS_PER_USER + 2; i++) { const r = fakeRes(); list.push(r); sse.addClient(1, r); }
    expect(sse.clientCount(1)).toBe(sse.MAX_CLIENTS_PER_USER);
    expect(list[0].ended).toBe(true);
    expect(list[1].ended).toBe(true);
    expect(list[2].ended).toBe(false);
  });
});

describe('express handler', () => {
  it('401 without an authenticated user; registers otherwise and disables the socket timeout', () => {
    const res = fakeRes();
    expect(sse.handler({}, res)).toBe(null);
    expect(res.status_).toBe(401);
    const res2 = fakeRes();
    const sock = { setTimeout: vi.fn(), setKeepAlive: vi.fn() };
    const c = sse.handler({ user: { id: 42 }, socket: sock }, res2);
    expect(c.userId).toBe('42');
    expect(sock.setTimeout).toHaveBeenCalledWith(0);
    expect(sse.clientCount(42)).toBe(1);
    c.close();
    expect(sse.clientCount(42)).toBe(0);
  });
});
