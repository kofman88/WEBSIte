/**
 * format_trade_result of all four traders and bybit format_trade_result_split — the Telegram/
 * site texts (Russian, HTML-escaped) byte-equal to the bot (fixtures/format_vectors.json from
 * py/gen_format_vectors.py: 8 result shapes × 4 signal shapes).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
const { loadFixture } = req('./helpers.js');
const MODS = {
  bybit: req('../../services/exchanges/bybitTrader.js'),
  bingx: req('../../services/exchanges/bingxTrader.js'),
  binance: req('../../services/exchanges/binanceTrader.js'),
  okx: req('../../services/exchanges/okxTrader.js'),
};
const ROWS = loadFixture('format_vectors.json');

function run(fn, args) {
  try { return fn(...args); } catch (e) { return { raised: e.pyType || e.name, msg: e.message }; }
}

describe('format_trade_result parity', () => {
  ROWS.forEach((row, i) => {
    it(`case ${i}: ok=${row.args[0].ok} ${row.args[1]} ${row.args[2]}`, () => {
      for (const ex of Object.keys(MODS)) expect(run(MODS[ex].formatTradeResult, row.args), ex).toEqual(row[ex]);
      expect(run(MODS.bybit.formatTradeResultSplit, row.split_args), 'bybit split').toEqual(row.bybit_split);
    });
  });
});
