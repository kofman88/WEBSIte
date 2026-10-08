/**
 * bingxWsFeed.js — the BingX kline feed driven by the committed gzip frames in
 * tests/fixtures/marketData/ws-frames (see make-ws-frames.js): decode, heartbeat,
 * subscribe format/throttle, instrument preload, the bar state machine
 * (forming / closed on newer T / late update / out-of-order / stale timer / refresh
 * after reconnect / forming-sync throttle), `_update_cache` semantics (forming bars
 * never stored, trim 300, TTL map, bar-close bus, [WS-REFILL]), watchdog and backoff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
const req = createRequire(import.meta.url);
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
const WSF = req('../../services/marketData/bingxWsFeed.js');
const CC = req('../../services/marketData/candleCache.js');
const S = req('../../services/marketData/symbolMap.js');
import { closedFrame, FakeWS, makeWsClass, sleepSpy, silentLog, logSpy, makeHttp } from './helpers.js';

const { BingxWsFeed, decodeFrame, encodeFrame, barOpenMs, channelName, parseChannel, registerOnBarClose, unregisterOnBarClose, fireBarClose, _resetBarCloseCallbacks, keyOf, maxSubsPerConn, SUB_PAUSE_MS, CLOSE_GRACE_S, CACHE_DEPTH } = WSF;

const here = path.dirname(fileURLToPath(import.meta.url));
const FX = path.join(here, '../fixtures/marketData/ws-frames');
const manifest = JSON.parse(fs.readFileSync(path.join(FX, 'manifest.json'), 'utf8'));
const frame = (name) => fs.readFileSync(path.join(FX, name));
const { NOW_MS, T0, T3, H0, M5, H1 } = manifest;

let nowMs = NOW_MS;
const now = () => nowMs;
let fired;

function makeFeed(opts = {}) {
  const feed = new BingxWsFeed({ now, sleep: sleepSpy(), log: silentLog, env: {}, ...opts });
  feed._ws = new FakeWS();
  feed._connectedAt = NOW_MS / 1000 - 1;
  return feed;
}

beforeEach(() => {
  nowMs = NOW_MS;
  CC.initCache(500, { now: () => nowMs / 1000, log: silentLog });
  S._setLive([]);
  _resetBarCloseCallbacks();
  fired = [];
  registerOnBarClose((inst, tf) => { fired.push([inst, tf]); });
});
afterEach(() => { CC._resetForTests(); _resetBarCloseCallbacks(); });

describe('frames / channels', () => {
  it('decodeFrame: gzip, zlib, raw deflate, plain bytes, strings, garbage', () => {
    expect(decodeFrame(frame('ping.gz'))).toBe('Ping');
    expect(decodeFrame(frame('zlib_frame.bin'))).toBe('{"a":1}');
    expect(decodeFrame(frame('raw_deflate.bin'))).toBe('{"raw":true}');
    expect(decodeFrame(frame('plain_text.bin'))).toBe('{"plain":true}');
    expect(decodeFrame(frame('garbage.bin'))).toBe(null);
    expect(decodeFrame('Ping')).toBe('Ping');
    expect(decodeFrame(null)).toBe(null);
    expect(decodeFrame(new Uint8Array(frame('ping.gz')))).toBe('Ping');
    expect(decodeFrame(zlib.gzipSync(Buffer.from('Ping')))).toBe('Ping');
    expect(JSON.parse(decodeFrame(encodeFrame({ a: 1 })))).toEqual({ a: 1 });
  });

  it('every committed kline fixture decodes to a BingX push envelope', () => {
    for (const name of Object.keys(manifest.frames).filter((n) => n.startsWith('kline_'))) {
      const d = JSON.parse(decodeFrame(frame(name)));
      expect(d.code).toBe(0);
      expect(d.dataType).toMatch(/^[A-Z0-9]+-USDT@kline_(5m|15m|1h|4h)$/);
      expect(Array.isArray(d.data)).toBe(true);
    }
  });

  it('channelName / parseChannel roundtrip (alias, multiplier, tf case)', () => {
    expect(channelName('BTC-USDT-SWAP', '1H')).toBe('BTC-USDT@kline_1h');
    expect(channelName('BTC-USDT-SWAP', '1h')).toBe('BTC-USDT@kline_1h');
    expect(channelName('PEPE-USDT-SWAP', '5m')).toBe('1000PEPE-USDT@kline_5m');
    expect(channelName('TON-USDT-SWAP', '4H')).toBe('TONCOIN-USDT@kline_4h');
    expect(channelName('ETH-USDT-SWAP', '1D')).toBe('ETH-USDT@kline_1d');
    expect(channelName('ETH-USDT-SWAP', '15m')).toBe('ETH-USDT@kline_15m');
    expect(channelName('ETH-USDT-SWAP', '7m')).toBe(null);
    expect(parseChannel('1000PEPE-USDT@kline_5m')).toEqual(['PEPE-USDT-SWAP', '5m']);
    expect(parseChannel('TONCOIN-USDT@kline_4h')).toEqual(['TON-USDT-SWAP', '4H']);
    expect(parseChannel('BTC-USDT@kline_1d')).toEqual(['BTC-USDT-SWAP', '1D']);
    expect(parseChannel('BTC-USDT@depth20')).toBe(null);
    expect(parseChannel('BTC-USDC@kline_1h')).toBe(null);
    expect(parseChannel('')).toBe(null);
  });

  it('barOpenMs handles open-time and close-time style T', () => {
    const t0 = 1_717_000_200_000 - (1_717_000_200_000 % M5);
    expect(barOpenMs(t0, '5m')).toBe(t0);
    expect(barOpenMs(t0 + M5 - 1, '5m')).toBe(t0);
    expect(barOpenMs(999, 'zz')).toBe(999);
    expect(barOpenMs('1717000200000', '1h')).toBe(1717000200000);
  });

  it('maxSubsPerConn reads the env with a 200 default', () => {
    expect(maxSubsPerConn({})).toBe(200);
    expect(maxSubsPerConn({ BINGX_WS_MAX_SUBS_PER_CONN: '50' })).toBe(50);
    expect(maxSubsPerConn({ BINGX_WS_MAX_SUBS_PER_CONN: 'x' })).toBe(200);
    expect(maxSubsPerConn({ BINGX_WS_MAX_SUBS_PER_CONN: '0' })).toBe(1);
  });
});

describe('heartbeat and control frames', () => {
  it('Ping → Pong, updates liveness and counters (binary and text variants)', async () => {
    const feed = makeFeed();
    feed._lastMsgTs = 0;
    await feed.handleMessage(frame('ping.gz'));
    expect(feed._ws.sent).toEqual(['Pong']);
    expect(feed._pingsReceived).toBe(1);
    expect(feed._pongsSent).toBe(1);
    expect(feed._lastMsgTs).toBe(NOW_MS / 1000);
    await feed.handleMessage('Ping');
    await feed.handleMessage(Buffer.from('ping'));
    expect(feed._ws.sent).toEqual(['Pong', 'Pong', 'Pong']);
    await feed.handleMessage('Pong');
    expect(feed._ws.sent).toHaveLength(3);
  });

  it('JSON ping → JSON pong', async () => {
    const feed = makeFeed();
    await feed.handleMessage(frame('json_ping.gz'));
    expect(JSON.parse(feed._ws.sent[0])).toEqual({ pong: 'abc', time: '2026-10-06T00:00:00' });
  });

  it('subscribe ack, error frames and garbage are ignored (errors counted)', async () => {
    const feed = makeFeed();
    await feed.handleMessage(frame('sub_ack.gz'));
    await feed.handleMessage(frame('sub_error.gz'));
    await feed.handleMessage(frame('garbage.bin'));
    await feed.handleMessage(encodeFrame('[1,2,3]'));
    await feed.handleMessage(encodeFrame('not json'));
    expect(feed._ws.sent).toEqual([]);
    expect(feed._subErrors).toBe(1);
    expect(feed.metrics().sub_errors).toBe(1);
  });

  it('Pong is not sent when the socket is closed', async () => {
    const feed = makeFeed();
    feed._ws.close();
    await feed.handleMessage(frame('ping.gz'));
    expect(feed._pingsReceived).toBe(1);
    expect(feed._pongsSent).toBe(0);
  });
});

describe('subscriptions', () => {
  it('one message per channel, uuid ids, 10 messages then a 0.1 s pause', async () => {
    const feed = makeFeed();
    const keys = [];
    for (let i = 0; i < 23; i++) { feed._subscriptions.set(keyOf(`C${i}-USDT-SWAP`, '5m'), [`C${i}-USDT-SWAP`, '5m']); keys.push(keyOf(`C${i}-USDT-SWAP`, '5m')); }
    feed._subscriptions.set(keyOf('PEPE-USDT-SWAP', '1H'), ['PEPE-USDT-SWAP', '1H']); keys.push(keyOf('PEPE-USDT-SWAP', '1H'));
    feed._subscriptions.set(keyOf('TON-USDT-SWAP', '4H'), ['TON-USDT-SWAP', '4H']); keys.push(keyOf('TON-USDT-SWAP', '4H'));
    await feed._sendSubscribe(keys);
    const msgs = feed._ws.sent.map((m) => JSON.parse(m));
    expect(msgs).toHaveLength(25);
    for (const m of msgs) {
      expect(Object.keys(m).sort()).toEqual(['dataType', 'id', 'reqType']);
      expect(m.reqType).toBe('sub');
      expect(m.id).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(new Set(msgs.map((m) => m.id)).size).toBe(25);
    const dts = msgs.map((m) => m.dataType);
    expect(dts).toContain('C0-USDT@kline_5m');
    expect(dts).toContain('1000PEPE-USDT@kline_1h');
    expect(dts).toContain('TONCOIN-USDT@kline_4h');
    expect(feed._sleep.calls).toEqual([SUB_PAUSE_MS, SUB_PAUSE_MS]);
    expect(feed._channelMap.get('1000PEPE-USDT@kline_1h')).toBe(keyOf('PEPE-USDT-SWAP', '1H'));
  });

  it('subscribeSymbols filters invalid instruments and flushes in one task', async () => {
    const feed = makeFeed();
    feed._validInstruments = new Set(['BTC-USDT-SWAP', 'PEPE-USDT-SWAP']);
    feed.subscribeSymbols(['BTC-USDT-SWAP', 'PEPE-USDT-SWAP', 'NOPE-USDT-SWAP'], ['5m', '1h']);
    expect(feed.activeSubscriptions).toBe(4);
    expect(feed._invalidSymbols.has('NOPE-USDT-SWAP')).toBe(true);
    await feed._flushTask;
    const dts = feed._ws.sent.map((m) => JSON.parse(m).dataType).sort();
    expect(dts).toEqual(['1000PEPE-USDT@kline_1h', '1000PEPE-USDT@kline_5m', 'BTC-USDT@kline_1h', 'BTC-USDT@kline_5m']);
    expect(feed.subscriptions).toContainEqual(['BTC-USDT-SWAP', '1H']);
    feed.subscribe('BTC-USDT-SWAP', '1H');                // duplicate
    expect(feed.activeSubscriptions).toBe(4);
  });

  it('caps subscriptions per connection and warns', () => {
    const log = logSpy();
    const feed = new BingxWsFeed({ maxSubscriptions: 800, log, env: {} });
    expect(feed._maxSubs).toBe(200);
    for (let i = 0; i < 250; i++) feed.subscribe(`C${i}-USDT-SWAP`, '5m');
    expect(feed.activeSubscriptions).toBe(200);
    expect(log.lines.warning[0]).toBe('ws_feed_bingx: достигнут лимит подписок (200)');
    expect(new BingxWsFeed({ maxSubscriptions: 650, env: { BINGX_WS_MAX_SUBS_PER_CONN: '300' } })._maxSubs).toBe(300);
  });

  it('unsubscribe sends unsub, drops channel map and bar state', async () => {
    const feed = makeFeed();
    feed.subscribe('BTC-USDT-SWAP', '1H');
    await feed._flushTask;
    feed._barState.set(keyOf('BTC-USDT-SWAP', '1H'), { T: 1 });
    feed.unsubscribe('BTC-USDT-SWAP', '1h');
    await feed.settle();
    expect(feed.activeSubscriptions).toBe(0);
    const last = JSON.parse(feed._ws.sent.at(-1));
    expect(last).toMatchObject({ reqType: 'unsub', dataType: 'BTC-USDT@kline_1h' });
    expect(feed._channelMap.has('BTC-USDT@kline_1h')).toBe(false);
    expect(feed._barState.size).toBe(0);
  });

  it('preloads valid instruments from /quote/contracts (status, non-crypto, alias)', async () => {
    const http = makeHttp(() => ({ code: 0, data: [
      { symbol: 'BTC-USDT', status: 1 }, { symbol: '1000PEPE-USDT', status: 1 }, { symbol: 'TONCOIN-USDT', status: 1 },
      { symbol: 'DEAD-USDT', status: 0 }, { symbol: 'BTC-USDC', status: 1 }, { symbol: 'NCCOGOLD2USD-USDT', status: 1 },
    ] }));
    const feed = new BingxWsFeed({ http, log: silentLog, env: {} });
    await feed._preloadValidInstruments();
    expect(feed._validInstruments).toEqual(new Set(['BTC-USDT-SWAP', 'PEPE-USDT-SWAP', 'TON-USDT-SWAP']));
    expect(http.calls[0].url).toContain('contracts');
    // live names keep every live crypto contract, USDC ones included (bot remember_live)
    expect(Array.from(S.getLive()).sort()).toEqual(['1000PEPE-USDT', 'BTC-USDC', 'BTC-USDT', 'TONCOIN-USDT']);
    const feed2 = new BingxWsFeed({ http: makeHttp(() => ({ status: 503, json: null })), log: silentLog, env: {} });
    await feed2._preloadValidInstruments();
    expect(feed2._validInstruments).toBe(null);
    const feed3 = new BingxWsFeed({ http: makeHttp(() => { throw new Error('dns'); }), log: silentLog, env: {} });
    await feed3._preloadValidInstruments();
    expect(feed3._validInstruments).toBe(null);
  });
});

describe('kline state machine → cache (recorded frames)', () => {
  function pepeFeed(extra = {}) {
    const feed = makeFeed(extra);
    feed._subscriptions.set(keyOf('PEPE-USDT-SWAP', '5m'), ['PEPE-USDT-SWAP', '5m']);
    CC.setCandles('PEPE-USDT-SWAP', '5m', closedFrame(T0, 3, M5, 0.01), { '5m': 600 });
    return feed;
  }

  it('a bar is confirmed when a newer T arrives; late updates fix values; old bars are ignored', async () => {
    const feed = pepeFeed();
    await feed.handleMessage(frame('kline_pepe_5m_forming_1.gz'));
    await feed.handleMessage(frame('kline_pepe_5m_forming_2.gz'));
    let f = CC.getCandles('PEPE-USDT-SWAP', '5m');
    expect(f.length).toBe(3);
    expect(fired).toEqual([]);
    expect(feed._barState.get(keyOf('PEPE-USDT-SWAP', '5m'))).toMatchObject({ T: T3, h: 12, l: 8, c: 11, v: 2000 });
    await feed.handleMessage(frame('kline_pepe_5m_next.gz'));
    f = CC.getCandles('PEPE-USDT-SWAP', '5m');
    expect(f.length).toBe(4);
    expect(f.t[3]).toBe(T3);
    expect(f.o[3]).toBeCloseTo(0.010, 12);
    expect(f.h[3]).toBeCloseTo(0.012, 12);
    expect(f.l[3]).toBeCloseTo(0.008, 12);
    expect(f.c[3]).toBeCloseTo(0.011, 12);
    expect(f.v[3]).toBeCloseTo(2000 * 11.0, 9);         // USDT = v × c in BingX units
    expect(fired).toEqual([['PEPE-USDT-SWAP', '5m']]);
    expect(feed._candlesReceivedTotal).toBe(1);
    expect(feed._lastEmitted.get(keyOf('PEPE-USDT-SWAP', '5m'))).toBe(T3);
    await feed.handleMessage(frame('kline_pepe_5m_late.gz'));
    f = CC.getCandles('PEPE-USDT-SWAP', '5m');
    expect(f.length).toBe(4);
    expect(f.c[3]).toBeCloseTo(0.0112, 12);
    expect(fired).toHaveLength(1);
    await feed.handleMessage(frame('kline_pepe_5m_old.gz'));
    expect(CC.getCandles('PEPE-USDT-SWAP', '5m').length).toBe(4);
    expect(feed._pushesReceived).toBe(5);
  });

  it('pushes for unsubscribed channels are dropped', async () => {
    const feed = makeFeed();
    CC.setCandles('BTC-USDT-SWAP', '1H', closedFrame(H0, 2, H1, 100), { '1H': 600 });
    await feed.handleMessage(frame('kline_btc_1h_unsubscribed.gz'));
    await feed.handleMessage(frame('kline_btc_1h_closetime.gz'));
    expect(CC.getCandles('BTC-USDT-SWAP', '1H').length).toBe(2);
    expect(fired).toEqual([]);
    expect(feed._pushesReceived).toBe(0);
  });

  it('close-time style T (…999) maps to the bar open', async () => {
    const feed = makeFeed();
    feed._subscriptions.set(keyOf('BTC-USDT-SWAP', '1H'), ['BTC-USDT-SWAP', '1H']);
    CC.setCandles('BTC-USDT-SWAP', '1H', closedFrame(H0, 2, H1, 100), { '1H': 600 });
    await feed.handleMessage(frame('kline_btc_1h_closetime.gz'));
    expect(feed._barState.get(keyOf('BTC-USDT-SWAP', '1H')).T).toBe(H0 + 2 * H1);
  });

  it('alias TONCOIN → TON-USDT-SWAP and tf 4h → 4H (multiplier 1)', async () => {
    const feed = makeFeed();
    feed._subscriptions.set(keyOf('TON-USDT-SWAP', '4H'), ['TON-USDT-SWAP', '4H']);
    const step = 4 * H1;
    const t0 = Math.floor(NOW_MS / step) * step - 6 * step;
    CC.setCandles('TON-USDT-SWAP', '4H', closedFrame(t0, 2, step, 5.0), { '4H': 600 });
    await feed.handleMessage(frame('kline_toncoin_4h.gz'));
    const next = encodeFrame({ code: 0, dataType: 'TONCOIN-USDT@kline_4h', s: 'TONCOIN-USDT', data: [{ o: '5.5', h: '5.5', l: '5.5', c: '5.5', v: '1', T: t0 + 3 * step }] });
    await feed.handleMessage(next);
    const f = CC.getCandles('TON-USDT-SWAP', '4H');
    expect(f.length).toBe(3);
    expect(f.c[2]).toBe(5.5);
    expect(fired).toEqual([['TON-USDT-SWAP', '4H']]);
  });

  it('items are sorted by open time; malformed items are skipped', async () => {
    const feed = makeFeed();
    feed._subscriptions.set(keyOf('ETH-USDT-SWAP', '15m'), ['ETH-USDT-SWAP', '15m']);
    const Q = 900_000;
    CC.setCandles('ETH-USDT-SWAP', '15m', closedFrame(T0 - 2 * Q, 3, Q, 1.0), { '15m': 600 });
    await feed.handleMessage(frame('kline_multi_unsorted.gz'));
    const f = CC.getCandles('ETH-USDT-SWAP', '15m');
    expect(f.length).toBe(4);                   // T0+15m closed by T0+30m
    expect(f.t[3]).toBe(T0 + Q);
    expect(f.c[3]).toBe(1);
    expect(feed._barState.get(keyOf('ETH-USDT-SWAP', '15m')).T).toBe(T0 + 2 * Q);
    expect(fired).toEqual([['ETH-USDT-SWAP', '15m']]);
    expect(feed._pushesReceived).toBe(1);
  });

  it('an empty cache triggers the REST initial load (reserved channel)', async () => {
    const calls = [];
    const fetcher = { async getCandles(s, tf) { calls.push([s, tf]); return closedFrame(0, 60, M5, 1.0); } };
    const feed = makeFeed({ fetcher });
    feed._subscriptions.set(keyOf('BTC-USDT-SWAP', '5m'), ['BTC-USDT-SWAP', '5m']);
    await feed.handleMessage(encodeFrame({ code: 0, dataType: 'BTC-USDT@kline_5m', data: [{ o: '1', h: '1', l: '1', c: '1', v: '1', T: 120 * M5 }] }));
    expect(calls).toEqual([['BTC-USDT-SWAP', '5m']]);
    expect(CC.getCandles('BTC-USDT-SWAP', '5m').length).toBe(60);
    expect(feed._loadedChannels.has('BTC-USDT-SWAP_5m')).toBe(true);
    expect(feed.channelStale('BTC-USDT-SWAP_5m')).toBe(false);
    expect(feed.channelStale('BTC-USDT-SWAP_5m', NOW_MS / 1000 + 60)).toBe(true);
    expect(feed.channelStale('nope')).toBe(false);
  });

  it('[WS-REFILL]: a reserved channel with an empty cache is reloaded only after 60 s', async () => {
    const calls = [];
    const fetcher = { async getCandles(s, tf) { calls.push([s, tf]); return closedFrame(0, 60, M5, 1.0); } };
    const log = logSpy();
    const feed = makeFeed({ fetcher, log });
    const row = BingxWsFeed.okxRow('BTC-USDT-SWAP', 0, 1, 1, 1, 1, 1, '0');
    feed.reserveChannel('BTC-USDT-SWAP_5m');
    await feed._updateCache('BTC-USDT-SWAP', '5m', [row]);
    expect(calls).toEqual([]);
    nowMs = NOW_MS + 60_000;
    await feed._updateCache('BTC-USDT-SWAP', '5m', [row]);
    expect(calls).toEqual([['BTC-USDT-SWAP', '5m']]);
    expect(log.lines.info).toContain('[WS-REFILL] BTC-USDT-SWAP/5m: cache empty for reserved channel — reloading');
    // without a fetcher nothing is loaded
    const bare = makeFeed();
    await bare._updateCache('BTC-USDT-SWAP', '5m', [row]);
    expect(bare._loadedChannels.size).toBe(0);
  });

  it('stale bars are closed by the timer after T + tf + 15 s, and not re-emitted', async () => {
    const feed = makeFeed();
    const key = keyOf('BTC-USDT-SWAP', '5m');
    feed._subscriptions.set(key, ['BTC-USDT-SWAP', '5m']);
    const t0 = Math.floor(NOW_MS / M5) * M5 - 10 * M5;
    CC.setCandles('BTC-USDT-SWAP', '5m', closedFrame(t0, 2, M5, 100.0), { '5m': 600 });
    const t2 = t0 + 2 * M5;
    await feed.handleMessage(encodeFrame({ code: 0, dataType: 'BTC-USDT@kline_5m', data: [{ o: '100', h: '101', l: '99', c: '100.5', v: '3', T: t2 }] }));
    await feed._closeStaleBars(t2 + M5 + 1000);
    expect(fired).toEqual([]);
    await feed._closeStaleBars(t2 + M5 + CLOSE_GRACE_S * 1000 + 1);
    expect(fired).toEqual([['BTC-USDT-SWAP', '5m']]);
    const f = CC.getCandles('BTC-USDT-SWAP', '5m');
    expect(f.t[f.length - 1]).toBe(t2);
    expect(f.v[f.length - 1]).toBeCloseTo(3 * 100.5, 9);
    await feed._closeStaleBars(t2 + M5 + CLOSE_GRACE_S * 1000 + 5000);
    await feed.handleMessage(encodeFrame({ code: 0, dataType: 'BTC-USDT@kline_5m', data: [{ o: '1', h: '1', l: '1', c: '1', v: '1', T: t2 + M5 }] }));
    expect(fired).toHaveLength(1);
    // default nowMs comes from the injected clock
    nowMs = t2 + 2 * M5 + CLOSE_GRACE_S * 1000 + 1;
    await feed._closeStaleBars();
    expect(fired).toHaveLength(2);
  });

  it('a bar that spans a reconnect is re-loaded via REST and still fires bar-close', async () => {
    const t0 = Math.floor(NOW_MS / M5) * M5 - 10 * M5;
    const fetcher = { async getCandles() { return closedFrame(t0, 4, M5, 42.0); } };
    const feed = makeFeed({ fetcher });
    const key = keyOf('BTC-USDT-SWAP', '5m');
    feed._subscriptions.set(key, ['BTC-USDT-SWAP', '5m']);
    CC.setCandles('BTC-USDT-SWAP', '5m', closedFrame(t0, 3, M5, 1.0), { '5m': 600 });
    await feed.handleMessage(encodeFrame({ code: 0, dataType: 'BTC-USDT@kline_5m', data: [{ o: '1', h: '1', l: '1', c: '1', v: '1', T: t0 + 3 * M5 }] }));
    feed._connectedAt = NOW_MS / 1000 + 1;      // reconnect happened after the last update
    await feed.handleMessage(encodeFrame({ code: 0, dataType: 'BTC-USDT@kline_5m', data: [{ o: '1', h: '1', l: '1', c: '1', v: '1', T: t0 + 4 * M5 }] }));
    await feed.settle();
    const f = CC.getCandles('BTC-USDT-SWAP', '5m');
    expect(f.length).toBe(4);
    expect(f.c[3]).toBe(42);
    expect(fired).toEqual([['BTC-USDT-SWAP', '5m']]);
    expect(feed._candlesReceivedTotal).toBe(1);
  });

  it('[WS-FORMING-THROTTLE]: same-bar updates within 5 s skip the cache sync', async () => {
    const feed = pepeFeed();
    const spy = vi.spyOn(feed, '_updateCache');
    await feed.handleMessage(frame('kline_pepe_5m_forming_1.gz'));
    await feed.handleMessage(frame('kline_pepe_5m_forming_2.gz'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(feed._formingSkipped).toBe(1);
    nowMs = NOW_MS + 5000;
    await feed.handleMessage(frame('kline_pepe_5m_forming_2.gz'));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(feed._formingSkipped).toBe(1);
    expect(feed.metrics().forming_skipped).toBe(1);
  });

  it('inbound frames are processed one at a time in arrival order', async () => {
    const feed = pepeFeed();
    const p1 = feed._enqueue(frame('kline_pepe_5m_forming_1.gz'));
    const p2 = feed._enqueue(frame('kline_pepe_5m_next.gz'));
    expect(p1).toBe(p2);
    await p2;
    expect(CC.getCandles('PEPE-USDT-SWAP', '5m').length).toBe(4);
    expect(fired).toEqual([['PEPE-USDT-SWAP', '5m']]);
  });
});

describe('_update_cache semantics (hot path)', () => {
  const SYM = 'BTC-USDT-SWAP', TF = '15m', Q = 900_000;

  it('a forming bar that is not in the cache is a no-op (no set, no fire)', async () => {
    const feed = makeFeed();
    const f = closedFrame(0, 10, Q, 1);
    CC.setCandles(SYM, TF, f, { [TF]: 3600 });
    const spy = vi.spyOn(CC, 'setCandles');
    const forming = f.t[9] + Q;
    for (let i = 0; i < 50; i++) await feed._updateCache(SYM, TF, [BingxWsFeed.okxRow(SYM, forming, 1, 2, 0.5, 1.5, 10, '0')]);
    expect(spy).not.toHaveBeenCalled();
    expect(fired).toEqual([]);
    const out = CC.getCandles(SYM, TF);
    expect(out).toBe(f);
    expect(out.length).toBe(10);
    spy.mockRestore();
  });

  it('a closed bar is appended and fires; a later confirm=0 update of it edits in place', async () => {
    const feed = makeFeed();
    const f = closedFrame(0, 10, Q, 1);
    CC.setCandles(SYM, TF, f, { [TF]: 3600 });
    const ts = f.t[9] + Q;
    await feed._updateCache(SYM, TF, [BingxWsFeed.okxRow(SYM, ts, 1, 2, 0.5, 1.5, 10, '1')]);
    await feed._updateCache(SYM, TF, [BingxWsFeed.okxRow(SYM, ts, 1, 3, 0.5, 2.5, 11, '0')]);
    const out = CC.getCandles(SYM, TF);
    expect(out.length).toBe(11);
    expect([out.h[10], out.c[10], out.v[10]]).toEqual([3, 2.5, 11 * 2.5]);
    expect(fired).toEqual([[SYM, TF]]);
    expect(feed._candlesReceivedTotal).toBe(1);
  });

  it('a confirmed bar older than the last row does not fire', async () => {
    const feed = makeFeed();
    const f = closedFrame(0, 10, Q, 1);
    CC.setCandles(SYM, TF, f, { [TF]: 3600 });
    await feed._updateCache(SYM, TF, [BingxWsFeed.okxRow(SYM, f.t[3], 7, 7, 7, 7, 1, '1')]);
    expect(CC.getCandles(SYM, TF).c[3]).toBe(7);
    expect(fired).toEqual([]);
  });

  it('keeps the last 300 bars and re-sets with TTL_MAP', async () => {
    let t = NOW_MS / 1000;
    CC.initCache(10, { now: () => t, log: silentLog });
    const feed = makeFeed();
    const f = closedFrame(0, CACHE_DEPTH, Q, 1);
    CC.setCandles(SYM, TF, f, { [TF]: 1 });
    const ts = f.t[CACHE_DEPTH - 1] + Q;
    await feed._updateCache(SYM, TF, [BingxWsFeed.okxRow(SYM, ts, 1, 1, 1, 1, 1, '1')]);
    const out = CC.getCandles(SYM, TF);
    expect(out.length).toBe(CACHE_DEPTH);
    expect(out.t[0]).toBe(f.t[1]);
    expect(out.t[CACHE_DEPTH - 1]).toBe(ts);
    t += 3599;                                         // TTL_MAP['15m'] = 3600 → still alive
    expect(CC.getCandles(SYM, TF)).toBe(out);
    t += 2;
    expect(CC.getCandles(SYM, TF)).toBe(null);
  });

  it('okxRow converts BingX prices to OKX units and the volume to USDT', () => {
    expect(BingxWsFeed.okxRow('PEPE-USDT-SWAP', 1000.9, 10, 12, 8, 11, 2000, '1')).toEqual([1000, 0.01, 0.012, 0.008, 0.011, 2000, 2000, 22000, '1']);
  });

  it('errors inside the update are swallowed (debug)', async () => {
    const feed = makeFeed();
    const f = closedFrame(0, 3, Q, 1);
    CC.setCandles(SYM, TF, f, { [TF]: 3600 });
    await feed._updateCache(SYM, TF, [['x', 1, 1, 1, 1, 1, 1, 1, '1']]);
    expect(CC.getCandles(SYM, TF).length).toBe(3);
  });
});

describe('bar-close bus', () => {
  it('register/unregister, async callbacks awaited, errors swallowed', async () => {
    _resetBarCloseCallbacks();
    const seen = [];
    const bad = () => { throw new Error('boom'); };
    const asyncCb = async (s, tf) => { await Promise.resolve(); seen.push(`${s}:${tf}`); };
    registerOnBarClose(bad); registerOnBarClose(asyncCb); registerOnBarClose(asyncCb);
    await fireBarClose('BTC-USDT-SWAP', '1H', silentLog);
    expect(seen).toEqual(['BTC-USDT-SWAP:1H']);
    unregisterOnBarClose(asyncCb);
    unregisterOnBarClose(() => {});
    await fireBarClose('BTC-USDT-SWAP', '1H', silentLog);
    expect(seen).toEqual(['BTC-USDT-SWAP:1H']);
  });
});

describe('connection lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('start: preload, connect, resubscribe on open, timers; stop closes', async () => {
    const WS = makeWsClass();
    const http = makeHttp(() => ({ code: 0, data: [{ symbol: 'BTC-USDT', status: 1 }] }));
    const feed = new BingxWsFeed({ WebSocket: WS, http, now, sleep: sleepSpy(), log: silentLog, env: {} });
    feed.subscribe('BTC-USDT-SWAP', '1H');
    feed.subscribe('ETH-USDT-SWAP', '1H');          // not a live contract — ignored
    expect(feed.activeSubscriptions).toBe(2);        // instruments not loaded yet → accepted
    await feed.start();
    expect(feed.running).toBe(true);
    expect(feed._validInstruments).toEqual(new Set(['BTC-USDT-SWAP']));
    expect(WS.instances).toHaveLength(1);
    expect(WS.instances[0].url).toBe(WSF.BINGX_WS_SWAP);
    const dts = WS.instances[0].sent.map((m) => JSON.parse(m).dataType).sort();
    expect(dts).toEqual(['BTC-USDT@kline_1h', 'ETH-USDT@kline_1h']);
    expect(feed._connectedAt).toBe(NOW_MS / 1000);
    expect(feed.metrics().connected).toBe(true);
    await feed.start();                              // idempotent
    expect(WS.instances).toHaveLength(1);
    // inbound text frames arrive as Buffers with isBinary=false
    WS.instances[0].emit('message', Buffer.from('Ping'), false);
    await feed.settle();
    expect(WS.instances[0].sent.at(-1)).toBe('Pong');
    await feed.stop();
    expect(feed.running).toBe(false);
    expect(WS.instances[0].closed).toBe(true);
  });

  it('reconnects with exponential backoff capped at 30 s and resets on success', async () => {
    const WS = makeWsClass({ failTimes: 6 });
    const sleep = sleepSpy();
    const feed = new BingxWsFeed({ WebSocket: WS, http: makeHttp(() => ({ code: 0, data: [] })), now, sleep, log: silentLog, env: {} });
    feed.subscribe('BTC-USDT-SWAP', '1H');
    await feed.start();                              // first attempt fails → reconnect chain
    await feed.settle();
    expect(WS.instances).toHaveLength(7);
    expect(sleep.calls).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(feed._reconnectDelay).toBe(1.0);
    expect(feed.metrics().connected).toBe(true);
    expect(WS.instances[6].sent.map((m) => JSON.parse(m).dataType)).toEqual(['BTC-USDT@kline_1h']);
    await feed.stop();
  });

  it('a closed socket triggers a reconnect; the cache is not flushed', async () => {
    const WS = makeWsClass();
    const sleep = sleepSpy();
    const feed = new BingxWsFeed({ WebSocket: WS, http: makeHttp(() => ({ code: 0, data: [] })), now, sleep, log: silentLog, env: {} });
    CC.setCandles('BTC-USDT-SWAP', '1H', closedFrame(0, 3, H1, 1), { '1H': 600 });
    await feed.start();
    WS.instances[0].emit('close');
    await feed.settle();
    expect(WS.instances).toHaveLength(2);
    expect(sleep.calls).toEqual([1000]);
    expect(CC.getCandles('BTC-USDT-SWAP', '1H').length).toBe(3);
    await feed.stop();
    WS.instances[1].emit('close');                   // after stop: nothing happens
    await feed.settle();
    expect(WS.instances).toHaveLength(2);
  });

  it('[WS-WATCHDOG]: silence > 300 s forces a reconnect', async () => {
    const WS = makeWsClass();
    const log = logSpy();
    const feed = new BingxWsFeed({ WebSocket: WS, http: makeHttp(() => ({ code: 0, data: [] })), now, sleep: sleepSpy(), log, env: {} });
    await feed.start();
    feed._lastMsgTs = NOW_MS / 1000 - 299;
    await feed._watchdogTick();
    expect(WS.instances).toHaveLength(1);
    feed._lastMsgTs = NOW_MS / 1000 - 301;
    await feed._watchdogTick();
    expect(WS.instances).toHaveLength(2);
    expect(feed._watchdogReconnects).toBe(1);
    expect(feed._lastMsgTs).toBe(NOW_MS / 1000);
    expect(log.lines.warning.some((l) => l.startsWith('[WS-WATCHDOG] silence 301s > 300s — forcing reconnect (#1)'))).toBe(true);
    await feed.stop();
  });

  it('the stale-bar timer and the watchdog run on 5 s / 60 s intervals', async () => {
    vi.useFakeTimers();
    const WS = makeWsClass();
    const feed = new BingxWsFeed({ WebSocket: WS, http: makeHttp(() => ({ code: 0, data: [] })), now, sleep: sleepSpy(), log: silentLog, env: {} });
    const stale = vi.spyOn(feed, '_closeStaleBars').mockResolvedValue();
    const wd = vi.spyOn(feed, '_watchdogTick').mockResolvedValue();
    const started = feed.start();
    await vi.advanceTimersByTimeAsync(0);
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stale).toHaveBeenCalledTimes(12);
    expect(wd).toHaveBeenCalledTimes(1);
    await feed.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stale).toHaveBeenCalledTimes(12);
  });
});
