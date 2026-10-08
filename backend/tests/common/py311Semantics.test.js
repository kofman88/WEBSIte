/**
 * The interpreter-dependent semantics the port re-implements, against values printed by the
 * production interpreter (CPython 3.11.17, unicodedata 14.0.0) and by the bot's own functions:
 * tests/common/fixtures/gen_py311_semantics.py → py311_semantics.json.gz.
 *
 * Node 22 ships Unicode 16 and CPython 3.12 unicodedata 15.0.0; neither is the bot's. Every
 * str method / int() / float() / re class / json.loads / fromtimestamp port must match 3.11 for
 * every code point (unicode section) and for the random inputs of the other sections.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

const req = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const F = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(HERE, 'fixtures', 'py311_semantics.json.gz'))).toString('utf8'));
const { PROD_PYTHON } = req('./prodPython.js');

const U = req('../../strategies/common/pyUnicode.js');
const N = req('../../strategies/common/pynum.js');
const { pyRegExp } = req('../../strategies/common/pyre.js');
const T = req('../../strategies/common/pytime.js');
const CH = req('../../services/challengeService.js');
const PC = req('../../services/exchanges/pyCompat.js');
const CO = req('../../services/engine/pycoerce.js');
const CF = req('../../services/marketData/candleFrame.js');
const VC = req('../../strategies/volume/config.js');
const PV = req('../../strategies/common/pyval.js');
const ST = req('../../strategies/levels/stars.js');
const CS = req('../../services/genome/constraints.js');
const AS = req('../../services/appSettingsService.js');
const BY = req('../../services/exchanges/bybitTrader.js');
const BX = req('../../services/exchanges/bingxTrader.js');
const BN = req('../../services/exchanges/binanceTrader.js');
const SMC = req('../../strategies/smc/config.js');
const SS = req('../../services/engine/signalStats.js');
const PJ = req('../../services/engine/pyjson.js');
const BB = req('../../services/engine/botBody.js');
const WS = req('../../services/marketData/bingxWsFeed.js');
const GT = req('../../services/marketData/globalTrend.js');
const PR = req('../../strategies/common/pyround.js');
const TC = req('../../services/engine/tradeCfg.js');
const LC = req('../../strategies/levels/config.js');
const TR = req('../../services/engine/tracker.js');
const SO = req('../../services/engine/signalOutcome.js');
const CW = req('../../services/marketData/cacheWarmer.js');
const GC = req('../../services/genome/config.js');

const N_CP = 0x110000;
const chr = (c) => String.fromCodePoint(c);
const isExc = (v) => Boolean(v && typeof v === 'object' && 'exc' in v);
function dec(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dec);
  if ('f' in v && Object.keys(v).length === 1) return v.f === 'nan' ? NaN : v.f === 'inf' ? Infinity : v.f === '-inf' ? -Infinity : Number(v.f);
  if ('int' in v && Object.keys(v).length === 1) return BigInt(v.int);
  if ('exc' in v) return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
}
const call = (fn) => { try { return { ok: fn() }; } catch (e) { return { err: e }; } };
const toSet = (ranges) => { const a = new Uint8Array(N_CP); for (const [x, y] of ranges) a.fill(1, x, y + 1); return a; };
const cpIndex = (s, i) => Array.from(s.slice(0, i)).length;     // JS UTF-16 offset → Python code-point offset

/** Collect mismatches instead of failing on the first (a few are shown). */
function check(cases, fn) {
  const bad = [];
  for (const c of cases) {
    const r = fn(c);
    if (r !== true) bad.push(r);
  }
  return bad.slice(0, 5);
}
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Object.is(a, b) : JSON.stringify(a) === JSON.stringify(b));

describe('fixture provenance', () => {
  it('printed by CPython 3.11 with unicodedata 14.0.0', () => {
    expect(F.python).toMatch(PROD_PYTHON);
    expect(F.unidata).toBe('14.0.0');
    expect(U.UNIDATA_VERSION).toBe(F.unidata);
  });
});

