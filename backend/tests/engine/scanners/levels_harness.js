/**
 * levels_harness — the JS side of the scanner differential replays (levels_scan.test.js,
 * volume_scan.test.js): the same fakes as py/levels_fakes.py (pinned clock, counter randint,
 * golden-candle REST fetcher, recording bot, canned execute_auto_trade / balances / charts /
 * metrics) and the observation helpers that put the JS state into the fixture's shapes.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Frame } = require('../../../strategies/common/frame');
const keyboards = require('../../../services/engine/cards/keyboards');

const GOLDEN = path.join(__dirname, '..', '..', 'golden', 'candles');
const TF_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const TF_ALIAS = { '15m': '15m', '1h': '1h', '1H': '1h', '4h': '4h', '4H': '4h', '1d': '1d', '1D': '1d' };

function loadFixture(file) {
  const raw = fs.readFileSync(file);
  const text = file.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return JSON.parse(text);
}

const fullFrames = new Map();
function fullFrame(symbol, tf) {
  const key = `${symbol}_${tf}`;
  if (!fullFrames.has(key)) {
    const p = path.join(GOLDEN, `${key}.json`);
    fullFrames.set(key, fs.existsSync(p) ? Frame.fromFixture(JSON.parse(fs.readFileSync(p, 'utf8'))) : null);
  }
  return fullFrames.get(key);
}

/** levels_fakes.frame_at: bars with open + tf ≤ now, the last `limit`. */
function frameAt(symbol, tf, nowS, limit = 300) {
  const t = TF_ALIAS[tf] || tf;
  const f = fullFrame(symbol, t);
  if (!f) return null;
  const n = f.countClosedAt(TF_MS[t], Math.trunc(nowS * 1000));
  const start = limit ? Math.max(0, n - limit) : 0;
  if (n - start <= 0) return null;
  return f.slice(start, n);
}

class Clock {
  constructor(t = 0) { this.t = t; }
  now() { return this.t; }
  monotonic() { return this.t; }
}

/** levels_fakes.Rand: randint(a, b) = a + (37·k + 11) mod (b − a + 1). */
class Rand {
  constructor() { this.k = 0; }
  randint(a, b) {
    const v = a + ((37 * this.k + 11) % (b - a + 1));
    this.k += 1;
    return v;
  }
}

class FakeFetcher {
  constructor(clock, volumes, globalTrend) {
    this.clock = clock;
    this.volumes = { ...volumes };
    this.globalTrend = globalTrend || {};
    this.volBySym = {};
    this.calls = [];
    this.missing = new Set();      // symbols whose REST call returns null
    this.raiseOn = new Set();      // "symbol|tf" whose REST call throws
  }

  async getCandles(symbol, tf, limit = 300) {
    this.calls.push(['candles', symbol, tf, Math.trunc(limit)]);
    if (this.raiseOn.has(`${symbol}|${tf}`)) throw new Error('rest down');
    if (this.missing.has(symbol)) return null;
    return frameAt(symbol, tf, this.clock.now(), Math.trunc(limit));
  }

  async getAllUsdtPairs(minVolumeUsdt = 1_000_000, blacklist = null, maxCoins = 0) {
    this.calls.push(['pairs', Number(minVolumeUsdt), (blacklist || []).slice().sort(), Math.trunc(maxCoins)]);
    const bl = new Set(blacklist || []);
    const items = Object.entries(this.volumes).filter(([s, v]) => v >= minVolumeUsdt && !bl.has(s));
    items.sort((a, b) => b[1] - a[1]);   // stable
    const capped = maxCoins ? items.slice(0, maxCoins) : items;
    this.volBySym = Object.fromEntries(capped);
    return capped.map(([s]) => s);
  }

  async getGlobalTrend() {
    this.calls.push(['global_trend']);
    return this.globalTrend;
  }
}

class FakeBot {
  constructor() { this.sent = []; this.fail = new Set(); this.nextId = 5000; }

  async sendMessage(uid, text, kw = {}) {
    const rec = {
      uid: Number(uid), text, parse_mode: kw.parseMode === undefined ? null : kw.parseMode,
      protect_content: Boolean(kw.protectContent), disable_notification: Boolean(kw.disableNotification),
      kb: kw.replyMarkup ? keyboards.toTelegram(kw.replyMarkup) : null,
    };
    if (this.fail.has(Number(uid))) {
      rec.failed = true;
      this.sent.push(rec);
      const e = new Error('Telegram server says - Forbidden: bot was blocked by the user');
      e.name = 'TelegramForbiddenError';
      throw e;
    }
    this.nextId += 1;
    rec.message_id = this.nextId;
    this.sent.push(rec);
    return { message_id: this.nextId, html: text, actions: kw.replyMarkup || null, lang: 'ru' };
  }
}

/** A capturing logger factory: lines [level, name, message] at INFO and above. */
function logCapture() {
  const lines = [];
  const make = (name) => ({
    debug() {},
    info(m) { lines.push(['INFO', name, String(m)]); },
    warning(m) { lines.push(['WARNING', name, String(m)]); },
    warn(m) { lines.push(['WARNING', name, String(m)]); },
    error(m) { lines.push(['ERROR', name, String(m)]); },
    exception(m) { lines.push(['ERROR', name, String(m)]); },
  });
  return { lines, make };
}

function memKv() {
  const m = new Map();
  return {
    map: m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    delete: (k) => { m.delete(k); },
    del: (k) => { m.delete(k); },
    has: (k) => m.has(k),
  };
}

/** JSON-normalise a value for comparison (non-finite floats like the fixture encoder). */
function norm(x) {
  return JSON.parse(JSON.stringify(x, (_k, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return { $f: Number.isNaN(v) ? 'nan' : (v > 0 ? 'inf' : '-inf') };
    if (typeof v === 'bigint') return Number(v);
    if (v instanceof Map) return Object.fromEntries(v);
    return v;
  }));
}

module.exports = { loadFixture, frameAt, fullFrame, Clock, Rand, FakeFetcher, FakeBot, logCapture, memKv, norm, TF_MS };
