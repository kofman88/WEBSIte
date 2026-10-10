/**
 * volumeScanner — the bot's volume_scanner.py (VOLUME «Торговля по объёму и MA») one-to-one
 * (signal-pipeline.md §2.3, strategy-volume.md scanner sections).
 *
 * Cycle (every SCAN_INTERVAL s, woken early by a WS bar close): eligible users (VOLUME primary
 * or extra, a vol_* direction on, access, `can("volume")`) → universe (pairs ≥ $300k →
 * volume_filter.apply_vol_filter cap 150) → groups by (user TF, json.dumps(cfg, sort_keys))
 * → per group, per symbol: candles (WS cache → REST), analyze_volume (HTF pre-pass, HTF frame
 * only for candidates, 180 s HTF cache), MTF bonus, squeeze bonus, [VOLUME-CTX-GATE] → per user
 * (cap MAX_SIGNALS_PER_USER_CYCLE, direction toggles) → `_deliver`: `_sent_bars` memo,
 * exchange listing, blacklist, [VOL-POST-SL-PAUSE] (the user's latest delivered VOLUME signal of
 * the coin + direction ended SL < VOLUME_POST_SL_PAUSE_BARS bars of the TF ago → skipped, fail-open),
 * freshness, registry peek / MULTI peek + claim, the signal_trades row, confluence, auto-trade
 * (Market, the signal TF), card, commit (dedup_ttl_s of the TF) or SKIP not_delivered, limit
 * message, chart, [VOLUME-SIGNAL].
 *
 * Entry quality [2026-10] (bot batch D): [VOL-LIQ-15M] the 15m groups scan only coins with a 24 h
 * volume ≥ VOLUME_15M_COINS_FLOOR_USDT ($5M, `coinsForTf`); [VOL-MIN-SL] / [VOL-MIN-VOLUME] live in
 * strategies/volume (15m stop floor, ribbon / bounce / golden volume floor) — the scanner logs a
 * widened stop once per bar; kv keeps the pre-floor values (`saveUserCfg`).
 *
 * Module-level state of the bot (`_sent_bars`, `_htf_cache`, `_WAKE_EVENT`) lives on a scanner
 * instance (`createVolumeScanner(deps)`); the module exports a default instance whose
 * `runVolumeScanner(bot, um, fetcher, {health, intervalSec})` mirrors the bot's
 * `run_volume_scanner(bot, um, fetcher, health=health)`.
 *
 * ── deps (every member optional; the bot equivalent on the right) ────────────────────────
 *   clock { now(), monotonic() }       time.time() / time.monotonic()
 *   sleep(ms), timers                  asyncio.sleep / wait_for timeouts
 *   random { randint(a, b) }           random.randint (trade_id suffix)
 *   log                                log = getLogger("CHM.VolumeScanner")
 *   filterLog / strategyLog / tgLog    volume_filter's "CHM.VolumeFilter", volume_strategy's
 *                                      "CHM.VolumeStrategy" ([VOLUME-ERR]), telegram_safe's "CHM.TgSafe"
 *   cache { getCandles(sym, tf) }      cache.get_candles (WS candle cache; '1H' / '4H' / '1D' keys)
 *   trend, registry, freshness, confluence, coinQuality   as in levelsScanner
 *   exchangeSymbols { isAvailable, recordSkip }            exchange_symbols
 *   repo, emitEvent, rememberSignalMessage, safeSendMessage, metrics, sendChart,
 *   executeAutoTrade, getApiKeys, getBalance               as in levelsScanner
 *   kv { get, set, delete }            db.db_kv_get / db_kv_set / db_kv_delete (volume_cfg_<uid>)
 *   checkAccess(user), can(user, feature), strategyEnabled(user, S)   UserSettings / config
 *   wsFeed { registerOnBarClose(cb) }  ws_feed.register_on_bar_close
 *   analysisExecutor(fn) → value | Promise   loop.run_in_executor(None, analyze_volume, …)
 *
 * Markers: [VOLUME-START], [VOLUME-CYCLE], [VOLUME-PROFILE], [VOLUME-CTX-GATE], [VOLUME-SIGNAL],
 * [VOLUME-CFG], [VOLUME], [VOLUME-ERR], [TRACE-AT-FAIL], [VOL-LIQ-15M], [VOL-POST-SL-PAUSE],
 * [VOL-MIN-SL], [VOL-MIN-VOLUME].
 */

'use strict';

const volume = require('../../strategies/volume');
const { computeSqueezeScore } = require('../../strategies/common/squeeze');
const { fmtFixed, fmtG } = require('../../strategies/common/pyfmt');
const { pyRound } = require('../../strategies/common/pyround');
const { pyTruthy } = require('../../strategies/common/pyval');
const { pyLower, pyUpper, pyStrip } = require('../../strategies/common/pyUnicode');
const { pyMax } = require('../../strategies/common/pyround');
const { toFloat } = require('../../strategies/volume/quality');
const { pyStr } = require('../exchanges/pyCompat');
const { pyJsonDumps } = require('./pyjson');
const { pyLoads, pyTypeName } = require('./signalTradesRepo');
const cardsVolume = require('./cards/volume');
const lite = require('./cards/lite');
const keyboards = require('./cards/keyboards');
const { wmInject } = require('./watermark');
const { positionLine } = require('./positionLine');
const quietHours = require('./quietHours');
const volumeFilter = require('./volumeFilter');
const { computeClientOrderId } = require('../exchanges/orderIdUtils');
const lv = require('./levelsScanner');
const { log: defaultLog } = require('../marketData/mdLog');

const { VolumeConfig, minBars, htfFor, resampleHtf, analyzeVolume, STRATEGY_NAME, USER_PREF_KEYS, FIELD_TYPE, FIELD_NAMES,
  envNumber, setupVolFloor, unflooredVolValues, keepPreFloorValues, SYSTEM_CFG_KEYS } = volume;