describe('unicode tables: every code point', () => {
  const P = F.unicode.props;
  const props = [
    ['isspace', U.isSpace], ['isdecimal', (c) => U.digitValue(c) >= 0], ['isdigit', U.isDigitChar], ['isalnum', U.isAlnumChar],
    ['isprintable', U.isPrintable], ['isupper', U.isUpperFlag], ['islower', U.isLowerFlag], ['istitle_only', U.isTitleFlag],
    ['re_w', U.isWordChar], ['re_d', (c) => U.digitValue(c) >= 0], ['re_s', U.isSpace], ['case_ignorable', U.isCaseIgnorable],
    ['unassigned', U.isUnassigned],
  ];
  for (const [name, fn] of props) {
    it(`${name} over 0..0x10FFFF`, () => {
      const want = toSet(P[name]);
      const bad = [];
      for (let c = 0; c < N_CP; c += 1) if ((fn(c) ? 1 : 0) !== want[c] && bad.length < 5) bad.push(c.toString(16));
      expect(bad).toEqual([]);
    });
  }

  it('re \\d / \\s / \\w / \\b of pyRegExp agree with the tables (a 4k sample of every class edge)', () => {
    const d = pyRegExp(String.raw`^\d$`);
    const s = pyRegExp(String.raw`^\s$`);
    const w = pyRegExp(String.raw`^\w$`);
    const wd = toSet(P.re_d); const ws = toSet(P.re_s); const ww = toSet(P.re_w);
    const edges = new Set();
    for (const rs of [P.re_d, P.re_s, P.re_w]) for (const [a, b] of rs) for (const c of [a - 1, a, b, b + 1]) if (c >= 0 && c < N_CP && !(c >= 0xd800 && c <= 0xdfff)) edges.add(c);
    let n = 0;
    for (const c of edges) {
      n += 1;
      expect(d.test(chr(c)), c.toString(16)).toBe(wd[c] === 1);
      expect(s.test(chr(c)), c.toString(16)).toBe(ws[c] === 1);
      expect(w.test(chr(c)), c.toString(16)).toBe(ww[c] === 1);
    }
    expect(n).toBeGreaterThan(2000);
  });

  it('lower() / upper() / capitalize() of every character (Unicode 15/16 additions keep no mapping)', () => {
    const M = F.unicode.maps;
    const bad = [];
    for (let c = 0; c < N_CP; c += 1) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const ch = chr(c);
      for (const [k, fn] of [['lower', U.pyLower], ['upper', U.pyUpper], ['capitalize', U.pyCapitalize]]) {
        const want = Object.prototype.hasOwnProperty.call(M[k], String(c)) ? M[k][String(c)] : ch;
        if (fn(ch) !== want && bad.length < 5) bad.push(`${k} ${c.toString(16)}`);
      }
    }
    expect(bad).toEqual([]);
    // the Unicode 16 pairs Node maps and CPython 3.11 does not
    expect(U.pyUpper('ɤƛ')).toBe('ɤƛ');
    expect('ɤƛ'.toUpperCase()).not.toBe('ɤƛ');
  });

  it('re.IGNORECASE: an ASCII letter matches exactly what CPython matches (i: İ ı, k: K, s: ſ)', () => {
    for (const [L, cps] of Object.entries(F.unicode.ignorecase)) {
      const re = pyRegExp(`^${L}$`, { ignoreCase: true });
      const cand = new Set([...cps, L.codePointAt(0), L.toUpperCase().codePointAt(0), ...(U.RE_IGNORECASE_EXTRA[L.codePointAt(0)] || [])]);
      for (const c of cand) expect(re.test(chr(c)), `${L} ${c.toString(16)}`).toBe(cps.includes(c));
    }
  });
});

describe('str methods on random text', () => {
  const S = F.strings;
  it(`lower / upper / capitalize / isupper / isdigit / isspace / strip / lstrip / rstrip / repr (${S.length} strings)`, () => {
    expect(S.length).toBeGreaterThanOrEqual(2000);
    const bad = check(S, ([s, lo, up, cap, isup, isdig, issp, st, lst, rst, rep]) => {
      const got = [U.pyLower(s), U.pyUpper(s), U.pyCapitalize(s), U.pyIsupper(s), U.pyIsdigit(s),
        s.length > 0 && Array.from(s).every((ch) => U.isSpace(ch.codePointAt(0))), U.pyStrip(s), U.pyLstrip(s), U.pyRstrip(s), U.pyStrRepr(s)];
      const want = [lo, up, cap, isup, isdig, issp, st, lst, rst, rep];
      return same(got, want) || JSON.stringify({ s, got, want });
    });
    expect(bad).toEqual([]);
  });

  it('the str ports of the services: pyCompat.pyCapitalize / pyStrRepr, challengeService.pyStrRepr / pyStrip', () => {
    const bad = check(S, ([s, , , cap, , , , st, , , rep]) => (PC.pyCapitalize(s) === cap && PC.pyStrRepr(s) === rep
      && CH.pyStrRepr(s) === rep && CH.pyStrip(s) === st) || JSON.stringify(s));
    expect(bad).toEqual([]);
  });

  it('the str helpers take a str only (like the JS methods they replace)', () => {
    for (const fn of [U.pyLower, U.pyUpper, U.pyStrip, U.pyRstrip, U.pyLstrip, U.pyCapitalize, U.pyIsupper, U.pyIsdigit]) {
      expect(() => fn(5)).toThrow(TypeError);
      expect(() => fn(null)).toThrow(TypeError);
    }
  });
});

