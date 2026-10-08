'use strict';
/**
 * bingxWsFeed.js — BingX Perpetual Swap kline feed (`ws_feed_bingx.py` on top of
 * `ws_feed.py`), one object per shard/connection.
 *
 * Protocol (wss://open-api-swap.bingx.com/swap-market):
 *   * every server frame is BINARY gzip (JSON or text); "Ping" → client sends "Pong"
 *     (JSON `{"ping":id}` → `{"pong":id,"time":…}` also supported);
 *   * one subscribe message per channel `{"id","reqType":"sub","dataType":"BTC-USDT@kline_1h"}`,
 *     10 messages then a 0.1 s pause;
 *   * pushes `{"code":0,"dataType":"…","data":[{o,h,l,c,v,T}]}` carry no "closed" flag:
 *     a bar is closed when a push with a newer T arrives on the same channel (the
 *     previous bar goes to the cache as confirmed); the stale-bar timer closes bars
 *     `T + tf + 15 s` after their interval ended (illiquid coins).
 *
 * Cache semantics (`_update_cache`, exact): forming bars are never stored; a confirmed
 * bar is appended (trim to the last 300) or, when its open-time is already in the
 * cache, overwritten in place; `setCandles` with `TTL_MAP`; a confirmed bar that is
 * the last row fires the bar-close bus (`registerOnBarClose`). An empty cache
 * reserves the channel and REST-loads it (`[WS-REFILL]` when the reservation is older
 * than 60 s).
 *
 * Liveness: `_lastMsgTs` on every frame, watchdog every 60 s (silence > 300 s →
 * `[WS-WATCHDOG]` reconnect), reconnect backoff 1→30 s, the cache is NOT flushed on
 * reconnect. Up to 200 subscriptions per connection (`BINGX_WS_MAX_SUBS_PER_CONN`).
 */

const zlib = require('zlib');
const crypto = require('crypto');
const { TextDecoder } = require('util');
const { log: defaultLog } = require('./mdLog');
const { fetchJson } = require('./httpClient');
const { defaultSleep } = require('./rateGate');
const sym = require('./symbolMap');
const candleCache = require('./candleCache');
const { parseContracts } = require('./bingxRest');
const {
  TF_NORM, TTL_MAP, TF_NORM_TO_BINGX, BINGX_TO_TF_NORM, TF_MS,
  pyInt, pyFloat, pyFalsy, frameIndexOf, frameSetRow, frameAppendRow, frameTrim,
} = require('./candleFrame');

const BINGX_WS_SWAP = 'wss://open-api-swap.bingx.com/swap-market';
const BINGX_CONTRACTS_URL = 'https://open-api.bingx.com/openApi/swap/v2/quote/contracts';

const SUB_BATCH = 10;
const SUB_PAUSE_MS = 100;
const CLOSE_GRACE_S = 15.0;
const FORMING_SYNC_S = 5.0;        // [WS-FORMING-THROTTLE]
const REFILL_MIN_GAP_S = 60.0;     // [WS-REFILL]
const WATCHDOG_SILENCE_THRESHOLD_S = 300;
const WATCHDOG_CHECK_INTERVAL_S = 60;
const STALE_CHECK_INTERVAL_S = 5;
const CACHE_DEPTH = 300;
const WS_TF_MS = TF_MS; // bar lengths per BingX interval (1M excluded in the bot's WS table; never subscribed)

function maxSubsPerConn(env = process.env) {
  const raw = env.BINGX_WS_MAX_SUBS_PER_CONN;
  const n = parseInt(raw === undefined || raw === '' ? '200' : raw, 10);
  if (!Number.isFinite(n)) return 200;
  return Math.max(1, n);
}

// ── bar-close event bus (module-level, like ws_feed._on_bar_close_callbacks) ──
const _onBarCloseCallbacks = [];

