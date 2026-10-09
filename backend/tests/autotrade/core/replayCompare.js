'use strict';
/**
 * replayCompare.js — run one fixture vector through the JS executor and diff it against the
 * bot's recorded outcome (results, per-task trader calls / messages / side effects / logs, DB
 * rows, kv, trade_events). Used by executeReplay.test.js and runnable by hand:
 *   node tests/autotrade/core/replayCompare.js [case-name …]
 */

const { loadFixture, buildEnv, byTask } = require('./harness');

const norm = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

/** [SKIP-AFTER-TP-PLACED] carries the caller's stack (Python vs JS frames) — keep the prefix. */
function normRecs(recs) {
  return recs.map(([t, kind, data]) => {
    if (kind === 'log' && typeof data[1] === 'string' && data[1].startsWith('[SKIP-AFTER-TP-PLACED]')) {
      return [t, kind, [data[0], data[1].split('logging call stack:')[0]]];
    }
    return [t, kind, data];
  });
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

async function replay(vector, fx, opts = {}) {
  const env = buildEnv(vector.case, fx, opts);
  const results = await env.run();
  const dump = env.dump();
  return { results: norm(results), recs: norm(normRecs(env.recs)), ...norm(dump), env };
}

function compare(vector, got) {
  const exp = vector.expected;
  const diffs = [];
  const d0 = firstDiff(norm(exp.results), got.results, 'results');
  if (d0) diffs.push(d0);
  const et = byTask(normRecs(exp.recs));
  const gt = byTask(got.recs);
  for (const t of new Set([...Object.keys(et), ...Object.keys(gt)])) {
    const d = firstDiff(norm(et[t] || []), gt[t] || [], `recs[${t}]`);
    if (d) diffs.push(d);
  }
  for (const k of ['trades', 'users', 'kv', 'events']) {
    const d = firstDiff(norm(exp[k]), got[k], k);
    if (d) diffs.push(d);
  }
  return diffs;
}

async function main() {
  const fx = loadFixture();
  const only = process.argv.slice(2);
  let bad = 0;
  for (const v of fx.vectors) {
    if (only.length && !only.includes(v.case.name)) continue;
    let diffs;
    try {
      diffs = compare(v, await replay(v, fx, { via: process.env.REPLAY_VIA || 'executor' }));
    } catch (e) {
      diffs = [`THREW ${e && e.stack}`];
    }
    if (diffs.length) {
      bad += 1;
      console.log(`✗ ${v.case.name}`);
      for (const d of diffs.slice(0, 6)) console.log(`    ${d.slice(0, 700)}`);
    } else if (only.length) {
      console.log(`✓ ${v.case.name}`);
    }
  }
  console.log(`${bad} failing of ${only.length ? only.length : fx.vectors.length}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { replay, compare, firstDiff, normRecs };