describe('int(str) / float(str): every port', () => {
  const NUMS = F.numbers.map(dec);
  const asNum = (v) => (typeof v === 'bigint' ? Number(v) : v);
  // [name, int(s) port, float(s) port, compares CPython's message]
  const PORTS = [
    ['challengeService', CH.pyInt, CH.pyFloat, true],
    ['pyCompat', PC.pyInt, PC.pyFloat, true],
    ['pycoerce', CO.pyInt, CO.pyFloat, true],
    ['candleFrame', CF.pyInt, CF.pyFloat, true],
    ['volume/config', VC.pyInt, VC.pyFloat, true],
    ['pyval', null, PV.pyFloat, true],
    ['levels/stars', null, ST.pyFloatStr, true],
    ['genome/constraints', CS.pyIntOf, null, false],
  ];
  it(`${NUMS.length} texts (Unicode 14 digits and spaces, Unicode 15 digits 3.12 accepts, PEP 515, inf/nan, 4300 digits)`, () => {
    expect(NUMS.length).toBeGreaterThanOrEqual(2000);
    for (const [name, pi, pf, msg] of PORTS) {
      const bad = check(NUMS, ([s, wi, wf]) => {
        for (const [fn, want] of [[pi, wi], [pf, wf]]) {
          if (!fn) continue;
          const got = call(() => fn(s));
          if (isExc(want)) {
            if (!got.err) return JSON.stringify({ name, s, got: got.ok, want });
            if (msg && got.err.message !== want.msg) return JSON.stringify({ name, s, msg: got.err.message, want: want.msg });
          } else if (got.err || !same(got.ok, asNum(want))) return JSON.stringify({ name, s, got: got.err ? got.err.message : got.ok, want: asNum(want) });
        }
        return true;
      });
      expect(bad, name).toEqual([]);
    }
  });

  it('exact ints: pyCompat.pyBigInt and challengeService.pyIntStr keep every digit', () => {
    const bad = check(NUMS, ([s, wi]) => {
      if (isExc(wi)) return Boolean(call(() => PC.pyBigInt(s)).err && call(() => CH.pyIntStr(s)).err) || s;
      return (PC.pyBigInt(s) === BigInt(wi) && CH.pyIntStr(s) === String(wi)) || s;
    });
    expect(bad).toEqual([]);
  });

  it('stars_str: int(n or 0) clamped 0..5 (a str that int() rejects counts 0)', () => {
    const bad = check(NUMS, ([s, wi]) => {
      const k = !s || isExc(wi) ? 0 : Math.max(0, Math.min(5, Number(wi)));
      return ST.starsStr(s) === '⭐'.repeat(k) + '☆'.repeat(5 - k) || s;
    });
    expect(bad).toEqual([]);
  });

  it('int() of a float is never -0 (int(-0.5) is 0) and inf / nan raise', () => {
    for (const fn of [CO.pyInt, CF.pyInt, VC.pyInt, PC.pyInt, CH.pyInt]) {
      expect(Object.is(fn(-0.5), 0)).toBe(true);
      expect(Object.is(fn(-0.0), 0)).toBe(true);
      expect(() => fn(NaN)).toThrow('cannot convert float NaN to integer');
      expect(() => fn(Infinity)).toThrow('cannot convert float infinity to integer');
    }
    expect(Object.is(CF.pyInt('-0'), 0)).toBe(true);
  });

  it('env texts: int(os.getenv(...)) parses like CPython (PEP 515, Unicode digits); an invalid value keeps the default', () => {
    const bad = check(NUMS, ([s, wi]) => {
      const pyMax = isExc(wi) ? 200 : Math.max(1, Number(wi));
      const pyIv = isExc(wi) ? GT.DEFAULT_INTERVAL_S : Number(wi);
      if (s !== '' && WS.maxSubsPerConn({ BINGX_WS_MAX_SUBS_PER_CONN: s }) !== pyMax) return `maxSubs ${JSON.stringify(s)}`;
      if (GT.resolveInterval({ TREND_UPDATE_INTERVAL: s }) !== pyIv) return `interval ${JSON.stringify(s)}`;
      return true;
    });
    expect(bad).toEqual([]);
    expect(WS.maxSubsPerConn({ BINGX_WS_MAX_SUBS_PER_CONN: '1_50' })).toBe(150);   // parseInt gave 1
    expect(N.intOrUndefined('５_００')).toBe(500);
  });
});