/** cb(instId, tfNorm) sync or async; errors are swallowed per callback. */
function registerOnBarClose(cb) { if (!_onBarCloseCallbacks.includes(cb)) _onBarCloseCallbacks.push(cb); }
function unregisterOnBarClose(cb) { const i = _onBarCloseCallbacks.indexOf(cb); if (i >= 0) _onBarCloseCallbacks.splice(i, 1); }
async function fireBarClose(instId, tfNorm, log = defaultLog) {
  for (const cb of _onBarCloseCallbacks.slice()) {
    try {
      const r = cb(instId, tfNorm);
      if (r && typeof r.then === 'function') await r;
    } catch (e) {
      log.debug(`ws_feed bar_close cb ${cb.name || cb}: ${e && e.message}`);
    }
  }
}
function _resetBarCloseCallbacks() { _onBarCloseCallbacks.length = 0; }

// ── frames / channels ───────────────────────────────────────────────────────

/** ("BTC-USDT-SWAP", "1H") → "BTC-USDT@kline_1h"; null for an unknown tf. */
function channelName(instId, tfNorm) {
  const iv = TF_NORM_TO_BINGX[TF_NORM[tfNorm] ?? tfNorm];
  if (!iv) return null;
  return `${sym.toBingx(instId)}@kline_${iv}`;
}

/** "1000PEPE-USDT@kline_5m" → ["PEPE-USDT-SWAP", "5m"] or null. */
function parseChannel(dataType) {
  if (!dataType || !String(dataType).includes('@kline_')) return null;
  const i = String(dataType).indexOf('@kline_');
  const s = String(dataType).slice(0, i);
  const iv = String(dataType).slice(i + '@kline_'.length);
  const tfNorm = BINGX_TO_TF_NORM[iv.trim().toLowerCase()];
  const canon = sym.fromBingx(s);
  if (!tfNorm || !canon) return null;
  return [canon, tfNorm];
}

const _utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** BINARY gzip → string. Text frames and uncompressed bytes come back as-is; undecodable → null. */
function decodeFrame(data) {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') return data;
  let raw = null;
  if (Buffer.isBuffer(data)) raw = data;
  else if (data instanceof ArrayBuffer) raw = Buffer.from(data);
  else if (ArrayBuffer.isView(data)) raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (Array.isArray(data) && data.every(Buffer.isBuffer)) raw = Buffer.concat(data);
  if (raw === null) return null;
  for (const decomp of [(b) => zlib.unzipSync(b), (b) => zlib.gunzipSync(b), (b) => zlib.inflateRawSync(b)]) {
    try {
      return decomp(raw).toString('utf8');
    } catch (_e) { /* try the next codec */ }
  }
  try {
    return _utf8Strict.decode(raw);
  } catch (_e) {
    return null;
  }
}

/** T of a push → bar open time: close-time style `…999` (open + tf − 1) is normalised. */
function barOpenMs(tMs, tfBingx) {
  const t = pyInt(tMs);
  const tfMs = WS_TF_MS[tfBingx] || 0;
  if (tfMs && (t + 1) % 1000 === 0) return t + 1 - tfMs;
  return t;
}

/** gzip a JSON/text frame (test fixtures, smoke tooling). */
function encodeFrame(obj) {
  const raw = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return zlib.gzipSync(Buffer.from(raw, 'utf8'));
}

const keyOf = (instId, tfNorm) => `${instId}|${tfNorm}`;

