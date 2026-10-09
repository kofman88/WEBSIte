'use strict';
/**
 * compare.js — run one wire_diff vector through tests/autotrade/wire/harness.js and diff it against
 * the bot's recording: results, per task the ordered requests (normalised) / messages / logs /
 * trader log markers / side effects / metrics, and the trades / users / kv / trade_events / hedge
 * mode tables. Used by wireDiff.test.js; runnable by hand:
 *   node tests/autotrade/wire/compare.js [fixture.json.gz] [name …]
 */

const { loadFixture, buildWireEnv, byTask, FIXTURE } = require('./harness');

const norm = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

/** The comparable view of one rec (the bot's req recs also carry the answer they got). */
function view(kind, data) {
  if (kind === 'req') {
    const r = { ...data.req };
    delete r.client;
    delete r.unhandled;
    return [kind, r];
  }
  // int((monotonic() - t0) * 1000) over a sum of virtual sleeps: the two clocks may round the last
  // millisecond differently (float accumulation order) — compared to the 2 ms bucket
  if (kind === 'metric' && data[0] === 'trade_placement_latency_ms' && typeof data[1] === 'number') {
    return [kind, [data[0], Math.round(data[1] / 2) * 2, data[2]]];
  }
  if (kind === 'log' && typeof data[1] === 'string' && data[1].startsWith('[SKIP-AFTER-TP-PLACED]')) {
    return [kind, [data[0], data[1].split('logging call stack:')[0]]];
  }
  return [kind, data];
}

function firstDiff(a, b, p = '$') {
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
    if (typeof a === 'number' && typeof b === 'number' && (a === b || (Number.isNaN(a) && Number.isNaN(b)))) return null;
    return a === b ? null : `${p}: expected ${JSON.stringify(a)} got ${JSON.stringify(b)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array/object mismatch`;
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (i >= a.length) return `${p}[${i}]: unexpected ${JSON.stringify(b[i])}`;
      if (i >= b.length) return `${p}[${i}]: missing ${JSON.stringify(a[i])}`;
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) return `${p}.${k}: unexpected ${JSON.stringify(b[k])}`;
    if (!(k in b)) return `${p}.${k}: missing ${JSON.stringify(a[k])}`;
    const d = firstDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}

async function replay(vector, opts = {}) {
  const c = { ...vector.case, _expected_recs: vector.expected.recs };
  const env = buildWireEnv(c, opts);
  const results = await env.run();
  const dump = env.dump();
  return { results: norm(results), recs: norm(env.recs), ...norm(dump), env };
}

/**
 * execute_auto_trade._cb_warned: the "Circuit Breaker disabled" WARNING is logged once per process by
 * whichever call reaches the gate first — with parallel calls that is a scheduling race (the bot's
 * aiosqlite threads), so it is compared as a count over all tasks, not per task.
 */
const ONCE_PER_PROCESS = (k, d) => k === 'log' && typeof d[1] === 'string' && d[1].startsWith('⚠️  Circuit Breaker ОТКЛЮЧЁН');

/** trade_events grouped per trade (the global interleaving of concurrent tasks is not data). */
function eventsByTrade(events) {
  const out = {};
  for (const e of events || []) (out[e[0]] = out[e[0]] || []).push(e);
  return out;
}

function compare(vector, got) {
  const exp = vector.expected;
  const diffs = [];
  const d0 = firstDiff(norm(exp.results), got.results, 'results');
  if (d0) diffs.push(d0);
  const onceE = exp.recs.filter(([, k, d]) => ONCE_PER_PROCESS(k, d)).map(([, k, d]) => view(k, d));
  const onceG = got.recs.filter(([, k, d]) => ONCE_PER_PROCESS(k, d)).map(([, k, d]) => view(k, d));
  const dOnce = firstDiff(norm(onceE), onceG, 'once_per_process');
  if (dOnce) diffs.push(dOnce);
  const et = byTask(exp.recs.filter(([, k, d]) => !ONCE_PER_PROCESS(k, d)).map(([t, k, d]) => [t, ...view(k, d)]));
  const gt = byTask(got.recs.filter(([, k, d]) => !ONCE_PER_PROCESS(k, d)).map(([t, k, d]) => [t, ...view(k, d)]));
  for (const t of new Set([...Object.keys(et), ...Object.keys(gt)])) {
    const d = firstDiff(norm(et[t] || []), gt[t] || [], `recs[${t}]`);
    if (d) diffs.push(d);
  }
  for (const k of ['trades', 'users', 'hedge']) {
    const d = firstDiff(norm(exp[k]), got[k], k);
    if (d) diffs.push(d);
  }
  // parallel calls draw the idempotency uuid (a process-wide counter here) in lock-arrival order
  const kvView = (kv) => {
    if (!vector.case.parallel) return kv;
    const out = {};
    for (const [k, v] of Object.entries(kv || {})) out[k.replace(/^(idemp_v1_.*_\d+)_[0-9a-f]{8}$/, '$1_*')] = v;
    return out;
  };
  const dKv = firstDiff(kvView(norm(exp.kv)), kvView(got.kv), 'kv');
  if (dKv) diffs.push(dKv);
  const dEv = firstDiff(eventsByTrade(norm(exp.events)), eventsByTrade(got.events), 'events');
  if (dEv) diffs.push(dEv);
  return diffs;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args[0] && args[0].endsWith('.gz') ? args.shift() : FIXTURE;
  const fx = loadFixture(file);
  const only = args;
  let bad = 0;
  let n = 0;
  for (const v of fx.vectors) {
    if (only.length && !only.some((o) => v.case.name === o || (o.endsWith('*') && v.case.name.startsWith(o.slice(0, -1))))) continue;
    n += 1;
    let diffs;
    try {
      diffs = compare(v, await replay(v));
    } catch (e) {
      diffs = [`THREW ${e && e.stack}`];
    }
    if (diffs.length) {
      bad += 1;
      console.log(`✗ ${v.case.name}`);
      for (const d of diffs.slice(0, 8)) console.log(`    ${d.slice(0, 900)}`);
    } else if (only.length) {
      console.log(`✓ ${v.case.name}`);
    }
  }
  console.log(`${bad} failing of ${n}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { replay, compare, firstDiff, view };
