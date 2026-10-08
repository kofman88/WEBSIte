/**
 * candleFrame.js — `_rows_to_df` port (values pinned with the bot's Python:
 * sort, dedup last-wins, forming-bar drop, volume = v × close, prices / mult,
 * NaN/inf drop, ms index), the python number parsers and the frame edit helpers.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const CF = req('../../services/marketData/candleFrame.js');
import { closedFrame } from './helpers.js';

const { rowsToFrame, parseRow, pyInt, pyFloat, pyFalsy, frameIndexOf, frameSetRow, frameAppendRow, frameTrim, TF_MS, TF_TO_BINGX, TF_NORM, TTL_MAP, CACHE_TTL, tfNorm, tfMsBingx, MAX_KLINES } = CF;
const H = 3_600_000;
const here = path.dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(fs.readFileSync(path.join(here, '../fixtures/marketData/klines_v3_sample.json'), 'utf8'));

describe('rowsToFrame (fetcher_bingx._rows_to_df)', () => {
  it('reproduces the Python probe on a mixed/dirty row set', () => {
    const rows = [
      { open: '1', high: '2', low: '0.5', close: '1.5', volume: '10', time: 0 },
      { open: '1', high: '2', low: '0.5', close: '1.6', volume: '10', time: 0 },        // dedup: last wins
      { open: 'inf', high: '2', low: '0.5', close: '1.5', volume: '10', time: H },       // inf → dropped
      { open: '1', high: '2', low: '0.5', close: 'nan', volume: '10', time: 2 * H },     // nan → dropped
      { open: '1', high: '2', low: '0.5', close: '1.5', time: 3 * H },                   // no volume → 0
      { open: 'x', high: '2', low: '0.5', close: '1.5', volume: '1', time: 4 * H },      // unparsable → skipped
      { open: '1', high: '2', low: '0.5', close: '1.5', volume: '1', time: '' },         // no time key → skipped
      { open: '1', high: '2', low: '0.5', close: '1.5', volume: '1', openTime: 5 * H },  // openTime accepted
      [6 * H, '1', '2', '0.5', '1.5'],                                                   // list without volume → 0
      [7 * H, '1', '2', '0.5', '1.5', '3', 'extra'],
      { open: '1', high: '2', low: '0.5', close: '1.5', volume: '1', T: 8 * H },         // T accepted
      { open: '1', high: '2', low: '0.5', close: '1.5', volume: '', time: 9 * H },       // '' or 0 → 0
      { open: '1', high: '2', low: '0.5', close: '1.5', volume: null, time: 10 * H },
      { open: '1', high: '2', low: '0.5', close: '1.5', volume: '1', time: '11.0' },     // int('11.0') raises → skipped
    ];
    const f = rowsToFrame(rows, '1h', 1.0, 20 * H);
    expect(Array.from(f.t)).toEqual([0, 10800000, 18000000, 21600000, 25200000, 28800000, 32400000, 36000000]);
    expect(Array.from(f.v)).toEqual([16, 0, 1.5, 0, 4.5, 1.5, 0, 0]);
    expect(Array.from(f.c)).toEqual([1.6, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5, 1.5]);
    expect(Array.from(f.o)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(f.length).toBe(8);
  });

  it('drops the forming bar, sorts newest-first input and converts volume to USDT', () => {
    const rows = [];
    for (let i = 4; i >= 0; i--) rows.push({ open: String(100 + i), high: String(101 + i), low: String(99 + i), close: String(100.5 + i), volume: '10', time: i * H });
    const now = 4 * H + H / 2;                                 // bar 4H still forming
    const f = rowsToFrame(rows, '1h', 1.0, now);
    expect(f.length).toBe(4);
    expect(Array.from(f.t)).toEqual([0, H, 2 * H, 3 * H]);
    expect(f.v[0]).toBeCloseTo(10 * 100.5, 9);
    // boundary: t + tf == now → closed (<=)
    expect(rowsToFrame(rows, '1h', 1.0, 4 * H).length).toBe(4);
    expect(rowsToFrame(rows, '1h', 1.0, 5 * H).length).toBe(5);
  });

  it('divides prices by the multiplier but not the USDT volume (list rows)', () => {
    const rows = [[0, '1.5', '1.6', '1.4', '1.55', '1000'], [H, '1.55', '1.7', '1.5', '1.6', '1000']];
    const f = rowsToFrame(rows, '1h', 1000.0, 10 * H);
    expect(f.c[1]).toBeCloseTo(0.0016, 12);
    expect(f.v[1]).toBeCloseTo(1000 * 1.6, 9);
    const f2 = rowsToFrame([[0, '1500', '1600', '1400', '1550', '1000']], '1h', 1000.0, 10 * H);
    expect(f2.row(0)).toEqual({ t: 0, o: 1.5, h: 1.6, l: 1.4, c: 1.55, v: 1550000 });
    // mult 1 / 0 / undefined → no scaling
    expect(rowsToFrame(rows, '1h', 1, 10 * H).c[0]).toBe(1.55);
    expect(rowsToFrame(rows, '1h', 0, 10 * H).c[0]).toBe(1.55);
  });

  it('returns null for nothing parsable or everything forming', () => {
    expect(rowsToFrame([], '1h', 1, 0)).toBe(null);
    expect(rowsToFrame(null, '1h', 1, 0)).toBe(null);
    expect(rowsToFrame([{ open: 'x' }], '1h', 1, 0)).toBe(null);
    expect(rowsToFrame([[0, '1', '1', '1', '1', '1']], '1h', 1, 0)).toBe(null);
  });

  it('returns an empty frame when every closed row is NaN (pandas dropna → empty df)', () => {
    const f = rowsToFrame([[0, 'nan', '1', '1', '1', '1']], '1h', 1, 10 * H);
    expect(f).not.toBe(null);
    expect(f.length).toBe(0);
  });

  it('unknown BingX tf uses 3 600 000 ms; 1M is 31 days', () => {
    expect(tfMsBingx('zzz')).toBe(3_600_000);
    expect(TF_MS['1M']).toBe(31 * 86_400_000);
    const rows = [[0, '1', '1', '1', '1', '1'], [31 * 86_400_000, '1', '1', '1', '1', '1']];
    expect(rowsToFrame(rows, '1M', 1, 31 * 86_400_000 + 1).length).toBe(1);
  });

  it('parses the BingX v3 sample (dict rows newest-first and list rows)', () => {
    const now = 1717000600000;
    const f = rowsToFrame(sample.dict_rows.data, '1h', 1000, now);
    expect(f.length).toBe(4);                                   // 1717000200000 is forming
    expect(Array.from(f.t)).toEqual([1716985800000, 1716989400000, 1716993000000, 1716996600000]);
    expect(f.c[3]).toBeCloseTo(0.0119, 12);
    expect(f.v[3]).toBeCloseTo(1800000 * 11.9, 6);
    const g = rowsToFrame(sample.list_rows.data, '1h', 1000, now);
    expect(g.length).toBe(3);
    expect(g.row(2).c).toBeCloseTo(0.0118, 12);
  });
});

describe('python number parsing', () => {
  it('pyInt', () => {
    expect(pyInt('12')).toBe(12);
    expect(pyInt(' 12 ')).toBe(12);
    expect(pyInt(12.9)).toBe(12);
    expect(pyInt(-3.9)).toBe(-3);
    expect(pyInt(true)).toBe(1);
    expect(() => pyInt('11.0')).toThrow();
    expect(() => pyInt('')).toThrow();
    expect(() => pyInt(null)).toThrow();
    expect(() => pyInt(NaN)).toThrow();
  });

  it('pyFloat', () => {
    expect(pyFloat('1e3')).toBe(1000);
    expect(pyFloat(' 1.5 ')).toBe(1.5);
    expect(pyFloat('inf')).toBe(Infinity);
    expect(pyFloat('-inf')).toBe(-Infinity);
    expect(Number.isNaN(pyFloat('nan'))).toBe(true);
    expect(pyFloat('.5')).toBe(0.5);
    expect(() => pyFloat('')).toThrow();
    expect(() => pyFloat('x')).toThrow();
    expect(() => pyFloat(null)).toThrow();
    expect(() => pyFloat({})).toThrow();
  });

  it('pyFalsy', () => {
    expect(pyFalsy(null)).toBe(true);
    expect(pyFalsy('')).toBe(true);
    expect(pyFalsy(0)).toBe(true);
    expect(pyFalsy([])).toBe(true);
    expect(pyFalsy({})).toBe(true);
    expect(pyFalsy(NaN)).toBe(false);
    expect(pyFalsy('0')).toBe(false);
    expect(pyFalsy([1])).toBe(false);
  });

  it('parseRow prefers time, then openTime, then T; skips empty markers', () => {
    expect(parseRow({ time: '', openTime: 5, T: 6, open: '1', high: '1', low: '1', close: '1' })).toEqual([5, 1, 1, 1, 1, 0]);
    expect(parseRow({ T: 7, open: '1', high: '1', low: '1', close: '1', volume: '2' })).toEqual([7, 1, 1, 1, 1, 2]);
    expect(parseRow('junk')).toBe(null);
    expect(parseRow([1])).toBe(null);
  });
});

describe('timeframe tables', () => {
  it('TF_TO_BINGX lower-cases H/D/W and keeps 1M', () => {
    expect(TF_TO_BINGX['4H']).toBe('4h');
    expect(TF_TO_BINGX['1D']).toBe('1d');
    expect(TF_TO_BINGX['1M']).toBe('1M');
    expect(TF_TO_BINGX['15m']).toBe('15m');
    expect(MAX_KLINES).toBe(1440);
  });

  it('TF_NORM / TTL_MAP / CACHE_TTL match ws_feed and Config', () => {
    expect(tfNorm('1h')).toBe('1H');
    expect(tfNorm('4h')).toBe('4H');
    expect(tfNorm('1d')).toBe('1D');
    expect(tfNorm('15m')).toBe('15m');
    expect(tfNorm('1W')).toBe('1W');
    expect(TF_NORM['2h']).toBe('2H');
    expect(TTL_MAP).toEqual({
      '1m': 300, '3m': 900, '5m': 1800, '15m': 3600, '30m': 7200,
      '1H': 14400, '1h': 14400, '2H': 28800, '2h': 28800, '4H': 57600, '4h': 57600, '1D': 172800, '1d': 172800,
    });
    expect(CACHE_TTL).toEqual({ '1m': 55, '5m': 270, '15m': 870, '30m': 1770, '1h': 3570, '4h': 14370, '1d': 85000, '1D': 85000, '1H': 3570, '4H': 14370 });
  });
});

describe('frame edit helpers (ws_feed._update_cache)', () => {
  it('frameIndexOf / frameSetRow in place', () => {
    const f = closedFrame(0, 5, H, 1);
    expect(frameIndexOf(f, 2 * H)).toBe(2);
    expect(frameIndexOf(f, 2 * H + 1)).toBe(-1);
    frameSetRow(f, 2, 9, 10, 8, 9.5, 77);
    expect(f.row(2)).toEqual({ t: 2 * H, o: 9, h: 10, l: 8, c: 9.5, v: 77 });
  });

  it('frameAppendRow returns a new sorted frame; frameTrim keeps the last n', () => {
    const f = closedFrame(0, 3, H, 1);
    const g = frameAppendRow(f, 3 * H, 2, 3, 1, 2.5, 5);
    expect(g).not.toBe(f);
    expect(g.length).toBe(4);
    expect(g.row(3)).toEqual({ t: 3 * H, o: 2, h: 3, l: 1, c: 2.5, v: 5 });
    expect(f.length).toBe(3);
    const t = frameTrim(g, 2);
    expect(Array.from(t.t)).toEqual([2 * H, 3 * H]);
    expect(frameTrim(g, 10)).toBe(g);
  });
});
