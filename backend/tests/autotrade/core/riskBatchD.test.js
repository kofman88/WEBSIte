/**
 * Batch D (bot c56653d, auto_trade.py 1bfc59c + d8123a2) — the pure pieces against the bot's own
 * values, from fixtures/execute_vectors.json.gz (gen/gen_execute_vectors.py `helpers` and
 * `count_vectors`; the flows themselves are the `d2_*` vectors of executeReplay.test.js):
 *   _vol15_max_risk_pct / _same_direction_cap / _fee_aware_sizing_enabled per raw env value (value, and
 *     the one WARNING per value on two calls), _vol15_risk_cap(strategy, timeframe, risk_mode),
 *     _taker_fee(exchange), _fee_aware_factor(entry, sl, exchange), _vol15_required_balance(...),
 *   db_count_open_trades(user_id, exclude_trade_id, direction) on the same seeded trade rows.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const req = createRequire(import.meta.url);
const Database = req('better-sqlite3');
const { loadFixture } = req('./harness.js');
const { createExecutor, vol15RequiredBalance, TAKER_FEE_FALLBACK } = req('../../../services/autotrade/executeAutoTrade');
const { createTradeDb } = req('../../../services/autotrade/tradeDb');
const { createSignalTradesRepo } = req('../../../services/engine/signalTradesRepo');
const { MODULES } = req('../../../services/autotrade/traders');
const { resolveExchange } = req('../../../services/exchanges');
const schema = req('../../../models/engineSchema');

const FX = loadFixture();
const H = FX.helpers;
const unf = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v) && '__float__' in v) {
    return { nan: NaN, inf: Infinity, '-inf': -Infinity }[v.__float__];
  }
  return Array.isArray(v) ? v.map(unf) : v;
};

function makeExec(env = {}) {
  const lines = [];
  const mk = (level) => (m) => { if (level !== 'DEBUG') lines.push([level, String(m)]); };
  const log = { debug: mk('DEBUG'), info: mk('INFO'), warning: mk('WARNING'), error: mk('ERROR') };
  const traderFor = (ex) => ({ exchange: resolveExchange(ex), mod: MODULES[resolveExchange(ex)] });
  const exec = createExecutor({ env, log, traderFor, db: {}, cooldowns: {}, config: {} });
  return { risk: exec._risk, lines };
}

describe('batch D helpers — bot vs site', () => {
  it('the fixture carries the helper and count vectors', () => {
    expect(H.env.length).toBeGreaterThanOrEqual(75);
    expect(H.risk_cap.length).toBeGreaterThan(200);
    expect(FX.count_vectors.queries.length).toBeGreaterThan(80);
    // the trader constants the bot reads are the site's
    for (const [ex, v] of Object.entries(FX.taker_fee)) expect(MODULES[ex].TAKER_FEE, ex).toBe(v);
  });

  const FN = {
    VOLUME_15M_MAX_RISK_PCT: 'vol15MaxRiskPct',
    AUTO_TRADE_MAX_SAME_DIRECTION: 'sameDirectionCap',
    AUTO_TRADE_FEE_AWARE_SIZING: 'feeAwareSizingEnabled',
  };
  for (const v of H.env) {
    it(`${v.name}=${JSON.stringify(v.raw)}`, () => {
      const env = v.raw === null ? {} : { [v.name]: v.raw };
      const { risk, lines } = makeExec(env);
      const got = [risk[FN[v.name]](), risk[FN[v.name]]()];
      expect(got).toEqual(unf(v.values));
      expect(lines).toEqual(v.logs);
    });
  }

  it('_vol15_risk_cap(strategy, timeframe, risk_mode)', () => {
    const { risk } = makeExec({});
    for (const [st, tf, rm, cap] of H.risk_cap) {
      expect(risk.vol15RiskCap(st, tf, rm), JSON.stringify([st, tf, rm])).toBe(cap);
    }
  });

  it('_taker_fee(exchange) and the fallback table', () => {
    const { risk } = makeExec({});
    for (const [ex, fee] of H.taker) expect(risk.takerFee(ex), JSON.stringify(ex)).toBe(fee);
    expect(TAKER_FEE_FALLBACK).toEqual({ bybit: 0.0006, bingx: 0.0005, binance: 0.0005, okx: 0.0005 });
  });

  it('_fee_aware_factor(entry, sl, exchange)', () => {
    const { risk } = makeExec({});
    for (const [e, sl, ex, f, rt] of H.factor) {
      expect(risk.feeAwareFactor(unf(e), unf(sl), ex), JSON.stringify([e, sl, ex])).toEqual([f, rt]);
    }
  });

  it('_vol15_required_balance(entry, sl, size_risk_pct, trader_required)', () => {
    for (const [args, [kind, v]] of H.required_balance) {
      const a = unf(args);
      if (kind === 'ok') expect(vol15RequiredBalance(...a), JSON.stringify(args)).toBe(v);
      else expect(() => vol15RequiredBalance(...a), JSON.stringify(args)).toThrow();
    }
  });
});

describe('db_count_open_trades(user_id, exclude_trade_id, direction) — bot vs site', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)');
  db.exec(schema.signalTradesDDL());
  for (const tr of FX.count_vectors.rows) {
    const cols = Object.keys(tr);
    db.prepare(`INSERT INTO signal_trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((k) => tr[k]));
  }
  const log = { debug() {}, info() {}, warning() {}, error() {} };
  const now = () => 1767781800;
  const tdb = createTradeDb({ db, now, log, repo: createSignalTradesRepo({ db, now, log, onClosed: null }), invalidateUserCache: () => {} });
  it('every query of the bot', async () => {
    for (const [uid, exc, dir, n] of FX.count_vectors.queries) {
      const got = dir === null ? await tdb.countOpenTrades(uid, exc) : await tdb.countOpenTrades(uid, exc, dir);
      expect(got, JSON.stringify([uid, exc, dir])).toBe(n);
    }
  });
});
