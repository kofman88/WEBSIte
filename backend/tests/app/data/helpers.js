/**
 * Shared harness for the /api/app data route tests: a fresh SQLite file per test file, raw HTTP
 * over a socket (request targets reach the server byte for byte — no client-side normalisation),
 * the market-data fakes the Python driver used (golden candles, tickers, scanner trend), and the
 * fixture loader.
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import zlib from 'zlib';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

export const FIXTURE_PATH = path.join(process.cwd(), 'tests', 'app', 'data', 'fixtures', 'app_data_replay.json.gz');

/** Must run before the first require of models/database. */
export function setupEnv(name) {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
  process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.DATABASE_PATH = path.join(process.cwd(), 'data', `test-app-data-${name}.db`);
  process.env.DB_QUIET = '1';
  process.env.LOG_LEVEL = 'error';
  process.env.VITEST = 'true';
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* absent */ } });
}

/** The generator's fixture (json.dump with NaN / Infinity literals → pyJsonParse). */
export function loadFixture() {
  const { pyJsonParse } = nodeRequire('../../../services/engine/pyjson.js');
  return pyJsonParse(zlib.gunzipSync(fs.readFileSync(FIXTURE_PATH)).toString('utf8'));
}

/**
 * One raw HTTP/1.1 request ("Connection: close") → { status, headers, text }.
 * `target` is written as is; `body` is a string (utf-8) or null.
 */