const SCAN_INTERVAL = 60;                  // seconds between cycles (floor)
const TOP_COINS = 150;                     // [LOW-VOL] universe cap
const COINS_FLOOR_USDT = 300_000;          // [LOW-VOL] minimum 24 h volume
// [VOL-LIQ-15M 2026-10] 15m: thin coins ($0.3–5M a day) — long-wick candles take a tight stop. The
// 24 h volume floor of the 15m groups; other TFs — COINS_FLOOR_USDT.
const COINS_FLOOR_15M_USDT = 5_000_000;
const ENV_COINS_FLOOR_15M = 'VOLUME_15M_COINS_FLOOR_USDT';
// [VOL-POST-SL-PAUSE 2026-10] after the SL of the user's previous signal on (coin, direction) the
// next one there — not earlier than N bars of the signal TF.
const POST_SL_PAUSE_BARS = 8;
const ENV_POST_SL_PAUSE_BARS = 'VOLUME_POST_SL_PAUSE_BARS';
const MAX_SIGNALS_PER_USER_CYCLE = 3;
const ALLOWED_TFS = Object.freeze(['15m', '1h', '4h']);
const TF_SECONDS = Object.freeze({ '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 });
const DEFAULT_TF = '1h';
const KV_CFG_PREFIX = 'volume_cfg_';
const CACHE_TF = Object.freeze({ '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' });
const SENT_TTL = 24 * 3600;
const HTF_TTL = 180;
const CYCLE_TIMEOUT_S = 300;
const FLOAT_KEYS = Object.freeze(Object.keys(FIELD_TYPE).filter((k) => FIELD_TYPE[k] === 'float'));
const isDict = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Map);

const own = (o, k) => o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
const getattr = (o, k, d) => (own(o, k) && o[k] !== undefined ? o[k] : d);
const errMsg = (e) => (e && e.message !== undefined ? e.message : String(e));
/** type(e).__name__ of a caught error (a Python-typed error carries `pyType`). */
const pyExcName = (e) => (e && (e.pyType || e.name)) || 'Exception';

/** [VOLUME-TTL] anti-duplicate per (coin, direction) = 4 bars of the TF, at least an hour. */
function dedupTtlS(tf) {
  const sec = TF_SECONDS[pyLower(String(tf || ''))];
  return Math.max(3600, 4 * (sec === undefined ? 3600 : sec));
}

/** user_tf(user): vol_timeframe lower-cased when in 15m / 1h / 4h, else 1h. */
function userTf(user) {
  const tf = pyLower(String(getattr(user, 'vol_timeframe', DEFAULT_TF) || DEFAULT_TF));
  return ALLOWED_TFS.includes(tf) ? tf : DEFAULT_TF;
}

/**
 * [VOL-LIQ-15M 2026-10] coins_floor_for_tf(tf): the 24 h quote-volume floor of a coin for scanning
 * TF `tf`. 15m — env VOLUME_15M_COINS_FLOOR_USDT (default 5_000_000), never below COINS_FLOOR_USDT
 * (≤ 0 → the old floor); other TFs — COINS_FLOOR_USDT.
 */
function coinsFloorForTf(tf) {
  const base = COINS_FLOOR_USDT;
  if (pyLower(pyStrip(String(tf || ''))) !== '15m') return base;
  let v = envNumber(ENV_COINS_FLOOR_15M, '[VOL-LIQ-15M]');
  if (v === null) v = COINS_FLOOR_15M_USDT;
  return pyMax(base, v);
}

/**
 * [VOL-LIQ-15M] coins_for_tf(coins, tf, vol_by_sym): the coins of the `tf` groups — with a floor above
 * the common one only those whose 24 h volume (fetcher.volBySym) is ≥ the floor; unknown volume → the
 * coin does not pass (like apply_vol_filter). Order kept. One log per cycle and TF.
 */
function coinsForTf(coins, tf, volBySym, log = defaultLog) {
  const floor = coinsFloorForTf(tf);
  if (floor <= COINS_FLOOR_USDT || !pyTruthy(coins)) return Array.from(coins || []);
  const vb = pyTruthy(volBySym) ? volBySym : {};
  const v = (c) => {
    const raw = own(vb, c) ? vb[c] : 0;
    try {
      return toFloat(pyTruthy(raw) ? raw : 0);
    } catch (_e) {
      return 0.0;
    }
  };
  const kept = coins.filter((c) => v(c) >= floor);
  const dropped = coins.filter((c) => v(c) < floor);   // a NaN volume is in neither list (the bot's two comprehensions)
  if (dropped.length && !pyTruthy(vb)) {
    log.warning(`[VOL-LIQ-15M] tf=${tf} no 24h volume data (fetcher.vol_by_sym empty) — `
      + `${dropped.length} coins skipped, floor $${fmtFixed(floor, 0)}`);
  } else if (dropped.length) {
    log.info(`[VOL-LIQ-15M] tf=${tf} coins ${coins.length} → ${kept.length}: ${dropped.length} skipped, `
      + `24h volume < $${fmtFixed(floor, 0)} (e.g. ${dropped.slice(0, 5).join(', ')})`);
  }
  return kept;
}

/**
 * [VOL-POST-SL-PAUSE 2026-10] post_sl_pause_bars(): the pause after a SL in bars of the signal TF —
 * env VOLUME_POST_SL_PAUSE_BARS (default 8; ≤ 0 → off; fractional → truncated).
 */
function postSlPauseBars() {
  let v = envNumber(ENV_POST_SL_PAUSE_BARS, '[VOL-POST-SL-PAUSE]');
  if (v === null) v = POST_SL_PAUSE_BARS;
  return Math.max(0, Math.trunc(v));
}

/**
 * _sl_end_ts(row): when the previous signal ended with its stop — tracker stage SL → progress_ts
 * (open time of the SL candle); result 'SL' (exchange / manual result) → state_changed_at; no time →
 * created_at.
 */
function slEndTs(row) {
  const f = (k) => {
    const raw = own(row, k) ? row[k] : null;
    try {
      return toFloat(pyTruthy(raw) ? raw : 0);
    } catch (_e) {
      return 0.0;
    }
  };
  if (pyUpper(pyStr(pyTruthy(row.progress_stage) ? row.progress_stage : '')) === 'SL' && f('progress_ts') > 0) return f('progress_ts');
  if (pyUpper(pyStr(pyTruthy(row.result) ? row.result : '')) === 'SL' && f('state_changed_at') > 0) return f('state_changed_at');
  return f('created_at');
}

/** json.dumps(cfg.to_dict(), sort_keys=True) — the group key. */
function cfgKey(cfg) {
  const d = cfg.toDict();
  const sorted = {};
  for (const k of Object.keys(d).sort()) sorted[k] = d[k];
  return pyJsonDumps(sorted, FLOAT_KEYS);
}

/** json.dumps(cfg.to_dict()) — the kv value. */
function cfgJson(cfg) {
  return pyJsonDumps(cfg.toDict(), FLOAT_KEYS);
}

/** str(df.index[-1]) of a pandas DatetimeIndex: 'YYYY-MM-DD HH:MM:SS' (the _sent_bars bar key). */
function barTs(df) {
  if (!df || !df.length) return '';
  const d = new Date(Number(df.t[df.length - 1]));
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  const ms = d.getUTCMilliseconds();
  return ms ? `${base}.${String(ms * 1000).padStart(6, '0')}` : base;
}

/**
 * [SQUEEZE-VOLUME] apply_squeeze_bonus(sig, df): cross / turn / golden out of a squeeze
 * (score ≥ 1) → sig.squeeze = score, quality +1 (cap 5); bounce / ribbon and an already set
 * squeeze are skipped. Returns the score 0/1/2.
 */
function applySqueezeBonus(sig, df, log = defaultLog) {
  if (sig === null || sig === undefined || sig.setup === 'bounce' || sig.setup === 'ribbon' || pyTruthy(getattr(sig, 'squeeze', 0))) {
    return Math.trunc(Number(getattr(sig, 'squeeze', 0) || 0));
  }
  let score;
  try {
    score = Math.trunc(Number(computeSqueezeScore(df) || 0));
  } catch (e) {
    log.debug(`[SQUEEZE-VOLUME] ${getattr(sig, 'symbol', '?')}: ${errMsg(e)}`);
    return 0;
  }
  if (score >= 1) {
    sig.squeeze = score;
    sig.quality = Math.min(5, Math.trunc(Number(sig.quality)) + 1);
  }
  return score;
}

/** volume_scanner.signal_text(sig, lang) — cards/volume with the live trend line. */
function signalText(sig, lang = 'ru', opts = {}) {
  return cardsVolume.signalText(sig, lang, opts);
}

function defaultsFor(deps) {
  const d = { ...deps };
  if (!d.clock) d.clock = { now: () => Date.now() / 1000, monotonic: () => Number(process.hrtime.bigint()) / 1e9 };
  if (!d.clock.monotonic) d.clock.monotonic = () => Number(process.hrtime.bigint()) / 1e9;
  if (!d.timers) {
    d.timers = {
      setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); if (h && h.unref) h.unref(); return h; },
      clearTimeout: (h) => clearTimeout(h),
    };
  }
  if (!d.sleep) d.sleep = (ms) => new Promise((r) => d.timers.setTimeout(r, ms));
  if (!d.random) d.random = { randint: (a, b) => a + Math.floor(Math.random() * (b - a + 1)) };
  if (!d.log) d.log = defaultLog;
  if (!d.tgLog) d.tgLog = d.log;
  const lazy = (name, make) => {
    if (d[name] !== undefined) return;
    let v;
    let made = false;
    Object.defineProperty(d, name, {
      configurable: true, enumerable: true,
      get() { if (!made) { v = make(); made = true; } return v; },
      set(x) { v = x; made = true; },
    });
  };
  const nowS = () => d.clock.now();
  lazy('cache', () => require('../marketData/candleCache'));
  lazy('registry', () => require('./signalRegistry').defaultRegistry);
  lazy('freshness', () => require('./signalFreshness').defaultFreshness);
  lazy('trend', () => require('./trendMonitor').defaultMonitor);
  lazy('confluence', () => require('./signalConfluence').defaultConfluence);
  lazy('coinQuality', () => require('./coinQualityLearner').defaultLearner);
  lazy('exchangeSymbols', () => require('../exchanges/exchangeSymbols'));
  lazy('repo', () => require('./signalTradesRepo').createSignalTradesRepo({ now: nowS }));
  lazy('kv', () => require('../engineKvService'));
  lazy('wsFeed', () => null);
  lazy('metrics', () => null);
  lazy('executeAutoTrade', () => null);
  lazy('sendChart', () => null);
  lazy('getBalance', () => null);
  lazy('analysisExecutor', () => null);
  if (!d.emitEvent) d.emitEvent = (tid, type, payload, opts) => d.repo.addTradeEvent(tid, type, payload, opts);
  if (!d.rememberSignalMessage) {
    d.rememberSignalMessage = (tradeId) => (msg) => {
      const mid = msg && Number(msg.message_id) ? Math.trunc(Number(msg.message_id)) : 0;
      if (!mid || !tradeId) return;
      try {
        d.repo.setSignalMsgId(tradeId, mid, d.repo.cardSnapshot({ html: msg.html || '', actions: msg.actions || null, lang: msg.lang || 'ru' }));
      } catch (e) {
        d.log.debug(`[SIGNAL-PROGRESS] remember msg tid=${tradeId}: ${errMsg(e)}`);
      }
    };
  }
  if (!d.safeSendMessage) d.safeSendMessage = (bot, uid, text, opts) => lv.safeSendMessage(bot, uid, text, opts, { log: d.tgLog, sleep: d.sleep });
  if (!d.isAdmin) {
    d.isAdmin = (user) => {
      try { return require('../traderSettingsService').isAdmin(user.user_id); } catch (_e) { return false; }
    };
  }
  if (!d.checkAccess) d.checkAccess = (user) => require('./userAccess').checkAccess(user, { admin: Boolean(d.isAdmin(user)), now: nowS() });
  if (!d.can) d.can = (user, feature) => require('./userAccess').can(user, feature, { admin: Boolean(d.isAdmin(user)) });
  if (!d.strategyEnabled) d.strategyEnabled = (user, s) => require('../../config/planFeatures').strategyEnabled(user, s, { admin: Boolean(d.isAdmin(user)) });
  if (!d.getApiKeys) {
    d.getApiKeys = (user, exchange) => {
      try {
        const db = require('../../models/database');
        const row = db.prepare("SELECT id FROM exchange_keys WHERE user_id = ? AND exchange = ? AND label = 'default'").get(user.user_id, exchange);
        if (!row) return null;
        const c = require('../exchangeService').getCredentials(row.id, user.user_id);
        return { apiKey: c.apiKey, apiSecret: c.apiSecret, passphrase: c.passphrase };
      } catch (_e) {
        return null;
      }
    };
  }
  return d;
}

