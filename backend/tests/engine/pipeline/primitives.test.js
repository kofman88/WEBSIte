/**
 * Card primitives on Python vectors (fixtures/primitives.json, tools/gen_vectors.py `primitives`):
 *   quality_scale.levels_stars / stars_str, the three price formatters (smc.scanner._fp,
 *   signal_format._fmt_price, volume_scanner._fp), signal_format.format_signal_lite,
 *   watermark.wm_encode / wm_inject / wm_decode, position_size.position_line / compute / _usd
 *   (balance_cache faked, trend_monitor ctx multipliers at their defaults),
 *   trend_monitor._keyboard, the free-report i18n strings and i18n.t formatting.
 *
 *   Python: [[q, quality_scale.levels_stars(q)] for q in …]; await position_size.position_line(user, e, sl, lang, ctx=cx) …
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const QS = req('../../../services/engine/cards/qualityScale.js');
const Html = req('../../../services/engine/cards/html.js');
const Lite = req('../../../services/engine/cards/lite.js');
const Vol = req('../../../services/engine/cards/volume.js');
const Smc = req('../../../services/engine/cards/smc.js');
const KB = req('../../../services/engine/cards/keyboards.js');
const WM = req('../../../services/engine/watermark.js');
const PL = req('../../../services/engine/positionLine.js');
const TM = req('../../../services/engine/trendMonitor.js');
const FR = req('../../../services/engine/freeReport.js');
const { load } = req('./vectors.js');

const V = load('primitives');
const label = (x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : JSON.stringify(x));
const call = (fn) => { try { return fn(); } catch (e) { return { error: e.name }; } };

describe('quality_scale (bot table)', () => {
  it.each(V.levels_stars.map(([q, want]) => [label(q), q, want]))('levels_stars(%s)', (_l, q, want) => {
    expect(QS.levelsStars(q)).toBe(want);
  });
  it.each(V.stars_str.map(([n, want]) => [label(n), n, want]))('stars_str(%s)', (_l, n, want) => {
    expect(QS.starsStr(n)).toBe(want);
  });
});

describe('price formatters (bot table)', () => {
  it.each(V.fp.map(([v, smc, lite, vol]) => [label(v), v, smc, lite, vol]))('_fp(%s)', (_l, v, smc, lite, vol) => {
    // smc.scanner._fp and signal_format._fmt_price are the same wrapper (cards/html.cardFp)
    expect(call(() => Html.cardFp(v))).toEqual(smc);
    expect(call(() => Html.cardFp(v))).toEqual(lite);
    expect(call(() => Vol.fp(v))).toEqual(vol);
  });
});

describe('format_signal_lite (bot table)', () => {
  it.each(V.lite.map(([kw, text], i) => [i, kw, text]))('#%i', (_i, kw, text) => {
    const { quality_scale: qualityScale, ...rest } = kw;
    const args = qualityScale === undefined ? rest : { ...rest, qualityScale };
    expect(Lite.formatSignalLite(args)).toBe(text);
  });
});

describe('watermark (bot table)', () => {
  it.each(V.wm_encode)('wm_encode(%s)', (u, want) => {
    expect(WM.wmEncode(u)).toBe(want);
  });
  it.each(V.wm_inject.map(([t, u, want], i) => [i, t, u, want]))('wm_inject #%i', (_i, t, u, want) => {
    expect(WM.wmInject(t, u)).toBe(want);
  });
  it.each(V.wm_decode.map(([t, want], i) => [i, t, want]))('wm_decode #%i', (_i, t, want) => {
    expect(WM.wmDecode(t)).toBe(want);
  });
});

describe('position_size (bot table)', () => {
  const tm = TM.createTrendMonitor({ env: {} });
  const opts = (balance) => ({ balance, ctxRiskMult: (c) => tm.ctxRiskMult(c), ctxLabel: (c, l) => tm.ctxLabel(c, l) });

  it(`position_line: ${V.position_line.length} user × entry × ctx × balance × lang combos`, () => {
    for (const p of V.position_line) {
      const where = JSON.stringify({ ...p, line: undefined });
      expect(PL.positionLine(p.user, p.entry, p.sl, p.lang, p.ctx, opts(p.balance)), where).toBe(p.line);
    }
  });

  it('position_line uses the trendMonitor module defaults without hooks', () => {
    const p = V.position_line.find((x) => x.ctx === 'counter' && x.lang === 'en');
    expect(PL.positionLine(p.user, p.entry, p.sl, p.lang, p.ctx, { balance: p.balance })).toBe(p.line);
  });

  it.each(V.compute.map((r, i) => [i, r]))('compute #%i', (_i, [b, r, e, s, lv, want]) => {
    expect(PL.compute(b, r, e, s, lv)).toEqual(want);
  });

  it.each(V.usd)('_usd(%s)', (v, want) => {
    expect(PL.usd(v)).toBe(want);
  });
});

describe('trend_monitor._keyboard (bot table)', () => {
  it.each(V.trend_kb)('%s', (lang, rows) => {
    expect(KB.toTelegram(KB.trendKeyboard(lang)).inline_keyboard).toEqual(rows);
  });
});

describe('i18n strings / t() formatting (bot table)', () => {
  it.each(Object.entries(V.i18n_free))('%s', (k, want) => {
    expect({ ru: FR.MESSAGES[k].ru, en: FR.MESSAGES[k].en }).toEqual(want);
  });

  const t = Html.makeT({ ...Smc.MESSAGES, ...FR.MESSAGES });
  it.each(V.t_format.map(([k, l, kw, want], i) => [i, k, l, kw, want]))('#%i t(%s, %s)', (_i, k, l, kw, want) => {
    expect(t(k, l, kw)).toBe(want);
  });
});