describe('kb_disabled_days: {int(d) for d in raw.split(",") if d.strip().isdigit()}', () => {
  it(`${F.days.length} raw strings — a set, Unicode digits count, '²' passes isdigit() and int() raises`, () => {
    expect(F.days.length).toBeGreaterThanOrEqual(2000);
    const bad = check(F.days.map(dec), ([raw, want]) => {
      const got = call(() => AS.disabledDays({ autotrade_disabled_days: raw }));
      if (isExc(want)) return (got.err && got.err.message === want.msg) || JSON.stringify({ raw, got: got.ok, want });
      return same(got.ok, want) || JSON.stringify({ raw, got: got.err ? got.err.message : got.ok, want });
    });
    expect(bad).toEqual([]);
    expect(AS.disabledDays({ autotrade_disabled_days: '1,1,٣' })).toEqual([1, 3]);
  });
});

describe('re: the bot\'s patterns through pyRegExp', () => {
  const PATS = F.regex_patterns.map(([p, ic]) => [pyRegExp(p, { ignoreCase: ic }), pyRegExp(p, { ignoreCase: ic, global: true })]);
  it(`re.search span / groups and re.sub (${F.regex.length} texts, ${PATS.length} patterns)`, () => {
    expect(F.regex.length).toBeGreaterThanOrEqual(2000);
    const bad = check(F.regex, ([pi, s, want, sub]) => {
      const m = PATS[pi][0].exec(s);
      const got = m === null ? null : [cpIndex(s, m.index), cpIndex(s, m.index + m[0].length), m.slice(1).map((g) => (g === undefined ? null : g))];
      const gotSub = s.replace(PATS[pi][1], '<>');
      return (same(got, want) && gotSub === sub) || JSON.stringify({ p: F.regex_patterns[pi][0], s, got, want, gotSub, sub });
    });
    expect(bad).toEqual([]);
  });

  it(`_humanize_bybit / bingx / binance_error of the bot (${F.humanize.length} texts)`, () => {
    expect(F.humanize.length).toBeGreaterThanOrEqual(2000);
    const bad = check(F.humanize, ([s, by, bx, bn]) => {
      const got = [BY.humanizeBybitError(s), BX.humanizeBingxError(s), BN.humanizeBinanceError(s)];
      return same(got, [by, bx, bn]) || JSON.stringify({ s, got, want: [by, bx, bn] });
    });
    expect(bad).toEqual([]);
  });
});

describe('the bot\'s own coercions', () => {
  it(`VolumeConfig.from_params: str values (strip / lower / int / float) — ${F.volume_cfg.length} dicts`, () => {
    const bad = check(F.volume_cfg.map(dec), ([p, want]) => {
      const cfg = VC.VolumeConfig.fromParams(p);
      const got = Object.fromEntries(Object.keys(p).map((k) => [k, cfg[k]]));
      return same(got, want) || JSON.stringify({ p, got, want });
    });
    expect(bad).toEqual([]);
  });

  it(`SMCConfig(**{key: 99}) takes the key iff key.isupper() and not key.startswith("_") — ${F.smc_keys.length} keys`, () => {
    const bad = check(F.smc_keys, ([key, taken]) => ((SMC.smcConfig({ [key]: 99 })[key] === 99) === taken && SMC.isUpperKey(key) === taken) || key);
    expect(bad).toEqual([]);
  });

  it(`db.stats.normalize_strategy: str(value).strip().upper() — ${F.normalize_strategy.length} values`, () => {
    const bad = check(F.normalize_strategy, ([v, want]) => SS.normalizeStrategy(v) === want || JSON.stringify([v, SS.normalizeStrategy(v), want]));
    expect(bad).toEqual([]);
  });
});