function createVolumeScanner(depsIn = {}) {
  const d = defaultsFor(depsIn);
  const sentBars = new Map();   // "uid|symbol|direction|bar" → sent ts (_sent_bars)
  const htfCache = new Map();   // "symbol|htf" → [loaded_ts, df] (_htf_cache)
  // _pause_logged: [VOL-POST-SL-PAUSE] "uid|symbol|direction|bar" / [VOL-MIN-SL]
  // "min_sl|symbol|direction|tf|bar" → ts — one log per bar (a cycle every 60 s sees the same bar)
  const pauseLogged = new Map();
  let wake = null;              // _WAKE_EVENT: { set(), wait(timeoutS), clear() }
  const now = () => d.clock.now();
  const log = () => d.log;
  // register_on_bar_close(_on_ws_bar_close): the same module function on every (re)start
  const barCloseCb = (inst, tf) => s._onWsBarClose(inst, tf);

  function wakeEvent() {
    if (wake === null) {
      let flag = false;
      let waiters = [];
      wake = {
        isSet: () => flag,
        set() { flag = true; const w = waiters; waiters = []; for (const f of w) f(); },
        clear() { flag = false; },
        wait(timeoutS) {
          if (flag) return Promise.resolve(true);
          return new Promise((resolve) => {
            const f = () => { d.timers.clearTimeout(h); resolve(true); };
            const h = d.timers.setTimeout(() => { waiters = waiters.filter((x) => x !== f); resolve(false); }, Math.max(0, timeoutS * 1000));
            waiters.push(f);
          });
        },
      };
    }
    return wake;
  }

  const s = {
    SCAN_INTERVAL, TOP_COINS, COINS_FLOOR_USDT, MAX_SIGNALS_PER_USER_CYCLE, ALLOWED_TFS, DEFAULT_TF, KV_CFG_PREFIX,
    deps: d,
    _sentBars: sentBars,
    _htfCache: htfCache,
    _pauseLogged: pauseLogged,
    _wakeEvent: wakeEvent,

    /** ws_feed bar-close callback → wake the scanner before the sleep ends. */
    async _onWsBarClose(_instId, tfNorm) {
      if (Object.values(CACHE_TF).includes(tfNorm)) wakeEvent().set();
    },

    /**
     * The site wiring of the module instance (the scheduler's sleep / clock / ws bus / delivery
     * adapters): run_volume_scanner reads module globals, so the running scanner IS the module
     * instance and the scheduler configures it instead of building another one.
     */
    configure(deps = {}) {
      for (const [k, v] of Object.entries(deps || {})) if (v !== undefined) d[k] = v;
      if (deps && deps.log) {
        for (const k of ['tgLog', 'filterLog', 'strategyLog']) if (deps[k] === undefined) d[k] = deps.log;
      }
      return s;
    },

    /** gc_sent(): drop _sent_bars / _pause_logged older than 24 h and HTF frames older than 180 s. */
    gcSent() {
      const cutoff = now() - SENT_TTL;
      const stale = [];
      for (const [k, ts] of sentBars) if (ts < cutoff) stale.push(k);
      for (const k of stale) sentBars.delete(k);
      for (const [k, ts] of Array.from(pauseLogged)) if (ts < cutoff) pauseLogged.delete(k);
      const hCut = now() - HTF_TTL;
      for (const [k, v] of Array.from(htfCache)) if (v[0] < hCut) htfCache.delete(k);
      return stale.length;
    },

    userTf,

    /** load_user_cfg(uid): kv volume_cfg_<uid> → VolumeConfig.from_params; error → [VOLUME-CFG] warning + defaults. */
    async loadUserCfg(userId) {
      try {
        const raw = await d.kv.get(KV_CFG_PREFIX + String(userId));
        if (raw) {
          // json.loads (the bot's JSONDecodeError text) → from_params, whose `params.items()`
          // raises AttributeError for a truthy non-dict value
          const params = pyLoads(raw);
          if (pyTruthy(params) && (typeof params !== 'object' || Array.isArray(params))) {
            // from_params builds `cls()` first ([VOL-MIN-VOLUME] __post_init__ → its log line), then
            // `params.items()` raises
            void new VolumeConfig();
            throw new Error(`'${pyTypeName(params, String(raw))}' object has no attribute 'items'`);
          }
          return VolumeConfig.fromParams(params);
        }
      } catch (e) {
        log().warning(`[VOLUME-CFG] load_user_cfg uid=${userId}: ${errMsg(e)} — используем дефолт`);
      }
      return new VolumeConfig();
    },

    /**
     * save_user_cfg(uid, params, keep_prefs=True). [VOL-MIN-VOLUME 2026-10] the volume floor is a
     * property of the EFFECTIVE config (load_user_cfg → from_params raises it); kv keeps the user's /
     * genome's choice as before the floor (env VOLUME_MIN_SETUP_VOL_MULT=0 restores it without a
     * migration). A full to_dict() (load → change → save: setup / HTF toggle, profile, settings/all)
     * carries the floored values — a value exactly at the floor over a kv value below it is the floor
     * echoed back, the kv value is kept (no kv row → the field default). [VOL-MIN-SL] min_sl_pct_15m
     * (a system threshold) is never stored.
     */
    async saveUserCfg(userId, params, keepPrefs = true) {
      const p = { ...(params || {}) };
      const roundtrip = FIELD_NAMES.every((k) => own(p, k));   // CONFIG_FIELDS ⊆ params, before the pref merge
      if (keepPrefs && USER_PREF_KEYS.some((k) => !own(p, k))) {
        const cur = await s.loadUserCfg(userId);
        for (const k of USER_PREF_KEYS) if (!own(p, k)) p[k] = cur[k];
      }
      const cfg = VolumeConfig.fromParams(p);
      const data = cfg.toDict();
      const unfl = unflooredVolValues(p);
      const fl = setupVolFloor();
      if (roundtrip && fl > 0) {
        let stored = null;
        try {
          const raw = await d.kv.get(KV_CFG_PREFIX + String(userId));
          const st = pyTruthy(raw) ? pyLoads(raw) : {};
          stored = unflooredVolValues(isDict(st) ? st : {});
        } catch (e) {
          log().warning(`[VOL-MIN-VOLUME] save_user_cfg uid=${userId}: stored kv unreadable (${errMsg(e)}) — floored values written`);
          stored = null;
        }
        if (stored !== null) keepPreFloorValues(unfl, stored, fl);
      }
      Object.assign(data, unfl);
      for (const k of SYSTEM_CFG_KEYS) delete data[k];   // [VOL-MIN-SL] a system threshold — not in kv
      await d.kv.set(KV_CFG_PREFIX + String(userId), pyJsonDumps(data, FLOAT_KEYS));
      return cfg;
    },

    /** reset_user_cfg(uid, keep_prefs=True): defaults, the non-default prefs kept. */
    async resetUserCfg(userId, keepPrefs = true) {
      let prefs = {};
      if (keepPrefs) {
        const cur = await s.loadUserCfg(userId);
        const dflt = new VolumeConfig();
        for (const k of USER_PREF_KEYS) if (cur[k] !== dflt[k]) prefs[k] = cur[k];
      }
      await d.kv.delete(KV_CFG_PREFIX + String(userId));
      if (Object.keys(prefs).length) await s.saveUserCfg(userId, prefs, false);
      prefs = null;
    },

    /**
     * [VOL-POST-SL-PAUSE 2026-10] post_sl_pause_active(uid, symbol, direction, tf, now) → [paused, reason]:
     * paused when the user's latest DELIVERED VOLUME signal of (symbol, direction) ended SL (tracker
     * stage 'SL' or result 'SL') less than N bars of `tf` ago. One query (repo.lastSignalOutcome =
     * db_last_signal_outcome). A failing query → [false, ''] + WARNING: the pause is a quality filter,
     * not a money guard (fail-open).
     */
    async postSlPauseActive(uid, symbol, direction, tf, nowTs = null) {
      const bars = postSlPauseBars();
      if (bars <= 0) return [false, ''];
      const tfS = own(TF_SECONDS, pyLower(pyStrip(String(tf || '')))) ? TF_SECONDS[pyLower(pyStrip(String(tf || '')))] : 3600;
      let row;
      try {
        // the site's signal_trades always exists (the bot's «no DB file → no history» check has no
        // equivalent state here)
        row = await d.repo.lastSignalOutcome(uid, symbol, direction, STRATEGY_NAME);
      } catch (e) {
        log().warning(`[VOL-POST-SL-PAUSE] uid=${uid} ${symbol} ${direction}: check failed `
          + `(${pyExcName(e)}: ${errMsg(e)}) — allowed (fail-open)`);
        return [false, ''];
      }
      if (!pyTruthy(row)) return [false, ''];
      const stage = pyUpper(pyStr(pyTruthy(row.progress_stage) ? row.progress_stage : ''));
      const res = pyUpper(pyStr(pyTruthy(row.result) ? row.result : ''));
      if (stage !== 'SL' && res !== 'SL') return [false, ''];
      const tsNow = nowTs === null || nowTs === undefined ? now() : Number(nowTs);
      const elapsed = tsNow - slEndTs(row);
      if (elapsed >= bars * tfS) return [false, ''];
      const tid = own(row, 'trade_id') && row.trade_id !== undefined ? pyStr(row.trade_id) : '';
      return [true, `previous VOLUME ${pyUpper(pyStr(direction))} signal ${tid} `
        + `ended SL ${fmtFixed(elapsed / tfS, 1)} bars ago < ${bars} bars of ${tf}`];
    },

    /** _user_api(user) → [exchange, api_key, api_secret] */
    _userApi(user) {
      const exchange = getattr(user, 'trade_exchange', 'bybit') || 'bybit';
      let keys = null;
      try { keys = d.getApiKeys(user, exchange); } catch (_e) { keys = null; }
      return [exchange, keys ? keys.apiKey || '' : '', keys ? keys.apiSecret || '' : ''];
    },

    /** _eligible(user, now_ts): VOLUME enabled, a vol_* flag, access, can("volume"). */
    _eligible(user, _nowTs) {
      if (!d.strategyEnabled(user, STRATEGY_NAME)) return false;
      if (!(getattr(user, 'vol_long_active', false) || getattr(user, 'vol_short_active', false))) return false;
      let ok;
      try { [ok] = d.checkAccess(user); } catch (_e) { ok = false; }
      if (!ok) return false;
      try { return Boolean(d.can(user, 'volume')); } catch (_e) { return false; }
    },

    /** _load_df(symbol, tf, fetcher, need): WS cache when ≥ need bars, else REST (8 s timeout, not cached). */
    async _loadDf(symbol, tf, fetcher, need) {
      let df = null;
      try {
        df = await d.cache.getCandles(symbol, own(CACHE_TF, tf) ? CACHE_TF[tf] : tf);
      } catch (_e) {
        df = null;
      }
      if (df !== null && df !== undefined && df.length >= need) return df;
      try {
        df = await lv.waitFor(fetcher.getCandles(symbol, tf, 300), 8.0, d.timers);
      } catch (e) {
        log().debug(`[VOLUME] candles ${symbol} ${tf}: ${errMsg(e)}`);
        return null;
      }
      return df !== null && df !== undefined && df.length >= need ? df : null;
    },

    /** _load_htf(symbol, tf, fetcher, cfg, df_ltf): HTF frame (cache 180 s) → resample of the LTF on failure. */
    async _loadHtf(symbol, tf, fetcher, cfg, dfLtf) {
      const htf = htfFor(tf);
      if (!htf) return null;
      const key = `${symbol}|${htf}`;
      const hit = htfCache.get(key);
      if (hit !== undefined && now() - hit[0] < HTF_TTL) return hit[1];
      let dfH = await s._loadDf(symbol, htf, fetcher, cfg.htf_ema + 5);
      if (dfH === null) dfH = resampleHtf(dfLtf, tf);
      if (dfH !== null && dfH !== undefined) htfCache.set(key, [now(), dfH]);
      return dfH;
    },

    /** analyze_volume in the executor; exceptions → [VOLUME-ERR] warning + null (the bot's contract). */
    async _runAnalyze(symbol, df, cfg, tf, dfHtf = null) {
      const run = () => {
        try {
          return analyzeVolume(symbol, df, cfg, tf, dfHtf);
        } catch (e) {
          (d.strategyLog || log()).warning(`[VOLUME-ERR] analyze_volume ${symbol}: ${errMsg(e)}`);
          return null;
        }
      };
      const exec = d.analysisExecutor;
      return exec ? exec(run) : run();
    },

    /** _analyze_with_htf: HTF loaded only for coins with a pre-pass candidate (min_quality − 1, no HTF). */
    async _analyzeWithHtf(symbol, df, cfg, tf, fetcher) {
      if (!cfg.use_htf || !htfFor(tf)) return s._runAnalyze(symbol, df, cfg, tf);
      const preCfg = cfg.replace({ use_htf: false, min_quality: Math.max(1, cfg.min_quality - 1) });
      const pre = await s._runAnalyze(symbol, df, preCfg, tf);
      if (pre === null || pre === undefined) return null;
      const dfH = await s._loadHtf(symbol, tf, fetcher, cfg, df);
      return s._runAnalyze(symbol, df, cfg, tf, dfH);
    },

    applySqueezeBonus: (sig, df) => applySqueezeBonus(sig, df, log()),

    async _scanCycle(bot, um, fetcher, token = null) {
      const L = log();
      const ck = () => { if (token) token.check(); };
      const nowTs = now();
      let users;
      try {
        users = (await um.getActiveUsers()).filter((u) => s._eligible(u, nowTs));
      } catch (e) {
        L.warning(`[VOLUME-CYCLE] users: ${errMsg(e)}`);
        return;
      }
      ck();
      if (!users.length) return;

      let allCoins;
      try {
        allCoins = await lv.waitFor(fetcher.getAllUsdtPairs(COINS_FLOOR_USDT), 30.0, d.timers);
      } catch (e) {
        L.warning(`[VOLUME-CYCLE] coins: ${errMsg(e)}`);
        return;
      }
      const volBySym = fetcher.volBySym || {};
      let coins;
      try {
        coins = volumeFilter.applyVolFilter(allCoins, users, volBySym,
          (u) => Number(getattr(u, 'min_volume_usdt', 0) || 0),
          { capCount: TOP_COINS, floorUsdt: COINS_FLOOR_USDT, strategyTag: 'VOLUME', log: d.filterLog || L });
      } catch (e) {
        L.warning(`[VOLUME] vol filter failed (${errMsg(e)}) — top-${TOP_COINS} без фильтра объёма`);
        coins = Array.from(allCoins).slice(0, TOP_COINS);
      }
      if (!pyTruthy(coins)) return;

      // groups (tf, cfg) → users
      const groups = new Map();
      const cfgs = new Map();
      for (const u of users) {
        const cfg = await s.loadUserCfg(u.user_id);
        const key = cfgKey(cfg);
        cfgs.set(key, cfg);
        const gk = `${userTf(u)}\u0000${key}`;
        if (!groups.has(gk)) groups.set(gk, { tf: userTf(u), key, users: [] });
        groups.get(gk).users.push(u);
      }

      let sentTotal = 0;
      const coinsByTf = new Map();   // [VOL-LIQ-15M] the 15m groups have their own 24 h volume floor
      for (const { tf, key, users: gUsers } of groups.values()) {
        const cfg = cfgs.get(key);
        const need = minBars(cfg);
        const perUserSent = new Map();
        let scanned = 0;
        let found = 0;
        if (!coinsByTf.has(tf)) coinsByTf.set(tf, coinsForTf(coins, tf, volBySym, L));
        for (const symbol of coinsByTf.get(tf)) {
          ck();
          const df = await s._loadDf(symbol, tf, fetcher, need);
          ck();
          if (df === null) continue;
          scanned += 1;
          const sig = await s._analyzeWithHtf(symbol, df, cfg, tf, fetcher);
          ck();
          if (sig === null || sig === undefined) continue;
          found += 1;
          try {
            d.trend.applyMtfBonus(sig, 'quality', 5);   // [MTF-ALIGNED]
          } catch (e) {
            L.debug(`VOLUME mtf bonus ${symbol}: ${errMsg(e)}`);
          }
          applySqueezeBonus(sig, df, L);                // [SQUEEZE-VOLUME]
          // [CTX-GATE] (ST-9) analyze_volume's min_quality ran before the strong-counter penalty
          const q = Math.trunc(Number(getattr(sig, 'quality', 0) || 0));
          const minQ = Math.trunc(Number(getattr(cfg, 'min_quality', 0) || 0));
          if (q < minQ) {
            L.info(`[VOLUME-CTX-GATE] ${symbol} q=${q} < min ${minQ} after trend-context penalty — skip`);
            continue;
          }
          let bar;
          try { bar = barTs(df); } catch (_e) { bar = ''; }
          const msKey = `min_sl|${symbol}|${sig.direction}|${tf}|${bar}`;
          if (Number(getattr(sig, 'sl_raw_pct', 0) || 0) > 0 && !pauseLogged.has(msKey)) {
            pauseLogged.set(msKey, now());                            // [VOL-MIN-SL] once per bar
            L.info(`[VOL-MIN-SL] ${symbol} ${sig.direction} tf=${tf} stop ${fmtFixed(Number(sig.sl_raw_pct), 2)}% → `
              + `${fmtFixed(Number(sig.risk_pct), 2)}% (15m floor), TP1/TP2/TP3 rescaled to the wider risk`);
          }
          for (const u of gUsers) {
            if ((perUserSent.get(u.user_id) || 0) >= MAX_SIGNALS_PER_USER_CYCLE) continue;
            if (sig.direction === 'LONG' && !getattr(u, 'vol_long_active', false)) continue;
            if (sig.direction === 'SHORT' && !getattr(u, 'vol_short_active', false)) continue;
            try {
              if (await s._deliver(bot, um, u, sig, df, bar)) {
                perUserSent.set(u.user_id, (perUserSent.get(u.user_id) || 0) + 1);
                sentTotal += 1;
              }
            } catch (e) {
              if (e && e.name === 'CancelledError') throw e;
              L.warning(`[VOLUME-SIGNAL] deliver uid=${u.user_id} ${symbol}: ${errMsg(e)}`);
            }
            ck();
          }
          await d.sleep(0);
          ck();
        }
        let sentGroup = 0;
        for (const v of perUserSent.values()) sentGroup += v;
        L.info(`[VOLUME-PROFILE] tf=${tf} users=${gUsers.length} scanned=${scanned} found=${found} sent=${sentGroup}`);
      }
      if (sentTotal) L.info(`[VOLUME-CYCLE] signals sent=${sentTotal}`);
    },

    /** _deliver: per-user filters → row → auto-trade → card → commit / SKIP. True once the row is written. */
    async _deliver(bot, um, user, sig, df, bar) {
      const L = log();
      const uid = user.user_id;
      const key = `${uid}|${sig.symbol}|${sig.direction}|${bar}`;
      if (sentBars.has(key)) return false;

      // the user's exchange must list the coin
      const [exchange, apiKey, apiSecret] = s._userApi(user);
      try {
        const ex = d.exchangeSymbols;
        if (!ex.isAvailable(sig.symbol, exchange)) {
          ex.recordSkip(exchange, sig.symbol);
          return false;
        }
      } catch (_e) { /* exchange_symbols unavailable → pass */ }

      try {
        if (d.coinQuality.isBlacklisted(sig.symbol, STRATEGY_NAME)) return false;
      } catch (_e) { /* pass */ }

      // [VOL-POST-SL-PAUSE 2026-10] the user's previous signal here ended with its stop less than N bars
      // ago → do not re-enter the same chop (fail-open); no row / slot / card / auto-trade
      const [paused, why] = await s.postSlPauseActive(uid, sig.symbol, sig.direction, sig.timeframe || '');
      if (paused) {
        if (!pauseLogged.has(key)) {
          pauseLogged.set(key, now());
          L.info(`[VOL-POST-SL-PAUSE] uid=${uid} ${sig.symbol} ${sig.direction} tf=${pyStr(sig.timeframe)} skipped: ${why}`);
        }
        return false;
      }

      try {
        if (!(await d.freshness.isSignalFresh({
          symbol: sig.symbol, direction: sig.direction, entry: sig.entry, tp1: sig.tp1,
          sl: Number(sig.sl || 0), strategy: STRATEGY_NAME, uid,
        }))) return false;
      } catch (e) {
        L.warning(`[VOLUME] freshness uid=${uid} ${sig.symbol}: ${errMsg(e)}`);
      }

      // [DEDUP-AFTER-SEND]: peek only; the slot is taken after delivery
      const reg = d.registry;
      if (!reg.peekCanSend(uid, sig.symbol, sig.direction, STRATEGY_NAME)) return false;
      if (!reg.peekCanSendMulti(user, sig.symbol, sig.direction)) return false;
      reg.claimMulti(user, sig.symbol, sig.direction);   // [MULTI-CLAIM] ST-10

      sentBars.set(key, now());
      const lang = getattr(user, 'lang', 'ru') || 'ru';

      const tradeId = `${uid}_vol_${Math.trunc(now() * 1000)}_${d.random.randint(100, 999)}`;
      let orderLinkId;
      try {
        orderLinkId = computeClientOrderId(tradeId, uid, exchange, 'entry');
      } catch (_e) {
        orderLinkId = '';
      }
      const r = Math.max(Math.abs(sig.entry - sig.sl), 1e-12);
      let isCounter = Boolean(sig.is_counter_trend);
      if (!isCounter) isCounter = Boolean(d.trend.isCounter(sig.direction, sig.timeframe));
      const t = now();
      await d.repo.addTrade({
        trade_id: tradeId,
        user_id: uid,
        symbol: sig.symbol,
        direction: sig.direction,
        entry: sig.entry,
        sl: sig.sl,
        original_sl: sig.sl,
        order_link_id: orderLinkId,
        tp1: sig.tp1,
        tp2: sig.tp2,
        tp3: sig.tp3,
        tp1_rr: pyRound(Math.abs(sig.tp1 - sig.entry) / r, 2),
        tp2_rr: pyRound(Math.abs(sig.tp2 - sig.entry) / r, 2),
        tp3_rr: pyRound(Math.abs(sig.tp3 - sig.entry) / r, 2),
        quality: Math.trunc(Number(sig.quality)),
        timeframe: sig.timeframe,
        breakout_type: STRATEGY_NAME,
        signal_type: lv.cpSlice(String(sig.signal_type), 64),
        created_at: t,
        strategy: STRATEGY_NAME,
        rsi: Number(sig.rsi),
        volume_ratio: Number(sig.vol_ratio),
        is_counter_trend: isCounter ? 1 : 0,
        mtf_aligned: getattr(sig, 'mtf_aligned', false) ? 1 : 0,
        trend_ctx: lv.cpSlice(String(getattr(sig, 'trend_ctx', '') || ''), 16),
        btc_corr: 0.0,
        session: '',
        preset_name: null,
        state: 'PENDING',
        state_changed_at: t,
      });
      try {
        d.emitEvent(tradeId, 'signal_generated', {
          strategy: STRATEGY_NAME, user_id: uid, symbol: sig.symbol, direction: sig.direction,
          entry: sig.entry, sl: sig.sl, tp1: sig.tp1, quality: Math.trunc(Number(sig.quality)), tf: sig.timeframe,
          signal_type: sig.signal_type,
        }, { floatKeys: ['entry', 'sl', 'tp1'] });
      } catch (_e) { /* best-effort */ }
      try {
        d.confluence.recordSignal(sig.symbol, sig.direction, STRATEGY_NAME, Math.trunc(Number(sig.quality)));
      } catch (_e) { /* pass */ }
      try {
        if (d.metrics && typeof d.metrics.record === 'function') {
          await d.metrics.record('signal_emitted', 1.0, { strategy: 'volume', symbol: sig.symbol, direction: sig.direction, exchange });
        }
      } catch (_e) { /* pass */ }

      // ── auto-trade (Market) ──
      let atResult = { executed: false, show_trade_btn: false, limit_msg: null };
      if (getattr(user, 'auto_trade', false) && apiKey && apiSecret) {
        try {
          if (typeof d.executeAutoTrade !== 'function') throw new Error('execute_auto_trade is not wired');
          atResult = await d.executeAutoTrade({
            user_id: uid, symbol: sig.symbol, direction: sig.direction,
            entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3,
            trade_id: tradeId, api_key: apiKey, api_secret: apiSecret,
            risk_pct: Number(getattr(user, 'trade_risk_pct', 1.0) || 1.0),
            leverage: Math.trunc(Number(getattr(user, 'trade_leverage', 10) || 10)),
            auto_trade_mode: getattr(user, 'auto_trade_mode', 'confirm'),
            max_trades: Math.trunc(Number(getattr(user, 'max_trades_limit', 5) || 5)),
            bot, strategy: STRATEGY_NAME, exchange,
            bybit_demo: Boolean(getattr(user, 'bybit_demo', false)),
            order_type: 'Market',
            quality: Math.trunc(Number(sig.quality)),
            trend_ctx: String(getattr(sig, 'trend_ctx', '') || ''),   // [CTX-SIZING]
            timeframe: String(getattr(sig, 'timeframe', '') || ''),   // [VOL15-RISK-CAP 2026-10]
          });
        } catch (e) {
          L.error(`[TRACE-AT-FAIL] VOLUME uid=${uid} sym=${sig.symbol}: ${errMsg(e)}`);
        }
      }

      // ── card ──
      let text;
      if (getattr(user, 'signal_format', 'full') === 'lite') {
        text = lite.formatSignalLite({
          symbol: sig.symbol, direction: sig.direction, quality: Math.trunc(Number(sig.quality)),
          entry: sig.entry, sl: sig.sl, tp1: sig.tp1, tp2: sig.tp2, tp3: sig.tp3,
          strategy: STRATEGY_NAME, lang,
        });
      } else {
        text = signalText(sig, lang, { cardLine: (dir, tf, l) => d.trend.cardLine(dir, tf, l) });
      }
      try {   // [POSITION-SIZE]
        const ctx = getattr(sig, 'trend_ctx', '');
        let needBalance = true;
        if (ctx) {
          try { needBalance = Number(d.trend.ctxRiskMult(ctx)) > 0; } catch (_e) { needBalance = true; }
        }
        let balance = null;
        if (needBalance && typeof d.getBalance === 'function') {
          try {
            const exB = String(getattr(user, 'trade_exchange', 'bybit') || 'bybit');
            balance = await lv.waitFor(Promise.resolve().then(() => d.getBalance(user, exB)), 3.0, d.timers);
          } catch (_e) {
            balance = null;
          }
        }
        const pl = positionLine(user, sig.entry, sig.sl, lang, ctx, {
          balance, ctxRiskMult: (c) => d.trend.ctxRiskMult(c), ctxLabel: (c, l) => d.trend.ctxLabel(c, l),
        });
        if (pl) text += '\n' + pl;
      } catch (e) {
        L.debug(`position_line VOLUME uid=${uid}: ${errMsg(e)}`);
      }
      const cardOk = await d.safeSendMessage(bot, uid, wmInject(text, uid), {
        parseMode: 'HTML',
        replyMarkup: keyboards.signalCompactKeyboard(tradeId, sig.symbol, {
          showTradeBtn: Boolean(atResult.show_trade_btn), isAutoTraded: Boolean(atResult.executed), lang,
        }),
        protectContent: true,
        onSent: d.rememberSignalMessage(tradeId),
        disableNotification: quietHours.isQuiet(user, now()),   // [QUIET-HOURS]
      });
      if (cardOk || atResult.executed) {
        reg.commitSend(uid, sig.symbol, sig.direction, STRATEGY_NAME, dedupTtlS(sig.timeframe));   // [VOLUME-TTL]
        reg.commitSendMulti(user, sig.symbol, sig.direction);
      } else {
        try {   // [NOT-DELIVERED]
          await d.repo.setTradeResult(tradeId, 'SKIP', 0.0, { skipReason: 'not_delivered' });
        } catch (nd) {
          L.debug(`not_delivered SKIP tid=${tradeId}: ${errMsg(nd)}`);
        }
      }
      if (atResult.limit_msg) {
        try { await d.safeSendMessage(bot, uid, atResult.limit_msg, { siteType: 'trade' }); } catch (_e) { /* pass */ }
      }
      if (getattr(user, 'send_chart_enabled', true)) {
        try {
          if (typeof d.sendChart === 'function') d.sendChart(bot, user, sig, df, { strategy: STRATEGY_NAME, lang });
        } catch (e) {
          L.warning(`[VOLUME] chart uid=${uid} ${sig.symbol}: ${errMsg(e)}`);
        }
      }
      L.info(`[VOLUME-SIGNAL] uid=${uid} ${sig.symbol} ${sig.direction} ${sig.signal_type} q=${Math.trunc(Number(sig.quality))} `
        + `vol×${fmtFixed(sig.vol_ratio, 1)} entry=${fmtG(sig.entry, 6)} sl=${fmtG(sig.sl, 6)} tp1=${fmtG(sig.tp1, 6)} `
        + `tf=${sig.timeframe} auto=${atResult.executed ? 'True' : 'False'}`);
      return true;   // QUIRK(spec §2.3): True once the row is written, delivered or not (counts toward the cap)
    },

    /**
     * run_volume_scanner(bot, um, fetcher, health, interval_sec): cycle with a 300 s timeout,
     * error backoff min(10·2^(n−1), 300) s, heartbeat VOLUME, then sleep the rest of the
     * interval or until a WS bar close sets the wake event. Ends when `signal.aborted`.
     */
    async runVolumeScanner(bot, um, fetcher, { health = null, intervalSec = SCAN_INTERVAL, signal = null } = {}) {
      const L = log();
      L.info(`[VOLUME-START] Volume scanner started, interval=${intervalSec}s`);
      try {
        if (!d.wsFeed) throw new Error('ws_feed is not wired');
        d.wsFeed.registerOnBarClose(barCloseCb);
      } catch (e) {
        L.debug(`ws_feed register VOLUME: ${errMsg(e)}`);
      }
      // the task's cancellation (bot shutdown): CancelledError inside the running cycle at its next
      // checkpoint, and the wake wait ends at once
      let token = null;
      const onAbort = () => { if (token) token.cancel(); wakeEvent().set(); };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        let errors = 0;
        while (!(signal && signal.aborted)) {
          const t0 = d.clock.monotonic();
          token = new lv.CancelToken();
          const cyc = s._scanCycle(bot, um, fetcher, token);
          try {
            await lv.waitFor(cyc, CYCLE_TIMEOUT_S, d.timers);
            errors = 0;
          } catch (e) {
            if (e instanceof lv.TimeoutError) {
              // CPython 3.11 wait_for cancels the timed-out cycle AND waits for it to end
              // (_cancel_and_wait, bpo-32751): the next cycle never overlaps the cancelled one. Here
              // the cycle stops at its next checkpoint; its outcome decides like wait_for's
              // `fut.result()`: a normal return is a finished cycle, CancelledError → TimeoutError,
              // any other error propagates.
              token.cancel();
              let outcome = null;
              try {
                await cyc;
              } catch (e2) {
                outcome = e2;
              }
              if (outcome === null) {
                errors = 0;
              } else if (outcome.name === 'CancelledError') {
                if (signal && signal.aborted) {
                  L.info('Volume scanner stopped.');
                  return;
                }
                L.warning('[VOLUME-CYCLE] timeout >300s — skipping');
              } else {
                errors += 1;
                L.error(`[VOLUME-CYCLE] error #${errors}: ${errMsg(outcome)}`);
                if (health) health.heartbeat('VOLUME');
                await d.sleep(Math.min(10 * (2 ** (errors - 1)), 300) * 1000);
                continue;
              }
            } else if (e && e.name === 'CancelledError') {
              L.info('Volume scanner stopped.');
              return;
            } else {
              errors += 1;
              L.error(`[VOLUME-CYCLE] error #${errors}: ${errMsg(e)}`);
              if (health) health.heartbeat('VOLUME');
              await d.sleep(Math.min(10 * (2 ** (errors - 1)), 300) * 1000);
              continue;
            }
          }
          if (health) health.heartbeat('VOLUME');
          if (signal && signal.aborted) break;
          const sleepS = Math.max(0.0, intervalSec - (d.clock.monotonic() - t0));
          const evt = wakeEvent();
          await evt.wait(sleepS);
          evt.clear();
        }
      } finally {
        // a restarted run (_guarded_restart) adds its own listener: drop this run's one
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    },
  };
  return s;
}

