/**
 * signalTradesRepo — the engine's only door to `signal_trades` / `trade_events`
 * (the bot's `trades` / `trade_events` tables, models/engineSchema.js). One-to-one
 * with the subset of db/trades.py, db/signals.py, db/signal_progress.py and
 * db/trade_events.py the signal pipeline uses:
 *
 *   addTrade(data)                    db_add_trade — _ALLOWED_TRADE_COLS whitelist, INSERT OR IGNORE
 *   getTrade(id) / getUserTrades(uid) db_get_trade / db_get_user_trades
 *   setTradeNote(id, {note, skipReason})               db_set_trade_note
 *   setTradeResult(id, result, rr, {closedPnlUsd, skipReason, allowOverwriteSkip})
 *                                     db_set_trade_result — state CLOSED/FAILED from the result,
 *                                     state_changed_at = now on every transition (L8), skip_reason[:64]
 *                                     in a second UPDATE only when the first changed a row, a
 *                                     position_closed event on a real transition
 *   setTradeState(id, state, {bumpAttempts, expectedFrom})  db_set_trade_state (monotonic CAS)
 *   setSignalMsgId / getTrackableSignals / getExpireCandidates / advanceSignalProgress /
 *   markSignalExpired                 db/signal_progress.py (CAS on COALESCE(progress_stage,''))
 *   cardSnapshot({html, actions, lang})   the signal_card_json value (≤ 12000 chars, else '')
 *   addTradeEvent / getTradeEvents / gcTradeEvents      db/trade_events.py (best-effort writes)
 *   getSignal / addTradeRecord / getUserRecords / updateSignalTp   db/signals.py
 *   cleanupGhostTrades(uid, days) / cleanupGhostTradesAll(days)     db_cleanup_ghost_trades(_all)
 *   coinQualityPairs(cutoffTs)        the coin_quality_learner GROUP BY query
 *
 * Synchronous (better-sqlite3); the clock is injected (`now` → unix seconds).
 * Values are bound like Python's sqlite3: booleans → 1/0, undefined → NULL.
 */

'use strict';

const { SIGNAL_TRADES_ALLOWED_COLS } = require('../../models/engineSchema');
const { pyRepr } = require('../../strategies/common/pyfmt');
const { log: defaultLog } = require('../marketData/mdLog');

const ALLOWED_TRADE_COLS = Object.freeze(new Set(SIGNAL_TRADES_ALLOWED_COLS));
const TRADE_STATES = Object.freeze(['PENDING', 'PLACING', 'OPEN', 'CLOSING', 'CLOSED', 'FAILED']);
const ALLOWED_TRANSITIONS = Object.freeze({
  PENDING: Object.freeze(['PLACING', 'FAILED']),
  PLACING: Object.freeze(['OPEN', 'FAILED']),
  OPEN: Object.freeze(['CLOSING', 'CLOSED']),
  CLOSING: Object.freeze(['CLOSED']),
  CLOSED: Object.freeze([]),
  FAILED: Object.freeze([]),
});
const CLOSED_RESULTS = Object.freeze(['TP1', 'TP2', 'TP3', 'SL', 'BE', 'MANUAL', 'TRAIL']);
const FAILED_RESULTS = Object.freeze(['SKIP', 'ORPHAN', 'CANCELLED']);
// db/signal_progress.py
const FINAL_STAGES = Object.freeze(['TP3', 'SL', 'BE', 'EXPIRED', 'MISSED']);
const STOP_RESULTS = Object.freeze(['TP1', 'TP2', 'TP3', 'SL', 'BE', 'MANUAL', 'TRAIL']);
const CARD_MAX_JSON = 12000;
// db/trade_events.py
const MAX_PAYLOAD_CHARS = 4000;
const EVT = Object.freeze({
  SIGNAL_GENERATED: 'signal_generated',
  SIGNAL_REACHED_AUTO_TRADE: 'signal_reached_auto_trade',
  ORDER_PLACEMENT_ATTEMPT: 'order_placement_attempt',
  ORDER_API_RESPONSE: 'order_api_response',
  FILL_CONFIRMED: 'fill_confirmed',
  SL_ATTEMPT: 'sl_attempt',
  SL_RESPONSE: 'sl_response',
  TP_PLACEMENT: 'tp_placement',
  PARTIAL_TP_PLACED: 'partial_tp_placed',
  TP_TRIGGERED: 'tp_triggered',
  PARTIAL_CLOSE: 'partial_close',
  TRAILING_MOVE: 'trailing_move',
  POSITION_CLOSED: 'position_closed',
  NOTIFICATION_SENT: 'notification_sent',
  ANOMALY_DETECTED: 'anomaly_detected',
  PLAN_GATE_BLOCK: 'plan_gate_block',
  FILTER_BLOCK: 'filter_block',
});