class BingxWsFeed {
  constructor({
    fetcher = null, cache = candleCache, maxSubscriptions = 200,
    WebSocket = null, http = fetchJson, now = () => Date.now(), sleep = defaultSleep,
    log = defaultLog, url = BINGX_WS_SWAP, env = process.env, shardId = 0,
  } = {}) {
    this.source = 'bingx';
    this.shardId = shardId;
    this._fetcher = fetcher;
    this._cache = cache;
    this._maxSubs = Math.min(pyInt(maxSubscriptions), maxSubsPerConn(env));
    this._WebSocket = WebSocket; // lazily require('ws') when null
    this._http = http;
    this._nowMs = now;
    this._sleep = sleep;
    this._log = log;
    this._url = url;

    this._ws = null;
    this._subscriptions = new Map();   // key → [instId, tfNorm]
    this._invalidSymbols = new Set();
    this._validInstruments = null;
    this._running = false;
    this._reconnectDelay = 1.0;
    this._reconnecting = false;
    this._loadedChannels = new Set();  // "inst_tf" reservations
    this._channelFillTs = new Map();   // "inst_tf" → s
    this._lastMsgTs = this._nowS();
    this._watchdogReconnects = 0;
    this._candlesReceivedTotal = 0;

    this._channelMap = new Map();      // dataType → key
    this._barState = new Map();        // key → {T,o,h,l,c,v,recvTs}
    this._lastEmitted = new Map();     // key → open_ms
    this._pendingSubs = [];
    this._flushTask = null;
    this._subIds = new Map();          // request id → dataType
    this._connectedAt = 0.0;
    this._pingsReceived = 0;
    this._pongsSent = 0;
    this._subErrors = 0;
    this._pushesReceived = 0;
    this._formingSyncTs = new Map();
    this._formingSkipped = 0;

    this._queue = [];                  // inbound frames, processed one at a time like the recv loop
    this._draining = null;
    this._tasks = new Set();           // fire-and-forget promises (refresh after reconnect)
    this._pingTimer = null;
    this._watchdogTimer = null;
    this._sent = [];                   // last outbound messages (diagnostics / tests), capped
  }

  _nowS() { return this._nowMs() / 1000; }

  // ── public API ────────────────────────────────────────────────────────────

  get activeSubscriptions() { return this._subscriptions.size; }
  get subscriptions() { return Array.from(this._subscriptions.values()); }
  get running() { return this._running; }

  metrics() {
    return {
      last_msg_ts: this._lastMsgTs,
      watchdog_reconnects: this._watchdogReconnects,
      candles_received_total: this._candlesReceivedTotal,
      pings_received: this._pingsReceived,
      pongs_sent: this._pongsSent,
      pushes_received: this._pushesReceived,
      sub_errors: this._subErrors,
      forming_skipped: this._formingSkipped,
      subscriptions: this._subscriptions.size,
      loaded_channels: this._loadedChannels.size,
      connected: this._wsOpen(),
    };
  }

  async start() {
    if (this._running) return;
    this._running = true;
    await this._preloadValidInstruments();
    await this._connect();
    // Prime the liveness clock before the watchdog arms itself.
    this._lastMsgTs = this._nowS();
    this._pingTimer = setInterval(() => { this._closeStaleBars().catch(() => {}); }, STALE_CHECK_INTERVAL_S * 1000);
    this._watchdogTimer = setInterval(() => { this._watchdogTick().catch(() => {}); }, WATCHDOG_CHECK_INTERVAL_S * 1000);
    if (this._pingTimer.unref) this._pingTimer.unref();
    if (this._watchdogTimer.unref) this._watchdogTimer.unref();
    this._log.info('BingX WebSocket feed запущен');
  }

  async stop() {
    this._running = false;
    if (this._pingTimer) clearInterval(this._pingTimer);
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    this._pingTimer = this._watchdogTimer = null;
    this._closeSocket();
    this._log.info('BingX WebSocket feed остановлен');
  }

  subscribe(instId, tf) {
    if (this._invalidSymbols.has(instId)) return;
    if (this._validInstruments !== null && !this._validInstruments.has(instId)) {
      this._invalidSymbols.add(instId);
      return;
    }
    const tfNorm = TF_NORM[tf] ?? tf;
    const key = keyOf(instId, tfNorm);
    if (this._subscriptions.has(key)) return;
    if (this._subscriptions.size >= this._maxSubs) {
      this._log.warning(`ws_feed_bingx: достигнут лимит подписок (${this._maxSubs})`);
      return;
    }
    this._subscriptions.set(key, [instId, tfNorm]);
    if (this._wsOpen()) {
      this._pendingSubs.push(key);
      if (!this._flushTask) {
        this._flushTask = this._flushPending().finally(() => { this._flushTask = null; });
      }
    }
  }

