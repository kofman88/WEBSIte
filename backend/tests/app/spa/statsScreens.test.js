/**
 * [STATS-HONEST 2026-10] The site's Home stats / equity card / strategy rows and the Signals summary
 * bar (frontend/app/app.js) against the bot's own Mini App front end (miniapp/static/app.js of
 * 7e20066 + 51e8256).
 *
 * Fixture: gen/gen_spa_stats_vectors.js rendered the bot's statsBlock / equityCard / stratRow /
 * statWindow / summaryBar / isLive / finalR / liveR under node (harness.js: stub h(), fixed clock,
 * UTC dates) over every 200 dashboard / signals answer of the app data replay (the bot's real API
 * payloads) plus edge cases. The site's functions, cut out of frontend/app/app.js the same way,
 * must render the same trees. The bot's own review rules are pinned on top: final WIN RATE with the
 * wrapping «N из M закрытых», ИТОГ R after costs + «до комиссий», the real window («с 6 окт»),
 * equity foot labels ≤ 11 characters («+ / 0 / −» with the full name in title), «В плюсе» =
 * final_wins (BE is not a plus), open vs closed Σ R, «последние 50».
 *
 * Regenerate: node tests/app/spa/gen/gen_spa_stats_vectors.js (after py/drive_app_data.py).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
const H = nodeRequire('./harness.js');
const ROOT = path.join(process.cwd(), '..');
const APP_JS = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'app.js'), 'utf8');
const APP_CSS = fs.readFileSync(path.join(ROOT, 'frontend', 'app', 'app.css'), 'utf8');
const V = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(process.cwd(), 'tests', 'app', 'spa', 'fixtures', 'spa_stats_vectors.json.gz'))).toString('utf8'));
const site = H.load(APP_JS);

const byClass = (tree, cls) => H.findAll(tree, (n) => n.attrs && typeof n.attrs.class === 'string' && n.attrs.class.split(' ').includes(cls));

describe('[STATS-HONEST] Home and Signals screens render like the bot\'s Mini App', () => {
  it(`${V.home.length} dashboards (the bot's API answers + edge cases): stats block, equity card, strategy rows, window`, () => {
    expect(V.home.length).toBeGreaterThanOrEqual(25);
    for (const c of V.home) expect(site.render(c), c.name).toEqual(c.out);
  });

  it(`${V.lists.length} signal lists: summary bar, isLive / finalR / liveR per card`, () => {
    expect(V.lists.length).toBeGreaterThanOrEqual(40);
    for (const c of V.lists) expect(site.bar(c.items), c.name).toEqual(c.out);
  });

  it('WIN RATE = final trades with the wrapping «N из M закрытых»; ИТОГ R net with «до комиссий»', () => {
    const c = V.home.find((x) => x.name === 'dashboard 117 honest');
    const r = site.render(c);
    const st = c.stats;
    const subs = byClass(r.stats, 'stat-sub');
    expect(subs[0].attrs.class).toBe('stat-sub wrap');
    expect(H.textOf(subs[0])).toBe(`${st.final_wins} из ${st.final_trades} закрытых`);
    expect(H.textOf(byClass(r.stats, 'stat-val')[0])).toBe(`${st.final_win_rate.toFixed(1)}%`);
    expect(H.textOf(subs[1])).toMatch(/^до комиссий [+−]/);
    expect(subs[1].attrs.title).toBe(`Без комиссий и проскальзывания (${st.cost_pct}% цены на сделку)`);
    // the old backend falls back to the gross fields and shows no «до комиссий» line
    const old = site.render(V.home.find((x) => x.name.startsWith('old backend')));
    expect(byClass(old.stats, 'stat-sub').map((n) => H.textOf(n)).some((t) => t.startsWith('до комиссий'))).toBe(false);
  });

  it('equity foot: labels fit a third of a 320 px card (≤ 11 chars), «+ / 0 / −» with the full name in title', () => {
    const c = V.home.find((x) => x.name === 'dashboard 117 honest');
    const foot = byClass(site.render(c).equity, 'eq-foot')[0];
    const cells = foot.children;
    const labels = cells.map((cell) => H.textOf(byClass(cell, 'label')[0]));
    expect(labels).toEqual(['Открыто', 'Лучший', '+ / 0 / −']);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(11);
    expect(cells[2].attrs.title).toBe('Плюс / ноль / минус');
    expect(H.textOf(cells[2].children[1])).toBe(`${c.stats.final_wins} / ${c.stats.final_be} / ${c.stats.final_losses}`);
    expect(H.textOf(cells[0].children[1])).toBe(String(c.stats.open_live));
  });

  it('the real window: «с 6 окт» while the data is younger than the window, else «за 30 дн.» / «30д»', () => {
    const w = Object.fromEntries(V.home.map((c) => [c.name, [c.out.window, c.out.window_short]]));
    expect(w['first_ts 4 d ago'][0]).toMatch(/^с \d+ [а-я]{3}$/);
    expect(w['first_ts 4 d ago'][0]).toBe(w['first_ts 4 d ago'][1]);
    expect(w['first_ts 31 d ago']).toEqual(['за 30 дн.', '30д']);
    expect(w['first_ts null']).toEqual(['за 30 дн.', '30д']);
    expect(w['days 7, first_ts 3 d ago'][0]).toMatch(/^с /);
  });

  it('«В плюсе» = final_wins (BE at +0.02R is «ноль»), Σ R split into closed (net) and open (now)', () => {
    const ref = V.lists.find((x) => x.name.startsWith('refuters'));
    const bar = site.bar(ref.items).bar;
    const plus = bar.children[2];
    expect(H.textOf(plus)).toBe('В плюсе1/2');
    expect(plus.attrs.title).toBe('Закрытые с R > 0 до комиссий; БУ — не в плюсе (как WIN RATE на Главной)');
    expect(H.textOf(byClass(bar, 'sumbar-r')[0])).toBe('Σ Rзакрытые +3.5R · открытые —');
    const mix = site.bar(V.lists.find((x) => x.name.startsWith('exchange-closed')).items);
    expect(mix.rows.map((x) => x.live)).toEqual([false, true, true, false, false]);
    expect(mix.rows[2].live_r).toBeCloseTo(0.5, 12);          // r from sl0 after BE (sl == entry)
  });

  it('Signals: «последние 50» window, request limit, CSS of the new pieces', () => {
    expect(V.sig_limit).toBe('50');
    expect(APP_JS).toContain('var SIG_LIMIT = 50;');
    expect(APP_JS).toContain('"&limit=" + SIG_LIMIT');
    expect(APP_JS).toContain('h("p", { class: "hint sig-window", text: "последние " + SIG_LIMIT })');
    for (const rule of ['.stat-sub.wrap {', '.sumbar { grid-template-columns: repeat(3, minmax(0, 1fr));',
      '.sumbar > .sumbar-r {', '.sumbar-rv {', '.sumbar-rv b {', '.eq-cap {', '.sig-window {']) {
      expect(APP_CSS, rule).toContain(rule);
    }
  });
});