const nowSec = () => Date.now() / 1000;

/** Python sqlite3 parameter binding: bool → int, undefined → NULL. */
function bindValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  // An integral number binds as an INTEGER like a Python int: better-sqlite3 binds every JS
  // number as REAL, which a TEXT column stores as '3.0' where the bot stores '3'
  // (REAL / INTEGER columns are unaffected — affinity converts either way).
  if (typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0)) return BigInt(v);
  return v;
}

/** str(x)[:n] — code-point slicing like Python. */
function pySlice(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  return Array.from(str).slice(0, n).join('');
}

function cpLen(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _c of s) n++;
  return n;
}

function escapeJsonString(s, ensureAscii) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || (ensureAscii && code > 0x7e)) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

/**
 * json.dumps(value, default=str, ensure_ascii=False) for plain JS values: Python
 * separators (", ", ": "), non-integral numbers as repr(float), integral numbers as
 * ints, NaN/Infinity tokens, anything else → its str().
 *
 * `floatKeys` names the dict keys whose numbers are Python floats (JS has one number
 * type): an integral value under such a key prints as repr(float) — `2.0`, not `2`.
 */
function pyDumps(value, { ensureAscii = false, floatKeys = null } = {}) {
  const floats = floatKeys ? new Set(floatKeys) : null;
  const walk = (v, key) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return 'NaN';
      if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
      const isFloat = Boolean(floats && key !== null && floats.has(key));
      return !isFloat && Number.isInteger(v) && !Object.is(v, -0) ? String(v) : pyRepr(v);
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return escapeJsonString(v, ensureAscii);
    if (Array.isArray(v)) return '[' + v.map((x) => walk(x, null)).join(', ') + ']';
    if (v instanceof Date) return escapeJsonString(String(v), ensureAscii);
    if (typeof v === 'object') {
      return '{' + Object.keys(v).map((k) => escapeJsonString(String(k), ensureAscii) + ': ' + walk(v[k], k)).join(', ') + '}';
    }
    return escapeJsonString(String(v), ensureAscii);
  };
  return walk(value, null);
}

/** json.JSONDecodeError: "<msg>: line L column C (char P)" (positions in code points, like CPython). */
class PyJSONDecodeError extends SyntaxError {
  constructor(msg, doc, pos) {
    const head = Array.from(doc.slice(0, pos));
    const cpPos = head.length;
    let lineno = 1;
    let lastNl = -1;
    head.forEach((ch, i) => { if (ch === '\n') { lineno++; lastNl = i; } });
    super(`${msg}: line ${lineno} column ${cpPos - lastNl} (char ${cpPos})`);
    this.name = 'JSONDecodeError';
    this.msg = msg;
    this.pos = cpPos;
  }
}

/**
 * json.loads(text) as CPython's C scanner reads it: the NaN / Infinity / -Infinity
 * tokens are accepted, integers and floats as numbers (an integer "-0" is 0), duplicate
 * keys keep the first position and the last value, a BOM / extra data / any syntax error
 * throws PyJSONDecodeError with the bot's message ("Expecting value: line 1 column 1
 * (char 0)", "Expecting ',' delimiter: …", "Extra data: …").
 *
 * JSON.parse cannot read what Python's json.dumps writes for a NaN / ±inf float, and a
 * plain JS object reorders integer-like keys ("101" before "7"); objects nested less
 * than `mapDepth` levels deep are therefore returned as Maps in document order (a
 * uid-keyed kv blob iterates like the bot's dict).
 */
