/**
 * Harness of the adversarial differential replay (appDiff.test.js): raw HTTP with Buffer bodies
 * (sent while the answer is read — a server may answer before it has read a large body), the
 * driver's market fakes (golden candles, REST modes ok / none / raise / empty / short, tickers
 * ok / none / raise / empty, NaN-tailed closes), the seed (users, trader_settings, signal_trades,
 * trade_events with id gaps, engine_kv, support tickets for the bot's seeded feedback ids) and
 * byte-level comparison helpers.
 */
import fs from 'fs';
import path from 'path';
import net from 'net';
import zlib from 'zlib';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);

export const FIXTURE_PATH = path.join(process.cwd(), 'tests', 'app', 'diff', 'fixtures', 'app_diff.json.gz');

/** Must run before the first require of models/database. */
export function setupEnv(name) {
  process.env.NODE_ENV = 'development';
  process.env.JWT_SECRET = 'test-jwt-secret-0123456789abcdef012';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abc';
  process.env.WALLET_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.DATABASE_PATH = path.join(process.cwd(), 'data', `test-app-diff-${name}.db`);
  process.env.DB_QUIET = '1';
  process.env.LOG_LEVEL = 'error';
  process.env.VITEST = 'true';
  const p = process.env.DATABASE_PATH;
  ['', '-wal', '-shm'].forEach((ext) => { try { fs.unlinkSync(p + ext); } catch (_e) { /* absent */ } });
}

export function loadFixture() {
  const { pyJsonParse } = nodeRequire('../../../services/engine/pyjson.js');
  return pyJsonParse(zlib.gunzipSync(fs.readFileSync(FIXTURE_PATH)).toString('utf8'));
}

/** The request body of a fixture step as bytes (utf-8 text, base64 bytes, or a {head, pad, n, tail} spec). */
export function stepBody(s) {
  if (s.body_b64) return Buffer.from(s.body_b64, 'base64');
  if (s.body_spec) {
    const b = s.body_spec;
    return Buffer.concat([Buffer.from(b.head, 'utf8'), Buffer.alloc(b.n, b.pad), Buffer.from(b.tail, 'utf8')]);
  }
  if (s.body === null || s.body === undefined) return null;
  return Buffer.from(s.body, 'utf8');
}

/** One raw HTTP/1.1 request ("Connection: close") → { status, headers, raw (Buffer) }. */
export function rawRequest(port, { method, target, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const data = body === null || body === undefined ? Buffer.alloc(0) : body;
    const head = [`${method} ${target} HTTP/1.1`, 'Host: 127.0.0.1', 'Connection: close'];
    for (const [k, v] of Object.entries(headers)) if (v !== null && v !== undefined) head.push(`${k}: ${v}`);
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) || data.length) head.push(`Content-Length: ${data.length}`);
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', (e) => { if (e.code !== 'EPIPE' && e.code !== 'ECONNRESET') reject(e); });
    sock.on('close', () => {
      const raw = Buffer.concat(chunks);
      const sep = raw.indexOf('\r\n\r\n');
      if (sep < 0) { reject(new Error(`no response (${raw.length} bytes)`)); return; }
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
      resolve({ status, headers: hdrs, raw: rest });
    });
    sock.write(Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'));
    let off = 0;
    const pump = () => {
      while (off < data.length) {
        const chunk = data.subarray(off, off + 65536);
        off += chunk.length;
        if (!sock.write(chunk)) { sock.once('drain', pump); return; }
      }
    };
    pump();
  });
}

// ── market fakes ─────────────────────────────────────────────────────────
const TF_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000 };
const goldCache = new Map();

function goldenBars(name) {
  if (!goldCache.has(name)) {
    const p = path.join(process.cwd(), 'tests', 'golden', 'candles', `${name}.json`);
    goldCache.set(name, JSON.parse(fs.readFileSync(p, 'utf8')).bars);
  }
  return goldCache.get(name);
}

/** drive_app_diff.frame_bars */
export function frameBars(spec) {
  const gtf = spec.golden.slice(spec.golden.lastIndexOf('_') + 1);
  let bars = goldenBars(spec.golden).map((b) => b.slice());
  if (spec.cut_ms !== undefined && spec.cut_ms !== null) bars = bars.filter((b) => b[0] + TF_MS[gtf] <= spec.cut_ms);
  const n = spec.n;
  if (n !== undefined && n !== null) bars = n > 0 ? bars.slice(-n) : [];
  const k = spec.scale === undefined ? 1.0 : Number(spec.scale);
  if (k !== 1.0) bars = bars.map((b) => [b[0], b[1] * k, b[2] * k, b[3] * k, b[4] * k, b[5]]);
  for (let i = 0; i < Number(spec.nan_close || 0); i++) if (i < bars.length) bars[bars.length - 1 - i][4] = NaN;
  return bars;
}