  unsubscribe(instId, tf) {
    const tfNorm = TF_NORM[tf] ?? tf;
    const key = keyOf(instId, tfNorm);
    this._subscriptions.delete(key);
    if (this._wsOpen()) {
      const p = this._sendUnsubscribe([key]);
      this._track(p);
    }
  }

  subscribeSymbols(symbols, timeframes) {
    for (const s of symbols) for (const tf of timeframes) this.subscribe(s, tf);
  }

  /** Reserve a channel (idempotent) and stamp the time — [WS-REFILL]. */
  reserveChannel(channelKey) {
    this._loadedChannels.add(channelKey);
    this._channelFillTs.set(channelKey, this._nowS());
  }

  /** Reserved ≥ 60 s ago → may be refilled. */
  channelStale(channelKey, now = null) {
    if (!this._loadedChannels.has(channelKey)) return false;
    const t = now === null ? this._nowS() : now;
    return t - (this._channelFillTs.get(channelKey) || 0) >= REFILL_MIN_GAP_S;
  }

  /** Wait for fire-and-forget work (tests). */
  async settle() {
    while (this._tasks.size || this._queue.length || this._draining) {
      await Promise.allSettled(Array.from(this._tasks));
      if (this._draining) await this._draining;
      if (!this._tasks.size && !this._queue.length && !this._draining) break;
    }
    if (this._flushTask) await this._flushTask;
  }

  // ── subscriptions ─────────────────────────────────────────────────────────

  async _flushPending() {
    while (this._pendingSubs.length) {
      const batch = this._pendingSubs;
      this._pendingSubs = [];
      await this._sendSubscribe(batch);
    }
  }

  _subMessage(dataType, req = 'sub') {
    const rid = crypto.randomBytes(16).toString('hex');
    this._subIds.set(rid, dataType);
    if (this._subIds.size > 5000) this._subIds.delete(this._subIds.keys().next().value);
    return JSON.stringify({ id: rid, reqType: req, dataType });
  }

  async _sendSubscribe(keys) {
    let sent = 0;
    for (const key of keys) {
      const entry = this._subscriptions.get(key);
      if (!entry) continue;
      const dt = channelName(entry[0], entry[1]);
      if (!dt) continue;
      this._channelMap.set(dt, key);
      if (!this._wsOpen()) return;
      try {
        this._rawSend(this._subMessage(dt, 'sub'));
      } catch (e) {
        this._log.warning(`ws_feed_bingx subscribe error: ${e && e.message}`);
        return;
      }
      sent += 1;
      if (sent % SUB_BATCH === 0) await this._sleep(SUB_PAUSE_MS);
    }
    if (sent) this._log.debug(`ws_feed_bingx: отправлено ${sent} подписок`);
  }