function pyLoads(text, { mapDepth = 0 } = {}) {
  const s = String(text);
  const n = s.length;
  if (s.charCodeAt(0) === 0xfeff) throw new PyJSONDecodeError('Unexpected UTF-8 BOM (decode using utf-8-sig)', s, 0);
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  const skipWs = (i) => { while (i < n && isWs(s[i])) i++; return i; };
  const STOP = Symbol('stop');
  const stop = (pos) => { const e = new Error('StopIteration'); e[STOP] = pos; return e; };
  const ESC = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
  const hex4 = (i) => (/^[0-9a-fA-F]{4}$/.test(s.slice(i, i + 4)) ? parseInt(s.slice(i, i + 4), 16) : -1);
  const NUM = /(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

  function scanString(end) {   // end = index after the opening quote
    const begin = end - 1;
    let out = '';
    let i = end;
    for (;;) {
      let j = i;
      while (j < n && s[j] !== '"' && s[j] !== '\\') {
        if (s.charCodeAt(j) <= 0x1f) throw new PyJSONDecodeError('Invalid control character at', s, j);
        j++;
      }
      if (j >= n) throw new PyJSONDecodeError('Unterminated string starting at', s, begin);
      out += s.slice(i, j);
      if (s[j] === '"') return [out, j + 1];
      const k = j + 1;
      if (k >= n) throw new PyJSONDecodeError('Unterminated string starting at', s, begin);
      const c = s[k];
      if (c !== 'u') {
        if (!Object.prototype.hasOwnProperty.call(ESC, c)) throw new PyJSONDecodeError('Invalid \\escape', s, j);
        out += ESC[c];
        i = k + 1;
      } else {
        if (k + 5 >= n) throw new PyJSONDecodeError('Invalid \\uXXXX escape', s, k);
        const u = hex4(k + 1);
        if (u < 0) throw new PyJSONDecodeError('Invalid \\uXXXX escape', s, k);
        out += String.fromCharCode(u);   // a surrogate pair joins in UTF-16 like chr(join) in Python
        i = k + 5;
      }
    }
  }

  function setKey(obj, key, val) {
    if (obj instanceof Map) obj.set(key, val);
    else if (key === '__proto__') Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
    else obj[key] = val;
  }

  function scanOnce(i, depth) {
    if (i >= n) throw stop(i);
    const c = s[i];
    if (c === '"') return scanString(i + 1);
    if (c === '{') {
      const obj = depth < mapDepth ? new Map() : {};
      let j = skipWs(i + 1);
      if (j < n && s[j] === '}') return [obj, j + 1];
      for (;;) {
        if (j >= n || s[j] !== '"') throw new PyJSONDecodeError('Expecting property name enclosed in double quotes', s, j);
        const [key, afterKey] = scanString(j + 1);
        j = skipWs(afterKey);
        if (j >= n || s[j] !== ':') throw new PyJSONDecodeError("Expecting ':' delimiter", s, j);
        j = skipWs(j + 1);
        const [val, afterVal] = scanOnce(j, depth + 1);
        setKey(obj, key, val);
        j = skipWs(afterVal);
        if (j < n && s[j] === '}') return [obj, j + 1];
        if (j >= n || s[j] !== ',') throw new PyJSONDecodeError("Expecting ',' delimiter", s, j);
        j = skipWs(j + 1);
      }
    }
    if (c === '[') {
      const arr = [];
      let j = skipWs(i + 1);
      if (j < n && s[j] === ']') return [arr, j + 1];
      for (;;) {
        const [val, afterVal] = scanOnce(j, depth + 1);
        arr.push(val);
        j = skipWs(afterVal);
        if (j < n && s[j] === ']') return [arr, j + 1];
        if (j >= n || s[j] !== ',') throw new PyJSONDecodeError("Expecting ',' delimiter", s, j);
        j = skipWs(j + 1);
      }
    }
    if (s.startsWith('null', i)) return [null, i + 4];
    if (s.startsWith('true', i)) return [true, i + 4];
    if (s.startsWith('false', i)) return [false, i + 5];
    if (s.startsWith('NaN', i)) return [NaN, i + 3];
    if (s.startsWith('Infinity', i)) return [Infinity, i + 8];
    if (s.startsWith('-Infinity', i)) return [-Infinity, i + 9];
    NUM.lastIndex = i;
    const m = NUM.exec(s);
    if (!m) throw stop(i);
    if (m[2] || m[3]) return [Number(m[0]), i + m[0].length];
    const v = Number(m[1]);
    return [Object.is(v, -0) ? 0 : v, i + m[0].length];
  }

  let value;
  let end;
  try {
    [value, end] = scanOnce(skipWs(0), 0);
  } catch (e) {
    if (e && e[STOP] !== undefined) throw new PyJSONDecodeError('Expecting value', s, e[STOP]);
    throw e;
  }
  end = skipWs(end);
  if (end !== n) throw new PyJSONDecodeError('Extra data', s, end);
  return value;
}

/** type(x).__name__ of a pyLoads value (`literal` = its source text, to tell int from float). */
function pyTypeName(v, literal = '') {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isFinite(v) && !/[.eEnN]/.test(String(literal).trim()) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  return 'dict';
}

/**
 * createSignalTradesRepo({ db, now, log, onClosed })
 *   db       — better-sqlite3 handle (default models/database, lazily)
 *   onClosed — optional (trade, result, rr) hook after a real result transition with a
 *              non-SKIP result (the bot's trade_feedback.record_feedback point, M16)
 */
function createSignalTradesRepo(deps = {}) {
  const dbOf = () => (deps.db ? deps.db : require('../../models/database'));
  const now = deps.now || nowSec;
  const log = deps.log || defaultLog;

  const repo = {
    ALLOWED_TRADE_COLS, TRADE_STATES, ALLOWED_TRANSITIONS, FINAL_STAGES, STOP_RESULTS, EVT,

    /** db_add_trade(data): whitelist the keys, INSERT OR IGNORE. Returns the inserted row count. */
    addTrade(data) {
      const keys = Object.keys(data || {}).filter((k) => ALLOWED_TRADE_COLS.has(k));
      if (!keys.length) {
        log.warning('db_add_trade: пустой dict после фильтрации — пропускаем');
        return 0;
      }
      const sql = `INSERT OR IGNORE INTO signal_trades (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
      return dbOf().prepare(sql).run(...keys.map((k) => bindValue(data[k]))).changes;
    },

    getTrade(tradeId) {
      return dbOf().prepare('SELECT * FROM signal_trades WHERE trade_id=?').get(String(tradeId)) || null;
    },

    /** db_get_user_trades: closed, non-SKIP rows of a user by created_at. */
    getUserTrades(userId) {
      return dbOf().prepare("SELECT * FROM signal_trades WHERE user_id=? AND result != '' AND result != 'SKIP' ORDER BY created_at").all(userId);
    },

    /** db_set_trade_note(trade_id, note, skip_reason): user_note[:500], skip_reason[:64]. */
    setTradeNote(tradeId, { note = null, skipReason = null } = {}) {
      const sets = [];
      const params = [];
      if (note !== null && note !== undefined) { sets.push('user_note=?'); params.push(pySlice(note, 500)); }
      if (skipReason !== null && skipReason !== undefined) { sets.push('skip_reason=?'); params.push(pySlice(skipReason, 64)); }
      if (!sets.length) return false;
      params.push(String(tradeId));
      return dbOf().prepare(`UPDATE signal_trades SET ${sets.join(', ')} WHERE trade_id=?`).run(...params).changes > 0;
    },

    /**
     * db_set_trade_result(trade_id, result, result_rr, closed_pnl_usd, skip_reason,
     * allow_overwrite_skip) → the row after the write (null when the trade is missing).
     */
    setTradeResult(tradeId, result, resultRr, { closedPnlUsd = null, skipReason = null, allowOverwriteSkip = false } = {}) {
      const db = dbOf();
      const tid = String(tradeId);
      if (result === 'SKIP') {
        try {
          const existing = repo.getTrade(tid);
          if (existing && Number(existing.tp_placed || 0) > 0) {
            // the bot appends "".join(traceback.format_stack(limit=8)[:-1]) — here the JS call stack
            const stack = String(new Error().stack || '').split('\n').slice(2, 9).map((l) => `  ${l.trim()}\n`).join('');
            log.warning(`[SKIP-AFTER-TP-PLACED] trade_id=${tid} tp_placed=${existing.tp_placed} result_was=${existing.result || ''} `
              + `reason=${skipReason || ''} — logging call stack:\n${stack}`);
          }
        } catch (e) {
          log.debug(`SKIP-AFTER-TP-PLACED instrument failed: ${e && e.message}`);
        }
      }
      let newState = null;
      if (CLOSED_RESULTS.includes(result)) newState = 'CLOSED';
      else if (FAILED_RESULTS.includes(result)) newState = 'FAILED';
      const where = allowOverwriteSkip ? "WHERE trade_id=? AND result IN ('', 'SKIP')" : "WHERE trade_id=? AND result=''";
      const t = now();
      const sets = ['result=?', 'result_rr=?'];
      const params = [bindValue(result), bindValue(resultRr)];
      if (closedPnlUsd !== null && closedPnlUsd !== undefined) { sets.push('closed_pnl_usd=?'); params.push(Number(closedPnlUsd)); }
      if (newState !== null) { sets.push('state=?'); params.push(newState); }
      sets.push('state_changed_at=?');
      params.push(t);
      let updated = 0;
      db.transaction(() => {
        updated = db.prepare(`UPDATE signal_trades SET ${sets.join(', ')} ${where}`).run(...params, tid).changes;
        if (skipReason !== null && skipReason !== undefined && updated > 0) {
          db.prepare('UPDATE signal_trades SET skip_reason=? WHERE trade_id=?').run(pySlice(skipReason, 64), tid);
        }
      })();
      if (updated > 0) {
        // result_rr is a Python float at every bot call site (0.0, 2.0, -1.0, computed R)
        repo.addTradeEvent(tid, EVT.POSITION_CLOSED, { result, result_rr: resultRr, new_state: newState }, { floatKeys: ['result_rr'] });
      }
      const trade = repo.getTrade(tid);
      if (updated > 0 && trade && result && result !== 'SKIP' && typeof deps.onClosed === 'function') {
        try { deps.onClosed(trade, result, resultRr); } catch (e) { log.debug(`auto record_feedback failed trade=${tid}: ${e && e.message}`); }
      }
      return trade;
    },

    /**
     * db_set_trade_state(trade_id, new_state, bump_attempts, expected_from): monotonic
     * forward transition, CAS on `state IN (allowed predecessors)`. Throws on an
     * invalid state / no valid predecessor (ValueError in the bot).
     */
    setTradeState(tradeId, newState, { bumpAttempts = false, expectedFrom = null } = {}) {
      if (!TRADE_STATES.includes(newState)) throw new RangeError(`invalid trade state: '${newState}'`);
      let predecessors;
      if (expectedFrom === null || expectedFrom === undefined) {
        predecessors = Object.keys(ALLOWED_TRANSITIONS).filter((p) => ALLOWED_TRANSITIONS[p].includes(newState));
      } else {
        predecessors = Array.from(new Set(expectedFrom)).filter((p) => (ALLOWED_TRANSITIONS[p] || []).includes(newState));
      }
      if (!predecessors.length) throw new RangeError(`no valid predecessor for trade state '${newState}'`);
      predecessors.sort();
      const attempts = bumpAttempts ? ', placement_attempts = COALESCE(placement_attempts, 0) + 1' : '';
      const sql = `UPDATE signal_trades SET state = ?, state_changed_at = ?${attempts} WHERE trade_id = ? AND state IN (${predecessors.map(() => '?').join(',')})`;
      const ok = dbOf().prepare(sql).run(newState, now(), String(tradeId), ...predecessors).changes > 0;
      if (!ok) log.debug(`db_set_trade_state noop tid=${tradeId} target=${newState} (predecessors=${predecessors.join(',')})`);
      return ok;
    },

    // ── db/signal_progress.py ──────────────────────────────────────────
    /** db_set_signal_msg_id(trade_id, message_id, card_json): only when both are truthy. */
    setSignalMsgId(tradeId, messageId, cardJson = '') {
      if (!tradeId || !messageId) return false;
      const db = dbOf();
      if (cardJson) {
        return db.prepare('UPDATE signal_trades SET signal_msg_id=?, signal_card_json=? WHERE trade_id=?')
          .run(Math.trunc(Number(messageId)), String(cardJson), String(tradeId)).changes > 0;
      }
      return db.prepare('UPDATE signal_trades SET signal_msg_id=? WHERE trade_id=?')
        .run(Math.trunc(Number(messageId)), String(tradeId)).changes > 0;
    },

    /** card_snapshot: JSON {"html", "actions", "lang"} of the delivered card; '' when > 12000 chars or empty. */
    cardSnapshot({ html = '', actions = null, lang = 'ru' } = {}) {
      if (!html) return '';
      const raw = pyDumps({ html, actions, lang });
      return cpLen(raw) <= CARD_MAX_JSON ? raw : '';
    },

    getTrackableSignals(sinceTs, limit = 3000) {
      const finals = FINAL_STAGES.slice().sort();
      const sql = 'SELECT trade_id, user_id, symbol, direction, entry, sl, original_sl, '
        + '       tp1, tp2, tp3, entry_lo, entry_hi, timeframe, strategy, '
        + '       created_at, signal_msg_id, progress_stage, progress_ts, '
        + '       result, order_id, signal_card_json, expire_rr '
        + 'FROM signal_trades '
        + 'WHERE signal_msg_id > 0 AND created_at >= ? '
        + "  AND (order_id = '' OR order_id IS NULL) "
        + `  AND COALESCE(progress_stage, '') NOT IN (${finals.map(() => '?').join(',')}) `
        + `  AND COALESCE(result, '') NOT IN (${STOP_RESULTS.map(() => '?').join(',')}) `
        + 'ORDER BY created_at DESC LIMIT ?';
      return dbOf().prepare(sql).all(Number(sinceTs), ...finals, ...STOP_RESULTS, Math.trunc(Number(limit)));
    },

    getExpireCandidates(t, maxAgeS, graceS = 86400.0, limit = 500) {
      const finals = FINAL_STAGES.slice().sort();
      const sql = 'SELECT trade_id, user_id, symbol, direction, entry, sl, original_sl, '
        + '       tp1, tp2, tp3, timeframe, strategy, created_at, signal_msg_id, '
        + '       progress_stage, progress_ts, result, order_id, signal_card_json, expire_rr '
        + 'FROM signal_trades '
        + 'WHERE signal_msg_id > 0 AND created_at >= ? AND created_at < ? '
        + "  AND (order_id = '' OR order_id IS NULL) "
        + `  AND COALESCE(progress_stage, '') NOT IN (${finals.map(() => '?').join(',')}) `
        + `  AND COALESCE(result, '') NOT IN (${STOP_RESULTS.map(() => '?').join(',')}) `
        + 'ORDER BY created_at LIMIT ?';
      return dbOf().prepare(sql).all(Number(t - maxAgeS - graceS), Number(t - maxAgeS), ...finals, ...STOP_RESULTS, Math.trunc(Number(limit)));
    },

    /** db_advance_signal_progress: CAS — true only when the row was at expected_stage. */
    advanceSignalProgress(tradeId, expectedStage, newStage, progressTs) {
      return dbOf().prepare("UPDATE signal_trades SET progress_stage=?, progress_ts=? WHERE trade_id=? AND COALESCE(progress_stage, '')=?")
        .run(String(newStage), Number(progressTs), String(tradeId), String(expectedStage || '')).changes > 0;
    },

    /** db_mark_signal_expired: CAS → EXPIRED with the mark-to-market R. */
    markSignalExpired(tradeId, expectedStage, rr, progressTs) {
      return dbOf().prepare("UPDATE signal_trades SET progress_stage='EXPIRED', progress_ts=?, expire_rr=? WHERE trade_id=? AND COALESCE(progress_stage, '')=?")
        .run(Number(progressTs), Number(rr), String(tradeId), String(expectedStage || '')).changes > 0;
    },

    // ── db/trade_events.py ─────────────────────────────────────────────
    /**
     * db_add_trade_event(trade_id, event_type, payload): best-effort append (errors swallowed).
     * `opts.floatKeys` — payload keys holding Python floats (printed `2.0`, like json.dumps).
     */
    addTradeEvent(tradeId, eventType, payload = null, { floatKeys = null } = {}) {
      if (!tradeId || !eventType) return false;
      try {
        let payloadStr = '';
        if (payload && (typeof payload !== 'object' || Object.keys(payload).length)) {
          try {
            payloadStr = pySlice(pyDumps(payload, { floatKeys }), MAX_PAYLOAD_CHARS);
          } catch (_e) {
            payloadStr = pySlice(String(payload), MAX_PAYLOAD_CHARS);
          }
        }
        dbOf().prepare('INSERT INTO trade_events (trade_id, ts, event_type, payload_json) VALUES (?, ?, ?, ?)')
          .run(String(tradeId), now(), String(eventType), payloadStr);
        return true;
      } catch (e) {
        log.debug(`trade_events emit tid=${tradeId} evt=${eventType}: ${e && e.message}`);
        return false;
      }
    },

    /** db_get_trade_events(trade_id, limit): oldest first, payload parsed ({"_raw": …} when not JSON). */
    getTradeEvents(tradeId, limit = 200) {
      if (!tradeId) return [];
      try {
        const rows = dbOf().prepare('SELECT id, trade_id, ts, event_type, payload_json FROM trade_events WHERE trade_id = ? ORDER BY ts ASC, id ASC LIMIT ?')
          .all(String(tradeId), Math.trunc(Number(limit)));
        return rows.map((r) => {
          let payload;
          try { payload = pyLoads(r.payload_json || '{}'); } catch (_e) { payload = { _raw: r.payload_json || '' }; }   // json.loads: NaN tokens too
          return { ...r, payload };
        });
      } catch (e) {
        log.debug(`db_get_trade_events tid=${tradeId}: ${e && e.message}`);
        return [];
      }
    },

    gcTradeEvents(maxAgeDays = 30) {
      try {
        return dbOf().prepare('DELETE FROM trade_events WHERE ts < ?').run(now() - maxAgeDays * 86400).changes;
      } catch (e) {
        log.debug(`gc_trade_events: ${e && e.message}`);
        return 0;
      }
    },

    // ── db/signals.py ──────────────────────────────────────────────────
    getSignal(signalId) { return repo.getTrade(String(signalId)); },
    getSignalRecords(signalId) { const t = repo.getTrade(String(signalId)); return t ? [t] : []; },
    addTradeRecord(_userId, signalId, result, rr) { return repo.setTradeResult(String(signalId), String(result).toUpperCase(), rr); },
    getUserRecords(userId, limit = 50) {
      const trades = repo.getUserTrades(userId);
      return trades.length > limit ? trades.slice(-limit) : trades;
    },
    /** update_signal_tp(signal_id, tp1=, tp2=, tp3=): only the given (non-None) columns. */
    updateSignalTp(signalId, { tp1 = null, tp2 = null, tp3 = null } = {}) {
      const updates = [];
      const vals = [];
      if (tp1 !== null && tp1 !== undefined) { updates.push('tp1=?'); vals.push(tp1); }
      if (tp2 !== null && tp2 !== undefined) { updates.push('tp2=?'); vals.push(tp2); }
      if (tp3 !== null && tp3 !== undefined) { updates.push('tp3=?'); vals.push(tp3); }
      if (!updates.length) return 0;
      return dbOf().prepare(`UPDATE signal_trades SET ${updates.join(', ')} WHERE trade_id=?`).run(...vals, String(signalId)).changes;
    },

    // ── ghost cleanup (db_cleanup_ghost_trades / _all) ─────────────────
    /** → [no_order, old]: undelivered rows without an order, then rows older than max_age_days. */
    cleanupGhostTrades(userId, maxAgeDays = 30) {
      const db = dbOf();
      const t = now();
      const cutoff = t - maxAgeDays * 86400;
      let noOrder = 0;
      let old = 0;
      db.transaction(() => {
        noOrder = db.prepare("UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', state_changed_at=? "
          + "WHERE user_id=? AND result='' AND (order_id='' OR order_id IS NULL) AND COALESCE(signal_msg_id, 0) = 0").run(t, userId).changes;
        old = db.prepare("UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', state_changed_at=? "
          + "WHERE user_id=? AND result='' AND created_at < ?").run(t, userId, cutoff).changes;
      })();
      return [noOrder, old];
    },

    cleanupGhostTradesAll(maxAgeDays = 30) {
      const db = dbOf();
      const t = now();
      const cutoff = t - maxAgeDays * 86400;
      let noOrder = 0;
      let old = 0;
      db.transaction(() => {
        noOrder = db.prepare("UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', state_changed_at=? "
          + "WHERE result='' AND (order_id='' OR order_id IS NULL) AND COALESCE(signal_msg_id, 0) = 0").run(t).changes;
        old = db.prepare("UPDATE signal_trades SET result='SKIP', state='FAILED', skip_reason='ghost', state_changed_at=? "
          + "WHERE result='' AND created_at < ?").run(t, cutoff).changes;
      })();
      return [noOrder, old];
    },

    // ── coin_quality_learner ───────────────────────────────────────────
    /** Per (symbol, strategy) wins_rr / losses_rr / n / avg_rr of the rows created after cutoff (bot SQL verbatim). */
    coinQualityPairs(cutoffTs) {
      return dbOf().prepare(`
        SELECT symbol, strategy,
               SUM(CASE WHEN result_rr > 0 THEN result_rr ELSE 0 END) as wins_rr,
               SUM(CASE WHEN result_rr < 0 THEN ABS(result_rr) ELSE 0 END) as losses_rr,
               COUNT(*) as n,
               AVG(result_rr) as avg_rr
        FROM signal_trades
        WHERE created_at > ?
          AND result NOT IN ('PENDING','SKIP','ORPHAN','MANUAL','AUTO')
          AND symbol IS NOT NULL AND symbol != ''
          AND strategy IS NOT NULL AND strategy != ''
          AND result_rr IS NOT NULL
        GROUP BY symbol, strategy
      `).all(Number(cutoffTs));
    },
  };
  return repo;
}

const defaultRepo = createSignalTradesRepo();

module.exports = {
  ALLOWED_TRADE_COLS, TRADE_STATES, ALLOWED_TRANSITIONS, CLOSED_RESULTS, FAILED_RESULTS,
  FINAL_STAGES, STOP_RESULTS, CARD_MAX_JSON, MAX_PAYLOAD_CHARS, EVT,
  bindValue, pySlice, pyDumps, pyLoads, pyTypeName, PyJSONDecodeError, createSignalTradesRepo, defaultRepo,
};
