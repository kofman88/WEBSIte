/**
 * The landing's data-source switch (frontend/landing/landing.js + README.md), checked statically:
 *   • DATA_SOURCE per endpoint: 'api' where /api/public/<path> exists (trend, stats, feed), 'mock'
 *     for the product-layer endpoints that do not exist yet (showcase, sandbox, genome);
 *   • while any endpoint is 'mock', index.html keeps robots noindex and the «Прототип · тестовые
 *     данные» pill (hidden by landing.js only when every source is 'api');
 *   • every status / path element the API returns has a label in the feed renderer;
 *   • the weight budget of / (< 250 000 bytes) and one cache-busting version everywhere.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FRONT = path.join(process.cwd(), '..', 'frontend');
const read = (p) => fs.readFileSync(path.join(FRONT, p), 'utf8');
const JS = read('landing/landing.js');
const INDEX = read('index.html');
const PRICING = read('pricing/index.html');
const README = read('landing/README.md');
const ROUTES = fs.readFileSync(path.join(process.cwd(), 'routes', 'publicLanding.js'), 'utf8');

function dataSource() {
  const m = /const DATA_SOURCE = \{([^}]*)\};/.exec(JS);
  expect(m, 'DATA_SOURCE object').not.toBeNull();
  return Object.fromEntries([...m[1].matchAll(/(\w+): '(\w+)'/g)].map((x) => [x[1], x[2]]));
}

describe('data source per endpoint', () => {
  it('api for trend / stats / feed, mock for showcase / sandbox / genome', () => {
    expect(dataSource()).toEqual({ trend: 'api', stats: 'api', feed: 'api', showcase: 'mock', sandbox: 'mock', genome: 'mock' });
  });

  it('every endpoint landing.js asks for has a source; every api source is a route of routes/publicLanding.js', () => {
    const used = new Set([...JS.matchAll(/api1?\('(\w+)'/g)].map((m) => m[1]));
    const src = dataSource();
    expect([...used].sort()).toEqual(Object.keys(src).sort());
    const routes = [...ROUTES.matchAll(/^router\.get\('([^']+)'/gm)].map((m) => m[1]);
    expect(routes).toEqual(['/trend', '/stats', '/feed']);
    for (const [p, s] of Object.entries(src)) {
      if (s === 'api') expect(routes, p).toContain(`/${p}`);
      else expect(routes, p).not.toContain(`/${p}`);
    }
  });

  it('?data= still overrides every endpoint; the pill hides only when ALL sources are api', () => {
    expect(JS).toContain("const MODE = { empty: 'empty', api: 'api', mock: 'mock' }[QS.get('data')], SRC = (p) => MODE || DATA_SOURCE[p]");
    expect(JS).toContain("ALL_API = Object.keys(DATA_SOURCE).every((p) => SRC(p) === 'api')");
    expect(JS).toContain("if (ALL_API) { $$('#proto, #ftr-src')");
    expect(JS).not.toMatch(/MODE === 'api'/);
  });

  it('noindex and the prototype pill stay while any block is mock', () => {
    expect(Object.values(dataSource())).toContain('mock');
    expect(INDEX).toContain('<meta name="robots" content="noindex,follow"/>');
    expect(INDEX).toMatch(/<span class="proto" id="proto"[^>]*>Прототип · тестовые данные<\/span>/);
    expect(INDEX).toMatch(/<span id="ftr-src">Прототип: [^<]+<\/span>/);
  });
});

describe('feed renderer knows every public status', () => {
  it('path elements and statuses produced by services/publicTrack/view.js have labels', () => {
    const pth = /const PTH = \{([^}]*)\};/.exec(JS)[1];
    const labels = new Set([...pth.matchAll(/(\w+): \[/g)].map((m) => m[1]));
    for (const p of ['open', 'tp1', 'tp2', 'tp3', 'be', 'sl', 'exp', 'missed']) expect(labels, p).toContain(p);
    expect(JS).toContain("const live = (it) => it.status === 'open' || it.status === 'tp1';");
    // a closed signal without R (exp without mark-to-market, missed) reads «—», not «в сделке»
    expect(JS).toContain(": live(it) ? ['amber', it.status === 'tp1' ? 'стоп в БУ' : 'в сделке'] : ['', '—']");
    for (const s of ['open', 'tp1', 'tp1be', 'tp2be', 'tp3', 'sl', 'exp', 'missed']) expect(README, s).toContain(s);
  });

  it('ticker: unknown strength or 24 h change reads «—», never 0', () => {
    expect(JS).toContain("${s.strength == null ? '—' : s.strength + '%'}");
    expect(JS).toContain("${x == null ? '—' : fP(x, 2)}");
  });
});

describe('the landing renders real API payloads (its own render functions, run in a VM)', () => {
  // the helpers and the feed / ticker renderers of landing.js, verbatim
  const lines = JS.split('\n');
  const pick = (re) => lines.filter((l) => re.test(l));
  const from = lines.findIndex((l) => l.startsWith(' const cells = (t) =>'));
  const to = lines.findIndex((l, i) => i > from && l.startsWith(" }).join('') + ['BTC', 'ETH']"));
  const code = [
    ...pick(/^const (esc|MI|num|sgn|fR|p2|hm|TFN|PTH) = /),
    ...pick(/^ const (live|chain|res|sr|row) = \(it\) =>/),
    ...lines.slice(from, to + 1),
    '({ row, res, chain, cells });',
  ].join('\n');
  const R = vm.runInNewContext(code, {});
  const { T0, makeDb, insertSignal, setStage, makeTrack, body } = require('./helpers.js');

  it('every public status of a real feed renders; closed without R → «—», never «в сделке»', () => {
    const db = makeDb();
    const clock = { t: T0 };
    let k = 0;
    const mk = (stage, extra = {}, rowExtra = {}) => {
      const r = insertSignal(db, { created_at: T0 + (k += 10), ...rowExtra });
      if (stage) setStage(db, r.trade_id, stage, T0 + 1200, extra);
      return r;
    };
    mk('');
    mk('TP1');
    mk('TP2');
    mk('TP3');
    mk('SL');
    mk('BE');
    mk('EXPIRED', { expire_rr: 0.42 });
    mk('EXPIRED', { expire_rr: null });
    mk('MISSED', {}, { entry_lo: 99, entry_hi: 100.5, strategy: 'SMC' });
    clock.t = T0 + 5 * 3600;
    const items = body(makeTrack(db, clock).feed()).items;
    const by = (s) => items.filter((x) => x.status === s);
    expect(new Set(items.map((x) => x.status))).toEqual(new Set(['open', 'tp1', 'tp3', 'sl', 'tp1be', 'exp', 'missed']));
    for (const it of items) {
      const html = R.row(it);
      expect(html).not.toMatch(/undefined|null|NaN/);
    }
    expect(R.res(by('missed')[0])).toEqual(['', '—']);
    expect(R.row(by('missed')[0])).toContain('БЕЗ ВХОДА');
    const exps = by('exp').map((x) => R.res(x));
    expect(exps).toContainEqual(['', '—']);
    expect(exps).toContainEqual(['up', '+0,31R']);           // 0.42 − 0.11
    const tp2running = by('tp1').find((x) => x.path.includes('tp2'));
    expect(R.res(tp2running)).toEqual(['amber', 'стоп в БУ']);
    expect(R.chain(tp2running)).toMatch(/class="pth live">TP2<\/span>$/);
    expect(R.res(by('sl')[0])).toEqual(['loss', '−1,11R']);
    expect(R.res(by('open')[0])).toEqual(['amber', 'в сделке']);
  });

  it('the ticker renders a trend payload with unknown strength / change as «—»', () => {
    const t = {
      tfs: { '15m': { trend: 'LONG', strength: 71, since: 1 }, '1H': { trend: 'SHORT', strength: null, since: null }, '4H': { trend: 'RANGE', strength: 0, since: 1 } },
      change_24h: { BTC: 1.23, ETH: null },
    };
    const html = R.cells(t);
    expect(html).not.toMatch(/undefined|null|NaN/);
    expect(html).toContain('71%');
    expect(html).toContain('<span class="val">0%</span>');
    expect(html).toContain('<span class="val ">—</span>');
    expect(html).toContain('+1,23%');
  });
});

describe('deploy rules of the README', () => {
  it('the page weight of / stays under 250 000 bytes (HTML + CSS + JS with the mock and Metrika)', () => {
    const files = ['index.html', 'landing/landing.css', 'landing/landing.js', 'landing/data/mock-api.js', 'yandex-metrika.js'];
    const total = files.reduce((s, f) => s + fs.statSync(path.join(FRONT, f)).size, 0);
    expect(total).toBeLessThan(250000);
  });

  it('one cache-busting version in every reference', () => {
    const vs = new Set();
    for (const [name, text] of [['index', INDEX], ['pricing', PRICING], ['landing.js', JS]]) {
      const refs = [...text.matchAll(/(landing\.css|landing\.js|mock-api\.js|support-widget\.js)\?v=(\d+)/g)];
      expect(refs.length, name).toBeGreaterThan(0);
      for (const r of refs) vs.add(r[2]);
    }
    expect([...vs]).toHaveLength(1);
    expect(README).toContain(`landing.js?v=${[...vs][0]}`);
  });
});