/** bars → Frame; [] → an empty Frame (the Python fake's empty DataFrame), null → null. */
export function toFrame(bars) {
  const { Frame } = nodeRequire('../../../strategies/common/frame.js');
  if (bars === null || bars === undefined) return null;
  if (!bars.length) return Frame.fromColumns({ t: [], o: [], h: [], l: [], c: [], v: [] });
  return Frame.fromBars(bars);
}

export function makeMarket(fx, clockRef) {
  const STATE = {
    tickers: JSON.parse(JSON.stringify(fx.tickers)),
    rest: JSON.parse(JSON.stringify(fx.rest_seed)),
    trend_raw: fx.trend_raw,
  };
  const cache = new Map();
  for (const c of fx.cache_seed) cache.set(`${c.symbol}|${c.tf}`, toFrame(frameBars(c)));
  // cache.get_candles(symbol, tf) keys: the bot's cache normalises nothing beyond the TF strings the callers pass
  const cached = (symbol, tf) => cache.get(`${symbol}|${tf}`) || null;

  function barsFor(sym, tf, limit) {
    const spec = STATE.rest[sym];
    if (!spec || spec.mode === 'none') return null;
    if (spec.mode === 'raise') throw new Error(`REST boom ${sym}`);
    if (spec.mode === 'empty') return [];
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
      if (t.mode === 'empty') return {};
      let last = t.last;
      // the driver drifts Python floats only; every drifting ticker of the seed has a fractional price
      if (typeof last === 'number' && !Number.isInteger(last) && t.drift) last += t.drift * (clockRef.now - fx.now);
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
    globalTrend: () => {
      if (STATE.trend_raw === 'raise') throw new Error('trend boom');
      return STATE.trend_raw;
    },
    marketTrend: null,
  };
  return { STATE, rest, bridge, cached };
}

// ── seed ─────────────────────────────────────────────────────────────────
export function insertUser(db, id, { isAdmin = 0, locale = 'ru' } = {}) {
  db.prepare('INSERT OR IGNORE INTO users (id, email, password_hash, referral_code, is_admin, locale) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, `u${id}@x.test`, 'x', `R${id}`, isAdmin, locale || 'ru');
}

const tableOf = (sql) => sql.split('{T}').join('signal_trades');

/** Run a step's SQL (the bot's `trades` statements on `signal_trades`). */
export function applySql(db, stmts) {
  for (const [sql, params] of stmts || []) db.prepare(tableOf(sql)).run(...params);
}

export function seedAll(db, ts, fx) {
  for (const [uid, plan, status, exp, lang, strat, admin] of fx.users) {
    insertUser(db, uid, { isAdmin: admin, locale: lang });
    const u = ts.getOrCreate(uid);
    if (plan !== null) u.sub_plan = plan;
    if (status !== null) u.sub_status = status;
    if (exp !== null) u.sub_expires = exp ? fx.now + exp : 0;
    if (lang !== null) u.lang = lang;
    if (strat !== null) u.strategy = strat;
    ts.save(u);
  }
  insertUser(db, fx.fresh_uid);
  const cols = fx.trade_keys;
  const ins = db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const r of fx.trades) ins.run(...cols.map((c) => (r[c] === undefined ? null : r[c])));
  const ev = db.prepare('INSERT INTO trade_events (id, trade_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?, ?)');
  for (const e of fx.events) ev.run(e.id, e.trade_id, e.ts, e.event_type, e.payload_json);
  const kv = db.prepare('INSERT OR REPLACE INTO engine_kv (key, value, updated_at) VALUES (?, ?, ?)');
  for (const [k, v] of Object.entries(fx.kv)) kv.run(k, v, fx.now);
  const tk = db.prepare("INSERT INTO support_tickets (id, user_id, subject, body, status, priority) VALUES (?, ?, ?, ?, 'open', 'normal')");
  for (const [id, uid, type, text] of fx.feedback_seed) tk.run(id, uid, `seed ${type}`, text);
}

/** Storage classes of the seeded rows — must equal the bot's typeof() snapshot. */
export function seededTypes(db, cols) {
  const rows = db.prepare(`SELECT trade_id AS tid, ${cols.map((c) => `typeof(${c}) AS "t_${c}"`).join(', ')} FROM signal_trades`).all();
  return Object.fromEntries(rows.map((r) => [r.tid, cols.map((c) => r[`t_${c}`])]));
}

// ── comparison ───────────────────────────────────────────────────────────
/** Deep equality with Python float semantics (NaN == NaN here, -0 == 0), key order included. */
export function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b || (Number.isNaN(a) && Number.isNaN(b));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => same(a[k], b[k]));
  }
  return a === b;
}

/** Where two byte strings first differ, with context. */
export function byteDiff(got, want) {
  const n = Math.min(got.length, want.length);
  let i = 0;
  while (i < n && got[i] === want[i]) i++;
  if (i === n && got.length === want.length) return null;
  const ctx = (b) => JSON.stringify(b.slice(Math.max(0, i - 60), i + 80).toString('utf8'));
  return `@${i} (len ${got.length} vs ${want.length}): site ${ctx(got)} | bot ${ctx(want)}`;
}
