'use strict';
/**
 * Shared fakes for the market-data tests: an HTTP layer driven by a handler, a fake
 * WebSocket, closed-bar frames and a sleep spy.
 */
const { EventEmitter } = require('events');
const { Frame } = require('../../strategies/common/frame');

/**
 * `http(url, { params })` → `{ status, headers, json, text }` from `handler(url, params, opts)`.
 * The handler may return a plain object (→ 200 JSON), `{ status, json, headers, text }`, or throw.
 */
function makeHttp(handler) {
  const calls = [];
  const http = async (url, opts = {}) => {
    const params = { ...(opts.params || {}) };
    calls.push({ url, params, opts });
    const r = await handler(url, params, opts);
    if (r && typeof r === 'object' && ('status' in r)) {
      const h = r.headers || {};
      return {
        status: r.status,
        headers: { get: (n) => (n in h ? h[n] : (h[n.toLowerCase()] ?? null)) },
        json: 'json' in r ? r.json : null,
        text: r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : ''),
      };
    }
    return { status: 200, headers: { get: () => null }, json: r, text: JSON.stringify(r) };
  };
  http.calls = calls;
  return http;
}

/** n closed bars from startMs, step stepMs, all prices = price, volume 1. */
function closedFrame(startMs, n, stepMs, price = 1.0) {
  const bars = [];
  for (let i = 0; i < n; i++) bars.push([startMs + i * stepMs, price, price, price, price, 1.0]);
  return Frame.fromBars(bars);
}

class FakeWS extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.readyState = 1; // OPEN
  }

  send(s) { if (this.closed) throw new Error('socket closed'); this.sent.push(s); }
  close() { this.closed = true; this.readyState = 3; }
  terminate() { this.close(); }
}

/** A WebSocket "class" whose instances open on the next tick (or fail when `failTimes` > 0). */
function makeWsClass({ failTimes = 0 } = {}) {
  const instances = [];
  let fails = failTimes;
  class WS extends FakeWS {
    constructor(url, opts) {
      super();
      this.url = url; this.opts = opts;
      this.readyState = 0;
      instances.push(this);
      setImmediate(() => {
        if (fails > 0) {
          fails -= 1;
          this.readyState = 3;
          this.emit('error', new Error('ECONNREFUSED'));
          this.emit('close');
        } else {
          this.readyState = 1;
          this.emit('open');
        }
      });
    }
  }
  WS.instances = instances;
  return WS;
}

/** A sleep that records the requested delays and resolves immediately (or waits with fake timers). */
function sleepSpy({ real = false } = {}) {
  const calls = [];
  const fn = (ms) => {
    calls.push(ms);
    return real ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  };
  fn.calls = calls;
  return fn;
}

const silentLog = { debug() {}, info() {}, warning() {}, warn() {}, error() {} };

function logSpy() {
  const lines = { debug: [], info: [], warning: [], error: [] };
  return {
    lines,
    debug: (m) => lines.debug.push(String(m)),
    info: (m) => lines.info.push(String(m)),
    warning: (m) => lines.warning.push(String(m)),
    warn: (m) => lines.warning.push(String(m)),
    error: (m) => lines.error.push(String(m)),
  };
}

module.exports = { makeHttp, closedFrame, FakeWS, makeWsClass, sleepSpy, silentLog, logSpy };
