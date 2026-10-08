/**
 * quietHours — the bot's quiet_hours.py verbatim (data-and-market.md §2.8).
 * In the window [quiet_start, quiet_end) (UTC hours, may wrap midnight)
 * signal cards, progress and trend changes are delivered silently.
 * (-1, -1) = off.
 */

'use strict';

const { pyInt } = require('./pycoerce');

const PRESETS = Object.freeze([[-1, -1], [22, 7], [23, 8], [0, 9], [1, 10]]);

function _get(user, key, dflt = -1) {
  try {
    const v = user && Object.prototype.hasOwnProperty.call(user, key) ? user[key] : dflt;
    return pyInt(v === null || v === undefined ? dflt : v);
  } catch (_e) {
    return dflt;
  }
}

/** window(user) → [start, end] or [-1, -1] when invalid / off. */
function window(user) {
  const s = _get(user, 'quiet_start');
  const e = _get(user, 'quiet_end');
  if (s < 0 || e < 0 || s > 23 || e > 23 || s === e) return [-1, -1];
  return [s, e];
}

/** is_quiet(user, now?) — `now` in unix seconds (default: current time). */
function isQuiet(user, now = null) {
  const [s, e] = window(user);
  if (s < 0) return false;
  const sec = now === null || now === undefined ? Date.now() / 1000 : now;
  const h = new Date(Math.floor(sec) * 1000).getUTCHours();
  return s < e ? (s <= h && h < e) : (h >= s || h < e);
}

/** label(user, lang): "HH:00–HH:00 UTC" / "выкл" / "off" */
function label(user, lang = 'ru') {
  const [s, e] = window(user);
  if (s < 0) return lang !== 'en' ? 'выкл' : 'off';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(s)}:00–${pad(e)}:00 UTC`;
}

/** normalize(start, end): UI/API values → a valid pair ((-1,-1) = off). */
function normalize(start, end) {
  let s;
  let e;
  try {
    s = pyInt(start);
    e = pyInt(end);
  } catch (_e) {
    return [-1, -1];
  }
  if (s < 0 || s > 23) return [-1, -1];
  if (e < 0 || e > 23 || e === s) e = (s + 9) % 24;
  return [s, e];
}

module.exports = { PRESETS, window, isQuiet, label, normalize };