describe('json.loads', () => {
  it('pyJsonParse: NaN / Infinity, the int -0 is 0, errors where json.loads raises; pyJsonLoads never throws', () => {
    for (const [t, want] of F.json.map(dec)) {
      const got = call(() => PJ.pyJsonParse(t));
      if (isExc(want)) {
        expect(got.err, t).toBeTruthy();
        expect(PJ.pyJsonLoads(t, 'FB'), t).toBe(t === '' ? 'FB' : 'FB');
      } else {
        expect(got.err, t).toBeFalsy();
        expect(same(got.ok, want) || [t, got.ok, want], t).toBe(true);
        expect(same(PJ.pyJsonLoads(t, 'FB'), want), t).toBe(true);
      }
    }
    expect(Object.is(PJ.pyJsonParse('{"x": -0}').x, 0)).toBe(true);
    expect(Object.is(PJ.pyJsonParse('[-0.0]')[0], -0)).toBe(true);
  });
});

describe('datetime.fromtimestamp(ts, tz=utc): half-even microseconds', () => {
  it(`date / hour / weekday (${F.timestamps.length} timestamps, many a hair before a UTC midnight)`, () => {
    expect(F.timestamps.length).toBeGreaterThanOrEqual(2000);
    const bad = check(F.timestamps, ([ts, date, hour, wd]) => {
      const x = Number(ts);
      const got = [T.utcDate(x), T.utcHour(x), T.utcWeekday(x), CH.dayKey(x), CH.utcHour(x)];
      return same(got, [date, hour, wd, date, hour]) || JSON.stringify({ ts, got, want: [date, hour, wd] });
    });
    expect(bad).toEqual([]);
  });

  it('signal stats by_session / by_weekday bucket a trade at …23:59:59.9999996 into the next day like the bot', () => {
    const [ts, date, hour, wd] = F.timestamps.find(([t]) => t === '1704067199.9999995');   // repr of the double nearest …199.9999996
    expect([date, hour, wd]).toEqual(['2024-01-01', 0, 0]);
    const row = { id: 1, user_id: 1, symbol: 'BTC-USDT-SWAP', direction: 'LONG', strategy: 'LEVELS', timeframe: '1h', result: 'TP1',
      result_rr: 1.5, order_id: 'abc', created_at: Number(ts), entry: 100, sl: 99, tp1: 101, tp2: 102, tp3: 103, progress_stage: '' };
    const p = SS.statsPayload([row], { now: Number(ts) + 100 });
    expect(p.by_weekday[wd].trades).toBe(1);
    expect(p.by_session.asia.trades).toBe(1);   // hour 0 (JS Date truncation said Sunday 23:59 → "us")
  });
});

describe('encodings.normalize_encoding (the aiohttp body charset)', () => {
  it(`${F.encodings.length} names, non-ASCII alphanumerics dropped without a '_'`, () => {
    const bad = check(F.encodings, ([n, want]) => BB.normalizeEncoding(n) === want || JSON.stringify([n, BB.normalizeEncoding(n), want]));
    expect(bad).toEqual([]);
  });
});