export function rawRequest(port, { method, target, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const data = body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8');
    const head = [`${method} ${target} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close'];
    for (const [k, v] of Object.entries(headers)) if (v !== null && v !== undefined) head.push(`${k}: ${v}`);
    if (['POST', 'PUT', 'DELETE'].includes(method) || data.length) head.push(`Content-Length: ${data.length}`);
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', reject);
    sock.on('end', () => {
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf('\r\n\r\n');
      const lines = raw.slice(0, sep).toString('latin1').split('\r\n');
      const status = Number(lines[0].split(' ')[1]);
      const hdrs = {};
      for (const ln of lines.slice(1)) {
        const i = ln.indexOf(':');
        hdrs[ln.slice(0, i).trim().toLowerCase()] = ln.slice(i + 1).trim();
      }
      let rest = raw.slice(sep + 4);
      if (hdrs['transfer-encoding'] === 'chunked') {
        const parts = [];
        for (;;) {
          const e = rest.indexOf('\r\n');
          const n = parseInt(rest.slice(0, e).toString('latin1'), 16);
          if (!n) break;
          parts.push(rest.slice(e + 2, e + 2 + n));
          rest = rest.slice(e + 2 + n + 2);
        }
        rest = Buffer.concat(parts);
      }
      if (hdrs['content-encoding'] === 'gzip') rest = zlib.gunzipSync(rest);
      resolve({ status, headers: hdrs, text: rest.toString('utf8') });
    });
    sock.write(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), data]));
  });
}

const TF_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const goldCache = new Map();

export function goldenBars(name) {
  if (!goldCache.has(name)) {
    const p = path.join(process.cwd(), 'tests', 'golden', 'candles', `${name}.json`);
    goldCache.set(name, JSON.parse(fs.readFileSync(p, 'utf8')).bars);
  }
  return goldCache.get(name);
}

/** drive_app_data.frame_bars: golden bars, cut at close cut_ms, tail n, prices × scale. */
export function frameBars(spec) {
  const gtf = spec.golden.slice(spec.golden.lastIndexOf('_') + 1);
  let bars = goldenBars(spec.golden);
  if (spec.cut_ms !== undefined && spec.cut_ms !== null) bars = bars.filter((b) => b[0] + TF_MS[gtf] <= spec.cut_ms);
  const n = spec.n;
  if (n !== undefined && n !== null) bars = n > 0 ? bars.slice(-n) : [];
  const k = spec.scale === undefined ? 1.0 : Number(spec.scale);
  if (k !== 1.0) bars = bars.map((b) => [b[0], b[1] * k, b[2] * k, b[3] * k, b[4] * k, b[5]]);
  return bars;
}

export function toFrame(bars) {
  if (!bars || !bars.length) return null;
  const { Frame } = nodeRequire('../../../strategies/common/frame.js');
  return Frame.fromBars(bars);
}

/**
 * The fakes of the Python driver: STATE {tickers, rest, trend_raw} mutated per step, the WS
 * cache from cache_seed, scanner.fetcher (REST candles + 24 h tickers) with the same modes.
 */
export function makeMarket(fx, clockRef) {
  const STATE = {
    tickers: JSON.parse(JSON.stringify(fx.tickers)),
    rest: JSON.parse(JSON.stringify(fx.rest_seed)),
    trend_raw: fx.trend_raw,
  };
  const TF_NORM = { '1h': '1H', '1H': '1H', '4h': '4H', '4H': '4H', '1d': '1D', '1D': '1D', '15m': '15m', '30m': '30m' };
  const cache = new Map();
  for (const c of fx.cache_seed) cache.set(`${c.symbol}_${TF_NORM[c.tf] || c.tf}`, toFrame(frameBars(c)));
  const cached = (symbol, tf) => cache.get(`${symbol}_${TF_NORM[tf] || tf}`) || null;

  function barsFor(sym, tf, limit) {
    const spec = STATE.rest[sym];
    if (!spec || spec.mode === 'none') return null;
    if (spec.mode === 'raise') throw new Error('REST boom');
    const gtf = { '1h': '1h', '4h': '4h', '15m': '15m', '1d': '1d' }[String(tf).toLowerCase()];
    if (!gtf) return null;
    const n = spec.mode === 'short' ? (spec.n === undefined ? limit : spec.n) : limit;
    return frameBars({ golden: `${sym}_${gtf}`, cut_ms: spec.cut_ms, n: Math.min(n, limit) });
  }
  const rest = {
    async getCandles(symbol, tf, limit = 300) { return toFrame(barsFor(symbol, tf, limit)); },
    async get24hChange(symbol) {
      const t = STATE.tickers[symbol];
      if (!t || t.mode === 'none') return null;
      if (t.mode === 'raise') throw new Error('timeout');
      let last = t.last;
      if (typeof last === 'number' && t.drift) last += t.drift * (clockRef.now - fx.now);
      return { last, change_pct: t.change_pct };
    },
  };
  const bridge = {
    cachedCandles: (symbol, tf) => cached(symbol, tf),
    currentPrices: (symbols) => {
      const out = {};
      for (const s of symbols) {
        out[s] = null;
        for (const tf of ['15m', '1H', '4H']) {
          const f = cached(s, tf);
          if (f && f.length > 0 && f.c[f.length - 1] > 0) { out[s] = f.c[f.length - 1]; break; }
        }
      }
      return out;
    },
    globalTrend: () => STATE.trend_raw,
    marketTrend: null,     // set per test (a trendMonitor instance)
  };
  return { STATE, rest, bridge, cached };
}

export function insertUser(db, id, { isAdmin = 0, locale = 'ru' } = {}) {
  db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, referral_code, is_admin, locale) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `u${id}@x.test`, 'x', `R${id}`, isAdmin, locale);
}

/** Seed users / trader_settings / signal_trades / trade_events / engine_kv like the driver. */
export function seedAll(db, ts, fx) {
  for (const [uid, plan, status, exp, lang, admin] of fx.users) {
    insertUser(db, uid, { isAdmin: admin, locale: lang });
    const u = ts.getOrCreate(uid);
    Object.assign(u, { sub_plan: plan, sub_status: status, sub_expires: exp ? fx.now + exp : 0, lang });
    ts.save(u);
  }
  const cols = fx.trade_cols;
  const ins = db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const r of fx.trades) ins.run(...cols.map((c) => (r[c] === undefined ? null : r[c])));
  const ev = db.prepare('INSERT INTO trade_events (trade_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?)');
  for (const e of fx.events) ev.run(e.trade_id, e.ts, e.event_type, e.payload_json);
  const kv = db.prepare('INSERT OR REPLACE INTO engine_kv (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(fx.kv)) kv.run(k, v, fx.now);
}

/** Deep equality with Python float semantics (NaN == NaN for the comparison, -0 == 0). */
export function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;   // key ORDER too
    return ka.every((k) => same(a[k], b[k]));
  }
  return a === b;
}

/** The first differing path between two JSON values (for failure messages). */
export function firstDiff(a, b, p = '$') {
  if (same(a, b)) return null;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${p}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${p}[${i}]`); if (d) return d; }
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
    const ka = Object.keys(a); const kb = Object.keys(b);
    if (ka.join('|') !== kb.join('|')) return `${p}: keys ${JSON.stringify(ka)} vs ${JSON.stringify(kb)}`;
    for (const k of ka) { const d = firstDiff(a[k], b[k], `${p}.${k}`); if (d) return d; }
  }
  return `${p}: ${JSON.stringify(a)?.slice(0, 200)} vs ${JSON.stringify(b)?.slice(0, 200)}`;
}
