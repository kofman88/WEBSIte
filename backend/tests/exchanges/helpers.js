'use strict';
/**
 * Shared helpers for the exchange-trader tests: fixture loading (with the NaN/inf
 * encoding of the Python generators), a deterministic clock and a log capture.
 *
 * Fixtures are produced by the bot's own Python code — see py/README.md for the
 * generator commands (venv: scratchpad/venv/bin/python, cwd MAIN_BOT/CHM_BREAKER_V4,
 * env BOT_TOKEN_CHM=test:token ADMIN_IDS=123).
 */
const fs = require('fs');
const path = require('path');

function revive(o) {
  if (Array.isArray(o)) return o.map(revive);
  if (o && typeof o === 'object') {
    if (Object.keys(o).length === 1 && '__float__' in o) {
      const v = o.__float__;
      return v === 'nan' ? NaN : (v === 'inf' ? Infinity : -Infinity);
    }
    const out = {};
    for (const k of Object.keys(o)) out[k] = revive(o[k]);
    return out;
  }
  return o;
}

/** Same int64 policy as transport.parseJsonPy: integers beyond 2^53 → exact decimal strings. */
function bigIntReviver(_k, v, ctx) {
  if (typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx && /^-?\d+$/.test(ctx.source || '')) return ctx.source;
  return v;
}

function loadFixture(name) {
  const p = path.join(__dirname, 'fixtures', name);
  return revive(JSON.parse(fs.readFileSync(p, 'utf8'), bigIntReviver));
}

/** Fake clock: time.time()/time.monotonic() only advance on sleep (like the Python harness). */
function makeClock(start = 1767225600.0, mono = 1000.0) {
  const c = {
    t: start,
    m: mono,
    sleeps: [],
    now: () => c.t,
    monotonic: () => c.m,
    sleep: async (s) => { c.sleeps.push(s); c.t += s; c.m += s; },
  };
  return c;
}

/** Captures log lines: { level, msg }. */
function makeLog() {
  const lines = [];
  const mk = (level) => (...a) => { lines.push({ level, msg: a.map(String).join(' ') }); };
  return {
    lines,
    debug: mk('debug'), info: mk('info'), warning: mk('warning'), warn: mk('warning'), error: mk('error'),
    has: (re) => lines.some((l) => (re instanceof RegExp ? re.test(l.msg) : l.msg.includes(re))),
  };
}

module.exports = { loadFixture, revive, makeClock, makeLog };