describe('builtin max(a, b) / min(a, b) clamps: the first argument wins, a NaN second one is ignored', () => {
  const C = F.clamps;
  const show = (v) => JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : Object.is(x, -0) ? '-0' : x));

  it(`pyMax / pyMin (${C.maxmin.length} pairs with NaN / ±0 / ±inf / denormals)`, () => {
    expect(C.maxmin.length).toBeGreaterThanOrEqual(2000);
    const cases = C.maxmin.map(dec);
    const bad = check(cases, ([a, b, mx, mn]) => (same(PR.pyMax(a, b), mx) && same(PR.pyMin(a, b), mn)) || show({ a, b, got: [PR.pyMax(a, b), PR.pyMin(a, b)], want: [mx, mn] }));
    expect(bad).toEqual([]);
    // the cases do separate builtin max/min from Math.max/min
    expect(cases.filter(([a, b, mx, mn]) => !same(Math.max(a, b), mx) || !same(Math.min(a, b), mn)).length).toBeGreaterThan(100);
  });

  it(`TradeCfg.__post_init__ and _cfg_to_ind MIN_RR (${C.trade_cfg.length} configs, engine and levels ports)`, () => {
    expect(C.trade_cfg.length).toBeGreaterThanOrEqual(2000);
    const bad = check(C.trade_cfg.map(dec), ([kw, lmr, want, minRr]) => {
      const a = TC.tradeCfg(kw);
      const b = LC.tradeCfg(kw);
      const pick = (cfg) => Object.fromEntries(Object.keys(want).map((k) => [k, cfg[k]]));
      const okA = Object.keys(want).every((k) => same(a[k], want[k])) && same(TC.cfgToInd(a, { levelsMinRr: lmr }).MIN_RR, minRr);
      const okB = Object.keys(want).every((k) => same(b[k], want[k])) && same(LC.cfgToInd(b, false, { ...LC.LEVELS_ENV, LEVELS_MIN_RR: lmr }).MIN_RR, minRr);
      return (okA && okB) || show({ kw, lmr, engine: pick(a), levels: pick(b), want, minRr });
    });
    expect(bad).toEqual([]);
  });

  it(`signal_tracker / db.signal_outcome env constants (${C.tracker_env.length} environments, module reloaded per env)`, () => {
    let crashes = 0;
    const bad = check(C.tracker_env.map(dec), ([env, crash, want, hours]) => {
      // int(inf) of REST_PER_CYCLE / MAX_ROWS raises at the bot's import: those keep the default on the site
      // (want = the bot's constants without the crashing variables)
      if (crash.length) crashes += 1;
      const got = TR.readConfig(env);
      const gotH = SO.envHours('SIGNAL_TRACKER_MAX_AGE_H', 72.0, env);
      return (Object.keys(want).every((k) => same(got[k], want[k])) && same(gotH, hours)) || show({ env, crash, got, want, gotH, hours });
    });
    expect(bad).toEqual([]);
    expect(crashes).toBeGreaterThan(0);
    expect(TR.readConfig({ SIGNAL_TRACKER_REST_PER_CYCLE: 'inf', SIGNAL_TRACKER_MAX_ROWS: '1e400' })).toMatchObject({ REST_PER_CYCLE: 20, MAX_ROWS: 20000 });
    expect(TR.readConfig({ SIGNAL_TRACKER_INTERVAL_S: 'nan', SIGNAL_MISSED_R: 'nan' })).toMatchObject({ INTERVAL_S: 15, MISSED_R: 0.3 });
  });

  it(`CacheWarmer rate / interval: constructor (${C.warmer.length}) and from_env (${C.warmer_env.length})`, () => {
    const bad = check(C.warmer.map(dec), ([r, c, want]) => {
      const w = new CW.CacheWarmer(null, null, { ratePerSec: r, cycleIntervalS: c });
      return same([w._rate, w._cycleInterval], want) || show({ r, c, got: [w._rate, w._cycleInterval], want });
    });
    expect(bad).toEqual([]);
    // float() raising in from_env kills the bot's warmer task; the site keeps that variable's default
    const bad2 = check(C.warmer_env.map(dec), ([env, crash, want]) => {
      const w = CW.CacheWarmer.fromEnv(null, null, { env });
      return same([w._rate, w._cycleInterval], want) || show({ env, crash, got: [w._rate, w._cycleInterval], want });
    });
    expect(bad2).toEqual([]);
    expect(C.warmer_env.some(([, crash]) => crash.length > 0)).toBe(true);
  });

  it(`genome._GENOME_CPU_SHARE (${C.cpu_share.length} texts; the bot's import raises → the site keeps the default)`, () => {
    expect(GC.defaultCpuShare(C.n_cpu)).toBe(C.default_cpu_share);
    const bad = check(C.cpu_share.map(dec), ([t, want]) => {
      const got = GC.genomeCpuShare({ GENOME_CPU_SHARE: t }, C.n_cpu);
      return same(got, isExc(want) ? C.default_cpu_share : want) || show({ t, got, want });
    });
    expect(bad).toEqual([]);
    expect(GC.genomeCpuShare({ GENOME_CPU_SHARE: 'nan' }, 4)).toBe(1.0);
  });
});
