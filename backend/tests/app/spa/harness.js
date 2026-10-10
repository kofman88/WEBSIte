'use strict';
/**
 * Renders the Home / Signals stats pieces of an app.js (the bot's miniapp/static/app.js or the
 * site's frontend/app/app.js — the same IIFE layout) under node: the named top-level functions and
 * vars are cut out of the source, run in a vm with a stub `h()` that builds plain trees, a fixed
 * clock (`Date.now()` = the case's `nowMs`, local date getters = UTC) and stubs for DOM / navigation
 * helpers. Used by gen/gen_spa_stats_vectors.js (the bot's source → the fixture) and by
 * statsScreens.test.js (the site's source → must render the same trees).
 */

const vm = require('vm');

// the real pieces (pure helpers + the [STATS-HONEST] renderers) and the stubbed ones
const REAL = [
  'num', 'sign', 'fmtR', 'signCls', 'MONTHS_SHORT', 'statWindow', 'pick', 'isLong', 'statusKey', 'isLive',
  'rOf', 'finalR', 'liveR', 'label', 'bracket', 'rVal', 'STRATS', 'statsBlock', 'equityCard', 'stratRow', 'summaryBar',
];

function skipString(src, i, q) {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j + 1;
  }
  throw new Error('unterminated string');
}

function skipRegex(src, i) {
  let cls = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) {
      let k = j + 1;
      while (/[a-z]/i.test(src[k])) k++;
      return k;
    }
  }
  throw new Error('unterminated regex');
}

/** Index just past the end of the statement / block starting at `i` (`{` block or `= …;`). */
function scan(src, i, untilSemicolon) {
  let depth = 0;
  let prev = '(';
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'") { i = skipString(src, i, c); prev = 'a'; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === '/' && /[(,=:[!&|?{};]/.test(prev)) { i = skipRegex(src, i); prev = 'a'; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0 && !untilSemicolon && c === '}') return i + 1;
    } else if (c === ';' && depth === 0 && untilSemicolon) return i + 1;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  throw new Error('unterminated block');
}

/** The source text of the top-level `function name(…) {…}` or `var name = …;` of the IIFE. */
function extract(src, name) {
  const fn = src.indexOf(`\n  function ${name}(`);
  if (fn >= 0) {
    const open = src.indexOf('{', fn);
    return src.slice(fn + 1, scan(src, open, false));
  }
  const v = src.indexOf(`\n  var ${name} = `);
  if (v >= 0) return src.slice(v + 1, scan(src, v + 1 + `  var ${name} = `.length, true));
  throw new Error(`${name} not found in app.js`);
}

// ── stubs ──────────────────────────────────────────────────────────────────
/** h(tag, props, …children) like app.js h(): null / false props skipped, children flattened. */
function h(tag, props, ...children) {
  const node = { tag };
  if (props) {
    const attrs = {};
    for (const k of Object.keys(props)) {
      const v = props[k];
      if (v === null || v === undefined || v === false) continue;
      if (k.slice(0, 2) === 'on' && typeof v === 'function') attrs[k] = 'fn';
      else attrs[k] = v === true ? '' : String(v);
    }
    node.attrs = attrs;
  }
  const kids = [];
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) { c.forEach(add); return; }
    kids.push(typeof c === 'object' && c.tag ? c : String(c));
  };
  children.forEach(add);
  if (kids.length) node.children = kids;
  return node;
}

function makeDate(nowMs) {
  const Real = Date;
  class FixedDate extends Real {
    constructor(...a) { if (a.length) super(...a); else super(nowMs); }
    static now() { return nowMs; }
    getDate() { return this.getUTCDate(); }
    getMonth() { return this.getUTCMonth(); }
    getFullYear() { return this.getUTCFullYear(); }
    getHours() { return this.getUTCHours(); }
    getMinutes() { return this.getUTCMinutes(); }
    getDay() { return this.getUTCDay(); }
  }
  return FixedDate;
}

/** load(src) → render({nowMs, stats, cfg}) / bar(items) / probe(items) over that app.js source. */
function load(src) {
  const code = `(function () {\n${REAL.map((n) => extract(src, n)).join('\n')}\n`
    + `return { ${REAL.filter((n) => !/^[A-Z_]+$/.test(n)).join(', ')} };\n})()`;
  const script = new vm.Script(code, { filename: 'app.js#stats' });
  const make = (nowMs, S) => {
    const sandbox = {
      S, h, Math, Number, String, Array, Object, JSON, isFinite, isNaN, parseFloat, parseInt, Date: makeDate(nowMs),
      icon: (name) => h('i', { icon: name }),
      equityPlot: (eq) => h('svg', { plot: JSON.stringify(eq) }),
      shareResults() {}, hap() {}, setTab() {}, openDetail() {}, loadSignals() {},
      stratCfg: (k) => (S.cfg && S.cfg[k]) || { locked: false, enabled: true, primary: false },
      ratingLine: () => null, lsPills: () => null, stratStatusTags: () => null,
    };
    return script.runInNewContext(sandbox);
  };
  return {
    render({ nowMs, stats, cfg }) {
      const S = { dash: { stats }, cfg };
      const m = make(nowMs, S);
      return {
        stats: m.statsBlock(), equity: m.equityCard(),
        strat: { LEVELS: m.stratRow('LEVELS'), SMC: m.stratRow('SMC'), VOLUME: m.stratRow('VOLUME') },
        window: m.statWindow(stats), window_short: m.statWindow(stats, true),
      };
    },
    bar(items, nowMs = 0) {
      const m = make(nowMs, { dash: {} });
      return {
        bar: m.summaryBar(items),
        rows: items.map((x) => ({ live: m.isLive(x), final_r: m.finalR(x), live_r: m.liveR(x) })),
      };
    },
  };
}

/** Text of a tree (children text + `text` attrs, depth first). */
function textOf(node) {
  if (typeof node === 'string') return node;
  if (!node) return '';
  return ((node.attrs && node.attrs.text) || '') + (node.children || []).map(textOf).join('');
}

/** Every node of a tree matching `pred`. */
function findAll(node, pred, out = []) {
  if (node && typeof node === 'object') {
    if (pred(node)) out.push(node);
    for (const c of node.children || []) findAll(c, pred, out);
  }
  return out;
}

module.exports = { extract, load, h, textOf, findAll, REAL };