const defaultScanner = createVolumeScanner();

module.exports = {
  SCAN_INTERVAL, TOP_COINS, COINS_FLOOR_USDT, MAX_SIGNALS_PER_USER_CYCLE, ALLOWED_TFS, TF_SECONDS, DEFAULT_TF,
  KV_CFG_PREFIX, CACHE_TF, SENT_TTL, HTF_TTL, CYCLE_TIMEOUT_S,
  COINS_FLOOR_15M_USDT, ENV_COINS_FLOOR_15M, POST_SL_PAUSE_BARS, ENV_POST_SL_PAUSE_BARS,
  dedupTtlS, userTf, cfgKey, cfgJson, barTs, applySqueezeBonus, signalText,
  coinsFloorForTf, coinsForTf, postSlPauseBars, slEndTs,
  setupTitle: cardsVolume.setupTitle, fp: cardsVolume.fp, SETUP_NAMES: cardsVolume.SETUP_NAMES,
  createVolumeScanner, defaultScanner,
  /**
   * run_volume_scanner(bot, um, fetcher, health=…) on the module instance; `opts.deps` (the
   * scheduler's site wiring) configure that instance first (configure()).
   */
  runVolumeScanner: (bot, um, fetcher, opts = {}) => {
    const { deps = null, ...loopOpts } = opts || {};
    if (deps) defaultScanner.configure(deps);
    return defaultScanner.runVolumeScanner(bot, um, fetcher, loopOpts);
  },
  loadUserCfg: (uid) => defaultScanner.loadUserCfg(uid),
  saveUserCfg: (uid, params, keepPrefs) => defaultScanner.saveUserCfg(uid, params, keepPrefs),
  resetUserCfg: (uid, keepPrefs) => defaultScanner.resetUserCfg(uid, keepPrefs),
  gcSent: () => defaultScanner.gcSent(),
  postSlPauseActive: (uid, symbol, direction, tf, nowTs) => defaultScanner.postSlPauseActive(uid, symbol, direction, tf, nowTs),
};
