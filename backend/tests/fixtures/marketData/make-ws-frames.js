#!/usr/bin/env node
'use strict';
/**
 * Generates the committed BingX WS frame fixtures under ./ws-frames (gzip/zlib/raw
 * deflate/plain bytes) plus manifest.json. The frames are synthesised in the exact
 * shape BingX sends on wss://open-api-swap.bingx.com/swap-market (captured protocol:
 * binary gzip JSON, "Ping" text, one push per channel with {o,h,l,c,v,T}). Timestamps
 * are fixed so the WS state-machine tests inject `now = NOW_MS`.
 *
 *   node tests/fixtures/marketData/make-ws-frames.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, 'ws-frames');
fs.mkdirSync(OUT, { recursive: true });

const M5 = 300_000;
const H1 = 3_600_000;
// A fixed "now": 2024-05-29T16:36:40Z — aligned so the 5m bar open times are round.
const NOW_MS = 1_717_000_600_000;
const T0 = Math.floor(NOW_MS / M5) * M5 - 10 * M5; // start of the cached history (10 closed 5m bars ago)
const T3 = T0 + 3 * M5;                             // the in-progress bar in the tests
const H0 = Math.floor(NOW_MS / H1) * H1 - 5 * H1;

const gz = (o) => zlib.gzipSync(Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)));
const kline = (base, iv, T, o, h, l, c, v) => ({
  code: 0, dataType: `${base}-USDT@kline_${iv}`, s: `${base}-USDT`,
  data: [{ o: String(o), h: String(h), l: String(l), c: String(c), v: String(v), T }],
});

const frames = {
  'ping.gz': { bytes: gz('Ping'), text: 'Ping', note: 'server heartbeat; client must answer "Pong"' },
  'json_ping.gz': { bytes: gz({ ping: 'abc', time: '2026-10-06T00:00:00' }), note: 'JSON heartbeat variant → {"pong":"abc","time":…}' },
  'sub_ack.gz': { bytes: gz({ id: 'c0ffee', code: 0, msg: '' }), note: 'subscribe acknowledgement — ignored' },
  'sub_error.gz': { bytes: gz({ id: 'bad1', code: 80015, msg: 'bad symbol' }), note: 'subscribe error — counted in sub_errors' },
  'kline_pepe_5m_forming_1.gz': { bytes: gz(kline('1000PEPE', '5m', T3, 10, 11, 9, 10.5, 1000)), note: 'first update of the forming bar T3 (BingX units ×1000)' },
  'kline_pepe_5m_forming_2.gz': { bytes: gz(kline('1000PEPE', '5m', T3, 10, 12, 8, 11.0, 2000)), note: 'second (cumulative) update of T3' },
  'kline_pepe_5m_next.gz': { bytes: gz(kline('1000PEPE', '5m', T3 + M5, 11, 11, 11, 11, 5)), note: 'newer T → T3 is closed with the last known values' },
  'kline_pepe_5m_late.gz': { bytes: gz(kline('1000PEPE', '5m', T3, 10, 12, 8, 11.2, 2100)), note: 'late update of the already-closed T3 (correct values, no second bar-close)' },
  'kline_pepe_5m_old.gz': { bytes: gz(kline('1000PEPE', '5m', T0, 1, 1, 1, 1, 1)), note: 'out-of-order old bar — ignored' },
  'kline_btc_1h_closetime.gz': { bytes: gz(kline('BTC', '1h', H0 + 2 * H1 + H1 - 1, 100, 101, 99, 100.5, 3)), note: 'close-time style T (…999) → open = T + 1 − tf' },
  'kline_btc_1h_unsubscribed.gz': { bytes: gz(kline('BTC', '1h', H0 + 2 * H1, 1, 1, 1, 1, 1)), note: 'push for a channel the feed did not subscribe — dropped' },
  'kline_toncoin_4h.gz': { bytes: gz(kline('TONCOIN', '4h', Math.floor(NOW_MS / (4 * H1)) * 4 * H1 - 4 * 4 * H1, 5, 6, 4, 5.5, 10)), note: 'alias TONCOIN → TON-USDT-SWAP, tf 4h → 4H' },
  'kline_multi_unsorted.gz': {
    bytes: gz({ code: 0, dataType: 'ETH-USDT@kline_15m', s: 'ETH-USDT', data: [
      { o: '2', h: '2', l: '2', c: '2', v: '1', T: T0 + 2 * 900_000 },
      { o: '1', h: '1', l: '1', c: '1', v: '1', T: T0 + 900_000 },
      { o: 'x', h: '1', l: '1', c: '1', v: '1', T: T0 },
    ] }),
    note: 'two valid items out of order + one malformed (skipped); items are processed oldest-first',
  },
  'zlib_frame.bin': { bytes: zlib.deflateSync(Buffer.from('{"a":1}')), text: '{"a":1}', note: 'zlib-wrapped (auto header) — decoded by unzipSync' },
  'raw_deflate.bin': { bytes: zlib.deflateRawSync(Buffer.from('{"raw":true}')), text: '{"raw":true}', note: 'raw deflate — third codec' },
  'plain_text.bin': { bytes: Buffer.from('{"plain":true}'), text: '{"plain":true}', note: 'uncompressed bytes — returned as utf-8' },
  'garbage.bin': { bytes: Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x67, 0x61, 0x72]), text: null, note: 'neither compressed nor utf-8 → null' },
};

const manifest = { NOW_MS, T0, T3, H0, M5, H1, frames: {} };
for (const [name, { bytes, text, note }] of Object.entries(frames)) {
  fs.writeFileSync(path.join(OUT, name), bytes);
  const entry = { note, size: bytes.length };
  if (text !== undefined) entry.text = text;
  manifest.frames[name] = entry;
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${Object.keys(frames).length} frames to ${OUT}`);
