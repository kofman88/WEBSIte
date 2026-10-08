/**
 * sseService frames: every line terminator of the event-stream grammar (CRLF, LF, lone CR —
 * WHATWG HTML §9.2.6) splits a string payload into separate `data:` lines, so the client
 * reassembles exactly the original lines (joined by LF); JSON payloads never contain a raw
 * terminator. Heartbeat comments keep their 25 s cadence across several clients.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const sse = nodeRequire('../../../services/sseService.js');

/** Minimal event-stream parser (the browser's EventSource algorithm, data field only). */
function parseStream(text) {
  const events = [];
  let data = [];
  let event = 'message';
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (data.length) events.push({ event, data: data.join('\n') });
      data = []; event = 'message';
      continue;
    }
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  return events;
}

function fakeRes() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writeHead = () => {};
  res.write = (c) => { res.chunks.push(c); return true; };
  res.end = () => {};
  return res;
}

beforeEach(() => { sse._resetForTests(); vi.useFakeTimers(); });
afterEach(() => { sse._resetForTests(); vi.useRealTimers(); });

describe('sse frames', () => {
  it('CRLF, LF and a lone CR each start a new data: line', () => {
    expect(sse.frame('m', 'a\r\nb\rc\nd')).toBe('event: m\ndata: a\ndata: b\ndata: c\ndata: d\n\n');
    expect(sse.frame('m', 'x\r')).toBe('event: m\ndata: x\ndata: \n\n');
  });

  it('a client parsing the stream gets the payload lines back intact', () => {
    const res = fakeRes();
    sse.addClient(3, res);
    const payloads = ['🎯 TP1\r🛡 Стоп', 'one\r\ntwo\nthree', { text: 'a\rb', n: 1 }];
    for (const p of payloads) sse.broadcast(3, 'progress', p);
    const evs = parseStream(res.chunks.join('')).filter((e) => e.event === 'progress');
    expect(evs.map((e) => e.data)).toEqual(['🎯 TP1\n🛡 Стоп', 'one\ntwo\nthree', JSON.stringify({ text: 'a\rb', n: 1 })]);
    expect(JSON.parse(evs[2].data)).toEqual({ text: 'a\rb', n: 1 });
  });

  it('heartbeats every 25 s on every open stream, independent per client', () => {
    const a = fakeRes(); const b = fakeRes();
    sse.addClient(1, a);
    vi.advanceTimersByTime(10_000);
    sse.addClient(2, b);
    const pings = (r) => r.chunks.filter((c) => c.startsWith(': ping ')).length;
    vi.advanceTimersByTime(15_000);
    expect([pings(a), pings(b)]).toEqual([1, 0]);
    vi.advanceTimersByTime(10_000);
    expect([pings(a), pings(b)]).toEqual([1, 1]);
    vi.advanceTimersByTime(50_000);
    expect([pings(a), pings(b)]).toEqual([3, 3]);
  });
});
