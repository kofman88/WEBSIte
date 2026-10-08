/**
 * The genome coin basket and the bot handler texts, against make_genome_vectors.py:
 *   "coins":    await genome._get_tier2_dynamic() with a recorded CoinGecko response (aiohttp faked);
 *               await genome._get_context_aware_coins(tf, S, limit) with a fake HistoryLoader serving
 *               the golden candles (the scored list captured from _build_tier_mixed_basket)
 *   "handlers": handlers/genome.py callbacks (cb_genome_evolve / cb_genome_apply / cb_genome_tf and
 *               the Pro gate) driven with fakes — the exact cb.answer / message / keyboard texts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadFixture, memLog } = require('./helpers');
const CB = require('../../services/genome/coinBasket');
const T = require('../../services/genome/texts');
const { loadFrame } = require('../golden/load');

const COINS = loadFixture('coins');
const HAND = loadFixture('handlers');

const frameOrNull = (coin, tf) => {
  try { return loadFrame(coin, tf); } catch (_e) { return null; }
};

beforeEach(() => CB._resetCaches());

describe('_get_tier2_dynamic (CoinGecko top-30 → canonical symbols, static fallback)', () => {
  it('recorded responses: mapping, de-dup, non-list / HTTP error / empty mapping → static list', async () => {
    for (const c of COINS.tier2) {
      CB._resetCaches();
      const calls = [];
      const http = async (url, opts) => { calls.push([url, opts.params]); return { status: c.status, json: c.data }; };
      const out = await CB.getTier2Dynamic({ http, log: memLog(), now: () => 1000 });
      expect(out, JSON.stringify(c.data)).toEqual(c.out);
      expect(calls[0]).toEqual([CB.COINGECKO_MARKETS, { vs_currency: 'usd', order: 'market_cap_desc', per_page: '30', page: '1' }]);
    }
  });

  it('24 h cache', async () => {
    let n = 0;
    const http = async () => { n++; return { status: 200, json: [{ id: 'cardano' }] }; };
    await CB.getTier2Dynamic({ http, now: () => 1000, log: memLog() });
    await CB.getTier2Dynamic({ http, now: () => 1000 + 86399, log: memLog() });
    expect(n).toBe(1);
    await CB.getTier2Dynamic({ http, now: () => 1000 + 86400, log: memLog() });
    expect(n).toBe(2);
  });
});

describe('_get_context_aware_coins on the golden candles', () => {
  it('ATR / volume / trend scores, blacklist, tier mix (T1 40 % / T2 30 % / T3) identical to the bot', async () => {
    const tier2Resp = COINS.tier2[0];
    for (const [i, c] of COINS.cases.entries()) {
      CB._resetCaches();
      const loader = { getTopCoins: async () => c.candidates.slice(), loadCached: async (coin, tf) => frameOrNull(coin, tf) };
      const http = async () => ({ status: tier2Resp.status, json: tier2Resp.data });
      const log = memLog();
      const out = await CB.getContextAwareCoins(c.tf, c.strategy, c.limit, { loader, http, log, now: () => 5000 });
      expect(out, `case ${i}`).toEqual(c.out);
      if (c.scored) {
        const js = c.candidates.filter((x) => !CB.isBlacklisted(x)).slice(0, 50)
          .map((coin) => [coin, CB.scoreCoin(frameOrNull(coin, c.tf), c.strategy)]).filter((x) => x[1] !== null)
          .map((x, k) => [...x, k]).sort((a, b) => (b[1] - a[1]) || (a[2] - b[2])).map((x) => [x[0], x[1]]);
        expect(js, `case ${i} scored`).toEqual(c.scored);
      }
    }
  });

  it('empty candidate list → [] (no fallback); a loader error → the fallback list; 15 min cache', async () => {
    expect(await CB.getContextAwareCoins('1h', 'LEVELS', 12, { loader: { getTopCoins: async () => [] }, log: memLog() })).toEqual([]);
    const sleeps = [];
    const bad = { getTopCoins: async () => { throw new Error('down'); } };
    const out = await CB.getContextAwareCoins('1h', 'SMC', 8, { loader: bad, log: memLog(), sleep: async (ms) => sleeps.push(ms) });
    expect(out).toEqual(CB.FALLBACK_COINS);
    expect(sleeps).toEqual([2000, 2000]);
    CB._resetCaches();
    let n = 0;
    const loader = { getTopCoins: async () => { n++; return ['BTC-USDT-SWAP', 'SYNVL01-USDT-SWAP']; }, loadCached: async (coin, tf) => frameOrNull(coin, tf) };
    const http = async () => ({ status: 500, json: null });
    const a = await CB.getContextAwareCoins('4h', 'VOLUME', 3, { loader, http, log: memLog(), now: () => 10 });
    const b = await CB.getContextAwareCoins('4h', 'VOLUME', 3, { loader, http, log: memLog(), now: () => 10 + 899 });
    expect(b).toEqual(a);
    expect(n).toBe(1);
  });

  it('_get_top_coins_cached: first 6 by volume ≥ 3 M, 10 min cache, stale cache before the hardcoded list', async () => {
    const loader = { getTopCoins: async (min) => { expect(min).toBe(3_000_000); return ['A', 'B', 'C', 'D', 'E', 'F', 'G']; } };
    expect(await CB.getTopCoinsCached('1h', { loader, now: () => 0, log: memLog() })).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const down = { getTopCoins: async () => { throw new Error('x'); } };
    expect(await CB.getTopCoinsCached('1h', { loader: down, now: () => 601, log: memLog(), sleep: async () => {} })).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(await CB.getTopCoinsCached('4h', { loader: down, now: () => 601, log: memLog(), sleep: async () => {} })).toEqual(CB.FALLBACK_COINS);
  });

  it('_build_tier_mixed_basket: limit 0 → []; Tier 1 = first BTC/ETH…; short pools filled from Tier 2', () => {
    expect(CB.buildTierMixedBasket([['X', 1]], 0, CB.TIER2_MCAP_STATIC)).toEqual([]);
    expect(CB.buildTierMixedBasket([], 10, ['ADA-USDT-SWAP', 'LAB-USDT-SWAP', 'AVAX-USDT-SWAP']))
      .toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP', 'BNB-USDT-SWAP', 'ADA-USDT-SWAP', 'AVAX-USDT-SWAP']);
  });
});

describe('bot handler texts (handlers/genome.py)', () => {
  it('i18n strings', () => {
    for (const key of ['sub_genome_locked', 'genome_auto_apply_btn_on', 'genome_auto_apply_btn_off', 'genome_auto_apply_disabled', 'genome_auto_apply_enabled_warn']) {
      for (const lang of ['ru', 'en']) expect(T.t(key, lang), `${key} ${lang}`).toBe(HAND.i18n[key][lang]);
    }
    expect(HAND.locked).toEqual([['answer', T.t('sub_genome_locked', 'en'), true]]);
  });

  it('cb_genome_evolve: the toast and the status message', () => {
    for (const c of HAND.evolve) {
      expect(c.log[0]).toEqual(['answer', T.EVOLVE_STARTED, false]);
      expect(c.log[1]).toEqual(['message', T.evolveStatusText(c.result, 'SMC', '1h'), null]);
    }
  });

  it('cb_genome_apply: the toast and the HTML message (html.escape, sorted keys, float repr)', () => {
    for (const c of HAND.apply) {
      expect(c.log[0]).toEqual(['answer', T.APPLY_STARTED, false]);
      expect(c.log[1]).toEqual(['message', T.applyResultText(c.result, 'LEVELS', '4h'), 'HTML']);
    }
  });

  it('_kb_genome rows (strategy / TF selectors, actions, auto-apply toggle, help, back)', () => {
    for (const c of [...HAND.keyboards, ...HAND.evolve.slice(0, 1).map(() => ({ strategy: 'SMC', tf: '1h', auto: false, lang: 'ru', log: HAND.evolve[0].log }))]) {
      const edit = c.log.find((x) => x[0] === 'edit');
      const rows = T.genomeKeyboard(c.strategy, c.tf, { genome_auto_apply: c.auto, lang: c.lang }).map((row) => row.map((b) => [b.text, b.callback]));
      expect(rows, `${c.strategy}/${c.tf}`).toEqual(edit[2]);
    }
  });
});
