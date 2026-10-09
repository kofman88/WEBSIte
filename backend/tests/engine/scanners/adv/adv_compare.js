/**
 * adv_compare — puts the driver's observations (bot) and the replay's (site) into one shape and
 * lists every difference: per step (deliveries, logs, REST calls, charts, auto-trade calls,
 * metrics, smart prompts, sleeps, inserted trade ids, the persisted registry) and per tick
 * (signal_trades rows on every shared column, trade_events, kv, trader_settings on every shared
 * column, optimizer_params, scanner / pipeline state).
 *
 * Site ↔ bot mappings applied here (not differences):
 *   signal_card_json  bot {"html", "kb"} ↔ site cardSnapshot {html, actions, lang}: html + Telegram keyboard
 *   kv                site engine_kv `signal_registry` = the bot's signal_registry.json (compared per step)
 *   registry_state    the in-memory registry after each step: compared exactly (key → timestamp)
 *   registry_file     the persisted registry (10 s debounce → the first write of a tick saves):
 *                     both sides must write it in the same steps; compared as a key → timestamp
 *                     map. SMC commits its slots inside the background card tasks (commit_send
 *                     after the send), so a file saved during the SMC step is a snapshot taken
 *                     somewhere inside the task interleaving: it is checked for consistency
 *                     (fileInconsistency) on each side instead of entry by entry
 *   users / trades    compared on the columns both schemas have
 */
'use strict';

const path = require('path');

const BACKEND = path.join(__dirname, '..', '..', '..', '..');
const { toTelegram } = require(path.join(BACKEND, 'services/engine/cards/keyboards.js'));

function card(json, site) {
  if (!json) return json === undefined ? null : json;
  let d;
  try { d = JSON.parse(json); } catch (_e) { return { raw: json }; }
  return site ? { html: d.html, kb: d.actions ? toTelegram(d.actions) : null } : { html: d.html, kb: d.kb === undefined ? null : d.kb };
}