  async _sendUnsubscribe(keys) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const [instId, tfNorm] = key.split('|');
      const dt = channelName(instId, tfNorm);
      if (!dt) continue;
      try {
        this._rawSend(this._subMessage(dt, 'unsub'));
      } catch (e) {
        this._log.warning(`ws_feed_bingx unsubscribe failed: ${e && e.message} — cleaning from set`);
        for (const k of keys) this._subscriptions.delete(k);
        return;
      }
      this._channelMap.delete(dt);
      this._barState.delete(key);
      if ((i + 1) % SUB_BATCH === 0) await this._sleep(SUB_PAUSE_MS);
    }
  }

  // ── connection ────────────────────────────────────────────────────────────

  /** Live BingX contracts (status == 1, crypto only) → canonical symbols. */
  async _preloadValidInstruments() {
    try {
      const resp = await this._http(BINGX_CONTRACTS_URL, { timeoutMs: 10_000 });
      if (resp.status !== 200) {
        this._log.warning(`ws_feed_bingx: contracts HTTP ${resp.status}`);
        return;
      }
      const rows = ((resp.json || {}).data) || [];
      const { liveRaw, canon } = parseContracts(rows);
      sym.rememberLive(liveRaw);
      if (!canon.size) {
        this._log.warning('ws_feed_bingx: BingX вернул пустой список контрактов');
        return;
      }
      this._log.info(`ws_feed_bingx: ${canon.size} активных контрактов BingX`);
      this._validInstruments = canon;
    } catch (e) {
      this._log.warning(`ws_feed_bingx: ошибка предзагрузки контрактов: ${e && e.message}`);
      this._validInstruments = null;
    }
  }

  _wsOpen() { return !!this._ws && this._ws.readyState === 1; }

  _rawSend(text) {
    this._ws.send(text);
    this._sent.push(text);
    if (this._sent.length > 50) this._sent.shift();
  }

  _closeSocket() {
    const ws = this._ws;
    this._ws = null;
    if (!ws) return;
    try { ws.removeAllListeners && ws.removeAllListeners(); } catch (_e) { /* fake sockets */ }
    try { if (ws.terminate) ws.terminate(); else ws.close(); } catch (_e) { /* already closed */ }
  }

  _wsClass() {
    if (!this._WebSocket) this._WebSocket = require('ws');
    return this._WebSocket;
  }

  /** Open the socket; resolves when connected (or after a failed attempt with `_ws = null`). */
  _connect() {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      let ws;
      try {
        const WS = this._wsClass();
        ws = new WS(this._url, { perMessageDeflate: false, handshakeTimeout: 10_000 });
      } catch (e) {
        this._log.warning(`BingX WS connect failed: ${e && e.message}`);
        this._ws = null;
        done();
        return;
      }
      this._ws = ws;
      ws.on('open', () => {
        this._reconnectDelay = 1.0;
        this._connectedAt = this._nowS();
        this._pendingSubs = [];
        this._log.info('BingX WS подключен');
        const p = this._subscriptions.size ? this._sendSubscribe(Array.from(this._subscriptions.keys())) : Promise.resolve();
        p.catch(() => {}).then(done);
      });
      ws.on('message', (data, isBinary) => {
        this._enqueue(isBinary === false && Buffer.isBuffer(data) ? data.toString('utf8') : data);
      });
      ws.on('error', (err) => {
        if (this._ws !== ws) return;
        this._log.warning(`BingX WS error: ${err && err.message}`);
        if (!settled) {
          // failed before open — mirrors `_connect` catching the exception
          this._ws = null;
          done();
          this._scheduleReconnect();
        }
      });
      ws.on('close', () => {
        if (this._ws !== ws) return;
        this._log.warning('BingX WS closed/error, reconnecting...');
        this._ws = null;
        done();
        this._scheduleReconnect();
      });
    });
  }

  _scheduleReconnect() {
    if (!this._running || this._reconnecting) return;
    this._reconnecting = true;
    const p = this._reconnect()
      .catch((e) => this._log.warning(`ws_feed_bingx reconnect error: ${e && e.message}`))
      .finally(() => {
        this._reconnecting = false;
        if (this._running && !this._ws) this._scheduleReconnect(); // connect failed → keep backing off
      });
    this._track(p);
  }

  /** Reconnect with exponential backoff (1 → 30 s). The cache is intentionally NOT flushed. */
  async _reconnect() {
    if (!this._running) return;
    const delay = Math.min(this._reconnectDelay, 30.0);
    this._log.info(`BingX WS reconnect через ${delay.toFixed(1)}с...`);
    await this._sleep(delay * 1000);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, 30.0);
    this._closeSocket();
    if (!this._running) return;
    await this._connect();
  }

  async _watchdogTick() {
    if (!this._running) return;
    const silence = this._nowS() - this._lastMsgTs;
    if (silence > WATCHDOG_SILENCE_THRESHOLD_S) {
      this._watchdogReconnects += 1;
      this._log.warning(`[WS-WATCHDOG] silence ${Math.round(silence)}s > ${WATCHDOG_SILENCE_THRESHOLD_S}s — forcing reconnect (#${this._watchdogReconnects})`);
      this._lastMsgTs = this._nowS();
      if (this._reconnecting) return;
      this._reconnecting = true;
      try {
        await this._reconnect();
      } catch (e) {
        this._log.warning(`ws_feed._watchdog_loop reconnect failed: ${e && e.message}`);
      } finally {
        this._reconnecting = false;
        if (this._running && !this._ws) this._scheduleReconnect();
      }
    }
  }

  _track(p) {
    this._tasks.add(p);
    p.finally(() => this._tasks.delete(p)).catch(() => {});
    return p;
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  _enqueue(raw) {
    this._queue.push(raw);
    if (!this._draining) {
      this._draining = this._drain().finally(() => { this._draining = null; });
    }
    return this._draining;
  }

  async _drain() {
    while (this._queue.length) {
      const raw = this._queue.shift();
      try {
        await this.handleMessage(raw);
      } catch (e) {
        this._log.warning(`ws_feed_bingx recv error: ${e && e.message}`);
      }
    }
  }

  _sendText(text) {
    if (!this._wsOpen()) return false;
    try {
      this._rawSend(text);
      return true;
    } catch (e) {
      this._log.debug(`ws_feed_bingx send ${JSON.stringify(text.slice(0, 40))} failed: ${e && e.message}`);
      return false;
    }
  }

  /** One inbound frame (Buffer or string). Public so tests and the smoke tool can feed frames. */
  async handleMessage(raw) {
    this._lastMsgTs = this._nowS();
    const text = decodeFrame(raw);
    if (!text) return;
    const stripped = text.trim();
    if (stripped === 'Ping' || stripped === 'ping') {
      this._pingsReceived += 1;
      if (this._sendText('Pong')) this._pongsSent += 1;
      return;
    }
    if (stripped === 'Pong' || stripped === 'pong') return;
    let data;
    try { data = JSON.parse(stripped); } catch (_e) { return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    if ('ping' in data) { // JSON heartbeat variant
      this._pingsReceived += 1;
      if (this._sendText(JSON.stringify({ pong: data.ping, time: data.time === undefined ? null : data.time }))) this._pongsSent += 1;
      return;
    }

    const dataType = data.dataType || '';
    const payload = data.data;
    const code = data.code === undefined ? 0 : data.code;
    if (!(code === 0 || code === '0' || code === null)) {
      this._subErrors += 1;
      const dt = dataType || this._subIds.get(String(data.id ?? '')) || '';
      if (this._subErrors <= 20 || this._subErrors % 100 === 0) {
        this._log.warning(`BingX WS error code=${code} msg=${data.msg} dataType=${dt}`);
      }
      return;
    }
    if (!dataType || pyFalsy(payload)) return; // subscribe ack and the like

    const key = this._channelMap.get(dataType) || (() => { const p = parseChannel(dataType); return p ? keyOf(p[0], p[1]) : null; })();
    if (!key) return;
    if (!this._subscriptions.has(key)) {
      this._log.debug(`ws_feed_bingx: push для неподписанного ${dataType} — игнорируем`);
      return;
    }
    const [, tfNorm] = this._subscriptions.get(key);
    const items = Array.isArray(payload) ? payload : [payload];
    const tfBingx = TF_NORM_TO_BINGX[tfNorm] || '1h';
    const bars = [];
    for (const it of items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
      try {
        const t = 'T' in it ? it.T : ('t' in it ? it.t : it.time);
        const vRaw = 'v' in it ? it.v : 0;
        bars.push([
          barOpenMs(pyInt(t), tfBingx),
          pyFloat(it.o), pyFloat(it.h), pyFloat(it.l), pyFloat(it.c),
          pyFloat(pyFalsy(vRaw) ? 0 : vRaw),
        ]);
      } catch (_e) { /* skip malformed item */ }
    }
    if (!bars.length) return;
    this._pushesReceived += 1;
    bars.sort((a, b) => a[0] - b[0]);
    for (const b of bars) await this._onKline(key, ...b);
  }

  // ── candles ───────────────────────────────────────────────────────────────

  /** BingX bar (BingX prices) → OKX WS row [ts, o, h, l, c, vol, volCcy, volCcyQuote(USDT), confirm] (numbers). */
  static okxRow(instId, openMs, o, h, l, c, v, confirm) {
    const mult = sym.priceMultiplier(instId) || 1.0;
    const volUsdt = v * c; // base volume × close in BingX units = USDT
    return [Math.trunc(openMs), o / mult, h / mult, l / mult, c / mult, v, v, volUsdt, confirm];
  }

  async _emitClosed(key, st) {
    const [instId, tfNorm] = this._subscriptions.get(key) || key.split('|');
    this._lastEmitted.set(key, st.T);
    if ((st.recvTs || 0) < this._connectedAt) {
      // The bar's last update predates a reconnect — final values may be lost; REST re-load.
      this._track(this._refreshClosedBar(instId, tfNorm));
      return;
    }
    await this._updateCache(instId, tfNorm, [BingxWsFeed.okxRow(instId, st.T, st.o, st.h, st.l, st.c, st.v, '1')]);
  }

  async _refreshClosedBar(instId, tfNorm) {
    try {
      await this._initialLoad(instId, tfNorm);
      this._candlesReceivedTotal += 1;
      await fireBarClose(instId, tfNorm, this._log);
    } catch (e) {
      this._log.debug(`ws_feed_bingx refresh ${instId}/${tfNorm}: ${e && e.message}`);
    }
  }

  async _onKline(key, openMs, o, h, l, c, v) {
    const [instId, tfNorm] = this._subscriptions.get(key) || key.split('|');
    const lastEmit = this._lastEmitted.get(key) || 0;
    if (openMs <= lastEmit) {
      // Late update of an already-closed bar: fix the cached values, no second bar-close.
      await this._updateCache(instId, tfNorm, [BingxWsFeed.okxRow(instId, openMs, o, h, l, c, v, '0')]);
      return;
    }
    const st = this._barState.get(key);
    const sameBar = !!st && openMs === st.T;
    if (st) {
      if (openMs < st.T) return;                                   // out-of-order older bar
      if (openMs > st.T && st.T > lastEmit) await this._emitClosed(key, st); // newer T → previous bar closed
    }
    const now = this._nowS();
    this._barState.set(key, { T: openMs, o, h, l, c, v, recvTs: now });
    if (sameBar && now - (this._formingSyncTs.get(key) || 0) < FORMING_SYNC_S) {
      this._formingSkipped += 1; // [WS-FORMING-THROTTLE]
      return;
    }
    this._formingSyncTs.set(key, now);
    await this._updateCache(instId, tfNorm, [BingxWsFeed.okxRow(instId, openMs, o, h, l, c, v, '0')]);
  }

  /** Close bars whose interval ended > CLOSE_GRACE_S ago without a newer push. */
  async _closeStaleBars(nowMs = null) {
    const t = nowMs === null ? Math.trunc(this._nowMs()) : nowMs;
    const graceMs = Math.trunc(CLOSE_GRACE_S * 1000);
    for (const [key, st] of Array.from(this._barState.entries())) {
      const tfNorm = key.split('|')[1];
      const tfMs = WS_TF_MS[TF_NORM_TO_BINGX[tfNorm] || ''] || 0;
      if (!tfMs || st.T <= (this._lastEmitted.get(key) || 0)) continue;
      if (t >= st.T + tfMs + graceMs) await this._emitClosed(key, st);
    }
  }

  /**
   * `ws_feed._update_cache` (exact): rows [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm].
   * Empty cache → reserve + REST load (or [WS-REFILL]); forming bars not in the index
   * are skipped; confirmed/known bars are written, trimmed to 300, re-set with TTL_MAP;
   * a confirmed last row fires the bar-close bus.
   */
  async _updateCache(instId, tfNorm, candles) {
    try {
      let existing = this._cache.getCandles(instId, tfNorm);
      if (!existing || existing.length === 0) {
        const channelKey = `${instId}_${tfNorm}`;
        if (this._fetcher) {
          if (!this._loadedChannels.has(channelKey)) {
            this.reserveChannel(channelKey);
            await this._initialLoad(instId, tfNorm);
          } else if (this.channelStale(channelKey)) {
            this.reserveChannel(channelKey);
            this._log.info(`[WS-REFILL] ${instId}/${tfNorm}: cache empty for reserved channel — reloading`);
            await this._initialLoad(instId, tfNorm);
          }
        }
        return;
      }
      for (const candle of candles) {
        const ts = pyInt(candle[0]);
        const confirmed = candle[8] === '1';
        const idx = frameIndexOf(existing, ts);
        const inIndex = idx >= 0;
        if (!confirmed && !inIndex) continue; // forming bars are never stored
        const o = pyFloat(candle[1]), h = pyFloat(candle[2]), l = pyFloat(candle[3]), c = pyFloat(candle[4]);
        const vol = pyFloat(candle[7]); // volCcyQuote (USDT)
        if (inIndex) {
          frameSetRow(existing, idx, o, h, l, c, vol);
        } else {
          existing = frameAppendRow(existing, ts, o, h, l, c, vol);
          if (existing.length > CACHE_DEPTH) existing = frameTrim(existing, CACHE_DEPTH);
        }
        const ttl = TTL_MAP[tfNorm] ?? 3600;
        this._cache.setCandles(instId, tfNorm, existing, { [tfNorm]: ttl });
        if (confirmed && existing && ts === existing.t[existing.length - 1]) {
          this._candlesReceivedTotal += 1;
          await fireBarClose(instId, tfNorm, this._log);
        }
      }
    } catch (e) {
      this._log.debug(`ws_feed update_cache ${instId}/${tfNorm}: ${e && e.message}`);
    }
  }

  /** REST history (300 closed bars) → cache with TTL_MAP. */
  async _initialLoad(instId, tfNorm) {
    if (!this._fetcher) return;
    try {
      const frame = await this._fetcher.getCandles(instId, tfNorm, 300);
      if (frame && frame.length > 0) {
        const ttl = TTL_MAP[tfNorm] ?? 3600;
        this._cache.setCandles(instId, tfNorm, frame, { [tfNorm]: ttl });
        this._log.debug(`ws_feed initial load ${instId}/${tfNorm}: ${frame.length} bars`);
      }
    } catch (e) {
      this._log.debug(`ws_feed initial_load ${instId}/${tfNorm}: ${e && e.message}`);
    }
  }

  /** Public alias used by the pool's initial fill and the warmer. */
  initialLoad(instId, tfNorm) { return this._initialLoad(instId, tfNorm); }
}

function makeFeed(opts = {}) { return new BingxWsFeed(opts); }

module.exports = {
  BingxWsFeed, makeFeed, decodeFrame, encodeFrame, barOpenMs, channelName, parseChannel, keyOf,
  registerOnBarClose, unregisterOnBarClose, fireBarClose, _resetBarCloseCallbacks, maxSubsPerConn,
  BINGX_WS_SWAP, BINGX_CONTRACTS_URL, SUB_BATCH, SUB_PAUSE_MS, CLOSE_GRACE_S, FORMING_SYNC_S,
  REFILL_MIN_GAP_S, WATCHDOG_SILENCE_THRESHOLD_S, WATCHDOG_CHECK_INTERVAL_S, CACHE_DEPTH,
};
