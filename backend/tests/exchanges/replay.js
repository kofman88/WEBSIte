'use strict';
/**
 * JS side of the Python replay harness (py/harness.py): serves the same scripted
 * responses, records requests in the same shape, drives a trader instance on a fake
 * clock and returns an "actual" object comparable with the fixture's "expected".
 */
const { TransportError } = require('../../services/exchanges/transport');
const { memoryKv } = require('../../services/exchanges/runtime');
const { InvalidRequestError } = require('../../services/exchanges/bybitHttp');
const { apiKeyHash } = require('../../services/exchanges/traderCommon');
const { makeClock } = require('./helpers');

const MARKER_RE = /\[[A-Z][A-Z0-9_-]*[A-Z0-9]\]/g;

function urlPath(url) {
  try { return new URL(url).pathname; } catch (_e) { return url; }
}

class Router {
  constructor(routes, { allHeaders = false } = {}) {
    this.routes = (routes || []).map((r) => ({ ...r, responses: r.responses.slice() }));
    this.log = [];
    this.allHeaders = allHeaders;
  }

  take(method, url) {
    const path = urlPath(url);
    for (const r of this.routes) {
      if (r.method === method && r.path === path) {
        if (r.query && !url.includes(r.query)) continue;
        if (r.responses.length > 1) return r.responses.shift();
        return r.responses[0];
      }
    }
    return { status: 404, text: 'no route', headers: { 'Content-Type': 'text/plain' } };
  }

  record(method, url, headers, body) {
    const keep = {};
    for (const [k, v] of Object.entries(headers || {})) {
      const kl = k.toLowerCase();
      if (kl.startsWith('x-bapi') || kl.startsWith('x-bx') || kl.startsWith('x-mbx') || kl.startsWith('ok-access') || kl === 'content-type' || kl === 'x-simulated-trading') keep[k] = v;
    }
    const row = { method, url, headers: keep, body: body === undefined ? null : body };
    if (this.allHeaders) {
      // every header the trader handed to the transport, lower-cased (gen_adversarial.py `hdrs`)
      row.hdrs = {};
      for (const [k, v] of Object.entries(headers || {})) row.hdrs[k.toLowerCase()] = v;
    }
    this.log.push(row);
  }
}

function makeTransport(router) {
  return async ({ method, url, headers, body }) => {
    router.record(method, url, headers, body);
    const spec = router.take(method, url);
    if (spec.raise) {
      const kind = spec.raise === 'timeout' ? 'timeout' : (spec.raise === 'connect' ? 'connect' : 'error');
      throw new TransportError(kind, spec.raise === 'timeout' ? (spec.message || '') : (spec.message || ''));
    }
    const hdrs = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(spec.headers || {})) hdrs[k.toLowerCase()] = v;
    return { status: spec.status === undefined ? 200 : spec.status, headers: hdrs, text: spec.text ?? '', url };
  };
}

/** Bybit mode='session': pybit stand-in returning scripted dicts. */
function makeFakeSession(router, demo) {
  const target = { endpoint: demo ? 'https://api-demo.bybit.com' : 'https://api.bybit.com', time_offset: 0 };
  return new Proxy(target, {
    get(t, name) {
      if (name in t) return t[name];
      if (typeof name !== 'string' || name.startsWith('_') || name === 'then') return undefined;
      return async (kwargs = {}) => {
        router.log.push({ method: name, kwargs: JSON.parse(JSON.stringify(kwargs)) });
        const spec = router.take('CALL', `https://x/${name}`);
        if (spec.raise) {
          if (spec.raise === 'invalid') throw new InvalidRequestError({ request: `call ${name}`, message: spec.message || '', statusCode: spec.code ?? -1, time: '00:00:00' });
          throw new Error(spec.message || '');
        }
        return require('../../services/exchanges/transport').parseJsonPy(spec.text);
      };
    },
  });
}

function makeLog() {
  const lines = [];
  const mk = (level) => (...a) => { lines.push([level, a.map(String).join(' ')]); };
  return { lines, debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), warn: mk('WARNING'), error: mk('ERROR') };
}

/**
 * @param {object} sc        scenario
 * @param {Function} create  (overrides) → trader instance
 * @param {Function} invoke  (trader, sc) → Promise<result>
 * @param {Function} [prepare] (trader, sc, ctx) hook to seed exchange-specific state
 * @param {object} [opts]    { allHeaders } — also record every passed header per request (`hdrs`)
 */
async function runScenario(sc, create, invoke, prepare, opts = {}) {
  const clock = makeClock(sc.clock ?? 1767225600.0, 1000.0);
  const randoms = (sc.random || []).slice();
  const router = new Router(sc.routes, { allHeaders: Boolean(opts.allHeaders) });
  const state = sc.state || {};
  const log = makeLog();
  const kv = memoryKv();
  const saved = { hedge_saved: [], auth_reset: [], events: [], metrics: [] };
  const full = { metrics: [], events: [] };
  const origSet = kv.set;
  kv.set = (k, v) => { if (String(k).startsWith('bybit_mode:')) saved.hedge_saved.push(v === '1'); origSet(k, v); };
  if (state.kv_hedge !== undefined && state.kv_hedge !== null) {
    origSet(`bybit_mode:${apiKeyHash(sc.args[0])}`, state.kv_hedge ? '1' : '0');
  }
  const overrides = {
    transport: makeTransport(router),
    now: clock.now,
    monotonic: clock.monotonic,
    sleep: clock.sleep,
    random: () => (randoms.length ? randoms.shift() : 0.5),
    log,
    kv,
    killswitch: { requireActive: async () => { if (state.ks_halted) throw Object.assign(new Error(state.ks_halted), { killswitchHalted: true, state: state.ks_halted }); } },
    planGate: { denyReason: async () => (state.plan_deny === undefined ? null : state.plan_deny) },
    metrics: {
      record: async (name, value = 1.0, tags = null) => {
        saved.metrics.push(name);
        full.metrics.push(JSON.parse(JSON.stringify([name, value, tags === undefined ? null : tags])));
      },
    },
    events: {
      emit: (tid, evt, payload = null) => {
        saved.events.push([tid, evt]);
        full.events.push(JSON.parse(JSON.stringify([tid, evt, payload === undefined ? null : payload])));
      },
    },
    onAuthReset: async () => { const uids = state.auth_uids || []; for (const u of uids) saved.auth_reset.push([u, false]); return uids; },
    env: {},
  };
  if (sc.mode === 'session') overrides.sessionFactory = (k, s, demo) => makeFakeSession(router, demo);
  const trader = create(overrides);
  if (prepare) await prepare(trader, sc, { clock, router, state });
  const out = { name: sc.name };
  try {
    out.result = await invoke(trader, sc, { clock, router, state });
  } catch (e) {
    out.raised = { type: e.pyType || e.name, msg: e.message };
  }
  out.requests = router.log;
  out.sleeps = clock.sleeps;
  out.clock_end = clock.t;
  out.markers = [];
  for (const [lvl, msg] of log.lines) for (const m of msg.match(MARKER_RE) || []) out.markers.push([lvl, m]);
  out.saved = saved;
  out.full_metrics = full.metrics;
  out.full_events = full.events;
  out.logLines = log.lines;
  return { out, trader, kv };
}

module.exports = { Router, makeTransport, makeFakeSession, runScenario, MARKER_RE };