/** first difference between two JSON values → [path, a, b] | null */
function firstDiff(a, b, p = '') {
  if (a === b) return null;
  if (typeof a === 'number' && typeof b === 'number' && Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return [p, a, b];
  if (Array.isArray(a) !== Array.isArray(b)) return [p, a, b];
  if (Array.isArray(a)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length || i >= b.length) return [`${p}[${i}]`, i < a.length ? a[i] : '<missing>', i < b.length ? b[i] : '<missing>'];
      const d = firstDiff(a[i], b[i], `${p}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    if (!(k in a)) return [`${p}.${k}`, '<missing>', b[k]];
    if (!(k in b)) return [`${p}.${k}`, a[k], '<missing>'];
    const d = firstDiff(a[k], b[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}

const STEP_FIELDS = ['sent', 'logs', 'rest', 'charts', 'at', 'metrics', 'prompts', 'sleeps', 'new_trades', 'registry_state'];

function tradeRows(rows, cols, site) {
  return rows.map((r) => {
    const o = {};
    for (const c of cols) o[c] = c === 'signal_card_json' ? card(r[c], site) : (r[c] === undefined ? null : r[c]);
    return o;
  });
}

/**
 * The SMC cycle hands every card to a background task (`_send_smc_card_bg`: counter-trend gate,
 * auto-trade, the card, the commit, the chart, "SMC ✅"). In the bot those tasks interleave with
 * the scan loop wherever asyncio switches (aiosqlite threads, wait_for, the Telegram round trip),
 * so their order relative to the loop — and to each other — is not part of the bot's behaviour.
 * For the SMC step the background effects are compared as multisets; the scan loop's own log
 * stream stays ordered.
 */
const SMC_BG_LOG = /^(SMC AUTO-TRADE BLOCK|SMC AUTO-TRADE RESULT|SMC ✅|\[REVERSAL-OVERRIDE\]|SMC auto_trade uid=|SMC send |Telegram flood control|\[NOTIF-FAIL\] silent exc smc limit_msg)/;
const isSmcBgLog = (l) => l[0] === 'CHM.TgSafe' || SMC_BG_LOG.test(l[2])
  || (l[2].startsWith('[FILTER-BLOCK]') && l[2].includes('strategy=SMC gate=counter_trend_scanner'));
const sortedCanon = (list) => (list || []).map((x) => JSON.stringify(x)).sort();

/** Normalised view of one tick: {steps: [...], tick: {...}} */
function viewTick(t, { site, tradeCols, userCols }) {
  const steps = t.steps.map((s) => {
    const o = {};
    for (const f of STEP_FIELDS) o[f] = s[f] === undefined ? null : s[f];
    o.step = s.step;
    o.registry_file = s.registry_file === undefined ? null : s.registry_file;
    if (typeof o.registry_file === 'string') {
      try { o.registry_file = JSON.parse(o.registry_file); } catch (_e) { /* unparsable: compared as text */ }
    }
    if (s.step === 'SMC') {
      o.sent = sortedCanon(o.sent);
      o.at = sortedCanon(o.at);
      o.charts = sortedCanon(o.charts);
      o.logs = { loop: (o.logs || []).filter((l) => !isSmcBgLog(l)), bg: sortedCanon((o.logs || []).filter(isSmcBgLog)) };
    }
    return o;
  });
  const kv = {};
  for (const [k, v] of Object.entries(t.kv || {})) if (k !== 'signal_registry') kv[k] = v;
  const users = (t.users || []).map((u) => {
    const o = {};
    for (const c of userCols) o[c] = u[c] === undefined ? null : (typeof u[c] === 'boolean' ? Number(u[c]) : u[c]);
    return o;
  });
  return {
    steps,
    tick: {
      trades: tradeRows(t.trades || [], tradeCols, site),
      events: t.events || [],
      kv,
      users,
      opt: t.opt || [],
      state: t.state || {},
    },
  };
}

/** Compare the bot ticks (FIX.expected) with the site ticks (replay out) → list of differences. */
const canonFile = (f) => (f && typeof f === 'object' ? JSON.stringify(Object.keys(f).sort().map((k) => [k, f[k]])) : JSON.stringify(f));

/** A registry file saved during a step: every entry the step left untouched (same value before
 * and after) is present with that value, and every other entry is a key the registry held before
 * or after the step (its value may be an intermediate one: claim_multi's provisional slot is
 * overwritten by commit_send_multi in the same step). → null | the first offending [key, value]. */
function fileInconsistency(file, pre, post) {
  if (!file || typeof file !== 'object') return ['<file>', file];
  const has = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);
  const untouched = (k) => has(pre, k) && has(post, k) && Object.is(pre[k], post[k]);
  for (const [k, v] of Object.entries(file)) {
    if (untouched(k) ? !Object.is(pre[k], v) : !(has(pre, k) || has(post, k))) return [k, v];
  }
  for (const k of Object.keys(pre || {})) {
    if (untouched(k) && !has(file, k)) return [k, '<missing>'];
  }
  return null;
}

function compareRegistryFile(diffs, tick, es, as, prev) {
  const eChanged = canonFile(es.registry_file) !== canonFile(prev.e.file);
  const aChanged = canonFile(as.registry_file) !== canonFile(prev.a.file);
  if (eChanged !== aChanged) {
    diffs.push({ tick, step: es.step, field: 'registry_file', path: 'written', bot: eChanged, site: aChanged });
  } else if (eChanged && es.step === 'SMC') {
    const eBad = fileInconsistency(es.registry_file, prev.e.state, es.registry_state);
    const aBad = fileInconsistency(as.registry_file, prev.a.state, as.registry_state);
    if (eBad || aBad) diffs.push({ tick, step: es.step, field: 'registry_file', path: 'snapshot', bot: eBad, site: aBad });
  } else if (eChanged) {
    const d = firstDiff(es.registry_file, as.registry_file);
    if (d) diffs.push({ tick, step: es.step, field: 'registry_file', path: d[0], bot: d[1], site: d[2] });
  }
  prev.e = { file: es.registry_file, state: es.registry_state };
  prev.a = { file: as.registry_file, state: as.registry_state };
}

function compare(expected, actual, { limit = 200 } = {}) {
  const diffs = [];
  const prev = { e: { file: null, state: {} }, a: { file: null, state: {} } };
  const n = Math.max(expected.length, actual.length);
  const siteTradeCols = (actual[0] && actual[0].tradeCols) || [];
  const siteUserCols = (actual[0] && actual[0].userCols) || [];
  const pyTradeCols = expected[0] && expected[0].trades && expected[0].trades[0] ? Object.keys(expected[0].trades[0]) : siteTradeCols;
  const pyUserCols = expected[0] && expected[0].users && expected[0].users[0] ? Object.keys(expected[0].users[0]) : siteUserCols;
  const tradeCols = siteTradeCols.filter((c) => pyTradeCols.includes(c));
  const userCols = siteUserCols.filter((c) => pyUserCols.includes(c));
  for (let i = 0; i < n && diffs.length < limit; i++) {
    if (!expected[i] || !actual[i]) { diffs.push({ tick: i, what: 'tick missing' }); continue; }
    const E = viewTick(expected[i], { site: false, tradeCols, userCols });
    const A = viewTick(actual[i], { site: true, tradeCols, userCols });
    const ns = Math.max(E.steps.length, A.steps.length);
    for (let s = 0; s < ns; s++) {
      const es = E.steps[s];
      const as = A.steps[s];
      if (!es || !as) { diffs.push({ tick: i, step: (es || as).step, what: 'step missing' }); continue; }
      for (const f of STEP_FIELDS) {
        const d = firstDiff(es[f], as[f]);
        if (d) diffs.push({ tick: i, step: es.step, field: f, path: d[0], bot: d[1], site: d[2] });
      }
      compareRegistryFile(diffs, i, es, as, prev);
    }
    for (const f of ['trades', 'events', 'kv', 'users', 'opt']) {
      const d = firstDiff(E.tick[f], A.tick[f]);
      if (d) diffs.push({ tick: i, field: f, path: d[0], bot: d[1], site: d[2] });
    }
    for (const k of new Set([...Object.keys(E.tick.state), ...Object.keys(A.tick.state)])) {
      const d = firstDiff(E.tick.state[k], A.tick.state[k]);
      if (d) diffs.push({ tick: i, field: `state.${k}`, path: d[0], bot: d[1], site: d[2] });
    }
  }
  return { diffs, tradeCols, userCols };
}

module.exports = { compare, firstDiff, card, viewTick, STEP_FIELDS };
